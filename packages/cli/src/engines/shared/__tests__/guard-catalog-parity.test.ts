import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NavoriConfigSchema } from "../../../lib/config/schema.ts";
import { prepareRenderTarget } from "../../../commands/render.ts";
import { load } from "../../pi/__tests__/fixtures/load-extension.ts";
import { GUARD_CATALOG, type CatalogRow, type GuardDecision } from "./fixtures/guard-catalog.ts";

let cwd: string;
beforeAll((): void => {
  cwd = mkdtempSync(join(tmpdir(), "guard-catalog-"));
  execFileSync("git", ["init", "-q", cwd]);
  mkdirSync(join(cwd, "bin"));
  writeFileSync(
    join(cwd, "bin/tgrep"),
    "#!/bin/sh\nprintf 'Index status for fixture\\n  Server:     running\\n'\n",
  );
  chmodSync(join(cwd, "bin/tgrep"), 0o755);
  const config = NavoriConfigSchema.parse({
    name: "catalog",
    preset: "custom",
    engines: ["claude", "codex", "pi"],
    plugins: { tgrep: { enabled: true } },
    harness: { scribe: true, scribeOwnsMarkdown: true },
    qualityGate: { fast: "true", full: "true" },
  });
  const owner = prepareRenderTarget(cwd, config, config.engines, false);
  owner.finalize();
  owner.commit();
});
afterAll((): void => {
  rmSync(cwd, { recursive: true, force: true });
});

/** Run Claude's installed shared scripts, without executing the submitted command. */
function claudeVerdict(
  row: CatalogRow,
  engine: "claude" | "codex" = "claude",
): { decision: GuardDecision; reason: string } {
  const input =
    "command" in row.input
      ? {
          command: row.input.command
            .replaceAll("{root}", cwd)
            .replaceAll("{physicalRoot}", realpathSync(cwd)),
        }
      : { file_path: row.input.path, content: "x", old_string: "a", new_string: "b" };
  const payload = {
    cwd,
    hook_event_name: "PreToolUse",
    tool_name: "command" in row.input ? "Bash" : row.input.tool === "write" ? "Write" : "Edit",
    tool_input: input,
    ...(row.actor === "parent" ? {} : { agent_type: row.actor, agent_id: `catalog-${row.actor}` }),
  };
  let reason = "";
  let blocked = false;
  for (const script of ["guard-destructive", "implementer-no-markdown"]) {
    const result = spawnSync("bash", [join(cwd, `.${engine}/hooks/${script}.sh`)], {
      cwd,
      input: JSON.stringify(payload),
      encoding: "utf-8",
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: cwd,
        PATH: join(cwd, "bin") + ":" + process.env.PATH,
      },
    });
    expect(result.error, row.id).toBeUndefined();
    expect([0, 2], row.id + result.stderr).toContain(result.status);
    reason += result.stderr + result.stdout;
    blocked ||= result.status === 2;
  }
  return { decision: blocked ? "block" : "allow", reason };
}

/** Pi uses its real extension-to-Bash bridge; only the host registration is stubbed. */
async function piVerdict(row: CatalogRow): Promise<{ decision: GuardDecision; reason: string }> {
  const env: Record<string, string> =
    row.actor === "parent" ? {} : { NAVORI_PI_CHILD_DEPTH: "1", NAVORI_PI_CHILD_ROLE: row.actor };
  env.PATH = join(cwd, "bin") + ":" + process.env.PATH;
  const handler = load({ env }).get("tool_call")!;
  const input =
    "command" in row.input
      ? {
          command: row.input.command
            .replaceAll("{root}", cwd)
            .replaceAll("{physicalRoot}", realpathSync(cwd)),
        }
      : { path: row.input.path, content: "x", oldText: "a", newText: "b" };
  const ask = vi.fn(async (): Promise<string> => "yes, run it");
  const result: unknown = await handler(
    {
      toolName: "command" in row.input ? "bash" : row.input.tool,
      toolCallId: `catalog-${row.id}`,
      input,
    },
    {
      cwd,
      hasUI: true,
      ui: { input: ask },
      sessionManager: { getSessionId: () => "catalog-session" },
    },
  );
  if (typeof result === "object" && result !== null && "block" in result && result.block === true) {
    expect("reason" in result && typeof result.reason === "string").toBe(true);
    return { decision: "block", reason: "reason" in result ? String(result.reason) : "" };
  }
  return { decision: ask.mock.calls.length ? "ask" : "allow", reason: "" };
}

