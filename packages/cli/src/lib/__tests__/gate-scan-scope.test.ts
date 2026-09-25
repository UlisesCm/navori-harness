import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getPluginPath } from "../render/bundled-assets.ts";
import { interpolate } from "../render/interpolate.ts";
import { expandHookIncludes } from "../render/hook-includes.ts";
import type { NavoriConfig } from "../config/config.ts";
import { acrossShells, type HookShell } from "./helpers/shells.ts";

/**
 * Scan scope of the diff-scanning gate hooks (#777).
 *
 * Two holes made the security layer report green over code it never read:
 *
 *  1. **Untracked files were invisible.** The file list came from `git diff`
 *     alone, so a file that was never `git add`-ed did not appear. The hooks are
 *     `PreToolUse`, so with `git add new.ts && git commit -m x` in ONE Bash call
 *     — the batching the harness itself recommends in auto mode — `new.ts` is
 *     still untracked at scan time. The gate printed `0 files to scan` and the
 *     file landed unread. jscpd was the severe case: it fires only on commit, so
 *     it never got the second chance semgrep gets on push.
 *  2. **The baseline was the LOCAL ref**, with no freshness guarantee. An agent
 *     worktree is born from whatever `main` pointed at and never moves, so the
 *     diff against it includes files other PRs merged meanwhile — the scan
 *     blocks on findings that are not this diff's, or accepts as "already at the
 *     baseline" something this diff introduces.
 *
 * Both are driven here against the FULLY-RENDERED hooks in real git repos, with
 * a stub scanner that LOGS the paths it received — so "was this file scanned?"
 * is read off the scanner's own arguments, never inferred from an exit code.
 * Every scenario runs under bash AND zsh (#391).
 */

const runsBash = process.platform !== "win32";
/** /usr/bin + /bin give the real git/date/ls/mktemp the hooks need. */
const BASE_PATH = "/usr/bin:/bin";

const GATES = [
  { id: "semgrep", rel: "scripts/check-semgrep.sh", bin: "semgrep" },
  { id: "jscpd", rel: "scripts/check-jscpd.sh", bin: "jscpd" },
] as const;

type GateId = (typeof GATES)[number]["id"];

/** Render a hook exactly as `navori render` does: inline the `# navori:include`
 * partials, then interpolate the `{{shq:…}}` markers (#249). */
function renderHook(rel: string, branchBase = "main"): string {
  const src = resolve(getPluginPath(rel.includes("semgrep") ? "semgrep" : "jscpd"), rel);
  const raw = expandHookIncludes(readFileSync(src, "utf-8"));
  return interpolate(raw, { branchBase, preset: "custom" } as unknown as NavoriConfig, {
    extraVars: { jscpdThreshold: "10" },
  });
}

interface Fixture {
  dir: string;
  binDir: string;
  /** One line per scanner invocation: the file arguments it received. */
  argsLog: string;
  hook: string;
}

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.email=t@navori.test",
      "-c",
      "user.name=navori",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, stdio: "pipe", encoding: "utf-8" },
  );
}

/**
 * A stub scanner that appends the *.ts arguments it was handed to `argsLog` and
 * exits `scanExit`. Both real tools take flags before the file list, so the stub
 * filters to the paths — what the assertions are about.
 *
 * Answers `--help` with both flags jscpd's capability probe checks for (#1060):
 * only jscpd calls `--help`, but answering it here for both tools is harmless
 * and keeps this one stub shared.
 */
function installStub(binDir: string, name: string, argsLog: string, scanExit: number): void {
  const stub = join(binDir, name);
  writeFileSync(
    stub,
    `#!/usr/bin/env bash
if [ "\${1:-}" = "--help" ]; then
  printf '%s\\n' "--baseline-from-ref --fail-on-new-clones"
  exit 0
fi
for a in "$@"; do case "$a" in *.ts|*.tsx) printf '%s\\n' "$a" >> ${JSON.stringify(argsLog)} ;; esac; done
exit ${scanExit}
`,
  );
  chmodSync(stub, 0o755);
}

/** Shared skeleton: a repo on `main` with one committed file. */
function newFixture(gate: GateId, scanExit: number, branchBase = "main"): Fixture {
  const dir = mkdtempSync(join(tmpdir(), `navori-scan-scope-${gate}-`));
  gitIn(dir, "init", "-q");
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  gitIn(dir, "add", "a.ts");
  gitIn(dir, "commit", "-q", "--no-verify", "-m", "base");
  gitIn(dir, "branch", "-M", "main");

  const binDir = join(dir, "fakebin");
  mkdirSync(binDir);
  const argsLog = join(dir, "scanned-paths.log");
  const spec = GATES.find((g) => g.id === gate);
  if (!spec) throw new Error(`unknown gate ${gate}`);
  installStub(binDir, spec.bin, argsLog, scanExit);

  const hook = join(dir, "hook.sh");
  writeFileSync(hook, renderHook(spec.rel, branchBase));
  chmodSync(hook, 0o755);

  return { dir, binDir, argsLog, hook };
}

