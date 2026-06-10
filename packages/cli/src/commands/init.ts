import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { writeConfig } from "../lib/config.ts";
import { detectProject, type ClaudeInfraInventory } from "../lib/detect.ts";
import { listKnownPluginIds, loadPlugin, type AgentRole } from "../lib/plugins.ts";
import { createMigrationBackup, removeOriginals } from "../lib/migrate.ts";
import { loadWorkspace, type WorkspaceConfig, WorkspaceError } from "../lib/workspace.ts";
import { runRender } from "./render.ts";
import {
  formatInfraSummary,
  formatDetectionSummary,
  formatWorkspaceSummary,
} from "./init-format.ts";
import { color, dim, brand, kv } from "../lib/style.ts";
import { t, type Lang } from "../lib/i18n.ts";

type AdoptionMode = "fresh" | "coexist" | "replace";

const ENGINE_OPTIONS = [
  { value: "claude", label: "Claude Code (.claude/)" },
  { value: "agents-md", label: "AGENTS.md (universal — Cursor / Codex / Gemini read it)" },
  { value: "cursor", label: "Cursor (.cursor/rules/)" },
  { value: "copilot", label: "Copilot (.github/copilot-instructions.md)" },
];

type EngineId = "claude" | "agents-md" | "cursor" | "copilot";