describe("K4 shared guard catalog", (): void => {
  // Covers: R8
  it("audits safe copies as skip only after owned destinations and Pi policy pass", (): void => {
    const auditRoot = mkdtempSync(join(tmpdir(), "copy-audit-"));
    const repo = join(auditRoot, basename(cwd));
    const spool = join(repo, "spool-copy-regression");
    mkdirSync(spool, { recursive: true });
    writeFileSync(join(repo, "session-copy-regression.log"), "");
    try {
      for (const engine of ["claude", "codex", "pi"] as const) {
        const cases = [
          ["cp x /tmp/out", "skip", 0],
          ["mv x /tmp/out", "skip", 0],
          ["install x /tmp/out", "skip", 0],
          ["ln x /tmp/out", "skip", 0],
          ["cp x CLAUDE.md", "block", 2],
          ...(engine === "pi"
            ? ([
                ["cp .pi/navori/hooks/guard-destructive.sh /tmp/out", "block", 2],
                ["cp x /tmp/out; pi --no-extensions", "block", 2],
                ["cp x /tmp/out; git branch -D stale", "ask", 0],
                ["cp x /tmp/out; mkfs x", "block", 2],
              ] as const)
            : []),
        ] as const;
        for (const shell of ["bash", "zsh"]) {
          if (spawnSync(shell, ["-c", "exit 0"]).status !== 0) continue;
          for (const [command, verdict, status] of cases) {
            const before = new Set(readdirSync(spool));
            const result = spawnSync(
              shell,
              [
                join(
                  cwd,
                  `.${engine}/${engine === "pi" ? "navori/" : ""}hooks/guard-destructive.sh`,
                ),
              ],
              {
                cwd,
                encoding: "utf-8",
                env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, NAVORI_AUDITS_ROOT: auditRoot },
                input: JSON.stringify({
                  cwd,
                  session_id: "copy-regression",
                  tool_input: { command },
                }),
              },
            );
            expect(result.status, command + result.stderr).toBe(status);
            const events = readdirSync(spool).filter((name) => !before.has(name));
            expect(events, command).toHaveLength(1);
            const event = JSON.parse(readFileSync(join(spool, events[0]!), "utf-8")) as {
              metadata: { verdict: string };
            };
            expect(event.metadata.verdict, `${engine}/${shell}: ${command}`).toBe(verdict);
          }
        }
      }
    } finally {
      rmSync(auditRoot, { recursive: true, force: true });
    }
  });

  // Covers: R8
  it("blocks a lexical macOS alias through the real Pi bridge without folding a sibling root", async (): Promise<void> => {
    const physical = realpathSync(cwd);
    const target = cwd.startsWith("/var/") ? cwd : physical;
    const row = (command: string): CatalogRow => ({
      id: "physical-alias",
      input: { command },
      actor: "parent",
      layer: "script",
      expect: { claude: "block", pi: "block" },
    });
    expect((await piVerdict(row(`cp x ${target}/CLAUDE.md`))).decision).toBe("block");
    expect((await piVerdict(row(`cp x ${physical}-sibling/CLAUDE.md`))).decision).toBe("allow");
  });

  // Covers: R7, R8
  it("keeps Codex apply_patch in the edit lane and enforces the Markdown doctrine boundary", (): void => {
    const invoke = (path: string, script: string): number | null =>
      spawnSync("bash", [join(cwd, `.codex/hooks/${script}.sh`)], {
        cwd,
        encoding: "utf-8",
        input: JSON.stringify({
          cwd,
          hook_event_name: "PreToolUse",
          tool_name: "apply_patch",
          agent_type: "implementer",
          tool_input: { command: `*** Begin Patch\n*** Add File: ${path}\n+x\n*** End Patch` },
        }),
      }).status;
    expect(invoke("notes.md", "implementer-no-markdown")).toBe(2);
    expect(invoke(".codex/agents/custom.md", "implementer-no-markdown")).toBe(0);
    // The copy/shell guard grants no new prohibition over the native edit tool.
    expect(invoke("CLAUDE.md", "guard-destructive")).toBe(0);
  });

  // Covers: R2, R6, R7, R8
  it.each(GUARD_CATALOG)(
    "$id [$layer] has its declared engine decisions and remedy",
    async (row): Promise<void> => {
      const pi = await piVerdict(row);
      expect(pi.decision, row.id + pi.reason).toBe(row.expect.pi);
      if (row.layer === "script") {
        const claude = claudeVerdict(row);
        expect(claude.decision, row.id + claude.reason).toBe(row.expect.claude);
        if (row.engineSpecific === undefined) {
          expect(row.expect.claude).toBe(row.expect.pi);
          expect(claude.decision).toBe(pi.decision);
          if (row.route) {
            expect(claude.reason).toContain(row.route);
            expect(pi.reason).toContain(row.route);
          }
        } else expect(row.engineSpecific.length).toBeGreaterThan(0);
        if (row.id.startsWith("owned-copy-"))
          expect(claudeVerdict(row, "codex").decision).toBe("block");
      } else if (row.layer === "claude-settings") {
        const settings = JSON.parse(readFileSync(join(cwd, ".claude/settings.json"), "utf-8")) as {
          permissions: { ask: string[] };
        };
        expect(row.expect.claude).toBe("ask");
        expect(settings.permissions.ask).toContain("Bash(rm -r *)");
      } else expect(row.expect.claude).toBe("n/a");
    },
    60_000,
  );
});
