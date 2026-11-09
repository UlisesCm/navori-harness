import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderClaudeEngine } from "../../../engines/claude/index.ts";
import { renderCodexEngine } from "../../../engines/codex/index.ts";
import { CODEX_PARITY } from "../../../engines/shared/codex-parity.ts";
import { NavoriConfigSchema } from "../../config/schema.ts";
import { acrossShells } from "../../__tests__/helpers/shells.ts";

type Engine = "claude" | "codex";

interface RenderedFixture {
  cwd: string;
  hook: string;
  registration: string;
}

const engines: readonly Engine[] = ["claude", "codex"];
const fixtures = new Map<Engine, RenderedFixture>();
const ownedDirectories: string[] = [];
const renderers = { claude: renderClaudeEngine, codex: renderCodexEngine };

/** Render installed adapters, rather than copying a canonical script into guessed paths. */
function renderFixture(engine: Engine, enabled: boolean): RenderedFixture {
  const cwd = mkdtempSync(join(tmpdir(), `navori-delivery-fixture-${engine}-`));
  ownedDirectories.push(cwd);
  renderers[engine](
    cwd,
    NavoriConfigSchema.parse({
      name: "delivery-parity-fixture",
      engines: [engine],
      preset: "custom",
      branchBase: "main",
      harness: { masterPlan: enabled, planTiers: true },
    }),
  );
  return {
    cwd,
    hook: join(cwd, `.${engine}/hooks/master-accept-confirm.sh`),
    registration: readFileSync(
      join(cwd, engine === "claude" ? ".claude/settings.json" : ".codex/config.toml"),
      "utf8",
    ),
  };
}

/** Fixtures use the implemented Bash/command contract; raw Codex normalization is unverified. */
function hookPayload(engine: Engine, cwd: string, command: string): string {
  return JSON.stringify(
    engine === "claude"
      ? {
          session_id: "fixture-only-claude",
          tool_name: "Bash",
          cwd,
          tool_input: { command },
          permission_mode: "bypassPermissions",
        }
      : {
          tool_input: { command },
          agent_type: "implementer",
          agent_id: "fixture-child",
          cwd,
          tool_name: "Bash",
          session_id: "fixture-only-codex",
        },
  );
}

const approvals: readonly string[] = [
  "npx --yes navori@latest master accept S1 --approved-by=user",
  "/opt/bin/navori master reject S2 --notes a --approved-by user",
  "true && bunx navori master accept S1 --approved-by 'user'",
  "(pnpm dlx navori master reject S2 --notes a --approved-by=user)",
  "answer=$(./node_modules/.bin/navori master accept S1 --approved-by user)",
  "navori master status; pnpm exec navori master accept S1 D2 --approved-by user",
];

const nonApprovals: readonly string[] = [
  // Spec 0063 T6: the v1 write forms are refused by the CLI, so no adapter asks on them.
  "navori master part P1 --accept A1 --approved-by user",
  "navori master close --abandon --reason fixture",
  "navori master delivery-baseline --approved-by user",
  "navori master delivery-queue --delivery E1 --parts P1 --approved-by user",
  "navori master delivery-review --part P1 --report report.txt --envelope review.json --approved-by user",
  "navori master delivery-decision --delivery E1 --identity fixture --decision accepted --approved-by user",
  "bunx navori master delivery-publication --delivery E1 --kind release --reference v1 --approved-by user",
  "navori master delivery-revoke --approved-by user",
  "navori master delivery-criterion --part P1 --criterion A2 --approved-by=user",
  "navori master delivery-slice --part P1 --refresh --approved-by user",
  "navori master status && echo --approved-by=user",
  "navori master accept-preview --approved-by user",
  "navori plan check feature && navori master status --json",
  "navori master delivery-present --delivery E1",
  "navori master delivery-check && echo --approved-by=user",
];

// These are installed-script fixtures, not host-hook live probes or user attestations.
describe.runIf(process.platform !== "win32")("delivery installed-adapter fixture parity", () => {
  beforeAll(() => {
    for (const engine of engines) fixtures.set(engine, renderFixture(engine, true));
  });

  afterAll(() => {
    for (const cwd of ownedDirectories.splice(0)) rmSync(cwd, { recursive: true, force: true });
  });

  // Covers: R20, R39, R62
  it.each(engines)("keeps %s opt-in separate from legacy tier enforcement", (engine: Engine) => {
    const active = fixtures.get(engine);
    expect(active).toBeDefined();
    const inactive = renderFixture(engine, false);
    for (const registration of [active?.registration, inactive.registration]) {
      expect(registration).toContain("plan-gate.sh");
    }
    expect(active?.registration).toContain("master-accept-confirm.sh");
    expect(inactive.registration).not.toContain("master-accept-confirm.sh");
    expect(inactive.registration).not.toContain("master-plan-context.sh");
    expect(active?.registration).toContain("master-plan-context.sh");
  });

  // Covers: R20, R58, R62
  it.each([...approvals, ...nonApprovals])(
    "matches both installed consent adapters: %s",
    (command: string) => {
      const needsConsent = approvals.includes(command);
      for (const engine of engines) {
        const fixture = fixtures.get(engine);
        if (fixture === undefined) throw new Error(`missing ${engine} rendered fixture`);
        const output = acrossShells((shell) => {
          const result = spawnSync(shell, [fixture.hook], {
            cwd: fixture.cwd,
            input: hookPayload(engine, fixture.cwd, command),
            encoding: "utf8",
            env: { ...process.env, CLAUDE_PROJECT_DIR: fixture.cwd },
          });
          expect(result.error).toBeUndefined();
          expect(result.status).toBe(0);
          expect(result.stderr).toBe("");
          return result.stdout;
        });
        if (!needsConsent) {
          expect(output).toBe("");
          continue;
        }
        const response: unknown = JSON.parse(output);
        expect(response).toMatchObject({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: engine === "claude" ? "ask" : "deny",
            permissionDecisionReason: expect.stringContaining("approved"),
          },
        });
        if (engine === "codex") {
          expect(output).toContain("run the command themselves");
        }
        if (command.includes("delivery-review")) {
          expect(output).toContain("named reviewer was separate from the producer");
          expect(output).toContain("does not authenticate reviewer identity or execute QA");
        }
        if (command.includes("delivery-decision")) {
          expect(output).toContain("explicit client decision on this exact presented delivery");
        }
        if (command.includes("delivery-publication")) {
          expect(output).toContain("this records publication, it does not deploy");
        }
      }
    },
  );

  // Covers: R20 — the fixture cannot establish a raw exec_command normalization guarantee.
  it("does not claim interception for an unnormalized Codex exec_command/cmd payload", () => {
    const fixture = fixtures.get("codex");
    if (fixture === undefined) throw new Error("missing codex rendered fixture");
    const stdout = acrossShells((shell) => {
      const result = spawnSync(shell, [fixture.hook], {
        cwd: fixture.cwd,
        input: JSON.stringify({
          tool_name: "exec_command",
          tool_input: { cmd: approvals[0] },
          cwd: fixture.cwd,
        }),
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      return result.stdout;
    });
    expect(stdout).toBe("");
  });

  // Covers: R20 — executing fixtures does not promote the live parity inventory.
  it("leaves the consent capability without a claimed live enforcement verification", () => {
    expect(CODEX_PARITY["hook:master-accept-confirm"]).toMatchObject({
      state: "equivalente",
      enforcing: false,
      difference: expect.stringContaining("user runs the command themselves"),
    });
    expect(CODEX_PARITY["hook:master-accept-confirm"]).not.toHaveProperty("verification");
  });
});
