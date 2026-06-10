import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { writeConfig } from "../lib/config.ts";
import { detectProject, type DetectedProject, type ClaudeInfraInventory } from "../lib/detect.ts";
import { listKnownPluginIds, loadPlugin, type AgentRole } from "../lib/plugins.ts";
import { createMigrationBackup, removeOriginals } from "../lib/migrate.ts";
import { loadWorkspace, type WorkspaceConfig, WorkspaceError } from "../lib/workspace.ts";
import { runRender } from "./render.ts";
import {
  formatInfraSummary,
  formatDetectionSummary,
  formatWorkspaceSummary,
} from "./init-format.ts";
import { color, dim, brand } from "../lib/style.ts";

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
  },
  async run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    const configPath = `${cwd}/navori.config.json`;
    // --recommended implies --yes (skip wizard)
    const autoYes = Boolean(args.yes || args.recommended);

    p.intro(brand("init"));

    if (!existsSync(cwd)) {
      p.cancel(`Directory not found: ${cwd}`);
      process.exit(1);
    }

    if (existsSync(configPath)) {
      p.cancel(`navori.config.json already exists at ${configPath}.`);
      process.exit(1);
    }

    const detected = detectProject(cwd);

    // Handle existing Claude infrastructure first — before showing stack detection
    const mode = await chooseAdoptionMode(cwd, detected.claudeInfra, detected.name, {
      yes: autoYes,
    });
    if (mode === null) return cancel();

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
      p.note(formatWorkspaceSummary(workspaceConfig), `Workspace defaults · ${workspaceConfig.name}`);
    }

    p.note(formatDetectionSummary(detected), "Detected from this repo");

    // Cascade: workspace defaults take precedence over detection when present
    const wsDefaults = workspaceConfig?.defaults;
    const defaultEngines = (wsDefaults?.engines as EngineId[] | undefined) ??
      (detected.existingEngines.length > 0
        ? (detected.existingEngines as EngineId[])
        : (["claude"] as EngineId[]));
    const defaultBranchBase = wsDefaults?.branchBase ?? detected.branchBase ?? "main";
    const defaultLanguage: "es" | "en" = wsDefaults?.language ?? "es";
    const defaultCommits = wsDefaults?.commits;

    if (autoYes) {
      if (!detected.name) {
        p.cancel("Could not detect project name. Run without --yes/--recommended to provide one.");
        process.exit(1);
      }
      const wsPlugins = wsDefaults?.plugins ?? {};
      const recommendedPlugins = args.recommended
        ? buildRecommendedPlugins(cwd)
        : {};
      const mergedPlugins = { ...wsPlugins, ...recommendedPlugins };

      if (args.recommended && Object.keys(recommendedPlugins).length > 0) {
        p.log.info(
          `Recommended plugins enabled: ${Object.keys(recommendedPlugins).join(", ")}`,
        );
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
      p.log.success(`Wrote ${configPath}`);
      if (mode === "coexist") {
        p.outro("Done — existing files not touched. Run 'navori render' when ready.");
        return;
      }
      // citty negates booleans on --no-X, so args.render === false when --no-render is passed.
      if (args.render !== false) renderInline(cwd);
      p.outro("Done");
      return;
    }

    // Confirm or adjust
    const accept = await p.confirm({
      message: detected.name
        ? `Use these values?`
        : `Project name could not be detected. Adjust?`,
      initialValue: Boolean(detected.name),
    });
    if (p.isCancel(accept)) return cancel();

    let name = detected.name;
    let engines = defaultEngines;
    let branchBase = defaultBranchBase;
    let workspace: string | undefined = args.workspace as string | undefined;
    let preset = detected.suggestedPreset;
    let qualityGate = detected.qualityGate;
    let language: "es" | "en" = defaultLanguage;

    if (!accept || !detected.name) {
      const toAdjust = await p.multiselect<string>({
        message: "What do you want to change?",
        options: [
          { value: "name", label: `Project name${detected.name ? ` (${detected.name})` : " (not detected)"}` },
          { value: "language", label: `Language (${defaultLanguage} — default)` },
          { value: "workspace", label: "Workspace" },
          { value: "engines", label: `Engines (${defaultEngines.join(", ")})` },
          { value: "preset", label: `Preset (${preset})` },
          { value: "branchBase", label: `Base branch (${defaultBranchBase})` },
          { value: "qualityGate", label: qualityGate ? `Quality gate (${qualityGate.full})` : "Quality gate (not detected)" },
        ],
        required: !detected.name,
        initialValues: detected.name ? [] : ["name"],
      });
      if (p.isCancel(toAdjust)) return cancel();
      const adjustments = toAdjust as string[];

      if (adjustments.includes("name") || !name) {
        const value = await p.text({
          message: "Project name (kebab-case)",
          placeholder: detected.name ?? "my-project",
          defaultValue: detected.name ?? "",
          validate(v) {
            if (!/^[a-z0-9][a-z0-9-]*$/.test(v)) return "Must be kebab-case (lowercase, hyphens)";
            return undefined;
          },
        });
        if (p.isCancel(value)) return cancel();
        name = value as string;
      }

      if (adjustments.includes("language")) {
        const value = await p.select<"es" | "en">({
          message: "Language for managed Core assets",
          options: [
            { value: "es", label: "Español (default — full coverage)" },
            { value: "en", label: "English (limited — falls back to es if asset not localized)" },
          ],
          initialValue: defaultLanguage,
        });
        if (p.isCancel(value)) return cancel();
        language = value;
      }

      if (adjustments.includes("workspace")) {
        const value = await p.text({
          message: "Workspace (optional, e.g. bonum, navori)",
          placeholder: "leave empty for none",
        });
        if (p.isCancel(value)) return cancel();
        const trimmed = (value as string).trim();
        if (trimmed) workspace = trimmed;
      }

      if (adjustments.includes("engines")) {
        const value = await p.multiselect<string>({
          message: "Engines to target",
          options: ENGINE_OPTIONS,
          required: true,
          initialValues: defaultEngines,
        });
        if (p.isCancel(value)) return cancel();
        engines = value as EngineId[];
      }

      if (adjustments.includes("preset")) {
        const value = await p.text({
          message: "Stack preset (free text for v1)",
          placeholder: preset,
          defaultValue: preset,
        });
        if (p.isCancel(value)) return cancel();
        preset = value as string;
      }

      if (adjustments.includes("branchBase")) {
        const value = await p.text({
          message: "Base branch",
          placeholder: defaultBranchBase,
          defaultValue: defaultBranchBase,
        });
        if (p.isCancel(value)) return cancel();
        branchBase = value as string;
      }

      if (adjustments.includes("qualityGate")) {
        const fastVal = await p.text({
          message: "Quality gate (fast — runs on Stop hook)",
          placeholder: qualityGate?.fast ?? "pnpm tsc --noEmit",
          defaultValue: qualityGate?.fast ?? "",
        });
        if (p.isCancel(fastVal)) return cancel();
        const fullVal = await p.text({
          message: "Quality gate (full — runs before close session)",
          placeholder: qualityGate?.full ?? (fastVal as string),
          defaultValue: qualityGate?.full ?? (fastVal as string),
        });
        if (p.isCancel(fullVal)) return cancel();
        if ((fastVal as string).trim() && (fullVal as string).trim()) {
          qualityGate = { fast: (fastVal as string).trim(), full: (fullVal as string).trim() };
        }
      }
    }

    if (!name) {
      p.cancel("Project name is required");
      process.exit(1);
    }

    // Plugin selection
    const pluginsToEnable = await pickPlugins();
    if (pluginsToEnable === null) return cancel();

    const pluginsConfig = pluginsToEnable.reduce<Record<string, { enabled: boolean }>>(
      (acc, id) => {
        acc[id] = { enabled: true };
        return acc;
      },
      {},
    );

    // Skill → agent assignments (only ask if plugins selected with recommendations)
    const agentAssignments = await pickAgentAssignments(pluginsToEnable);
    if (agentAssignments === null) return cancel();

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

    p.log.success(`Wrote ${configPath}`);

    if (mode === "coexist") {
      p.outro("Done — existing files not touched. Run 'navori render' when ready.");
      return;
    }

    // Final: render or not
    if (args.render === false) {
      p.outro("Done (skipped render)");
      return;
    }

    const shouldRender = await p.confirm({
      message: "Render CLAUDE.md now?",
      initialValue: true,
    });
    if (p.isCancel(shouldRender) || !shouldRender) {
      p.outro("Done (run 'navori render' when ready)");
      return;
    }

    renderInline(cwd);
    p.outro("Your harness is ready");
  },
});

