import type { NavoriConfig } from "./schema.ts";
import { listKnownPluginIds, loadPlugin } from "./plugins.ts";
import { isGitHubRepo } from "./git.ts";

/**
 * Plugin ids for external providers (tgrep, codegraph, semgrep, jscpd, acli,
 * gh…) that exist and could be enabled, but currently aren't (#981). A single
 * criterion shared by `add --suggest` and `doctor`'s "available, not enabled"
 * section so the two surfaces can never disagree about what counts as a
 * provider: `manifest.externalTool != null`, excluding `engram` (always-on,
 * never a user choice) and anything already `enabled: true`.
 *
 * `gh` is additionally gated on `isGitHubRepo` — the same signal
 * `init --recommended` already uses to auto-enable it, reused here (not
 * re-derived) so suggesting it in a non-GitHub repo never happens on either
 * surface. codegraph/tgrep/semgrep/jscpd/acli have no equivalent repo signal
 * today, so they are always listed when not enabled (D04: offer, never
 * auto-enable).
 */
export function listAvailableExternalProviders(config: NavoriConfig, cwd: string): string[] {
  const enabled = new Set(
    Object.entries(config.plugins ?? {})
      .filter(([, v]) => v.enabled === true)
      .map(([k]) => k),
  );
  return listKnownPluginIds().filter((id) => {
    if (id === "engram" || enabled.has(id)) return false;
    if (id === "gh" && !isGitHubRepo(cwd)) return false;
    try {
      return loadPlugin(id).manifest.externalTool != null;
    } catch {
      return false;
    }
  });
}
