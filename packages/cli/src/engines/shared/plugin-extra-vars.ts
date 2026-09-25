import type { NavoriConfig } from "../../lib/config/config.ts";

/**
 * Presets whose frontend-heavy codebases (JSX/TSX, generated component
 * boilerplate) tolerate more incidental duplication before jscpd's
 * duplication threshold is relaxed to 10%. Every other preset (backends,
 * workers) keeps the stricter 5% default.
 */
const FRONTEND_PRESETS = new Set([
  "vite-react-ts",
  "vite-react-ts-mantine",
  "nextjs",
  "astro",
  "react-native-expo",
]);

/** jscpd duplication threshold (percent) for a preset — see FRONTEND_PRESETS. */
function jscpdThresholdForPreset(preset: string): number {
  return FRONTEND_PRESETS.has(preset) ? 10 : 5;
}

/**
 * `extraVars` every plugin asset render needs, computed once and reused by
 * both scripts and skill-extension renders across every engine (#1055). A
 * plugin value derived from config (not a declared schema field, e.g.
 * jscpdThreshold) has no other channel into `interpolate` — `resolvePath`
 * only walks `NavoriConfig` itself for declared fields, so a derived value
 * MUST arrive through `extraVars` or every render call site has to know how
 * to compute it independently (and, before this, four of five forgot to).
 */
export function pluginExtraVars(config: NavoriConfig): Record<string, string> {
  return { jscpdThreshold: String(jscpdThresholdForPreset(config.preset)) };
}