async function chooseAdoptionMode(
  cwd: string,
  infra: ClaudeInfraInventory,
  projectName: string | null,
  args: { yes?: boolean },
): Promise<AdoptionMode | null> {
  if (!infra.present) return "fresh";

  if (args.yes) {
    // --yes implies coexist for safety: never replaces user infra silently
    p.log.warn("Existing Claude infrastructure detected — using 'coexist' mode (safe)");
    return "coexist";
  }

  p.log.warn("Existing Claude infrastructure detected:");
  p.note(formatInfraSummary(infra), "Files found");

  const choice = await p.select<AdoptionMode>({
    message: "How do you want to adopt navori?",
    options: [
      {
        value: "coexist",
        label: "Coexist (recommended)",
        hint: "add what's missing, never modify existing files",
      },
      {
        value: "replace",
        label: "Replace",
        hint: "backup everything to ~/.navori/migrations/<ts>/ and start fresh",
      },
    ],
    initialValue: "coexist",
  });
  if (p.isCancel(choice)) return null;

  if (choice === "replace") {
    const confirm = await p.confirm({
      message: `This will move .claude/, CLAUDE.md, AGENTS.md, CHECKPOINTS.md, feature_list.json, progress/, specs/ to ~/.navori/migrations/. Continue?`,
      initialValue: false,
    });
    if (p.isCancel(confirm) || !confirm) return null;

    const backup = createMigrationBackup(cwd, projectName ?? "unknown");
    p.log.success(`Backed up ${backup.movedPaths.length} item(s) to ${backup.path}`);
    removeOriginals(cwd, backup.movedPaths);
    p.log.info(`Removed originals from ${cwd}`);
    return "replace";
  }

  return "coexist";
}

