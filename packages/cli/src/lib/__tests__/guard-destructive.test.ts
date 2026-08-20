import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, symlinkSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { getCoreRoot } from "../bundled-assets.ts";
import { shellSingleQuote } from "../shell-escape.ts";
import { expandHookIncludes } from "../hook-includes.ts";

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
// The hook ships with `# navori:include` directives that `navori render` inlines.
// Expand them once here so the tests drive exactly what a rendered hook runs
// (the `{{shq:branchBase}}` placeholder is left for `renderGuard` to substitute).
const guardSource = resolve(getCoreRoot(), "core-assets/hooks/guard-destructive.sh");
const guardPath = (() => {
  const dir = mkdtempSync(join(tmpdir(), "navori-guard-src-"));
  const p = join(dir, "guard-destructive.sh");
  writeFileSync(p, expandHookIncludes(readFileSync(guardSource, "utf-8")));
  chmodSync(p, 0o755);
  return p;
})();

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
 * The base-branch rules key off `{{shq:branchBase}}`, a live placeholder in the
 * source asset that `navori render` shell-quotes (#197). Render a temp copy with
 * the placeholder substituted the same way so force-push-to-base assertions have
 * a concrete base.
 */
function renderGuard(base: string): string {
  const raw = readFileSync(guardPath, "utf-8").replace(
    /\{\{shq:branchBase\}\}/g,
    shellSingleQuote(base),
  );
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

    // A hyphen-word inside a quoted commit message must NOT trip the combined
    // short-flag pattern (`-[a-zA-Z]*n[a-zA-Z]*`), which runs over a
    // quote-stripped copy of the command exactly for this reason.
    it("does NOT block a quoted commit message containing `-notify` (exit 0)", () => {
      expect(runGuard('git commit -m "add -notify option"')).toBe(0);
    });

    it("does NOT block a quoted commit message containing `-node` (exit 0)", () => {
      expect(runGuard('git commit -m "add -node support"')).toBe(0);
    });

    it("does NOT block a quoted commit message containing `-network` (exit 0)", () => {
      expect(runGuard('git commit -m "add -network flag"')).toBe(0);
    });

    // Regression guard: a quoted skip-flag must STILL be blocked. The literal
    // `--no-verify` check runs over the quote-PRESERVING copy — an earlier fix
    // stripped all quoted spans and let `git commit "--no-verify"` slip through.
    it('blocks a quoted `git commit "--no-verify"` (exit 2)', () => {
      expect(runGuard('git commit "--no-verify"')).toBe(2);
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

    // #307: the force-push rule is scoped to the actual `git push` segment, so a
    // ` + ` in a commit message plus a base-branch name in a sibling `gh pr
    // create --base main` no longer forge a false "force-push to base".
    it("does NOT block a compound commit+push+PR whose message contains ` + ` (exit 0, #307)", () => {
      const rendered = renderGuard("main");
      expect(
        runGuardScript(
          rendered,
          'git commit -m "wip (full: format:check + test + lint)" && ' +
            "git push -u origin feat/mi-rama && gh pr create --base main --body x",
        ),
      ).toBe(0);
    });

    it("does NOT block `git push -u origin feat/x` with a ` + ` earlier in the line (exit 0, #307)", () => {
      const rendered = renderGuard("main");
      expect(runGuardScript(rendered, 'echo "a + b" && git push -u origin feat/x')).toBe(0);
    });

    // Real force-pushes to the base branch must STILL be blocked.
    it("blocks `git push --force main` (exit 2, #307)", () => {
      const rendered = renderGuard("main");
      expect(runGuardScript(rendered, "git push --force main")).toBe(2);
    });

    it("blocks a force-push refspec `git push origin +main` (exit 2, #307)", () => {
      const rendered = renderGuard("main");
      expect(runGuardScript(rendered, "git push origin +main")).toBe(2);
    });

    // The `+` refspec is only a force-push when glued to the ref (`+main`); a
    // stray `+main` in a message plus a real push to a feature branch must not
    // block, but a genuine `+main` refspec in the push still does.
    it("blocks a real `+main` refspec even next to a benign ` + ` message (exit 2, #307)", () => {
      const rendered = renderGuard("main");
      expect(runGuardScript(rendered, 'git commit -m "a + b" && git push origin +main')).toBe(2);
    });
  });

  /**
   * Runtime truth table: one row per command, one expected verdict.
   *
   * The tests above grew case by case; this table is the flat inventory of what
   * the guard blocks and what it lets through, which is the artifact a reviewer
   * actually needs to reason about a security hook. Every row that carries an
   * issue tag is a repro from the shell audit (`audit_hooks_shell.md`) — the
   * four regressions it caught are the reason the rules are now scoped to a
   * single command SEGMENT instead of the whole command string.
   */
  const VERDICTS: ReadonlyArray<{ cmd: string; blocked: boolean; why: string }> = [
    // A2 — a short flag carrying an `n` in a LATER segment used to be read as
    // the commit's `-n`, blocking two of the most common compound commands
    // there are. That false positive fires daily and teaches the operator to
    // route around the guard, which is worse than the bug.
    { cmd: 'git commit -m "fix: x" && git log --oneline -n 3', blocked: false, why: "A2" },
    { cmd: 'git commit -m "fix: x" && grep -rn TODO src/', blocked: false, why: "A2" },
    { cmd: 'git commit -m "x" && git log -n 1 | head -5', blocked: false, why: "A2" },
    { cmd: 'git commit -m "a && b -n c"', blocked: false, why: "A2, flag inside a message" },
    // A1 — the rm targets were anchored to the end of the WHOLE command, so any
    // compound command walked past both the guard and the static deny globs
    // (which only match a command that starts with `rm`).
    { cmd: "cd /tmp && rm -rf ~/", blocked: true, why: "A1" },
    { cmd: "cd /tmp && rm -rf /Users/ulisescm/Documents", blocked: true, why: "A1" },
    { cmd: "cd x && rm -rf ~ && echo ok", blocked: true, why: "A1, `~` no longer at end" },
    { cmd: "rm -rf ~/Documents", blocked: true, why: "A1, immediate child of HOME" },
    { cmd: "rm -rf /usr", blocked: true, why: "A1, system root" },
    { cmd: "rm -rf /etc/ssh", blocked: true, why: "A1, immediate child of a system root" },
    { cmd: "rm -rf /*", blocked: true, why: "A1, root with a glob" },
    // Everyday cleanup must keep working — the guard targets HOME and the
    // system roots, not any absolute path (see the rule-3 comment in the hook).
    { cmd: "rm -rf ./node_modules", blocked: false, why: "relative path" },
    { cmd: "rm -rf dist", blocked: false, why: "relative path" },
    { cmd: "cd /tmp && rm -rf build coverage", blocked: false, why: "relative paths" },
    { cmd: "rm -rf /Users/ulisescm/dev/app/node_modules", blocked: false, why: "deep path" },
    { cmd: "rm -rf /tmp/navori-test-123", blocked: false, why: "scratch dir" },
    { cmd: "rm -rf /tmp", blocked: true, why: "A1, the scratch root itself" },
    { cmd: "rm -rf /private/tmp", blocked: true, why: "A1, the same root on macOS" },
    // Pre-existing coverage that the segment scoping must not weaken.
    { cmd: "rm -rf /", blocked: true, why: "filesystem root" },
    { cmd: "rm -rf ~", blocked: true, why: "HOME" },
    { cmd: "rm -rf $PATH", blocked: true, why: "variable indirection" },
    { cmd: 'rm -rf "$BUILD_DIR"', blocked: true, why: "quoted variable" },
    { cmd: "PATH=/; rm -rf $PATH", blocked: true, why: "variable indirection, compound" },
    { cmd: 'git commit "--no-verify"', blocked: true, why: "quoted skip-flag" },
    { cmd: "git commit -qn -m x", blocked: true, why: "combined short flag" },
    { cmd: "sudo git commit --no-verify", blocked: true, why: "wrapper before git" },
    { cmd: 'git commit -m "add -notify option"', blocked: false, why: "hyphen-word in message" },
    { cmd: "git push --force-with-lease origin feature", blocked: false, why: "safe rebase flow" },
    { cmd: "ls -la", blocked: false, why: "benign" },
  ];

  describe("verdict table (segment scoping, #A1/#A2 regressions)", () => {
    it.each(VERDICTS)("$why: `$cmd` → $blocked", ({ cmd, blocked }) => {
      expect(runGuard(cmd)).toBe(blocked ? 2 : 0);
    });

    // Base-branch rules need `{{shq:branchBase}}` substituted, so they run
    // against a rendered copy instead of the raw asset.
    const BASE_VERDICTS: ReadonlyArray<{ cmd: string; blocked: boolean; why: string }> = [
      { cmd: "git push --force main", blocked: true, why: "force-push to base" },
      { cmd: "git push origin +main", blocked: true, why: "force refspec to base" },
      { cmd: "true;git push --force main", blocked: true, why: "tight `;` boundary" },
      { cmd: "FOO=1 git push --force main", blocked: true, why: "VAR=val prefix" },
      { cmd: "git push --force feature", blocked: false, why: "not the base branch" },
      { cmd: 'echo "a + b" && git push -u origin feat/x', blocked: false, why: "#307" },
    ];

    it.each(BASE_VERDICTS)("$why: `$cmd` → $blocked", ({ cmd, blocked }) => {
      expect(runGuardScript(renderGuard("main"), cmd)).toBe(blocked ? 2 : 0);
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