export const initCommand = defineCommand({
  meta: {
    name: "init",
    description: "Adopt navori in the current repo (auto-detects stack, presets, quality gate)",
  },
  args: {
    yes: {
      type: "boolean",
      description: "Accept all detected values + render automatically without prompting",
    },
    cwd: {
      type: "string",
      description: "Directory to initialize (default: current working directory)",
    },
    render: {
      type: "boolean",
      default: true,
      description: "Render CLAUDE.md after writing config. Disable with --no-render.",
    },
    workspace: {
      type: "string",
      description: "Workspace to inherit defaults from (must exist via 'workspace init')",
    },
    recommended: {
      type: "boolean",
      description: "Opinionated mode: --yes + auto-enable recommended plugins (engram, +gh if GitHub repo)",
    },
    lang: {
      type: "string",
      description: "Wizard language (es|en). Default: es. Skipped in --yes/--recommended.",
    },
  },
  async run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    const configPath = `${cwd}/navori.config.json`;
    // --recommended implies --yes (skip wizard)
    const autoYes = Boolean(args.yes || args.recommended);

    p.intro(brand("init"));

    // Bootstrap-language: errors that fire before the wizard runs are shown in
    // the lang chosen via --lang (or "es" if none/invalid). The wizard itself
    // re-prompts the user for the real choice right after.
    const bootstrapLang = normalizeLang(args.lang as string | undefined) ?? "es";
    const bootstrapT = t(bootstrapLang);

    if (!existsSync(cwd)) {
      p.cancel(bootstrapT.dirNotFound(cwd));
      process.exit(1);
    }

    if (existsSync(configPath)) {
      p.cancel(bootstrapT.configExists(configPath));
      process.exit(1);
    }

    // --- Step 0 — pick wizard language (skipped in auto mode) ---
    let lang: Lang = bootstrapLang;
    if (!autoYes) {
      const explicit = normalizeLang(args.lang as string | undefined);
      if (explicit) {
        lang = explicit;
      } else {
        const picked = await p.select<Lang>({
          message: bootstrapT.pickLanguage,
          options: [
            { value: "es", label: bootstrapT.pickLanguageEs },
            { value: "en", label: bootstrapT.pickLanguageEn },
          ],
          initialValue: "es",
        });
        if (p.isCancel(picked)) return cancel(bootstrapLang);
        lang = picked;
      }
    }
    const tr = t(lang);

    const detected = detectProject(cwd);

    // Handle existing Claude infrastructure first — before showing stack detection
    const mode = await chooseAdoptionMode(cwd, detected.claudeInfra, detected.name, {
      yes: autoYes,
      lang,
    });
    if (mode === null) return cancel(lang);

    // Load workspace defaults (cascade: detection → workspace defaults → user overrides)
    let workspaceConfig: WorkspaceConfig | null = null;
    if (args.workspace) {
      try {
        workspaceConfig = loadWorkspace(args.workspace);
      } catch (err) {
        if (err instanceof WorkspaceError) {
          p.cancel(err.message);
          process.exit(1);
        }
        throw err;
      }
      if (!workspaceConfig) {
        p.cancel(
          `Workspace '${args.workspace}' not found. Create it with 'navori workspace init ${args.workspace}'.`,
        );
        process.exit(1);
      }
      p.note(
        formatWorkspaceSummary(workspaceConfig, lang),
        tr.workspaceDefaultsTitle(workspaceConfig.name),
      );
    }

    p.note(formatDetectionSummary(detected, lang), tr.detectedTitle);

    // Cascade: workspace defaults take precedence over detection when present
    const wsDefaults = workspaceConfig?.defaults;
    const defaultEngines = (wsDefaults?.engines as EngineId[] | undefined) ??
      (detected.existingEngines.length > 0
        ? (detected.existingEngines as EngineId[])
        : (["claude"] as EngineId[]));
    const defaultBranchBase = wsDefaults?.branchBase ?? detected.branchBase ?? "main";
    // Asset language defaults to the wizard language. The user can still
    // override via the "language" multi-select adjustment below.
    const defaultLanguage: "es" | "en" = wsDefaults?.language ?? lang;
    const defaultCommits = wsDefaults?.commits;

    if (autoYes) {
      if (!detected.name) {
        p.cancel(tr.detectionFailedYes);
        process.exit(1);
      }
      const wsPlugins = wsDefaults?.plugins ?? {};
      const recommendedPlugins = args.recommended
        ? buildRecommendedPlugins(cwd)
        : {};
      const mergedPlugins = { ...wsPlugins, ...recommendedPlugins };

      if (args.recommended && Object.keys(recommendedPlugins).length > 0) {
        p.log.info(tr.recPluginsEnabled(Object.keys(recommendedPlugins).join(", ")));
      }

      writeConfig(configPath, {
        name: detected.name,
        ...(args.workspace ? { workspace: args.workspace } : {}),
        engines: defaultEngines,
        preset: detected.suggestedPreset,
        language: defaultLanguage,
        branchBase: defaultBranchBase,
        ...(defaultCommits ? { commits: defaultCommits } : {}),
        ...(detected.qualityGate ? { qualityGate: detected.qualityGate } : {}),
        ...(Object.keys(mergedPlugins).length > 0 ? { plugins: mergedPlugins } : {}),
      });
      p.log.success(tr.wroteConfig(configPath));
      if (mode === "coexist") {
        p.outro(tr.doneExistingUntouched);
        return;
      }
      // citty negates booleans on --no-X, so args.render === false when --no-render is passed.
      if (args.render !== false) renderInline(cwd);
      p.outro(tr.done);
      return;
    }

    // Confirm or adjust
    const accept = await p.confirm({
      message: detected.name ? tr.useTheseValues : tr.projectNameUndetectedAdjust,
      initialValue: Boolean(detected.name),
    });
    if (p.isCancel(accept)) return cancel(lang);

    let name = detected.name;
    let engines = defaultEngines;
    let branchBase = defaultBranchBase;
    let workspace: string | undefined = args.workspace as string | undefined;
    let preset = detected.suggestedPreset;
    let qualityGate = detected.qualityGate;
    let language: "es" | "en" = defaultLanguage;

    if (!accept || !detected.name) {
      const toAdjust = await p.multiselect<string>({
        message: tr.whatToChange,
        options: [
          {
            value: "name",
            label: `${tr.labelProjectName}${detected.name ? ` (${detected.name})` : ` ${tr.notDetectedParen}`}`,
          },
          { value: "language", label: `${tr.labelLanguage} (${defaultLanguage} — ${tr.defaultParen})` },
          { value: "workspace", label: tr.labelWorkspace },
          { value: "engines", label: `${tr.labelEngines} (${defaultEngines.join(", ")})` },
          { value: "preset", label: `${tr.labelPreset} (${preset})` },
          { value: "branchBase", label: `${tr.labelBranchBase} (${defaultBranchBase})` },
          {
            value: "qualityGate",
            label: qualityGate
              ? `${tr.labelQualityGate} (${qualityGate.full})`
              : `${tr.labelQualityGate} ${tr.notDetectedParen}`,
          },
        ],
        required: !detected.name,
        initialValues: detected.name ? [] : ["name"],
      });
      if (p.isCancel(toAdjust)) return cancel(lang);
      const adjustments = toAdjust as string[];

      if (adjustments.includes("name") || !name) {
        const value = await p.text({
          message: tr.projectNameKebab,
          placeholder: detected.name ?? "my-project",
          defaultValue: detected.name ?? "",
          validate(v) {
            if (!/^[a-z0-9][a-z0-9-]*$/.test(v)) return tr.mustBeKebab;
            return undefined;
          },
        });
        if (p.isCancel(value)) return cancel(lang);
        name = value as string;
      }

      if (adjustments.includes("language")) {
        const value = await p.select<"es" | "en">({
          message: tr.languageForAssets,
          options: [
            { value: "es", label: tr.assetEsLabel },
            { value: "en", label: tr.assetEnLabel },
          ],
          initialValue: defaultLanguage,
        });
        if (p.isCancel(value)) return cancel(lang);
        language = value;
      }

      if (adjustments.includes("workspace")) {
        const value = await p.text({
          message: tr.workspaceOptional,
          placeholder: tr.leaveEmpty,
        });
        if (p.isCancel(value)) return cancel(lang);
        const trimmed = (value as string).trim();
        if (trimmed) workspace = trimmed;
      }

      if (adjustments.includes("engines")) {
        const value = await p.multiselect<string>({
          message: tr.enginesToTarget,
          options: ENGINE_OPTIONS,
          required: true,
          initialValues: defaultEngines,
        });
        if (p.isCancel(value)) return cancel(lang);
        engines = value as EngineId[];
      }

      if (adjustments.includes("preset")) {
        const value = await p.text({
          message: tr.stackPresetFreeText,
          placeholder: preset,
          defaultValue: preset,
        });
        if (p.isCancel(value)) return cancel(lang);
        preset = value as string;
      }

      if (adjustments.includes("branchBase")) {
        const value = await p.text({
          message: tr.baseBranch,
          placeholder: defaultBranchBase,
          defaultValue: defaultBranchBase,
        });
        if (p.isCancel(value)) return cancel(lang);
        branchBase = value as string;
      }

      if (adjustments.includes("qualityGate")) {
        const fastVal = await p.text({
          message: tr.qualityGateFast,
          placeholder: qualityGate?.fast ?? "pnpm tsc --noEmit",
          defaultValue: qualityGate?.fast ?? "",
        });
        if (p.isCancel(fastVal)) return cancel(lang);
        const fullVal = await p.text({
          message: tr.qualityGateFull,
          placeholder: qualityGate?.full ?? (fastVal as string),
          defaultValue: qualityGate?.full ?? (fastVal as string),
        });
        if (p.isCancel(fullVal)) return cancel(lang);
        if ((fastVal as string).trim() && (fullVal as string).trim()) {
          qualityGate = { fast: (fastVal as string).trim(), full: (fullVal as string).trim() };
        }
      }
    }

    if (!name) {
      p.cancel(tr.projectNameRequired);
      process.exit(1);
    }

    // Plugin selection
    let pluginsToEnable = await pickPlugins(lang);
    if (pluginsToEnable === null) return cancel(lang);

    let pluginsConfig = buildPluginsConfig(pluginsToEnable);

    // Skill → agent assignments (only ask if plugins selected with recommendations)
    let agentAssignments = await pickAgentAssignments(pluginsToEnable, lang);
    if (agentAssignments === null) return cancel(lang);

    // Preview + edit loop — last chance to fix any field before writing.
    // Each edit re-runs the field's prompt; cancelling a re-prompt just
    // returns to the preview (no exit), so a typo never forces you to
    // restart from scratch.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const summary = buildConfigPreview(
        {
          name: name ?? "",
          workspace,
          engines,
          preset,
          language,
          branchBase,
          qualityGate,
          plugins: pluginsToEnable,
          agentAssignments,
        },
        lang,
      );
      p.note(summary, tr.previewTitle);

      const choice = await p.select<string>({
        message: tr.previewAction,
        options: [
          { value: "save", label: color.green(tr.saveAndContinue) },
          { value: "edit:name", label: tr.editField(tr.labelProjectName) },
          { value: "edit:language", label: tr.editField(tr.labelLanguage) },
          { value: "edit:engines", label: tr.editField(tr.labelEngines) },
          { value: "edit:preset", label: tr.editField(tr.labelPreset) },
          { value: "edit:branchBase", label: tr.editField(tr.labelBranchBase) },
          { value: "edit:qualityGate", label: tr.editField(tr.labelQualityGate) },
          { value: "edit:plugins", label: tr.editField("plugins") },
          { value: "edit:agentAssignments", label: tr.editField("agent assignments") },
          { value: "cancel", label: color.red(tr.cancelAndExit) },
        ],
        initialValue: "save",
      });
      if (p.isCancel(choice)) return cancel(lang);
      if (choice === "save") break;
      if (choice === "cancel") return cancel(lang);

      const field = (choice as string).replace(/^edit:/, "");
      switch (field) {
        case "name": {
          const v = await p.text({
            message: tr.projectNameKebab,
            placeholder: name ?? "my-project",
            defaultValue: name ?? "",
            validate: (val) => (/^[a-z0-9][a-z0-9-]*$/.test(val) ? undefined : tr.mustBeKebab),
          });
          if (!p.isCancel(v)) name = v as string;
          break;
        }
        case "language": {
          const v = await p.select<"es" | "en">({
            message: tr.languageForAssets,
            options: [
              { value: "es", label: tr.assetEsLabel },
              { value: "en", label: tr.assetEnLabel },
            ],
            initialValue: language,
          });
          if (!p.isCancel(v)) language = v;
          break;
        }
        case "engines": {
          const v = await p.multiselect<string>({
            message: tr.enginesToTarget,
            options: ENGINE_OPTIONS,
            required: true,
            initialValues: engines,
          });
          if (!p.isCancel(v)) engines = v as EngineId[];
          break;
        }
        case "preset": {
          const v = await p.text({
            message: tr.stackPresetFreeText,
            placeholder: preset,
            defaultValue: preset,
          });
          if (!p.isCancel(v)) preset = v as string;
          break;
        }
        case "branchBase": {
          const v = await p.text({
            message: tr.baseBranch,
            placeholder: branchBase,
            defaultValue: branchBase,
          });
          if (!p.isCancel(v)) branchBase = v as string;
          break;
        }
        case "qualityGate": {
          const fastVal = await p.text({
            message: tr.qualityGateFast,
            placeholder: qualityGate?.fast ?? "pnpm tsc --noEmit",
            defaultValue: qualityGate?.fast ?? "",
          });
          if (p.isCancel(fastVal)) break;
          const fullVal = await p.text({
            message: tr.qualityGateFull,
            placeholder: qualityGate?.full ?? (fastVal as string),
            defaultValue: qualityGate?.full ?? (fastVal as string),
          });
          if (p.isCancel(fullVal)) break;
          if ((fastVal as string).trim() && (fullVal as string).trim()) {
            qualityGate = {
              fast: (fastVal as string).trim(),
              full: (fullVal as string).trim(),
            };
          }
          break;
        }
        case "plugins": {
          const v = await pickPlugins(lang);
          if (v !== null) {
            pluginsToEnable = v;
            pluginsConfig = buildPluginsConfig(v);
            // Drop assignments whose plugin id is no longer enabled
            const enabledPluginIds = new Set(v);
            for (const skillId of Object.keys(agentAssignments)) {
              const ownerPlugin = findPluginIdForSkill(skillId);
              if (ownerPlugin && !enabledPluginIds.has(ownerPlugin)) {
                delete agentAssignments[skillId];
              }
            }
          }
          break;
        }
        case "agentAssignments": {
          const v = await pickAgentAssignments(pluginsToEnable, lang);
          if (v !== null) agentAssignments = v;
          break;
        }
      }
    }

    // Merge workspace-default plugins with user-selected plugins
    const wsPlugins = wsDefaults?.plugins ?? {};
    const mergedPlugins = { ...wsPlugins, ...pluginsConfig };

    writeConfig(configPath, {
      name,
      ...(workspace ? { workspace } : {}),
      engines,
      preset,
      language,
      branchBase,
      ...(defaultCommits ? { commits: defaultCommits } : {}),
      ...(qualityGate ? { qualityGate } : {}),
      ...(Object.keys(mergedPlugins).length > 0 ? { plugins: mergedPlugins } : {}),
      ...(Object.keys(agentAssignments).length > 0 ? { agentAssignments } : {}),
    });

    p.log.success(tr.wroteConfig(configPath));

    if (mode === "coexist") {
      p.outro(tr.doneExistingUntouched);
      return;
    }

    // Final: render or not
    if (args.render === false) {
      p.outro(tr.doneSkippedRender);
      return;
    }

    const shouldRender = await p.confirm({
      message: tr.renderNow,
      initialValue: true,
    });
    if (p.isCancel(shouldRender) || !shouldRender) {
      p.outro(tr.doneRunLater);
      return;
    }

    renderInline(cwd);
    p.outro(tr.harnessReady);
  },
});

