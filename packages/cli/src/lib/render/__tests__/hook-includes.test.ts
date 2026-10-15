import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { expandHookIncludes, hookPartialsDir } from "../hook-includes.ts";
import { acrossShells } from "../../__tests__/helpers/shells.ts";

describe("expandHookIncludes", () => {
  it("returns content untouched when there is no directive", () => {
    const src = "#!/usr/bin/env bash\nset -euo pipefail\necho hi\n";
    expect(expandHookIncludes(src)).toBe(src);
  });

  it("inlines a partial and leaves no directive behind", () => {
    const out = expandHookIncludes("before\n# navori:include extract-cmd\nafter\n");
    expect(out).not.toContain("navori:include");
    expect(out).toContain("extract_cmd() {"); // partial body was inlined
    expect(out.startsWith("before\n")).toBe(true);
    expect(out.endsWith("after\n")).toBe(true);
  });

  it("preserves the directive line's own newline (no blank-line collapse)", () => {
    const partial = readFileSync(join(hookPartialsDir(), "extract-cmd.sh"), "utf-8").replace(
      /\n$/,
      "",
    );
    expect(expandHookIncludes("a\n# navori:include extract-cmd\nb\n")).toBe(`a\n${partial}\nb\n`);
  });

  it("throws on an unknown partial", () => {
    expect(() => expandHookIncludes("# navori:include does-not-exist\n")).toThrow(/not found/);
  });
});

/**
 * Behavioral parity: the shared gate detector must still classify commands the
 * same way now that its body lives in a partial. Runs the expanded function
 * through a real bash with representative commands and asserts the gate verdict.
 */
