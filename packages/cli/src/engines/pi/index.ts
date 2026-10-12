import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { conditionOrchestration } from "../../lib/render/render-plan.ts";
import { join, resolve, sep } from "node:path";
import { effectiveConfig, type NavoriConfig } from "../../lib/config/config.ts";
import { getCoreRoot } from "../../lib/render/bundled-assets.ts";
import { loadPreset } from "../../lib/config/presets.ts";
import { resolveLang } from "../../lib/i18n.ts";
import { resolveHarnessPlan } from "../shared/harness-plan.ts";
import {
  collectPlan,
  commitWrites,
  type AdapterCtx,
  type EngineAdapter,
  type PendingWrite,
  type SkippedFile,
} from "../shared/execute-plan.ts";
import type { ProseEngineResult } from "../shared/prose-harness.ts";
import { renderAgentsMdEngine } from "../agents-md/index.ts";
import { ENGINE_CAPABILITIES } from "../shared/engine-capabilities.ts";
import { parseAsset } from "../claude/parse-asset.ts";
import { resolveCodexModel } from "../../lib/assets/model-profile.ts";
import { interpolate } from "../../lib/render/interpolate.ts";
import {
  ownsPiAgent,
  ownsPiManifest,
  ownsPiSource,
  PI_MANIFEST_SCHEMA,
  piManifestSchemaVersion,
  serializePiAgent,
  serializePiManifest,
  serializePiSource,
  type PiManifestHook,
} from "./owned-file.ts";
import { renderPiExtensionSource } from "./extension-source.ts";
import { activePiHookBindings, piHookPath, type PiHookBinding } from "./hook-bindings.ts";
import { buildPiDenyRules, collectShellPermissionRules } from "../shared/permission-rules.ts";
import { navoriAuthorship } from "../../lib/render/removable.ts";
import {
  buildLocalSkillPointerContent,
  classifyLocalSkills,
  localSkillPointerDestRel,
  localSkillPointerMarkerId,
  localSkillSourceAbs,
} from "../shared/local-skill-pointer.ts";
import { loadDisabledPlugins, loadEnabledPlugins } from "../../lib/config/plugins.ts";
import {
  applyHookExtension,
  hookExtensionTarget,
  removeHookExtension,
} from "../shared/hook-extension.ts";
import { pluginExtraVars } from "../shared/plugin-extra-vars.ts";
import { pluginScriptCollisions, pluginScriptPlacements } from "../shared/plugin-scripts.ts";
import {
  applySkillSubBlocks,
  extendWithOrchestratorBlocks,
  piBindingPath,
  piInstalledPluginScripts,
  piLivePlugins,
  resolvePiPluginHooks,
  rolePluginProse,
  type PiPluginBinding,
} from "./plugin-projection.ts";
import type { LoadedPlugin } from "../../lib/config/plugins.ts";
import { deriveMcpTools } from "../claude/agent-mcp-tools.ts";
import { tc } from "../../lib/i18n.ts";
import { PI_ROLE_TOOLS } from "./role-tools.ts";
import { mcpPluginIds, mcpServerDiagnostics } from "./mcp-diagnosis.ts";

const ROLE_TOOLS = PI_ROLE_TOOLS as Readonly<Record<string, readonly string[]>>;
const EXTENSION = ".pi/extensions/navori.ts";

const MANIFEST = ".pi/navori.json";
const HOOKS_DIR = ".pi/navori/hooks";
const SCRIPTS_DIR = ".pi/navori/scripts";
/** Plan-skill ids plus the local-skill pointers Pi may own in the shared `.agents/skills` root. */
interface PiSkillRoot {
  /** Local ids with a safe-to-write pointer (`emit`). */
  emit: readonly string[];
  /** Local ids whose destination is a foreign file (protected from pruning). */
  foreign: readonly string[];
}

/**
 * Pi adapter. Codex already owns the shared `.agents/skills` root when both engines are
 * enabled, so Pi writes (and prunes) nothing there then: one writer, one marker.
 */
