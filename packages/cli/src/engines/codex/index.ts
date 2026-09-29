import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import { effectiveConfig, type NavoriConfig } from "../../lib/config/config.ts";
import { getCoreRoot, readCliVersion } from "../../lib/render/bundled-assets.ts";
import {
  loadDisabledPlugins,
  loadEnabledPlugins,
  type LoadedPlugin,
} from "../../lib/config/plugins.ts";
import { unknownLibraries } from "../../lib/assets/library-skills.ts";
import {
  droppedLibrariesWarnings,
  isPresetLoaded,
  loadPreset,
  PresetError,
} from "../../lib/config/presets.ts";
import { tc, resolveLang } from "../../lib/i18n.ts";
import { parseAsset } from "../claude/parse-asset.ts";
import { interpolate } from "../../lib/render/interpolate.ts";
import {
  getFrontmatterField,
  removeFrontmatterField,
  splitFrontmatter,
  stripFrontmatter,
} from "../../lib/render/frontmatter.ts";
import {
  extractManagedContent,
  injectManagedSection,
  removeManagedSection,
} from "../../lib/render/marker.ts";
import { buildHarnessProse, type ProseEngineResult } from "../shared/prose-harness.ts";
import { buildAgentsIndexBlock } from "../shared/agents-index.ts";
import { pluginExtraVars } from "../shared/plugin-extra-vars.ts";
import { pluginScriptCollisions, pluginScriptPlacements } from "../shared/plugin-scripts.ts";
import {
  resolveHarnessPlan,
  type PlannedAgent,
  type PlannedSkill,
} from "../shared/harness-plan.ts";
import {
  collectPlan,
  commitWrites,
  type AdapterCtx,
  type EngineAdapter,
  type PlacementRequest,
} from "../shared/execute-plan.ts";
import { buildCodexConfigToml } from "./build-config-toml.ts";
import { codexHookCommand, resolvePluginCodexHooks } from "./hook-registrations.ts";
import { buildCodexRules } from "./build-rules.ts";
import { collectShellPermissionRules } from "../shared/permission-rules.ts";
import { adaptHarnessTextForCodex } from "./compat.ts";
import {
  buildLocalSkillPointerContent,
  classifyLocalSkills,
  isManualOnlyLocalSkill,
  localSkillPointerDestRel,
  localSkillPointerMarkerId,
  localSkillSourceAbs,
  type ClassifiedLocalSkills,
} from "./local-skill-pointer.ts";

import { resolveCodexModel } from "../../lib/assets/model-profile.ts";

const NAVORI_VERSION = readCliVersion();

// A plugin skill declared with `injectInto: .claude/skills/<id>/SKILL.md` (or the
// flat legacy `.claude/skills/<id>.md`) extends an existing skill. Captures the
// target skill id; skill→agent injectInto (`.claude/agents/<id>.md`) does NOT
// match here — that path is handled inside buildAgentToml.
const SKILL_INJECT_RE = /^\.claude\/skills\/([a-z0-9-]+)(?:\/SKILL)?\.md$/;

// A plugin skill can also inject into an agent (`injectInto: .claude/agents/<id>.md`).
// The orchestrator is embodied by the main thread (appended to AGENTS.md); other rendered
// agents are covered by buildAgentToml. A target that is NEITHER — a disabled or
// otherwise non-rendered agent — would drop silently, so we warn (#277).
const AGENT_INJECT_RE = /^\.claude\/agents\/([a-z0-9-]+)\.md$/;

/**
 * Codex's confirmed native equivalent of Claude's `disable-model-invocation`
 * (https://developers.openai.com/codex/skills, verified): a sibling
 * `agents/openai.yaml` inside the skill dir with `allow_implicit_invocation:
 * false` stops implicit (natural-language) triggering; explicit `$<skill>`
 * invocation still works. #823.
 */
const OPENAI_MANUAL_ONLY_POLICY = "policy:\n  allow_implicit_invocation: false\n";

/** Read straight off the skill's own frontmatter rather than a per-skill list,
 * so any skill that opts out of model invocation gets the Codex sidecar
 * automatically — never keyed to one skill's id. */
