import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getCoreRoot } from "../../../lib/render/bundled-assets.ts";
import { expandHookIncludes } from "../../../lib/render/hook-includes.ts";
import { acrossShells, type HookShell } from "../../../lib/__tests__/helpers/shells.ts";
import {
  createExecShims,
  expectLinearTrace,
  traceShape,
  type TraceShape,
} from "../../../lib/__tests__/helpers/exec-shims.ts";

/** Backslash continuation and quote-stripping of `sh -c`/`eval` payloads are parsed by the shell (#391). */
const CONTINUATION_SENSITIVE =
  "backslash-newline continuation and nested quote handling are shell-specific";
import { buildClaudeSettings, claudeHookCommand } from "../build-settings.ts";
import type { NavoriConfig } from "../../../lib/config/config.ts";

const runsBash = process.platform !== "win32";
const hookPath = (() => {
  const dir = mkdtempSync(join(tmpdir(), "navori-master-accept-src-"));
  const path = join(dir, "master-accept-confirm.sh");
  writeFileSync(
    path,
    expandHookIncludes(
      readFileSync(resolve(getCoreRoot(), "core-assets/hooks/master-accept-confirm.sh"), "utf-8"),
    ),
  );
  chmodSync(path, 0o755);
  return path;
})();

interface HookRun {
  code: number;
  stdout: string;
}

function payload(command: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: "master-accept-1",
    tool_name: "Bash",
    tool_input: { command },
    ...extra,
  };
}

function runHook(
  shell: HookShell,
  input: Record<string, unknown>,
  env?: NodeJS.ProcessEnv,
): HookRun {
  const cwd = mkdtempSync(join(tmpdir(), "navori-master-accept-"));
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  const result = spawnSync(shell, [hookPath], {
    input: JSON.stringify(input),
    encoding: "utf-8",
    env: { ...process.env, ...env, CLAUDE_PROJECT_DIR: cwd },
  });
  return { code: result.status ?? -1, stdout: result.stdout ?? "" };
}

function run(input: Record<string, unknown>, env?: NodeJS.ProcessEnv, sensitive?: string): HookRun {
  return acrossShells((shell) => runHook(shell, input, env), { sensitive });
}

function expectAsk(
  input: Record<string, unknown>,
  env?: NodeJS.ProcessEnv,
  approval = "the QA verdict on these slices or decisions, written to navori/acceptance",
  sensitive?: string,
): void {
  const result = run(input, env, sensitive);
  expect(result.code).toBe(0);
  const parsed = JSON.parse(result.stdout) as {
    hookSpecificOutput?: {
      permissionDecision?: string;
      permissionDecisionReason?: string;
    };
  };
  expect(parsed.hookSpecificOutput?.permissionDecision).toBe("ask");
  expect(parsed.hookSpecificOutput?.permissionDecisionReason).toBe(
    `[navori] this records that you approved ${approval}. Confirm only if you reviewed it.`,
  );
}

