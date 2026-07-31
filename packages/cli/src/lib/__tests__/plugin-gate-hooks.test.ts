import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  symlinkSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getPluginPath } from "../bundled-assets.ts";
import { interpolate } from "../interpolate.ts";
import { expandHookIncludes } from "../hook-includes.ts";
import type { NavoriConfig } from "../config.ts";

/**
 * Render a plugin script exactly as `navori render` does: inline the shared
 * `# navori:include` shell partials, then `interpolate` with a config (so the
 * `{{shq:branchBase}}` / `{{shq:jscpdThreshold}}` markers get shell-quoted, #249)
 * plus the `jscpdThreshold` extraVar the engine injects.
 */
function renderScript(id: string, rel: string, branchBase = "main"): string {
  const raw = expandHookIncludes(readFileSync(resolve(getPluginPath(id), rel), "utf-8"));
  const config = { branchBase, preset: "custom" } as unknown as NavoriConfig;
  return interpolate(raw, config, { extraVars: { jscpdThreshold: "10" } });
}

/**
 * Gate-detection tests for the plugin PreToolUse(Bash) hooks
 * (jscpd/semgrep). Both now inline the SAME shared `is_scan_trigger` from
 * `core-assets/hooks/_partials/gate-trigger.sh` (single source of truth, #261),
 * so this suite pins the segment-based gate as rendered for every copy and
 * guards against divergence.
 *
 * The gate runs BEFORE the tool check. We drive each script under a restricted
 * PATH where the underlying tool (jscpd/semgrep) is absent, so a command
 * that PASSES the gate reaches the "not installed" skip (observable on stderr),
 * while a command that FAILS the gate exits 0 immediately with no output.
 */

const runsBash = process.platform !== "win32";

function resolveBin(name: string): string {
  return execFileSync("bash", ["-c", `command -v ${name}`], { encoding: "utf-8" }).trim();
}

const PLUGINS = [
  { id: "jscpd", rel: "scripts/check-jscpd.sh" },
  { id: "semgrep", rel: "scripts/check-semgrep.sh" },
] as const;

describe.runIf(runsBash)("plugin gate hooks — segment-based git commit/push detection", () => {
  let restrictedEnv: NodeJS.ProcessEnv;

  beforeAll(() => {
    // Minimal PATH: enough to extract the command and run the gate, but WITHOUT
    // jscpd/semgrep so the post-gate tool check reports "not installed".
    const bin = mkdtempSync(join(tmpdir(), "navori-plugin-gate-"));
    for (const tool of ["bash", "cat", "grep", "sed", "node", "dirname"]) {
      symlinkSync(resolveBin(tool), join(bin, tool));
    }
    restrictedEnv = { PATH: bin };
  });

  /** Render a plugin script into a temp file with placeholders substituted. */
  function installScript(id: string, rel: string): string {
    const dir = mkdtempSync(join(tmpdir(), `navori-${id}-`));
    const p = join(dir, "hook.sh");
    writeFileSync(p, renderScript(id, rel));
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

      // Gate PASSES → reaches the tool check → "not installed" on stderr.
      it("triggers on a plain `git commit`", () => {
        const r = runHook(scriptPath, "git commit -m x");
        expect(r.status).toBe(0);
        expect(r.stderr).toContain("installed");
      });

      it("triggers on a compound `cd sub && git commit`", () => {
        const r = runHook(scriptPath, "cd sub && git commit -m x");
        expect(r.status).toBe(0);
        expect(r.stderr).toContain("installed");
      });

      // Push gating: only semgrep (the security backstop) gates a push; the
      // commit-only hooks skip it — the content was already gated at commit.
      it(`${id === "semgrep" ? "gates" : "skips"} \`echo done; git push\` (push)`, () => {
        const r = runHook(scriptPath, "echo done; git push");
        expect(r.status).toBe(0);
        if (id === "semgrep") expect(r.stderr).toContain("installed");
        else expect(r.stderr).not.toContain("installed");
      });

      // Gate FAILS → early `exit 0` with no tool-check output.
      it("skips a non-git command (`ls -la`) before the tool check", () => {
        const r = runHook(scriptPath, "ls -la");
        expect(r.status).toBe(0);
        expect(r.stderr).not.toContain("installed");
      });

      it('skips a quoted `echo "git commit"` (not a real invocation)', () => {
        const r = runHook(scriptPath, 'echo "git commit"');
        expect(r.status).toBe(0);
        expect(r.stderr).not.toContain("installed");
      });

      // FIX H: an env-var prefix must not hide the commit from the gate.
      it("triggers past an env-var prefix `FOO=bar git commit`", () => {
        const r = runHook(scriptPath, "FOO=bar git commit -m x");
        expect(r.status).toBe(0);
        expect(r.stderr).toContain("installed");
      });

      // FIX H: no command extracted (Stop-hook / empty payload) → run
      // unconditionally, never silently skip.
      it("runs unconditionally on an empty command (Stop-hook path)", () => {
        const r = runHook(scriptPath, "");
        expect(r.status).toBe(0);
        expect(r.stderr).toContain("installed");
      });

      // FIX C: git global options between `git` and the subcommand.
      it("triggers on `git -c k=v commit` (interleaved global option)", () => {
        const r = runHook(scriptPath, "git -c k=v commit -m x");
        expect(r.status).toBe(0);
        expect(r.stderr).toContain("installed");
      });

      it(`${id === "semgrep" ? "gates" : "skips"} \`git -C /repo push\` (global -C push)`, () => {
        const r = runHook(scriptPath, "git -C /repo push");
        expect(r.status).toBe(0);
        if (id === "semgrep") expect(r.stderr).toContain("installed");
        else expect(r.stderr).not.toContain("installed");
      });

      // gh pr create pushes to the remote → semgrep (backstop) gates it, even
      // though it is not a `git` command; the commit-only hooks skip it.
      it(`${id === "semgrep" ? "gates" : "skips"} \`gh pr create\` (remote push)`, () => {
        const r = runHook(scriptPath, "gh pr create --title x --body y");
        expect(r.status).toBe(0);
        if (id === "semgrep") expect(r.stderr).toContain("installed");
        else expect(r.stderr).not.toContain("installed");
      });

      // FIX C: simple wrappers reduce to a plain `git …`.
      it("triggers on `command git commit`", () => {
        const r = runHook(scriptPath, "command git commit -m x");
        expect(r.status).toBe(0);
        expect(r.stderr).toContain("installed");
      });

      it("triggers on `\\git commit` (leading backslash)", () => {
        const r = runHook(scriptPath, "\\git commit -m x");
        expect(r.status).toBe(0);
        expect(r.stderr).toContain("installed");
      });

      it("triggers on `(git commit …)` (subshell parens)", () => {
        const r = runHook(scriptPath, "(git commit -m x)");
        expect(r.status).toBe(0);
        expect(r.stderr).toContain("installed");
      });

      // FIX B: a multi-line continuation still gates.
      it("triggers on a multi-line `cd x && \\\\<NL> git commit`", () => {
        const r = runHook(scriptPath, "cd x && \\\n git commit -m x");
        expect(r.status).toBe(0);
        expect(r.stderr).toContain("installed");
      });

      // FIX C negatives: a non-commit subcommand must NOT be gated.
      it("skips `git config user.name x` (not commit/push)", () => {
        const r = runHook(scriptPath, "git config user.name x");
        expect(r.status).toBe(0);
        expect(r.stderr).not.toContain("installed");
      });

      it("skips `git commitgraph` (not the commit subcommand)", () => {
        const r = runHook(scriptPath, "git commitgraph write");
        expect(r.status).toBe(0);
        expect(r.stderr).not.toContain("installed");
      });
    });
  }
});