function buildAdapter(
  local: PiSkillRoot,
  bindings: readonly PiHookBinding[],
  plugins: readonly LoadedPlugin[],
  pluginBindings: readonly PiPluginBinding[],
): EngineAdapter {
  const hookIds = new Set(bindings.map(({ script }) => script));
  const installedScripts = piInstalledPluginScripts(
    plugins,
    pluginBindings,
    new Set(bindings.map(({ script }) => piHookPath(script))),
  );
  return {
    id: "pi",
    label: "Pi Coding Agent",
    placeAgent: () => null,
    placeSkill: (skill, ctx) =>
      ctx.config.engines.includes("codex")
        ? null
        : {
            assetPath: skill.assetPath,
            destRelPath: `.agents/skills/${skill.id}/SKILL.md`,
            managedId: skill.managedId,
            commentStyle: "html",
          },
    // Spec 0048 D1: the shared script, copied to `.pi/navori/hooks/<id>.sh`, only for rows of the
    // binding table: one table decides what is installed, what the bridge runs and the manifest.
    placeHook: (hook, ctx) =>
      hookIds.has(hook.id)
        ? {
            assetPath: hook.assetPath,
            destRelPath: piHookPath(hook.id),
            managedId: hook.managedId,
            commentStyle: "shell",
            chmodExec: true,
            // Spec 0048 D15: the guard's Pi copy embeds the shared `deny` rules, translated once
            // for Pi and Codex alike. Every other copy keeps the "no rules" default.
            ...(hook.id === "guard-destructive"
              ? {
                  extraVars: {
                    piPermissionRules: buildPiDenyRules(
                      collectShellPermissionRules(ctx.config, ctx.plugins),
                    ),
                  },
                }
              : {}),
          }
        : null,
    // Same transform/marker/destination as the Codex pointer: the body stays in the user's
    // `.claude/skills/<id>/SKILL.md`, this entry only makes it discoverable (spec 0047 R9).
    extraFiles: (ctx) => {
      // Plugin scripts are Pi's own copies even when Codex is active (`.pi/navori/scripts`).
      const collisions = pluginScriptCollisions(ctx.plugins);
      const pluginScripts = ctx.plugins.flatMap((plugin) =>
        pluginScriptPlacements(plugin, "pi").flatMap((script) =>
          collisions.has(script.dest) || !installedScripts.has(script.destRelPath)
            ? []
            : [
                {
                  assetPath: script.src,
                  destRelPath: script.destRelPath,
                  managedId: script.managedId,
                  meta: script.meta,
                  extraVars: pluginExtraVars(ctx.config),
                  commentStyle: "shell" as const,
                  chmodExec: script.exec,
                },
              ],
        ),
      );
      if (ctx.config.engines.includes("codex")) return pluginScripts;
      const pointers = local.emit.flatMap((id) => {
        const sourceAbs = localSkillSourceAbs(ctx.cwd, id);
        if (sourceAbs === null) return [];
        return [
          {
            assetPath: sourceAbs,
            transform: (text: string) => buildLocalSkillPointerContent(text, id),
            destRelPath: localSkillPointerDestRel(id),
            managedId: localSkillPointerMarkerId(id),
            commentStyle: "html" as const,
          },
        ];
      });
      return [...pointers, ...pluginScripts];
    },
    orphanScans: (plan, ctx) => [
      // A script whose binding is gone (or whose `when` no longer holds) is pruned like any managed hook.
      {
        dir: HOOKS_DIR,
        match: (name) => name.endsWith(".sh"),
        desired: new Set(
          plan.hooks.filter(({ id }) => hookIds.has(id)).map(({ id }) => piHookPath(id)),
        ),
        shape: "file",
      },
      {
        dir: SCRIPTS_DIR,
        match: (name) => name.endsWith(".sh"),
        desired: new Set(installedScripts),
        shape: "file",
      },
      ...(ctx.config.engines.includes("codex")
        ? []
        : [
            {
              dir: ".agents/skills",
              match: () => true,
              desired: new Set([
                ...plan.skills.map(({ id }) => `.agents/skills/${id}/SKILL.md`),
                ...[...local.emit, ...local.foreign].map((id) => localSkillPointerDestRel(id)),
              ]),
              shape: "skill-dir" as const,
            },
          ]),
    ],
  };
}