describe("gate-trigger partial (behavioral)", () => {
  const gateBody = readFileSync(join(hookPartialsDir(), "gate-trigger.sh"), "utf-8");
  const COMMIT_RE =
    "^git([[:space:]]+-[a-zA-Z-]+(=[^[:space:]]+)?([[:space:]]+[^-][^[:space:]]*)?)*[[:space:]]+commit([[:space:]]|$)";
  const PUSH_RE =
    "(^git([[:space:]]+-[a-zA-Z-]+(=[^[:space:]]+)?([[:space:]]+[^-][^[:space:]]*)?)*[[:space:]]+(commit|push)([[:space:]]|$))|(^gh[[:space:]]+pr[[:space:]]+create([[:space:]]|$))";

  /** Runs under every available shell (bash AND zsh, #391); the verdicts must agree. */
  function gate(triggerRe: string, cmd: string): boolean {
    const script = `TRIGGER_RE='${triggerRe}'\n${gateBody}\nif is_scan_trigger "$1"; then echo T; else echo F; fi`;
    return acrossShells((shell) => {
      const out = execFileSync(shell, ["-c", script, shell, cmd], { encoding: "utf-8" }).trim();
      return out === "T";
    });
  }

  it("commit gate: fires on git commit incl. compound / wrapped forms, not on lookalikes", () => {
    expect(gate(COMMIT_RE, "git commit -m x")).toBe(true);
    expect(gate(COMMIT_RE, "cd x && git commit -m x")).toBe(true); // FIX: was silently skipped
    expect(gate(COMMIT_RE, "FOO=bar git commit")).toBe(true);
    expect(gate(COMMIT_RE, "git -c k=v commit")).toBe(true); // global option before subcommand
    expect(gate(COMMIT_RE, "git commitgraph write")).toBe(false); // word boundary
    expect(gate(COMMIT_RE, 'echo "git commit"')).toBe(false); // quoted, not a real invocation
    expect(gate(COMMIT_RE, "git push")).toBe(false); // commit-only gate ignores push
  });

  it("push gate: additionally fires on git push and gh pr create", () => {
    expect(gate(PUSH_RE, "git commit -m x")).toBe(true);
    expect(gate(PUSH_RE, "git push origin main")).toBe(true);
    expect(gate(PUSH_RE, "gh pr create --fill")).toBe(true);
    expect(gate(PUSH_RE, "gh pr view")).toBe(false);
  });

  /** Same table with TRIGGER_STRIP_HEREDOC_BODIES set (or not) — #1095. */
  function gateHeredoc(cmd: string, strip: boolean): boolean {
    const flag = strip ? "TRIGGER_STRIP_HEREDOC_BODIES=1\n" : "";
    const script = `TRIGGER_RE='${COMMIT_RE}'\n${flag}${gateBody}\nif is_scan_trigger "$1"; then echo T; else echo F; fi`;
    return acrossShells((shell) => {
      const out = execFileSync(shell, ["-c", script, shell, cmd], { encoding: "utf-8" }).trim();
      return out === "T";
    });
  }

  it("heredoc bodies fed to `cat` are data, everything else keeps its body (#1095)", () => {
    const gh = "gh issue create --title t --body \"$(cat <<'EOF'\ngit commit -m x\nEOF\n)\"";
    expect(gateHeredoc(gh, true)).toBe(false);
    expect(gateHeredoc(gh, false)).toBe(true); // opt-in: flag unset keeps every line
    expect(gateHeredoc("cat > f.sh <<EOF\ngit commit\nEOF", true)).toBe(false);
    expect(gateHeredoc("cat <<-EOF\n\tgit commit\n\tEOF", true)).toBe(false);
    // The introducing line is kept, so a real commit still triggers.
    expect(gateHeredoc("git commit -F - <<'EOF'\nmsg\nEOF", true)).toBe(true);
    expect(gateHeredoc("git commit -m \"$(cat <<'EOF'\nmsg\nEOF\n)\"", true)).toBe(true);
    // A body a shell or interpreter may execute is never stripped.
    expect(gateHeredoc("bash <<'EOF'\ngit commit -m x\nEOF", true)).toBe(true);
    expect(gateHeredoc("cat <<EOF | sh\ngit commit\nEOF", true)).toBe(true);
    expect(gateHeredoc("while read c; do $c; done <<EOF\ngit commit -m x\nEOF", true)).toBe(true);
    expect(gateHeredoc('bash -c "$(cat <<EOF\ngit commit -m x\nEOF\n)"', true)).toBe(true);
    expect(gateHeredoc("python3 - <<EOF\ngit commit\nEOF", true)).toBe(true);
    // Fail closed on doubt.
    expect(gateHeredoc("cat <<EOF\ngit commit", true)).toBe(true); // unterminated
    expect(gateHeredoc("cat <<A <<B\ngit commit\nA\nB", true)).toBe(true); // two heredocs
    // Text after the terminator is a normal command again.
    expect(gateHeredoc("cat <<EOF\nx\nEOF\ngit commit -m y", true)).toBe(true);
    // F5: `<<` inside a message is not a heredoc; the later op keeps its trigger.
    expect(gateHeredoc('git commit -m "x <<EOF"\ngit commit -m z', true)).toBe(true);
  });
});

/**
 * Mechanical coverage control for the shared partials (spec: retire jscpd/semgrep).
 *
 * A partial is only worth its place if a CORE hook includes it, and only trusted
 * while a test that drives that hook names it. Both halves are checked here, so
 * deleting a plugin (and its gate tests) cannot silently strand a partial.
 */