function normalizeLang(raw: string | undefined): Lang | null {
  if (!raw) return null;
  const v = raw.toLowerCase().trim();
  if (v === "es" || v === "en") return v;
  return null;
}

async function chooseAdoptionMode(
  cwd: string,
  infra: ClaudeInfraInventory,
  projectName: string | null,
  args: { yes?: boolean; lang: Lang },
): Promise<AdoptionMode | null> {
  if (!infra.present) return "fresh";

  const tr = t(args.lang);

  if (args.yes) {
    // --yes implies coexist for safety: never replaces user infra silently
    p.log.warn(tr.existingInfraYesMode);
    return "coexist";
  }

  p.log.warn(tr.existingInfraDetected);
  p.note(formatInfraSummary(infra, args.lang), tr.filesFoundTitle);

  const choice = await p.select<AdoptionMode>({
    message: tr.howToAdopt,
    options: [
      { value: "coexist", label: tr.coexistLabel, hint: tr.coexistHint },
      { value: "replace", label: tr.replaceLabel, hint: tr.replaceHint },
    ],
    initialValue: "coexist",
  });
  if (p.isCancel(choice)) return null;

  if (choice === "replace") {
    const confirm = await p.confirm({
      message: tr.replaceConfirm,
      initialValue: false,
    });
    if (p.isCancel(confirm) || !confirm) return null;

    const backup = createMigrationBackup(cwd, projectName ?? "unknown");
    p.log.success(tr.backedUp(backup.movedPaths.length, backup.path));
    removeOriginals(cwd, backup.movedPaths);
    p.log.info(tr.removedOriginals(cwd));
    return "replace";
  }

  return "coexist";
}

