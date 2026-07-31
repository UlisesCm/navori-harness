import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { effectiveConfig, type NavoriConfig } from "../../lib/config.ts";
import { getCoreRoot, readCliVersion } from "../../lib/bundled-assets.ts";
import { loadDisabledPlugins, loadEnabledPlugins, type LoadedPlugin } from "../../lib/plugins.ts";
import { loadPreset, PresetError } from "../../lib/presets.ts";
import { tc, resolveLang } from "../../lib/i18n.ts";
import { parseAsset } from "../claude/parse-asset.ts";
import { interpolate } from "../../lib/interpolate.ts";
import { stripFrontmatter } from "../../lib/frontmatter.ts";
import { injectManagedSection, removeManagedSection } from "../../lib/marker.ts";
import { buildHarnessProse, type ProseEngineResult } from "../shared/prose-harness.ts";
import { resolveHarnessPlan, type PlannedAgent } from "../shared/harness-plan.ts";
import {
  collectPlan,
  commitWrites,
  type AdapterCtx,
  type EngineAdapter,
  type PlacementRequest,
} from "../shared/execute-plan.ts";
import { buildCodexConfigToml } from "./build-config-toml.ts";
import { adaptHarnessTextForCodex } from "./compat.ts";

const CODEX_MODEL_BY_CLAUDE_TIER = {
  opus: "gpt-5.6-sol",
  sonnet: "gpt-5.6-terra",
  haiku: "gpt-5.6-luna",
} as const;

const NAVORI_VERSION = readCliVersion();

// A plugin skill declared with `injectInto: .claude/skills/<id>/SKILL.md` (or the
// flat legacy `.claude/skills/<id>.md`) extends an existing skill. Captures the
// target skill id; skill→agent injectInto (`.claude/agents/<id>.md`) does NOT
// match here — that path is handled inside buildAgentToml.
const SKILL_INJECT_RE = /^\.claude\/skills\/([a-z0-9-]+)(?:\/SKILL)?\.md$/;

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
  if (!isWorkspace) {
    warnings.push(tc(lang).engine.codexTrustHint);
  }

  const preset = loadActivePreset(config, repoRoot, warnings);
  const presetLoadedSafely =
    !config.preset || config.preset === "custom" || config.preset === preset?.def.id;

  const codexConfig = buildCodexConfigToml(config, plugins);
  warnings.push(...codexConfig.warnings);

  const plan = resolveHarnessPlan(config, coreAssets, preset);
  const ctx: AdapterCtx = { cwd, config, repoRoot, isWorkspace, coreAssets, preset, plugins };
  const adapter = createCodexAdapter(codexConfig.body);

  // Split collect/commit so plugin skills that extend another skill (injectInto
  // a `.claude/skills/<id>/SKILL.md`, e.g. codegraph → structural-search) can be
  // appended as a managed sub-block BEFORE the single write — mirroring the
  // Claude adapter, but into Codex's `.agents/skills/<id>/SKILL.md` and adapted
  // to Codex's vocabulary. (skill→agent injectInto is handled in buildAgentToml.)
  const { pending, removals, skipped } = collectPlan(plan, adapter, ctx, {
    prune: presetLoadedSafely,
    lang,
  });
  for (const plugin of plugins) {
    for (const skill of plugin.skillAssets) {
      const m = skill.injectInto?.match(SKILL_INJECT_RE);
      if (!m) continue;
      const targetRel = `.agents/skills/${m[1]}/SKILL.md`;
      const targetAbs = join(cwd, targetRel);
      // The base skill may not be in `pending` if it's unchanged this render
      // (e.g. `navori add codegraph` on an already-rendered repo). Fall back to
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
        interpolate(stripFrontmatter(readFileSync(skill.absPath, "utf-8")), config),
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
    backupTargets: adapter.backupTargets,
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

/**
 * Builds a fresh, stateful adapter per render. `placeAgent` accumulates the
 * agent catalog that `extraFiles` folds into AGENTS.md, so the executor must
 * place agents before calling extraFiles (it does).
 */
function createCodexAdapter(configTomlBody: string): EngineAdapter {
  const agentCatalog: Array<{ id: string; description: string }> = [];

  return {
    id: "codex",
    label: "Codex",
    backupTargets: ["AGENTS.md", ".codex", ".agents", "navori.config.json"],

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

    placeSkill(skill): PlacementRequest {
      return {
        assetPath: skill.assetPath,
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
      return [
        buildAgentsMdRequest(ctx, agentCatalog),
        {
          body: configTomlBody,
          destRelPath: ".codex/config.toml",
          managedId: "codex-config-base",
          commentStyle: "shell",
          firstRenderSeed: { header: "# Codex project config generated by navori.\n" },
        },
      ];
    },

    orphanScans(plan): ReturnType<EngineAdapter["orphanScans"]> {
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
          desired: new Set(plan.skills.map(({ id }) => `.agents/skills/${id}/SKILL.md`)),
          shape: "skill-dir",
        },
        {
          dir: ".codex/hooks",
          match: () => true,
          desired: new Set(plan.hooks.map(({ id }) => `.codex/hooks/${id}.sh`)),
          shape: "file",
        },
      ];
    },
  };
}

function buildAgentsMdRequest(
  ctx: AdapterCtx,
  agents: ReadonlyArray<{ id: string; description: string }>,
): PlacementRequest {
  const baseBody = buildHarnessProse(ctx.config, ctx.repoRoot, ctx.isWorkspace, {
    includeOrchestration: true,
    includePluginBlocks: true,
  });
  const agentCatalog =
    agents.length === 0
      ? ""
      : [
          "## Available agents",
          "",
          ...agents.map(({ id, description }) => `- \`${id}\` — ${description}`),
          "",
        ].join("\n");
  const body = adaptHarnessTextForCodex(`${baseBody}\n${agentCatalog}`, ctx.config);
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
  let instructions = adaptHarnessTextForCodex(interpolate(parsed.managedBody, config), config);

  for (const plugin of plugins) {
    for (const skill of plugin.skillAssets) {
      if (skill.injectInto !== `.claude/agents/${source.id}.md`) continue;
      const extension = parseAsset(readFileSync(skill.absPath, "utf-8"), "html");
      instructions += `\n\n${adaptHarnessTextForCodex(
        interpolate(extension.managedBody, config),
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
    const codexModel =
      config.models?.codexMap?.[modelTier] ?? CODEX_MODEL_BY_CLAUDE_TIER[modelTier];
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