describe.runIf(runsBash)("master-accept-confirm.sh", () => {
  // Covers: spec 0063 — the QA verdict asks with any invoker, and so does touching its log.
  it.each([
    "navori master accept S1 --approved-by user",
    "node /x/packages/cli/dist/index.js master accept S1 --approved-by user",
    "npx navori master reject S2 --notes a --approved-by user",
  ])("asks for the acceptance verdict: %s", (command: string) => {
    expectAsk(
      payload(command),
      undefined,
      "the QA verdict on these slices or decisions, written to navori/acceptance",
    );
  });

  it.each(["git push origin navori/acceptance", "git update-ref refs/heads/navori/acceptance abc"])(
    "asks before a direct change to the acceptance log: %s",
    (command: string) => {
      expectAsk(
        payload(command),
        undefined,
        "a direct change to the acceptance log (navori/acceptance)",
      );
    },
  );

  it.each(["navori master status", "navori master check --incoming x", "echo masterpiece"])(
    "stays silent on a read-only command: %s",
    (command: string) => {
      expect(run(payload(command)).stdout).toBe("");
    },
  );

  // Covers: R58, R62
  it.each([
    "navori master delivery-present --delivery E1",
    "navori master delivery-slice --part P1",
    "navori master delivery-criterion --part P1 --criterion A1",
    "navori master delivery-criterion --part P1 --criterion A1; echo --approved-by user",
  ])("does not infer an attestation from non-consent work: %s", (command: string) => {
    expect(run(payload(command)).stdout).toBe("");
  });

  // Covers: R58, R62 — spec 0063 T6: the v1 write forms are refused by the CLI, so they no longer ask.
  it.each([
    "navori master part P2 --accept A3 --approved-by user",
    "navori master close",
    "navori master close --abandon --reason x",
    "navori master delivery-baseline --approved-by user",
    "navori master delivery-queue --delivery E1 --parts P1 --approved-by=user",
    "navori master delivery-review --part P1 --report report.txt --envelope review.json --approved-by user",
    "navori master delivery-decision --delivery E1 --identity abc --decision accepted --approved-by user",
    "bunx navori master delivery-publication --delivery E1 --kind release --reference v1 --approved-by user",
    "navori master delivery-revoke --approved-by user",
    "navori master delivery-slice --part P1 --refresh --approved-by user",
  ])("no longer asks on a refused v1 write: %s", (command: string) => {
    expect(run(payload(command)).stdout).toBe("");
  });

  it("does not treat a read-only delivery check as approval", () => {
    expect(run(payload("navori master delivery-check")).stdout).toBe("");
    expect(run(payload("navori master delivery-check && echo --approved-by user")).stdout).toBe("");
  });

  // Covers: R62
  it("asks on navori master accept S1 --approved-by user (main thread)", () => {
    expectAsk(payload("navori master accept S1 --approved-by user"));
  });

  // Covers: R62
  it("asks on approved-by from a subagent", () => {
    expectAsk(
      payload("navori master accept S1 --approved-by user", {
        agent_id: "a1",
      }),
    );
  });

  // Covers: R62
  it("asks on approved-by under auto", () => {
    expectAsk(
      payload("navori master accept S1 --approved-by user", {
        permission_mode: "auto",
      }),
    );
  });

  // Covers: R62
  it("asks on approved-by under bypassPermissions", () => {
    expectAsk(
      payload("navori master accept S1 --approved-by user", {
        permission_mode: "bypassPermissions",
      }),
    );
  });

  // Covers: R62
  it("asks on approved-by under dontAsk", () => {
    expectAsk(
      payload("navori master accept S1 --approved-by user", {
        permission_mode: "dontAsk",
      }),
    );
  });

  // Covers: R62
  it("ignores navori master status and check", () => {
    expect(run(payload("navori master status --json")).stdout.trim()).toBe("");
    expect(run(payload("navori master check --part P2 --approved-by user")).stdout.trim()).toBe("");
  });

  // Covers: R62
  it("asks on chained cd x && navori master accept … --approved-by user", () => {
    expectAsk(payload("cd x && navori master accept S1 --approved-by user"));
  });

  // Covers: R62
  it("asks on chained true; navori master reject … --approved-by user", () => {
    expectAsk(payload("true; navori master reject S1 --notes a --approved-by user"));
  });

  // Covers: R62
  it("asks on subshell (navori master accept … --approved-by user)", () => {
    expectAsk(payload("(navori master accept S1 --approved-by user)"));
  });

  // Covers: R62
  it("asks on command substitution $(navori master accept … --approved-by user)", () => {
    expectAsk(payload("$(navori master accept S1 --approved-by user)"));
  });

  // Covers: R58
  it.each([
    "navori master accept S1 --approved-by=user",
    "navori master accept S1 D2 --approved-by user",
    "npx navori master accept S1 --approved-by user",
    "npx --yes navori master reject S2 --notes a --approved-by=user",
    "bunx navori master accept S1 --approved-by user",
    "pnpm exec navori master reject S2 --notes a --approved-by user",
    "pnpm dlx navori master accept S1 --approved-by user",
    "./node_modules/.bin/navori master accept S1 --approved-by user",
    "/usr/local/bin/navori master reject S2 --notes a --approved-by=user",
    "navori master accept",
    "navori master reject",
    "/opt/bin/navori master accept",
    "cd x && navori master accept",
    "(navori master accept)",
    "x=$(navori master accept S1)",
    "echo $(navori master reject S1)",
    "navori master accept>/dev/null",
    "navori master accept;true",
    "navori master accept|cat",
    "npx navori@latest master accept S1",
    "npx -y navori@latest master accept S1",
    "npx navori@1.2 master reject S2 --notes a",
    "bunx navori@latest master accept S1",
    "bunx navori@1.2.3 master accept S1 --approved-by user",
  ])("asks on %s", (command) => {
    expectAsk(payload(command));
  });

  // Covers: R58
  it.each([
    "git push origin master",
    "navori master status",
    "navori master advance",
    "navori master check --part P2",
    "echo navori master closet",
    "echo navori master acceptable",
  ])("stays silent on %s", (command) => {
    expect(run(payload(command)).stdout.trim()).toBe("");
  });

  // Covers: R36
  it("sh -c, bash -lc, eval y argumentos entrecomillados preguntan y la continuación con barra invertida sigue preguntando en bash y zsh", () => {
    for (const command of [
      "sh -c 'navori master accept S1'",
      'bash -lc "cd x && navori master reject S1 --notes a --approved-by user"',
      'eval "navori master accept S1"',
      'navori master "accept" S1',
      "navori master \\\n  accept S1 --approved-by user",
    ]) {
      expectAsk(payload(command), undefined, undefined, CONTINUATION_SENSITIVE);
    }
    // Wrapped read-only commands stay silent.
    expect(
      run(payload("sh -c 'navori master status'"), undefined, CONTINUATION_SENSITIVE).stdout.trim(),
    ).toBe("");
    expect(
      run(
        payload('bash -lc "navori master check --part P1"'),
        undefined,
        CONTINUATION_SENSITIVE,
      ).stdout.trim(),
    ).toBe("");
  });

  // Covers: R9
  it("escalation-reset con approved-by pregunta en Claude y deniega como confirmación en Codex", () => {
    const description = "another review round after two rejections at level 2 or higher";
    const command = 'navori plan escalation-reset demo --approved-by user --reason "again"';
    expectAsk(payload(command), undefined, description);
    expectAsk(
      payload(`cd x && npx navori plan escalation-reset demo --approved-by=user`),
      undefined,
      description,
    );

    // Without --approved-by the CLI itself refuses; the hook stays silent.
    expect(run(payload("navori plan escalation-reset demo --reason x")).stdout.trim()).toBe("");
    expect(run(payload("navori plan check demo --approved-by user")).stdout.trim()).toBe("");

    const dir = join(mkdtempSync(join(tmpdir(), "navori-reset-codex-")), ".codex/hooks");
    mkdirSync(dir, { recursive: true });
    const codexPath = join(dir, "master-accept-confirm.sh");
    writeFileSync(codexPath, readFileSync(hookPath, "utf-8"));
    chmodSync(codexPath, 0o755);
    const result = spawnSync("bash", [codexPath], {
      input: JSON.stringify(payload(command)),
      encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout).hookSpecificOutput;
    expect(out.permissionDecision).toBe("deny");
    expect(out.permissionDecisionReason).toContain(description);
  });

  // Covers: R62
  it("emits the fixed reason without jq or node", () => {
    expectAsk(payload("navori master accept S1 --approved-by user"), {
      PATH: "/usr/bin:/bin",
    });
  });

  // Issue #1481: bash 3.2's `${var//[class]/}` is superlinear (6.5 KB took 44 s, over Pi's 10 s
  // hook timeout) and a `grep` fork per segment made the cost scale with the segment count. The
  // checks below are about SHAPE (fork counts, scaling), never an absolute time.
  describe("long multi-segment commands containing navori and master (issue #1481)", () => {
    // Several `&&`/`|`/`;` per line: realistic long commands have many segments.
    const line = `echo 'navori master check' && ls /Users/x/navori-harness/packages | grep "core"; cat a || true\n`;
    const heredoc = `cat <<'EOF'\n${"navori master line with 'quotes' and \"more\"\n".repeat(400)}EOF\n`;
    const trigger = "navori master accept S1 --approved-by user";
    const hookRun = (command: string, env?: NodeJS.ProcessEnv): HookRun =>
      runHook("bash", payload(command), env);

    // Covers: R62
    it("forks the same constant number of grep/awk/tr/sed for 20 and 200 lines", () => {
      const shims = createExecShims();
      const counts = (lines: number): Record<string, number> => {
        shims.reset();
        const result = hookRun(line.repeat(lines), shims.env);
        expect(result.code).toBe(0);
        expect(result.stdout).toBe("");
        return shims.counts();
      };
      const small = counts(20);
      const large = counts(200);
      expect(large).toEqual(small);
      // The segment scan is ONE grep over the whole stream, not one per segment.
      expect(large.grep).toBeGreaterThanOrEqual(1); // the shims really observe execs
      expect(large.grep).toBeLessThanOrEqual(2);
    });

    // Covers: R62
    it("scales linearly: a 20 KB command traces at most 2.5x the work of a 10 KB one", () => {
      // The xtrace of a run is the work bash did, so its growth is the scaling on any load.
      const traceOf = (lines: number): TraceShape => {
        const cwd = mkdtempSync(join(tmpdir(), "navori-master-accept-"));
        mkdirSync(join(cwd, ".claude"), { recursive: true });
        return traceShape({
          script: hookPath,
          input: JSON.stringify(payload(line.repeat(lines))),
          env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
        });
      };
      expectLinearTrace(traceOf(105), traceOf(210));
    });

    // Covers: R62
    it("stays silent on a 40 KB command without a trigger", () => {
      const filler = line.repeat(440);
      expect(filler.length).toBeGreaterThan(40_000);
      const result = hookRun(filler);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
    });

    // Covers: R62
    it("still asks when the same 40 KB command ends with a real trigger", () => {
      const result = hookRun(`${line.repeat(440)}${trigger}`);
      expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
    });

    // Covers: R62
    it("asks on a trigger after a ~400-line heredoc body", () => {
      const result = hookRun(`${heredoc}${trigger}\n`);
      expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
    });
  });
});

const base = {
  name: "master-accept-demo",
  engines: ["claude"],
  preset: "custom",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
} as unknown as NavoriConfig;

describe("master-accept-confirm wiring", () => {
  // Covers: R62
  it("registers the hook only with masterPlan enabled", () => {
    const hookCommands = (settings: Record<string, unknown>): string[] => {
      const hooks = settings.hooks as {
        PreToolUse?: Array<{ hooks: Array<{ command: string }> }>;
      };
      return (hooks.PreToolUse ?? []).flatMap((entry) => entry.hooks.map((hook) => hook.command));
    };

    const enabled = buildClaudeSettings(
      { ...base, harness: { masterPlan: true } } as NavoriConfig,
      [],
    );
    const disabled = buildClaudeSettings(
      { ...base, harness: { masterPlan: false } } as NavoriConfig,
      [],
    );

    expect(hookCommands(enabled)).toContain(
      claudeHookCommand("PreToolUse", ".claude/hooks/master-accept-confirm.sh"),
    );
    expect(hookCommands(disabled)).not.toContain(
      claudeHookCommand("PreToolUse", ".claude/hooks/master-accept-confirm.sh"),
    );
  });
});

// Covers: R20 — the Codex copy (installed under .codex/hooks/) cannot ask, so it denies.
describe.runIf(runsBash)("master-accept-confirm.sh installed for Codex", () => {
  const codexPath = (() => {
    const dir = join(mkdtempSync(join(tmpdir(), "navori-master-accept-codex-")), ".codex/hooks");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "master-accept-confirm.sh");
    writeFileSync(path, readFileSync(hookPath, "utf-8"));
    chmodSync(path, 0o755);
    return path;
  })();

  // Covers: R20, R58, R62
  it.each([
    "navori master accept S1 --approved-by user",
    "navori master reject S2 --notes a --approved-by user",
    "echo ready && pnpm exec navori master accept S1 --approved-by user",
  ])("denies approval and never asks or allows: %s", (command: string) => {
    const result = spawnSync("bash", [codexPath], {
      input: JSON.stringify(payload(command)),
      encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    const decision = JSON.parse(result.stdout).hookSpecificOutput.permissionDecision;
    expect(decision).toBe("deny");
    expect(result.stdout).toContain("the QA verdict on these slices or decisions");
  });

  it("denies a verdict on the Codex copy", () => {
    const result = spawnSync("bash", [codexPath], {
      input: JSON.stringify(payload("navori master accept S1 --approved-by user")),
      encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it.each(["git status", "navori master delivery-check"])(
    "stays silent on a non-approval command: %s",
    (command: string) => {
      const result = spawnSync("bash", [codexPath], {
        input: JSON.stringify(payload(command)),
        encoding: "utf-8",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    },
  );
});
