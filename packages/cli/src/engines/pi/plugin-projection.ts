import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NavoriConfig } from "../../lib/config/config.ts";
import type { LoadedPlugin } from "../../lib/config/plugins.ts";
import { stripFrontmatter } from "../../lib/render/frontmatter.ts";
import { interpolate } from "../../lib/render/interpolate.ts";
import { readCliVersion } from "../../lib/render/bundled-assets.ts";
import { injectManagedSection, removeManagedSection } from "../../lib/render/marker.ts";
import { conditionOrchestration } from "../../lib/render/render-plan.ts";
import { parseAsset } from "../claude/parse-asset.ts";
import { resolvePluginCodexHooks } from "../codex/hook-registrations.ts";
import type { PendingWrite } from "../shared/execute-plan.ts";
import { hookExtensionTarget } from "../shared/hook-extension.ts";
import { isNativeOn } from "../shared/native-overlap.ts";
import { pluginExtraVars } from "../shared/plugin-extra-vars.ts";
import { pluginScriptManagedId } from "../shared/plugin-scripts.ts";
import { piHookPath, type PiHookBinding } from "./hook-bindings.ts";
import {
  PI_KNOWLEDGE_PREFIX,
  PI_KNOWLEDGE_READONLY,
  piKnowledgeToolName,
  type PiKnowledgeGrants,
} from "./knowledge-tools.ts";
import type { PiRoleName } from "./role-tools.ts";

/**
 * Spec 0048 D13 (R12): how enabled plugins reach Pi. This module holds the pure parts of the
 * projection (which plugins are live, which hooks translate, the sub-block bodies); the writes go
 * through `renderPiEngine`'s shared plan so ownership, backup and prune stay the shared ones.
 */

const NAVORI_VERSION = readCliVersion();
const SKILL_INJECT_RE = /^\.claude\/skills\/([a-z0-9-]+)(?:\/SKILL)?\.md$/;
const AGENT_INJECT_RE = /^\.claude\/agents\/([a-z0-9-]+)\.md$/;

/** A bridge row for a plugin script: it lives under `.pi/navori/scripts`, not `.pi/navori/hooks`. */
export type PiPluginBinding = PiHookBinding & { readonly path: string; readonly dest: string };

/** Destination of a plugin script copy, relative to the project root. */
export function piScriptPath(dest: string): string {
  return `.pi/navori/scripts/${dest}`;
}

/** The manifest path of any bridge row (core hook copy or plugin script). */
export function piBindingPath(binding: PiHookBinding | PiPluginBinding): string {
  return "path" in binding ? binding.path : piHookPath(binding.script);
}

/** Enabled plugins minus the ones the overlap matrix marks native on Pi. */
export function piLivePlugins(plugins: readonly LoadedPlugin[]): readonly LoadedPlugin[] {
  return plugins.filter((plugin) => !isNativeOn("pi", "plugin", plugin.manifest.id));
}

/**
 * Plugin `PreToolUse`/`Bash` hooks the bridge can run: the same exact grammar Codex translates
 * (`resolvePluginCodexHooks`), re-pointed at `.pi/navori/scripts/<dest>`. Whatever does not
 * translate is counted in a warning, never dropped silently.
 */
export function resolvePiPluginHooks(plugins: readonly LoadedPlugin[]): {
  bindings: PiPluginBinding[];
  warnings: string[];
} {
  const { hooks } = resolvePluginCodexHooks(plugins);
  const bindings = hooks.map((hook): PiPluginBinding => ({
    script: pluginScriptManagedId(hook.pluginId ?? "plugin", hook.script),
    dest: hook.script,
    path: piScriptPath(hook.script),
    on: "tool_call",
    tools: ["bash"],
    scope: "all",
    class: "enforced",
    interactive: false,
    timeoutMs: hook.timeout * 1000,
  }));
  const warnings: string[] = [];
  for (const plugin of plugins) {
    const declared = plugin.manifest.hooks?.length ?? 0;
    const kept = hooks.filter((hook) => hook.pluginId === plugin.manifest.id).length;
    if (declared > kept) {
      warnings.push(
        `Plugin '${plugin.manifest.id}': ${declared - kept} hook(s) are not translatable to Pi and were not installed.`,
      );
    }
  }
  return { bindings, warnings };
}

/**
 * Plugin script destinations Pi installs: those a bridge row runs, plus every script of a plugin
 * whose hook extension rides inside an installed Pi hook copy (the extension sources it).
 */
export function piInstalledPluginScripts(
  plugins: readonly LoadedPlugin[],
  pluginBindings: readonly PiPluginBinding[],
  coreHookPaths: ReadonlySet<string>,
): ReadonlySet<string> {
  const installed = new Set(pluginBindings.map((binding) => binding.path));
  for (const plugin of plugins) {
    const hosted = (plugin.hookExtensionAssets ?? []).some((extension) => {
      const target = hookExtensionTarget(extension.target, "pi");
      return target !== null && coreHookPaths.has(target);
    });
    if (!hosted) continue;
    for (const script of plugin.scriptAssets) installed.add(piScriptPath(script.dest));
  }
  return installed;
}

/** The body a plugin skill contributes, interpolated like every other engine. */
function subBlockBody(skill: LoadedPlugin["skillAssets"][number], config: NavoriConfig): string {
  return interpolate(stripFrontmatter(readFileSync(skill.absPath, "utf-8")), config, {
    extraVars: pluginExtraVars(config),
  });
}

const sourceOf = (plugin: LoadedPlugin): { source: string; version: string } => ({
  source: `@navori/plugin-${plugin.manifest.id}`,
  version: NAVORI_VERSION,
});

