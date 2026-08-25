import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
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
