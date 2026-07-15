import { readFileSync, existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { NavoriError } from "./errors.ts";
import { bundledPluginManifestPath, getPluginPath, listBundledPluginIds } from "./bundled-assets.ts";
import { safeRelPath } from "./zod-helpers.ts";

const AGENT_ROLES = [
  "leader",
  "implementer",
  "reviewer",
  "researcher",
  "ticket-audit",
  "commit-pr-pilot",
  "explorer",
] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

const ManagedEntrySchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  /** Agent that the plugin recommends for this skill/protocol. */
  recommendedAgent: z.enum(AGENT_ROLES).optional(),
});

const ExternalToolSchema = z.object({
  name: z.string().min(1),
  /** Binary name to look up in PATH. Safer than checkCommand because it
   * never spawns a shell — we walk PATH directories manually. */
  checkBinary: z.string().regex(/^[a-zA-Z0-9_\-.]+$/, "binary name must be alphanumeric").optional(),
  install: z.record(z.string(), z.string()).optional(),
  postInstall: z.string().optional(),
});

// Spec 0002 — extensions for the Claude engine adapter.
// All fields below are optional and additive: existing plugins keep
// validating without changes.

const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "Stop"] as const;

const HookEntrySchema = z.object({
  event: z.enum(HOOK_EVENTS),
  /** Claude Code matcher (regex against tool name). */
  matcher: z.string().optional(),
  command: z.string().min(1),
  timeout: z.number().int().positive().optional(),
  statusMessage: z.string().optional(),
});

const ScriptEntrySchema = z.object({
  /** Path relative to the plugin package root. */
  src: safeRelPath,
  /** Path relative to `.claude/scripts/` in the target repo. */
  dest: safeRelPath,
  /** chmod +x after copy. Defaults to true (shell scripts need it). */
  exec: z.boolean().default(true),
});

const SkillEntrySchema = z.object({
  id: z.string().min(1),
  file: safeRelPath,
  recommendedAgent: z.enum(AGENT_ROLES).optional(),
  /** If set, inject this skill content as a sub-block (managed marker)
   * inside the target file instead of writing a standalone skill. Used
   * when a plugin extends an agent (e.g. engram → leader.md). */
  injectInto: safeRelPath.optional(),
});

const PromptSelectOptionSchema = z.object({
  value: z.string().min(1),
  label: z.object({ es: z.string().min(1), en: z.string().min(1) }),
});

const PromptEntrySchema = z.object({
  /** Dot-path under config.project that the answer is written to. */
  key: z.string().regex(/^[a-z][a-zA-Z0-9_.]*$/, "key must be a config dot-path"),
  /** Wizard grouping: "general" questions first, then "specific" ones. */
  phase: z.enum(["general", "specific"]).optional(),
  question: z.object({ es: z.string().min(1), en: z.string().min(1) }),
  type: z.enum(["string", "string-list", "boolean", "number", "select"]),
  /** Required when type === "select". */
  options: z.array(PromptSelectOptionSchema).optional(),
  placeholder: z.string().optional(),
  optional: z.boolean().default(false),
});

export const PluginManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "plugin id must be kebab-case"),
  name: z.string(),
  description: z.string(),
  version: z.string(),
  managed: z.array(ManagedEntrySchema).default([]),
  externalTool: ExternalToolSchema.optional(),
  /** Deep-merged into `.claude/settings.json` at render time. */
  settingsFragment: z.record(z.string(), z.unknown()).optional(),
  hooks: z.array(HookEntrySchema).optional(),
  scripts: z.array(ScriptEntrySchema).optional(),
  skills: z.array(SkillEntrySchema).optional(),
  prompts: z.array(PromptEntrySchema).optional(),
  /**
   * Load-bearing substrings that MUST appear verbatim in the rendered output
   * while this plugin is enabled. `navori doctor` fails when any disappears —
   * a guard against a template refactor silently eating a rule. Spec 0003 §3.1.1.
   */
  invariants: z.array(z.string().min(1)).default([]),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type PluginManagedEntry = z.infer<typeof ManagedEntrySchema>;
export type PluginExternalTool = z.infer<typeof ExternalToolSchema>;
export type PluginHookEntry = z.infer<typeof HookEntrySchema>;
export type PluginScriptEntry = z.infer<typeof ScriptEntrySchema>;
export type PluginSkillEntry = z.infer<typeof SkillEntrySchema>;
export type PluginPromptEntry = z.infer<typeof PromptEntrySchema>;

/** Resolved manifest with its package root and computed asset paths. */
export interface LoadedPlugin {
  manifest: PluginManifest;
  /** Absolute path to the plugin package root (where plugin.json lives). */
  packageRoot: string;
  /** Resolved absolute paths for each managed entry. */
  managedAssets: Array<{ id: string; absPath: string }>;
  /** Resolved absolute paths for each script entry (source side). */
  scriptAssets: Array<{ src: string; dest: string; exec: boolean }>;
  /** Resolved absolute paths for each skill entry (source side). */
  skillAssets: Array<{
    id: string;
    absPath: string;
    recommendedAgent?: AgentRole;
    injectInto?: string;
  }>;
}

/**
 * Known plugins shipped with navori. Each entry maps a plugin id to its
 * npm package name. The CLI uses createRequire to resolve the package
 * regardless of whether we are in dev (workspace) or installed via npm.
 */
