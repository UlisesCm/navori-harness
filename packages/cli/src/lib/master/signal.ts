/**
 * The "mode" signal `navori master init` reports (R15): commit count, first
 * commit date and files changed since it (from `git`), plus framework and
 * libraries from `detectProject(cwd).stack` (the same entry point
 * `lib/diagnose/scan.ts` uses). No git or no code returns `null` in the git
 * fields and never throws (R19) — the suggestion thresholds live only here
 * (design.md "Otras decisiones").
 */
import { execFileSync } from "node:child_process";
import { detectProject } from "../diagnose/detect.ts";
import type { MasterMode } from "./schema.ts";

export interface MasterSignal {
  commits: number | null;
  firstCommit: string | null;
  filesChangedSinceFirst: number | null;
  framework: string | null;
  libraries: string[];
  suggested: MasterMode;
}

/** [assumed] Umbrales de la sugerencia de modo (design.md "Preguntas
 * abiertas"): recalibrar con los primeros planes maestros reales. */
const TEMPLATE_MAX_COMMITS = 5;
const TEMPLATE_MAX_FILES_CHANGED = 20;

function git(cwd: string, args: string[]): string | null {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim();
  } catch {
    return null;
  }
}

/** Computes the mode signal for `cwd`. Pure best-effort: any missing git
 * history or code degrades individual fields to `null`/`[]`, never throws. */
export function computeSignal(cwd: string): MasterSignal {
  const stack = detectProject(cwd).stack;
  const framework = stack.framework ?? null;
  const libraries = [...stack.deps];

  const commitsRaw = git(cwd, ["rev-list", "--count", "HEAD"]);
  const commits = commitsRaw !== null && commitsRaw !== "" ? Number(commitsRaw) : null;

  let firstCommit: string | null = null;
  let firstCommitSha: string | null = null;
  if (commits !== null) {
    // `git log --reverse -1` is a known trap: `-1` limits the walk (newest
    // first) BEFORE `--reverse` flips the output, so it returns HEAD, not the
    // root commit. List the full reversed history and take its first line
    // instead.
    const reversed = git(cwd, ["log", "--reverse", "--format=%H"]);
    const sha = reversed?.split("\n")[0] ?? null;
    if (sha) {
      firstCommitSha = sha;
      firstCommit = git(cwd, ["show", "-s", "--format=%cs", sha]);
    }
  }

  let filesChangedSinceFirst: number | null = null;
  if (firstCommitSha) {
    const diffOut = git(cwd, ["diff", "--name-only", `${firstCommitSha}..HEAD`]);
    filesChangedSinceFirst = diffOut === null || diffOut === "" ? 0 : diffOut.split("\n").length;
  }

  const suggested: MasterMode =
    commits === null || filesChangedSinceFirst === null
      ? "template"
      : commits <= TEMPLATE_MAX_COMMITS && filesChangedSinceFirst <= TEMPLATE_MAX_FILES_CHANGED
        ? "template"
        : "en-curso";

  return { commits, firstCommit, filesChangedSinceFirst, framework, libraries, suggested };
}
