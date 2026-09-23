import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  PLUGIN_HOOK_SCRIPT_REL,
  globalPluginDir,
  pluginInstalled,
} from "../engines/claude/global-plugin.ts";
import {
  composeBaseline,
  generateHookScript,
  globalTargetDir,
  permissionBagOf,
  readExistingSettings,
  readHookDrift,
  type HookDrift,
} from "../engines/claude/global-render.ts";
import { globalConfigExists, readGlobalConfig } from "./global-config.ts";
import { listMarkers } from "./health.ts";
import type { NavoriConfig } from "./config.ts";

/**
 * A plugin agent Claude Code will never load in this repo, because a
 * same-named file exists under `.claude/agents/` and the repo scope wins.
 */
export interface ShadowedGlobalAgent {
  /** Agent id (the `.md` basename, without extension). */
  id: string;
  /** Absolute path of the plugin copy that stays inert. */
  globalPath: string;
  /** Path (relative to the repo) of the file that shadows it. */
  repoPath: string;
}

/** The managed-settings keys that can leave the global layer installed but inert. */
export type ManagedPolicyKey =
  | "strictPluginOnlyCustomization"
  | "allowManagedPermissionRulesOnly"
  | "strictKnownMarketplaces"
  | "blockedMarketplaces";

/** A managed-settings key found on disk, with the policy file that declares it. */
export interface ManagedPolicyFinding {
  key: ManagedPolicyKey;
  /** Absolute path of the policy file (main file or a `managed-settings.d/` drop-in). */
  path: string;
}

/**
 * `readHookDrift`'s verdict, plus the two cases where it cannot be asked at all:
 *
 * - `not-evaluable`: `composeBaseline` throws on an unknown / non-`globalSafe`
 *   block and `readGlobalConfig` throws on a corrupt `global.json`.
 * - `plugin-missing`: `~/.navori/global.json` exists but the plugin does not, so
 *   the hook this check looks for lives nowhere — an F1 install that was never
 *   migrated still has its hook OUTSIDE the plugin (`legacyGlobalHookPath`).
 *   Reporting the raw `absent` there would describe the machine wrongly.
 *
 * Neither is this check's to diagnose — `navori global doctor` owns that report,
 * and it is the one that tells `pluginMissing` from `legacyLeftover` — but
 * silently swallowing them would turn "I could not look" into "everything is
 * fine".
 */
export type GlobalHookStatus = HookDrift | { kind: "not-evaluable" } | { kind: "plugin-missing" };

/**
 * Real clashes between the machine-global harness and this repo's harness.
 * Every list empty means the two scopes coexist cleanly; the caller prints
 * nothing at all in that case.
 */
export interface GlobalScopeReport {
  shadowedAgents: ShadowedGlobalAgent[];
  /** Rules the global settings `allow` and this repo's settings `deny`. */
  permissionConflicts: string[];
  hookDrift: GlobalHookStatus;
  managedPolicy: ManagedPolicyFinding[];
}

/** Injection point for the platform policy file (see `scanGlobalScope`). */
export interface GlobalScopeOptions {
  /**
   * Absolute path of Claude Code's machine-wide `managed-settings.json`. Its
   * sibling `managed-settings.d/` is derived from it. Overridable so the specs
   * can drive the policy sub-check without writing into `/Library` or `/etc` —
   * deliberately a parameter and not a new env var: an env knob would become
   * part of the CLI's public contract for the sole benefit of a test.
   */
  managedSettingsPath?: string;
}

/** Directory Claude Code merges extra policy files from, next to the main one. */
const MANAGED_DROP_IN_DIR = "managed-settings.d";

/**
 * Claude Code's machine-wide policy file for the current platform, verbatim
 * from the official settings reference.
 */
export function defaultManagedSettingsPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
  return "/etc/claude-code/managed-settings.json";
}

/** Parse a JSON object off disk, or null when it is missing, broken or not an object. */
function readJsonObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Every drop-in policy file, ascending by name — the order Claude Code merges
 * them in, with its filter: a `.json` suffix and a name that does NOT start
 * with a dot. Verified in the shipped binary (2.1.236), which reads the dir as
 * `readdirSync(dir).filter((d) => (d.isFile() || d.isSymbolicLink()) &&
 * d.name.endsWith(".json") && !d.name.startsWith(".")).map(...).sort()`.
 */
function dropInPolicyFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json") && !name.startsWith("."))
      .sort()
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/**
 * True when `strictPluginOnlyCustomization` locks the surface that discovers the
 * global plugin. The key is PER SURFACE — Claude Code resolves it as
 * `value === true || (Array.isArray(value) && value.includes(surface))` — and
 * the `~/.claude/skills/` scan is cut by the `"skills"` surface. So `true` locks
 * it, `["skills", …]` locks it, and `["mcp"]` does not touch it at all.
 */
function restrictsSkills(value: unknown): boolean {
  return value === true || (Array.isArray(value) && value.includes("skills"));
}

/**
 * The `{"source": "skills-dir"}` sentinel Claude Code reads in
 * `strictKnownMarketplaces` / `blockedMarketplaces`. Entries of those lists are
 * objects (`{source, repo, hostPattern?}`) and the binary's predicates compare
 * `entry.source === "skills-dir"`, so a bare `"skills-dir"` string is NOT the
 * sentinel and no shape other than that object is either.
 *
 * Tolerating the bare string INVERTED the allowlist answer: an allowlist whose
 * only entry is `"skills-dir"` does block the scan, and reading it as an opt-in
 * silenced precisely the row that had to be printed. Erring toward reporting is
 * acceptable here; erring toward silence is not, so the check matches the
 * binary instead of guessing at intent.
 */
function isSkillsDirSentinel(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  return (entry as Record<string, unknown>).source === "skills-dir";
}

/** A key exactly as ONE policy file declared it, before the merge folded it in. */
interface PolicyDeclaration {
  /** Absolute path of the file that declared the key. */
  path: string;
  /** The value that file declared, not the merged one. */
  value: unknown;
}

/** The single policy document Claude Code decides on, plus who declared what. */
interface EffectivePolicy {
  /** Main file and drop-ins folded into one object, in merge order. */
  merged: Record<string, unknown>;
  /** Per key, every file that declared it, in merge order. */
  declarations: Map<string, PolicyDeclaration[]>;
}

/**
 * One incoming value folded onto the accumulator, the way Claude Code's merge
 * customizer does it: two arrays concat and dedupe (`uniq([...a, ...b])`, whose
 * SameValueZero identity `Set` reproduces), anything else is the last writer's.
 */
function mergePolicyValue(current: unknown, incoming: unknown): unknown {
  if (Array.isArray(current) && Array.isArray(incoming)) {
    return [...new Set([...current, ...incoming])];
  }
  return incoming;
}

/**
 * `managed-settings.json` and its drop-ins composed into the one document
 * `scanManagedPolicy` decides on, keeping the per-file attribution that makes a
 * row actionable.
 *
 * Only TOP-LEVEL keys are folded: the four keys this check reads are booleans
 * or flat arrays, so a nested object takes the last writer instead of being
 * deep-merged. Upgrade trigger: the day one of those keys becomes a nested
 * object, this needs real recursive-merge semantics.
 */
function composeManagedPolicy(mainPath: string): EffectivePolicy {
  const merged: Record<string, unknown> = {};
  const declarations = new Map<string, PolicyDeclaration[]>();
  const paths = [mainPath, ...dropInPolicyFiles(join(dirname(mainPath), MANAGED_DROP_IN_DIR))];
  for (const path of paths) {
    const doc = readJsonObject(path);
    if (!doc) continue;
    for (const [key, value] of Object.entries(doc)) {
      merged[key] = key in merged ? mergePolicyValue(merged[key], value) : value;
      declarations.set(key, [...(declarations.get(key) ?? []), { path, value }]);
    }
  }
  return { merged, declarations };
}

/**
 * The policy file a row names: the LAST one that declared the key — the writer
 * that survives a scalar merge, and the highest-precedence contributor of a
 * merged list. `matches` narrows it to the last file declaring the DECIDING
 * shape, so a blocklist row names a file that actually carries the sentinel and
 * not one that merely re-declared the key afterwards.
 */
