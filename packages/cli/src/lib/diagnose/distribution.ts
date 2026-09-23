/**
 * The distribution axis: is the harness on disk the one git SHARES? (#778)
 *
 * Every other health check in navori answers a single question — "does the disk
 * match the core / the CLI?" — and `scanManagedDrift`, `check-render.mjs` and
 * the version stamp answer it exhaustively. None of them looks at git beyond
 * "is this path tracked", so a harness that was rendered and never committed,
 * committed and never pushed, or pushed onto a branch the base never merged is
 * INVISIBLE to all of them.
 *
 * The cost of that blind spot is measured, not hypothetical: a repo was audited
 * for two weeks on "1,495 searches routed the wrong way" while its harness lived
 * in 55 staged-but-uncommitted files and a branch with no remote counterpart.
 * Every existing check was green the whole time, because every existing check
 * compares the disk against something that also lives on that one machine. The
 * one command that would have said so on day one is
 * `git diff --stat origin/develop -- .claude CLAUDE.md navori.config.json`, and
 * nothing ran it.
 *
 * Four questions, one per git hop:
 *   1. working tree ↔ HEAD     — rendered, never committed
 *   2. HEAD ↔ its own upstream — committed, never pushed
 *   3. working tree ↔ base     — the base branch shares a different harness
 *   4. base → HEAD             — the base moved and this checkout stayed behind
 *
 * NO NETWORK, by the same rule the rest of doctor follows: only refs git already
 * fetched. A `git fetch` here would turn an inspection command into one that
 * mutates the repo's refs and can hang on a credential prompt — so a base branch
 * that was never fetched simply reports what the local ref knows, and a repo with
 * no remote falls back to the local base branch.
 *
 * Advisory by construction: it feeds neither the health verdict nor an exit
 * code. Committing, pushing and merging are the user's acts, and a PR branch
 * that legitimately carries harness changes the base has not merged yet is a
 * normal state, not a defect — what the report adds is that it is now STATED,
 * with the version on each side, instead of being something nobody ever asked.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NavoriConfig } from "../config.ts";
import { engineOwnedPaths } from "./health.ts";
import { readNavoriOwnership } from "../json-ownership.ts";

/** The config file itself: rendered output does not own it, git still shares it. */
const CONFIG_FILE = "navori.config.json";

/** Where the `$navori.version` stamp of a rendered harness lives. */
const SETTINGS_FILE = ".claude/settings.json";

/** Commits on the base branch that HEAD lacks, and the files they moved. */
export interface BaseDivergence {
  /** The ref that was compared against, as it will be printed (`origin/main`). */
  ref: string;
  /** Harness files differing between the working tree and that ref. */
  files: number;
  /** `$navori.version` of the harness on disk — null when none was rendered. */
  localVersion: string | null;
  /** `$navori.version` the base branch publishes — null when it ships none. */
  baseVersion: string | null;
  /** Commits touching harness paths that the base has and HEAD does not. */
  behind: number;
}

export interface DistributionReport {
  /** Tracked harness paths with uncommitted changes, sorted. */
  uncommitted: string[];
  /** Local commits touching harness paths that the upstream branch lacks.
   *  Null when the branch has no upstream — nothing to compare, no noise. */
  unpushed: { commits: number; upstream: string } | null;
  /** How the base branch's harness differs. Null when it matches, when HEAD IS
   *  the base, or when no base ref resolves locally. */
  base: BaseDivergence | null;
}

/**
 * Report the git-side divergences of this repo's harness, or null when there is
 * nothing to say.
 *
 * Null — and therefore complete silence in doctor/status — in four cases, each
 * deliberate:
 *   - `gitignoreHarness` is not `"off"`: navori itself ignores the harness here,
 *     so "git does not share it" is the configured intent, not a finding;
 *   - the directory is not a git work tree;
 *   - git tracks NO harness path (a repo whose policy keeps `.claude/` out of
 *     version control by hand — the Bonum case — where every path would
 *     otherwise be reported as untracked, which is exactly the noise this check
 *     must not produce);
 *   - all four questions come back clean.
 */
