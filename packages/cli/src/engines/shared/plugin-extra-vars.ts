import type { NavoriConfig } from "../../lib/config/config.ts";

/**
 * `extraVars` every plugin asset render needs, computed once and reused by
 * both scripts and skill-extension renders across every engine (#1055). A
 * plugin value derived from config (not a declared schema field) has no
 * other channel into `interpolate` — `resolvePath` only walks `NavoriConfig`
 * itself for declared fields, so a derived value MUST arrive through
 * `extraVars` or every render call site has to know how to compute it
 * independently (and, before this, four of five forgot to).
 *
 * No plugin currently needs a derived value here (jscpd's own
 * `jscpdThreshold` was retired with #1060, since the gate now blocks on new
 * clones rather than on a duplication percentage). The function — and the
 * six render call sites that call it — stays wired on purpose: it is the
 * single seam future plugins use for this, and removing it would reproduce
 * the "four of five forgot" bug #1057 just fixed the day before this ticket.
 */
export function pluginExtraVars(_config: NavoriConfig): Record<string, string> {
  return {};
}
