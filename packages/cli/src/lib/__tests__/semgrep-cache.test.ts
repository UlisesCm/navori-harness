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
import { getPluginPath } from "../bundled-assets.ts";
import { interpolate } from "../interpolate.ts";
import { expandHookIncludes } from "../hook-includes.ts";
import type { NavoriConfig } from "../config.ts";
import { acrossShells, type HookShell } from "./helpers/shells.ts";

/**
 * Content cache of the semgrep gate (#402).
 *
 * The gate fires on `git commit`, `git push` AND `gh pr create`, so one cycle
 * used to rescan byte-identical content three times (~4s each). The hook now
 * memoizes the fingerprint of the last GREEN scan in the per-worktree git dir.
 *
 * These tests drive the FULLY-RENDERED hook inside a real git repo with a stub
 * `semgrep` on PATH that appends one line per invocation to a log — so "did it
 * scan?" is counted, never inferred from timing. Every scenario runs under bash
 * AND zsh (#391) on its own throwaway repo, and the outcomes must agree.
 */

const runsBash = process.platform !== "win32";
// /usr/bin + /bin give the real git/date/ls the hook needs; the stub semgrep
// lands in a temp bin dir prepended to PATH.
const BASE_PATH = "/usr/bin:/bin";
const TRIGGERS = ["git commit -m x", "git push", "gh pr create --title x --body y"] as const;

/** Render the hook exactly as `navori render` does: inline the shared
 * `# navori:include` partials, then interpolate `{{shq:branchBase}}` (#249). */
function renderHook(branchBase = "main"): string {
  const src = resolve(getPluginPath("semgrep"), "scripts/check-semgrep.sh");
  const raw = expandHookIncludes(readFileSync(src, "utf-8"));
  return interpolate(raw, { branchBase, preset: "custom" } as unknown as NavoriConfig);
}

interface Repo {
  dir: string;
  binDir: string;
  /** One line per stub-semgrep invocation. */
  log: string;
  hook: string;
  marker: string;
}

/**
 * Build a throwaway repo whose working tree differs from `main` in one TS file,
 * with a stub `semgrep` that records every invocation and exits `scanExit`.
 * With `mutateDuringScan`, the stub also rewrites the file it is "scanning" —
 * the writer-vs-scan race the TOCTOU case needs.
 */
function setupRepo(scanExit: number, mutateDuringScan = false): Repo {
  const dir = mkdtempSync(join(tmpdir(), "navori-semgrep-cache-"));
  const git = (...args: string[]): void => {
    execFileSync(
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
      { cwd: dir, stdio: "pipe" },
    );
  };
  git("init", "-q");
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  git("add", "a.ts");
  git("commit", "-q", "--no-verify", "-m", "base");
  // `git init -b main` needs git >= 2.28; renaming after the first commit works
  // on every version the harness supports.
  git("branch", "-M", "main");
  // The scanned diff: an uncommitted edit vs the base branch.
  writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");

  const binDir = join(dir, "fakebin");
  mkdirSync(binDir);
  const log = join(dir, "semgrep-invocations.log");
  const stub = join(binDir, "semgrep");
  const race = mutateDuringScan
    ? `printf 'export const a = 99;\\n' > ${JSON.stringify(join(dir, "a.ts"))}\n`
    : "";
  writeFileSync(
    stub,
    `#!/usr/bin/env bash\nprintf 'run\\n' >> ${JSON.stringify(log)}\n${race}exit ${scanExit}\n`,
  );
  chmodSync(stub, 0o755);

  const hook = join(dir, "hook.sh");
  writeFileSync(hook, renderHook());
  chmodSync(hook, 0o755);

  return { dir, binDir, log, hook, marker: join(dir, ".git", "navori-semgrep-ok") };
}

interface HookRun {
  status: number | null;
  /** The hook reached the scan (or at least announced it). */
  scanned: boolean;
  /** The hook short-circuited on the content cache. */
  cacheHit: boolean;
}

function runHook(repo: Repo, shell: HookShell, command: string): HookRun {
  const r = spawnSync(shell, [repo.hook], {
    cwd: repo.dir,
    input: JSON.stringify({ tool_input: { command } }),
    encoding: "utf-8",
    env: { PATH: `${repo.binDir}:${BASE_PATH}` },
  });
  return {
    status: r.status,
    scanned: r.stderr.includes("modificados vs"),
    cacheHit: r.stderr.includes("diff unchanged since last green scan"),
  };
}

/** How many times the stub semgrep actually ran. */
function scanCount(repo: Repo): number {
  return existsSync(repo.log) ? readFileSync(repo.log, "utf-8").trimEnd().split("\n").length : 0;
}

