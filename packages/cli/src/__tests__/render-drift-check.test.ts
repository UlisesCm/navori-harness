import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * #421 — the harness-mirror drift guard (`bun check:render` → this repo's
 * `scripts/js/check-render.mjs`).
 *
 * navori dogfoods itself: `.claude/` + `CLAUDE.md` here are RENDER OUTPUT. When
 * a managed asset changes in `@navori/core` and nobody re-renders, the mirror
 * keeps running the previous version — in #420 that meant hook scripts without
 * the zsh portability fix of #391, for a full day, with every check green.
 *
 * These tests pin BOTH directions of the guard, because each failure mode is a
 * real regression:
 *   - stale mirror  → non-zero exit + the exact command that fixes it,
 *   - fresh mirror  → zero, so the check never becomes permanent noise,
 *   - broken run    → non-zero (a check that can't run must be RED, not green).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "..", "dist", "index.js");
const CHECK_SCRIPT = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "scripts",
  "js",
  "check-render.mjs",
);

/** Throwaway HOME so `init` can't self-register into the real ~/.navori. */
const E2E_HOME = mkdtempSync(join(tmpdir(), "navori-drift-home-"));
afterAll(() => {
  rmSync(E2E_HOME, { recursive: true, force: true });
});

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  combined: string;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = {}): RunResult {
  const r = spawnSync(process.execPath, [command, ...args], {
    encoding: "utf-8",
    env: { ...process.env, HOME: E2E_HOME, NO_COLOR: "1", ...env },
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    combined: (r.stdout ?? "") + (r.stderr ?? ""),
  };
}

const runCli = (args: string[]): RunResult => run(CLI, args);
const runCheck = (repo: string, env: NodeJS.ProcessEnv = {}): RunResult =>
  run(CHECK_SCRIPT, ["--cwd", repo], env);

/** Run fixture Git operations without inheriting a host checkout or index. */
function fixtureGit(repo: string, args: string[]): void {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]: [string, string | undefined]): boolean => !key.startsWith("GIT_"),
    ),
  );
  expect(spawnSync("git", args, { cwd: repo, env, encoding: "utf-8" }).status).toBe(0);
}

/**
 * Simulate "the core moved, the mirror didn't": drift the `source=` provenance
 * of the FIRST managed block in `file`. The block's content still matches its
 * own hash (so it reads as pristine, not hand-edited) but its metadata differs
 * from what the core renders — exactly what makes `injectManagedSection` report
 * `updated` instead of `unchanged`. (A version stamp alone no longer counts:
 * an identical body keeps its last-change version, #1262.)
 */
function driftBlockMetadata(file: string): void {
  const before = readFileSync(file, "utf-8");
  const after = before.replace(/source="[^"]+"/, 'source="@navori/drifted"');
  expect(after).not.toBe(before);
  writeFileSync(file, after, "utf-8");
}

let dirs: string[] = [];

function seedRenderedRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "navori-drift-"));
  dirs.push(repo);
  const init = runCli(["init", "--recommended", "--cwd", repo]);
  expect(init.status).toBe(0);
  return repo;
}

/** Model a clean checkout where ignored local progress has never been created. */
function seedMissingLocalProgress(): string {
  const repo: string = seedRenderedRepo();
  fixtureGit(repo, ["init", "--quiet"]);
  const ignore: string = join(repo, ".gitignore");
  writeFileSync(ignore, `${existsSync(ignore) ? readFileSync(ignore, "utf-8") : ""}\n/progress/\n`);
  for (const path of ["progress/current.md", "progress/history.md"]) {
    rmSync(join(repo, path), { force: true });
  }
  return repo;
}

