/**
 * Weights and thresholds for `navori plan classify` — the SINGLE module that
 * defines them (R2). Nothing else recomputes a level from scratch: the gate
 * (R16), the reviewer (R21) and the activation miner (R32) all call
 * `classify.ts`, which reads only from here.
 *
 * Calibrated 2026-09-23 (#1011, T0) against 14 real commits (8 from
 * navori-harness, 6 from Bonum repos) with their expected level agreed with
 * the user beforehand. 13/14 fixtures match these weights; the one mismatch
 * (`dc5d73b0`) is a known gap in `source-classify.ts`, not a weight problem —
 * see `lib/plan/__tests__/classify.test.ts` for the full calculation.
 */

/** A floor forces the task to at least this level, regardless of the score. */
export const FLOOR_LEVEL = 2;

/**
 * Signals that force `FLOOR_LEVEL`, independent of the numeric score (R3).
 * Critical area is deliberately NOT in this list: the user's calibration
 * (#1011) demoted it from a floor to an additive weight (`CRITICAL_AREA_WEIGHT`)
 * because area alone, without one of these, does not justify skipping straight
 * to a design pass.
 */
export const FLOOR_SIGNALS = [
  "money-credentials-pii",
  "multi-repo",
  "new-external-dependency",
  "shared-contract",
  "data-schema-migration",
] as const;
export type FloorSignal = (typeof FLOOR_SIGNALS)[number];

/** Additive weight when the task touches `project.criticalPaths` or the
 * orchestrator declares it — no longer a floor (calibration override, #1011). */
export const CRITICAL_AREA_WEIGHT = 3;

/** Additive weight for a bug worked without a confirmed root cause. */
export const BUG_WITHOUT_ROOT_CAUSE_WEIGHT = 2;

/** The ceiling a `classify` score is truncated to before deriving a level. */
export const MAX_SCORE = 10;

/** Non-trivial file count (`source-classify`'s ceiling) → additive weight. */
export function nonTrivialFileWeight(ceiling: number): number {
  if (ceiling <= 1) return 0;
  if (ceiling <= 3) return 2;
  if (ceiling <= 7) return 3;
  return 4;
}

/** Distinct root directories touched → additive weight. Root directory = the
 * first two path segments relative to the repo (e.g. `src/pages`,
 * `packages/cli`), per the user's calibration (#1011). */
export function rootDirWeight(distinctRootDirs: number): number {
  if (distinctRootDirs <= 1) return 0;
  if (distinctRootDirs === 2) return 1;
  return 2;
}

/** Level-0 exemption (R4): at most this score AND at most this many
 * non-trivial files, and no floor signal present. */
export const LEVEL_ZERO_MAX_SCORE = 3;
export const LEVEL_ZERO_MAX_NONTRIVIAL_FILES = 1;

/** Level-2 threshold on score alone, absent a floor (R5). */
export const LEVEL_TWO_MIN_SCORE = 8;
