import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NavoriConfig } from "../config/config.ts";
import type { LoadedPlugin } from "../config/plugins.ts";
import { isDowngrade } from "../primitives/semver.ts";
import type { HookExtensionPending } from "../../engines/shared/hook-extension.ts";
import { hookExtensionTarget } from "../../engines/shared/hook-extension.ts";
import { pluginExtraVars } from "../../engines/shared/plugin-extra-vars.ts";
import { pluginScriptPlacements } from "../../engines/shared/plugin-scripts.ts";
import { renderManagedFile } from "../../engines/shared/render-managed-file.ts";
import { expandHookIncludes } from "./hook-includes.ts";
import { computeManagedHash, injectManagedSection, readMarkerAttrs } from "./marker.ts";
import { readCliVersion } from "./bundled-assets.ts";
import {
  INTEGRITY_PREFIX,
  loadNativeHooks,
  nativeDependencyPath,
  nativePathContained,
  nativeRunnerShell,
  sha256,
  signNativeScript,
  stripNativeSignature,
  type NativeEngine,
  type NativeHook,
  type NativeHooks,
} from "./native-hook.ts";

interface PlannedNativeHook {
  id: string;
  assetPath: string;
  managedId: string;
}
interface NativeRenderInput {
  cwd: string;
  engine: NativeEngine;
  config: NavoriConfig;
  hooks: readonly PlannedNativeHook[];
  plugins: readonly LoadedPlugin[];
  pending: HookExtensionPending[];
  manifest?: NativeHooks;
  /** Final `extraVars` of each asset placement, by destination relative to `cwd`. */
  renderVars?: ReadonlyMap<string, Readonly<Record<string, string>>>;
}

/**
 * Each dependency is a plugin script: `deps` pins its source asset, and the deployed copy (the
 * planned write, else the file on disk) must be that asset's fresh render under its own marker.
 * The returned bytes are the deployed ones, the bytes the binary re-hashes.
 */
function depsFor(input: NativeRenderInput, descriptor: NativeHook): Buffer[] | null {
  const deps: Buffer[] = [];
  for (const path of Object.keys(descriptor.deps).sort()) {
    const resolved = nativeDependencyPath(input.cwd, input.engine, path);
    if (resolved === null || !nativePathContained(input.cwd, resolved)) return null;
    const script = input.plugins
      .flatMap((plugin: LoadedPlugin) => pluginScriptPlacements(plugin, input.engine))
      .find((placement): boolean => `scripts/${placement.dest}` === path);
    if (script === undefined || sha256(readFileSync(script.src)) !== descriptor.deps[path])
      return null;
    const planned = input.pending.find(
      (entry: HookExtensionPending): boolean => entry.path === resolved,
    );
    const content = planned
      ? planned.content
      : existsSync(resolved)
        ? readFileSync(resolved, "utf8")
        : null;
    if (content === null) return null;
    const meta = readMarkerAttrs(content, script.managedId, "shell");
    if (meta?.existingSource !== script.meta.source || !meta.existingVersion) return null;
    const fresh = renderManagedFile({
      assetPath: script.src,
      existingContent: null,
      managedId: script.managedId,
      meta: { source: meta.existingSource, version: meta.existingVersion },
      config: input.config,
      extraVars: pluginExtraVars(input.config),
      engine: input.engine,
      commentStyle: "shell",
    }).content;
    if (fresh !== content) return null;
    deps.push(Buffer.from(content));
  }
  return deps;
}

/** Exact fresh reference, including user template and every configured plugin block. */
function referenceFor(
  input: NativeRenderInput,
  hook: PlannedNativeHook,
  script: string,
  descriptor: NativeHook,
  target: string,
): string | null {
  const attrs = readMarkerAttrs(script, hook.managedId, "shell");
  if (
    !attrs?.existingVersion ||
    attrs.existingSource !== "@navori/core" ||
    isDowngrade(attrs.existingVersion, readCliVersion()) ||
    isDowngrade(input.config.harnessVersion, readCliVersion())
  )
    return null;
  const expanded = expandHookIncludes(readFileSync(hook.assetPath, "utf8"));
  if (sha256(expanded) !== descriptor.blocks[hook.managedId]) return null;
  const seen = new Set([hook.managedId]);
  let reference = renderManagedFile({
    assetPath: hook.assetPath,
    existingContent: null,
    managedId: hook.managedId,
    meta: { source: attrs.existingSource, version: attrs.existingVersion },
    config: input.config,
    extraVars: input.renderVars?.get(target),
    engine: input.engine,
    commentStyle: "shell",
  }).content;
  for (const plugin of input.plugins) {
    for (const extension of plugin.hookExtensionAssets ?? []) {
      if (hookExtensionTarget(extension.target, input.engine) !== target) continue;
      // The existing engine installs every sibling script of a hosted extension. Require
      // that finite dependency inventory rather than trying to infer arbitrary shell source.
      if (
        plugin.scriptAssets.some(
          (script: LoadedPlugin["scriptAssets"][number]): boolean =>
            !Object.hasOwn(descriptor.deps, `scripts/${script.dest}`),
        )
      )
        return null;
      const body = readFileSync(extension.absPath, "utf8");
      if (sha256(expandHookIncludes(body)) !== descriptor.blocks[extension.id]) return null;
      const meta = readMarkerAttrs(script, extension.id, "shell");
      if (
        !meta?.existingVersion ||
        meta.existingSource !== `@navori/plugin-${plugin.manifest.id}` ||
        isDowngrade(meta.existingVersion, readCliVersion())
      )
        return null;
      reference = injectManagedSection(
        reference,
        extension.id,
        body,
        { source: meta.existingSource, version: meta.existingVersion },
        "shell",
      ).output;
      seen.add(extension.id);
    }
  }
  return Object.keys(descriptor.blocks).every((id: string): boolean => seen.has(id))
    ? reference
    : null;
}