describe.runIf(runsBash)("semgrep gate — content cache (#402)", () => {
  it("scans exactly once across commit → push → gh pr create on the same diff", () => {
    const out = acrossShells((shell) => {
      const repo = setupRepo(0);
      const runs = TRIGGERS.map((command) => runHook(repo, shell, command));
      return { runs, scans: scanCount(repo), marker: existsSync(repo.marker) };
    });

    expect(out.scans).toBe(1);
    expect(out.runs.map((r) => r.status)).toEqual([0, 0, 0]);
    // First trigger scans; the two that follow ride the marker.
    expect(out.runs[0]).toMatchObject({ scanned: true, cacheHit: false });
    expect(out.runs[1]).toMatchObject({ scanned: false, cacheHit: true });
    expect(out.runs[2]).toMatchObject({ scanned: false, cacheHit: true });
    expect(out.marker).toBe(true);
  });

  it("rescans when a file in the diff changes between invocations", () => {
    const out = acrossShells((shell) => {
      const repo = setupRepo(0);
      const first = runHook(repo, shell, "git commit -m x");
      writeFileSync(join(repo.dir, "a.ts"), "export const a = 3;\n");
      const second = runHook(repo, shell, "git push");
      return { first, second, scans: scanCount(repo) };
    });

    expect(out.scans).toBe(2);
    expect(out.first).toMatchObject({ scanned: true, cacheHit: false });
    expect(out.second).toMatchObject({ scanned: true, cacheHit: false });
  });

  it("rescans when a NEW file joins the diff (cache keyed on the scanned set)", () => {
    const out = acrossShells((shell) => {
      const repo = setupRepo(0);
      const first = runHook(repo, shell, "git commit -m x");
      writeFileSync(join(repo.dir, "b.ts"), "export const b = 1;\n");
      execFileSync("git", ["add", "b.ts"], { cwd: repo.dir, stdio: "pipe" });
      const second = runHook(repo, shell, "git push");
      return { first, second, scans: scanCount(repo) };
    });

    expect(out.scans).toBe(2);
    expect(out.second).toMatchObject({ scanned: true, cacheHit: false });
  });

  it("does NOT cache a red scan — the retry rescans the same content", () => {
    const out = acrossShells((shell) => {
      const repo = setupRepo(1);
      const first = runHook(repo, shell, "git commit -m x");
      const second = runHook(repo, shell, "git commit -m x");
      return { first, second, scans: scanCount(repo), marker: existsSync(repo.marker) };
    });

    expect(out.scans).toBe(2);
    // semgrep's exit code still reaches the caller — the gate keeps blocking.
    expect(out.first.status).toBe(1);
    expect(out.second).toMatchObject({ status: 1, scanned: true, cacheHit: false });
    expect(out.marker).toBe(false);
  });

  // The fingerprint is taken BEFORE the scan, so a writer racing that window
  // (format-on-save, a watch build, a second agent in the same worktree) can
  // have semgrep read content B while the pre-scan fingerprint describes
  // content A. Reverting to A afterwards leaves bytes semgrep NEVER opened: a
  // marker earned by that run would hand them a green they never passed.
  it("does NOT cache when a scanned file changes during the scan (TOCTOU)", () => {
    const out = acrossShells((shell) => {
      const repo = setupRepo(0, true);
      const preScan = readFileSync(join(repo.dir, "a.ts"), "utf-8");
      const first = runHook(repo, shell, "git commit -m x");
      const raced = readFileSync(join(repo.dir, "a.ts"), "utf-8");
      writeFileSync(join(repo.dir, "a.ts"), preScan);
      const second = runHook(repo, shell, "git push");
      return { raced, first, second, scans: scanCount(repo), marker: existsSync(repo.marker) };
    });

    // The stub really did win the race — otherwise the case passes vacuously.
    expect(out.raced).toBe("export const a = 99;\n");
    expect(out.first).toMatchObject({ scanned: true, cacheHit: false });
    expect(out.second).toMatchObject({ scanned: true, cacheHit: false });
    expect(out.scans).toBe(2);
    expect(out.marker).toBe(false);
  });

  // The scan arguments (`--config=p/default`, `--error`) are constants inside
  // the hook, so the hook's own bytes are part of the fingerprint: a re-render
  // that tightens the ruleset must not inherit a marker earned under the old one.
  it("rescans when the hook script's own bytes change (re-rendered ruleset)", () => {
    const out = acrossShells((shell) => {
      const repo = setupRepo(0);
      const first = runHook(repo, shell, "git commit -m x");
      writeFileSync(repo.hook, `${readFileSync(repo.hook, "utf-8")}\n# tightened ruleset\n`);
      const second = runHook(repo, shell, "git push");
      return { first, second, scans: scanCount(repo) };
    });
    expect(out.first).toMatchObject({ scanned: true, cacheHit: false });
    expect(out.second).toMatchObject({ scanned: true, cacheHit: false });
    expect(out.scans).toBe(2);
  });

  // The fingerprint cannot see the registry rules behind `p/default`, so the
  // marker expires; a timestamp in the future (clock skew, restored backup)
  // must not buy an unbounded skip either.
  it("rescans when the marker is older than the TTL, or dated in the future", () => {
    const restamp = (repo: Repo, ts: number): void => {
      const [key] = readFileSync(repo.marker, "utf-8").trim().split(" ");
      writeFileSync(repo.marker, `${key} ${ts}\n`);
    };
    const out = acrossShells((shell) => {
      const repo = setupRepo(0);
      runHook(repo, shell, "git commit -m x");
      restamp(repo, Math.floor(Date.now() / 1000) - 2 * 3600);
      const expired = runHook(repo, shell, "git push");
      restamp(repo, Math.floor(Date.now() / 1000) + 2 * 3600);
      const future = runHook(repo, shell, "git push");
      return { expired, future, scans: scanCount(repo) };
    });

    expect(out.scans).toBe(3);
    expect(out.expired).toMatchObject({ scanned: true, cacheHit: false });
    expect(out.future).toMatchObject({ scanned: true, cacheHit: false });
  });
});
