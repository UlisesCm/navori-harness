import type { DetectedProject } from "./detect.ts";

/**
 * Build a reasonable quality-gate fallback for `init --recommended` when
 * `guessQualityGate` couldn't infer one from package.json scripts. Avoids
 * leaving 27+ visible `<not configured: qualityGate.*>` placeholders in the
 * rendered harness.
 *
 * Strategy (most specific first):
 *   - TypeScript (tsconfig.json or `typescript` dep): `<pm> tsc --noEmit`
 *   - Otherwise: null (warn instead of writing a noisy command)
 *
 * The python/rust paths are already handled inside `guessQualityGate` itself,
 * so this fallback only fires when the user has a JS/TS package.json without
 * the common script names.
 */
export function buildRecommendedQualityGate(
  detected: DetectedProject,
): { fast: string; full: string } | null {
  if (detected.stack.language === "ts") {
    const pm = detected.packageManager ?? "pnpm";
    const cmd = `${pm} tsc --noEmit`;
    return { fast: cmd, full: cmd };
  }
  return null;
}

/**
 * Build a minimal `project` block for `init --recommended` so the rendered
 * agents don't show `<not configured: project.criticalAreas>` etc. The arrays
 * are empty by design — we can't infer them — but the empty arrays interpolate
 * to "" instead of the noisy placeholder text. `testRunner` is inferred from
 * detected stack (vitest/jest/playwright/etc).
 *
 * The user can fill `legacyPaths` / `criticalAreas` later via
 * `navori configure project` once they know the repo specifics.
 */
export function buildRecommendedProject(
  detected: DetectedProject,
): { legacyPaths: string[]; criticalAreas: string[]; testRunner?: string } {
  return {
    legacyPaths: [],
    criticalAreas: [],
    ...(detected.stack.test ? { testRunner: detected.stack.test } : {}),
  };
}

/**
 * Enable every known plugin for `init --full`. Unlike `--recommended` (which is
 * conservative and only adds `gh` when there's a GitHub remote), full mode turns
 * on all plugins in navori.config.json — including the ones that need an external
 * binary (jscpd/semgrep/cognitive/gh/acli). A missing binary is surfaced by
 * `doctor` as a non-fatal yellow warning (never flips its exit code); that's the
 * accepted trade-off for a maximal install.
 *
 * `pluginIds` must come from `listKnownPluginIds()` (bundled-aware) so full mode
 * only enables plugins actually shipped in this install — never a stale static-map
 * id that would render as a missing plugin and fail `doctor --strict`.
 */
export function buildFullPlugins(pluginIds: string[]): Record<string, { enabled: boolean }> {
  const result: Record<string, { enabled: boolean }> = {};
  for (const id of pluginIds) {
    result[id] = { enabled: true };
  }
  return result;
}

/**
 * Build a strict `project` block for `init --full`. Extends the recommended
 * baseline (empty legacyPaths/criticalAreas + detected testRunner) with an
 * opinionated posture for a production-grade harness. `architectureRule` stays
 * unset on purpose — it's repo-specific and full mode never invents it.
 */
export function buildFullProject(detected: DetectedProject): {
  legacyPaths: string[];
  criticalAreas: string[];
  testRunner?: string;
  posture: string;
  reviewRigor: string;
  testsForNewCode: string;
} {
  return {
    ...buildRecommendedProject(detected),
    posture: "production",
    reviewRigor: "strict",
    testsForNewCode: "always",
  };
}