export function scanDistribution(cwd: string, config: NavoriConfig): DistributionReport | null {
  if ((config.gitignoreHarness ?? "off") !== "off") return null;
  if (git(cwd, ["rev-parse", "--is-inside-work-tree"]) !== "true") return null;

  const paths = harnessPaths(cwd, config);
  if (paths.length === 0) return null;

  const uncommitted = uncommittedPaths(cwd, paths);
  const unpushed = unpushedCommits(cwd, paths);
  const base = baseDivergence(cwd, config, paths);

  if (uncommitted.length === 0 && unpushed === null && base === null) return null;
  return { uncommitted, unpushed, base };
}

/**
 * The repo-relative paths git is asked about, derived from `ENGINE_OUTPUTS` via
 * `engineOwnedPaths` plus the config file — never a hardcoded list, so an engine
 * that gains an output directory is covered here the day it is added to that
 * table rather than the day somebody remembers this file.
 *
 * Only what git TRACKS survives the filter, and that is the gate for the whole
 * scan: the question is what git SHARES, and a path it never took into the index
 * is shared by nobody. It also keeps the check silent in a repo that excludes
 * the harness by hand, where every path would come back as an untracked `??`.
 */
function harnessPaths(cwd: string, config: NavoriConfig): string[] {
  const candidates = new Set<string>([CONFIG_FILE]);
  for (const engine of config.engines) {
    for (const path of engineOwnedPaths(engine)) candidates.add(path);
  }
  return [...candidates].filter((path) => tracksPath(cwd, path)).sort();
}

/** Tracked harness paths the working tree has modified, staged or not. */
function uncommittedPaths(cwd: string, paths: string[]): string[] {
  // RAW, not trimmed: porcelain v1 spells an unstaged modification `" M path"`,
  // and trimming the whole output eats that leading space — which silently
  // shifted the first row's path by one character (`LAUDE.md`). Caught by the
  // fixture, not by review, which is why these tests drive real repos.
  const out = gitRaw(cwd, ["status", "--porcelain", "--", ...paths]);
  if (!out) return [];
  const found = new Set<string>();
  for (const line of out.split("\n")) {
    // `XY <path>` — and for a rename, `XY <old> -> <new>`. The destination is
    // the one that exists now, which is the path a reader would go look at.
    const rest = line.slice(3).trim();
    if (!rest) continue;
    const arrow = rest.lastIndexOf(" -> ");
    found.add(unquote(arrow === -1 ? rest : rest.slice(arrow + 4)));
  }
  return [...found].sort();
}

/**
 * Local commits touching harness paths that this branch's upstream lacks.
 *
 * Skipped without a sound when the branch has no upstream: `@{u}` then fails,
 * and a branch nobody has pushed yet is the normal state of work in progress,
 * not a divergence to report. The case worth naming — a harness branch that
 * never reached the remote at all — surfaces through the base comparison below.
 */
function unpushedCommits(
  cwd: string,
  paths: string[],
): { commits: number; upstream: string } | null {
  const upstream = git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!upstream) return null;
  const count = Number(git(cwd, ["rev-list", "--count", "@{u}..HEAD", "--", ...paths]));
  if (!Number.isFinite(count) || count === 0) return null;
  return { commits: count, upstream };
}