async function pickPlugins(lang: Lang): Promise<string[] | null> {
  const ids = listKnownPluginIds();
  if (ids.length === 0) return [];

  const options = ids.map((id) => {
    const plugin = (() => {
      try {
        return loadPlugin(id);
      } catch {
        return null;
      }
    })();
    return {
      value: id,
      label: plugin ? `${plugin.manifest.name} (${id})` : id,
      hint: plugin?.manifest.description,
    };
  });

  const selected = await p.multiselect<string>({
    message: t(lang).pluginsToEnable,
    options,
    required: false,
    initialValues: [],
  });
  if (p.isCancel(selected)) return null;
  return selected as string[];
}

/**
 * Build skill → agent assignments based on plugin recommendations, then offer
 * the user a chance to review/override. Returns user-overridden entries only
 * (defaults stay implicit and live in the plugin manifest, not in the config).
 */
async function pickAgentAssignments(
  enabledPlugins: string[],
  lang: Lang,
): Promise<Record<string, AgentRole> | null> {
  if (enabledPlugins.length === 0) return {};
  const tr = t(lang);

  type Recommendation = { id: string; pluginId: string; recommendedAgent: AgentRole };
  const recommendations: Recommendation[] = [];
  for (const pluginId of enabledPlugins) {
    let plugin;
    try {
      plugin = loadPlugin(pluginId);
    } catch {
      continue;
    }
    for (const entry of plugin.manifest.managed) {
      if (entry.recommendedAgent) {
        recommendations.push({
          id: entry.id,
          pluginId,
          recommendedAgent: entry.recommendedAgent,
        });
      }
    }
  }

  if (recommendations.length === 0) return {};

  // Show defaults
  const summary = recommendations
    .map((r) => `  · ${r.id} (${r.pluginId})  →  ${r.recommendedAgent}`)
    .join("\n");
  p.log.message(`${tr.recommendedAssignments}\n${summary}`);

  const accept = await p.confirm({
    message: tr.useAssignments,
    initialValue: true,
  });
  if (p.isCancel(accept)) return null;
  if (accept) return {};

  // Let the user override one or more
  const overrides: Record<string, AgentRole> = {};
  const agentOptions: Array<{ value: AgentRole; label: string }> = [
    { value: "leader", label: tr.roleLeader },
    { value: "implementer", label: tr.roleImplementer },
    { value: "reviewer", label: tr.roleReviewer },
    { value: "researcher", label: tr.roleResearcher },
    { value: "ticket-audit", label: tr.roleTicketAudit },
    { value: "commit-pr-pilot", label: tr.roleCommitPrPilot },
    { value: "explorer", label: tr.roleExplorer },
  ];

  for (const rec of recommendations) {
    const choice = await p.select<AgentRole>({
      message: tr.agentFor(rec.id, rec.pluginId),
      options: agentOptions,
      initialValue: rec.recommendedAgent,
    });
    if (p.isCancel(choice)) return null;
    if (choice !== rec.recommendedAgent) {
      overrides[rec.id] = choice;
    }
  }

  return overrides;
}