interface HookRun {
  status: number | null;
  /**
   * Raw stderr — useful INSIDE an `acrossShells` callback, never as part of its
   * result: it carries the fixture's mkdtemp path and commit shas, and every
   * shell gets its own fixture, so returning it would report a divergence on
   * every run. Return a derived boolean instead.
   */
  stderr: string;
  /** Paths the stub scanner actually received, sorted. */
  scanned: string[];
}

function runHook(fx: Fixture, shell: HookShell, command: string, cwd = fx.dir): HookRun {
  const r = spawnSync(shell, [fx.hook], {
    cwd,
    input: JSON.stringify({ tool_input: { command }, cwd }),
    encoding: "utf-8",
    env: { PATH: `${fx.binDir}:${BASE_PATH}`, NO_COLOR: "1" },
  });
  const scanned = existsSync(fx.argsLog)
    ? readFileSync(fx.argsLog, "utf-8").trim().split("\n").filter(Boolean).sort()
    : [];
  return { status: r.status, stderr: r.stderr, scanned };
}

/** The shell-independent half of a run — safe to return from `acrossShells`. */
function verdict(r: HookRun): { status: number | null; scanned: string[] } {
  return { status: r.status, scanned: r.scanned };
}

describe.runIf(runsBash)("gate scans see untracked files (#777)", () => {
  for (const { id } of GATES) {
    /**
     * The exact payload from the issue: `git add` and `git commit` batched into
     * one Bash call, which is what the hook sees BEFORE either runs. The file is
     * untracked at scan time — and it carries the finding.
     */
    it(`${id}: scans a new untracked file in a batched \`git add … && git commit\``, () => {
      const out = acrossShells((shell) => {
        // exit 1 = "finding / over threshold" for both tools.
        const fx = newFixture(id, 1);
        writeFileSync(join(fx.dir, "new.ts"), "export const secret = 'x';\n");
        return verdict(runHook(fx, shell, "git add new.ts && git commit -m x"));
      });

      expect(out.scanned).toContain("new.ts");
      // Exit 2 is the ONLY code PreToolUse treats as a block (#510).
      expect(out.status).toBe(2);
    });

    it(`${id}: an untracked file joins the tracked diff, both are scanned`, () => {
      const out = acrossShells((shell) => {
        const fx = newFixture(id, 0);
        writeFileSync(join(fx.dir, "a.ts"), "export const a = 2;\n");
        writeFileSync(join(fx.dir, "new.ts"), "export const b = 1;\n");
        return verdict(runHook(fx, shell, "git commit -m x"));
      });

      expect(out.scanned).toEqual(["a.ts", "new.ts"]);
      expect(out.status).toBe(0);
    });

    it(`${id}: an untracked file that is not TS/TSX stays out of the scan`, () => {
      const out = acrossShells((shell) => {
        const fx = newFixture(id, 0);
        writeFileSync(join(fx.dir, "a.ts"), "export const a = 2;\n");
        writeFileSync(join(fx.dir, "notes.md"), "# notes\n");
        return verdict(runHook(fx, shell, "git commit -m x"));
      });

      expect(out.scanned).toEqual(["a.ts"]);
    });

    /** `--exclude-standard` — an ignored build artifact is not "new code". */
    it(`${id}: a gitignored untracked file stays out of the scan`, () => {
      const out = acrossShells((shell) => {
        const fx = newFixture(id, 0);
        writeFileSync(join(fx.dir, ".gitignore"), "generated/\n");
        writeFileSync(join(fx.dir, "a.ts"), "export const a = 2;\n");
        mkdirSync(join(fx.dir, "generated"));
        writeFileSync(join(fx.dir, "generated", "out.ts"), "export const g = 1;\n");
        return verdict(runHook(fx, shell, "git commit -m x"));
      });

      expect(out.scanned).toEqual(["a.ts"]);
    });
  }
});

/**
 * A repo whose LOCAL `main` is left behind while `origin/main` moves on — the
 * shape every agent worktree is born into. `merged.ts` arrives from another
 * change that already landed; `a.ts` is this diff's own edit.
 */
function staleBaseFixture(gate: GateId, scanExit = 0): Fixture {
  const fx = newFixture(gate, scanExit);
  const origin = join(mkdtempSync(join(tmpdir(), "navori-origin-")), "origin.git");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin], { stdio: "pipe" });
  gitIn(fx.dir, "remote", "add", "origin", origin);
  gitIn(fx.dir, "push", "-q", "origin", "main");

  // Another change lands on the remote's main. Local `main` is never moved —
  // exactly what "nobody pulled" and "the worktree was cut yesterday" look like.
  gitIn(fx.dir, "checkout", "-q", "-b", "feature");
  writeFileSync(join(fx.dir, "merged.ts"), "export const merged = 1;\n");
  gitIn(fx.dir, "add", "merged.ts");
  gitIn(fx.dir, "commit", "-q", "--no-verify", "-m", "someone else's PR");
  gitIn(fx.dir, "push", "-q", "origin", "feature:main");
  gitIn(fx.dir, "fetch", "-q", "origin");

  // This diff's own change, on top.
  writeFileSync(join(fx.dir, "a.ts"), "export const a = 2;\n");
  return fx;
}

