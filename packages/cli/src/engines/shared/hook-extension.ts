import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { NavoriConfig } from "../../lib/config/config.ts";
import type { LoadedPlugin } from "../../lib/config/plugins.ts";
import { resolveLang, tc } from "../../lib/i18n.ts";
import { readCliVersion } from "../../lib/render/bundled-assets.ts";
import { injectManagedSection, removeManagedSection } from "../../lib/render/marker.ts";
import { classifyVersionDrift, type UpdateAvailable } from "../../lib/render/render-plan.ts";
import type { RenderStatus } from "../../lib/primitives/style.ts";
import type { SkippedFile } from "./execute-plan.ts";

const NAVORI_VERSION = readCliVersion();

/** One plugin hook extension as the plugin loader resolves it. */
export type HookExtensionAsset = NonNullable<LoadedPlugin["hookExtensionAssets"]>[number];

/**
 * A pending write both engines understand. Codex entries carry `relPath`
 * (required by its executor), Claude's do not.
 */
export interface HookExtensionPending {
  path: string;
  content: string;
  status: RenderStatus;
  chmodExec?: boolean;
  relPath?: string;
}

const CLAUDE_HOOKS_PREFIX = ".claude/hooks/";

/**
 * The repo-relative hook an extension targets under one engine. Manifests name
 * the Claude mirror (`.claude/hooks/<id>.sh`); Codex keeps the same hook under
 * `.codex/hooks/`. Returns null for a target that is not an engine hook mirror,
 * which Codex does not extend.
 */
export function hookExtensionTarget(target: string, engine: "claude" | "codex"): string | null {
  if (engine === "claude") return target;
  return target.startsWith(CLAUDE_HOOKS_PREFIX)
    ? `.codex/hooks/${target.slice(CLAUDE_HOOKS_PREFIX.length)}`
    : null;
}

/**
 * Inject a plugin's hook extension (`hookExtensions[]`, spec 0039 D6) as a
 * shell-style managed sub-block in its target hook mirror. The block lands right
 * after the hook's base block, ahead of the `# navori:user-section` marker and
 * its trailing `exit 0`, so it runs after every rule the base block carries. A
 * missing target (hook not rendered) is a no-op: there is nothing to extend.
 * Shared by the Claude and Codex engines (spec 0041 R29); `target` is the
 * engine-specific repo-relative hook path (see {@link hookExtensionTarget}).
 */
export function applyHookExtension(input: {
  cwd: string;
  plugin: LoadedPlugin;
  extension: HookExtensionAsset;
  target: string;
  config: NavoriConfig;
  pending: HookExtensionPending[];
  skipped: SkippedFile[];
  updatesAvailable: UpdateAvailable[];
  downgrades: UpdateAvailable[];
  /** Stamp `relPath` on a newly queued write (the Codex executor needs it). */
  withRelPath?: boolean;
}): void {
  const targetAbs = join(input.cwd, input.target);
  const pendingEntry = input.pending.find((p) => p.path === targetAbs);
  let currentContent: string;
  if (pendingEntry) currentContent = pendingEntry.content;
  else if (existsSync(targetAbs)) currentContent = readFileSync(targetAbs, "utf-8");
  else return;

  const source = `@navori/plugin-${input.plugin.manifest.id}`;
  const lang = resolveLang(input.config.language);
  const result = injectManagedSection(
    currentContent,
    input.extension.id,
    readFileSync(input.extension.absPath, "utf-8"),
    { source, version: NAVORI_VERSION },
    "shell",
  );
  classifyVersionDrift(
    result,
    input.extension.id,
    source,
    NAVORI_VERSION,
    input.updatesAvailable,
    input.downgrades,
  );
  if (result.status === "user-modified-skipped") {
    input.skipped.push({
      path: relative(input.cwd, targetAbs),
      reason: tc(lang).engine.subBlockEditedByHand(input.extension.id, input.plugin.manifest.id),
      status: "user-modified-skipped",
    });
    return;
  }
  if (result.status === "downgrade-skipped") {
    input.skipped.push({
      path: relative(input.cwd, targetAbs),
      reason: tc(lang).engine.subBlockFromNewerNavori(
        input.extension.id,
        result.details?.existingVersion ?? undefined,
      ),
      status: "downgrade-skipped",
    });
    return;
  }
  if (result.output === currentContent) return;
  if (pendingEntry) {
    pendingEntry.content = result.output;
    return;
  }
  input.pending.push({
    path: targetAbs,
    ...(input.withRelPath ? { relPath: input.target } : {}),
    content: result.output,
    status: result.status === "unchanged" ? "updated" : result.status,
    chmodExec: true,
  });
}

/** Inverse of {@link applyHookExtension}: strip the sub-block when its plugin is disabled. */
export function removeHookExtension(input: {
  cwd: string;
  extension: HookExtensionAsset;
  target: string;
  pending: HookExtensionPending[];
  withRelPath?: boolean;
}): void {
  const targetAbs = join(input.cwd, input.target);
  const pendingEntry = input.pending.find((p) => p.path === targetAbs);
  let currentContent: string;
  if (pendingEntry) currentContent = pendingEntry.content;
  else if (existsSync(targetAbs)) currentContent = readFileSync(targetAbs, "utf-8");
  else return;

  const stripped = removeManagedSection(currentContent, input.extension.id, "shell");
  if (stripped === currentContent) return;
  if (pendingEntry) {
    pendingEntry.content = stripped;
    return;
  }
  input.pending.push({
    path: targetAbs,
    ...(input.withRelPath ? { relPath: input.target } : {}),
    content: stripped,
    status: "updated",
    chmodExec: true,
  });
}