/**
 * Recommended plugin set for opinionated --recommended mode:
 * - engram: always (persistent memory is universally useful)
 * - gh: only if the repo's git origin points to github.com
 *
 * Intentionally conservative — semgrep/jscpd/cognitive require external tools
 * that may not be installed; users add those explicitly.
 */
function buildRecommendedPlugins(cwd: string): Record<string, { enabled: boolean }> {
  const result: Record<string, { enabled: boolean }> = {
    engram: { enabled: true },
  };
  if (isGitHubRepo(cwd)) {
    result.gh = { enabled: true };
  }
  return result;
}

function isGitHubRepo(cwd: string): boolean {
  const r = spawnSync("git", ["-C", cwd, "config", "--get", "remote.origin.url"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (r.status !== 0) return false;
  return /github\.com/i.test(r.stdout);
}

function renderInline(cwd: string): void {
  const result = runRender(cwd, false);
  if (!result.ok) {
    p.log.error(result.reason ?? "Render failed");
    return;
  }
  const counts = result.entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.status] = (acc[e.status] ?? 0) + 1;
    return acc;
  }, {});
  const parts: string[] = [];
  if (counts.created) parts.push(color.green(`${counts.created} created`));
  if (counts.updated) parts.push(color.yellow(`${counts.updated} updated`));
  if (counts["user-modified-skipped"]) parts.push(color.red(`${counts["user-modified-skipped"]} conflict`));
  if (counts["removed-condition-false"]) parts.push(color.magenta(`${counts["removed-condition-false"]} removed`));
  if (counts.unchanged) parts.push(dim(`${counts.unchanged} unchanged`));
  const summary = parts.length > 0 ? ` ${dim("—")} ${parts.join(dim(", "))}` : "";
  if (result.written) {
    p.log.success(`Rendered ${result.filePath}${summary}`);
  } else {
    p.log.info(`No render needed${summary}`);
  }

  // Surface engine-tree results (agents/skills/settings/hooks)
  if (result.engineResult) {
    const written = result.engineResult.written.filter((w) => w.path !== "CLAUDE.md");
    if (written.length > 0) {
      const lines = written
        .slice(0, 12)
        .map((w) => `  ${dim("+")} ${w.path}`)
        .join("\n");
      const more = written.length > 12 ? `\n  ${dim(`… +${written.length - 12} more`)}` : "";
      p.log.message(`${dim(".claude/ written:")}\n${lines}${more}`);
    }
    for (const s of result.engineResult.skipped) {
      p.log.warn(`Skipped ${s.path}: ${s.reason}`);
    }
  }
}

