import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { NavoriConfigSchema, type NavoriConfig } from "../../lib/schema.ts";
import { scanClaudeHookScripts, computeHealthVerdict } from "../doctor.ts";

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "navori-claude-doctor-"));
}

function config(overrides: Partial<NavoriConfig> = {}): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "cl",
    engines: ["claude"],
    preset: "custom",
    branchBase: "main",
    ...overrides,
  });
}

/** Write a `.claude/settings.json` with one PreToolUse hook pointing at `cmd`. */
function writeSettings(cwd: string, cmd: string): void {
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(
    join(cwd, ".claude/settings.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: cmd }] }],
      },
    }),
  );
}

describe("scanClaudeHookScripts (#213)", () => {
  it("returns null when claude is not a configured engine", () => {
    const cwd = tempRepo();
    writeSettings(cwd, 'bash "$CLAUDE_PROJECT_DIR/.claude/scripts/check-semgrep.sh"');
    expect(scanClaudeHookScripts(cwd, config({ engines: ["codex"] }))).toBeNull();
  });

  it("returns null when there is no settings.json yet", () => {
    expect(scanClaudeHookScripts(tempRepo(), config())).toBeNull();
  });

  it("returns null on corrupted settings.json (left to scanCorruptedSettings)", () => {
    const cwd = tempRepo();
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(join(cwd, ".claude/settings.json"), "{ not valid json");
    expect(scanClaudeHookScripts(cwd, config())).toBeNull();
  });

  it("flags a referenced script that is missing on disk", () => {
    const cwd = tempRepo();
    writeSettings(cwd, 'bash "$CLAUDE_PROJECT_DIR/.claude/scripts/check-semgrep.sh"');
    const report = scanClaudeHookScripts(cwd, config());
    expect(report?.missing).toContain(".claude/scripts/check-semgrep.sh");
    expect(report?.notExecutable).toEqual([]);
  });

  it("flags a referenced script present but without the executable bit", () => {
    const cwd = tempRepo();
    writeSettings(cwd, 'bash "$CLAUDE_PROJECT_DIR/.claude/scripts/check-jscpd.sh"');
    mkdirSync(join(cwd, ".claude/scripts"), { recursive: true });
    const script = join(cwd, ".claude/scripts/check-jscpd.sh");
    writeFileSync(script, "#!/bin/sh\n");
    chmodSync(script, 0o644); // no +x
    const report = scanClaudeHookScripts(cwd, config());
    expect(report?.notExecutable).toContain(".claude/scripts/check-jscpd.sh");
    expect(report?.missing).toEqual([]);
  });

  it("passes a referenced hook that exists and is executable", () => {
    const cwd = tempRepo();
    writeSettings(cwd, 'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-destructive.sh"');
    mkdirSync(join(cwd, ".claude/hooks"), { recursive: true });
    const hook = join(cwd, ".claude/hooks/guard-destructive.sh");
    writeFileSync(hook, "#!/bin/sh\n");
    chmodSync(hook, 0o755);
    const report = scanClaudeHookScripts(cwd, config());
    expect(report).toEqual({ missing: [], notExecutable: [] });
  });

  it("finds hook references nested under different events", () => {
    const cwd = tempRepo();
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(
      join(cwd, ".claude/settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                { type: "command", command: 'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/guard.sh"' },
              ],
            },
          ],
          SessionStart: [
            {
              hooks: [
                { type: "command", command: 'bash "$CLAUDE_PROJECT_DIR/.claude/scripts/ctx.sh"' },
              ],
            },
          ],
        },
      }),
    );
    const report = scanClaudeHookScripts(cwd, config());
    expect(report?.missing).toEqual([".claude/hooks/guard.sh", ".claude/scripts/ctx.sh"]);
  });
});

describe("computeHealthVerdict (#244 — shared doctor/status gate)", () => {
  it("is ok on a bare custom-preset repo with no rendered output", () => {
    const cwd = tempRepo();
    expect(computeHealthVerdict(cwd, config()).ok).toBe(true);
  });

  it("flips ok when settings.json is corrupted (same signal doctor exits 2 on)", () => {
    const cwd = tempRepo();
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(join(cwd, ".claude/settings.json"), "{ not valid json");
    const verdict = computeHealthVerdict(cwd, config());
    expect(verdict.ok).toBe(false);
    expect(verdict.corruptedSettings).toHaveLength(1);
  });

  it("flips ok when an enabled plugin can't be loaded", () => {
    const cwd = tempRepo();
    const verdict = computeHealthVerdict(cwd, config({ plugins: { ghost: { enabled: true } } }));
    expect(verdict.ok).toBe(false);
    expect(verdict.missingPlugins.map((m) => m.id)).toContain("ghost");
  });
});
