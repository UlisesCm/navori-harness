import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  symlinkSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getCoreRoot, getPluginPath } from "../render/bundled-assets.ts";
import { interpolate } from "../render/interpolate.ts";
import { expandHookIncludes } from "../render/hook-includes.ts";
import { buildClaudeSettings, claudeHookCommand } from "../../engines/claude/build-settings.ts";
import { buildCodexConfigToml } from "../../engines/codex/build-config-toml.ts";
import type { NavoriConfig } from "../config/config.ts";
import type { LoadedPlugin } from "../config/plugins.ts";
import { acrossShells, HOOK_SHELLS, type HookShell } from "./helpers/shells.ts";

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

  /** Run a plugin hook with `command` on stdin; returns { status, stderr }.
   * Runs under every available shell (bash AND zsh, #391); the outcomes must
   * agree. The shell is invoked by absolute path so the restricted PATH stays
   * minimal. */
  function runHook(scriptPath: string, command: string) {
    return acrossShells((shell) => {
      const r = spawnSync(resolveBin(shell), [scriptPath], {
        input: JSON.stringify({ tool_input: { command } }),
        encoding: "utf-8",
        env: restrictedEnv,
      });
      return { status: r.status, stderr: r.stderr };
    });
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

      // #1115: a chained `commit && push` (no repo context, same-repo) still gates.
      it("triggers on the chain `git commit && git push`", () => {
        const r = runHook(scriptPath, "git commit -m x && git push");
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

      /**
       * Spec 0016 — the detector pays one `grep` fork PER SEGMENT, so its cost
       * used to scale with command length (85 ms for 40 segments). A substring
       * fast path over the raw input now answers "not for me" in-process. These
       * two pin the property that matters: the shortcut changes the price,
       * never the verdict.
       */
      it("still triggers on a `git commit` buried at the end of a long compound", () => {
        const long = [...Array.from({ length: 39 }, (_, i) => `echo paso${i}`), "git commit"].join(
          " && ",
        );
        const r = runHook(scriptPath, long);
        expect(r.status).toBe(0);
        expect(r.stderr).toContain("installed");
      });

      it("skips a long compound with no gated op (the fast path's whole point)", () => {
        const long = Array.from({ length: 40 }, (_, i) => `echo paso${i}`).join(" && ");
        const r = runHook(scriptPath, long);
        expect(r.status).toBe(0);
        expect(r.stderr).not.toContain("installed");
      });
    });
  }
});

/**
 * The fast path is sound only while $TRIGGER_TOKENS stays a set of literals
 * that EVERY branch of its $TRIGGER_RE requires — a regex branch added without
 * its token would be silently unreachable through the shortcut. The runtime
 * fails open (unset tokens → slow path), so the pairing itself is pinned here,
 * against the ASSETS, for the three hooks that gate on git operations.
 */
