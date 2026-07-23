import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, symlinkSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { getCoreRoot } from "../bundled-assets.ts";

/**
 * Behavioral guard tests for core-assets/hooks/guard-destructive.sh.
 *
 * The guard reads Claude Code's PreToolUse payload from stdin and HARD-BLOCKS
 * (exit 2) destructive commands. It used to parse the payload with `jq`, which
 * is NOT preinstalled on macOS — a missing jq made the guard wave every command
 * through (fail-open). The fix extracts the command via jq → node → sed so the
 * guard keeps working with no JSON parser on PATH. These tests pin BOTH the
 * happy path and the no-parser fallback so that regression can't come back.
 */

const runsBash = process.platform !== "win32";
const guardPath = resolve(getCoreRoot(), "core-assets/hooks/guard-destructive.sh");

function resolveBin(name: string): string {
  return execFileSync("bash", ["-c", `command -v ${name}`], { encoding: "utf-8" }).trim();
}

/** Run the guard with `command` on stdin; returns its exit code. */
function runGuard(command: string, env?: NodeJS.ProcessEnv): number {
  return runGuardScript(guardPath, command, env);
}

function runGuardScript(scriptPath: string, command: string, env?: NodeJS.ProcessEnv): number {
  const payload = JSON.stringify({ tool_input: { command } });
  try {
    execFileSync(resolveBin("bash"), [scriptPath], {
      input: payload,
      env: env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? -1;
  }
}

/**
 * The base-branch rules key off `{{branchBase}}`, which is a live placeholder in
 * the source asset. Render a temp copy with the placeholder substituted (as
 * `navori render` does) so force-push-to-base assertions have a concrete base.
 */
function renderGuard(base: string): string {
  const raw = readFileSync(guardPath, "utf-8").replace(/\{\{branchBase\}\}/g, base);
  const dir = mkdtempSync(join(tmpdir(), "navori-guard-render-"));
  const p = join(dir, "guard.sh");
  writeFileSync(p, raw);
  chmodSync(p, 0o755);
  return p;
}

describe.runIf(runsBash)("guard-destructive.sh", () => {
  describe("with a JSON parser on PATH (jq/node)", () => {
    it("blocks `rm -rf /` (exit 2)", () => {
      expect(runGuard("rm -rf /")).toBe(2);
    });

    it("blocks `git commit --no-verify` (exit 2)", () => {
      expect(runGuard("git commit --no-verify -m x")).toBe(2);
    });

    it("allows a benign command (exit 0)", () => {
      expect(runGuard("ls -la")).toBe(0);
    });

    it("allows a normal commit without --no-verify (exit 0)", () => {
      expect(runGuard('git commit -m "feat: x"')).toBe(0);
    });

    // Rule 1 gap: `-n` folded into a combined short-flag token still skips hooks.
    it("blocks `git commit -qn` (combined short flags, exit 2)", () => {
      expect(runGuard("git commit -qn -m x")).toBe(2);
    });

    it("blocks `git commit -nq` (n anywhere in the token, exit 2)", () => {
      expect(runGuard("git commit -nq -m x")).toBe(2);
    });

    // Rule 2 gap: a `;`/`&`/`|` boundary with no trailing space before `git`.
    // Base-branch rules need the {{branchBase}} placeholder rendered first.
    it("blocks `true;git push --force <base>` (no space after `;`, exit 2)", () => {
      const rendered = renderGuard("main");
      expect(runGuardScript(rendered, "true;git push --force main")).toBe(2);
    });

    it("still allows `git push --force feature` (not the base branch, exit 0)", () => {
      const rendered = renderGuard("main");
      expect(runGuardScript(rendered, "git push --force feature")).toBe(0);
    });

    it("blocks `x&&git commit --no-verify` past a tight `&&` boundary (exit 2)", () => {
      expect(runGuard("x&&git commit --no-verify -m y")).toBe(2);
    });

    it("still allows force-with-lease on a feature branch (exit 0)", () => {
      expect(runGuard("git push --force-with-lease origin feature")).toBe(0);
    });

    // FIX A: a hyphen-word inside a quoted commit message must NOT trip the
    // combined short-flag pattern (`-[a-zA-Z]*n[a-zA-Z]*`). origin/main blocked
    // these; stripping quoted spans before matching fixes the false positive.
    it("does NOT block a quoted commit message containing `-notify` (exit 0)", () => {
      expect(runGuard('git commit -m "add -notify option"')).toBe(0);
    });

    it("does NOT block a quoted commit message containing `-node` (exit 0)", () => {
      expect(runGuard('git commit -m "add -node support"')).toBe(0);
    });

    it("does NOT block a quoted commit message containing `-network` (exit 0)", () => {
      expect(runGuard('git commit -m "add -network flag"')).toBe(0);
    });

    // FIX B: a backslash-newline continuation splits the flag onto a separate
    // line; grep is line-by-line, so `--no-verify` used to evade rule 1. Joining
    // continuations before matching closes it.
    it("blocks a multi-line `git commit \\\\<NL> --no-verify` (exit 2)", () => {
      expect(runGuard("git commit \\\n --no-verify -m x")).toBe(2);
    });

    // FIX C: git global options between `git` and the subcommand, plus simple
    // wrappers (`command`/`\\git`/parens), all used to evade both rules.
    it("blocks `git -c k=v commit --no-verify` (global option, exit 2)", () => {
      expect(runGuard("git -c k=v commit --no-verify")).toBe(2);
    });

    it("blocks `command git commit --no-verify` (command wrapper, exit 2)", () => {
      expect(runGuard("command git commit --no-verify")).toBe(2);
    });

    it("blocks `\\git commit --no-verify` (leading backslash, exit 2)", () => {
      expect(runGuard("\\git commit --no-verify")).toBe(2);
    });

    it("blocks `(git commit --no-verify)` (subshell parens, exit 2)", () => {
      expect(runGuard("(git commit --no-verify)")).toBe(2);
    });

    it("blocks `git -C /repo push --force <base>` (global -C with arg, exit 2)", () => {
      const rendered = renderGuard("main");
      expect(runGuardScript(rendered, "git -C /repo push --force origin main")).toBe(2);
    });

    // FIX C negatives: the global-options relaxation must not treat a non-commit
    // subcommand as a commit.
    it("does NOT block `git config user.name x` (exit 0)", () => {
      expect(runGuard("git config user.name x")).toBe(0);
    });
  });

  describe("with NO JSON parser on PATH (sed fallback)", () => {
    // A minimal PATH with only the coreutils the guard needs — deliberately
    // without jq or node — proves the guard still inspects the command instead
    // of failing open. This is the exact scenario the fix targets.
    let restrictedEnv: NodeJS.ProcessEnv;

    beforeAll(() => {
      const bin = mkdtempSync(join(tmpdir(), "navori-guard-nobin-"));
      for (const tool of ["cat", "grep", "sed"]) {
        symlinkSync(resolveBin(tool), join(bin, tool));
      }
      restrictedEnv = { PATH: bin };
    });

    it("still blocks `rm -rf /` (exit 2)", () => {
      expect(runGuard("rm -rf /", restrictedEnv)).toBe(2);
    });

    it("still blocks `git commit --no-verify` (exit 2)", () => {
      expect(runGuard("git commit --no-verify -m x", restrictedEnv)).toBe(2);
    });

    it("still allows a benign command (exit 0)", () => {
      expect(runGuard("ls", restrictedEnv)).toBe(0);
    });
  });
});