/** Plan native wrapping after all plugin extensions. No disk writes, backup or ownership changes. */
export function finalizeNativeHooks(input: NativeRenderInput): ReadonlyMap<string, NativeHook> {
  const hooks = input.manifest ?? loadNativeHooks();
  const eligible = new Map<string, NativeHook>();
  if (
    Object.keys(hooks).length === 0 &&
    !input.pending.some((entry: HookExtensionPending): boolean =>
      entry.content.startsWith(INTEGRITY_PREFIX),
    )
  )
    return eligible;
  for (const hook of input.hooks) {
    const target =
      input.engine === "pi"
        ? `.pi/navori/hooks/${hook.id}.sh`
        : `.${input.engine}/hooks/${hook.id}.sh`;
    const path = join(input.cwd, target);
    if (!nativePathContained(input.cwd, path)) continue;
    const index = input.pending.findIndex(
      (entry: HookExtensionPending): boolean => entry.path === path,
    );
    const planned = input.pending[index];
    const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
    let candidate = planned?.content ?? existing;
    if (candidate === null) continue;
    const descriptor = Object.hasOwn(hooks, hook.id) ? hooks[hook.id] : undefined;
    // The normal renderer has already regenerated owned blocks. Remove only our own old header.
    if (planned && candidate.startsWith(INTEGRITY_PREFIX))
      candidate = stripNativeSignature(candidate);
    if (!descriptor) {
      if (planned) planned.content = candidate;
      continue;
    }
    const wrapper = nativeRunnerShell({
      engine: input.engine,
      hook: hook.id,
      descriptor,
      invocation: '--via-script "$0"',
      args: '"$@"',
    });
    const unsigned = stripNativeSignature(candidate);
    let withoutWrapper = unsigned.replace(wrapper + "\n", "");
    if (withoutWrapper !== unsigned) {
      const attrs = readMarkerAttrs(unsigned, hook.managedId, "shell");
      const bodyStart = withoutWrapper.indexOf("\n") + 1;
      const bodyEnd = withoutWrapper.indexOf(
        `# navori:managed end id="${hook.managedId}"`,
        bodyStart,
      );
      const originalStart = unsigned.indexOf("\n") + 1;
      const originalEnd = unsigned.indexOf(
        `# navori:managed end id="${hook.managedId}"`,
        originalStart,
      );
      if (
        !attrs ||
        bodyEnd < 0 ||
        originalEnd < 0 ||
        attrs.existingHash !== computeManagedHash(unsigned.slice(originalStart, originalEnd))
      )
        continue;
      // Undo only our wrapper's hash contribution. Preserve every body byte so exact
      // conformity still rejects CRLF or trailing-space edits hidden by marker normalization.
      const header = withoutWrapper.slice(0, bodyStart);
      withoutWrapper =
        header.replace(
          /hash="[a-f0-9]{8}"/,
          `hash="${computeManagedHash(withoutWrapper.slice(bodyStart, bodyEnd))}"`,
        ) + withoutWrapper.slice(bodyStart);
    }
    let reference: string | null;
    let dependencies: Buffer[] | null;
    try {
      reference = referenceFor(input, hook, withoutWrapper, descriptor, target);
      dependencies = depsFor(input, descriptor);
    } catch {
      if (planned) planned.content = candidate;
      continue;
    }
    // Comparing the full reference also rejects unknown markers, custom preambles and user edits.
    if (reference === null || withoutWrapper !== reference || dependencies === null) {
      if (planned) planned.content = candidate;
      continue;
    }
    const body = readMarkerAttrs(reference, hook.managedId, "shell");
    if (!body) continue;
    const start = reference.indexOf("\n") + 1;
    const shebang = reference.startsWith("#!", start) ? reference.indexOf("\n", start) + 1 : start;
    const withWrapper = reference.slice(0, shebang) + wrapper + "\n" + reference.slice(shebang);
    // Restamp the modified managed body with the canonical JS marker algorithm.
    const close = withWrapper.indexOf(`# navori:managed end id="${hook.managedId}"`, start);
    if (close < 0) continue;
    const wrapped = injectManagedSection(
      reference,
      hook.managedId,
      withWrapper.slice(start, close).replace(/\n$/, ""),
      {
        source: body.existingSource ?? "@navori/core",
        version: readCliVersion(),
      },
      "shell",
    ).output;
    const signed = signNativeScript(wrapped, descriptor.impl, dependencies);
    eligible.set(target, descriptor);
    if (signed === existing) {
      if (index >= 0) input.pending.splice(index, 1);
    } else if (planned) {
      planned.content = signed;
    } else {
      input.pending.push({
        path,
        relPath: target,
        content: signed,
        status: "updated",
        chmodExec: true,
      });
    }
  }
  return eligible;
}
