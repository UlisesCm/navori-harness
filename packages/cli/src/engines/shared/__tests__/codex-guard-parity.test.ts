import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { NavoriConfigSchema } from "../../../lib/config/schema.ts";
import { getCoreRoot } from "../../../lib/render/bundled-assets.ts";
import { HOOK_SHELLS } from "../../../lib/__tests__/helpers/shells.ts";
import { createHookBatch, type HookCase } from "../../../__tests__/helpers/hook-batch.ts";
import { renderManagedFile } from "../render-managed-file.ts";
import { GUARD_GOLDEN } from "./fixtures/claude-verdict-cases.ts";

/**
 * Spec 0057 T28: the Codex copy of guard-destructive decides like the Claude copy. Codex reads its
 * project directory from the payload's `cwd` (the git toplevel) instead of `CLAUDE_PROJECT_DIR`;
 * every rule is otherwise shared. The table drives each rule family, its near misses and inert
 * spellings, so the hook verdict corpus also carries Codex cases for the native replay (R11).
 */

const config = NavoriConfigSchema.parse({
  name: "codex-guard",
  preset: "custom",
  engines: ["claude", "codex"],
  branchBase: "main",
  qualityGate: { fast: "bun test", full: "bun test" },
});

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Commands for every guard-destructive rule, its near misses and inert spellings of both. */
const COMMANDS = [
  ...GUARD_GOLDEN.map(({ command }) => command),
  "git commit -n -m x",
  'git -C . commit "--no-verify"',
  'git commit -m "skip --no-verify later"',
  "git push -f origin main",
  "git push origin +main",
  "git push --force-with-lease origin main",
  "git push --force origin feature",
  "rm -rf $HOME",
  "rm -rf /usr",
  'rm -rf "$DIR"',
  "rm -rf ./dist",
  "sudo rm -rf /",
  "env A=1 rm -rf ~",
  "(rm -rf /)",
  "cat x > /dev/disk2",
  "echo x > /dev/null",
  "printf y >> AGENTS.md",
  "sed -i '' s/a/b/ .claude/settings.json",
  "tee .codex/config.toml",
  "cp x .claude/settings.json",
  "mv a AGENTS.md",
  "echo x > notes.md",
  "pi --no-extensions",
  "git reset --hard",
  "git checkout -- .",
  "git clean -fdx",
  "git clean -n",
  "git reset --soft HEAD~1",
  "grep -rn foo .",
  "rg foo",
  "ls -la && git status",
  "git log --oneline -3 | head -1",
  'gh pr create --body "git push --force origin main"',
  "cat <<'EOF'\nrm -rf /\nEOF",
  "echo 'rm -rf /'",
  "git status \\\n  && rm -rf /",
  "git status; :(){ :|:& };:",
  "",
];

/** Both copies rendered from the same config into one git project. */
function renderCopies(): { project: string; claude: string; codex: string } {
  const project = mkdtempSync(join(tmpdir(), "navori-codex-guard-"));
  dirs.push(project);
  execFileSync("git", ["init", "-q", project]);
  const copy = (engine: "claude" | "codex"): string => {
    const dest = join(project, `.${engine}/hooks/guard-destructive.sh`);
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(
      dest,
      renderManagedFile({
        assetPath: resolve(getCoreRoot(), "core-assets/hooks/guard-destructive.sh"),
        existingContent: null,
        managedId: "guard-destructive-base",
        meta: { source: "@navori/core", version: "0.0.0-test" },
        config,
        commentStyle: "shell",
        engine,
      }).content,
    );
    return dest;
  };
  return { project, claude: copy("claude"), codex: copy("codex") };
}

describe("Codex guard parity: the Codex copy decides like the Claude copy", () => {
  // Covers: R11
  it("every rule family gives the same exit, stdout and stderr under bash and zsh", () => {
    const { project, claude, codex } = renderCopies();
    const cases = COMMANDS.map((command): HookCase => ({
      input: JSON.stringify({
        session_id: "s",
        turn_id: "t",
        cwd: project,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: "call_1",
        tool_input: { command },
      }),
      cwd: project,
    }));
    const claudeBatch = createHookBatch(claude);
    const codexBatch = createHookBatch(codex);
    claudeBatch.prime(HOOK_SHELLS, cases);
    codexBatch.prime(HOOK_SHELLS, cases);
    const blocked = new Set<string>();
    for (const shell of HOOK_SHELLS) {
      for (const [index, c] of cases.entries()) {
        const command = COMMANDS[index];
        const expected = claudeBatch.run(shell, c);
        const actual = codexBatch.run(shell, c);
        expect([0, 2], `${shell}: ${command}`).toContain(actual.status);
        expect(actual, `${shell}: ${command}`).toEqual(expected);
        if (actual.status === 2) blocked.add(command ?? "");
      }
    }
    for (const { command, exit } of GUARD_GOLDEN)
      expect(blocked.has(command), command).toBe(exit === 2);
    // The table reaches the rules, not just the fast path.
    expect(blocked.size).toBeGreaterThanOrEqual(20);
  }, 180_000);
});