function cancel(lang: Lang): void {
  p.cancel(t(lang).cancelled);
  process.exit(0);
}

function buildPluginsConfig(ids: string[]): Record<string, { enabled: boolean }> {
  return ids.reduce<Record<string, { enabled: boolean }>>((acc, id) => {
    acc[id] = { enabled: true };
    return acc;
  }, {});
}

/**
 * Find which plugin id owns a given managed asset id. Used when the user
 * edits the plugin list in the preview loop, so assignments tied to plugins
 * that are now disabled get pruned.
 *
 * Returns null if the skill id is not owned by any known plugin (e.g. a
 * future-core skill, or stale assignment).
 */
function findPluginIdForSkill(skillId: string): string | null {
  for (const pluginId of listKnownPluginIds()) {
    try {
      const plugin = loadPlugin(pluginId);
      if (plugin.manifest.managed.some((m) => m.id === skillId)) {
        return pluginId;
      }
    } catch {
      // unknown / broken plugin — skip
    }
  }
  return null;
}

interface PreviewState {
  name: string;
  workspace: string | undefined;
  engines: string[];
  preset: string;
  language: "es" | "en";
  branchBase: string;
  qualityGate: { fast: string; full: string } | undefined;
  plugins: string[];
  agentAssignments: Record<string, AgentRole>;
}

function buildConfigPreview(state: PreviewState, lang: Lang): string {
  const tr = t(lang);
  const rows: Array<[string, string]> = [];
  rows.push(["name", state.name || dim(tr.notDetectedParen)]);
  if (state.workspace) rows.push(["workspace", state.workspace]);
  rows.push(["language", state.language]);
  rows.push(["engines", state.engines.join(", ")]);
  rows.push(["preset", state.preset]);
  rows.push(["branchBase", state.branchBase]);
  if (state.qualityGate) {
    rows.push(["qualityGate.fast", state.qualityGate.fast]);
    rows.push(["qualityGate.full", state.qualityGate.full]);
  }
  rows.push([
    "plugins",
    state.plugins.length > 0
      ? tr.pluginsValueLabel(state.plugins.join(", "))
      : dim(tr.pluginsNone),
  ]);
  rows.push([
    "agentAssignments",
    Object.keys(state.agentAssignments).length > 0
      ? tr.assignmentsValueLabel(Object.keys(state.agentAssignments).length)
      : dim(tr.assignmentsNone),
  ]);
  return kv(rows);
}
