import type { DetectedProject } from "./detect.ts";

/**
 * Build a reasonable quality-gate fallback for `init --recommended` when
 * `guessQualityGate` couldn't infer one from package.json scripts. Avoids
 * leaving 27+ visible `<not configured: qualityGate.*>` placeholders in the
 * rendered harness.
 *
 * Strategy (most specific first):
 *   - TypeScript (tsconfig.json or `typescript` dep): run the local `tsc` via
 *     the detected package manager's binary runner (see `tscCommandFor`).
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
    const cmd = tscCommandFor(detected.packageManager);
    return { fast: cmd, full: cmd };
  }
  return null;
}

/**
 * Command that runs the project-local `tsc --noEmit` under the given package
 * manager. `pnpm`/`yarn`/`bun` resolve a `node_modules/.bin` binary from a bare
 * `<pm> tsc` invocation, but **`npm` does not** (`npm tsc` → "Unknown command"),
 * so npm must go through `npx`. Defaults to pnpm when the PM is undetected. #88.
 */
function tscCommandFor(pm: DetectedProject["packageManager"]): string {
  if (pm === "npm") return "npx tsc --noEmit";
  return `${pm ?? "pnpm"} tsc --noEmit`;
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
 * Cost-aware per-agent model profile for `init --recommended` / `--full` and the
 * wizard. Without it every subagent inherits the session model (typically Opus),
 * so mechanical work — implementing a planned change, mapping a directory, drafting
 * a commit — runs on the priciest tier. This assigns models by the nature of the
 * work: judgement-heavy roles stay on `opus`, code/synthesis roles drop to `sonnet`
 * (~40% cheaper per token, near-Opus on coding), and read-only/mechanical roles drop
 * to `haiku` (~80% cheaper). It's written explicitly into navori.config.json so it's
 * visible and overridable per repo, not a hidden default. Roughly a third of a
 * subagent-heavy workload's token cost, reclaimed with no loss of quality where it
 * matters (the orchestrator and reviewer keep their tier).
 */
export const RECOMMENDED_MODELS = {
  leader: "opus",
  implementer: "sonnet",
  reviewer: "sonnet",
  researcher: "sonnet",
  ticketAudit: "sonnet",
  auditor: "sonnet",
  explorer: "haiku",
  commitPrPilot: "haiku",
} as const;

/**
 * Reasoning-effort profile, aligned with RECOMMENDED_MODELS by tier. Claude Code
 * defaults every agent to the session effort (`xhigh`), so without this each
 * subagent over-deliberates on mechanical work. Judgement roles (the orchestrator)
 * keep `xhigh`; code/synthesis roles drop to `medium` (the quality/cost sweet spot);
 * read-only/mechanical roles drop to `low` (fewest, most-consolidated tool calls,
 * terse output). `leader`'s value also drives `settings.json`'s `effortLevel` so the
 * main-loop orchestrator actually runs at that tier — see buildClaudeSettings.
 */
export const RECOMMENDED_EFFORT = {
  leader: "xhigh",
  implementer: "medium",
  reviewer: "medium",
  researcher: "medium",
  ticketAudit: "medium",
  auditor: "medium",
  explorer: "low",
  commitPrPilot: "low",
} as const;

/**
 * Enable every known plugin for `init --full`. Unlike `--recommended` (which is
 * conservative and only adds `gh` when there's a GitHub remote), full mode turns
 * on all plugins in navori.config.json — including the ones that need an external
 * binary (jscpd/semgrep/gh/acli). A missing binary is surfaced by
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
