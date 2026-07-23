import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getPluginPath } from "../bundled-assets.ts";

/**
 * Gate-detection tests for the plugin PreToolUse(Bash) hooks
 * (jscpd/semgrep/cognitive). Each embeds an IDENTICAL copy of
 * `is_git_commit_or_push` (there is no shared shell lib — the scripts render
 * standalone), so this suite pins the segment-based gate for every copy and
 * guards against divergence.
 *
 * The gate runs BEFORE the tool check. We drive each script under a restricted
 * PATH where the underlying tool (jscpd/semgrep/eslint) is absent, so a command
 * that PASSES the gate reaches the "no instalado" skip (observable on stderr),
 * while a command that FAILS the gate exits 0 immediately with no output.
 */

const runsBash = process.platform !== "win32";

function resolveBin(name: string): string {
  return execFileSync("bash", ["-c", `command -v ${name}`], { encoding: "utf-8" }).trim();
}

const PLUGINS = [
  { id: "jscpd", rel: "scripts/check-jscpd.sh" },
  { id: "semgrep", rel: "scripts/check-semgrep.sh" },
  { id: "cognitive", rel: "scripts/check-cognitive.sh" },
] as const;

describe.runIf(runsBash)("plugin gate hooks — segment-based git commit/push detection", () => {
  let restrictedEnv: NodeJS.ProcessEnv;

  beforeAll(() => {
    // Minimal PATH: enough to extract the command and run the gate, but WITHOUT
    // jscpd/semgrep so the post-gate tool check reports "no instalado".
    const bin = mkdtempSync(join(tmpdir(), "navori-plugin-gate-"));
    for (const tool of ["bash", "cat", "grep", "sed", "node", "dirname"]) {
      symlinkSync(resolveBin(tool), join(bin, tool));
    }
    restrictedEnv = { PATH: bin };
  });

  /** Render a plugin script into a temp file with placeholders substituted. */
  function installScript(id: string, rel: string): string {
    const raw = readFileSync(resolve(getPluginPath(id), rel), "utf-8").replace(
      /\{\{branchBase\}\}/g,
      "main",
    );
    const dir = mkdtempSync(join(tmpdir(), `navori-${id}-`));
    const p = join(dir, "hook.sh");
    writeFileSync(p, raw);
    chmodSync(p, 0o755);
    return p;
  }

  /** Run a plugin hook with `command` on stdin; returns { status, stderr }. */
  function runHook(scriptPath: string, command: string) {
    const r = spawnSync("bash", [scriptPath], {
      input: JSON.stringify({ tool_input: { command } }),
      encoding: "utf-8",
      env: restrictedEnv,
    });
    return { status: r.status, stderr: r.stderr };
  }

  for (const { id, rel } of PLUGINS) {
    describe(id, () => {
      let scriptPath: string;
      beforeAll(() => {
        scriptPath = installScript(id, rel);
      });

      // Gate PASSES → reaches the tool check → "no instalado" on stderr.
      it("triggers on a plain `git commit`", () => {
        const r = runHook(scriptPath, "git commit -m x");
        expect(r.status).toBe(0);
        expect(r.stderr).toContain("instalado");
      });

      it("triggers on a compound `cd sub && git commit`", () => {
        const r = runHook(scriptPath, "cd sub && git commit -m x");
        expect(r.status).toBe(0);
        expect(r.stderr).toContain("instalado");
      });

      it("triggers on `echo done; git push` (separator)", () => {
        const r = runHook(scriptPath, "echo done; git push");
        expect(r.status).toBe(0);
        expect(r.stderr).toContain("instalado");
      });

      // Gate FAILS → early `exit 0` with no tool-check output.
      it("skips a non-git command (`ls -la`) before the tool check", () => {
        const r = runHook(scriptPath, "ls -la");
        expect(r.status).toBe(0);
        expect(r.stderr).not.toContain("instalado");
      });

      it("skips a quoted `echo \"git commit\"` (not a real invocation)", () => {
        const r = runHook(scriptPath, 'echo "git commit"');
        expect(r.status).toBe(0);
        expect(r.stderr).not.toContain("instalado");
      });

      // FIX H: an env-var prefix must not hide the commit from the gate.
      it("triggers past an env-var prefix `FOO=bar git commit`", () => {
        const r = runHook(scriptPath, "FOO=bar git commit -m x");
        expect(r.status).toBe(0);
        expect(r.stderr).toContain("instalado");
      });

      // FIX H: no command extracted (Stop-hook / empty payload) → run
      // unconditionally, never silently skip.
      it("runs unconditionally on an empty command (Stop-hook path)", () => {
        const r = runHook(scriptPath, "");
        expect(r.status).toBe(0);
        expect(r.stderr).toContain("instalado");
      });

      // FIX C: git global options between `git` and the subcommand.
      it("triggers on `git -c k=v commit` (interleaved global option)", () => {
        const r = runHook(scriptPath, "git -c k=v commit -m x");
        expect(r.status).toBe(0);
        expect(r.stderr).toContain("instalado");
      });

      it("triggers on `git -C /repo push` (global -C with separate arg)", () => {
        const r = runHook(scriptPath, "git -C /repo push");
        expect(r.status).toBe(0);
        expect(r.stderr).toContain("instalado");
      });

      // FIX C: simple wrappers reduce to a plain `git …`.
      it("triggers on `command git commit`", () => {
        const r = runHook(scriptPath, "command git commit -m x");
        expect(r.status).toBe(0);
        expect(r.stderr).toContain("instalado");
      });

      it("triggers on `\\git commit` (leading backslash)", () => {
        const r = runHook(scriptPath, "\\git commit -m x");
        expect(r.status).toBe(0);
        expect(r.stderr).toContain("instalado");
      });

      it("triggers on `(git commit …)` (subshell parens)", () => {
        const r = runHook(scriptPath, "(git commit -m x)");
        expect(r.status).toBe(0);
        expect(r.stderr).toContain("instalado");
      });

      // FIX B: a multi-line continuation still gates.
      it("triggers on a multi-line `cd x && \\\\<NL> git commit`", () => {
        const r = runHook(scriptPath, "cd x && \\\n git commit -m x");
        expect(r.status).toBe(0);
        expect(r.stderr).toContain("instalado");
      });

      // FIX C negatives: a non-commit subcommand must NOT be gated.
      it("skips `git config user.name x` (not commit/push)", () => {
        const r = runHook(scriptPath, "git config user.name x");
        expect(r.status).toBe(0);
        expect(r.stderr).not.toContain("instalado");
      });

      it("skips `git commitgraph` (not the commit subcommand)", () => {
        const r = runHook(scriptPath, "git commitgraph write");
        expect(r.status).toBe(0);
        expect(r.stderr).not.toContain("instalado");
      });
    });
  }
});