describe("check-render — harness mirror drift guard (#421)", () => {
  beforeAll(() => {
    if (!existsSync(CLI)) {
      throw new Error(`CLI not built at ${CLI}. Run 'bun run build' before tests.`);
    }
    if (!existsSync(CHECK_SCRIPT)) {
      throw new Error(`check script missing at ${CHECK_SCRIPT}`);
    }
  });

  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
    dirs = [];
  });

  it("exits 0 on a freshly rendered mirror (so the check can't become noise)", () => {
    const repo = seedRenderedRepo();

    const check = runCheck(repo);
    expect(check.status).toBe(0);
    expect(check.stdout).toContain("up to date");
  });

  it("permits absent ignored local progress in a clean checkout without creating it", () => {
    const repo: string = seedMissingLocalProgress();
    const check: RunResult = runCheck(repo);
    expect(check.status, check.combined).toBe(0);
    for (const path of ["progress/current.md", "progress/history.md"]) {
      expect(existsSync(join(repo, path))).toBe(false);
    }
  });

  it("does not exempt absent progress unless Git confirms it is ignored", () => {
    const repo: string = seedMissingLocalProgress();
    writeFileSync(join(repo, ".gitignore"), "");
    const check: RunResult = runCheck(repo);
    expect(check.status).toBe(1);
    expect(check.combined).toContain("progress/current.md");
  });

  it("does not exempt tracked-but-missing progress even when an ignore rule matches", () => {
    const repo: string = seedMissingLocalProgress();
    const path: string = join(repo, "progress/current.md");
    writeFileSync(path, "fixture local state\n");
    fixtureGit(repo, ["add", "--force", "--", "progress/current.md"]);
    rmSync(path);
    const check: RunResult = runCheck(repo);
    expect(check.status).toBe(1);
    expect(check.combined).toContain("progress/current.md");
  });

  it("fails closed for ignored absent progress outside a Git repository", () => {
    const repo: string = seedMissingLocalProgress();
    rmSync(join(repo, ".git"), { recursive: true });
    expect(runCheck(repo).status).toBe(1);
  });

  it("fails closed when the Git verification command cannot run", () => {
    const repo: string = seedMissingLocalProgress();
    const check: RunResult = runCheck(repo, { PATH: "" });
    expect(check.status).toBe(1);
    expect(check.combined).toContain("progress/current.md");
  });

  it("ignores inherited Git checkout overrides when confirming local progress", () => {
    const repo: string = seedMissingLocalProgress();
    expect(
      runCheck(repo, { GIT_DIR: join(repo, "missing-git-dir"), GIT_INDEX_FILE: "/missing-index" })
        .status,
    ).toBe(0);
  });

  it("still rejects an ignored stale hook alongside ignored absent progress", () => {
    const repo: string = seedMissingLocalProgress();
    const ignore: string = join(repo, ".gitignore");
    writeFileSync(ignore, `${readFileSync(ignore, "utf-8")}\n/.claude/hooks/\n`);
    const hook: string = join(repo, ".claude/hooks/guard-destructive.sh");
    driftBlockMetadata(hook);
    const before: string = readFileSync(hook, "utf-8");
    const check: RunResult = runCheck(repo);
    expect(check.status).toBe(1);
    expect(check.combined).toContain(".claude/hooks/guard-destructive.sh");
    expect(readFileSync(hook, "utf-8")).toBe(before);
  });

  it("does not exempt another ignored file that render would create", () => {
    const repo: string = seedMissingLocalProgress();
    const ignore: string = join(repo, ".gitignore");
    writeFileSync(ignore, `${readFileSync(ignore, "utf-8")}\n/.claude/hooks/\n`);
    const hook: string = join(repo, ".claude/hooks/guard-destructive.sh");
    rmSync(hook);
    const check: RunResult = runCheck(repo);
    expect(check.status).toBe(1);
    expect(check.combined).toContain(".claude/hooks/guard-destructive.sh");
    expect(existsSync(hook)).toBe(false);
  });

  it("exits non-zero when a rendered hook is a release behind the core", () => {
    const repo = seedRenderedRepo();
    const hook = join(repo, ".claude/hooks/guard-destructive.sh");
    driftBlockMetadata(hook);
    const beforeCheck = readFileSync(hook, "utf-8");

    const check = runCheck(repo);
    expect(check.status).toBe(1);
    expect(check.combined).toContain("OUT OF DATE");
    // Names the stale file AND the exact command that fixes it — a check that
    // only says "failed" reproduces the problem it exists to solve.
    expect(check.combined).toContain(".claude/hooks/guard-destructive.sh");
    expect(check.combined).toContain("render --apply");
    // …and the command it names must carry the BUILD half. Naming the bare
    // binary is what taught the build-less chain in the first place: the CLI
    // reads dist/assets/core, a build-time copy, so without a rebuild the fix
    // compares against the old assets and silently does nothing (or reverts).
    expect(check.combined).toContain("bun run --filter navori build && node");
    expect(check.combined).toContain("bun run render:apply");
    // The guard previews: it must never write while auditing.
    expect(readFileSync(hook, "utf-8")).toBe(beforeCheck);
  });

  it("exits non-zero when a CLAUDE.md managed block is stale, naming the block", () => {
    const repo = seedRenderedRepo();
    driftBlockMetadata(join(repo, "CLAUDE.md"));

    const check = runCheck(repo);
    expect(check.status).toBe(1);
    expect(check.combined).toContain("CLAUDE.md");
    expect(check.combined).toContain("stale CLAUDE.md blocks");
  });

  it("exits non-zero when render refuses to overwrite a hand-edited block", () => {
    const repo = seedRenderedRepo();
    const hook = join(repo, ".claude/hooks/guard-destructive.sh");
    // Edit INSIDE the managed block without fixing the hash → render skips it
    // (never clobbers a hand-edit), so it would be invisible to a pending-only
    // check even though the mirror no longer matches the core.
    //
    // Not a synthetic case: with parallel asset PRs, two branches conflict in
    // the same rendered files, and resolving that conflict by hand is exactly
    // how a real block ends up hand-edited (#435). Keep this case.
    const edited = readFileSync(hook, "utf-8").replace("set -euo pipefail", "set -eu");
    writeFileSync(hook, edited, "utf-8");

    const check = runCheck(repo);
    expect(check.status).toBe(1);
    expect(check.combined).toContain("refuses to overwrite");
    expect(check.combined).toContain(".claude/hooks/guard-destructive.sh");
  });

  it("is RED (never a silent pass) when the render itself fails", () => {
    const repo = mkdtempSync(join(tmpdir(), "navori-drift-noconfig-"));
    dirs.push(repo);

    const check = runCheck(repo);
    expect(check.status).toBe(1);
    expect(check.combined).toContain("render failed");
    expect(check.combined).toContain("config-missing");
  });

  it("render --json exposes the per-file plan the guard reads (#421 contract)", () => {
    const repo = seedRenderedRepo();
    driftBlockMetadata(join(repo, ".claude/hooks/guard-destructive.sh"));

    const r = runCli(["render", "--json", "--cwd", repo]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.pending).toBe(true);
    expect(Array.isArray(parsed.root.written)).toBe(true);
    expect(Array.isArray(parsed.root.skipped)).toBe(true);
    expect(parsed.root.written.map((w: { path: string }) => w.path)).toContain(
      ".claude/hooks/guard-destructive.sh",
    );
  });
});

