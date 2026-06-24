import type { DetectedProject, StackInfo } from "./detect.ts";

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
 * Derive the validator flags a preset uses as skill conditions from the
 * detected stack. Independent of init mode (recommended/wizard/plain): the
 * validator is a fact of the repo's deps, not a user preference, so it's
 * merged into `project` in every path. Returns `{}` when no validator was
 * detected (and for non-Node stacks) so it spreads cleanly.
 */
export function validatorProjectFlags(
  stack: StackInfo,
): { zodValidation: true } | { joiValidation: true } | Record<string, never> {
  if (stack.validator === "zod") return { zodValidation: true };
  if (stack.validator === "joi") return { joiValidation: true };
  return {};
}
