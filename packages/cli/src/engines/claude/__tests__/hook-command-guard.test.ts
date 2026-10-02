import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acrossShells, type HookShell } from "../../../lib/__tests__/helpers/shells.ts";
import { buildClaudeSettings, claudeHookCommand } from "../build-settings.ts";
import type { NavoriConfig } from "../../../lib/config/config.ts";

/**
 * A hook script bash cannot parse — conflict markers left by a merge or rebase
 * in a self-hosted `.claude/hooks/` — made bash exit 2, Claude Code's BLOCK
 * signal: every PreToolUse hook blocked Bash/Edit/Write (so the agent could not
 * even abort the rebase) and a Stop hook looped the session. The registered
 * command parse-checks the script first; these cases run that exact command.
 */

const SCRIPT = ".claude/hooks/fixture.sh";
const CONFLICTED = [
  "<<<<<<< HEAD",
  '# navori:managed start id="fixture-base" hash="aaaaaaaa" version="0.11.0"',
  "=======",
  '# navori:managed start id="fixture-base" hash="bbbbbbbb" version="0.11.1"',
  ">>>>>>> 1f7cbee9 (chore(release): navori v0.11.1)",
  "#!/usr/bin/env bash",
  "exit 0",
].join("\n");
// Echoes its args, `$0` and stdin, then exits 2: proves the healthy path is a
// transparent `exec` (args, script path, payload and a blocking code all reach).
const HEALTHY = '#!/usr/bin/env bash\necho "args=$* zero=$0 stdin=$(cat)"\nexit 2\n';

function projectWith(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "navori-hook-cmd-"));
  mkdirSync(join(dir, ".claude/hooks"), { recursive: true });
  writeFileSync(join(dir, SCRIPT), body);
  return dir;
}

function run(shell: HookShell, dir: string, command: string) {
  const r = spawnSync(shell, ["-c", command], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    input: '{"tool_name":"Bash"}',
    encoding: "utf-8",
  });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

describe("claudeHookCommand — unparseable hook scripts", () => {
  it("asks instead of blocking when a PreToolUse script cannot be parsed", () => {
    const dir = projectWith(CONFLICTED);
    const result = acrossShells((shell) =>
      run(shell, dir, claudeHookCommand("PreToolUse", SCRIPT)),
    );
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain(SCRIPT);
  });

  it("exits 1 (non-blocking) with a notice for any other event, so Stop cannot loop", () => {
    const dir = projectWith(CONFLICTED);
    const result = acrossShells((shell) =>
      run(shell, dir, claudeHookCommand("Stop", SCRIPT, "claude-stop")),
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`navori: ${SCRIPT} cannot be parsed`);
  });

  it("runs a healthy script transparently: args, $0, stdin and exit code", () => {
    const dir = projectWith(HEALTHY);
    for (const event of ["PreToolUse", "Stop"]) {
      const result = acrossShells((shell) =>
        run(shell, dir, claudeHookCommand(event, SCRIPT, "claude-stop")),
      );
      expect(result.status).toBe(2);
      expect(result.stdout).toBe(
        `args=claude-stop zero=${join(dir, SCRIPT)} stdin={"tool_name":"Bash"}`,
      );
    }
  });

  it("guards every core hook registration", () => {
    const settings = buildClaudeSettings({ engines: ["claude"] } as unknown as NavoriConfig, []);
    const commands = Object.values(settings.hooks as Record<string, unknown[]>)
      .flat()
      .flatMap((entry) => (entry as { hooks: Array<{ command: string }> }).hooks)
      .map((h) => h.command);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) expect(command).toMatch(/^f="\$CLAUDE_PROJECT_DIR\//);
  });
});
