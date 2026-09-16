import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { buildClaudeSettings } from "../engines/claude/build-settings.ts";
import { getCoreRoot, listBundledPluginIds } from "../lib/bundled-assets.ts";
import { loadPlugin } from "../lib/plugins.ts";
import { NavoriConfigSchema, type NavoriConfig } from "../lib/schema.ts";

/**
 * #778 — every hook the harness REGISTERS must be able to say that it ran.
 *
 * The audit log is the only witness a hook has: a hook that runs and lets the
 * action through is invisible to the transcript by construction, which is the
 * whole reason `_partials/audit-log.sh` exists. A registered hook WITHOUT that
 * include is therefore indistinguishable from one that never executes — it
 * cannot lose its `+x` bit, get its path renamed, or be shadowed by another
 * harness in a way anybody would notice.
 *
 * That was not hypothetical. `tgrep-session.sh` shipped without the include and
 * had ZERO recorded executions in every session log of every repo in the park,
 * across weeks. It was found by hand, by crossing the 15 registered hooks
 * against the log — the same accident that found `routing-watch` inert in #767.
 * This test is that cross-check, run on every commit, so the NEXT plugin hook
 * cannot be born invisible.
 *
 * It reads the REGISTRY, not a directory listing: what matters is what
 * `settings.json` wires up, whether it comes from core, from a plugin's
 * `hooks[]`, or from a `settingsFragment` that merges hooks in directly.
 */

/** Hooks exempt from the include, each because it IS the recorder. */
const RECORDER_HOOKS = new Map<string, string>([
  [
    "audit-mode-trigger.sh",
    "writes the `start`/`prompt` records itself — it is the command that CREATES the session log, so a generic recorder inlined into it would record the act of starting to record",
  ],
  ["audit-mode-close.sh", "writes the `session-end` record itself, which is the log's own seal"],
]);

/** A config that turns on every optional hook, so nothing escapes by being off. */
function fullConfig(pluginIds: string[]): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "fx",
    engines: ["claude"],
    preset: "custom",
    branchBase: "main",
    qualityGate: { fast: "pnpm test", full: "pnpm test" },
    // `verifyOnStop` gates `stop-verify-reminder.sh`, which is opt-in and would
    // otherwise never appear in a settings object built from a default config.
    hooks: { verifyOnStop: true },
    plugins: Object.fromEntries(pluginIds.map((id) => [id, { enabled: true }])),
  });
}

/** Every `command` string under `settings.hooks`, whatever its event shape. */
function registeredCommands(settings: Record<string, unknown>): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (typeof record.command === "string") out.push(record.command);
    for (const value of Object.values(record)) walk(value);
  };
  walk(settings.hooks);
  return out;
}

describe("every registered hook carries the audit-log include (#778)", () => {
  const pluginIds = listBundledPluginIds();
  const plugins = pluginIds.map((id) => loadPlugin(id));
  const settings = buildClaudeSettings(fullConfig(pluginIds), plugins);
  const commands = registeredCommands(settings);

  /** `bash "$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh"` → `x.sh`. */
  const scriptNames = [
    ...new Set(
      commands
        .map((c) => /\.claude\/(?:hooks|scripts)\/([A-Za-z0-9._-]+\.sh)/.exec(c)?.[1])
        .filter((n): n is string => Boolean(n)),
    ),
  ].sort();

  /** Where each registered script's SOURCE asset lives. `scriptAssets[].src` is
   *  already absolute (see `LoadedPlugin`), so it is used verbatim. */
  function sourcePath(name: string): string | null {
    const core = join(getCoreRoot(), "core-assets/hooks", name);
    if (existsSync(core)) return core;
    for (const plugin of plugins) {
      const script = plugin.scriptAssets.find((s) => basename(s.dest) === name);
      if (script && existsSync(script.src)) return script.src;
    }
    return null;
  }

  it("registers the hooks this harness is known to wire", () => {
    // A guard on the guard: if the extraction regex ever stops matching, every
    // assertion below would pass over an EMPTY list and the test would go green
    // while checking nothing.
    expect(scriptNames.length).toBeGreaterThanOrEqual(12);
    // One from each source, because the include rule applies to both: a core
    // hook and a plugin-contributed one.
    expect(scriptNames).toContain("guard-destructive.sh");
    expect(scriptNames).toContain("check-jscpd.sh");
  });

  it("resolves every registered hook to a source asset", () => {
    const unresolved = scriptNames.filter((name) => sourcePath(name) === null);
    expect(unresolved, "registered hooks with no source asset on disk").toEqual([]);
  });

  it("has the include in every registered hook that is not the recorder itself", () => {
    const missing: string[] = [];
    for (const name of scriptNames) {
      if (RECORDER_HOOKS.has(name)) continue;
      const path = sourcePath(name);
      if (!path) continue; // reported by the test above
      const body = readFileSync(path, "utf-8");
      if (!/^[^\S\n]*#\s*navori:include\s+audit-log[^\S\n]*$/m.test(body)) missing.push(name);
    }
    expect(
      missing,
      `these hooks are registered in settings.json but have no '# navori:include audit-log', ` +
        `so they can run for months with zero recorded executions and nothing would notice ` +
        `(that is exactly how a plugin's SessionStart hook once shipped invisible): ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("keeps the exemption list honest — a recorder that is no longer registered", () => {
    // An exemption that names a hook nobody registers any more is a hole the
    // next reader would inherit without a reason attached to it.
    const stale = [...RECORDER_HOOKS.keys()].filter((name) => !scriptNames.includes(name));
    expect(stale, "exempt hooks that are no longer registered").toEqual([]);
  });
});
