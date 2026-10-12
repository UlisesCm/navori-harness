import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import {
  retiredPluginForScript,
  retiredScriptBasenames,
  type PluginsConfig,
  type RetiredPluginEntry,
} from "../../lib/config/plugins.ts";
import { readHookSources, type HookSource } from "../../lib/diagnose/native-hooks.ts";
import { locateManagedBlocks } from "../../lib/render/marker.ts";
import { navoriAuthorship, type KeepReason } from "../../lib/render/removable.ts";
import { matchesLegacyFingerprint } from "./legacy-plugin-script-fingerprints.ts";

/**
 * The one policy that decides whether a RETIRED plugin's asset may be deleted.
 *
 * A retired plugin's manifest is gone, so nothing can re-render its scripts to
 * compare bytes; the verdict has to come from the file itself and from who may
 * still call it. Three delete sites share this: the Claude sweep (step 8.5-bis),
 * the Codex `.codex/scripts` orphan scan, and `render --prune`. A path is
 * deletable only when `retiredAssetKeepReason` returns `null`; otherwise it is
 * kept, the render warns with the reason, and `doctor` reports it.
 *
 * Ownership (the file is provably navori's), first failing rule wins:
 *   - an intact managed marker (hash verified, not stamped by a newer navori)
 *     with NOTHING outside the managed block, or
 *   - no marker, but a byte-for-byte pre-#637 render (legacy fingerprint), or
 *   - no marker, and the registry entry opts in with `deleteForeign` (cognitive:
 *     its leftovers predate script markers and are not in the fingerprint table).
 * A directory is judged file by file; a symlink, anywhere, keeps it.
 *
 * Then, only for a file navori does own, "does anything still call it?":
 *   - `plugins.<id>.nativeHook === true` (the user wired the script into a
 *     native hook by hand, possibly through a path no scan can follow);
 *   - a hook-bearing config this render did NOT rewrite still names it (a
 *     skipped `settings.json` / `config.toml`, or `settings.local.json`);
 *   - any hook source (git hooks, husky, lefthook, pre-commit, package.json,
 *     Makefile, workflows) names it.
 */

/** What the policy needs from the render in progress. Built once per render. */
export interface RetiredAssetContext {
  cwd: string;
  plugins: PluginsConfig | undefined;
  /**
   * Hook-bearing config files that survive this render and may still register
   * the script: a `settings.json` / `config.toml` the render skipped, and
   * `.claude/settings.local.json`. Absolute paths; missing files are ignored.
   */
  configPaths: readonly string[];
  /** Hook sources, read at most once and only when a retired asset survives ownership. */
  sources?: HookSource[];
}

/** A context for one render. */
export function createRetiredAssetContext(
  cwd: string,
  plugins: PluginsConfig | undefined,
  configPaths: readonly string[] = [],
): RetiredAssetContext {
  return { cwd, plugins, configPaths };
}

const MAX_DEPTH = 8;
const SCRIPTS_PATH = /^\.(?:claude|codex)\/scripts\/([^/]+)(?:\/|$)/;

/** The asset name (`check-x.sh`, `cognitive-tool`) a cwd-relative script path belongs to, or null. */
export function retiredAssetNameOf(cwd: string, absPath: string): string | null {
  const name = SCRIPTS_PATH.exec(relative(cwd, absPath).split("\\").join("/"))?.[1];
  return name !== undefined && retiredScriptBasenames().has(name) ? name : null;
}

/** True when the file holds nothing but navori managed blocks (and whitespace). */
function onlyManagedBlocks(content: string): boolean {
  const style = content.includes("# navori:managed start") ? "shell" : "html";
  let rest = content;
  for (const block of [...locateManagedBlocks(content, style)].sort(
    (a, b) => b.openStart - a.openStart,
  )) {
    rest = rest.slice(0, block.openStart) + rest.slice(block.closeEnd);
  }
  return rest.trim() === "";
}

