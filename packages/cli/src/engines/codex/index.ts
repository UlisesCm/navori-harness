import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  type Dirent,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { effectiveConfig, type NavoriConfig } from "../../lib/config.ts";
import { writeFileAtomic } from "../../lib/atomic.ts";
import { createBackup, purgeOldBackups } from "../../lib/backup.ts";
import { RenderWriteError } from "../../lib/errors.ts";
import { getCoreRoot, readCliVersion } from "../../lib/bundled-assets.ts";
import { injectManagedSection } from "../../lib/marker.ts";
import { loadEnabledPlugins, type LoadedPlugin } from "../../lib/plugins.ts";
import { loadPreset, PresetError } from "../../lib/presets.ts";
import { librarySkillById } from "../../lib/library-skills.ts";
import type { RenderStatus } from "../../lib/style.ts";
import { isDowngrade } from "../../lib/semver.ts";
import { renderManagedFile } from "../claude/render-managed-file.ts";
import { parseAsset } from "../claude/parse-asset.ts";
import { interpolate } from "../claude/interpolate.ts";
import { buildHarnessProse, type ProseEngineResult } from "../shared/prose-harness.ts";
import {
  CORE_AGENTS,
  CORE_SKILLS,
  WORKFLOW_SKILLS,
  extraConditionMet,
  isAgentEnabled,
} from "../shared/harness-assets.ts";
import { buildCodexConfigToml } from "./build-config-toml.ts";
import { adaptHarnessTextForCodex } from "./compat.ts";

const CORE_META = { source: "@navori/core" as const, version: readCliVersion() };
const CODEX_MODEL_BY_CLAUDE_TIER = {
  opus: "gpt-5.6-sol",
  sonnet: "gpt-5.6-terra",
  haiku: "gpt-5.6-luna",
} as const;

interface PendingWrite {
  path: string;
  content: string;
  status: RenderStatus;
  chmodExec?: boolean;
}

interface PendingRemoval {
  path: string;
  recursive?: boolean;
}

interface AgentSource {
  id: string;
  assetPath: string;
  modelKey?: keyof NonNullable<NavoriConfig["models"]>;
}

interface CodexAgentDefinition {
  id: string;
  description: string;
}

export type CodexEngineResult = ProseEngineResult;

/**
 * Full Codex adapter. Codex v0.145 discovers repo skills from `.agents/skills`,
 * project config/hooks/agents from `.codex/`, and durable guidance from
 * `AGENTS.md`.
 */