/**
 * The re-render command this repo DOCUMENTS must be the one that works.
 *
 * `render` reads `packages/cli/dist/assets/core`, a build-time copy, so the bare
 * `node packages/cli/dist/index.js render --apply` compares against whatever the
 * last build captured: it answers `unchanged` over a mirror that is genuinely
 * stale and, in the reverse direction, rewrites the mirror BACKWARDS. Measured
 * on `main` @ 416d39e: 4 files would have been reverted, dropping the
 * `### Always-on delta` section of #480 and the engram block of #401.
 *
 * `bun check:render` already chains the build (`package.json`); the fix is that
 * the WRITE side gets the same treatment as a named script, so it can't be
 * copy-pasted half.
 */
describe("the documented re-render command always carries its build (#421 follow-up)", () => {
  const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
  const readRoot = (file: string): string => readFileSync(join(REPO_ROOT, file), "utf-8");

  it("exposes `render:apply` as a script, symmetric to `check:render`", () => {
    const pkg = JSON.parse(readRoot("package.json")) as { scripts?: Record<string, string> };
    const renderApply = pkg.scripts?.["render:apply"];

    expect(renderApply, "root package.json must define a `render:apply` script").toBeDefined();
    expect(renderApply).toContain("bun run --filter navori build");
    expect(renderApply).toContain("render --apply");
    // The build must come FIRST; the whole defect is rendering before building.
    expect((renderApply as string).indexOf("build")).toBeLessThan(
      (renderApply as string).indexOf("render --apply"),
    );
    expect(pkg.scripts?.["check:render"]).toContain("bun run --filter navori build");
  });

  it("never documents the build-less binary invocation", () => {
    // The exact string that taught the broken chain (was CONTRIBUTING.md:26).
    const BUILDLESS = "node packages/cli/dist/index.js render --apply";
    for (const file of ["CONTRIBUTING.md", "README.md"]) {
      const offenders = readRoot(file)
        .split("\n")
        .filter(
          (line) => line.includes(BUILDLESS) && !line.includes("bun run --filter navori build"),
        );
      expect(offenders, `${file} teaches a render --apply with no build`).toEqual([]);
    }
  });
});