function declaringFile(
  policy: EffectivePolicy,
  key: ManagedPolicyKey,
  matches: (value: unknown) => boolean = () => true,
): string | undefined {
  return policy.declarations
    .get(key)
    ?.filter((declaration) => matches(declaration.value))
    .at(-1)?.path;
}

/**
 * Managed-settings keys that can leave a `@skills-dir` plugin installed but
 * inert — decided ONCE, on the merged policy.
 *
 * Claude Code never judges a policy file on its own: it folds
 * `managed-settings.json` and every drop-in beside it into a single
 * `policySettings` object and reads that. The shipped binary defines this, not
 * the public docs, so it was read there (2.1.236): the merge customizer returns
 * `uniq([...a, ...b])` for two arrays, and the marketplace predicates
 * (`areLocalPluginDirsAllowedByPolicy` and the two list getters) read
 * `pn("policySettings")`, the already-merged tier.
 *
 * Deciding per file produced a row that ASSERTED a block that was not
 * happening — a main file with a plain allowlist plus a drop-in adding the
 * sentinel loads the plugin fine — and it missed the merged scalar case (`true`
 * in the main file, `false` in a drop-in). Only the ATTRIBUTION stays per file.
 *
 * The two marketplace lists gate the `~/.claude/skills/` auto-load itself,
 * which is what discovers navori's global plugin: ANY allowlist blocks the scan
 * unless it opts back in with the sentinel — `[]` included, because an empty
 * allowlist is a legitimate lockdown and `[].some(...)` is false — and the
 * blocklist turns the scan off when it carries the sentinel.
 *
 * SCOPE, honestly: this is a file check. On macOS the same policy can also
 * arrive by MDM through the `com.anthropic.claudecode` managed-preferences
 * domain, which is not a file and is invisible here. Finding a key is a strong
 * signal; NOT finding one proves nothing.
 */
function scanManagedPolicy(mainPath: string): ManagedPolicyFinding[] {
  const policy = composeManagedPolicy(mainPath);
  const found: ManagedPolicyFinding[] = [];
  const report = (key: ManagedPolicyKey, matches?: (value: unknown) => boolean): void => {
    const path = declaringFile(policy, key, matches);
    if (path) found.push({ key, path });
  };
  if (restrictsSkills(policy.merged.strictPluginOnlyCustomization)) {
    report("strictPluginOnlyCustomization");
  }
  if (policy.merged.allowManagedPermissionRulesOnly === true) {
    report("allowManagedPermissionRulesOnly");
  }
  const allowlist = policy.merged.strictKnownMarketplaces;
  if (Array.isArray(allowlist) && !allowlist.some(isSkillsDirSentinel)) {
    report("strictKnownMarketplaces");
  }
  const blocklist = policy.merged.blockedMarketplaces;
  if (Array.isArray(blocklist) && blocklist.some(isSkillsDirSentinel)) {
    const carriesSentinel = (value: unknown): boolean =>
      Array.isArray(value) && value.some(isSkillsDirSentinel);
    report("blockedMarketplaces", carriesSentinel);
  }
  return found;
}

/**
 * Plugin agents this repo shadows WITHOUT meaning to.
 *
 * Claude Code resolves an agent id in the repo's favour and the plugin copy
 * goes inert — silently, which is the whole problem. A same-named file is
 * therefore NOT the discriminant: in a healthy navori repo all eight agents
 * exist in both scopes BY DESIGN, and warning about that would be pure noise.
 * The discriminant is the managed marker: a repo agent carrying one was written
 * by navori, so the deferral is intentional. One without it is the user's own
 * file, quietly disabling the global copy.
 */
function scanShadowedAgents(cwd: string, claudeDir: string): ShadowedGlobalAgent[] {
  if (!pluginInstalled(claudeDir)) return []; // nothing installed to shadow
  const globalAgents = join(globalPluginDir(claudeDir), "agents");
  let entries: string[];
  try {
    entries = readdirSync(globalAgents).filter((name) => name.endsWith(".md"));
  } catch {
    return [];
  }
  const shadowed: ShadowedGlobalAgent[] = [];
  for (const name of entries.sort()) {
    const repoRel = join(".claude", "agents", name);
    const repoPath = join(cwd, repoRel);
    if (!existsSync(repoPath)) continue;
    if (listMarkers(repoPath).length > 0) continue; // navori put it there on purpose
    shadowed.push({
      id: name.replace(/\.md$/, ""),
      globalPath: join(globalAgents, name),
      repoPath: repoRel,
    });
  }
  return shadowed;
}