/**
 * Pi discovers the repo-root context file natively (docs/configuration.md "Context files").
 * Pi delegates it to the agents-md adapter only when no other configured engine already owns
 * it (Codex, agents-md): one writer and one `navori-agents` block across every transition.
 */
function piNeedsContextWriter(config: NavoriConfig): boolean {
  return !config.engines.some(
    (engine) =>
      engine !== "pi" &&
      engine in ENGINE_CAPABILITIES &&
      ENGINE_CAPABILITIES[engine as keyof typeof ENGINE_CAPABILITIES].ownsAgentsMd,
  );
}

/**
 * Spec 0047 R10 (fail-closed): Pi children always run with `--no-mcp` (Pi 1.1.0 connects every
 * enabled server and lists them all in the child prompt, so per-server limiting is not
 * verifiable). An enabled plugin that injects MCP prose into a rendered Pi role therefore cannot
 * work there: direct, discovery and codemode access are all unavailable. Name each one.
 */
function mcpRoleDiagnostics(config: NavoriConfig, roles: ReadonlyArray<{ id: string }>): string[] {
  const roleIds = new Set(roles.map((role) => role.id));
  const out: string[] = [];
  for (const plugin of loadEnabledPlugins(config.plugins).loaded) {
    if (!plugin.manifest.mcpServer) continue;
    for (const skill of plugin.manifest.skills ?? []) {
      const role = skill.injectInto?.match(/^\.claude\/agents\/([a-z0-9-]+)\.md$/)?.[1];
      if (role === undefined || !roleIds.has(role)) continue;
      const tools = deriveMcpTools(plugin, skill.mcpTools).join(", ");
      out.push(
        `Pi role ${role} needs MCP tools from plugin ${plugin.manifest.id} (${tools}) but is unavailable for them in children: ` +
          "Pi children run with --no-mcp, so direct, discovery and codemode MCP access are all off. " +
          `Run that work from the parent session, or disable plugin ${plugin.manifest.id} for Pi.`,
      );
    }
  }
  return out;
}

/**
 * Who wrote a `.pi/**` file, judged ONLY by Pi's own validators (spec 0047 R11). The generic
 * prune test reads `navori:managed ... version=` or a `$navori` key, neither of which Pi's
 * strict JSON / `navori:managed-file` headers carry, so it cannot answer for them. `ours` needs
 * the exact canonical content and digest of a resource Pi writes; a recognizable Navori header
 * that no longer validates is `modified`; anything else (user settings, foreign agents,
 * symlinks) is `foreign`. A path Pi never writes is never `ours`.
 */
