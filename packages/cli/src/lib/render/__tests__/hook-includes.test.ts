import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
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
  const SEMGREP_RE =
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

  it("semgrep gate: additionally fires on git push and gh pr create", () => {
    expect(gate(SEMGREP_RE, "git commit -m x")).toBe(true);
    expect(gate(SEMGREP_RE, "git push origin main")).toBe(true);
    expect(gate(SEMGREP_RE, "gh pr create --fill")).toBe(true);
    expect(gate(SEMGREP_RE, "gh pr view")).toBe(false);
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