/**
 * Rules the global settings.json allows and this repo's settings.json denies.
 *
 * A settings.json that does not parse produces no rows on purpose: that report
 * belongs to `scanCorruptedSettings` (repo side) and to `navori global doctor`
 * (global side), and a check that cannot read a file has nothing to say about
 * its contents — the same criterion `scanClaudeHookScripts` documents.
 */
function scanPermissionConflicts(cwd: string, claudeDir: string): string[] {
  const globalRead = readExistingSettings(claudeDir);
  const repoRead = readExistingSettings(join(cwd, ".claude"));
  if (globalRead.kind !== "ok" || repoRead.kind !== "ok") return [];
  const globalAllow = permissionBagOf(globalRead.settings).allow ?? [];
  const repoDeny = new Set(permissionBagOf(repoRead.settings).deny ?? []);
  return globalAllow.filter((rule) => repoDeny.has(rule));
}

/**
 * What the installed global hook is, relative to what this CLI would render
 * now. Only the `kind` reaches the report: the full diagnosis (and the gate
 * probe, which spawns bash) belongs to `navori global doctor`, and a repo
 * doctor has no business paying for it.
 *
 * Gated on `pluginInstalled` for the same reason `scanShadowedAgents` is: with
 * a `~/.navori/global.json` but no plugin, the hook this function looks for
 * (inside the plugin) is absent by construction while the user's actual hook is
 * alive somewhere else, so the raw `absent` would be a true statement about a
 * path nobody has and a false one about the machine.
 */
function scanHookDrift(claudeDir: string): GlobalHookStatus {
  if (!pluginInstalled(claudeDir)) return { kind: "plugin-missing" };
  let expected: string;
  try {
    const config = readGlobalConfig();
    if (!config) return { kind: "not-evaluable" };
    expected = generateHookScript(composeBaseline(config));
  } catch {
    // `readGlobalConfig` throws on a corrupt global.json and `composeBaseline`
    // throws on an unknown / non-globalSafe block or an unanswered placeholder.
    // Neither is this check's to diagnose, and neither may take doctor down.
    return { kind: "not-evaluable" };
  }
  return readHookDrift(join(globalPluginDir(claudeDir), PLUGIN_HOOK_SCRIPT_REL), expected);
}

/**
 * Advisory checks about the machine-global harness (`navori global`) seen from
 * a repo's `navori doctor` — Spec 0010 FC, issue #547.
 *
 * ZERO FOOTPRINT is the invariant (Spec 0010 §2.4): with no global layer
 * installed this returns `null` and doctor must not mention the global scope at
 * all. `null` also covers "I cannot know" — a repo that renders no Claude
 * output (the global layer is Claude-only by design) and a HOME that
 * `safeHomedir` refuses, which would otherwise crash doctor over an
 * environment problem that is none of its business.
 *
 * Everything here is READ-ONLY and ADVISORY: it feeds neither `HealthVerdict`
 * nor the exit code, so a finding never turns a green repo red.
 */
export function scanGlobalScope(
  cwd: string,
  config: NavoriConfig,
  options: GlobalScopeOptions = {},
): GlobalScopeReport | null {
  if (!config.engines.includes("claude")) return null;
  let claudeDir: string;
  try {
    if (!globalConfigExists()) return null;
    claudeDir = globalTargetDir();
  } catch {
    return null; // HomeError: no usable HOME, so the answer is "I cannot know"
  }
  return {
    shadowedAgents: scanShadowedAgents(cwd, claudeDir),
    permissionConflicts: scanPermissionConflicts(cwd, claudeDir),
    hookDrift: scanHookDrift(claudeDir),
    managedPolicy: scanManagedPolicy(options.managedSettingsPath ?? defaultManagedSettingsPath()),
  };
}