export function renderCodexEngine(
  cwd: string,
  inputConfig: NavoriConfig,
  options: { dryRun?: boolean; repoRoot?: string } = {},
): CodexEngineResult {
  const config = effectiveConfig(inputConfig);
  const dryRun = options.dryRun === true;
  const repoRoot = options.repoRoot ?? cwd;
  const isWorkspace = resolve(repoRoot) !== resolve(cwd);
  const coreAssets = resolve(getCoreRoot(), "core-assets");
  const pluginsResult = loadEnabledPlugins(config.plugins);
  const plugins = pluginsResult.loaded;
  const pending: PendingWrite[] = [];
  const skipped: CodexEngineResult["skipped"] = [];
  const warnings = pluginsResult.missing.map(
    ({ id, reason }) => `Plugin '${id}' no pudo cargarse para Codex: ${reason}.`,
  );
  if (!isWorkspace) {
    warnings.push(
      "Requiere Codex CLI >= 0.145.0. Codex solo carga `.codex/` en repos confiables; " +
        "revisa y autoriza los hooks nuevos con `/hooks`.",
    );
  }

  const preset = loadActivePreset(config, repoRoot, warnings);
  const presetLoadedSafely =
    !config.preset || config.preset === "custom" || config.preset === preset?.def.id;
  const agentSources = collectAgentSources(config, coreAssets, preset);
  const agentDefs: CodexAgentDefinition[] = [];
  for (const source of agentSources) {
    // Codex auto-discovers standalone project agents from `.codex/agents/`;
    // config.toml does not need one registration table per file.
    const plan = planAgentFile(cwd, config, source, plugins);
    agentDefs.push({ id: source.id, description: plan.description });
    collectPlan(plan, pending, skipped);
  }
  planAgentsMd(cwd, config, repoRoot, isWorkspace, agentDefs, pending, skipped);

  const skillSources = collectSkillSources(config, coreAssets, preset);
  for (const skill of skillSources) {
    collectPlan(
      planManagedAsset({
        cwd,
        config,
        assetPath: skill.assetPath,
        destRelPath: `.agents/skills/${skill.id}/SKILL.md`,
        managedId: skill.managedId,
      }),
      pending,
      skipped,
    );
  }

  collectPlan(
    planManagedAsset({
      cwd,
      config,
      assetPath: join(coreAssets, "hooks/guard-destructive.sh"),
      destRelPath: ".codex/hooks/guard-destructive.sh",
      managedId: "guard-destructive-base",
      commentStyle: "shell",
      chmodExec: true,
    }),
    pending,
    skipped,
  );
  if (config.qualityGate?.fast) {
    collectPlan(
      planManagedAsset({
        cwd,
        config,
        assetPath: join(coreAssets, "hooks/quality-gate-pre-commit.sh"),
        destRelPath: ".codex/hooks/quality-gate-pre-commit.sh",
        managedId: "qg-pre-commit-base",
        commentStyle: "shell",
        chmodExec: true,
      }),
      pending,
      skipped,
    );
  }

  const codexConfig = buildCodexConfigToml(config, plugins);
  warnings.push(...codexConfig.warnings);
  planCodexConfig(cwd, codexConfig.body, pending, skipped);

  const removals = presetLoadedSafely
    ? collectOrphanedManagedFiles(
        cwd,
        new Set(agentSources.map(({ id }) => `.codex/agents/${id}.toml`)),
        new Set(skillSources.map(({ id }) => `.agents/skills/${id}/SKILL.md`)),
        new Set([
          ".codex/hooks/guard-destructive.sh",
          ...(config.qualityGate?.fast ? [".codex/hooks/quality-gate-pre-commit.sh"] : []),
        ]),
      )
    : [];

  let backupPath: string | null = null;
  if ((pending.length > 0 || removals.length > 0) && !dryRun) {
    if (pending.some((item) => existsSync(item.path)) || removals.length > 0) {
      const handle = createBackup(cwd, ["AGENTS.md", ".codex", ".agents", "navori.config.json"]);
      if (handle.files.length > 0) {
        backupPath = handle.path;
        purgeOldBackups();
      }
    }
    // AGENTS.md is the human-facing entry point; write it last so a partial
    // failure leaves the prior guidance intact.
    pending.sort(
      (a, b) => Number(a.path.endsWith("/AGENTS.md")) - Number(b.path.endsWith("/AGENTS.md")),
    );
    let current = "";
    try {
      for (const item of pending) {
        current = item.path;
        mkdirSync(dirname(item.path), { recursive: true });
        writeFileAtomic(item.path, item.content);
        if (item.chmodExec) {
          try {
            chmodSync(item.path, 0o755);
          } catch {
            // Best effort on filesystems without executable bits.
          }
        }
      }
      for (const removal of removals) {
        current = removal.path;
        rmSync(removal.path, { recursive: removal.recursive === true, force: true });
      }
    } catch (error) {
      const hint = backupPath ? ` Backup pre-escritura disponible en: ${backupPath}` : "";
      throw new RenderWriteError(
        `El render Codex falló escribiendo ${current}: ${
          error instanceof Error ? error.message : String(error)
        }.${hint}`,
        backupPath,
      );
    }
  }

  return {
    written: [
      ...pending.map((item) => ({
        path: relative(cwd, item.path),
        status: item.status,
      })),
      ...removals.map((item) => ({
        path: relative(cwd, item.path),
        status: "removed-condition-false" as const,
      })),
    ],
    skipped,
    warnings: isWorkspace ? [] : warnings,
    backupPath,
  };
}

function planAgentsMd(
  cwd: string,
  config: NavoriConfig,
  repoRoot: string,
  isWorkspace: boolean,
  agents: readonly CodexAgentDefinition[],
  pending: PendingWrite[],
  skipped: CodexEngineResult["skipped"],
): void {
  const relPath = "AGENTS.md";
  const path = join(cwd, relPath);
  const first = !existsSync(path);
  const existing = first ? "# AGENTS.md\n" : readFileSync(path, "utf-8");
  const baseBody = buildHarnessProse(config, repoRoot, isWorkspace, {
    includeOrchestration: true,
    includePluginBlocks: true,
  });
  const agentCatalog =
    agents.length === 0
      ? ""
      : [
          "## Agentes disponibles",
          "",
          ...agents.map(({ id, description }) => `- \`${id}\` — ${description}`),
          "",
        ].join("\n");
  const body = adaptHarnessTextForCodex(`${baseBody}\n${agentCatalog}`, config);
  // Share the universal adapter's managed id so switching from `agents-md` to
  // full Codex upgrades one block in place instead of duplicating guidance.
  const result = injectManagedSection(existing, "navori-agents", body, CORE_META, "html");
  const output = first
    ? `${result.output}\n<!-- navori:user-section -->\n<!-- user: reglas adicionales para Codex -->\n`
    : result.output;
  collectInjectedResult(relPath, path, output, result.status, pending, skipped);
}