export function piOwnershipVerdict(cwd: string, rel: string): "ours" | "modified" | "foreign" {
  const path = join(cwd, rel);
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (!stats?.isFile() || stats.isSymbolicLink()) return "foreign";
  // Hook scripts are marker-managed (shell comments) with a user-section, not whole-file owned.
  if (/^\.pi\/navori\/(hooks\/[a-z0-9-]+|scripts\/[A-Za-z0-9_][A-Za-z0-9_./-]*)\.sh$/.test(rel)) {
    const authorship = navoriAuthorship(path, undefined, { verifyHash: true });
    return authorship === "ours" ? "ours" : authorship === "foreign" ? "foreign" : "modified";
  }
  const content = readFileSync(path, "utf-8");
  const agent = /^\.pi\/agents\/([a-z-]+)\.md$/.exec(rel)?.[1];
  const owned =
    rel === MANIFEST
      ? ownsPiManifest(content)
      : rel === EXTENSION
        ? ownsPiSource(content)
        : agent !== undefined && Object.hasOwn(ROLE_TOOLS, agent) && ownsPiAgent(content, agent);
  if (owned) return "ours";
  const claimsNavori =
    content.includes('navori:managed-file id="pi-') ||
    /"_navori"\s*:\s*{\s*"id": "pi-runtime"/.test(content);
  return claimsNavori ? "modified" : "foreign";
}

/** Render the opt-in Pi manifest through the shared plan and commit choke point. */
export function renderPiEngine(
  cwd: string,
  inputConfig: NavoriConfig,
  options: {
    dryRun?: boolean;
    repoRoot?: string;
    /** Test seam: the rows to install instead of {@link PI_HOOK_BINDINGS}. */
    hookBindings?: readonly PiHookBinding[];
  } = {},
): ProseEngineResult {
  const config = effectiveConfig(inputConfig);
  const coreBindings = activePiHookBindings(config, options.hookBindings);
  const repoRoot = options.repoRoot ?? cwd;
  const loadedPlugins = loadEnabledPlugins(config.plugins);
  // Spec 0048 D13: the plugins Pi projects (the matrix may mark one native on Pi).
  const plugins = piLivePlugins(loadedPlugins.loaded);
  const pluginHooks = resolvePiPluginHooks(plugins);
  const bindings: readonly (PiHookBinding | PiPluginBinding)[] = [
    ...coreBindings,
    ...pluginHooks.bindings,
  ];
  const coreAssets = resolve(getCoreRoot(), "core-assets");
  const preset =
    config.preset && config.preset !== "custom" ? loadPreset(config.preset, repoRoot) : null;
  const ctx: AdapterCtx = {
    cwd,
    config,
    repoRoot,
    isWorkspace: resolve(cwd) !== resolve(repoRoot),
    coreAssets,
    preset,
    plugins,
  };
  const plan = resolveHarnessPlan(config, coreAssets, preset);
  const lang = resolveLang(config.language);
  const localSkills = classifyLocalSkills(
    cwd,
    config.project?.localSkills ?? [],
    new Set(plan.skills.map((s) => s.id)),
  );
  const adapter = buildAdapter(localSkills, coreBindings, plugins, pluginHooks.bindings);
  const collected = collectPlan(plan, adapter, ctx, { lang });
  const warnings: string[] = [];
  const disabledPlugins = loadDisabledPlugins(config.plugins).loaded;
  // Codex owns the shared skill root when active: its sub-blocks come from there, never twice.
  if (!config.engines.includes("codex")) {
    applySkillSubBlocks({
      cwd,
      config,
      enabled: plugins,
      disabled: disabledPlugins,
      pending: collected.pending,
      warnings,
      notInjected: tc(lang).engine.pluginSkillNotInjected,
    });
  }
  // Hook extensions ride inside Pi's own copy of the hook they extend (the extension body is
  // engine-neutral); a target Pi does not install is left alone.
  const extensionSkipped: SkippedFile[] = [];
  const installedHooks = new Set(coreBindings.map(({ script }) => piHookPath(script)));
  for (const plugin of plugins) {
    for (const extension of plugin.hookExtensionAssets ?? []) {
      const target = hookExtensionTarget(extension.target, "pi");
      if (target === null || !installedHooks.has(target)) continue;
      applyHookExtension({
        cwd,
        plugin,
        extension,
        target,
        config,
        pending: collected.pending,
        skipped: extensionSkipped,
        updatesAvailable: [],
        downgrades: [],
        withRelPath: true,
      });
    }
  }
  for (const plugin of disabledPlugins) {
    for (const extension of plugin.hookExtensionAssets ?? []) {
      const target = hookExtensionTarget(extension.target, "pi");
      if (target === null) continue;
      removeHookExtension({
        cwd,
        extension,
        target,
        pending: collected.pending,
        withRelPath: true,
      });
    }
  }
  const scribeOwnsMarkdown = config.harness?.scribeOwnsMarkdown ?? false;
  // The scribe is admitted only as the Markdown producer the project policy requires.
  const admitted = (id: string): boolean =>
    Object.hasOwn(ROLE_TOOLS, id) && (id !== "scribe" || scribeOwnsMarkdown);
  const roles = plan.agents.filter((agent) => admitted(agent.id));
  warnings.push(
    ...plan.agents
      .filter((agent) => !Object.hasOwn(ROLE_TOOLS, agent.id))
      .map((agent) => `Pi subagent role ${agent.id} is unsupported and was not rendered.`),
  );
  if (!config.engines.includes("codex")) {
    for (const id of localSkills.foreign) {
      warnings.push(tc(lang).engine.localSkillForeignPointer(localSkillPointerDestRel(id)));
    }
  }
  for (const { id, reason } of loadedPlugins.missing) {
    warnings.push(`Pi could not load plugin ${id}: ${reason}`);
  }
  warnings.push(...pluginHooks.warnings);
  warnings.push(...mcpRoleDiagnostics(config, roles));
  warnings.push(...mcpServerDiagnostics(cwd, config));
  if (scribeOwnsMarkdown && !roles.some((agent) => agent.id === "scribe")) {
    warnings.push(
      "harness.scribeOwnsMarkdown forbids implementer Markdown but the scribe role is disabled; Pi implementer dispatch is refused until harness.scribe is enabled or scribeOwnsMarkdown is turned off.",
    );
  }
  const hooks: PiManifestHook[] = bindings.map((binding) => ({
    script: binding.script,
    path: piBindingPath(binding),
    on: binding.on,
    ...(binding.tools ? { tools: [...binding.tools] } : {}),
    scope: binding.scope,
    class: binding.class,
    interactive: binding.interactive,
    timeoutMs: binding.timeoutMs,
  }));
  const permissions = collectShellPermissionRules(config, ctx.plugins);
  const serialized = serializePiManifest({
    schemaVersion: PI_MANIFEST_SCHEMA,
    agents: roles.map((r) => r.id),
    controls: {
      planTiers: config.harness?.planTiers ?? false,
      masterPlan: config.harness?.masterPlan ?? false,
      scribeOwnsMarkdown,
    },
    hooks,
    // Whole-file destinations only; AGENTS.md and skills mix user text with managed blocks (marker lane).
    ownedPaths: [
      MANIFEST,
      EXTENSION,
      ...roles.map((agent) => `.pi/agents/${agent.id}.md`),
      ...hooks.map((hook) => hook.path),
    ],
    permissionRules: { ask: permissions.ask, deny: permissions.deny },
  });
  const extension = serializePiSource(renderPiExtensionSource(mcpPluginIds(config)));
  const resources: Array<{ relPath: string; content: string; owned: (value: string) => boolean }> =
    [
      { relPath: MANIFEST, content: serialized, owned: ownsPiManifest },
      { relPath: EXTENSION, content: extension, owned: ownsPiSource },
    ];
  for (const agent of roles) {
    const parsed = parseAsset(readFileSync(agent.assetPath, "utf-8"), "html");
    const description = interpolate(parsed.frontmatter.description ?? agent.id, config);
    // Resolve `navori:if` markers like every other engine; `onCodex` is false here.
    const instructions = interpolate(
      conditionOrchestration(parsed.managedBody, config, "pi"),
      config,
    );
    const tier = agent.modelKey ? config.models?.[agent.modelKey] : undefined;
    // codexMap values may be a Codex family (resolved against the local catalog)
    // or a full id (verbatim). The never-downgrade rule is Codex-specific (it
    // reads a rendered .codex toml), so Pi resolves catalog-or-fallback only.
    const mapped = tier ? config.models?.codexMap?.[tier] : undefined;
    const resolved = tier && mapped ? resolveCodexModel(config, tier) : undefined;
    const model =
      resolved === undefined
        ? undefined
        : resolved.source === "pin"
          ? resolved.model
          : `openai-codex/${resolved.model}`;
    if (tier && !mapped) {
      warnings.push(
        `Pi role ${agent.id} has a model tier but no concrete codexMap.${tier}; inheriting the selected Pi model.`,
      );
    }
    const content = serializePiAgent({
      name: agent.id,
      description,
      ...(model ? { model } : {}),
      tools: ROLE_TOOLS[agent.id]!,
      instructions: instructions + rolePluginProse(agent.id, plugins, config),
    });
    resources.push({
      relPath: `.pi/agents/${agent.id}.md`,
      content,
      owned: (value) => ownsPiAgent(value, agent.id),
    });
  }
  // Complete-generation validation precedes any pending Pi write.
  for (const resource of resources) {
    if (!resource.owned(resource.content))
      throw new Error(`Generated Pi resource failed validation: ${resource.relPath}`);
  }
  // Resolutions are sync-side: Pi's ownership/symlink checks only run in its own apply.
  const skipped: SkippedFile[] = collected.skipped.map(
    ({ resolution: _resolution, ...skip }) => skip,
  );
  const piPending: PendingWrite[] = [];
  // `.pi/navori/**` joins the all-or-nothing rule: an edited managed block in a hook copy means the
  // extension, manifest and scripts are not committed as a mixed generation (spec 0048 "Render parcial").
  const navoriDir = join(cwd, ".pi/navori") + sep;
  let collided =
    extensionSkipped.length > 0 ||
    collected.skipped.some((skip) => skip.path.startsWith(".pi/navori/"));
  skipped.push(...extensionSkipped);
  for (const relPath of [".pi", ".pi/extensions", ".pi/agents", ".pi/navori", HOOKS_DIR]) {
    const path = join(cwd, relPath);
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`Pi resource parent is a symlink: ${relPath}`);
    }
  }
  for (const resource of resources) {
    const path = join(cwd, resource.relPath);
    const existing = lstatSync(path, { throwIfNoEntry: false });
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink()) {
        collided = true;
        skipped.push({
          path: resource.relPath,
          reason: "Pi resource is not a regular owned file.",
          status: "user-modified-skipped",
        });
        continue;
      }
      const current = readFileSync(path, "utf-8");
      if (!resource.owned(current)) {
        collided = true;
        // Anti-downgrade: a manifest written by a NEWER Navori is never overwritten.
        const newer =
          resource.relPath === MANIFEST &&
          (piManifestSchemaVersion(current) ?? 0) > PI_MANIFEST_SCHEMA;
        skipped.push({
          path: resource.relPath,
          reason: newer
            ? "Pi manifest was written by a newer Navori; update this CLI before rendering."
            : "Pi resource ownership mismatch; preserved user file.",
          status: newer ? "downgrade-skipped" : "user-modified-skipped",
        });
      } else if (current !== resource.content) {
        piPending.push({
          path,
          relPath: resource.relPath,
          content: resource.content,
          status: "updated",
        });
      }
    } else {
      piPending.push({
        path,
        relPath: resource.relPath,
        content: resource.content,
        status: "created",
      });
    }
  }

  const desiredAgents = new Set(roles.map((agent) => `${agent.id}.md`));
  const agentDir = join(cwd, ".pi/agents");
  const removals = [...collected.removals];
  if (existsSync(agentDir)) {
    for (const name of readdirSync(agentDir)) {
      if (
        !name.endsWith(".md") ||
        desiredAgents.has(name) ||
        !Object.hasOwn(ROLE_TOOLS, name.slice(0, -3))
      )
        continue;
      const path = join(agentDir, name);
      if (
        lstatSync(path).isFile() &&
        !lstatSync(path).isSymbolicLink() &&
        ownsPiAgent(readFileSync(path, "utf-8"), name.slice(0, -3))
      ) {
        removals.push({ path });
      } else {
        collided = true;
        skipped.push({
          path: `.pi/agents/${name}`,
          reason: "Pi orphan ownership mismatch; preserved user file.",
          status: "user-modified-skipped",
        });
      }
    }
  }
  if (collided) {
    warnings.push(
      "Pi generation was not committed because at least one owned destination collides or was edited.",
    );
  }
  const pending: PendingWrite[] = [
    ...(collided
      ? collected.pending.filter((write) => !write.path.startsWith(navoriDir))
      : collected.pending),
    ...(!collided ? piPending : []),
  ];

  const result = commitWrites({
    pending,
    removals: collided
      ? collected.removals.filter((removal) => !removal.path.startsWith(navoriDir))
      : removals,
    cwd,
    dryRun: options.dryRun,
    engineLabel: adapter.label,
    lang: resolveLang(config.language),
  });
  if (!piNeedsContextWriter(config)) return { ...result, skipped, warnings };
  // Foreign content outside the managed block and a hand-edited block are preserved by the
  // shared prose renderer. Its Claude-parity advisories do not apply to Pi and are dropped.
  // Pi is the only writer of the shared context file here, so it also carries the plugin blocks
  // and the orchestrator sub-blocks (Codex, when active, does it for them: no duplication).
  const context = renderAgentsMdEngine(cwd, config, {
    ...options,
    includePluginBlocks: true,
    extendBody: (body) => extendWithOrchestratorBlocks(body, plugins, config),
  });
  return {
    written: [...result.written, ...context.written],
    skipped: [...skipped, ...context.skipped],
    warnings,
    backupPath: result.backupPath ?? context.backupPath,
  };
}