/** How the base branch's harness differs from this working tree. */
function baseDivergence(cwd: string, config: NavoriConfig, paths: string[]): BaseDivergence | null {
  const ref = resolveBaseRef(cwd, config);
  if (!ref) return null;

  // The WORKING TREE against the base, not HEAD against the base. That is the
  // distinction the backend case turns on: its 0.8.6 render sat staged on a
  // branch pointing at the same commit as `origin/dev`, so every HEAD-to-HEAD
  // comparison said "identical" while the disk ran a harness three minors ahead
  // of everything the team shared.
  const diff = git(cwd, ["diff", "--name-only", ref, "--", ...paths]);
  const files = diff ? diff.split("\n").filter(Boolean).length : 0;
  const behindRaw = Number(git(cwd, ["rev-list", "--count", `HEAD..${ref}`, "--", ...paths]));
  const behind = Number.isFinite(behindRaw) ? behindRaw : 0;
  if (files === 0 && behind === 0) return null;

  const localVersion = localHarnessVersion(cwd);
  const baseVersion = refHarnessVersion(cwd, ref);
  // When HEAD IS the base commit, this row's file list is the uncommitted row's,
  // word for word — so it only earns its place when the version pair adds
  // something, which is the whole reason the row reports two versions.
  const sameCommit = git(cwd, ["rev-parse", "HEAD"]) === git(cwd, ["rev-parse", ref]);
  if (sameCommit && localVersion === baseVersion) return null;

  return { ref, files, localVersion, baseVersion, behind };
}

/**
 * The ref the harness is distributed THROUGH, preferring what the remote holds.
 *
 * `origin/<branchBase>` first: the base as the team sees it is the remote-tracking
 * ref, and comparing against a local `main` that is itself months stale answers a
 * question nobody asked. The local branch is the fallback for a repo with no
 * remote, and `origin/HEAD` the fallback for a config with no `branchBase` —
 * the same ref `detect.ts` already reads to guess one, and for the same reason:
 * it is on disk and costs no network.
 */
function resolveBaseRef(cwd: string, config: NavoriConfig): string | null {
  const candidates: string[] = [];
  const declared = config.branchBase?.trim();
  if (declared) candidates.push(`origin/${declared}`, declared);
  const originHead = git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead) candidates.push(originHead);
  for (const ref of candidates) {
    if (git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) return ref;
  }
  return null;
}

/** `$navori.version` of the harness on disk, or null when none was rendered. */
function localHarnessVersion(cwd: string): string | null {
  const path = join(cwd, SETTINGS_FILE);
  if (!existsSync(path)) return null;
  try {
    return readNavoriOwnership(readFileSync(path, "utf-8"))?.version ?? null;
  } catch {
    return null;
  }
}

/** `$navori.version` as `ref` publishes it — the other half of the comparison
 *  that makes "the base has a different harness" an actionable sentence rather
 *  than a file count. Null when that ref ships no settings file at all. */
function refHarnessVersion(cwd: string, ref: string): string | null {
  const raw = git(cwd, ["show", `${ref}:${SETTINGS_FILE}`]);
  if (!raw) return null;
  return readNavoriOwnership(raw)?.version ?? null;
}

/** True when git tracks at least one file under `path`. */
function tracksPath(cwd: string, path: string): boolean {
  return git(cwd, ["ls-files", "--", path]) !== null;
}

/**
 * Run one read-only git command and return its stdout VERBATIM, or null when
 * git failed, was absent, or said nothing.
 *
 * One runner rather than a helper per question: every call here is the same
 * shape, and a non-zero exit is never an error worth surfacing — a repo with no
 * upstream, no base ref or no remote is a repo with less to report, not a broken
 * one. `stdio` keeps stderr off the terminal for exactly that reason.
 *
 * NONE of these commands touches the network. That is a property of the command
 * SET, not of a flag: `status`, `rev-list`, `rev-parse`, `diff`, `show`,
 * `ls-files` and `symbolic-ref` all answer from the object store. Adding a
 * `fetch` or an `ls-remote` here would break doctor's read-only contract and
 * could hang on a credential prompt.
 */
function gitRaw(cwd: string, args: string[]): string | null {
  try {
    const out = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    });
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/** {@link gitRaw} trimmed — for the calls that read ONE value (a sha, a ref, a
 *  count), where surrounding whitespace is never data. */
function git(cwd: string, args: string[]): string | null {
  const out = gitRaw(cwd, args)?.trim();
  return out ? out : null;
}

/** `git status --porcelain` quotes a path holding non-ASCII or spaces. */
function unquote(path: string): string {
  return path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path;
}