describe.runIf(runsBash)("gate scans resolve the baseline against origin (#777)", () => {
  for (const { id } of GATES) {
    it(`${id}: a file merged into origin/main between cuts does NOT enter the scan`, () => {
      const out = acrossShells((shell) => {
        const fx = staleBaseFixture(id);
        return verdict(runHook(fx, shell, "git commit -m x"));
      });

      // Against the stale local `main`, `merged.ts` reads as added by this diff.
      expect(out.scanned).not.toContain("merged.ts");
      expect(out.scanned).toEqual(["a.ts"]);
      expect(out.status).toBe(0);
    });

    it(`${id}: says so on stderr when the local ref and origin disagree`, () => {
      const out = acrossShells((shell) => {
        const fx = staleBaseFixture(id);
        return runHook(fx, shell, "git commit -m x").stderr.includes("origin/main");
      });
      expect(out).toBe(true);
    });

    it(`${id}: falls back to the local ref when there is no origin (offline repo)`, () => {
      const out = acrossShells((shell) => {
        const fx = newFixture(id, 0);
        writeFileSync(join(fx.dir, "a.ts"), "export const a = 2;\n");
        return verdict(runHook(fx, shell, "git commit -m x"));
      });

      expect(out.scanned).toEqual(["a.ts"]);
      expect(out.status).toBe(0);
    });

    it(`${id}: skips cleanly when neither origin/<base> nor <base> exists`, () => {
      const out = acrossShells((shell) => {
        const fx = newFixture(id, 0, "nonexistent-base");
        writeFileSync(join(fx.dir, "a.ts"), "export const a = 2;\n");
        const r = runHook(fx, shell, "git commit -m x");
        return { ...verdict(r), namesTheBase: r.stderr.includes("nonexistent-base") };
      });

      expect(out.scanned).toEqual([]);
      expect(out.status).toBe(0);
      // A skip that does not say WHAT it could not resolve is the silent green
      // this whole layer exists to avoid.
      expect(out.namesTheBase).toBe(true);
    });

    /**
     * No network inside the hook, ever: it runs on every `git commit`, and a
     * fetch there would put a remote round-trip in front of each one. Freshness
     * comes from the reviewer's and the pilot's pre-flight, which do fetch.
     */
    it(`${id}: performs no fetch (the hook stays offline)`, () => {
      const src = readFileSync(resolve(getPluginPath(id), `scripts/check-${id}.sh`), "utf-8");
      const body = expandHookIncludes(src);
      expect(body).not.toMatch(/\bgit\s+(-\S+\s+\S+\s+)*fetch\b/);
      expect(body).not.toMatch(/\bgit\s+(-\S+\s+\S+\s+)*(pull|ls-remote)\b/);
    });
  }
});

/**
 * The cache marker (#402) is what makes the scan cheap enough to run BEFORE the
 * approval: once the quality gate has scanned these bytes against this base, the
 * commit hook must ride the marker instead of paying the scan again. Untracked
 * files are part of the fingerprint now — they are part of the scan, and a
 * fingerprint that ignored them would hand a green to bytes nobody read.
 */
describe.runIf(runsBash)("semgrep cache covers the untracked half (#777)", () => {
  it("the commit re-scan after a green gate run is a cache hit", () => {
    const out = acrossShells((shell) => {
      const fx = newFixture("semgrep", 0);
      writeFileSync(join(fx.dir, "new.ts"), "export const b = 1;\n");
      // The gate step runs the SAME script with no command — exactly what
      // `pnpm semgrep:check` does.
      const gate = runHook(fx, shell, "");
      const commit = runHook(fx, shell, "git commit -m x");
      return {
        gate: { status: gate.status, scanned: gate.scanned },
        commitHit: commit.stderr.includes("diff unchanged since last green scan"),
        // The stub logged once per invocation: still one run after both calls.
        totalScanned: commit.scanned,
      };
    });

    expect(out.gate.scanned).toEqual(["new.ts"]);
    expect(out.gate.status).toBe(0);
    expect(out.commitHit).toBe(true);
    expect(out.totalScanned).toEqual(["new.ts"]);
  });

  it("editing an untracked file invalidates the marker", () => {
    const out = acrossShells((shell) => {
      const fx = newFixture("semgrep", 0);
      writeFileSync(join(fx.dir, "new.ts"), "export const b = 1;\n");
      runHook(fx, shell, "git commit -m x");
      writeFileSync(join(fx.dir, "new.ts"), "export const b = 2;\n");
      const second = runHook(fx, shell, "git push");
      return {
        hit: second.stderr.includes("diff unchanged since last green scan"),
        scanned: second.scanned,
      };
    });

    expect(out.hit).toBe(false);
    // Scanned twice — the stub logs one line per invocation.
    expect(out.scanned).toEqual(["new.ts", "new.ts"]);
  });
});
