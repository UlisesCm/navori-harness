import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getPluginPath, getCoreRoot } from "../bundled-assets.ts";
import { interpolate } from "../interpolate.ts";
import { expandHookIncludes } from "../hook-includes.ts";
import type { NavoriConfig } from "../config.ts";
import { acrossShells, type HookShell } from "./helpers/shells.ts";

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
 */
function setupFixture(scanExit = 1): Fixture {
  // realpath, not the raw mkdtemp path: on macOS mkdtemp hands back `/var/…`
  // while git reports `/private/var/…`, and the hook's messages quote git's.
  const main = realpathSync(mkdtempSync(join(tmpdir(), "navori-454-main-")));
  writeFileSync(join(main, "a.ts"), "export const a = 1;\n");
  git(main, "init", "-q");
  git(main, "add", "a.ts");
  git(main, "commit", "-q", "--no-verify", "-m", "base");
  // `git init -b main` needs git >= 2.28; renaming after the first commit works
  // on every version the harness supports.
  git(main, "branch", "-M", "main");
  const baseSha = git(main, "rev-parse", "main").trim();
  const baseShort = git(main, "rev-parse", "--short", baseSha).trim();

  const worktree = join(realpathSync(mkdtempSync(join(tmpdir(), "navori-454-wt-"))), "wt");
  git(main, "worktree", "add", "-q", "-b", "feature", worktree, "main");
  // The diff the gate must see: it exists ONLY in the worktree.
  writeFileSync(join(worktree, "a.ts"), "export const a = 2;\n");

  const binDir = join(main, "fakebin");
  mkdirSync(binDir);
  const log = join(main, "invocations.log");
  for (const tool of ["semgrep", "jscpd"]) {
    const stub = join(binDir, tool);
    writeFileSync(
      stub,
      `#!/usr/bin/env bash\nprintf '%s %s\\n' ${JSON.stringify(tool)} "$*" >> ${JSON.stringify(log)}\nexit ${scanExit}\n`,
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
  const foreign = realpathSync(mkdtempSync(join(tmpdir(), "navori-454-other-")));
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
  // main". The stub exits 1, so reaching the scanner at all is observable.
  it("semgrep BLOCKS a commit whose diff lives in an agent worktree", () => {
    const out = acrossShells((shell) => {
      const fx = setupFixture(1);
      const run = normalize(fx, runHook(fx, shell, "semgrep", "git commit -m x", fx.worktree));
      return { run, scans: invocations(fx).length };
    });

    expect(out.run.status).toBe(1);
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

    expect(out.run.status).toBe(1);
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

    expect(out.run.status).toBe(1);
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

    expect(out.run.status).toBe(1);
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
 * that the scanner RAN over the tree the commit acts on (invocations are
 * counted, and the stub exits 1 so reaching it also shows in the status) and
 * that the foreign tree is never announced.
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
    expect(out.run.status).toBe(1);
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
    expect(out.run.status).toBe(1);
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
    expect(out.run.status).toBe(1);
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
    expect(out.run.status).toBe(1);
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
    expect(out.run.status).toBe(1);
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
    expect(out.run.status).toBe(1);
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

    expect(out.status).toBe(2);
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