function planCodexConfig(
  cwd: string,
  body: string,
  pending: PendingWrite[],
  skipped: CodexEngineResult["skipped"],
): void {
  const relPath = ".codex/config.toml";
  const path = join(cwd, relPath);
  const first = !existsSync(path);
  const existing = first
    ? "# Codex project config generated by navori.\n"
    : readFileSync(path, "utf-8");
  const result = injectManagedSection(existing, "codex-config-base", body, CORE_META, "shell");
  collectInjectedResult(relPath, path, result.output, result.status, pending, skipped);
}

function collectInjectedResult(
  relPath: string,
  path: string,
  content: string,
  status: RenderStatus,
  pending: PendingWrite[],
  skipped: CodexEngineResult["skipped"],
): void {
  if (status === "unchanged") return;
  if (status === "user-modified-skipped" || status === "downgrade-skipped") {
    skipped.push({
      path: relPath,
      reason:
        status === "user-modified-skipped"
          ? "managed block edited by hand"
          : "escrito por una navori más nueva",
    });
    return;
  }
  pending.push({ path, content, status });
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
      warnings.push(`Preset '${config.preset}' no encontrado; Codex usará solo el core.`);
    return preset;
  } catch (error) {
    if (error instanceof PresetError) {
      warnings.push(`Preset '${config.preset}' inválido: ${error.message}`);
      return null;
    }
    throw error;
  }
}

function collectAgentSources(
  config: NavoriConfig,
  coreAssets: string,
  preset: ReturnType<typeof loadPreset>,
): AgentSource[] {
  const sources: AgentSource[] = [];
  for (const agent of CORE_AGENTS) {
    // The main Codex thread embodies leader; registering it as a spawnable
    // custom role would contradict the leader asset itself.
    if (agent.id === "leader" || !isAgentEnabled(config, agent.harnessKey)) continue;
    sources.push({
      id: agent.id,
      assetPath: join(coreAssets, `agents/${agent.id}.md`),
      modelKey: agent.harnessKey,
    });
  }
  for (const extra of preset?.def.extras.agents ?? []) {
    if (!extraConditionMet(extra, config)) continue;
    sources.push({
      id: basename(extra.destRelPath).replace(/\.md$/, ""),
      assetPath: join(preset!.assetRoot, extra.relPath),
    });
  }
  return sources;
}

function planAgentFile(
  cwd: string,
  config: NavoriConfig,
  source: AgentSource,
  plugins: readonly LoadedPlugin[],
): ReturnType<typeof planRawManagedFile> & { description: string } {
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
  const sandbox = ["reviewer", "researcher", "ticket-audit", "explorer", "auditor"].includes(
    source.id,
  )
    ? "read-only"
    : "workspace-write";
  const lines = [
    `name = ${JSON.stringify(source.id)}`,
    `description = ${JSON.stringify(description)}`,
    `developer_instructions = ${JSON.stringify(instructions.trim())}`,
  ];
  if (sandbox === "read-only") lines.push('sandbox_mode = "read-only"');
  if (modelTier) lines.push(`model = ${JSON.stringify(CODEX_MODEL_BY_CLAUDE_TIER[modelTier])}`);
  if (effort) lines.push(`model_reasoning_effort = ${JSON.stringify(effort)}`);

  return {
    ...planRawManagedFile(
      cwd,
      `.codex/agents/${source.id}.toml`,
      `${source.id}-codex-base`,
      lines.join("\n") + "\n",
      "shell",
    ),
    description,
  };
}

function collectSkillSources(
  config: NavoriConfig,
  coreAssets: string,
  preset: ReturnType<typeof loadPreset>,
): Array<{ id: string; assetPath: string; managedId: string }> {
  const out = [
    ...CORE_SKILLS.map((id) => ({
      id,
      assetPath: join(coreAssets, `skills/${id}.md`),
      managedId: `${id}-base`,
    })),
    ...WORKFLOW_SKILLS.map((id) => ({
      id,
      assetPath: join(coreAssets, `skills/${id}.md`),
      managedId: id,
    })),
  ];
  const seen = new Set(out.map(({ id }) => id));
  for (const extra of preset?.def.extras.skills ?? []) {
    if (!extraConditionMet(extra, config)) continue;
    const id = basename(extra.destRelPath).replace(/\.md$/, "");
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, assetPath: join(preset!.assetRoot, extra.relPath), managedId: extra.id });
  }
  for (const id of config.project?.libraries ?? []) {
    if (seen.has(id) || !librarySkillById(id)) continue;
    seen.add(id);
    out.push({ id, assetPath: join(coreAssets, `lib-skills/${id}.md`), managedId: id });
  }
  return out;
}

