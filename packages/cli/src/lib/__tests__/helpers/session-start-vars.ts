import { interpolate } from "../../render/interpolate.ts";
import type { NavoriConfig } from "../../config/config.ts";

/**
 * Resolves the two `harness.sessionState`-driven placeholders of the SessionStart
 * hook exactly as the render does (#1579), so a test that installs the raw asset
 * by hand gets a parseable script. `sessionState` defaults to on (key absent).
 */
export function sessionStartVars(sessionState?: boolean): {
  progressFiles: string;
  compactSummaryTail: string;
} {
  const config = (sessionState === undefined
    ? {}
    : { harness: { sessionState } }) as unknown as NavoriConfig;
  return {
    progressFiles: interpolate("{{navori.progressFiles}}", config),
    compactSummaryTail: interpolate("{{navori.compactSummaryTail}}", config),
  };
}
