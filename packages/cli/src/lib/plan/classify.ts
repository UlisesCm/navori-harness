/**
 * `navori plan classify` — the only definition of a task's complexity and
 * level (R1). Reuses `source-classify.ts`'s `countNonTrivial` instead of
 * duplicating its file-significance rules (R2's "single module" is about the
 * WEIGHTS, not about re-deriving what counts as a file).
 */
import { countNonTrivial } from "../diagnose/source-classify.ts";
import {
  BUG_WITHOUT_ROOT_CAUSE_WEIGHT,
  CRITICAL_AREA_WEIGHT,
  FLOOR_LEVEL,
  LEVEL_TWO_MIN_SCORE,
  LEVEL_ZERO_MAX_NONTRIVIAL_FILES,
  LEVEL_ZERO_MAX_SCORE,
  MAX_SCORE,
  nonTrivialFileWeight,
  rootDirWeight,
} from "./signals.ts";

/** A level `classify` can derive on its own. Level 3 ("the user accepted a
 * spec", R5) is a manual designation the orchestrator makes — `classify`
 * never returns it. */
export type ClassifyLevel = 0 | 1 | 2;

export interface ClassifyInput {
  /** Repo-relative paths touched by the task ("Archivos"). */
  files: readonly string[];
  /** Declared: the task handles money, credentials or PII (floor, R3). */
  moneyCredentialsPii?: boolean;
  /** Declared: the task spans two or more repos (floor, R3). */
  multiRepo?: boolean;
  /** Declared: the task adds a new external dependency (floor, R3). */
  newExternalDependency?: boolean;
  /** Declared: the task changes a shared contract — API, DTO, schema, event
   * (floor, R3). */
  sharedContract?: boolean;
  /** Declared: the task includes a data or schema migration (floor, R3). */
  dataSchemaMigration?: boolean;
  /** Declared: the task touches a critical area but no `criticalPaths` glob
   * confirms it (additive, calibration override of #1011). Ignored when
   * `files` already matches `criticalPaths`. */
  criticalArea?: boolean;
  /** `project.criticalPaths` globs (R9) to detect critical area from `files`
   * instead of relying on it being declared. */
  criticalPaths?: readonly string[];
  /** Declared: a bug worked without a confirmed root cause. */
  bugWithoutRootCause?: boolean;
  /** `project.localSkills` ids (`navori.config.json`) — forwarded to
   * `countNonTrivial` so a project-local skill's `SKILL.md` counts as
   * hand-authored source instead of the rendered `.claude/` mirror
   * (#1011). */
  localSkillIds?: readonly string[];
}

export interface ClassifyResult {
  score: number;
  level: ClassifyLevel;
  /** Human-readable breakdown, one entry per signal that contributed —
   * shown to the user per R6 and stored in the workplan's `classification`
   * field. */
  signals: string[];
  /** The `source-classify` ceiling this run was computed against. */
  nonTrivialCeiling: number;
}

/**
 * Minimal glob matcher for `project.criticalPaths`: `**` matches zero or more
 * whole path segments, `*` matches any run of characters within ONE segment.
 * Sufficient for the config globs this field is meant to hold
 * (`src/payments/**`, `**\/secrets/*.ts`) — brace expansion and character
 * classes are out of scope (YAGNI, no consumer needs them).
 *
 * Deliberately NOT built on `new RegExp(dynamicString)`: a glob is arbitrary
 * text from `navori.config.json`, and semgrep's
 * `detect-non-literal-regexp` blocks compiling a dynamic pattern into a
 * regex on sight (ReDoS surface). This matches segment-by-segment with plain
 * string operations instead — no backtracking possible.
 */
function matchesSegment(segment: string, pattern: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return segment === pattern;
  const first = parts.at(0) ?? "";
  const last = parts.at(-1) ?? "";
  if (!segment.startsWith(first) || !segment.endsWith(last)) return false;
  const upperBound = segment.length - last.length;
  let cursor = first.length;
  for (const middle of parts.slice(1, -1)) {
    if (middle === "") continue;
    const index = segment.indexOf(middle, cursor);
    if (index === -1 || index > upperBound) return false;
    cursor = index + middle.length;
  }
  return cursor <= upperBound;
}

