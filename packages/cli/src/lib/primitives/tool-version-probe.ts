import { execFileSync } from "node:child_process";
import type { NavoriConfig } from "../config/config.ts";
import { loadPlugin, type PluginExternalTool } from "../config/plugins.ts";
import { currentPlatform } from "../config/platform.ts";
import { hasBinary } from "./which.ts";

/** An enabled plugin's external tool found on PATH with a parseable `--version`. */
export interface InstalledToolVersion {
  pluginId: string;
  binary: string;
  tool: PluginExternalTool;
  installedVersion: string;
  install: string | null;
}

export interface ProbeOptions {
  /**
   * Global wall-clock cap for every `--version` call together (the hook path). Each call gets
   * `min(PER_TOOL_MS, remaining)` and the tools left once it is spent are skipped. Without it
   * each call keeps the interactive 5 s limit.
   */
  budgetMs?: number;
  /** Monotonic clock in ms, injectable for tests. */
  clock?: () => number;
}

const INTERACTIVE_MS = 5000; // best-effort external probe must not hang doctor (#268)
const PER_TOOL_MS = 1000;

/**
 * Shared loop of the pin, advisory and release-notice scans: enabled plugin -> manifest tool
 * with a `checkBinary` -> `wants(tool)` (checked BEFORE `hasBinary`, so a plugin nobody asks
 * about never touches PATH) -> binary on PATH -> first `x.y.z` of `--version`. Absent binary,
 * failing or unparseable `--version` and broken plugins stay silent rather than guess (missing
 * ones are reported by `missingExternalTools` / `missingPlugins`).
 */
export function probeEnabledToolVersions(
  config: NavoriConfig,
  wants: (tool: PluginExternalTool, pluginId: string) => boolean,
  { budgetMs, clock = () => performance.now() }: ProbeOptions = {},
): InstalledToolVersion[] {
  const found: InstalledToolVersion[] = [];
  const platform = currentPlatform();
  const start = clock();
  for (const [id, settings] of Object.entries(config.plugins ?? {})) {
    if (settings.enabled !== true) continue;
    let timeout = INTERACTIVE_MS;
    if (budgetMs !== undefined) {
      const remaining = budgetMs - (clock() - start);
      if (remaining <= 0) break; // budget spent: stay silent about the rest
      timeout = Math.min(PER_TOOL_MS, Math.ceil(remaining));
    }
    try {
      const tool = loadPlugin(id).manifest.externalTool;
      if (!tool?.checkBinary || !wants(tool, id)) continue;
      if (!hasBinary(tool.checkBinary)) continue;
      let raw: string;
      try {
        raw = execFileSync(tool.checkBinary, ["--version"], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout,
        });
      } catch {
        continue; // binary present but --version failed — not this scan's job
      }
      const match = /\d+\.\d+\.\d+/.exec(raw);
      if (!match) continue; // unparseable output — never guess
      found.push({
        pluginId: id,
        binary: tool.checkBinary,
        tool,
        installedVersion: match[0],
        install: (platform ? tool.install?.[platform] : undefined) ?? null,
      });
    } catch {
      // Missing / broken plugin is reported via missingPlugins.
    }
  }
  return found;
}
