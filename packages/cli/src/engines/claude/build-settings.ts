import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { NavoriConfig } from "../../lib/config.ts";
import type { LoadedPlugin, PluginHookEntry } from "../../lib/plugins.ts";
import { getCoreRoot, readBundledCoreVersion } from "../../lib/bundled-assets.ts";
import { interpolate } from "./interpolate.ts";
import { deepMerge } from "./deep-merge.ts";

/**
 * Build the final `.claude/settings.json` object the engine adapter will
 * write. Pure (no file writes); returns a plain object so the caller can
 * JSON.stringify it once.
 *
 * Layering (deep-merged in order):
 *   1. settings-base.json from @navori/core (interpolated with coreVersion).
 *      Ships permissions.allow (read-only git + file inspection + the native
 *      Read/Glob/Grep tools, so trivial reads don't prompt), .ask
 *      (destructive-but-legit) and .deny (catastrophic, no-legit-use) rules.
 *   1b. Defensive guard PreToolUse(Bash) hook — always registered, references
 *      `.claude/hooks/guard-destructive.sh`. Exit 2 precedes permission rules.
 *   2. Quality-gate PreToolUse hook, only if `config.qualityGate.fast` is
 *      set. The hook entry references `.claude/hooks/quality-gate-pre-commit.sh`
 *      (rendered separately by the file pipeline).
 *   3. For each enabled plugin: `settingsFragment` and `hooks[]` translated
 *      from the flat manifest shape into Claude Code's nested
 *      `hooks.<Event>[].{matcher, hooks[]}` shape.
 *
 * Arrays concat-dedupe via `deepMerge`, so the same hook contributed twice
 * (or shipped by two plugins) collapses to one entry.
 */

const QG_HOOK_DEST = ".claude/hooks/quality-gate-pre-commit.sh";
const GUARD_HOOK_DEST = ".claude/hooks/guard-destructive.sh";
const SETTINGS_BASE_REL = "core-assets/settings/settings-base.json";

export function buildClaudeSettings(
  config: NavoriConfig,
  plugins: LoadedPlugin[],
): Record<string, unknown> {
  const basePath = resolve(getCoreRoot(), SETTINGS_BASE_REL);
  const baseRaw = readFileSync(basePath, "utf-8");
  const baseInterp = interpolate(baseRaw, config, {
    extraVars: { coreVersion: readBundledCoreVersion() },
  });
  let settings = JSON.parse(baseInterp) as Record<string, unknown>;

  // Defensive guard hook — always registered (unlike the quality gate, it has
  // no config dependency). Exit 2 here precedes permission rules, so it's the
  // hard backstop for destructive patterns static deny globs can't catch.
  settings = deepMerge(settings, {
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: `bash ${GUARD_HOOK_DEST}`,
              timeout: 10,
              statusMessage: "navori: guard-destructive",
            },
          ],
        },
      ],
    },
  });

  if (config.qualityGate?.fast) {
    settings = deepMerge(settings, {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: `bash ${QG_HOOK_DEST}`,
                timeout: 180,
                statusMessage: "navori: quality-gate fast",
              },
            ],
          },
        ],
      },
    });
  }

  for (const plugin of plugins) {
    const fragment = plugin.manifest.settingsFragment;
    if (fragment && typeof fragment === "object" && !Array.isArray(fragment)) {
      settings = deepMerge(settings, fragment as Record<string, unknown>);
    }
    if (plugin.manifest.hooks && plugin.manifest.hooks.length > 0) {
      settings = deepMerge(settings, {
        hooks: pluginHooksToClaudeShape(plugin.manifest.hooks),
      });
    }
  }

  // The guard (1b), quality-gate (2) and plugin hooks each deep-merge their own
  // `{matcher:"Bash", hooks:[...]}`, which concat into redundant matcher buckets
  // (e.g. two `matcher:"Bash"` entries → a Bash command pays two matcher
  // evaluations). Collapse buckets sharing an event+matcher into one so Claude
  // sees a single bucket per matcher — same intent as pluginHooksToClaudeShape,
  // now across all layers.
  return coalesceHookMatchers(settings);
}

/**
 * Merge hook entries that share an event + matcher into a single bucket,
 * deduping identical hook commands. Non-standard entries (no `hooks[]` array)
 * pass through untouched. Order is preserved by first appearance.
 */
function coalesceHookMatchers(settings: Record<string, unknown>): Record<string, unknown> {
  const hooks = settings.hooks;
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) return settings;

  const coalesced: Record<string, unknown> = {};
  for (const [event, entries] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(entries)) {
      coalesced[event] = entries;
      continue;
    }
    const buckets: Array<{ matcher?: string; hooks: unknown[] }> = [];
    const passthrough: unknown[] = [];
    for (const entry of entries) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        !Array.isArray((entry as { hooks?: unknown }).hooks)
      ) {
        passthrough.push(entry);
        continue;
      }
      const e = entry as { matcher?: string; hooks: unknown[] };
      const existing = buckets.find((b) => b.matcher === e.matcher);
      if (existing) {
        const seen = new Set(existing.hooks.map((h) => JSON.stringify(h)));
        for (const h of e.hooks) {
          if (!seen.has(JSON.stringify(h))) existing.hooks.push(h);
        }
      } else {
        buckets.push({ ...(e.matcher !== undefined ? { matcher: e.matcher } : {}), hooks: [...e.hooks] });
      }
    }
    coalesced[event] = [...buckets, ...passthrough];
  }
  return { ...settings, hooks: coalesced };
}

/**
 * Translate the flat plugin-manifest hook entries to Claude Code's nested
 * structure. Entries sharing an event + matcher are grouped under one
 * outer object so Claude doesn't see redundant matcher buckets.
 */
function pluginHooksToClaudeShape(
  entries: PluginHookEntry[],
): Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>> {
  const grouped: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>> = {};
  for (const h of entries) {
    const inner: Record<string, unknown> = { type: "command", command: h.command };
    if (h.timeout !== undefined) inner.timeout = h.timeout;
    if (h.statusMessage !== undefined) inner.statusMessage = h.statusMessage;

    const eventBucket = (grouped[h.event] ??= []);
    let matcherEntry = eventBucket.find((e) => e.matcher === h.matcher);
    if (!matcherEntry) {
      matcherEntry = h.matcher !== undefined ? { matcher: h.matcher, hooks: [] } : { hooks: [] };
      eventBucket.push(matcherEntry);
    }
    matcherEntry.hooks.push(inner);
  }
  return grouped;
}
