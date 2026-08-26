import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { getCoreRoot } from "../bundled-assets.ts";
import { shellSingleQuote } from "../shell-escape.ts";
import { expandHookIncludes } from "../hook-includes.ts";
import { acrossShells } from "./helpers/shells.ts";

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

/** Runs under every available shell (bash AND zsh, #391); the verdicts must agree. */
function runGuardScript(scriptPath: string, command: string, env?: NodeJS.ProcessEnv): number {
  const payload = JSON.stringify({ tool_input: { command } });
  return acrossShells((shell) => {
    try {
      execFileSync(resolveBin(shell), [scriptPath], {
        input: payload,
        env: env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return 0;
    } catch (err) {
      return (err as { status?: number }).status ?? -1;
    }
  });
}

/**
 * Exit code PLUS stderr, for the cases that must distinguish "a rule fired"
 * from "the script died". Under `set -euo pipefail` a broken guard exits
 * non-zero too, so an exit code alone can read as a block that never happened.
 * Only bash: this is about the reason text, and `runGuardScript` already pins
 * the bash/zsh agreement on the verdict.
 */
function runGuardVerbose(
  command: string,
  scriptPath = guardPath,
): { status: number; stderr: string; ms: number } {
  const t0 = Date.now();
  const r = spawnSync(resolveBin("bash"), [scriptPath], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: "utf-8",
  });
  return { status: r.status ?? -1, stderr: r.stderr ?? "", ms: Date.now() - t0 };
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

  /**
   * #462 — the guard is scoped to what the shell EXECUTES, never to the text a
   * command merely WRITES.
   *
   * Documenting a security fix means quoting the attack it defends against, so
   * the text-only match blocked the very PR bodies that describe it (#403 could
   * not write its own). What the decision explicitly does NOT excuse is writing
   * a script and running it: that is still an execution.
   *
   * The table below is the record of the attempts that have been MADE, not a
   * proof that none is left — the first review of #462 found four the original
   * pass had missed, and calling the list complete is what let them ship. The
   * frontier the guard actually defends is stated in the hook itself (the "NOT
   * inert" block): a KNOWN interpreter in command position behind simple
   * wrappers and prefixes. Any other runner (`npx tsx`, `lua`, `make -f`,
   * `find … -exec`) escapes by design, same class as the `sh -c` / `eval`
   * limitation. A new attempt that lands belongs here as a row.
   */
  describe("inert content — written text vs executed text (#462)", () => {
    // 1. Writing a file whose CONTENT quotes a destructive command: passes.
    const WRITES: ReadonlyArray<{ cmd: string; why: string }> = [
      {
        cmd: "cat > /tmp/body.md <<'EOF'\nel fix bloquea rm -rf / y rm -rf ~/\nEOF",
        why: "quoted heredoc",
      },
      {
        cmd: "cat > /tmp/body.md <<EOF\nel fix bloquea rm -rf /usr\nEOF",
        why: "unquoted heredoc, no substitution",
      },
      { cmd: "cat > /tmp/x.md <<-'EOF'\n\trm -rf ~/\n\tEOF", why: "indented `<<-` heredoc" },
      {
        cmd: "cat > \"/tmp/mi archivo.md\" <<'EOF'\nrm -rf ~/\nEOF",
        why: "quoted destination path",
      },
      { cmd: "cat > /tmp/b.md <<'MSG'\nrm -rf ~/\nMSG", why: "custom delimiter" },
      {
        cmd: "cat > /tmp/b.md <<'EOF'\nrm -rf ~/\nEOF\n\ngh pr create --body-file /tmp/b.md",
        why: "the #403 flow end to end",
      },
      {
        cmd: "gh pr create --body-file /tmp/body.md",
        why: "--body-file: content is not in the command",
      },
      { cmd: "git commit -F /tmp/msg.txt", why: "git commit -F: same" },
      {
        cmd: 'git commit -m "fix: bloquea rm -rf ~/ en el guard"',
        why: "commit message quoting the attack",
      },
      {
        cmd: 'gh pr create --title x --body "el ataque era rm -rf ~/ y ahora no corre"',
        why: "PR body quoting the attack",
      },
      { cmd: 'git commit -m "docs: no uses --no-verify"', why: "message naming the skip-flag" },
      {
        cmd: "cat > /tmp/x.md <<'EOF'\ngit commit --no-verify\ngit push --force main\nEOF",
        why: "body quoting rules 1 and 2",
      },
      {
        cmd: "cat > /tmp/b.md <<'EOF'\n:(){ :|:& };:\ndd if=/dev/zero of=/dev/disk0\nEOF",
        why: "body quoting rules 4 and 5",
      },
      // The other half of the four remedies below: each one had to close its
      // bypass WITHOUT re-blocking the prose #462 exists to allow, so the prose
      // that sits closest to each remedy is pinned here too.
      {
        cmd: "gh pr create --body \"don't use rm -rf ~/ here, it's blocked\"",
        why: "3 · apostrophes with NO substitution stay inert",
      },
      {
        cmd: "cat > /tmp/b.md <<'EOF'\nit's the rm -rf ~/ case, don't ship it\nEOF",
        why: "3 · the same inside a heredoc body",
      },
      {
        cmd: "echo \"a << EOF\"\ncat > /tmp/b.md <<'EOF'\nrm -rf ~/\nEOF",
        why: "4 · a real opener after a line whose `<<` is quoted",
      },
      {
        cmd: 'git commit -m "fix(hooks): bloquea rm -rf ~/ (guard)"',
        why: "1 · parens in a message are not a subshell",
      },
      {
        cmd: 'git commit -m "docs: usa command git en vez de rm -rf ~/"',
        why: "1 · `command` in a message is not a wrapper",
      },
    ];

    it.each(WRITES)("writes, does not run — $why (exit 0)", ({ cmd }) => {
      expect(runGuardScript(renderGuard("main"), cmd)).toBe(0);
    });

    // 2 + 3. Running that same payload — directly, or in the second step of a
    //        write-then-execute — stays blocked. Every row here was an attempt
    //        to reach an execution THROUGH the #462 exception.
    const BYPASS_ATTEMPTS: ReadonlyArray<{ cmd: string; why: string }> = [
      { cmd: "rm -rf /", why: "2 · running the payload the body quotes" },
      {
        // A runner named by a VARIABLE used to escape the tell: the frontier the
        // hook DECLARES is what justifies leaving other runners out, so a hole in
        // it undermines the trade-off rather than just the case (#462 review, obs 8).
        cmd: "cat > /tmp/p.md <<'EOF'\nrm -rf ~/\nEOF\n$SHELL /tmp/p.md",
        why: "3 · runner named by a variable",
      },
      { cmd: "git commit --no-verify -m x", why: "2 · same, rule 1" },
      {
        cmd: "cat > /tmp/p.sh <<'EOF'\nrm -rf ~/\nEOF\nbash /tmp/p.sh",
        why: "3 · write a script, run it",
      },
      {
        cmd: "cat > /tmp/p <<'EOF'\nrm -rf ~/\nEOF\nbash /tmp/p",
        why: "3 · same, extensionless target",
      },
      {
        cmd: "cat > /tmp/p.md <<'EOF'\nrm -rf ~/\nEOF\nsource /tmp/p.md",
        why: "3 · `source` instead of bash",
      },
      { cmd: "cat > /tmp/p.md <<'EOF'\nrm -rf ~/\nEOF\n. /tmp/p.md", why: "3 · the `.` builtin" },
      {
        cmd: "cat > /tmp/p.md <<'EOF'\nrm -rf ~/\nEOF\nsudo bash /tmp/p.md",
        why: "3 · sudo wrapper",
      },
      {
        cmd: "cat > /tmp/p.txt <<'EOF'\nrm -rf ~/\nEOF\nchmod +x /tmp/p.txt && /tmp/p.txt",
        why: "3 · chmod +x, then the path itself",
      },
      {
        cmd: "cat > /tmp/p.md <<'EOF'\nrm -rf ~/\nEOF\nFOO=1 /tmp/p.md",
        why: "3 · VAR=val before the path",
      },
      {
        cmd: "cat > /tmp/p.md <<'EOF'\nrm -rf ~/\nEOF\nxargs -a /tmp/p.md sh",
        why: "3 · xargs as the runner",
      },
      {
        cmd: "tee /tmp/p.sh <<'EOF'\nrm -rf ~/\nEOF",
        why: "3 · a script written with tee (no `>`)",
      },
      { cmd: "cat <<'EOF' > /tmp/p.sh\nrm -rf ~/\nEOF", why: "3 · redirect after the opener" },
      { cmd: "bash <<'EOF'\nrm -rf ~/\nEOF", why: "3 · the heredoc IS the program" },
      {
        cmd: "cat > /tmp/b.md <<'EOF'\ntext\nEOF\ncat > /tmp/q.sh <<'EOF2'\nrm -rf ~/\nEOF2",
        why: "3 · a second heredoc writing a script",
      },
      {
        cmd: 'git commit -m "$(rm -rf / )"',
        why: "a substitution is an invocation, not a message",
      },
      { cmd: 'gh pr create --body "$(rm -rf ~/ )"', why: "the same in a PR body" },
      { cmd: 'echo "a << EOF"\nrm -rf ~/', why: "a `<<` inside a string opens no heredoc" },
      { cmd: "echo 'a << EOF'\nrm -rf ~/\nEOF", why: "the same, single-quoted" },
      {
        cmd: "cat > /tmp/b.md <<'EOF'\nbody\nEOF\nrm -rf ~/",
        why: "a real command AFTER the body ends",
      },
      {
        cmd: "cat > /tmp/b.md <<'EOF'\nbody\nEOF\ndd if=/dev/zero of=/dev/disk0",
        why: "the same, rule 5",
      },
      { cmd: 'git commit -m "x" ; rm -rf ~', why: "a real command after an elided message" },
      { cmd: 'git commit -m "x" --no-verify', why: "the skip-flag OUTSIDE the elided value" },
      { cmd: 'git commit -m "x ; rm -rf ~', why: "an unbalanced quote elides nothing" },
      {
        cmd: "gh pr create --body-file /tmp/b.md && rm -rf /",
        why: "--body-file next to a real rm",
      },
      // Rules 4 and 5 read `live` too now, and neither had a single blocking
      // assertion in this suite before #462 — pin them, or a later change to
      // `live` could switch them off with nothing turning red.
      { cmd: ":(){ :|:& };:", why: "rule 4 · the bare fork bomb" },
      {
        cmd: "cat > /tmp/b.md <<'EOF'\nbody\nEOF\n:(){ :|:& };:",
        why: "rule 4 · after an elided body",
      },
      { cmd: "dd if=/dev/zero of=/dev/disk0", why: "rule 5 · raw block device" },
      {
        cmd: "cat > /tmp/b.md <<'EOF'\nbody\nEOF\ncat /dev/zero > /dev/sda",
        why: "rule 5 · after an elided body",
      },
      // The four bypasses the #462 review measured as BLOCK-on-`main` →
      // pass-with-the-diff. Each one is a hole the ORIGINAL #462 pass opened, so
      // each stays here as a permanent case: reverting any of the four remedies
      // turns these red.
      //
      // 1 · the execution tell reads a copy normalized like FIX C, so a wrapper
      //     between the boundary and the interpreter no longer hides it.
      {
        cmd: "cat > /tmp/p.md <<'EOF'\nrm -rf ~/\nEOF\n(bash /tmp/p.md)",
        why: "1 · interpreter inside a subshell",
      },
      {
        cmd: "cat > /tmp/p.md <<'EOF'\nrm -rf ~/\nEOF\n{ bash /tmp/p.md; }",
        why: "1 · interpreter inside a brace group",
      },
      {
        cmd: "cat > /tmp/p.md <<'EOF'\nrm -rf ~/\nEOF\n\\bash /tmp/p.md",
        why: "1 · backslash-escaped interpreter",
      },
      {
        cmd: "cat > /tmp/p.md <<'EOF'\nrm -rf ~/\nEOF\n\"bash\" /tmp/p.md",
        why: "1 · quoted interpreter",
      },
      // 2 · the prefix group takes the prefix's OWN arguments, so the runner is
      //     still found behind `sudo -u me`, `env FOO=1`, `timeout 5`.
      {
        cmd: "cat > /tmp/p.md <<'EOF'\nrm -rf ~/\nEOF\nsudo -u me bash /tmp/p.md",
        why: "2 · sudo with a flag and its value",
      },
      {
        cmd: "cat > /tmp/p.md <<'EOF'\nrm -rf ~/\nEOF\nenv FOO=1 bash /tmp/p.md",
        why: "2 · env with a VAR=val argument",
      },
      {
        cmd: "cat > /tmp/p.md <<'EOF'\nrm -rf ~/\nEOF\ntimeout 5 bash /tmp/p.md",
        why: "2 · timeout with a numeric argument",
      },
      {
        cmd: "cat > /tmp/p.md <<'EOF'\nrm -rf ~/\nEOF\npython3.11 /tmp/p.md",
        why: "2 · a versioned interpreter name",
      },
      {
        cmd: "cat > /tmp/p.md <<'EOF'\nrm -rf ~/\nEOF\nfish /tmp/p.md",
        why: "2 · a shell missing from the list",
      },
      // 3 · the substitution check also reads the double-quoted spans, where an
      //     apostrophe is LITERAL and used to swallow the `$(` with it.
      {
        cmd: "git commit -m \"it's fine $(rm -rf / ) it's\"",
        why: "3 · apostrophes around a live substitution",
      },
      {
        cmd: "gh pr create --body \"don't $(rm -rf ~ ) don't\"",
        why: "3 · the same in a PR body",
      },
      // 4 · a line whose quotes do not pair up is a NON-opener: inventing a
      //     heredoc there elided the real commands that followed.
      { cmd: 'echo "a \\" << EOF"\nrm -rf ~/', why: "4 · escaped quote fakes an opener" },
      { cmd: 'echo "a" b" << EOF\nrm -rf ~/', why: "4 · odd quote count fakes an opener" },
      // 5 · the script-extension match is case-insensitive: on macOS's
      //     case-insensitive filesystem `p.SH` is the same file as `p.sh`.
      { cmd: "cat > /tmp/P.SH <<'EOF'\nrm -rf ~/\nEOF", why: "5 · uppercase script extension" },
      { cmd: "cat > /tmp/p.tsx <<'EOF'\nrm -rf ~/\nEOF", why: "5 · `.tsx`, sibling of `.ts`" },
    ];

    it.each(BYPASS_ATTEMPTS)("still blocked — $why (exit 2)", ({ cmd }) => {
      expect(runGuardScript(renderGuard("main"), cmd)).toBe(2);
    });

    const BYPASS_ATTEMPTS_BASE: ReadonlyArray<{ cmd: string; why: string }> = [
      {
        cmd: "cat > /tmp/b.md <<'EOF'\nbody\nEOF\ngit push --force main",
        why: "a real force-push after the body",
      },
      {
        cmd: 'git commit -m "x" && git push --force main',
        why: "the same after an elided message",
      },
    ];

    it.each(BYPASS_ATTEMPTS_BASE)("still blocked — $why (exit 2)", ({ cmd }) => {
      expect(runGuardScript(renderGuard("main"), cmd)).toBe(2);
    });

    // The shell's own reading is the reference: a terminator line that is not
    // EXACTLY the delimiter keeps the heredoc open, so `EOF && rm -rf ~` is
    // body text and nothing runs. Blocking it would be a false positive.
    it("treats a non-exact terminator line as body, like the shell does (exit 0)", () => {
      expect(runGuard("cat > /tmp/b.md <<'EOF'\ntext\nEOF && rm -rf ~")).toBe(0);
    });
  });

  /**
   * #509 — the FLAGS axis, which the table above never varied.
   *
   * Every one of its ~30 `rm` rows spells the flags `-rf`. That table is
   * exhaustive on the TARGET axis (`/`, `~`, `/tmp`, `$VAR`, relative, deep,
   * quoted) and blind on the flag one, because it was written from the shape of
   * the regex instead of from the rule the regex is supposed to express:
   * "a recursive rm over a sensitive path". The regex matched flags with a
   * LOWERCASE class (`[rf]`), so three everyday spellings of the same command
   * walked straight through a guard whose whole job is to stop them:
   * `rm -R ~/`, `rm --recursive --force ~/`, and `rm -rf --no-preserve-root /`
   * — the last one being both the command that erases the system root and the
   * only one that also evades the static `deny` globs.
   *
   * So this matrix CROSSES the two axes: every spelling of "recursive/force"
   * against both a sensitive target (must block) and an everyday one (must
   * still pass). A future rule that widens one axis by breaking the other turns
   * this red.
   */
  describe("rm flag equivalences × targets (#509)", () => {
    const RM_FLAGS: ReadonlyArray<{ flags: string; why: string }> = [
      { flags: "-rf", why: "canonical" },
      { flags: "-fr", why: "combined, reversed" },
      { flags: "-r", why: "recursive alone" },
      { flags: "-f", why: "force alone" },
      { flags: "-R", why: "`-R` is `-r` in POSIX, GNU and BSD" },
      { flags: "-fR", why: "uppercase inside a combined token" },
      { flags: "-Rf", why: "the same, other order" },
      { flags: "--recursive", why: "long form" },
      { flags: "--force", why: "long form" },
      { flags: "--recursive --force", why: "two long forms" },
      { flags: "--force --recursive", why: "…in the other order" },
      { flags: "-r --force", why: "short + long" },
      { flags: "--recursive -f", why: "long + short" },
      { flags: "-rf --", why: "end-of-options separator before the target" },
      { flags: "-rf --one-file-system", why: "an unrelated long option between" },
    ];
    /** Targets the guard exists to protect (rule 3's COVERED list). */
    const SENSITIVE = ["~/", "/", "/usr", '"$BUILD_DIR"'];
    /** Everyday cleanup, which must keep working whatever the flag spelling. */
    const EVERYDAY = ["node_modules", "./build"];

    // ANTI-FALSE-GREEN: pin the matrix's own shape. Without it, dropping the
    // uppercase or long-form rows would silently restore the exact blind spot
    // this block exists for, and the suite would still be green.
    it("crosses both axes — flag spellings and targets", () => {
      expect(RM_FLAGS.length).toBeGreaterThanOrEqual(12);
      expect(RM_FLAGS.some((f) => /-[a-z]*R/.test(f.flags))).toBe(true);
      expect(RM_FLAGS.some((f) => f.flags.includes("--recursive"))).toBe(true);
      expect(RM_FLAGS.some((f) => f.flags.includes("--force"))).toBe(true);
      expect(SENSITIVE.length).toBeGreaterThan(1);
      expect(EVERYDAY.length).toBeGreaterThan(1);
    });

    const BLOCKED = RM_FLAGS.flatMap(({ flags, why }) =>
      SENSITIVE.map((target) => ({ cmd: `rm ${flags} ${target}`, why })),
    );
    it.each(BLOCKED)("blocks `$cmd` ($why)", ({ cmd }) => {
      expect(runGuard(cmd)).toBe(2);
    });

    const ALLOWED = RM_FLAGS.flatMap(({ flags, why }) =>
      EVERYDAY.map((target) => ({ cmd: `rm ${flags} ${target}`, why })),
    );
    it.each(ALLOWED)("still allows `$cmd` ($why)", ({ cmd }) => {
      expect(runGuard(cmd)).toBe(0);
    });

    /**
     * `--no-preserve-root` disarms the last safety net `rm` itself has, and
     * nothing inside an agent has a legitimate use for it — so it blocks on its
     * own, whatever the target and wherever it sits among the flags. It was the
     * worst row of the bypass: its mere presence broke the flag match, so the
     * ONE command that erases the system root was the one the guard let past.
     */
    const NO_PRESERVE_ROOT = [
      "rm -rf --no-preserve-root /",
      "rm --no-preserve-root -rf /",
      "rm --no-preserve-root -r /",
      "rm -R --no-preserve-root /",
      "rm --no-preserve-root --recursive --force /",
      "cd /tmp && rm -rf --no-preserve-root /",
      // Not even over a harmless-looking target: the flag is the tell.
      "rm --no-preserve-root -rf ./build",
    ];
    it.each(NO_PRESERVE_ROOT)("blocks `%s`", (cmd) => {
      expect(runGuard(cmd)).toBe(2);
    });

    // ANTI-FALSE-GREEN: a guard that DIED (bad syntax, a missing tool under
    // `set -euo pipefail`) also exits non-zero, so "exit 2" alone does not
    // prove a rule fired. Read the reason, and read the silence on the way out.
    it("blocks because a RULE fired, not because the guard fell over", () => {
      const blocked = runGuardVerbose("rm -R ~/");
      expect(blocked.status).toBe(2);
      expect(blocked.stderr).toContain("BLOCKED by guard-destructive");
      expect(blocked.stderr).toContain("recursive rm");

      const aggravated = runGuardVerbose("rm -rf --no-preserve-root /");
      expect(aggravated.status).toBe(2);
      expect(aggravated.stderr).toContain("--no-preserve-root");

      const allowed = runGuardVerbose("rm -R ./build");
      expect(allowed.status).toBe(0);
      expect(allowed.stderr).toBe("");
    });
  });

  /**
   * #509, second half — the SAME defect one axis over.
   *
   * The rule matched `rm`, then the flags, then ONE target, and stopped there.
   * A harmless path in first position therefore detached the rule from
   * everything that followed it, and these two erased the filesystem root and
   * HOME with exit 0:
   *
   *     rm -rf build /            exit=0
   *     rm -rf node_modules ~/    exit=0
   *
   * `rm` takes a LIST of operands and deletes every one of them, so whether an
   * operand is sensitive is a property of its SHAPE (root / home / variable),
   * never of its POSITION. This matrix varies the position the same way the
   * block above varies the flag spelling — and crosses the two, because the
   * fix has to hold for `-R`/`--recursive` as well as for `-rf`.
   *
   * The negative rows carry the other half of the bargain: `rm -rf build
   * coverage` has no sensitive operand and must keep passing, or the fix trades
   * a bypass for a false positive that fires daily.
   */
  describe("rm operand LISTS — every operand counts, not just the first (#509)", () => {
    /** The axis here is position, so the flag axis stays at one row per family. */
    const LIST_FLAGS = ["-rf", "-R", "--recursive"];
    /** Harmless operands that sit BEFORE the sensitive one. */
    const LIST_PREFIXES = [
      { ops: "build", why: "sensitive operand is 2nd" },
      { ops: "node_modules dist", why: "…3rd" },
      { ops: "a b c", why: "…4th" },
    ];
    const LIST_TARGETS = ["/", "~/", "$HOME", "/usr"];

    const LIST_BLOCKED = LIST_FLAGS.flatMap((flags) =>
      LIST_PREFIXES.flatMap(({ ops, why }) =>
        LIST_TARGETS.map((target) => ({ cmd: `rm ${flags} ${ops} ${target}`, why })),
      ),
    );
    it.each(LIST_BLOCKED)("blocks `$cmd` ($why)", ({ cmd }) => {
      expect(runGuard(cmd)).toBe(2);
    });

    // GNU `rm` permutes its argv, so an operand can sit BEFORE the flags and
    // the delete is still recursive. `rm build -rf /` erases the root on Linux.
    const PERMUTED = [
      "rm build -rf /",
      "rm dist -R ~/",
      "rm a b --recursive $HOME",
      "rm x -rf /usr",
    ];
    it.each(PERMUTED)("blocks `%s` (operand before the flag, GNU permutation)", (cmd) => {
      expect(runGuard(cmd)).toBe(2);
    });

    /**
     * The false-positive budget. Every row has TWO OR MORE operands and NONE of
     * them is sensitive, which is the exact shape the fix widened — if scanning
     * the whole operand list had been done by dropping the target check, these
     * would all turn red.
     */
    const LIST_ALLOWED: ReadonlyArray<{ cmd: string; why: string }> = [
      { cmd: "rm -rf build coverage", why: "two relative paths — the verdict table's row" },
      { cmd: "rm -rf dist .cache", why: "…including a dotted one" },
      { cmd: "rm -rf a b c", why: "three relative paths" },
      { cmd: "rm -R node_modules ./build", why: "the same under the `-R` spelling" },
      { cmd: "rm --recursive --force dist coverage", why: "…and under the long spelling" },
      {
        cmd: "rm -rf /Users/me/dev/app/node_modules /tmp/x/y",
        why: "two DEEP absolute paths, both out of scope by design",
      },
      // A redirection destination is not an operand: `rm` deletes nothing there,
      // so the token after `>` must not be read as a target.
      { cmd: "rm -rf dist > /dev/null", why: "redirection target, spaced" },
      { cmd: "rm -rf dist 2> /dev/null", why: "…on fd 2" },
      { cmd: "rm -rf dist 2>/dev/null", why: "…glued to the operator" },
    ];
    it.each(LIST_ALLOWED)("still allows `$cmd` ($why)", ({ cmd }) => {
      expect(runGuard(cmd)).toBe(0);
    });

    // ANTI-FALSE-GREEN on the table's own shape: the old rule stopped at the
    // FIRST token after the flags, so a row with a single token there would
    // have passed before the fix and proves nothing about it.
    it("only asserts rows with something PAST the first operand", () => {
      /** Tokens after `rm` and its leading flags — what the old rule ignored. */
      const tail = (cmd: string) =>
        cmd
          .replace(/^rm\s+/, "")
          .split(/\s+/)
          .filter((token, i, all) => all.slice(0, i + 1).some((t) => !t.startsWith("-")));
      for (const { cmd } of [...LIST_ALLOWED, ...LIST_BLOCKED]) {
        expect({ cmd, pastFirstOperand: tail(cmd).length > 1 }).toEqual({
          cmd,
          pastFirstOperand: true,
        });
      }
      expect(LIST_FLAGS.some((f) => f.includes("R"))).toBe(true);
      expect(LIST_FLAGS.some((f) => f.startsWith("--"))).toBe(true);
    });

    // ANTI-FALSE-GREEN on the verdict: under `set -euo pipefail` a guard that
    // DIED also exits non-zero, so exit 2 alone does not prove a rule fired.
    it("blocks because a RULE fired, not because the guard fell over", () => {
      const blocked = runGuardVerbose("rm -rf build /");
      expect(blocked.status).toBe(2);
      expect(blocked.stderr).toContain("BLOCKED by guard-destructive");
      expect(blocked.stderr).toContain("recursive rm");

      const allowed = runGuardVerbose("rm -rf build coverage");
      expect(allowed.status).toBe(0);
      expect(allowed.stderr).toBe("");
    });
  });

  /**
   * The QUOTING axis — the third one, and the one both matrices above were
   * blind to.
   *
   * The flag matrix varies flags, the operand matrix varies position, and every
   * row of both spells its target BARE. The shell strips a quote around an
   * operand before `rm` ever sees it, so `rm -rf "/"` erases exactly what
   * `rm -rf /` erases — and it returned 0, together with `'/'`, `"/usr"`,
   * `"~"`, `"/tmp"`, `rm -r "/"` and `rm -rf build "/etc"`.
   *
   * What made it worse than a plain hole was its SHAPE: `rm -rf "~/"` DID
   * block, by accident — the home pattern's path-component class swallowed the
   * closing quote as if it were a path character, which the root pattern cannot
   * do. A spot-check on the obvious spelling therefore reported the axis as
   * covered, and the hook's own `NOT COVERED` block never listed it.
   *
   * So this matrix crosses quoting × target × flag spelling, with the everyday
   * targets carried through the same crossing: closing a bypass by widening the
   * match is only half the trade if the other half fires daily.
   */
  describe("rm target QUOTING — a quoted target is the same target", () => {
    const QUOTES: ReadonlyArray<{ open: string; close: string; why: string }> = [
      { open: "", close: "", why: "bare" },
      { open: '"', close: '"', why: "double-quoted" },
      { open: "'", close: "'", why: "single-quoted" },
    ];
    /** One per COVERED row of the hook's rule-3 table. */
    const SENSITIVE = ["/", "/*", "/usr", "/etc", "~", "~/", "~/Documents", "/tmp", "$HOME"];
    /** Every spelling of "recursive" the #509 matrix pinned, now quoted too. */
    const QUOTE_FLAGS = ["-rf", "-R", "-r", "--recursive --force", "-rf --"];
    /** Everyday cleanup: quoting must not turn any of these into a block. */
    const EVERYDAY = [
      "node_modules",
      "./build",
      "/Users/me/dev/app/node_modules",
      "/tmp/navori-test-123",
    ];

    // ANTI-FALSE-GREEN on the matrix's own shape: drop the quoted rows and the
    // blind spot comes back with the suite still green.
    it("crosses all three quotings against both target families", () => {
      expect(QUOTES.map((q) => q.open).sort()).toEqual(["", '"', "'"]);
      expect(SENSITIVE.length).toBeGreaterThanOrEqual(8);
      expect(QUOTE_FLAGS.length).toBeGreaterThanOrEqual(4);
      expect(EVERYDAY.length).toBeGreaterThanOrEqual(3);
    });

    const QUOTED_BLOCKED = QUOTES.flatMap(({ open, close, why }) =>
      SENSITIVE.map((t) => ({ cmd: `rm -rf ${open}${t}${close}`, why })),
    );
    it.each(QUOTED_BLOCKED)("blocks `$cmd` ($why)", ({ cmd }) => {
      expect(runGuard(cmd)).toBe(2);
    });

    const QUOTED_FLAGS = QUOTES.flatMap(({ open, close, why }) =>
      QUOTE_FLAGS.flatMap((flags) =>
        ["/", "~/", "/usr"].map((t) => ({ cmd: `rm ${flags} ${open}${t}${close}`, why })),
      ),
    );
    it.each(QUOTED_FLAGS)("blocks `$cmd` (flags × quoting, $why)", ({ cmd }) => {
      expect(runGuard(cmd)).toBe(2);
    });

    // Quoting × POSITION: the operand matrix's axis, re-crossed. A quoted
    // sensitive path in second or third position is still a delete.
    const QUOTED_LISTS = [
      'rm -rf build "/etc"',
      "rm -rf build '/etc'",
      'rm -rf node_modules dist "~/"',
      "rm -R a b '/usr'",
      'rm --recursive --force x "$HOME"',
      'rm build -rf "/"',
    ];
    it.each(QUOTED_LISTS)("blocks `%s` (quoted target inside an operand list)", (cmd) => {
      expect(runGuard(cmd)).toBe(2);
    });

    // The other half of the bargain, crossed the same way.
    const QUOTED_ALLOWED = QUOTES.flatMap(({ open, close, why }) =>
      EVERYDAY.map((t) => ({ cmd: `rm -rf ${open}${t}${close}`, why })),
    );
    it.each(QUOTED_ALLOWED)("still allows `$cmd` ($why)", ({ cmd }) => {
      expect(runGuard(cmd)).toBe(0);
    });

    // `--no-preserve-root` carries the same axis: the flag IS the verdict, so
    // its quoted spelling has to reach the rule too.
    it.each([
      'rm "--no-preserve-root" -rf ./build',
      "rm '--no-preserve-root' -rf ./build",
      'rm -rf "--no-preserve-root" /',
    ])("blocks `%s` (quoted aggravating flag)", (cmd) => {
      expect(runGuard(cmd)).toBe(2);
    });

    /**
     * The declared frontier, pinned so it stays declared. Quotes AROUND the
     * target are covered; quotes SPLICED INTO it are not, and neither are
     * backslash escapes — the shell removes both before `rm` runs, but the
     * guard matches text and needs the path spelled contiguously. These rows
     * exist so the hook's `NOT COVERED` block and the runtime agree: if a later
     * change closes one of them, this test says so instead of leaving the
     * comment stale.
     */
    it.each(['rm -rf /"u"sr', 'rm -rf "/us"r', "rm -rf \\~", "rm -rf \\/"])(
      "declared NOT COVERED, and still is — `%s` (exit 0)",
      (cmd) => {
        expect(runGuard(cmd)).toBe(0);
      },
    );

    // ANTI-FALSE-GREEN on the verdict: under `set -euo pipefail` a guard that
    // DIED also exits non-zero, so exit 2 alone does not prove a rule fired.
    it("blocks because a RULE fired, not because the guard fell over", () => {
      const doubled = runGuardVerbose('rm -rf "/"');
      expect(doubled.status).toBe(2);
      expect(doubled.stderr).toContain("BLOCKED by guard-destructive");
      expect(doubled.stderr).toContain("recursive rm");

      const singled = runGuardVerbose("rm -rf '/usr'");
      expect(singled.status).toBe(2);
      expect(singled.stderr).toContain("recursive rm");

      const flag = runGuardVerbose('rm "--no-preserve-root" -rf ./build');
      expect(flag.status).toBe(2);
      expect(flag.stderr).toContain("--no-preserve-root");

      const allowed = runGuardVerbose('rm -rf "node_modules"');
      expect(allowed.status).toBe(0);
      expect(allowed.stderr).toBe("");
    });
  });

  /**
   * The false-positive class the operand widening BUYS, pinned as rows rather
   * than left to be rediscovered.
   *
   * `rm_arg` accepts any token, so an UNQUOTED mention of `rm` reaches forward
   * to any sensitive absolute path later in the SAME segment — even from inside
   * a shell comment. It is a deliberate trade (narrowing `rm_arg` reopens
   * `rm -rf build /`), and the hook now names it; these rows are the other half
   * of naming it, and the negative rows are the bound that makes it acceptable.
   */
  describe("bounded false positives of the operand run", () => {
    const FALSE_POSITIVES: ReadonlyArray<{ cmd: string; blocked: boolean; why: string }> = [
      { cmd: "echo rm -rf build /usr", blocked: true, why: "a mention plus a later path" },
      {
        cmd: 'python3 -c "print(1)" # rm -rf a /bin/zsh',
        blocked: true,
        why: "…from inside a comment",
      },
      { cmd: 'rm -rf "release /usr notes"', blocked: true, why: "…inside one quoted operand" },
      // The bounds. Each one is a reason the class stays acceptable.
      { cmd: "echo rm -rf build dist", blocked: false, why: "no sensitive path in the segment" },
      { cmd: "echo rm -rf build && ls /usr", blocked: false, why: "`&&` ends the reach" },
      { cmd: "echo rm -rf build ; ls /usr", blocked: false, why: "`;` ends the reach" },
      { cmd: "echo rm -rf build | grep /usr", blocked: false, why: "`|` ends the reach" },
      {
        cmd: 'git commit -m "el fix bloquea rm -rf /usr"',
        blocked: false,
        why: "a quoted message was already elided",
      },
      {
        cmd: "cat > /tmp/b.md <<'EOF'\nrm -rf /usr\nEOF",
        blocked: false,
        why: "a heredoc body was already elided",
      },
    ];

    it.each(FALSE_POSITIVES)("$why: `$cmd` → $blocked", ({ cmd, blocked }) => {
      expect(runGuardScript(renderGuard("main"), cmd)).toBe(blocked ? 2 : 0);
    });
  });

  /**
   * #511 — the guard runs under a wall-clock timeout it does not control (10s
   * in `settings.json`), and being KILLED is indistinguishable from approving:
   * the hook says nothing and the tool call proceeds. The audit drove a
   * 2000-segment command and measured 46.9s, i.e. the guard never evaluated a
   * single rule and the command went through.
   *
   * There is no way for the hook to observe its own timeout, so the defense is
   * (a) never getting near it and (b) DENYING what is too big to inspect. Both
   * halves are asserted: the verdict AND the budget.
   */
  describe("bounded work — the guard must never be killed mid-verdict (#511)", () => {
    /** Comfortably under the hook's 10s timeout, with room for a slow CI box. */
    const BUDGET_MS = 5000;
    const segments = (n: number) =>
      Array.from({ length: n }, (_, i) => `echo seg${i}`).join(" && ");
    /** The hook's own ceilings, so a row can sit exactly ON one of them. */
    const CMD_MAX = 131072;
    const LINE_MAX = 4096;
    /** `n` lines behind a heredoc opener — the shape that walks the per-line loop. */
    const heredocLines = (n: number) =>
      ["cat > /tmp/doc.md <<'EOF'", ...Array.from({ length: n }, () => "x")].join("\n");
    /**
     * `n` TOTAL lines, every one of them KEPT — the expensive arm of the same
     * loop, and the only one the accumulator's shape shows up in. A `<<` that
     * opens nothing (`echo "a << E"`) is what turns the loop on without turning
     * eliding on, so each following line is appended instead of discarded.
     * Padding each line to ~30 chars puts the shape on the byte ceiling too.
     */
    const keptLines = (n: number) =>
      ['echo "a << E"', ...Array.from({ length: n - 1 }, () => `echo ${"x".repeat(25)}`)].join(
        "\n",
      );

    it("evaluates a 2000-segment command inside the time budget", () => {
      const out = runGuardVerbose(segments(2000));
      expect(out.status).toBe(0);
      expect(out.ms).toBeLessThan(BUDGET_MS);
    });

    // The verdict half: the padding must not become a way to smuggle the
    // payload past the rules. This is the audit's repro with a real command at
    // the end — under the old quadratic passes it was never reached.
    it("still BLOCKS the destructive tail of a 2000-segment command, in budget", () => {
      const out = runGuardVerbose(`${segments(2000)} && rm -rf ~/`);
      expect(out.status).toBe(2);
      expect(out.stderr).toContain("BLOCKED by guard-destructive");
      expect(out.ms).toBeLessThan(BUDGET_MS);
    });

    // #509 scans the WHOLE operand list, so the pathological input is no longer
    // only "many segments" — it is also "one segment with a huge argv". The
    // operand run is a token-delimited repetition (`([^<>&\s]+\s+)*`), i.e.
    // unambiguous and linear; this is the row that would turn red if someone
    // rewrote it into a backtracking shape.
    it("evaluates a 2000-OPERAND `rm` inside the time budget, both verdicts (#509)", () => {
      const operands = Array.from({ length: 2000 }, (_, i) => `d${i}`).join(" ");
      const benign = runGuardVerbose(`rm -rf ${operands}`);
      expect(benign.status).toBe(0);
      expect(benign.ms).toBeLessThan(BUDGET_MS);

      const destructive = runGuardVerbose(`rm -rf ${operands} ~/`);
      expect(destructive.status).toBe(2);
      expect(destructive.stderr).toContain("recursive rm");
      expect(destructive.ms).toBeLessThan(BUDGET_MS);
    });

    // Past the ceiling the answer is `block`, never `exit 0`: a guard that
    // cannot evaluate a command has to deny it. Note the shape — the command
    // below is completely harmless, and it is still denied, because the verdict
    // is about the guard's ability to judge, not about the command.
    it("BLOCKS an oversized command instead of waving it through", () => {
      const oversized = `echo ${"x".repeat(CMD_MAX + 1000)}`;
      const out = runGuardVerbose(oversized);
      expect(out.status).toBe(2);
      expect(out.stderr).toContain("too large to inspect");
      expect(out.stderr).toContain("nothing in it was evaluated");
      expect(out.ms).toBeLessThan(BUDGET_MS);
      // The ceiling is a `block`, so bash and zsh must agree on it like they do
      // on every other verdict (#391) — `${#cmd}` and `${cmd:0:n}` are the two
      // expansions this path adds, and both are shell-portable.
      expect(runGuard(oversized)).toBe(2);
    });

    /**
     * The LINE ceiling, and the reason it exists as a SEPARATE number.
     *
     * `CMD_MAX` bounds bytes; the cost was per LINE, so the two disagreed and
     * the guard priced the wrong one. Measured on the pre-fix hook: 16k
     * one-char lines — comfortably inside the 32768-byte ceiling of the day —
     * cost 3.45s, 32k cost 13.2s and 64k cost 53.2s, i.e. the accumulator was
     * QUADRATIC and 96-99% of the whole runtime. The two halves of the remedy
     * are asserted separately below: the ceiling (this test) and the linearity
     * that makes the ceiling affordable (the next one).
     */
    it("BLOCKS a command with more lines than it can walk", () => {
      const out = runGuardVerbose(heredocLines(LINE_MAX));
      expect(out.status).toBe(2);
      expect(out.stderr).toContain("too many lines to inspect");
      expect(out.stderr).toContain("nothing in it was evaluated");
      expect(out.ms).toBeLessThan(BUDGET_MS);
      // The `block` fires from INSIDE the `while … done <<< "$cmd"` loop, which
      // must not run in a subshell in either shell — there `exit 2` would be
      // swallowed and the command would sail through (#391).
      expect(runGuard(heredocLines(LINE_MAX))).toBe(2);
    });

    // The affordability half: sitting exactly ON the line ceiling, with every
    // line kept AND the command on the byte ceiling, has to stay cheap — or the
    // ceiling is set where the guard already lost.
    it("evaluates a command at BOTH ceilings at once, inside the budget", () => {
      const cmd = keptLines(LINE_MAX);
      expect(cmd.split("\n").length).toBe(LINE_MAX);
      expect(cmd.length).toBeGreaterThan(CMD_MAX / 2);
      expect(cmd.length).toBeLessThanOrEqual(CMD_MAX);
      const out = runGuardVerbose(cmd);
      expect(out.status).toBe(0);
      expect(out.ms).toBeLessThan(BUDGET_MS);
    });

    /**
     * The SHAPE of the curve, which is the half a wall-clock budget cannot see.
     *
     * A ceiling makes a quadratic pass affordable at THIS ceiling on THIS
     * machine — the accumulator costs 3.5s at LINE_MAX, under the 5s budget
     * above — so a budget assertion alone lets the quadratic shape come back
     * and only turns red on the slower box nobody runs the suite on. A RATIO
     * has no such blind spot: machine speed cancels out.
     *
     * 8x the input. Linear predicts ~8x the time and measures 3.7x (fixed
     * per-process start-up dilutes the small end); the quadratic accumulator
     * predicts ~64x and measures 26.6x. The threshold sits between, with 2.2x
     * of margin below it and 3.3x above.
     */
    it("scales LINEARLY with the number of lines, not quadratically", () => {
      const small = runGuardVerbose(keptLines(LINE_MAX / 8));
      const large = runGuardVerbose(keptLines(LINE_MAX));
      expect(small.status).toBe(0);
      expect(large.status).toBe(0);
      expect(large.ms / Math.max(small.ms, 1)).toBeLessThan(8);
      expect(large.ms).toBeLessThan(BUDGET_MS);
    });

    // The verdict half of the same shape: padding a command with lines must not
    // become a way to smuggle the payload past the rules.
    it("still BLOCKS a destructive command buried under thousands of lines", () => {
      const out = runGuardVerbose(`${keptLines(LINE_MAX - 1)}\nrm -rf ~/`);
      expect(out.status).toBe(2);
      expect(out.stderr).toContain("recursive rm");
      expect(out.ms).toBeLessThan(BUDGET_MS);

      // …and the same payload one line PAST the ceiling is denied, not waved
      // through. A guard that stops inspecting has to stop approving with it.
      const past = runGuardVerbose(`${keptLines(LINE_MAX)}\nrm -rf ~/`);
      expect(past.status).toBe(2);
      expect(past.stderr).toContain("too many lines to inspect");
    });

    // The dimension the hook declares as NOT covered by a ceiling: line count
    // with no `<<` anywhere. The per-line loop never runs there, so what is
    // left is linear in bytes and CMD_MAX already prices it. Pinned because a
    // future change that moves work back into a per-line loop would make this
    // the unbounded case again, silently.
    it("evaluates a heredoc-FREE command of 20k lines inside the budget", () => {
      const out = runGuardVerbose(Array.from({ length: 20000 }, () => "x").join("\n"));
      expect(out.status).toBe(0);
      expect(out.ms).toBeLessThan(BUDGET_MS);
    });

    /**
     * The decision the byte ceiling used to make backwards, pinned as a row.
     *
     * A 40k-char prose heredoc is ONE pass over ONE body line — 74ms of real
     * work — and the 32768-byte ceiling denied it, while 16k one-char lines
     * (3.45s) passed. Cheap work blocked, expensive work admitted. Now that the
     * cost driver has its own ceiling, the byte ceiling can be what it should
     * be: a bound on memory and on the linear passes, not a proxy for time.
     * This is the exact shape #462 exists to allow — writing the document that
     * describes a security fix.
     */
    it("ADMITS a 40k-char single-pass prose heredoc (it used to deny it)", () => {
      const doc = `cat > /tmp/body.md <<'EOF'\n${"documentacion ".repeat(2900)}\nEOF`;
      expect(doc.length).toBeGreaterThan(40000);
      expect(doc.length).toBeLessThan(CMD_MAX);
      const out = runGuardVerbose(doc);
      expect(out.status).toBe(0);
      expect(out.stderr).toBe("");
      expect(out.ms).toBeLessThan(BUDGET_MS);
    });

    // The second ceiling: each `<<`-bearing line pays two `sed` and a `grep`,
    // so thousands of them drain the budget without any single one being large.
    it("BLOCKS a command with an absurd number of heredoc openers", () => {
      const cmd = Array.from({ length: 400 }, (_, i) => `echo "a << E${i}"`).join("\n");
      const out = runGuardVerbose(cmd);
      expect(out.status).toBe(2);
      expect(out.stderr).toContain("too many heredoc openers");
      expect(out.ms).toBeLessThan(BUDGET_MS);
      // This ceiling `block`s from INSIDE the `while … done <<< "$cmd"` loop,
      // which must not run in a subshell in either shell — there the `exit 2`
      // would be swallowed and the command would sail through.
      expect(runGuard(cmd)).toBe(2);
    });

    // ANTI-FALSE-GREEN for both ceilings: an ordinary command with a heredoc
    // must stay under them, or the two tests above would pass simply because
    // the guard blocks everything.
    it("leaves ordinary commands — heredoc included — under both ceilings", () => {
      const out = runGuardVerbose("cat > /tmp/body.md <<'EOF'\nun cuerpo de PR normal\nEOF");
      expect(out.status).toBe(0);
      expect(out.stderr).toBe("");
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