async function pickPlugins(): Promise<string[] | null> {
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
    message: "Plugins to enable",
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
): Promise<Record<string, AgentRole> | null> {
  if (enabledPlugins.length === 0) return {};

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
  p.log.message(`Recommended skill → agent assignments:\n${summary}`);

  const accept = await p.confirm({
    message: "Use these assignments?",
    initialValue: true,
  });
  if (p.isCancel(accept)) return null;
  if (accept) return {};

  // Let the user override one or more
  const overrides: Record<string, AgentRole> = {};
  const agentOptions: Array<{ value: AgentRole; label: string }> = [
    { value: "leader", label: "leader (orquestador)" },
    { value: "implementer", label: "implementer (escribe código)" },
    { value: "reviewer", label: "reviewer (revisa diff)" },
    { value: "researcher", label: "researcher (lee, no escribe)" },
    { value: "ticket-audit", label: "ticket-audit (análisis profundo)" },
    { value: "commit-pr-pilot", label: "commit-pr-pilot (commits + PRs)" },
    { value: "explorer", label: "explorer (exploración inicial)" },
  ];

  for (const rec of recommendations) {
    const choice = await p.select<AgentRole>({
      message: `Agent for '${rec.id}' (${rec.pluginId})`,
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
}

function cancel(): void {
  p.cancel("Cancelled");
  process.exit(0);
}