export const KNOWN_PLUGINS: Record<string, string> = {
  engram: "@navori/plugin-engram",
  acli: "@navori/plugin-acli",
  gh: "@navori/plugin-gh",
  jscpd: "@navori/plugin-jscpd",
  semgrep: "@navori/plugin-semgrep",
  cognitive: "@navori/plugin-cognitive",
};

export class PluginNotFoundError extends NavoriError {
  readonly pluginId: string;
  constructor(pluginId: string) {
    super("plugin-not-found", `Unknown plugin: '${pluginId}'`);
    this.pluginId = pluginId;
  }
}

export class PluginManifestError extends NavoriError {
  readonly issues?: z.ZodIssue[];
  constructor(message: string, issues?: z.ZodIssue[]) {
    super("plugin-manifest-invalid", message);
    this.issues = issues;
  }
}

export function listKnownPluginIds(): string[] {
  // Bundled assets win when present (published CLI); fall back to the static map.
  const bundled = listBundledPluginIds();
  return bundled.length > 0 ? bundled : Object.keys(KNOWN_PLUGINS);
}

/**
 * Load a plugin by id. Throws PluginNotFoundError if id is unknown, or
 * PluginManifestError if plugin.json is malformed.
 *
 * Resolution: first try bundled assets in dist/assets/plugins/<id>/; if not
 * present (dev mode without build), fall back to the workspace package root.
 */
export function loadPlugin(pluginId: string): LoadedPlugin {
  if (!KNOWN_PLUGINS[pluginId] && !listBundledPluginIds().includes(pluginId)) {
    throw new PluginNotFoundError(pluginId);
  }

  const packageRoot = getPluginPath(pluginId);
  const manifestPath = bundledPluginManifestPath(pluginId);

  if (!existsSync(manifestPath)) {
    throw new PluginManifestError(`plugin.json not found at ${manifestPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (err) {
    throw new PluginManifestError(`Invalid JSON in ${manifestPath}: ${(err as Error).message}`);
  }

  const result = PluginManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new PluginManifestError(`Invalid plugin manifest in ${manifestPath}`, result.error.issues);
  }

  const manifest = result.data;
  // Containment check: a malicious or buggy plugin.json could declare
  // 'file: "../../../etc/passwd"'. Reject anything that escapes the
  // package root, so plugin content can never read arbitrary files.
  const rootPrefix = packageRoot.endsWith(sep) ? packageRoot : packageRoot + sep;
  const containAgainstRoot = (entryFile: string, fieldLabel: string): string => {
    const absPath = resolve(packageRoot, entryFile);
    if (absPath !== packageRoot && !absPath.startsWith(rootPrefix)) {
      throw new PluginManifestError(
        `Plugin '${pluginId}' declared ${fieldLabel} '${entryFile}' that resolves outside the package root.`,
      );
    }
    return absPath;
  };

  const managedAssets = manifest.managed.map((entry) => ({
    id: entry.id,
    absPath: containAgainstRoot(entry.file, "managed.file"),
  }));

  const scriptAssets = (manifest.scripts ?? []).map((entry) => ({
    src: containAgainstRoot(entry.src, "scripts.src"),
    dest: entry.dest,
    exec: entry.exec,
  }));

  const skillAssets = (manifest.skills ?? []).map((entry) => ({
    id: entry.id,
    absPath: containAgainstRoot(entry.file, "skills.file"),
    recommendedAgent: entry.recommendedAgent,
    injectInto: entry.injectInto,
  }));

  return { manifest, packageRoot, managedAssets, scriptAssets, skillAssets };
}

/**
 * Load all plugins that are enabled in the config (plugins[id].enabled === true).
 * Skips entries whose package is not installed (returns them in `missing` for doctor to report).
 */
export interface PluginsLoadResult {
  loaded: LoadedPlugin[];
  missing: Array<{ id: string; reason: string }>;
}

export function loadEnabledPlugins(
  pluginsConfig: Record<string, { enabled: boolean }> | undefined,
): PluginsLoadResult {
  return loadPluginsWhere(pluginsConfig, (v) => v.enabled === true);
}

/**
 * Load the plugins declared with `enabled: false`. The render uses these to
 * clean up artifacts a now-disabled plugin left on disk — its injectInto
 * sub-blocks and scripts — which `loadEnabledPlugins` (enabled-only) can't see
 * (#80). A plugin absent from config entirely is NOT returned: there's nothing
 * declaring it, so there's nothing to reconcile.
 */
export function loadDisabledPlugins(
  pluginsConfig: Record<string, { enabled: boolean }> | undefined,
): PluginsLoadResult {
  return loadPluginsWhere(pluginsConfig, (v) => v.enabled === false);
}

function loadPluginsWhere(
  pluginsConfig: Record<string, { enabled: boolean }> | undefined,
  predicate: (v: { enabled: boolean }) => boolean,
): PluginsLoadResult {
  const ids = Object.entries(pluginsConfig ?? {})
    .filter(([, v]) => predicate(v))
    .map(([k]) => k);

  const loaded: LoadedPlugin[] = [];
  const missing: Array<{ id: string; reason: string }> = [];

  for (const id of ids) {
    try {
      loaded.push(loadPlugin(id));
    } catch (err) {
      if (err instanceof PluginNotFoundError) {
        missing.push({ id, reason: "unknown plugin id" });
      } else if (err instanceof PluginManifestError) {
        missing.push({ id, reason: err.message });
      } else {
        throw err;
      }
    }
  }

  return { loaded, missing };
}