function collectOrphanedManagedFiles(
  cwd: string,
  desiredAgents: ReadonlySet<string>,
  desiredSkills: ReadonlySet<string>,
  desiredHooks: ReadonlySet<string>,
): PendingRemoval[] {
  const removals: PendingRemoval[] = [];

  const agentsDir = join(cwd, ".codex/agents");
  for (const entry of readDirSafe(agentsDir)) {
    if (!entry.isFile() || !entry.name.endsWith(".toml")) continue;
    const relPath = `.codex/agents/${entry.name}`;
    const absPath = join(agentsDir, entry.name);
    if (!desiredAgents.has(relPath) && isRemovableNavoriFile(absPath)) {
      removals.push({ path: absPath });
    }
  }

  const skillsDir = join(cwd, ".agents/skills");
  for (const entry of readDirSafe(skillsDir)) {
    if (!entry.isDirectory()) continue;
    const relPath = `.agents/skills/${entry.name}/SKILL.md`;
    const skillDir = join(skillsDir, entry.name);
    const skillPath = join(skillDir, "SKILL.md");
    if (desiredSkills.has(relPath) || !isRemovableNavoriFile(skillPath)) continue;
    const children = readDirSafe(skillDir);
    removals.push({
      path: children.length === 1 && children[0]?.name === "SKILL.md" ? skillDir : skillPath,
      recursive: children.length === 1 && children[0]?.name === "SKILL.md",
    });
  }

  const hooksDir = join(cwd, ".codex/hooks");
  for (const entry of readDirSafe(hooksDir)) {
    if (!entry.isFile()) continue;
    const relPath = `.codex/hooks/${entry.name}`;
    const absPath = join(hooksDir, entry.name);
    if (!desiredHooks.has(relPath) && isRemovableNavoriFile(absPath)) {
      removals.push({ path: absPath });
    }
  }

  return removals;
}

function readDirSafe(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isRemovableNavoriFile(path: string): boolean {
  if (!existsSync(path)) return false;
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return false;
  }
  if (!content.includes("navori:managed")) return false;
  const existingVersion = content.match(/version="([^"]+)"/)?.[1];
  if (!existingVersion) return false;
  return !isDowngrade(existingVersion, CORE_META.version);
}

function planManagedAsset(input: {
  cwd: string;
  config: NavoriConfig;
  assetPath: string;
  destRelPath: string;
  managedId: string;
  commentStyle?: "html" | "shell";
  chmodExec?: boolean;
}): ReturnType<typeof planRawManagedFile> {
  const destPath = join(input.cwd, input.destRelPath);
  const existing = existsSync(destPath) ? readFileSync(destPath, "utf-8") : null;
  const result = renderManagedFile({
    assetPath: input.assetPath,
    existingContent: existing,
    managedId: input.managedId,
    meta: CORE_META,
    config: input.config,
    commentStyle: input.commentStyle,
  });
  return {
    path: destPath,
    relPath: input.destRelPath,
    content: result.content,
    status: result.status,
    chmodExec: input.chmodExec,
  };
}

function planRawManagedFile(
  cwd: string,
  relPath: string,
  managedId: string,
  body: string,
  style: "html" | "shell",
): {
  path: string;
  relPath: string;
  content: string;
  status: RenderStatus;
  chmodExec?: boolean;
} {
  const path = join(cwd, relPath);
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const result = injectManagedSection(existing, managedId, body, CORE_META, style);
  return { path, relPath, content: result.output, status: result.status };
}

function collectPlan(
  plan: ReturnType<typeof planRawManagedFile>,
  pending: PendingWrite[],
  skipped: CodexEngineResult["skipped"],
): void {
  if (plan.status === "unchanged") return;
  if (plan.status === "user-modified-skipped" || plan.status === "downgrade-skipped") {
    skipped.push({
      path: plan.relPath,
      reason:
        plan.status === "user-modified-skipped"
          ? "managed block edited by hand"
          : "escrito por una navori más nueva",
    });
    return;
  }
  pending.push({
    path: plan.path,
    content: plan.content,
    status: plan.status,
    chmodExec: plan.chmodExec,
  });
}