describe("plugin gate commands — generated tool invocation", () => {
  function scriptOf(id: string, rel: string): string {
    return readFileSync(resolve(getPluginPath(id), rel), "utf-8");
  }

  it("semgrep uses p/default, not auto (auto is incompatible with --metrics=off)", () => {
    const s = scriptOf("semgrep", "scripts/check-semgrep.sh");
    expect(s).toContain("--config=p/default");
    // No ACTIVE `--config=auto` flag line (the NOTE comment may still name it).
    expect(s).not.toMatch(/\n\s*--config=auto\b/);
    // Telemetry stays off — the whole reason auto had to go.
    expect(s).toContain("--metrics=off");
  });

  it("jscpd prefers the repo-pinned binary over a global one", () => {
    const s = scriptOf("jscpd", "scripts/check-jscpd.sh");
    expect(s).toContain("node_modules/.bin/jscpd");
    // The scan invokes the resolved binary, not a bare `jscpd`.
    expect(s).toContain('"$JSCPD_BIN"');
  });
});

/**
 * #249 — `branchBase` (and `jscpdThreshold`) flow from `navori.config.json`
 * (checked-in, editable via PR) into these hooks, which run on every
 * `git commit`/`push` via PreToolUse(Bash). A hostile value must be an inert
 * literal, never an injected command. We drive the FULLY-RENDERED script in a
 * real git repo with the tool faked-present (so execution reaches the
 * branchBase-consuming lines) and assert the payload never fires.
 */
describe.runIf(runsBash)("plugin gate hooks — untrusted branchBase stays inert (#249)", () => {
  for (const { id, rel } of PLUGINS) {
    it(`neutralizes a command-substitution payload in branchBase (${id})`, () => {
      const work = mkdtempSync(join(tmpdir(), `navori-inj-${id}-`));
      execFileSync("git", ["init", "-q"], { cwd: work });

      // Minimal PATH plus a fake tool binary so the early "installed?" check
      // passes and we reach the lines that consume `$base` (real semgrep/jscpd
      // may be absent in CI — irrelevant, we only need the payload to NOT run).
      const bin = mkdtempSync(join(tmpdir(), `navori-inj-bin-${id}-`));
      for (const tool of ["bash", "cat", "grep", "sed", "node", "dirname", "git", "mktemp", "rm"]) {
        symlinkSync(resolveBin(tool), join(bin, tool));
      }
      writeFileSync(join(bin, id), "#!/usr/bin/env bash\nexit 0\n");
      chmodSync(join(bin, id), 0o755);

      // With the bug, `git rev-parse --verify main$(touch pwned)` executes the
      // substitution and creates the sentinel. The shq: marker keeps it literal.
      const sentinel = join(work, "pwned");
      const hostile = `main$(touch ${sentinel})`;
      const script = join(work, "hook.sh");
      writeFileSync(script, renderScript(id, rel, hostile));
      chmodSync(script, 0o755);

      const r = spawnSync("bash", [script], {
        input: JSON.stringify({ tool_input: { command: "git commit -m x" } }),
        encoding: "utf-8",
        cwd: work,
        env: { PATH: bin },
      });

      expect(existsSync(sentinel)).toBe(false);
      // The unknown ref just skips the scan — a clean exit, no crash.
      expect(r.status).toBe(0);
    });
  }
});
