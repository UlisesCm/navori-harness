import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { writeConfig } from "../lib/config.ts";
import { detectProject, type DetectedProject, type ClaudeInfraInventory } from "../lib/detect.ts";
import { listKnownPluginIds, loadPlugin } from "../lib/plugins.ts";
import { createMigrationBackup, removeOriginals } from "../lib/migrate.ts";
import { runRender } from "./render.ts";

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
    description: "Adopt navori-ai in the current repo (auto-detects stack, presets, quality gate)",
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
    "no-render": {
      type: "boolean",
      description: "Do not render CLAUDE.md after writing config",
    },
  },
  async run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    const configPath = `${cwd}/navori.config.json`;

    p.intro("navori-ai init");

    if (existsSync(configPath)) {
      p.cancel(`navori.config.json already exists at ${configPath}.`);
      process.exit(1);
    }

    const detected = detectProject(cwd);

    // Handle existing Claude infrastructure first — before showing stack detection
    const mode = await chooseAdoptionMode(cwd, detected.claudeInfra, detected.name, args);
    if (mode === null) return cancel();

    p.log.message(formatDetectionSummary(detected));

    const defaultEngines = detected.existingEngines.length > 0
      ? (detected.existingEngines as EngineId[])
      : (["claude"] as EngineId[]);
    const defaultBranchBase = detected.branchBase ?? "main";
    const defaultLanguage: "es" | "en" = "es";

    if (args.yes) {
      if (!detected.name) {
        p.cancel("Could not detect project name. Run without --yes to provide one.");
        process.exit(1);
      }
      writeConfig(configPath, {
        name: detected.name,
        engines: defaultEngines,
        preset: detected.suggestedPreset,
        language: defaultLanguage,
        branchBase: defaultBranchBase,
        ...(detected.qualityGate ? { qualityGate: detected.qualityGate } : {}),
      });
      p.log.success(`Wrote ${configPath}`);
      if (mode === "coexist") {
        p.outro("Done — existing files not touched. Run 'navori-ai render' when ready.");
        return;
      }
      if (!args["no-render"]) renderInline(cwd);
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
    let workspace: string | undefined;
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

    writeConfig(configPath, {
      name,
      ...(workspace ? { workspace } : {}),
      engines,
      preset,
      language,
      branchBase,
      ...(qualityGate ? { qualityGate } : {}),
      ...(pluginsToEnable.length > 0 ? { plugins: pluginsConfig } : {}),
    });

    p.log.success(`Wrote ${configPath}`);

    if (mode === "coexist") {
      p.outro("Done — existing files not touched. Run 'navori-ai render' when ready.");
      return;
    }

    // Final: render or not
    if (args["no-render"]) {
      p.outro("Done (skipped render)");
      return;
    }

    const shouldRender = await p.confirm({
      message: "Render CLAUDE.md now?",
      initialValue: true,
    });
    if (p.isCancel(shouldRender) || !shouldRender) {
      p.outro("Done (run 'navori-ai render' when ready)");
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

  p.log.warn(formatInfraSummary(infra));

  const choice = await p.select<AdoptionMode>({
    message: "How do you want to adopt navori-ai?",
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

function formatInfraSummary(infra: ClaudeInfraInventory): string {
  const lines: string[] = ["Existing Claude infrastructure detected:"];
  if (infra.agentFiles.length > 0) {
    lines.push(`  .claude/agents/        : ${infra.agentFiles.join(", ")} (${infra.agentFiles.length})`);
  }
  if (infra.skillFiles.length > 0) {
    const preview = infra.skillFiles.slice(0, 3).join(", ");
    const more = infra.skillFiles.length > 3 ? ` (+${infra.skillFiles.length - 3} more)` : "";
    lines.push(`  .claude/skills/        : ${preview}${more} (${infra.skillFiles.length})`);
  }
  if (infra.hasSettings) lines.push(`  .claude/settings.json  : present`);
  if (infra.hasLocalSettings) lines.push(`  .claude/settings.local.json : present (gitignored)`);
  if (infra.hasClaudeMd) lines.push(`  CLAUDE.md              : present`);
  if (infra.hasAgentsMd) lines.push(`  AGENTS.md              : present`);
  if (infra.hasCheckpointsMd) lines.push(`  CHECKPOINTS.md         : present`);
  if (infra.hasFeatureList) lines.push(`  feature_list.json      : present`);
  if (infra.progressFiles > 0) lines.push(`  progress/              : ${infra.progressFiles} file(s)`);
  if (infra.specsDirs > 0) lines.push(`  specs/                 : ${infra.specsDirs} feature(s)`);
  return lines.join("\n");
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
  const parts = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ");
  if (result.written) {
    p.log.success(`Rendered ${result.filePath} (${parts})`);
  } else {
    p.log.info(`No render needed (${parts})`);
  }
}

function formatDetectionSummary(d: DetectedProject): string {
  const lines: string[] = ["Detected from this repo:"];
  lines.push(
    d.name
      ? `  name           : ${d.name}  ${grey(`(from ${d.sources.name})`)}`
      : `  name           : ${grey("(not detected — will ask)")}`,
  );
  lines.push(
    d.branchBase
      ? `  branchBase     : ${d.branchBase}  ${grey(`(from ${d.sources.branchBase})`)}`
      : `  branchBase     : main  ${grey("(default — no git detected)")}`,
  );
  lines.push(
    d.existingEngines.length > 0
      ? `  engines        : ${d.existingEngines.join(", ")}  ${grey("(found in repo)")}`
      : `  engines        : claude  ${grey("(default — nothing detected)")}`,
  );
  lines.push(`  language       : ${d.stack.language}`);
  if (d.stack.framework) lines.push(`  framework      : ${d.stack.framework}`);
  if (d.stack.ui) lines.push(`  ui             : ${d.stack.ui}`);
  if (d.stack.forms) lines.push(`  forms          : ${d.stack.forms}`);
  if (d.stack.state) lines.push(`  state          : ${d.stack.state}`);
  if (d.stack.test) lines.push(`  test           : ${d.stack.test}`);
  if (d.packageManager) {
    lines.push(`  packageManager : ${d.packageManager}  ${grey(`(from ${d.sources.packageManager})`)}`);
  }
  if (d.monorepo) {
    lines.push(`  monorepo       : ${d.monorepo.tool}  ${grey(`(from ${d.monorepo.source})`)}`);
  }
  lines.push(`  preset         : ${d.suggestedPreset}  ${grey("(suggested)")}`);
  lines.push(`  language       : es  ${grey("(default — change in wizard if you need 'en' fallback)")}`);
  if (d.qualityGate) {
    lines.push(`  qualityGate    : ${d.qualityGate.full}  ${grey("(from package.json scripts)")}`);
  }
  return lines.join("\n");
}

function grey(s: string): string {
  return `\x1b[90m${s}\x1b[0m`;
}

function cancel(): void {
  p.cancel("Cancelled");
  process.exit(0);
}