describe("gate fast path — TRIGGER_TOKENS pairs with TRIGGER_RE (spec 0016)", () => {
  const ASSETS = [
    ["core", join(getCoreRoot(), "core-assets/hooks/quality-gate-pre-commit.sh"), ["commit"]],
    ["jscpd", join(getPluginPath("jscpd"), "scripts/check-jscpd.sh"), ["commit"]],
    [
      "semgrep",
      join(getPluginPath("semgrep"), "scripts/check-semgrep.sh"),
      ["commit", "push", "create"],
    ],
  ] as const;

  it.each(ASSETS)("%s: declares its tokens, and each appears in the regex", (_id, path, tokens) => {
    const src = readFileSync(path, "utf-8");
    const re = src.match(/^TRIGGER_RE='(.+)'$/m)?.[1];
    const declared = src.match(/^TRIGGER_TOKENS='(.+)'$/m)?.[1]?.split(" ");
    expect(re, "TRIGGER_RE not found").toBeDefined();
    expect(declared, "TRIGGER_TOKENS not found").toEqual([...tokens]);
    // Each token must be a literal the regex spells out — the substring probe
    // can only be a superset of matches while this holds.
    for (const tok of tokens) expect(re).toContain(tok);
  });
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
 * The managed protocol blocks are interpolated at render time (#273), so they
 * must use `{{branchBase}}` — never the undefined `$BRANCH_BASE` shell var,
 * which expands to an empty string and turns the scan into a silent no-op. The
 * semgrep protocol must also match its own gate script's flags (#278).
 */
describe("plugin managed protocols — interpolated command doctrine", () => {
  function protocolOf(id: string, rel: string, branchBase = "main"): string {
    const raw = readFileSync(resolve(getPluginPath(id), rel), "utf-8");
    return interpolate(raw, { branchBase, preset: "custom" } as unknown as NavoriConfig);
  }

  it("jscpd protocol interpolates the base branch, not $BRANCH_BASE (#273)", () => {
    const p = protocolOf("jscpd", "managed/jscpd-protocol.md");
    expect(p).not.toContain("$BRANCH_BASE");
    expect(p).toContain("main...HEAD");
  });

  // #614 moved this doctrine out of managed/semgrep-protocol.md (retired,
  // #1025) into the skill the plugin still ships — same doctrine, new home.
  it("semgrep skill interpolates the base branch, not $BRANCH_BASE (#273)", () => {
    const p = protocolOf("semgrep", "skills/semgrep-review.md");
    expect(p).not.toContain("$BRANCH_BASE");
    expect(p).toContain("--baseline-commit main");
  });

  it("semgrep skill matches its gate script's flags (#278)", () => {
    const p = protocolOf("semgrep", "skills/semgrep-review.md");
    expect(p).toContain("--config=p/default");
    expect(p).toContain("--metrics=off");
    // The old, telemetry-on, non-deterministic invocation is gone.
    expect(p).not.toContain("--config=auto");
    expect(p).not.toContain("--severity=ERROR");
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

      // Both shells must leave the payload inert (#391): run under bash AND zsh.
      const status = acrossShells(
        (shell) =>
          spawnSync(resolveBin(shell), [script], {
            input: JSON.stringify({ tool_input: { command: "git commit -m x" } }),
            encoding: "utf-8",
            cwd: work,
            env: { PATH: bin },
          }).status,
      );

      expect(existsSync(sentinel)).toBe(false);
      // The unknown ref just skips the scan — a clean exit, no crash.
      expect(status).toBe(0);
    });
  }
});

/** Covers: R5, R6 (spec 0037) — the host decision and audit reason are separate scanner evidence. */
describe.runIf(runsBash)("plugin gate hooks — rendered scanner outcome fidelity", () => {
  type AuditEvent = { verdict: string; reason?: string; host?: string };
  // The claude/codex placements run THIS repo's rendered hooks, which bake in its
  // `branchBase`; the fixture repo and the source render must use the same base.
  const BASE =
    (
      JSON.parse(readFileSync(resolve("../../navori.config.json"), "utf-8")) as {
        branchBase?: string;
      }
    ).branchBase ?? "main";

  /** Isolate Git history, fake scanner, and audit log for one host/shell case. */
  function fixture(id: "jscpd" | "semgrep") {
    const root = mkdtempSync(join(tmpdir(), `navori-scanner-${id}-`));
    const bin = join(root, "bin");
    mkdirSync(bin);
    const auditRoot = join(root, "audits");
    const repo = join(root, "repo");
    mkdirSync(repo);
    mkdirSync(join(auditRoot, "repo"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(bin, "navori"),
      `#!/bin/sh\nexec '${process.execPath}' '${resolve("dist/index.js")}' "$@"\n`,
      { mode: 0o700 },
    );
    const log = join(auditRoot, "repo", "session-spec0037.log");
    writeFileSync(
      log,
      `${JSON.stringify({ event: "start", sessionId: "spec0037", cwd: repo })}\n`,
      { mode: 0o600 },
    );
    execFileSync("git", ["init", "-q", "-b", BASE], { cwd: repo });
    writeFileSync(join(repo, "changed.ts"), "export const before = 1;\n");
    execFileSync("git", ["add", "changed.ts"], { cwd: repo });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "fixture baseline",
      ],
      { cwd: repo },
    );
    execFileSync("git", ["update-ref", `refs/remotes/origin/${BASE}`, "HEAD"], { cwd: repo });
    writeFileSync(join(repo, "changed.ts"), "export const localOnly = 1;\n");
    execFileSync("git", ["add", "changed.ts"], { cwd: repo });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "fixture local main ahead of origin",
      ],
      { cwd: repo },
    );
    writeFileSync(join(repo, "changed.ts"), "export const after = 2;\n");
    writeFileSync(join(repo, "new.tsx"), "export const New = () => null;\n");
    const scanner = join(bin, id);
    writeFileSync(
      scanner,
      `#!/bin/sh
if [ "\${1:-}" = "--help" ]; then
  if [ -n "\${SCAN_NO_FLAGS:-}" ]; then echo 'old scanner'; else echo '--baseline-from-ref --fail-on-new-clones'; fi
  exit 0
fi
printf '%s\\n' "$@" > "$SCAN_ARGS"
# Reproduces jscpd --baseline-from-ref: it checks the base out via a detached worktree.
if [ -n "\${SCAN_WORKTREE:-}" ]; then git worktree add -q --detach "$SCAN_WORKTREE" origin/${BASE} || exit 9; fi
if [ -n "\${SCAN_SIGNAL:-}" ]; then kill -s "$SCAN_SIGNAL" "$PPID"; exit 0; fi
exit "$SCAN_EXIT"
`,
    );
    chmodSync(scanner, 0o755);
    const args = join(root, "args");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      NAVORI_AUDITS_ROOT: auditRoot,
      SCAN_ARGS: args,
      SCAN_EXIT: "0",
    };
    return { root, repo, log, env, args };
  }

  function run(script: string, f: ReturnType<typeof fixture>, scanExit: number, shell: HookShell) {
    writeFileSync(
      f.log,
      `${JSON.stringify({ event: "start", host: script.includes(".codex/") ? "codex" : "claude", sessionId: "spec0037", cwd: f.repo })}\n`,
    );
    const result = spawnSync(resolveBin(shell), [script], {
      cwd: f.repo,
      env: { ...f.env, SCAN_EXIT: String(scanExit) },
      encoding: "utf-8",
      input: JSON.stringify({
        session_id: "spec0037",
        tool_use_id: "scan",
        cwd: f.repo,
        tool_input: { command: "git commit -m fixture" },
      }),
    });
    const events = readFileSync(f.log, "utf-8")
      .trim()
      .split("\n")
      .filter((line) => Boolean(line) && (JSON.parse(line) as { event?: string }).event === "hook")
      .map((line) => JSON.parse(line) as AuditEvent);
    return { status: result.status, signal: result.signal, stderr: result.stderr, events };
  }

  for (const { id, rel } of PLUGINS) {
    it.each(
      ["source", "claude", "codex"].flatMap((placement) =>
        HOOK_SHELLS.map((shell) => [placement, shell] as const),
      ),
    )(`${id} %s/%s: clean, ambiguous/finding and error`, (placement, shell) => {
      const f = fixture(id);
      const script =
        placement === "source"
          ? join(f.root, "hook.sh")
          : resolve(`../../.${placement}/scripts/check-${id}.sh`);
      if (placement === "source") {
        writeFileSync(script, renderScript(id, rel, BASE));
        chmodSync(script, 0o755);
      }
      // Covers: R5, R6 — every rendered host shares the same exit and audit contract.
      const clean = run(script, f, 0, shell);
      expect(clean.status).toBe(0);
      expect(clean.events.map((event) => event.verdict)).toEqual(["gate-started", "allow"]);
      expect(clean.events.at(-1)?.host).toBe(placement === "codex" ? "codex" : "claude");
      expect(clean.events.at(-1)?.reason).toBe("unspecified");
      const args = readFileSync(f.args, "utf-8");
      expect(args).toContain("new.tsx");
      expect(args).toContain("changed.ts");
      expect(args).toContain(
        execFileSync("git", ["rev-parse", `origin/${BASE}`], {
          cwd: f.repo,
          encoding: "utf-8",
        }).trim(),
      );
      expect(args).not.toContain(
        execFileSync("git", ["rev-parse", BASE], {
          cwd: f.repo,
          encoding: "utf-8",
        }).trim(),
      );
      if (id === "jscpd") expect(args).toMatch(/--\n(?:changed\.ts|new\.tsx)/);

      if (id === "semgrep") {
        const cached = run(script, f, 0, shell);
        expect(cached.status).toBe(0);
        expect(cached.events).toEqual([
          expect.objectContaining({
            verdict: "allow",
            reason: "unspecified",
          }),
        ]);
        // A changed fingerprint must invalidate the previous green cache marker.
        writeFileSync(join(f.repo, "changed.ts"), "export const after = 3;\n");
      }
      const marker =
        id === "semgrep"
          ? join(
              execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
                cwd: f.repo,
                encoding: "utf-8",
              }).trim(),
              "navori-semgrep-ok",
            )
          : "";
      const markerBeforeError = marker ? readFileSync(marker, "utf-8") : "";
      const blocked = run(script, f, 1, shell);
      expect(blocked.status).toBe(2);
      expect(blocked.events.at(-1)?.verdict).toBe("block");
      if (id === "jscpd") {
        expect(blocked.stderr).toMatch(/exit 1 with no new-clone evidence/);
        expect(blocked.events.at(-1)?.reason).toBe("unspecified");
      }

      const error = run(script, f, 3, shell);
      expect(error.status).toBe(1);
      expect(error.stderr).toMatch(/nothing was validated/);
      expect(error.events.at(-1)).toMatchObject({ verdict: "allow" });
      expect(error.events.at(-1)?.reason).toBe("unspecified");
      if (id === "semgrep") {
        expect(readFileSync(marker, "utf-8")).toBe(markerBeforeError);
      }

      unlinkSync(join(f.repo, "new.tsx"));
      writeFileSync(join(f.repo, "changed.ts"), "export const before = 1;\n");
      const skipped = run(script, f, 0, shell);
      expect(skipped.status).toBe(0);
      expect(skipped.events.at(-1)).toMatchObject({
        verdict: "allow",
        reason: "unspecified",
      });
      expect(skipped.events.some((event) => event.verdict === "gate-started")).toBe(false);
    });

    it.each(
      ["source", "codex"].flatMap((placement) =>
        HOOK_SHELLS.map((shell) => [placement, shell] as const),
      ),
    )(`${id} %s/%s: missing scanner and baseline are explicit skips`, (placement, shell) => {
      const f = fixture(id);
      const script =
        placement === "source"
          ? join(f.root, "hook.sh")
          : resolve(`../../.codex/scripts/check-${id}.sh`);
      if (placement === "source") {
        writeFileSync(script, renderScript(id, rel, BASE));
        chmodSync(script, 0o755);
      }
      execFileSync("git", ["branch", "-m", "topic"], { cwd: f.repo });
      execFileSync("git", ["update-ref", "-d", `refs/remotes/origin/${BASE}`], { cwd: f.repo });
      const noBase = run(script, f, 0, shell);
      expect(noBase.status).toBe(0);
      expect(noBase.events.at(-1)).toMatchObject({
        verdict: "allow",
        reason: "unspecified",
      });
      expect(noBase.events.some((event) => event.verdict === "gate-started")).toBe(false);

      const restricted = join(f.root, "restricted");
      mkdirSync(restricted);
      writeFileSync(
        join(restricted, "navori"),
        `#!/bin/sh\nexec '${process.execPath}' '${resolve("dist/index.js")}' "$@"\n`,
        { mode: 0o700 },
      );
      for (const tool of [
        "bash",
        "cat",
        "grep",
        "sed",
        "node",
        "dirname",
        "git",
        "jq",
        "basename",
        "perl",
        "date",
        "mktemp",
        "rm",
      ]) {
        symlinkSync(resolveBin(tool), join(restricted, tool));
      }
      f.env.PATH = restricted;
      const missing = run(script, f, 0, shell);
      expect(missing.status).toBe(0);
      expect(missing.events.at(-1)).toMatchObject({
        verdict: "allow",
        reason: "unspecified",
      });
      expect(missing.events.some((event) => event.verdict === "gate-started")).toBe(false);
    });

    it.each(
      ["source", "codex"].flatMap((placement) =>
        HOOK_SHELLS.map((shell) => [placement, shell] as const),
      ),
    )(`${id} %s/%s: handled signal has no false terminal`, (placement, shell) => {
      const f = fixture(id);
      const script =
        placement === "source"
          ? join(f.root, "hook.sh")
          : resolve(`../../.codex/scripts/check-${id}.sh`);
      if (placement === "source") {
        writeFileSync(script, renderScript(id, rel, BASE));
        chmodSync(script, 0o755);
      }
      f.env.SCAN_SIGNAL = "TERM";
      const killed = run(script, f, 0, shell);
      expect(killed.events.map((event) => event.verdict)).toEqual(["gate-started", "gate-killed"]);
      expect(killed.status).not.toBe(0);
    });

    it.each(
      ["source", "codex"].flatMap((placement) =>
        HOOK_SHELLS.map((shell) => [placement, shell] as const),
      ),
    )(`${id} %s/%s: SIGKILL preserves only start witness`, (placement, shell) => {
      const f = fixture(id);
      const script =
        placement === "source"
          ? join(f.root, "hook.sh")
          : resolve(`../../.codex/scripts/check-${id}.sh`);
      if (placement === "source") {
        writeFileSync(script, renderScript(id, rel, BASE));
        chmodSync(script, 0o755);
      }
      f.env.SCAN_SIGNAL = "KILL";
      const killed = run(script, f, 0, shell);
      expect(killed.events.map((event) => event.verdict)).toEqual(["gate-started"]);
      expect(killed.status).not.toBe(0);
    });
  }

  it.each(
    ["source", "codex"].flatMap((placement) =>
      HOOK_SHELLS.map((shell) => [placement, shell] as const),
    ),
  )("jscpd %s/%s: cleanup failure cannot alter scanner decision", (placement, shell) => {
    const f = fixture("jscpd");
    const script =
      placement === "source"
        ? join(f.root, "hook.sh")
        : resolve("../../.codex/scripts/check-jscpd.sh");
    if (placement === "source") {
      writeFileSync(script, renderScript("jscpd", "scripts/check-jscpd.sh", BASE));
      chmodSync(script, 0o755);
    }
    const fakeRm = join(f.root, "bin", "rm");
    writeFileSync(fakeRm, "#!/bin/sh\nexit 1\n");
    chmodSync(fakeRm, 0o755);
    const blocked = run(script, f, 1, shell);
    expect(blocked.status).toBe(2);
    expect(blocked.events.at(-1)?.verdict).toBe("block");
    const clean = run(script, f, 0, shell);
    expect(clean.status).toBe(0);
    expect(clean.events.at(-1)?.verdict).toBe("allow");
    expect(clean.events.at(-1)?.reason).toBe("unspecified");
  });

  it.each(
    ["source", "codex"].flatMap((placement) =>
      HOOK_SHELLS.map((shell) => [placement, shell] as const),
    ),
  )("jscpd %s/%s: unsupported flags block without claiming clones", (placement, shell) => {
    const f = fixture("jscpd");
    const script =
      placement === "source"
        ? join(f.root, "hook.sh")
        : resolve("../../.codex/scripts/check-jscpd.sh");
    if (placement === "source") {
      writeFileSync(script, renderScript("jscpd", "scripts/check-jscpd.sh", BASE));
      chmodSync(script, 0o755);
    }
    f.env.SCAN_NO_FLAGS = "1";
    const result = run(script, f, 0, shell);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("not a duplication verdict");
    expect(result.events.at(-1)).toMatchObject({
      verdict: "block",
      reason: "unspecified",
    });
    expect(result.events.some((event) => event.verdict === "gate-started")).toBe(false);
  });

  // Covers: A4 — inside a `git commit` hook GIT_INDEX_FILE is the commit's index; the
  // scanner's own `git worktree add` must never inherit it and overwrite it.
  it("jscpd never lets its baseline checkout write the caller's GIT_INDEX_FILE", () => {
    const f = fixture("jscpd");
    const script = join(f.root, "hook.sh");
    writeFileSync(script, renderScript("jscpd", "scripts/check-jscpd.sh", BASE));
    chmodSync(script, 0o755);
    execFileSync("git", ["add", "-A"], { cwd: f.repo });
    const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
      cwd: f.repo,
      encoding: "utf-8",
    }).trim();
    const indexCopy = join(f.root, "commit-index");
    writeFileSync(indexCopy, readFileSync(join(gitDir, "index")));
    const staged = () =>
      execFileSync("git", ["ls-files", "-s"], {
        cwd: f.repo,
        encoding: "utf-8",
        env: { ...process.env, GIT_INDEX_FILE: indexCopy },
      });
    const before = staged();
    const result = spawnSync(resolveBin("bash"), [script], {
      cwd: f.repo,
      env: {
        ...f.env,
        GIT_INDEX_FILE: indexCopy,
        GIT_DIR: gitDir,
        SCAN_WORKTREE: join(f.root, "baseline-checkout"),
      },
      encoding: "utf-8",
      input: JSON.stringify({
        session_id: "spec0037",
        tool_use_id: "scan",
        cwd: f.repo,
        tool_input: { command: "git commit -m fixture" },
      }),
    });
    expect(result.status).toBe(0);
    expect(existsSync(join(f.root, "baseline-checkout", "changed.ts"))).toBe(true);
    expect(staged()).toBe(before);
  });
});