function matchesGlobSegments(
  pathSegments: readonly string[],
  patternSegments: readonly string[],
): boolean {
  if (patternSegments.length === 0) return pathSegments.length === 0;
  const [head, ...restPattern] = patternSegments;
  if (head === "**") {
    for (let i = 0; i <= pathSegments.length; i++) {
      if (matchesGlobSegments(pathSegments.slice(i), restPattern)) return true;
    }
    return false;
  }
  if (pathSegments.length === 0) return false;
  return (
    matchesSegment(pathSegments[0]!, head!) &&
    matchesGlobSegments(pathSegments.slice(1), restPattern)
  );
}

function matchesCriticalPaths(files: readonly string[], criticalPaths: readonly string[]): boolean {
  if (criticalPaths.length === 0) return false;
  const patterns = criticalPaths.map((glob) => glob.split("/"));
  return files.some((file) => {
    const segments = file.split("/");
    return patterns.some((pattern) => matchesGlobSegments(segments, pattern));
  });
}

function rootDirsOf(files: readonly string[]): Set<string> {
  return new Set(files.map((file) => file.split("/").slice(0, 2).join("/")));
}

/** Computes complexity 0-10 and derives a level from "Señales y pesos"
 * (design.md), calibrated in #1011 (T0). */
export function classify(input: ClassifyInput): ClassifyResult {
  const localSkillIds = input.localSkillIds ? new Set(input.localSkillIds) : undefined;
  const nonTrivial = countNonTrivial(input.files, "", localSkillIds);
  const signals: string[] = [];
  let score = 0;

  const fileWeight = nonTrivialFileWeight(nonTrivial.ceiling);
  if (fileWeight > 0) signals.push(`non-trivial-files:${nonTrivial.ceiling}(+${fileWeight})`);
  score += fileWeight;

  const distinctRootDirs = rootDirsOf(input.files).size;
  const dirWeight = rootDirWeight(distinctRootDirs);
  if (dirWeight > 0) signals.push(`root-dirs:${distinctRootDirs}(+${dirWeight})`);
  score += dirWeight;

  if (input.bugWithoutRootCause) {
    signals.push(`bug-without-root-cause(+${BUG_WITHOUT_ROOT_CAUSE_WEIGHT})`);
    score += BUG_WITHOUT_ROOT_CAUSE_WEIGHT;
  }

  const criticalAreaMatched = matchesCriticalPaths(input.files, input.criticalPaths ?? []);
  const criticalArea = criticalAreaMatched || Boolean(input.criticalArea);
  if (criticalArea) {
    signals.push(
      `critical-area:${criticalAreaMatched ? "matched" : "declared"}(+${CRITICAL_AREA_WEIGHT})`,
    );
    score += CRITICAL_AREA_WEIGHT;
  }

  const floors: string[] = [];
  if (input.moneyCredentialsPii) floors.push("money-credentials-pii");
  if (input.multiRepo) floors.push("multi-repo");
  if (input.newExternalDependency) floors.push("new-external-dependency");
  if (input.sharedContract) floors.push("shared-contract");
  if (input.dataSchemaMigration) floors.push("data-schema-migration");
  for (const floor of floors) signals.push(`floor:${floor}`);

  score = Math.min(score, MAX_SCORE);

  let level: ClassifyLevel;
  if (floors.length > 0) {
    level = FLOOR_LEVEL;
  } else if (
    score <= LEVEL_ZERO_MAX_SCORE &&
    nonTrivial.ceiling <= LEVEL_ZERO_MAX_NONTRIVIAL_FILES
  ) {
    level = 0;
  } else if (score >= LEVEL_TWO_MIN_SCORE) {
    level = 2;
  } else {
    level = 1;
  }

  return { score, level, signals, nonTrivialCeiling: nonTrivial.ceiling };
}
