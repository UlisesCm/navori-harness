import { afterEach, describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { getPluginPath, getCoreRoot } from "../render/bundled-assets.ts";
import { interpolate } from "../render/interpolate.ts";
import { expandHookIncludes } from "../render/hook-includes.ts";
import type { NavoriConfig } from "../config/config.ts";
import { acrossShells, type HookShell } from "./helpers/shells.ts";

/** Per-test fixture dirs, removed by the top-level `afterEach` below. */
const tempDirs: string[] = [];

/** `mkdtemp` under tmpdir() (realpath'd, as git reports it) registered for per-test cleanup. */
function mkTemp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

// Keeps the file's single end-of-file rmSync (vitest.setup.ts) cheap: git fixtures are removed as
// they are used. Failed tests and NAVORI_KEEP_TEST_ARTIFACTS=1 retain them as evidence.
afterEach((ctx) => {
  const dirs = tempDirs.splice(0);
  if (ctx.task.result?.state === "fail" || process.env.NAVORI_KEEP_TEST_ARTIFACTS === "1") return;
  const root = realpathSync(tmpdir());
  for (const dir of dirs) {
    if (dir.startsWith(`${root}/`)) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * #454 — the gate hooks must scan the tree the COMMIT acts on.
 *
 * `settings.json` invokes them as
 * `bash "$CLAUDE_PROJECT_DIR/.claude/scripts/check-semgrep.sh"`, so the hook
 * process starts in the MAIN repo. When the commit happens inside an agent
 * worktree, the old `cd "$(git rev-parse --show-toplevel)"` landed in the main
 * repo — clean tree, `git diff --name-only main` → 0 files, "no changes vs
 * main", exit 0. A green that scanned nothing.
 *
 * Every case here therefore drives the hook the way settings.json does: process
 * cwd = the MAIN repo, and the worktree only reachable through the payload
 * (`.cwd`) or the command itself. The scanners are stubs on PATH that log their
 * argv, so "did it scan?" is counted, never inferred — and the suite never
 * depends on a real semgrep/jscpd being installed (both hooks skip silently
 * when the binary is absent, which would turn a broken gate green).
 */

const runsBash = process.platform !== "win32";
// /usr/bin + /bin give the real git/date/ls/sed the hooks need; the stubs land
// in a temp bin dir prepended to PATH.
const BASE_PATH = "/usr/bin:/bin";

/**
 * The HOOK's own exit code — a verdict — as `PreToolUse` defines it (#510).
 * DO NOT "restore" these to the scanner's codes: 2 is the contract, not a
 * regression.
 *
 * Claude Code blocks a tool call ONLY on exit 2; any other non-zero code is
 * shown and the call PROCEEDS. Until #510 these cases asserted `1`, which is
 * what the STUB exits with, and titled it "BLOCKS". That conflated two
 * different signals into one number: `1` only ever proved the hook REACHED the
 * scanner, never that the verdict blocked anything. With the gates passing the
 * scanner's code straight through, the suite ended up pinning the exact
 * contract they were violating — the gate shipped decorative and green.
 *
 * The two signals are now kept apart, and on purpose they are different
 * numbers: "did the scanner run?" is `invocations(fx).length`, "does the
 * verdict block?" is the hook's exit code. The same file already had the right
 * shape two assertions below, where the quality gate asserts 2 for a red gate.
 */
const HOOK_BLOCKS = 2;
/**
 * A scanner that fell over is NOT a verdict: nothing was validated, so the hook
 * reports it loudly and lets the call through rather than passing a tooling
 * failure off as a security decision.
 */
const HOOK_WARNS_WITHOUT_BLOCKING = 1;

type HookId = "semgrep" | "jscpd" | "quality-gate";

/** Render a hook exactly as `navori render` does: inline the shared
 * `# navori:include` partials, then interpolate the `{{shq:…}}` markers. */
function renderHook(id: HookId, qualityGateFast = "true"): string {
  const src =
    id === "quality-gate"
      ? resolve(getCoreRoot(), "core-assets/hooks/quality-gate-pre-commit.sh")
      : resolve(getPluginPath(id), `scripts/check-${id}.sh`);
  const raw = expandHookIncludes(readFileSync(src, "utf-8"));
  const config = {
    branchBase: "main",
    preset: "custom",
    qualityGate: { fast: qualityGateFast },
  } as unknown as NavoriConfig;
  return interpolate(raw, config, { extraVars: { jscpdThreshold: "10" } });
}

interface Fixture {
  /** The main repo — clean, on `main`. This is the hook process's cwd. */
  main: string;
  /** A linked worktree on a branch whose tree differs from `main`. */
  worktree: string;
  binDir: string;
  /** One line per stub invocation: the full argv. */
  log: string;
  hooks: Record<HookId, string>;
  baseSha: string;
  baseShort: string;
  /** A SECOND repository, unrelated to `main`. Set by `addForeignRepo`. */
  foreign?: string;
}

function git(cwd: string, ...args: string[]): string {
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
 * A main repo on `main` with a CLEAN tree, plus a linked worktree (outside the
 * main working tree, so its checkout cannot show up in the main repo's own
 * diff) carrying one changed `.ts` file. That asymmetry is the whole point: the
 * main repo has nothing to scan, the worktree does.
 *
 * `scanExit` is the SCANNER stub's exit code — the finding it seeds, not the
 * hook's verdict. The hook maps it (see `HOOK_BLOCKS`): 1 (findings) → 2, >1
 * (scanner broken) → 1, 0 → 0.
 */
function setupFixture(scanExit = 1): Fixture {
  // realpath, not the raw mkdtemp path: on macOS mkdtemp hands back `/var/…`
  // while git reports `/private/var/…`, and the hook's messages quote git's.
  const main = mkTemp("navori-454-main-");
  writeFileSync(join(main, "a.ts"), "export const a = 1;\n");
  git(main, "init", "-q");
  git(main, "add", "a.ts");
  git(main, "commit", "-q", "--no-verify", "-m", "base");
  // `git init -b main` needs git >= 2.28; renaming after the first commit works
  // on every version the harness supports.
  git(main, "branch", "-M", "main");
  const baseSha = git(main, "rev-parse", "main").trim();
  const baseShort = git(main, "rev-parse", "--short", baseSha).trim();

  const worktree = join(mkTemp("navori-454-wt-"), "wt");
  git(main, "worktree", "add", "-q", "-b", "feature", worktree, "main");
  // The diff the gate must see: it exists ONLY in the worktree.
  writeFileSync(join(worktree, "a.ts"), "export const a = 2;\n");

  const binDir = join(main, "fakebin");
  mkdirSync(binDir);
  const log = join(main, "invocations.log");
  for (const tool of ["semgrep", "jscpd"]) {
    const stub = join(binDir, tool);
    // jscpd's capability probe (#1060) calls `--help` before scanning; answer
    // it with both flags so it never intercepts the invocation these fixtures
    // count. Harmless for semgrep, which never calls it.
    const helpBranch =
      tool === "jscpd"
        ? `if [ "\${1:-}" = "--help" ]; then\n  printf '%s\\n' "--baseline-from-ref --fail-on-new-clones"\n  exit 0\nfi\n`
        : "";
    writeFileSync(
      stub,
      `#!/usr/bin/env bash\n${helpBranch}printf '%s %s\\n' ${JSON.stringify(tool)} "$*" >> ${JSON.stringify(log)}\nexit ${scanExit}\n`,
    );
    chmodSync(stub, 0o755);
  }

  const hooks = {} as Record<HookId, string>;
  for (const id of ["semgrep", "jscpd", "quality-gate"] as const) {
    const p = join(main, `${id}-hook.sh`);
    // The quality gate proves WHERE it ran: the marker file exists only in the
    // worktree, so a gate that runs in the main repo fails to read it.
    writeFileSync(p, renderHook(id, id === "quality-gate" ? "cat only-in-worktree.txt" : "true"));
    chmodSync(p, 0o755);
    hooks[id] = p;
  }
  writeFileSync(join(worktree, "only-in-worktree.txt"), "worktree\n");

  return { main, worktree, binDir, log, hooks, baseSha, baseShort };
}

/**
 * A second, independent repository — clean, on `main`, so a scan that lands
 * here finds nothing and exits 0. It is the "other tree" every bypass case
 * points the command at.
 */
function addForeignRepo(fx: Fixture): string {
  const foreign = mkTemp("navori-454-other-");
  writeFileSync(join(foreign, "b.ts"), "export const b = 1;\n");
  git(foreign, "init", "-q");
  git(foreign, "add", "b.ts");
  git(foreign, "commit", "-q", "--no-verify", "-m", "base");
  git(foreign, "branch", "-M", "main");
  fx.foreign = foreign;
  return foreign;
}

/**
 * Registers the foreign repo as a REAL submodule at `<main>/sub` and commits
 * it, so `main` is clean again. A submodule is its own working tree whose git
 * dir lives under `<main>/.git/modules/sub` — inside the superproject's `.git`,
 * yet not the same repository, which is why the check is exact equality and not
 * a path prefix. Advancing `main` moves the base, so the fixture's SHAs are
 * refreshed for `scrub`.
 */
function addSubmodule(fx: Fixture): string {
  const foreign = fx.foreign ?? addForeignRepo(fx);
  // Local-path submodules are refused by default since git 2.38 (CVE-2022-39253).
  git(fx.main, "-c", "protocol.file.allow=always", "submodule", "add", "-q", foreign, "sub");
  git(fx.main, "commit", "-q", "--no-verify", "-m", "add submodule");
  fx.baseSha = git(fx.main, "rev-parse", "main").trim();
  fx.baseShort = git(fx.main, "rev-parse", "--short", fx.baseSha).trim();
  return join(fx.main, "sub");
}

/** One changed `.ts` in the MAIN repo: something for the gate to scan there. */
function dirtyMain(fx: Fixture): void {
  writeFileSync(join(fx.main, "a.ts"), "export const a = 3;\n");
}

interface HookRun {
  status: number | null;
  stderr: string;
  stdout: string;
}

/**
 * Replace everything that differs between two runs of the same case — the
 * fixture's mkdtemp paths and the base SHA — with stable placeholders.
 * `acrossShells` deep-equals the bash and zsh results, and each shell gets its
 * own fixture, so raw output would diverge on the paths alone.
 */
function scrub(fx: Fixture, text: string): string {
  return (fx.foreign ? text.split(fx.foreign).join("<FOREIGN>") : text)
    .split(fx.worktree)
    .join("<WORKTREE>")
    .split(fx.main)
    .join("<MAIN>")
    .split(fx.baseSha)
    .join("<BASE_SHA>")
    .split(fx.baseShort)
    .join("<BASE_SHORT>");
}

function normalize(fx: Fixture, run: HookRun): HookRun {
  return {
    status: run.status,
    stderr: scrub(fx, run.stderr),
    stdout: scrub(fx, run.stdout),
  };
}

/**
 * Run a hook the way `settings.json` does: the PROCESS cwd is the main repo
 * (`$CLAUDE_PROJECT_DIR`), and the worktree is only visible through the
 * payload's `.cwd` — the field Claude Code fills with the tool call's current
 * working directory. `cwd` comes FIRST in the payload and `tool_input` last, as
 * Claude Code sends it.
 */
function runHook(
  fx: Fixture,
  shell: HookShell,
  id: HookId,
  command: string,
  payloadCwd: string | undefined,
): HookRun {
  const payload: Record<string, unknown> = {};
  if (payloadCwd !== undefined) payload.cwd = payloadCwd;
  payload.tool_input = { command };
  const r = spawnSync(shell, [fx.hooks[id]], {
    cwd: fx.main,
    input: JSON.stringify(payload),
    encoding: "utf-8",
    env: { PATH: `${fx.binDir}:${BASE_PATH}`, CLAUDE_PROJECT_DIR: fx.main },
  });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout };
}

/** Every stub invocation recorded so far, scrubbed of run-specific paths. */
function invocations(fx: Fixture): string[] {
  try {
    return scrub(fx, readFileSync(fx.log, "utf-8")).trimEnd().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

describe.runIf(runsBash)("gate hooks — scan the tree the commit acts on (#454)", () => {
  // THE regression. Against the pre-#454 hooks this case is green with zero
  // scans: the hook cd'd into the (clean) main repo and reported "no changes vs
  // main". Two independent signals prove the opposite here, and they no longer
  // share a number (#510): `scans` says the scanner RAN, the exit code says the
  // verdict BLOCKS.
  it("semgrep BLOCKS a commit whose diff lives in an agent worktree", () => {
    const out = acrossShells((shell) => {
      const fx = setupFixture(1);
      const run = normalize(fx, runHook(fx, shell, "semgrep", "git commit -m x", fx.worktree));
      return { run, scans: invocations(fx).length };
    });

    expect(out.run.status).toBe(HOOK_BLOCKS);
    expect(out.scans).toBe(1);
    // The tree it announces is the WORKTREE, not the (clean) main repo.
    expect(out.run.stderr).toContain("1 changed file(s) vs main (<BASE_SHORT>) in <WORKTREE>");
  });

  it("jscpd runs over the worktree's diff too", () => {
    const out = acrossShells((shell) => {
      const fx = setupFixture(1);
      const run = normalize(fx, runHook(fx, shell, "jscpd", "git commit -m x", fx.worktree));
      const runs = invocations(fx);
      // The `--output` temp dir differs per run, so compare the shape, not the
      // literal argv (`acrossShells` deep-equals bash's result against zsh's).
      return { run, scans: runs.length, scannedFile: runs.every((line) => line.endsWith("a.ts")) };
    });

    expect(out.run.status).toBe(HOOK_BLOCKS);
    expect(out.scans).toBe(1);
    expect(out.scannedFile).toBe(true);
  });

  // The quality gate had the same defect through a different line: it cd'd to
  // `$CLAUDE_PROJECT_DIR`, so `pnpm test` ran over the main repo's code while
  // the commit carried the worktree's.
  it("quality gate runs the gate command inside the worktree", () => {
    const out = acrossShells((shell) => {
      const fx = setupFixture();
      const inWorktree = normalize(
        fx,
        runHook(fx, shell, "quality-gate", "git commit -m x", fx.worktree),
      );
      const inMain = normalize(fx, runHook(fx, shell, "quality-gate", "git commit -m x", fx.main));
      return { inWorktree, inMain };
    });

    // `cat only-in-worktree.txt` succeeds only from the worktree…
    expect(out.inWorktree.status).toBe(0);
    expect(out.inWorktree.stdout).toContain("worktree");
    // …and the same gate, anchored at the main repo, cannot find the file. That
    // asymmetry is what proves WHERE the gate ran.
    expect(out.inMain.status).toBe(2);
  });

  // Second, independent signal: the command names its own tree. Covers a
  // session anchored in the main repo that commits into a worktree, where the
  // payload cwd alone would still point at the main repo.
  it("resolves the tree from a leading `cd <worktree>` in the command", () => {
    const out = acrossShells((shell) => {
      const fx = setupFixture(1);
      const run = normalize(
        fx,
        runHook(fx, shell, "semgrep", `cd '${fx.worktree}' && git commit -m x`, fx.main),
      );
      return { run, scans: invocations(fx).length };
    });

    expect(out.run.status).toBe(HOOK_BLOCKS);
    expect(out.scans).toBe(1);
  });

  it("resolves the tree from `git -C <worktree> commit`", () => {
    const out = acrossShells((shell) => {
      const fx = setupFixture(1);
      const run = normalize(
        fx,
        runHook(fx, shell, "semgrep", `git -C ${fx.worktree} commit -m x`, fx.main),
      );
      return { run, scans: invocations(fx).length };
    });

    expect(out.run.status).toBe(HOOK_BLOCKS);
    expect(out.scans).toBe(1);
  });

  // No payload cwd and no cd → the hook process's own cwd, i.e. the pre-#454
  // behaviour. The main repo is clean, so this legitimately scans nothing — and
  // must SAY so (see the legibility block below).
  it("falls back to the hook process's cwd when the payload carries no cwd", () => {
    const out = acrossShells((shell) => {
      const fx = setupFixture(1);
      const run = normalize(fx, runHook(fx, shell, "semgrep", "git commit -m x", undefined));
      return { run, scans: invocations(fx).length };
    });

    expect(out.run.status).toBe(0);
    expect(out.scans).toBe(0);
    expect(out.run.stderr).toContain("0 files to scan");
    expect(out.run.stderr).toContain("in <MAIN>");
  });
});

/**
 * Set up a bypass shape and report whether the scanner ran. `build` gets the
 * fixture plus a second, unrelated repository, and returns the command Claude
 * Code would run and the cwd it would report; it may also mutate the fixture
 * (dirty the main repo, add a submodule) before the hook runs.
 */
function bypassRun(
  shell: HookShell,
  id: HookId,
  build: (fx: Fixture, foreign: string) => { command: string; payloadCwd: string },
): { run: HookRun; scans: number } {
  const fx = setupFixture(1);
  const { command, payloadCwd } = build(fx, addForeignRepo(fx));
  const run = normalize(fx, runHook(fx, shell, id, command, payloadCwd));
  return { run, scans: invocations(fx).length };
}

/**
 * The directory the COMMAND names is candidate 1, so accepting any git tree it
 * happens to mention lets it override the payload cwd and aim the scan at a
 * tree with nothing to scan — exit 0 with the scanner never invoked, the same
 * shape #454 is about. Every case below is one of those commands; each asserts
 * that the scanner RAN over the tree the commit acts on (counted invocations)
 * and, separately, that the seeded finding produced a BLOCKING verdict
 * (`HOOK_BLOCKS`) — and that the foreign tree is never announced.
 */
describe.runIf(runsBash)("gate hooks — the command cannot aim the scan elsewhere (#454)", () => {
  it("ignores a `cd <other repo>` earlier in the chain", () => {
    const out = acrossShells((shell) =>
      bypassRun(shell, "semgrep", (fx, foreign) => ({
        command: `cd '${foreign}' && cd '${fx.worktree}' && git commit -m x`,
        payloadCwd: fx.worktree,
      })),
    );

    expect(out.scans).toBe(1);
    expect(out.run.status).toBe(HOOK_BLOCKS);
    expect(out.run.stderr).toContain("1 changed file(s) vs main (<BASE_SHORT>) in <WORKTREE>");
    expect(out.run.stderr).not.toContain("<FOREIGN>");
  });

  // The decisive one: with the commit landing in the MAIN repo, an unconstrained
  // candidate 1 is strictly WORSE than not resolving worktrees at all — this
  // exact command scanned 1 file before #454 and 0 after it.
  it("ignores a `git -C <other repo>` in an unrelated leading segment", () => {
    const out = acrossShells((shell) =>
      bypassRun(shell, "semgrep", (fx, foreign) => {
        dirtyMain(fx);
        return {
          command: `git -C ${foreign} log && git commit -m x`,
          payloadCwd: fx.main,
        };
      }),
    );

    expect(out.scans).toBe(1);
    expect(out.run.status).toBe(HOOK_BLOCKS);
    expect(out.run.stderr).toContain("1 changed file(s) vs main (<BASE_SHORT>) in <MAIN>");
    expect(out.run.stderr).not.toContain("<FOREIGN>");
  });

  // `;` is not a segment separator for the `cd` probe (only the first `&&`
  // segment is inspected), so this shape hands candidate 1 the wrong directory.
  it("ignores a `cd <other repo>` separated by `;`", () => {
    const out = acrossShells((shell) =>
      bypassRun(shell, "semgrep", (fx, foreign) => ({
        command: `cd '${foreign}' ; cd '${fx.worktree}' && git commit -m x`,
        payloadCwd: fx.worktree,
      })),
    );

    expect(out.scans).toBe(1);
    expect(out.run.status).toBe(HOOK_BLOCKS);
    expect(out.run.stderr).toContain("1 changed file(s) vs main (<BASE_SHORT>) in <WORKTREE>");
    expect(out.run.stderr).not.toContain("<FOREIGN>");
  });

  // The probe scans the whole command for `git -C `, so a commit MESSAGE that
  // merely quotes those bytes used to redirect the scan. Nothing about a message
  // is trustworthy input.
  it("ignores `git -C <other repo>` quoted inside the commit message", () => {
    const out = acrossShells((shell) =>
      bypassRun(shell, "semgrep", (fx, foreign) => ({
        command: `git commit -m "use git -C ${foreign} everywhere"`,
        payloadCwd: fx.worktree,
      })),
    );

    expect(out.scans).toBe(1);
    expect(out.run.status).toBe(HOOK_BLOCKS);
    expect(out.run.stderr).toContain("1 changed file(s) vs main (<BASE_SHORT>) in <WORKTREE>");
    expect(out.run.stderr).not.toContain("<FOREIGN>");
  });

  // A submodule IS a git working tree, and its git dir sits under the
  // superproject's `.git/modules/` — inside it, yet a different repository. The
  // check is exact equality of the common dir for exactly this case.
  it("ignores a `cd <submodule>` even though it lives inside the repo", () => {
    const out = acrossShells((shell) =>
      bypassRun(shell, "semgrep", (fx) => {
        const sub = addSubmodule(fx);
        dirtyMain(fx);
        return { command: `cd '${sub}' && cd .. && git commit -m x`, payloadCwd: fx.main };
      }),
    );

    expect(out.scans).toBe(1);
    expect(out.run.status).toBe(HOOK_BLOCKS);
    expect(out.run.stderr).toContain("1 changed file(s) vs main (<BASE_SHORT>) in <MAIN>");
    expect(out.run.stderr).not.toContain("<MAIN>/sub");
  });

  // Both scanners share the resolver, so the same command must not divert jscpd
  // either — it was the second half of the reported exposure.
  it("keeps jscpd on the commit's tree too", () => {
    const out = acrossShells((shell) =>
      bypassRun(shell, "jscpd", (fx, foreign) => {
        dirtyMain(fx);
        return { command: `git -C ${foreign} log && git commit -m x`, payloadCwd: fx.main };
      }),
    );

    expect(out.scans).toBe(1);
    expect(out.run.status).toBe(HOOK_BLOCKS);
    expect(out.run.stderr).toContain("1 changed file(s) vs main in <MAIN>");
    expect(out.run.stderr).not.toContain("<FOREIGN>");
  });
});

describe.runIf(runsBash)("gate hooks — an empty scan is not a silent green (#454)", () => {
  it("semgrep distinguishes `scanned 0 files` from `scanned N and found nothing`", () => {
    const out = acrossShells((shell) => {
      const fx = setupFixture(0);
      const empty = normalize(fx, runHook(fx, shell, "semgrep", "git commit -m x", fx.main));
      const scanned = normalize(fx, runHook(fx, shell, "semgrep", "git commit -m x", fx.worktree));
      return { empty, scanned };
    });

    // Nothing to scan: names the base AND the tree, so a skip is readable.
    expect(out.empty.status).toBe(0);
    expect(out.empty.stderr).toContain(
      "0 files to scan — no *.ts/*.tsx differ from main (<BASE_SHORT>) in <MAIN>",
    );
    expect(out.empty.stderr).not.toContain("no new findings");

    // Something scanned and clean: a different sentence entirely.
    expect(out.scanned.status).toBe(0);
    expect(out.scanned.stderr).toContain(
      "1 file(s) scanned vs main (<BASE_SHORT>) — no new findings",
    );
    expect(out.scanned.stderr).not.toContain("0 files to scan");
  });

  it("jscpd names the base and the tree when there is nothing to scan", () => {
    const out = acrossShells((shell) => {
      const fx = setupFixture(0);
      const run = normalize(fx, runHook(fx, shell, "jscpd", "git commit -m x", fx.main));
      return { run, scans: invocations(fx).length };
    });

    expect(out.run.status).toBe(0);
    expect(out.scans).toBe(0);
    expect(out.run.stderr).toContain("0 files to scan — no *.ts/*.tsx differ from main in <MAIN>");
  });
});

describe.runIf(runsBash)("semgrep gate — fails on NEW findings, not inherited debt (#454)", () => {
  // Half two of #454: pointing the gate at the right tree would otherwise turn a
  // decorative gate into one that blocks any commit touching a file with
  // pre-existing hits (7 of them already sit in `main` under
  // packages/cli/src/lib/marker.ts). The baseline is what keeps the verdict on
  // what the branch INTRODUCES. Semgrep owns the comparison itself; what the
  // hook owes is the right baseline commit, pinned to a SHA.
  it("passes --baseline-commit with the base branch's SHA", () => {
    const out = acrossShells((shell) => {
      const fx = setupFixture(0);
      runHook(fx, shell, "semgrep", "git commit -m x", fx.worktree);
      return { invocations: invocations(fx) };
    });

    expect(out.invocations).toHaveLength(1);
    expect(out.invocations[0]).toContain("--baseline-commit <BASE_SHA>");
  });

  it("announces which baseline the verdict is measured against", () => {
    const out = acrossShells((shell) => {
      const fx = setupFixture(0);
      return normalize(fx, runHook(fx, shell, "semgrep", "git commit -m x", fx.worktree));
    });

    expect(out.stderr).toContain(
      "baseline: findings already at main (<BASE_SHORT>) are not blocking",
    );
  });

  // A scanner that fell over is not a security verdict. `--error` maps findings
  // to exit 1; anything higher is semgrep itself failing (unusable baseline,
  // bad ruleset, crash) and must not read as "1 finding".
  it("says a scan that FAILED is not a findings verdict", () => {
    const out = acrossShells((shell) => {
      const fx = setupFixture(2);
      return normalize(fx, runHook(fx, shell, "semgrep", "git commit -m x", fx.worktree));
    });

    // …and it does not block on it either (#510): a crashed scanner is a
    // tooling failure, so it is reported and the call proceeds. Blocking here
    // would spend the gate's credibility on a claim it cannot make.
    expect(out.status).toBe(HOOK_WARNS_WITHOUT_BLOCKING);
    expect(out.stderr).toContain("scan FAILED with exit 2");
    expect(out.stderr).toContain("nothing was validated");
  });

  // The cache (#402) memoizes a GREEN scan by content fingerprint. The verdict
  // now also depends on the baseline, so the same bytes must rescan when the
  // base branch moves — otherwise a green earned against an old baseline masks
  // findings that are new against the current one.
  it("rescans the same bytes when the base branch moves", () => {
    const out = acrossShells((shell) => {
      const fx = setupFixture(0);
      const first = normalize(fx, runHook(fx, shell, "semgrep", "git commit -m x", fx.worktree));
      const cached = normalize(fx, runHook(fx, shell, "semgrep", "git push", fx.worktree));
      // `main` advances with a file the worktree does not care about.
      writeFileSync(join(fx.main, "unrelated.ts"), "export const u = 1;\n");
      git(fx.main, "add", "unrelated.ts");
      git(fx.main, "commit", "-q", "--no-verify", "-m", "main moves");
      const afterMove = runHook(fx, shell, "semgrep", "git push", fx.worktree);
      return {
        first,
        cached,
        // The base SHA changed, so scrub against the ORIGINAL fixture would no
        // longer match: only the cache-hit sentence matters here.
        rescanned: !afterMove.stderr.includes("diff unchanged since last green scan"),
        scans: invocations(fx).length,
      };
    });

    expect(out.first.status).toBe(0);
    expect(out.cached.stderr).toContain("diff unchanged since last green scan");
    expect(out.rescanned).toBe(true);
    // scan → cache hit → rescan.
    expect(out.scans).toBe(2);
  });
});

/**
 * #1095 — a commit that provably lands in ANOTHER repository is not what the
 * anchor's gate protects: its tree holds none of the diff, so the gate ran for
 * nothing (and blocked for nothing). Those pass with a stderr warning. Everything
 * the parser cannot prove — and every #454 shape — keeps running the gate.
 */
const GATES: readonly HookId[] = ["quality-gate", "semgrep", "jscpd"];

/** Did the hook run its gate/scan (true) or stand down as `foreign` (false)? */
function landingRun(
  shell: HookShell,
  id: HookId,
  build: (fx: Fixture, foreign: string) => { command: string; payloadCwd: string },
): { run: HookRun; scans: number; skipped: boolean } {
  const fx = setupFixture(1);
  const { command, payloadCwd } = build(fx, addForeignRepo(fx));
  const run = normalize(fx, runHook(fx, shell, id, command, payloadCwd));
  return {
    run,
    scans: invocations(fx).length,
    skipped: run.stderr.includes("lands in another repository"),
  };
}

describe.runIf(runsBash)(
  "gate hooks — a commit landing in another repo is not gated (#1095)",
  () => {
    const foreignShapes: Array<[string, (fx: Fixture, f: string) => string]> = [
      ["cd <F> && git commit", (_fx, f) => `cd '${f}' && git commit -m x`],
      ["git -C <F> commit", (_fx, f) => `git -C '${f}' commit -m x`],
      ["cd <F> && git add && git commit", (_fx, f) => `cd '${f}' && git add -A && git commit -m x`],
      ["git -c k=v -C <F> commit", (_fx, f) => `git -c commit.gpgsign=false -C '${f}' commit -m x`],
      ["relative cd", (_fx, f) => `cd ../${basename(f)} && git commit -m x`],
      [
        "multi-line message heredoc",
        (_fx, f) => `cd '${f}' && git commit -m "$(cat <<'EOF'\nmessage line\nEOF\n)"`,
      ],
    ];

    for (const id of GATES) {
      for (const [name, build] of foreignShapes) {
        it(`${id}: passes with a warning on \`${name}\``, () => {
          const out = acrossShells((shell) =>
            landingRun(shell, id, (fx, f) => ({ command: build(fx, f), payloadCwd: fx.main })),
          );
          expect(out.run.status).toBe(0);
          expect(out.scans).toBe(0);
          expect(out.skipped).toBe(true);
          expect(out.run.stderr).toContain("another repository (<FOREIGN>)");
          expect(out.run.stderr).not.toContain("running quality-gate fast");
        });
      }
    }

    it("records the foreign skip reason in the quality gate's audit trail", () => {
      const out = acrossShells((shell) =>
        landingRun(shell, "quality-gate", (fx, f) => ({
          command: `cd '${f}' && git commit -m x`,
          payloadCwd: fx.main,
        })),
      );
      expect(out.run.stderr).toContain("quality-gate NOT run");
    });

    // #1097 — the skip names the destination and says whether ITS gate exists.
    // The destination's config is data: detected, never executed.
    const hasJq = spawnSync("jq", ["--version"], { env: { PATH: BASE_PATH } }).status === 0;

    /** Foreign commit with `configText` (or no config) in the destination; returns
     * stderr, the audit `skip` reason and whether the sentinel file was created. */
    function foreignGateRun(
      shell: HookShell,
      configText: string | null,
    ): { status: number | null; stderr: string; reason: string; sentinel: boolean } {
      const fx = setupFixture(1);
      const f = addForeignRepo(fx);
      if (configText !== null) writeFileSync(join(f, "navori.config.json"), configText);
      const auditsRoot = mkTemp("navori-1097-audits-");
      const repoDir = join(auditsRoot, basename(fx.main));
      mkdirSync(repoDir, { mode: 0o700 });
      writeFileSync(
        join(fx.binDir, "navori"),
        `#!/bin/sh\nexec '${process.execPath}' '${resolve("dist/index.js")}' "$@"\n`,
        { mode: 0o700 },
      );
      const log = join(repoDir, "session-s1.log");
      writeFileSync(log, `${JSON.stringify({ event: "start", sessionId: "s1", cwd: fx.main })}\n`, {
        mode: 0o600,
      });
      const r = spawnSync(shell, [fx.hooks["quality-gate"]], {
        cwd: fx.main,
        input: JSON.stringify({
          session_id: "s1",
          cwd: fx.main,
          tool_input: { command: `cd '${f}' && git commit -m x` },
        }),
        encoding: "utf-8",
        env: {
          PATH: `${fx.binDir}:${BASE_PATH}`,
          CLAUDE_PROJECT_DIR: fx.main,
          NAVORI_AUDITS_ROOT: auditsRoot,
        },
      });
      const events = readFileSync(log, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { verdict?: string; reason?: string });
      const skip = events.find((e) => e.verdict === "skip");
      return {
        status: r.status,
        stderr: scrub(fx, r.stderr),
        reason: scrub(fx, skip?.reason ?? ""),
        sentinel: existsSync(join(f, "SENTINEL")) || existsSync(join(fx.main, "SENTINEL")),
      };
    }

    it.runIf(hasJq)("names the destination and says its own gate was NOT run", () => {
      const out = acrossShells((shell) =>
        foreignGateRun(shell, JSON.stringify({ qualityGate: { fast: "bun lint" } })),
      );
      expect(out.status).toBe(0);
      expect(out.reason).toBe("unspecified");
      expect(out.stderr).toContain("<FOREIGN>");
      expect(out.stderr).toContain("declares its own qualityGate.fast");
      expect(out.stderr).toContain("NOT executed");
    });

    it.runIf(hasJq)("names the destination only when it has no config", () => {
      const out = acrossShells((shell) => foreignGateRun(shell, null));
      expect(out.status).toBe(0);
      expect(out.reason).toBe("unspecified");
      expect(out.stderr).toContain("<FOREIGN>");
      expect(out.stderr).not.toContain("declares its own");
    });

    it.runIf(hasJq)("degrades on an invalid or gate-less destination config", () => {
      for (const cfg of ["{ not json", "{}", JSON.stringify({ qualityGate: { fast: 5 } })]) {
        const out = acrossShells((shell) => foreignGateRun(shell, cfg));
        expect(out.status).toBe(0);
        expect(out.reason).toBe("unspecified");
        expect(out.stderr).toContain("<FOREIGN>");
        expect(out.stderr).not.toContain("declares its own");
      }
    });

    it.runIf(hasJq)("never executes a destination fast containing `;` or `$()`", () => {
      const fast = "touch SENTINEL; $(touch SENTINEL) && `touch SENTINEL`";
      const out = acrossShells((shell) =>
        foreignGateRun(shell, JSON.stringify({ qualityGate: { fast } })),
      );
      expect(out.status).toBe(0);
      expect(out.sentinel).toBe(false);
      expect(out.stderr).toContain("NOT executed");
    });

    // Every shape below must still RUN the gate: either it lands in the anchor
    // (same-repo) or the parser cannot prove where it lands (ambiguous).
    const stillGated: Array<[string, (fx: Fixture, f: string) => string]> = [
      ["GIT_DIR= prefix", (_fx, f) => `GIT_DIR='${f}/.git' git commit -m x`],
      ["subshell", (_fx, f) => `(cd '${f}' && git commit -m x)`],
      ["pushd", (_fx, f) => `pushd '${f}' && git commit -m x`],
      ["$VAR path", () => `cd "$HOME/x" && git commit -m x`],
      ["tilde path", () => `cd ~/x && git commit -m x`],
      ["cd <F> && git -C <MAIN> commit", (fx, f) => `cd '${f}' && git -C '${fx.main}' commit -m x`],
      [
        "two commits in different repos",
        (fx, f) => `cd '${f}' && git commit -m a && cd '${fx.main}' && git commit -m b`,
      ],
      [
        "second commit hidden behind env",
        (fx, f) => `cd '${f}' && git commit -m a && (cd '${fx.main}' && env git commit -m b)`,
      ],
      ["`;`-joined cd", (_fx, f) => `cd '${f}' ; git commit -m x`],
      ["cd and commit on separate lines", (_fx, f) => `cd '${f}'\ngit commit -m x`],
      ["a non-cd step between", (_fx, f) => `cd '${f}' && bun test && git commit -m x`],
      ["--git-dir", (_fx, f) => `git --git-dir='${f}/.git' commit -m x`],
      ["--work-tree", (_fx, f) => `git --work-tree='${f}' commit -m x`],
      ["cd || true", (_fx, f) => `cd '${f}' || true && git commit -m x`],
      ["missing directory", (_fx, f) => `cd '${f}/missing' && git commit -m x`],
      ["non-repo directory", () => `cd '/' && git commit -m x`],
      ["message quoting git -C", (_fx, f) => `git commit -m "use git -C ${f} everywhere"`],
    ];

    for (const id of GATES) {
      for (const [name, build] of stillGated) {
        it(`${id}: still gates \`${name}\``, () => {
          const out = acrossShells((shell) =>
            landingRun(shell, id, (fx, f) => ({ command: build(fx, f), payloadCwd: fx.main })),
          );
          expect(out.skipped).toBe(false);
          // A gate that ran either blocked (2) or announced itself; a hook that
          // stood down silently would be exit 0 with neither.
          if (id === "quality-gate") expect(out.run.stderr).toContain("running quality-gate fast");
        });
      }
    }

    it("still gates a submodule target (ambiguous by decision)", () => {
      const out = acrossShells((shell) => {
        const fx = setupFixture(1);
        const sub = addSubmodule(fx);
        const run = normalize(
          fx,
          runHook(fx, shell, "quality-gate", `cd '${sub}' && git commit -m x`, fx.main),
        );
        return { run, skipped: run.stderr.includes("lands in another repository") };
      });
      expect(out.skipped).toBe(false);
      expect(out.run.stderr).toContain("running quality-gate fast");
    });

    // F1: the hook's OWN repo is `$CLAUDE_PROJECT_DIR`. A session anchored in a
    // foreign repo that commits into it must still be gated.
    it("still gates a commit into the hook's own repo from a foreign-anchored session", () => {
      const out = acrossShells((shell) =>
        landingRun(shell, "quality-gate", (fx, f) => ({
          command: `cd '${fx.main}' && git commit -m x`,
          payloadCwd: f,
        })),
      );
      expect(out.skipped).toBe(false);
      expect(out.run.stderr).toContain("running quality-gate fast");
    });

    // F4: `..` resolved through a symlinked base differs between the shell and the
    // kernel, so the classification must not trust it.
    it("treats `..` behind a symlinked cwd as ambiguous", () => {
      const out = acrossShells((shell) =>
        landingRun(shell, "quality-gate", (fx, f) => {
          const link = join(mkTemp("navori-1095-link-"), "l");
          symlinkSync(fx.main, link);
          return { command: `cd ../${basename(f)} && git commit -m x`, payloadCwd: link };
        }),
      );
      expect(out.skipped).toBe(false);
    });

    // #1115: every gated op of the chain (semgrep also gates `git push`) resolves
    // to the same foreign repo, so the scan stands down.
    it("semgrep skips `cd <F> && git commit && git push` (#1115)", () => {
      const out = acrossShells((shell) =>
        landingRun(shell, "semgrep", (fx, f) => ({
          command: `cd '${f}' && git commit -m x && git push`,
          payloadCwd: fx.main,
        })),
      );
      expect(out.scans).toBe(0);
      expect(out.skipped).toBe(true);
    });
  },
);

/**
 * #1099 — the hook's HOME repo is the one it is installed in
 * (`$CLAUDE_PROJECT_DIR/.claude/{hooks,scripts}/<file>`, exact shape). A session
 * whose cwd sits in ANOTHER repo must not run the anchor's gate over that tree,
 * with or without a `cd`. Unlike the suites above, these hooks are installed at
 * the path settings.json registers them at, because the home check is about the
 * hook's own path.
 */
interface HomeCase {
  command: string;
  payloadCwd: string;
  /** `null` = `CLAUDE_PROJECT_DIR` unset. Defaults to the main repo. */
  cpd?: string | null;
  /** Repo/dir the hook is installed under. Defaults to the main repo. */
  hookRoot?: string;
  /** Extra hook env (e.g. `GH_REPO`). */
  env?: Record<string, string>;
}

/** An independent repository NESTED inside `fx.main` (a gitignored clone). */
function addNestedRepo(fx: Fixture): string {
  const nested = join(fx.main, "nested");
  mkdirSync(nested);
  writeFileSync(join(nested, "n.ts"), "export const n = 1;\n");
  git(nested, "init", "-q");
  git(nested, "add", "n.ts");
  git(nested, "commit", "-q", "--no-verify", "-m", "base");
  git(nested, "branch", "-M", "main");
  return nested;
}

/** Copy the rendered hook to `<root>/.claude/{hooks|scripts}/<id>.sh`. */
function installHook(fx: Fixture, id: HookId, root: string): string {
  const dir = join(root, ".claude", id === "quality-gate" ? "hooks" : "scripts");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${id}.sh`);
  writeFileSync(p, readFileSync(fx.hooks[id], "utf-8"));
  chmodSync(p, 0o755);
  return p;
}

function homeRun(
  shell: HookShell,
  id: HookId,
  build: (fx: Fixture, foreign: string) => HomeCase,
): { run: HookRun; scans: number; skipped: boolean } {
  const fx = setupFixture(1);
  const c = build(fx, addForeignRepo(fx));
  const hook = installHook(fx, id, c.hookRoot ?? fx.main);
  const cpd = c.cpd === undefined ? fx.main : c.cpd;
  const env: Record<string, string> = { PATH: `${fx.binDir}:${BASE_PATH}`, ...c.env };
  if (cpd !== null) env.CLAUDE_PROJECT_DIR = cpd;
  const r = spawnSync(shell, [hook], {
    cwd: fx.main,
    input: JSON.stringify({ cwd: c.payloadCwd, tool_input: { command: c.command } }),
    encoding: "utf-8",
    env,
  });
  const run = normalize(fx, { status: r.status, stderr: r.stderr, stdout: r.stdout });
  // The foreign/nested repos have their own base SHA, which `scrub` does not know.
  run.stderr = run.stderr.replace(/\([0-9a-f]{7,40}\)/g, "(<SHA>)");
  return {
    run,
    scans: invocations(fx).length,
    skipped: run.stderr.includes("lands in another repository"),
  };
}

describe.runIf(runsBash)(
  "gate hooks — a session anchored in another repo is not gated (#1099)",
  () => {
    for (const id of GATES) {
      for (const [name, build] of [
        ["plain commit", (_fx: Fixture, _f: string) => "git commit -m x"],
        ["cd to the cwd itself", (_fx: Fixture, f: string) => `cd '${f}' && git commit -m x`],
      ] as const) {
        it(`${id}: skips \`${name}\` when the cwd is another repo`, () => {
          const out = acrossShells((shell) =>
            homeRun(shell, id, (fx, f) => ({ command: build(fx, f), payloadCwd: f })),
          );
          expect(out.run.status).toBe(0);
          expect(out.scans).toBe(0);
          expect(out.skipped).toBe(true);
          expect(out.run.stderr).toContain("another repository (<FOREIGN>)");
          expect(out.run.stderr).toContain("not the one this hook protects");
          // zsh prints a re-declared `local` to stdout; the hook's stdout stays empty.
          expect(out.run.stdout).toBe("");
        });
      }

      it(`${id}: skips when CLAUDE_PROJECT_DIR carries a trailing slash`, () => {
        const out = acrossShells((shell) =>
          homeRun(shell, id, (fx, f) => ({
            command: "git commit -m x",
            payloadCwd: f,
            cpd: `${fx.main}/`,
          })),
        );
        expect(out.skipped).toBe(true);
      });

      it(`${id}: still gates a commit from a linked worktree of the home repo`, () => {
        const out = acrossShells((shell) =>
          homeRun(shell, id, (fx) => ({ command: "git commit -m x", payloadCwd: fx.worktree })),
        );
        expect(out.skipped).toBe(false);
        if (id === "quality-gate") expect(out.run.stderr).toContain("running quality-gate fast");
        else expect(out.scans).toBe(1);
      });

      // Home unknown -> the gate runs (fail-safe), whatever the reason.
      const unknownHome: Array<[string, (fx: Fixture, f: string) => HomeCase]> = [
        [
          "CLAUDE_PROJECT_DIR unset",
          (_fx, f) => ({ command: "git commit -m x", payloadCwd: f, cpd: null }),
        ],
        [
          "CLAUDE_PROJECT_DIR not a git repo",
          (_fx, f) => {
            const plain = mkTemp("navori-1099-plain-");
            return { command: "git commit -m x", payloadCwd: f, cpd: plain, hookRoot: plain };
          },
        ],
        [
          "leaked CLAUDE_PROJECT_DIR, hook outside it",
          (_fx, f) => ({ command: "git commit -m x", payloadCwd: f, hookRoot: f }),
        ],
        [
          "leaked CLAUDE_PROJECT_DIR, hook of a repo nested under it",
          (fx) => {
            const nested = addNestedRepo(fx);
            return { command: "git commit -m x", payloadCwd: nested, hookRoot: nested };
          },
        ],
        [
          "cwd inside a submodule of home",
          (fx) => ({ command: "git commit -m x", payloadCwd: addSubmodule(fx) }),
        ],
      ];
      for (const [name, build] of unknownHome) {
        it(`${id}: still gates when home is not proven (${name})`, () => {
          const out = acrossShells((shell) => homeRun(shell, id, build));
          expect(out.skipped).toBe(false);
          if (id === "quality-gate") expect(out.run.stderr).toContain("running quality-gate fast");
        });
      }
    }

    // Related variant: cwd in F, the command names HOME. The scan must follow the
    // command to home's tree, not stay in F's.
    it("semgrep scans HOME's tree for `cd <home> && git commit` from a foreign cwd", () => {
      const out = acrossShells((shell) =>
        homeRun(shell, "semgrep", (fx, f) => {
          dirtyMain(fx);
          return { command: `cd '${fx.main}' && git commit -m x`, payloadCwd: f };
        }),
      );
      expect(out.skipped).toBe(false);
      expect(out.scans).toBe(1);
      expect(out.run.stderr).toContain("in <MAIN>");
    });

    it("quality gate still runs for `cd <home> && git commit` from a foreign cwd", () => {
      const out = acrossShells((shell) =>
        homeRun(shell, "quality-gate", (fx, f) => ({
          command: `cd '${fx.main}' && git commit -m x`,
          payloadCwd: f,
        })),
      );
      expect(out.skipped).toBe(false);
      expect(out.run.stderr).toContain("running quality-gate fast");
    });
  },
);

/**
 * #1098 — semgrep also gates `git push` and `gh pr create`. The landing walk now
 * matches the caller's `$TRIGGER_RE`, so those verbs classify like a commit:
 * `foreign` only when the cd/-C target is provably another repo. Only semgrep
 * triggers on them; QG and jscpd are commit-only.
 */
describe.runIf(runsBash)(
  "gate hooks — push and `gh pr create` landing in another repo are not scanned (#1098)",
  () => {
    const foreignVerbs: Array<[string, (f: string) => string]> = [
      ["cd <F> && git push", (f) => `cd '${f}' && git push`],
      ["git -C <F> push", (f) => `git -C '${f}' push`],
      ["cd <F> && gh pr create", (f) => `cd '${f}' && gh pr create --title t`],
    ];
    for (const [name, build] of foreignVerbs) {
      it(`semgrep: skips \`${name}\``, () => {
        const out = acrossShells((shell) =>
          homeRun(shell, "semgrep", (fx, f) => ({ command: build(f), payloadCwd: fx.worktree })),
        );
        expect(out.run.status).toBe(0);
        expect(out.scans).toBe(0);
        expect(out.skipped).toBe(true);
        expect(out.run.stderr).toContain("the command lands in another repository (<FOREIGN>)");
      });
    }

    it("semgrep: skips a bare `git push` / `gh pr create` from a foreign cwd", () => {
      for (const command of ["git push", "gh pr create --fill"]) {
        const out = acrossShells((shell) =>
          homeRun(shell, "semgrep", (_fx, f) => ({ command, payloadCwd: f })),
        );
        expect(out.scans).toBe(0);
        expect(out.skipped).toBe(true);
      }
    });

    const stillScanned: Array<[string, (fx: Fixture, f: string) => HomeCase]> = [
      ["git push in the home repo", (fx) => ({ command: "git push", payloadCwd: fx.worktree })],
      [
        "gh pr create in the home repo",
        (fx) => ({ command: "gh pr create --title t", payloadCwd: fx.worktree }),
      ],
      [
        "--repo",
        (fx, f) => ({ command: `cd '${f}' && gh pr create --repo o/r`, payloadCwd: fx.worktree }),
      ],
      [
        "--repo=",
        (fx, f) => ({ command: `cd '${f}' && gh pr create --repo=o/r`, payloadCwd: fx.worktree }),
      ],
      ["-R", (fx, f) => ({ command: `cd '${f}' && gh pr create -R o/r`, payloadCwd: fx.worktree })],
      [
        "-Ro/r",
        (fx, f) => ({ command: `cd '${f}' && gh pr create -Ro/r`, payloadCwd: fx.worktree }),
      ],
      [
        "GH_REPO in the hook env",
        (fx, f) => ({
          command: `cd '${f}' && gh pr create --title t`,
          payloadCwd: fx.worktree,
          env: { GH_REPO: "o/r" },
        }),
      ],
      [
        "push from a submodule",
        (fx) => ({ command: `cd '${addSubmodule(fx)}' && git push`, payloadCwd: fx.worktree }),
      ],
      [
        "push with an unparsable global option",
        (fx, f) => ({ command: `git --git-dir='${f}/.git' push`, payloadCwd: fx.worktree }),
      ],
    ];
    for (const [name, build] of stillScanned) {
      it(`semgrep: still scans (${name})`, () => {
        const out = acrossShells((shell) => homeRun(shell, "semgrep", build));
        expect(out.skipped).toBe(false);
        expect(out.scans).toBe(1);
      });
    }

    // #1115: a chain of gated ops lands where ALL of them land. These two were the
    // pinned ceiling of #1098; they flip because the walk now sees every op.
    it("semgrep: skips `cd <F> && git commit && git push` (#1115)", () => {
      const out = acrossShells((shell) =>
        homeRun(shell, "semgrep", (fx, f) => ({
          command: `cd '${f}' && git commit -m x && git push`,
          payloadCwd: fx.worktree,
        })),
      );
      expect(out.skipped).toBe(true);
      expect(out.scans).toBe(0);
    });

    it("semgrep: skips `git commit && git push` from a foreign cwd (#1115)", () => {
      const out = acrossShells((shell) =>
        homeRun(shell, "semgrep", (_fx, f) => ({
          command: "git commit -m x && git push",
          payloadCwd: f,
        })),
      );
      expect(out.run.status).toBe(0);
      expect(out.scans).toBe(0);
      expect(out.skipped).toBe(true);
    });
  },
);

/**
 * #1115 — a chain of gated ops (`git commit && git push`, `&& git status`) is
 * `foreign` only when EVERY gated op provably lands in the same foreign repo and
 * the walk saw every op the counter did. Anything that could touch the home repo
 * (another `-C`, a `cd`, an env export, a shell, an alias, an uncounted git form)
 * keeps the gate running. `skips` lists the gates that stand down; the rest run.
 */
describe.runIf(runsBash)("gate hooks — chained gated ops landing in another repo (#1115)", () => {
  const NONE: readonly HookId[] = [];
  const SEMGREP: readonly HookId[] = ["semgrep"];
  const NOT_SEMGREP: readonly HookId[] = ["quality-gate", "jscpd"];
  interface ChainRow {
    name: string;
    skips: readonly HookId[];
    build: (fx: Fixture, f: string) => HomeCase;
  }
  /** A second independent repo (the fixture's `foreign` slot is left untouched). */
  const otherRepo = (fx: Fixture): string => addForeignRepo({ ...fx });
  /** A linked worktree of `repo`. */
  const linkedWorktree = (repo: string): string => {
    const wt = join(mkTemp("navori-1115-wt-"), "wt");
    git(repo, "worktree", "add", "-q", "-b", "other", wt, "main");
    return wt;
  };
  /** A symlink called `name` (may hold a space) pointing at `target`. */
  const linkAs = (name: string, target: string): string => {
    const link = join(mkTemp("navori-1115-ln-"), name);
    symlinkSync(target, link);
    return link;
  };
  const inF = (command: (fx: Fixture, f: string) => string, skips: readonly HookId[]) => ({
    skips,
    build: (fx: Fixture, f: string): HomeCase => ({ command: command(fx, f), payloadCwd: f }),
  });
  const inMain = (command: (fx: Fixture, f: string) => string, skips: readonly HookId[]) => ({
    skips,
    build: (fx: Fixture, f: string): HomeCase => ({
      command: command(fx, f),
      payloadCwd: fx.main,
    }),
  });

  const heredocMsg = `git add -A && git commit -m "$(cat <<'EOF'\nmessage line\nEOF\n)" && git push`;
  /** Tails after `git commit -m x && `: uncounted or state-changing, so the gate runs. */
  const hostileTails: Array<[string, (fx: Fixture) => string]> = [
    ["quoted path with a space", (fx) => `git -C "${linkAs("M dir", fx.main)}" commit -m y`],
    ["quoted -c value with a space", () => `git -c user.name="A B" commit -m y`],
    ["alias ci", () => "git ci -m y"],
    ["alias ci with -C M", (fx) => `git -C '${fx.main}' ci -m y`],
    ["rebase -x", (fx) => `git rebase -x 'git -C ${fx.main} commit --allow-empty -m y' HEAD`],
    ["submodule foreach", (fx) => `git submodule foreach 'git -C ${fx.main} commit -m y'`],
    ["tab-separated -c", () => "git\t-c\tcore.pager=touch\tlog -1"],
    ["-c alias injection", () => "git -c alias.x='!git commit' x"],
    ["log --exec-path", () => "git log --exec-path"],
    ["status --config-env", () => "git status --config-env=core.pager=X"],
    ["-C M push", (fx) => `git -C '${fx.main}' push`],
    ["--git-dir M push", (fx) => `git --git-dir='${fx.main}/.git' push`],
    ["--work-tree M push", (fx) => `git --work-tree='${fx.main}' push`],
    [
      "export GIT_DIR then commit",
      (fx) => `export GIT_DIR='${linkAs("gd", join(fx.main, ".git"))}' && git commit -m y`,
    ],
    [
      "export GIT_DIR GIT_WORK_TREE then commit",
      (fx) =>
        `export GIT_DIR='${linkAs("gd", join(fx.main, ".git"))}' GIT_WORK_TREE='${linkAs("mm", fx.main)}' && git commit -m y`,
    ],
    [
      "export GIT_DIR then push",
      (fx) => `export GIT_DIR='${linkAs("gd", join(fx.main, ".git"))}' && git push`,
    ],
    ["bash -c", () => "bash -c 'git push'"],
    ["sh -c", () => "sh -c 'git push'"],
    ["subshell cd", (fx) => `(cd '${fx.main}' && git push)`],
    ["env git", () => "env git push"],
    ["eval", () => "eval 'git push'"],
    ["xargs", () => "xargs git push"],
    ["VAR= prefix", () => "VAR=1 git push"],
    ["command git", () => "command git push"],
    ["brace group", () => "{ git push; }"],
    ["newline then push", () => "git push\ngit push"],
    ["gh pr create -R", () => "gh pr create -R o/r"],
  ];

  const rows: ChainRow[] = [
    // Foreign: every gated op lands in the one foreign repo.
    { name: "commit && push from F", ...inF(() => "git commit -m x && git push", GATES) },
    { name: "commit && status from F", ...inF(() => "git commit -m x && git status", GATES) },
    {
      name: "add && commit && push from F",
      ...inF(() => "git add -A && git commit -m x && git push", GATES),
    },
    { name: "heredoc message && push from F", ...inF(() => heredocMsg, GATES) },
    {
      name: "commit && push -u from F",
      ...inF(() => "git commit -m x && git push -u origin HEAD", GATES),
    },
    { name: "commit && echo done from F", ...inF(() => "git commit -m x && echo done", GATES) },
    {
      name: "cd F && commit && log",
      ...inMain((_fx, f) => `cd '${f}' && git commit -m x && git log --oneline -1`, GATES),
    },
    {
      name: "cd F && commit && commit",
      ...inMain((_fx, f) => `cd '${f}' && git commit -m a && git commit -m b`, GATES),
    },
    {
      name: "cd F && commit && push && gh pr create",
      ...inMain(
        (_fx, f) => `cd '${f}' && git commit -m x && git push && gh pr create --fill`,
        SEMGREP,
      ),
    },
    {
      name: "-C F commit && -C F push",
      ...inMain((_fx, f) => `git -C '${f}' commit -m x && git -C '${f}' push`, SEMGREP),
    },
    {
      name: "relative -C F commit && -C F push",
      ...inMain(
        (_fx, f) => `git -C ../${basename(f)} commit -m x && git -C ../${basename(f)} push`,
        SEMGREP,
      ),
    },
    // Push is not QG/jscpd's op: only the commit's landing matters to them.
    {
      name: "-C F commit && push from home",
      ...inMain((_fx, f) => `git -C '${f}' commit -m x && git push`, NOT_SEMGREP),
    },
    // Mixed or unprovable landings: every gate runs.
    {
      name: "commit && -C M push from F",
      ...inF((fx) => `git commit -m x && git -C '${fx.main}' push`, NONE),
    },
    {
      name: "-C F commit && -C F2 push",
      ...inMain((fx, f) => `git -C '${f}' commit -m x && git -C '${otherRepo(fx)}' push`, NONE),
    },
    {
      name: "cd F && commit && -C F2 commit",
      ...inMain(
        (fx, f) => `cd '${f}' && git commit -m a && git -C '${otherRepo(fx)}' commit -m b`,
        NONE,
      ),
    },
    {
      name: "cd F && commit && cd M && push",
      ...inMain((fx, f) => `cd '${f}' && git commit -m x && cd '${fx.main}' && git push`, NONE),
    },
    {
      name: "commit && cd F && push",
      ...inMain((_fx, f) => `git commit -m x && cd '${f}' && git push`, NONE),
    },
    {
      name: "commit && push; commit",
      ...inF(() => "git commit -m x && git push; git commit -m y", NONE),
    },
    {
      name: "commit && push || push",
      ...inF(() => "git commit -m x && git push || git push", NONE),
    },
    {
      name: "message text with && -C M push",
      ...inF((fx) => `git commit -m "a && git -C '${fx.main}' push here"`, NONE),
    },
    {
      name: "two worktrees of F, -C tail",
      ...inMain(
        (_fx, f) => `git -C '${f}' commit -m x && git -C '${linkedWorktree(f)}' push`,
        NONE,
      ),
    },
    {
      name: "two worktrees of F, two commits",
      ...inMain(
        (_fx, f) => `git -C '${f}' commit -m a && git -C '${linkedWorktree(f)}' commit -m b`,
        NONE,
      ),
    },
    {
      name: "submodule chain",
      ...inMain((fx) => `cd '${addSubmodule(fx)}' && git commit -m x && git push`, NONE),
    },
    {
      name: "--git-dir head",
      ...inMain((_fx, f) => `git --git-dir='${f}/.git' commit -m x && git push`, NONE),
    },
    { name: "commit && push in home", ...inMain(() => "git commit -m x && git push", NONE) },
    {
      name: "commit && push in a home worktree",
      skips: NONE,
      build: (fx) => ({ command: "git commit -m x && git push", payloadCwd: fx.worktree }),
    },
    ...hostileTails.map(([name, tail]): ChainRow => ({
      name: `commit && ${name} from F`,
      ...inF((fx) => `git commit -m x && ${tail(fx)}`, NONE),
    })),
  ];

  for (const id of GATES) {
    for (const row of rows) {
      const stands = row.skips.includes(id);
      it(`${id}: ${stands ? "skips" : "still gates"} \`${row.name}\``, () => {
        const out = acrossShells((shell) => homeRun(shell, id, row.build));
        expect(out.skipped).toBe(stands);
        if (stands) {
          // No stdout leak under either shell (a redeclared `local` prints in zsh).
          expect(out.run.stdout).toBe("");
          expect(out.run.status).toBe(0);
          expect(out.scans).toBe(0);
        } else if (id === "quality-gate") {
          expect(out.run.stderr).toContain("running quality-gate fast");
        }
      });
    }
  }
});