describe("every shared partial is consumed and covered by a core hook", () => {
  const cliSrc = join(import.meta.dirname, "..", "..", ".."); // packages/cli/src
  const hooksDir = join(hookPartialsDir(), "..");
  const partials = readdirSync(hookPartialsDir())
    .filter((f) => f.endsWith(".sh"))
    .map((f) => f.replace(/\.sh$/, ""))
    .sort();
  const coreHooks = readdirSync(hooksDir).filter((f) => f.endsWith(".sh"));

  /**
   * partial -> a core hook that includes it + a test that runs that hook and
   * exercises the partial's behaviour. `title` must appear verbatim in `file`.
   */
  const PARTIAL_BEHAVIOUR_TESTS: Record<string, { hook: string; file: string; title: string }> = {
    "review-edit-binding": {
      hook: "role-guard",
      file: "lib/__tests__/role-guard.test.ts",
      title: "authorizes registered linked-worktree review outputs through the binding branch",
    },
    "audit-arm": {
      hook: "audit-mode-trigger",
      file: "__tests__/audit-hooks.test.ts",
      title: "appends the typed prompt while active, and only appends",
    },
    "audit-log": {
      hook: "quality-gate-pre-commit",
      file: "__tests__/audit-hooks.test.ts",
      title: "records a hook that ran and decided it had nothing to do",
    },
    "audit-repo": {
      hook: "audit-mode-close",
      file: "__tests__/audit-hooks.test.ts",
      title: "normalizes agent worktree cwd in close hook (#764)",
    },
    "audit-signal": {
      hook: "quality-gate-pre-commit",
      file: "lib/__tests__/gate-hook-kill.test.ts",
      title: "records allow only when nothing killed it",
    },
    "bash-outcome": {
      hook: "bash-outcome-watch",
      file: "lib/__tests__/bash-outcome-watch.test.ts",
      title: "separates agents and signatures, and resets on success",
    },
    "classify-source": {
      hook: "routing-watch",
      file: "lib/__tests__/routing-watch.test.ts",
      title: "no cuenta tests, lockfiles ni docs",
    },
    "draft-body": {
      hook: "comment-draft-confirm",
      file: "lib/__tests__/comment-draft-confirm.test.ts",
      title: "shows --body-file content for gh issue create",
    },
    "extract-cmd": {
      hook: "quality-gate-pre-commit",
      file: "lib/__tests__/quality-gate-hook.test.ts",
      title: "extracts a command before cwd when jq and node are unavailable",
    },
    "gate-ask": {
      hook: "quality-gate-pre-commit",
      file: "lib/__tests__/gate-exit-contract.test.ts",
      title: "runner not on PATH + Claude hook payload → ask JSON, exit 0, no 'outside the agent'",
    },
    "gate-trigger": {
      hook: "quality-gate-pre-commit",
      file: "lib/__tests__/quality-gate-hook.test.ts",
      title: "runs the gate on a compound `cd x && git commit` (no silent skip)",
    },
    "hook-input": {
      hook: "guard-destructive",
      file: "lib/__tests__/codex-hook-payloads.test.ts",
      title: "blocks a fork bomb under both engines",
    },
    "inert-skeleton": {
      hook: "guard-destructive",
      file: "lib/__tests__/guard-destructive.test.ts",
      title: "inert content — written text vs executed text (#462)",
    },
    "resolve-worktree": {
      hook: "quality-gate-pre-commit",
      file: "lib/__tests__/quality-gate-worktree-resolve.test.ts",
      title: "resolves the tree from `git -C <worktree> commit`",
    },
  };

  const includesPartial = (hook: string, partial: string): boolean => {
    const text = readFileSync(join(hooksDir, `${hook}.sh`), "utf-8");
    const names = [...text.matchAll(/^[^\S\n]*#\s*navori:include\s+(\S+)[^\S\n]*$/gm)].map(
      (m) => m[1],
    );
    return names.includes(partial);
  };

  it("every partial is included by at least one core hook", () => {
    const orphans = partials.filter(
      (p) => !coreHooks.some((h) => includesPartial(h.replace(/\.sh$/, ""), p)),
    );
    expect(orphans, "a partial no core hook includes is dead code").toEqual([]);
  });

  it("every partial maps to a behaviour test, and the map has no stale rows", () => {
    expect(Object.keys(PARTIAL_BEHAVIOUR_TESTS).sort()).toEqual(partials);
  });

  it.each(Object.entries(PARTIAL_BEHAVIOUR_TESTS))(
    "%s: the named test exists and drives a core hook that includes the partial",
    (partial, { hook, file, title }) => {
      expect(coreHooks, `${hook} is not a core hook`).toContain(`${hook}.sh`);
      expect(includesPartial(hook, partial), `${hook} does not include ${partial}`).toBe(true);
      const path = join(cliSrc, file);
      expect(existsSync(path), `${file} does not exist`).toBe(true);
      const src = readFileSync(path, "utf-8");
      expect(src, `${file} does not contain the test "${title}"`).toContain(title);
      expect(src, `${file} never names the ${hook} hook`).toContain(hook);
    },
  );
});