function isManualOnlySkill(assetPath: string): boolean {
  const { frontmatter } = splitFrontmatter(readFileSync(assetPath, "utf-8"));
  return getFrontmatterField(frontmatter, "disable-model-invocation") === "true";
}

export type CodexEngineResult = ProseEngineResult;

/**
 * Full Codex adapter (Spec 0007, Capa 2). Codex v0.145 discovers repo skills
 * from `.agents/skills`, project config/hooks/agents from `.codex/`, and
 * durable guidance from `AGENTS.md`. This module only maps each planned asset
 * to a destination + serialization; the render pipeline lives in executePlan.
 */
export function renderCodexEngine(
  cwd: string,
  inputConfig: NavoriConfig,
  options: { dryRun?: boolean; repoRoot?: string } = {},
): CodexEngineResult {
  const config = effectiveConfig(inputConfig);
  const lang = resolveLang(config.language);
  const dryRun = options.dryRun === true;
  const repoRoot = options.repoRoot ?? cwd;
  const isWorkspace = resolve(repoRoot) !== resolve(cwd);
  const coreAssets = resolve(getCoreRoot(), "core-assets");
  const pluginsResult = loadEnabledPlugins(config.plugins);
  const plugins = pluginsResult.loaded;

  const warnings = pluginsResult.missing.map(({ id, reason }) =>
    tc(lang).engine.pluginLoadFailedCodex(id, reason),
  );
  // Spec 0035 D10/T10: the unconditional "review with /hooks" reminder moved
  // to `renderNonClaudeEngines` (render.ts), which only prints it when
  // `readCodexTrustState` finds something actually missing, and points at
  // `navori codex trust` instead of the deprecated `/hooks` flow.

  const preset = loadActivePreset(config, repoRoot, warnings);
  const presetLoadedSafely = isPresetLoaded(config, preset);

  // Subpath from the repo root to this render's cwd ("" at the root, e.g.
  // "apps/backend" in a workspace), normalized to POSIX for the bash hook command
  // (#279). Lets config.toml point at the hook co-located with THIS workspace.
  const wsSubpath = isWorkspace
    ? relative(resolve(repoRoot), resolve(cwd)).split(sep).join("/")
    : "";

  const plan = resolveHarnessPlan(config, coreAssets, preset);
  // Mirror of the Claude engine's unknown-library warning (audit v0.5.1 A1):
  // an id the plan skipped silently would lose its guidance without signal.
  for (const lib of unknownLibraries(config.project?.libraries)) {
    warnings.push(
      lib.removed
        ? tc(lang).engine.libraryRemovedFromRegistry(lib.id, lib.successors)
        : tc(lang).engine.libraryUnknownInRegistry(lib.id),
    );
  }

  // Spec 0033 D2 (R9-R12): classify `project.localSkills` ids once — `plan`
  // already exists here, so this is the one call site that gets `plan.skills`
  // for free instead of re-deriving it. `emit` is threaded into the adapter
  // below so `extraFiles`/`orphanScans` never re-derive the same question with
  // a different criterion. `missing` is NOT reported here: R11 requires
  // `render` to name it regardless of which engines are configured, exactly
  // once per run — `commands/render.ts` owns that (a single centralized
  // check), so a claude+codex repo never sees it twice. `foreign` stays here:
  // it's specifically about the `.agents/skills/<id>/` destination, which only
  // exists when Codex renders.
  const localSkills = classifyLocalSkills(
    cwd,
    config.project?.localSkills ?? [],
    new Set(plan.skills.map((s) => s.id)),
  );
  for (const id of localSkills.foreign) {
    warnings.push(tc(lang).engine.localSkillForeignCodex(localSkillPointerDestRel(id)));
  }

  // Floor / safety net (#277): a plugin skill targeting an agent Codex neither
  // renders as a `.toml` (buildAgentToml) nor embodies as the orchestrator (appended to
  // AGENTS.md) is dropped silently. Warn so a disabled/unknown agent target surfaces
  // instead of vanishing — mirroring how the prose engines report their omissions.
  const renderedAgentIds = new Set(plan.agents.map((a) => a.id));
  for (const plugin of plugins) {
    for (const skill of plugin.skillAssets) {
      const injectInto = skill.injectInto;
      if (injectInto === undefined) continue;
      const agentId = injectInto.match(AGENT_INJECT_RE)?.[1];
      if (agentId === undefined || agentId === "orchestrator" || renderedAgentIds.has(agentId))
        continue;
      warnings.push(
        tc(lang).engine.pluginSkillNotInjected(skill.id, plugin.manifest.id, injectInto),
      );
    }
  }

  const ctx: AdapterCtx = { cwd, config, repoRoot, isWorkspace, coreAssets, preset, plugins };
  // Spec 0035 T6/T7 (D5, D8): `.codex/config.toml` and `.codex/rules/navori.rules`
  // are now built INSIDE `extraFiles`, after `AGENTS.md`'s planned body is known
  // — `project_doc_max_bytes` needs its byte size (R12), and both need only
  // `wsSubpath`/`localSkills`, already closed over here. `codexWarnings` is the
  // channel back out: `extraFiles` runs deep inside `collectPlan`, so it can't
  // push onto the outer `warnings` array directly.
  const codexWarnings: string[] = [];
  const adapter = createCodexAdapter(wsSubpath, localSkills, codexWarnings);

  // Split collect/commit so plugin skills that extend another skill (injectInto
  // a `.claude/skills/<id>/SKILL.md`, e.g. jscpd → review-diff) can be
  // appended as a managed sub-block BEFORE the single write — mirroring the
  // Claude adapter, but into Codex's `.agents/skills/<id>/SKILL.md` and adapted
  // to Codex's vocabulary. (skill→agent injectInto is handled in buildAgentToml.)
  const { pending, removals, skipped, kept } = collectPlan(plan, adapter, ctx, {
    prune: presetLoadedSafely,
    lang,
  });
  warnings.push(...codexWarnings);
  for (const write of pending) {
    if (!write.relPath.startsWith(".codex/scripts/") || write.status !== "updated") continue;
    const old = readFileSync(write.path, "utf-8");
    const oldBody = extractManagedContent(old, scriptManagedId(old), "shell");
    const newBody = extractManagedContent(write.content, scriptManagedId(write.content), "shell");
    if (oldBody !== null && newBody !== null && oldBody !== newBody) {
      warnings.push(tc(lang).engine.codexPluginScriptChanged(write.relPath));
    }
  }
  if (skipped.some((item) => item.path === ".codex/config.toml")) {
    const configPath = join(cwd, ".codex/config.toml");
    if (existsSync(configPath)) {
      const configText = readFileSync(configPath, "utf-8");
      const registered = projectHookCommands(configText);
      for (const hook of resolvePluginCodexHooks(loadDisabledPlugins(config.plugins).loaded)
        .hooks) {
        const command = codexHookCommand(hook, wsSubpath);
        if (registered.has(command) || configText.includes(command)) {
          warnings.push(tc(lang).engine.codexResidualPluginHook(hook.scriptPath ?? hook.script));
        }
      }
    }
  }
  // R39/R41 (spec 0026 T10): Codex reports a kept orphan the same way Claude's
  // §8.7b–d retirement loops do — path + reason, plain text in `warnings`,
  // never silently skipped. Generic over every orphan scan (agents/skills/
  // hooks), a superset of "retired ids" that stays correct once T11 starts
  // pruning old agent ids here too.
  for (const k of kept) {
    warnings.push(tc(lang).engine.keptOrphanCodex(k.path, k.reason));
  }
  for (const plugin of plugins) {
    for (const skill of plugin.skillAssets) {
      const m = skill.injectInto?.match(SKILL_INJECT_RE);
      if (!m) continue;
      const targetRel = `.agents/skills/${m[1]}/SKILL.md`;
      const targetAbs = join(cwd, targetRel);
      // The base skill may not be in `pending` if it's unchanged this render
      // (e.g. `navori add jscpd` on an already-rendered repo). Fall back to
      // the on-disk copy and add it back to the write set, like the Claude adapter.
      const inPending = pending.find((p) => p.path === targetAbs);
      const baseContent =
        inPending?.content ?? (existsSync(targetAbs) ? readFileSync(targetAbs, "utf-8") : null);
      if (baseContent === null) {
        warnings.push(
          tc(lang).engine.pluginSkillNotInjected(skill.id, plugin.manifest.id, targetRel),
        );
        continue;
      }
      const subBlock = adaptHarnessTextForCodex(
        interpolate(stripFrontmatter(readFileSync(skill.absPath, "utf-8")), config, {
          extraVars: pluginExtraVars(config),
        }),
        config,
      );
      const injected = injectManagedSection(
        baseContent,
        skill.id,
        subBlock,
        { source: `@navori/plugin-${plugin.manifest.id}`, version: NAVORI_VERSION },
        "html",
      );
      if (inPending) {
        inPending.content = injected.output;
      } else if (injected.status === "created" || injected.status === "updated") {
        pending.push({
          path: targetAbs,
          relPath: targetRel,
          content: injected.output,
          status: injected.status,
        });
      }
    }
  }

  // Reconcile DISABLED plugins — mirror of the Claude engine's §8.5 (#80), here
  // for Codex (#211). A plugin turned off via `navori remove` (phase 1 renders
  // with `enabled: false` BEFORE phase 2 drops the config key) still has its
  // injectInto sub-block sitting in `.agents/skills/<id>/SKILL.md`: that file was
  // only ever touched on the enabled path above, so without this it would orphan
  // permanently — no future render could see the plugin to clean it. Strip the
  // sub-block by id while the disabled entry still declares the plugin.
  for (const plugin of loadDisabledPlugins(config.plugins).loaded) {
    for (const skill of plugin.skillAssets) {
      const m = skill.injectInto?.match(SKILL_INJECT_RE);
      if (!m) continue;
      const targetRel = `.agents/skills/${m[1]}/SKILL.md`;
      const targetAbs = join(cwd, targetRel);
      const inPending = pending.find((p) => p.path === targetAbs);
      const currentContent =
        inPending?.content ?? (existsSync(targetAbs) ? readFileSync(targetAbs, "utf-8") : null);
      if (currentContent === null) continue; // target file gone — nothing to strip
      const stripped = removeManagedSection(currentContent, skill.id, "html");
      if (stripped === currentContent) continue; // sub-block not present
      if (inPending) {
        inPending.content = stripped;
      } else {
        pending.push({ path: targetAbs, relPath: targetRel, content: stripped, status: "updated" });
      }
    }
  }

  const { written, backupPath } = commitWrites({
    pending,
    removals,
    cwd,
    dryRun,
    writeLast: (p) => p.path.endsWith("/AGENTS.md"),
    engineLabel: adapter.label ?? adapter.id,
    lang,
  });

  return {
    written,
    skipped,
    warnings: isWorkspace ? [] : warnings,
    backupPath,
  };
}