/** Files under `dir` (depth-capped). `null` when something in it is a symlink or not a plain file/dir. */
function filesOf(dir: string, depth = 0): string[] | null {
  if (depth > MAX_DEPTH) return null;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const out: string[] = [];
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isSymbolicLink()) return null;
    if (entry.isDirectory()) {
      const nested = filesOf(abs, depth + 1);
      if (nested === null) return null;
      out.push(...nested);
    } else if (entry.isFile()) out.push(abs);
    else return null;
  }
  return out;
}

/** Ownership verdict for ONE regular file of a retired asset: null = provably navori's. */
function ownershipKeepReason(file: string, entry: RetiredPluginEntry): KeepReason | null {
  let content: string;
  try {
    content = readFileSync(file, "utf-8");
  } catch {
    return "foreign";
  }
  if (content.includes("navori:managed")) {
    const authorship = navoriAuthorship(file, undefined, { verifyHash: true });
    if (authorship !== "ours") return authorship;
    return onlyManagedBlocks(content) ? null : "modified";
  }
  if (matchesLegacyFingerprint(basename(file), content)) return null;
  return entry.deleteForeign === true ? null : "foreign";
}

/** Hook sources of this render, read lazily and once. Retired scripts are the assets being judged, not callers. */
function hookSources(ctx: RetiredAssetContext): HookSource[] {
  ctx.sources ??= readHookSources(ctx.cwd).filter(
    (s) => retiredAssetNameOf(ctx.cwd, s.path) === null,
  );
  return ctx.sources;
}

/**
 * Why `absPath` (a retired plugin's script or directory, Claude or Codex) must NOT
 * be deleted, or `null` when it may be. A path that is not a retired asset, or no
 * longer exists, is not this policy's business and also returns `null`.
 */
export function retiredAssetKeepReason(
  absPath: string,
  ctx: RetiredAssetContext,
): KeepReason | null {
  const name = retiredAssetNameOf(ctx.cwd, absPath);
  if (name === null) return null;
  const owner = retiredPluginForScript(name);
  if (owner === null) return null;

  let stats;
  try {
    stats = lstatSync(absPath, { throwIfNoEntry: false });
  } catch {
    return "foreign";
  }
  if (!stats) return null;
  if (!stats.isFile() && !stats.isDirectory()) return "symlink"; // symlink, socket, fifo
  const files = stats.isFile() ? [absPath] : filesOf(absPath);
  if (files === null) return "symlink";
  for (const file of files) {
    const reason = ownershipKeepReason(file, owner.entry);
    if (reason !== null) return reason;
  }

  if (ctx.plugins?.[owner.id]?.nativeHook === true) return "native-hook-declared";
  for (const config of ctx.configPaths) {
    if (!existsSync(config)) continue;
    try {
      if (readFileSync(config, "utf-8").includes(name)) return "settings-referenced";
    } catch {
      // Unreadable config: it cannot be shown to name the script.
    }
  }
  if (hookSources(ctx).some((s) => s.text.includes(name))) return "hook-referenced";
  return null;
}

/** A hook source that names a retired script. */
export interface RetiredScriptReference {
  /** Retired script/dir basename named. */
  script: string;
  /** Repo-relative path of the file that names it. */
  source: string;
}

/**
 * Hook sources that name a retired script, for `doctor`. Reads sources only when
 * `retiredNames` is non-empty, so a repo with nothing to look for pays nothing.
 */
export function findRetiredScriptReferences(
  ctx: RetiredAssetContext,
  retiredNames: readonly string[],
): RetiredScriptReference[] {
  if (retiredNames.length === 0) return [];
  const out: RetiredScriptReference[] = [];
  for (const source of hookSources(ctx)) {
    for (const script of retiredNames) {
      if (source.text.includes(script)) {
        out.push({ script, source: relative(ctx.cwd, source.path) });
      }
    }
  }
  return out;
}