/**
 * Backticked bare MCP tool names (`mem_search`) become the navori tool the Pi child really holds
 * (`navori_mem_search`). Token-exact over the names granted to `roleId` only: any other mention
 * stays as written. Applies to core role prose as well (the scout orders `mem_search`).
 */
export function prefixKnowledgeNames(
  prose: string,
  roleId: string,
  grants: PiKnowledgeGrants,
): string {
  let out = prose;
  for (const held of grants[roleId as PiRoleName] ?? []) {
    const name = held.slice(PI_KNOWLEDGE_PREFIX.length);
    out = out.replaceAll(`\`${name}\``, `\`${held}\``);
  }
  return out;
}

/**
 * Prose a plugin appends to the role file `.pi/agents/<role>.md` (skills injecting into
 * `.claude/agents/<role>.md`). A plugin with an MCP server injects into a child role only when
 * the role holds its navori knowledge tools (`grants`, see `knowledge-tools.ts`), and then the prose
 * names those `navori_*` tools; otherwise Pi children run `--no-mcp` and `mcpRoleDiagnostics` names them.
 */
export function rolePluginProse(
  roleId: string,
  plugins: readonly LoadedPlugin[],
  config: NavoriConfig,
  grants: PiKnowledgeGrants = {},
): string {
  let prose = "";
  const held = grants[roleId as PiRoleName] ?? [];
  for (const plugin of plugins) {
    const table = PI_KNOWLEDGE_READONLY[plugin.manifest.id] ?? [];
    const granted = table.filter((tool) => held.includes(piKnowledgeToolName(tool)));
    if (plugin.manifest.mcpServer && granted.length === 0) continue;
    for (const skill of plugin.skillAssets) {
      if (skill.injectInto?.match(AGENT_INJECT_RE)?.[1] !== roleId) continue;
      const extension = parseAsset(readFileSync(skill.absPath, "utf-8"), "html");
      const body = interpolate(
        conditionOrchestration(extension.managedBody, config, "pi"),
        config,
        { extraVars: pluginExtraVars(config) },
      );
      prose += `\n\n${plugin.manifest.mcpServer ? prefixKnowledgeNames(body, roleId, grants) : body}`;
    }
  }
  return prose;
}

/**
 * Plugin sub-blocks for the orchestrator (the Pi main thread embodies it through `AGENTS.md`):
 * appended inside the managed body, idempotent by skill id.
 */
export function extendWithOrchestratorBlocks(
  body: string,
  plugins: readonly LoadedPlugin[],
  config: NavoriConfig,
): string {
  let out = body;
  for (const plugin of plugins) {
    for (const skill of plugin.skillAssets) {
      if (skill.injectInto !== ".claude/agents/orchestrator.md") continue;
      out = injectManagedSection(
        out,
        skill.id,
        subBlockBody(skill, config),
        sourceOf(plugin),
        "html",
      ).output;
    }
  }
  return out;
}

/** Read a pending (or on-disk) skill copy, or null when the base skill is not Pi's to write. */
function currentOf(cwd: string, pending: readonly PendingWrite[], rel: string): string | null {
  const abs = join(cwd, rel);
  const inPending = pending.find((write) => write.path === abs);
  if (inPending) return inPending.content;
  return existsSync(abs) ? readFileSync(abs, "utf-8") : null;
}

function setContent(
  cwd: string,
  pending: PendingWrite[],
  rel: string,
  content: string,
  status: PendingWrite["status"],
): void {
  const abs = join(cwd, rel);
  const inPending = pending.find((write) => write.path === abs);
  if (inPending) inPending.content = content;
  else pending.push({ path: abs, relPath: rel, content, status });
}

/**
 * Plugin skills extending another skill (`injectInto: .claude/skills/<id>/SKILL.md`) land as a
 * managed sub-block of `.agents/skills/<id>/SKILL.md`; a disabled plugin's sub-block is stripped.
 * Only called when Pi writes the shared skill root (Codex absent): Codex owns it otherwise.
 */
export function applySkillSubBlocks(input: {
  cwd: string;
  config: NavoriConfig;
  enabled: readonly LoadedPlugin[];
  disabled: readonly LoadedPlugin[];
  pending: PendingWrite[];
  warnings: string[];
  notInjected: (skill: string, plugin: string, target: string) => string;
}): void {
  for (const plugin of input.enabled) {
    for (const skill of plugin.skillAssets) {
      const target = skill.injectInto?.match(SKILL_INJECT_RE)?.[1];
      if (target === undefined) continue;
      const rel = `.agents/skills/${target}/SKILL.md`;
      const base = currentOf(input.cwd, input.pending, rel);
      if (base === null) {
        input.warnings.push(input.notInjected(skill.id, plugin.manifest.id, rel));
        continue;
      }
      const injected = injectManagedSection(
        base,
        skill.id,
        subBlockBody(skill, input.config),
        sourceOf(plugin),
        "html",
      );
      if (injected.status === "user-modified-skipped" || injected.status === "downgrade-skipped")
        continue;
      if (injected.output !== base) {
        setContent(input.cwd, input.pending, rel, injected.output, "updated");
      }
    }
  }
  for (const plugin of input.disabled) {
    for (const skill of plugin.skillAssets) {
      const target = skill.injectInto?.match(SKILL_INJECT_RE)?.[1];
      if (target === undefined) continue;
      const rel = `.agents/skills/${target}/SKILL.md`;
      const base = currentOf(input.cwd, input.pending, rel);
      if (base === null) continue;
      const stripped = removeManagedSection(base, skill.id, "html");
      if (stripped !== base) setContent(input.cwd, input.pending, rel, stripped, "updated");
    }
  }
}