/** Read only executable command handlers, not comments or incidental TOML text. */
function projectHookCommands(content: string): Set<string> {
  try {
    const parsed: unknown = parseToml(content);
    if (typeof parsed !== "object" || parsed === null || !("hooks" in parsed)) return new Set();
    const groups = parsed.hooks;
    if (typeof groups !== "object" || groups === null) return new Set();
    const commands = new Set<string>();
    for (const entries of Object.values(groups)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (typeof entry !== "object" || entry === null || !("hooks" in entry)) continue;
        if (!Array.isArray(entry.hooks)) continue;
        for (const handler of entry.hooks) {
          if (
            typeof handler === "object" &&
            handler !== null &&
            "type" in handler &&
            handler.type === "command" &&
            "command" in handler &&
            typeof handler.command === "string"
          )
            commands.add(handler.command);
        }
      }
    }
    return commands;
  } catch {
    return new Set();
  }
}

/** The generated script's opening marker carries its unique managed id. */
function scriptManagedId(content: string): string {
  return content.match(/^# navori:managed start id="([^"]+)"/m)?.[1] ?? "";
}

/**
 * Builds a fresh, stateful adapter per render. `placeAgent` accumulates the
 * agent catalog that `extraFiles` folds into AGENTS.md, and `placeSkill`
 * accumulates the manual-only skills that `extraFiles` turns into
 * `agents/openai.yaml` sidecars (#823) — so the executor must place
 * agents/skills before calling extraFiles (it does, see `collectPlan`).
 */
function createCodexAdapter(
  wsSubpath: string,
  localSkills: ClassifiedLocalSkills,
  /** Mutated in place — `extraFiles` runs inside `collectPlan`, so this is the
   *  only channel back to the caller's `warnings` array (spec 0035 T6/T7). */
  warningsSink: string[],
): EngineAdapter {
  const agentCatalog: Array<{ id: string; description: string }> = [];
  const manualOnlySkillIds: string[] = [];

  return {
    id: "codex",
    label: "Codex",

    placeAgent(agent, ctx): PlacementRequest {
      const { body, description } = buildAgentToml(agent, ctx.config, ctx.plugins);
      agentCatalog.push({ id: agent.id, description });
      // Codex auto-discovers standalone project agents from `.codex/agents/`;
      // config.toml does not need one registration table per file.
      return {
        body,
        destRelPath: `.codex/agents/${agent.id}.toml`,
        managedId: `${agent.id}-codex-base`,
        commentStyle: "shell",
      };
    },

    placeSkill(skill, ctx): PlacementRequest {
      if (isManualOnlySkill(skill.assetPath)) manualOnlySkillIds.push(skill.id);
      return {
        assetPath: skill.assetPath,
        // #364: skills ship as raw assets, so without this the body kept
        // pointing at `.claude/progress/` while the adapted agents read and
        // write `.codex/progress/` — the 8-phase pipeline scattered its
        // artifacts across two directories and the gates found nothing.
        //
        // #823: `disable-model-invocation` is dropped AFTER the vocabulary
        // pass, here rather than in `adaptHarnessTextForCodex` — that function
        // is a generic prose adapter that also runs over AGENTS.md and every
        // agent `.toml`, neither of which has skill frontmatter to strip.
        // Codex's own equivalent is emitted separately, as `agents/openai.yaml`
        // (see `extraFiles`), not as a frontmatter key.
        transform: (text) =>
          removeFrontmatterField(
            adaptHarnessTextForCodex(text, ctx.config),
            "disable-model-invocation",
          ),
        destRelPath: `.agents/skills/${skill.id}/SKILL.md`,
        managedId: skill.managedId,
        commentStyle: "html",
      };
    },

    placeHook(hook): PlacementRequest {
      return {
        assetPath: hook.assetPath,
        destRelPath: `.codex/hooks/${hook.id}.sh`,
        managedId: hook.managedId,
        commentStyle: "shell",
        chmodExec: true,
      };
    },

    extraFiles(ctx): PlacementRequest[] {
      // Spec 0033 D2: one pointer per `emit` id, `assetPath` pointed at the
      // SOURCE (`.claude/skills/<id>/SKILL.md`) so frontmatter merge, version
      // stamping and anti-rollback all come from `renderManagedFile` for free
      // — `transform` swaps the body for the pointer text, never the source's
      // own prose. `missing`/`foreign` get no request at all (R11, R12).
      const localSkillManualOnlyIds: string[] = [];
      const localSkillRequests: PlacementRequest[] = [];
      for (const id of localSkills.emit) {
        const sourceAbs = localSkillSourceAbs(ctx.cwd, id);
        if (sourceAbs === null) continue; // classify guarantees this for `emit`, guard for TS
        if (isManualOnlyLocalSkill(sourceAbs)) localSkillManualOnlyIds.push(id);
        localSkillRequests.push({
          assetPath: sourceAbs,
          transform: (text) => buildLocalSkillPointerContent(text, id),
          destRelPath: localSkillPointerDestRel(id),
          managedId: localSkillPointerMarkerId(id),
          commentStyle: "html",
        });
      }
      // R12/D8: `project_doc_max_bytes` needs the PLANNED AGENTS.md size, not
      // whatever is on disk — both files are written by this same render.
      const agentsMdRequest = buildAgentsMdRequest(ctx, agentCatalog);
      const agentsMdBytes = Buffer.byteLength(agentsMdRequest.body ?? "", "utf-8");

      // R9/R10 (D5): translate the SAME permission source Claude writes into
      // `.claude/settings.json` into `.codex/rules/navori.rules`.
      const permissionRules = collectShellPermissionRules(ctx.config, ctx.plugins);
      const codexRules = buildCodexRules(permissionRules);
      const droppedNotBash = codexRules.dropped.filter((d) => d.reason === "not-bash").length;
      const droppedWildcard = codexRules.dropped.filter(
        (d) => d.reason === "inner-wildcard",
      ).length;
      if (codexRules.dropped.length > 0 || codexRules.narrowed.length > 0) {
        warningsSink.push(
          tc(resolveLang(ctx.config.language)).engine.codexRulesSummary(
            droppedNotBash,
            droppedWildcard,
            codexRules.narrowed.length,
          ),
        );
      }

      const codexConfig = buildCodexConfigToml(ctx.config, ctx.plugins, wsSubpath, agentsMdBytes);
      warningsSink.push(...codexConfig.warnings);

      const collisions = pluginScriptCollisions(ctx.plugins);
      const pluginScripts: PlacementRequest[] = [];
      for (const plugin of ctx.plugins) {
        for (const script of pluginScriptPlacements(plugin, "codex")) {
          if (collisions.has(script.dest)) continue;
          pluginScripts.push({
            assetPath: script.src,
            destRelPath: script.destRelPath,
            managedId: script.managedId,
            meta: script.meta,
            extraVars: pluginExtraVars(ctx.config),
            commentStyle: "shell",
            chmodExec: script.exec,
          });
        }
      }

      return [
        agentsMdRequest,
        {
          assetPath: join(ctx.coreAssets, "agents/orchestrator.md"),
          transform: (content) => adaptOrchestratorPlaybookForCodex(content, ctx.config),
          destRelPath: ".codex/orchestrator.md",
          managedId: "orchestrator-codex-base",
          commentStyle: "html",
        },
        {
          body: codexConfig.body,
          destRelPath: ".codex/config.toml",
          managedId: "codex-config-base",
          commentStyle: "shell",
          firstRenderSeed: { header: "# Codex project config generated by navori.\n" },
        },
        {
          body: codexRules.body,
          destRelPath: ".codex/rules/navori.rules",
          managedId: "codex-rules-base",
          commentStyle: "shell",
          firstRenderSeed: {
            header: "# Codex terminal permission rules generated by navori.\n",
          },
        },
        ...localSkillRequests,
        ...pluginScripts,
        // #823: one `agents/openai.yaml` sidecar per manual-only skill — Codex's
        // native `allow_implicit_invocation: false`, shell-comment managed so it
        // gets the same backup/anti-downgrade/prune treatment as every other file.
        ...[...manualOnlySkillIds, ...localSkillManualOnlyIds].map((id): PlacementRequest => ({
          body: OPENAI_MANUAL_ONLY_POLICY,
          destRelPath: `.agents/skills/${id}/agents/openai.yaml`,
          managedId: `${id}-openai-policy`,
          commentStyle: "shell",
        })),
      ];
    },

    orphanScans(plan, ctx): ReturnType<EngineAdapter["orphanScans"]> {
      // `emit ∪ foreign` protects a declared local skill's destination from
      // ever being pruned or reported as an orphan — `foreign` because it
      // isn't navori's to touch either way, `emit` because it IS the desired
      // pointer path. Only ids that fell out of both (`missing`, or removed
      // from `project.localSkills`) may be pruned.
      const localSkillDesired = [...localSkills.emit, ...localSkills.foreign];
      const localSkillManualOnlyIds = localSkills.emit.filter((id) => {
        const sourceAbs = localSkillSourceAbs(ctx.cwd, id);
        return sourceAbs !== null && isManualOnlyLocalSkill(sourceAbs);
      });
      return [
        {
          dir: ".codex/agents",
          match: (name) => name.endsWith(".toml"),
          desired: new Set(plan.agents.map(({ id }) => `.codex/agents/${id}.toml`)),
          shape: "file",
        },
        {
          dir: ".agents/skills",
          match: () => true,
          desired: new Set([
            ...plan.skills.map(({ id }) => `.agents/skills/${id}/SKILL.md`),
            ...localSkillDesired.map((id) => localSkillPointerDestRel(id)),
          ]),
          shape: "skill-dir",
        },
        // #823: prunes a skill's openai.yaml the moment it stops declaring
        // `disable-model-invocation` — independent of the accumulator above
        // (re-reads each skill's own frontmatter) so it never depends on
        // `placeSkill` having run first in THIS scan's call order.
        {
          dir: ".agents/skills",
          match: () => true,
          desired: new Set([
            ...plan.skills
              .filter((s: PlannedSkill) => isManualOnlySkill(s.assetPath))
              .map(({ id }) => `.agents/skills/${id}/agents/openai.yaml`),
            ...localSkillManualOnlyIds.map((id) => `.agents/skills/${id}/agents/openai.yaml`),
          ]),
          shape: "skill-nested-file",
          nestedRelPath: "agents/openai.yaml",
        },
        {
          dir: ".codex/hooks",
          match: () => true,
          desired: new Set(plan.hooks.map(({ id }) => `.codex/hooks/${id}.sh`)),
          shape: "file",
        },
        {
          dir: ".codex/scripts",
          match: (name) => name.endsWith(".sh"),
          desired: new Set(
            ctx.plugins.flatMap((plugin) =>
              plugin.scriptAssets.map((script) => `.codex/scripts/${script.dest}`),
            ),
          ),
          shape: "file",
        },
      ];
    },
  };
}

/** Keep one playbook source while removing Claude-only navigation from its Codex reference. */
function adaptOrchestratorPlaybookForCodex(content: string, config: NavoriConfig): string {
  return adaptHarnessTextForCodex(stripFrontmatter(content), config)
    .replaceAll("(../../AGENTS.md)", "(../AGENTS.md)")
    .replaceAll(
      "which the `SessionStart` hook delivers to the session, not to a subagent:",
      "which `AGENTS.md` supplies to the main thread:",
    )
    .replace(
      /^2\. The catalog of subagents and skills is in .*$/m,
      "2. The catalog of subagents and skills is in `AGENTS.md`, inside its managed `navori-agents` block; read the rendered headings there, not a Claude-only block id.",
    )
    .replaceAll(
      'In Claude Code you can reference `subagent_type: "Explore"` when it exists; in other engines, `scout` is the replacement.',
      "Use the `scout` role for this scope.",
    )
    .replaceAll(
      "The command lives in a cross-review sub-block that navori injects into THIS file, and only in that case. Scroll to the end: no such sub-block below means this repo renders Claude only and the option does not apply here. (Never re-derive this from a `grep` for the sub-block's id — you are reading the file that would match.)",
      "The optional cross-review guidance lives in `AGENTS.md`, not in this reference. Its absence here does not establish whether another engine is configured.",
    );
}

function buildAgentsMdRequest(
  ctx: AdapterCtx,
  agents: ReadonlyArray<{ id: string; description: string }>,
): PlacementRequest {
  const baseBody = buildHarnessProse(ctx.config, ctx.repoRoot, ctx.isWorkspace, {
    includeOrchestration: true,
    includePluginBlocks: true,
  });
  // Same localized "## Available agents" prose as the Claude engine (#289), but
  // without the orchestrator intro — AGENTS.md IS the catalog Codex reads, so it
  // appends the list bare, matching its prior output. The descriptions here come
  // from each agent's own frontmatter (collected in placeAgent), not from the
  // Claude "when to reach for it" map.
  const agentCatalog =
    buildAgentsIndexBlock(resolveLang(ctx.config.language), agents, { withIntro: false }) ?? "";
  let body = adaptHarnessTextForCodex(`${baseBody}\n${agentCatalog}`, ctx.config);
  // The main thread embodies the orchestrator in Codex (no `.codex/agents/orchestrator.toml`),
  // so a plugin skill injecting into a target agent (e.g. engram's
  // orchestrator extension) has no agent .toml to land in — buildAgentToml only runs for
  // rendered agents. Append it here as a managed sub-block of AGENTS.md, the orchestrator's
  // durable guide, mirroring buildAgentToml's per-agent injection but into prose.
  // Same managed-marker treatment as the skill sub-block loop (`@navori/plugin-<id>`
  // source) so re-render is idempotent and disabling the plugin drops it: AGENTS.md
  // is fully regenerated each render, and a disabled plugin is absent from
  // `ctx.plugins`, so the sub-block simply isn't re-emitted (#277).
  for (const plugin of ctx.plugins) {
    for (const skill of plugin.skillAssets) {
      if (skill.injectInto !== ".claude/agents/orchestrator.md") continue;
      const subBlock = adaptHarnessTextForCodex(
        interpolate(stripFrontmatter(readFileSync(skill.absPath, "utf-8")), ctx.config, {
          extraVars: pluginExtraVars(ctx.config),
        }),
        ctx.config,
      );
      body = injectManagedSection(
        body,
        skill.id,
        subBlock,
        { source: `@navori/plugin-${plugin.manifest.id}`, version: NAVORI_VERSION },
        "html",
      ).output;
    }
  }
  // Share the universal adapter's managed id so switching from `agents-md` to
  // full Codex upgrades one block in place instead of duplicating guidance.
  return {
    body,
    destRelPath: "AGENTS.md",
    managedId: "navori-agents",
    commentStyle: "html",
    firstRenderSeed: {
      header: "# AGENTS.md\n",
      trailer: "\n<!-- navori:user-section -->\n<!-- user: additional rules for Codex -->\n",
    },
  };
}

function buildAgentToml(
  source: PlannedAgent,
  config: NavoriConfig,
  plugins: readonly LoadedPlugin[],
): { body: string; description: string } {
  const raw = readFileSync(source.assetPath, "utf-8");
  const parsed = parseAsset(raw, "html");
  const description = adaptHarnessTextForCodex(
    interpolate(parsed.frontmatter.description ?? source.id, config),
    config,
  );
  let instructions = adaptHarnessTextForCodex(
    interpolate(parsed.managedBody, config, { extraVars: pluginExtraVars(config) }),
    config,
  );

  for (const plugin of plugins) {
    for (const skill of plugin.skillAssets) {
      if (skill.injectInto !== `.claude/agents/${source.id}.md`) continue;
      const extension = parseAsset(readFileSync(skill.absPath, "utf-8"), "html");
      instructions += `\n\n${adaptHarnessTextForCodex(
        interpolate(extension.managedBody, config, { extraVars: pluginExtraVars(config) }),
        config,
      )}`;
    }
  }

  const modelTier = source.modelKey ? config.models?.[source.modelKey] : undefined;
  const effort = source.modelKey ? config.effort?.[source.modelKey] : undefined;
  const sandbox = source.sandbox ?? "workspace-write";
  const lines = [
    `name = ${JSON.stringify(source.id)}`,
    `description = ${JSON.stringify(description)}`,
    `developer_instructions = ${JSON.stringify(instructions.trim())}`,
  ];
  if (sandbox === "read-only") lines.push('sandbox_mode = "read-only"');
  if (modelTier) {
    const codexModel = resolveCodexModel(config, modelTier).model;
    lines.push(`model = ${JSON.stringify(codexModel)}`);
  }
  if (effort) lines.push(`model_reasoning_effort = ${JSON.stringify(effort)}`);

  return { body: lines.join("\n") + "\n", description };
}

function loadActivePreset(
  config: NavoriConfig,
  repoRoot: string,
  warnings: string[],
): ReturnType<typeof loadPreset> {
  if (!config.preset || config.preset === "custom") return null;
  try {
    const preset = loadPreset(config.preset, repoRoot);
    if (!preset)
      warnings.push(tc(resolveLang(config.language)).engine.presetNotFoundCodex(config.preset));
    warnings.push(...droppedLibrariesWarnings(preset));
    return preset;
  } catch (error) {
    if (error instanceof PresetError) {
      warnings.push(
        tc(resolveLang(config.language)).engine.presetInvalid(config.preset, error.message),
      );
      return null;
    }
    throw error;
  }
}