/**
 * Covers: R7 (spec 0017) — `SessionStart` joined the plugin hook contract so a
 * plugin can announce itself when a session opens. Mapping it to settings is the
 * generic path (`pluginHooksToClaudeShape`), so what needs pinning is the
 * COLLISION: the core context hook already owns that bucket, and a plugin entry
 * must land BESIDE it, never on top of it. Codex ignores plugin hooks by design
 * — pinned too, so the new event doesn't quietly start leaking into config.toml.
 */
describe("plugin hooks — SessionStart (spec 0017)", () => {
  const CONFIG = {
    name: "test",
    engines: ["claude", "codex"],
    preset: "custom",
    version: "1.0.0",
    language: "es",
    branchBase: "main",
    commits: "conventional-es",
  } as unknown as NavoriConfig;

  const PLUGIN_COMMAND = 'bash "$CLAUDE_PROJECT_DIR/.claude/scripts/session-fixture.sh"';
  // What settings.json registers for it: the same script behind the parse check.
  const REGISTERED_PLUGIN_COMMAND = claudeHookCommand(
    "SessionStart",
    ".claude/scripts/session-fixture.sh",
  );

  const sessionPlugin: LoadedPlugin = {
    manifest: {
      id: "session-fixture",
      name: "Session fixture",
      description: "A plugin that only ships a SessionStart hook.",
      version: "0.0.1",
      managed: [],
      invariants: [],
      hooks: [
        {
          event: "SessionStart",
          command: PLUGIN_COMMAND,
          timeout: 30,
          statusMessage: "navori/fixture: session",
        },
      ],
    } as unknown as LoadedPlugin["manifest"],
    packageRoot: "/tmp/fake",
    managedAssets: [],
    scriptAssets: [],
    skillAssets: [],
  };

  type HookBucket = { matcher?: string; hooks: Array<{ command: string }> };

  function sessionBuckets(plugins: LoadedPlugin[]): HookBucket[] {
    const hooks = buildClaudeSettings(CONFIG, plugins).hooks as Record<string, HookBucket[]>;
    return hooks.SessionStart ?? [];
  }

  it("adds the plugin's hook without displacing the core context hook", () => {
    const buckets = sessionBuckets([sessionPlugin]);
    const commands = buckets.flatMap((b) => b.hooks.map((h) => h.command));
    expect(commands.some((c) => c.includes("session-start-context.sh"))).toBe(true);
    expect(commands).toContain(REGISTERED_PLUGIN_COMMAND);

    // Separate buckets, not one merged blob: the core hook keeps its lifecycle
    // matcher, and the plugin's matcher-less entry neither inherits nor erases it.
    const core = buckets.find((b) => b.matcher === "startup|resume|clear|compact|fork");
    expect(core?.hooks.map((h) => h.command)).toEqual([
      expect.stringContaining("session-start-context.sh"),
    ]);
    const pluginBucket = buckets.find((b) => b.matcher === undefined);
    expect(pluginBucket?.hooks.map((h) => h.command)).toEqual([
      expect.stringContaining("model-advisor.sh"),
      REGISTERED_PLUGIN_COMMAND,
    ]);
  });

  it("leaves the codex render byte-identical (it consumes no plugin hooks)", () => {
    const withPlugin = buildCodexConfigToml(CONFIG, [sessionPlugin]);
    const without = buildCodexConfigToml(CONFIG, []);
    expect(withPlugin.body).toBe(without.body);
    expect(withPlugin.body).not.toContain("session-fixture.sh");
  });
});
