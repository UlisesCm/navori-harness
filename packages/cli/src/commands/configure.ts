import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readConfig, writeConfig, type NavoriConfig } from "../lib/config.ts";
import { listKnownPluginIds, loadPlugin } from "../lib/plugins.ts";

const ENGINE_OPTIONS = [
  { value: "claude", label: "Claude Code (.claude/)" },
  { value: "agents-md", label: "AGENTS.md (universal — Cursor / Codex / Gemini read it)" },
  { value: "cursor", label: "Cursor (.cursor/rules/)" },
  { value: "copilot", label: "Copilot (.github/copilot-instructions.md)" },
];

type EngineId = "claude" | "agents-md" | "cursor" | "copilot";

function loadOrExit(cwd: string): { config: NavoriConfig; path: string; raw: Record<string, unknown> } {
  if (!existsSync(cwd)) {
    console.error(`Directory not found: ${cwd}`);
    process.exit(1);
  }
  const configPath = resolve(cwd, "navori.config.json");
  if (!existsSync(configPath)) {
    console.error(`No navori.config.json at ${configPath}. Run 'navori-ai init' first.`);
    process.exit(1);
  }
  const config = readConfig(configPath);
  const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  return { config, path: configPath, raw };
}

function persist(path: string, raw: Record<string, unknown>): void {
  const next = { ...raw };
  delete next.$schema;
  // Re-validate via writeConfig (which prepends $schema)
  writeConfig(path, next as Parameters<typeof writeConfig>[1]);
}

const pluginsSubCommand = defineCommand({
  meta: {
    name: "plugins",
    description: "Enable or disable plugins for this repo",
  },
  args: {
    cwd: { type: "string", description: "Directory (default: cwd)" },
  },
  async run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    const { config, path, raw } = loadOrExit(cwd);

    p.intro("navori-ai configure plugins");

    const allIds = listKnownPluginIds();
    const current = config.plugins ?? {};
    const enabledNow = new Set(
      Object.entries(current).filter(([, v]) => v.enabled).map(([k]) => k),
    );

    const options = allIds.map((id) => {
      let plugin;
      try {
        plugin = loadPlugin(id);
      } catch {
        return null;
      }
      return {
        value: id,
        label: `${plugin.manifest.name} (${id})`,
        hint: plugin.manifest.description,
      };
    }).filter((o): o is NonNullable<typeof o> => o !== null);

    const selected = await p.multiselect<string>({
      message: "Plugins enabled in this repo",
      options,
      required: false,
      initialValues: [...enabledNow],
    });
    if (p.isCancel(selected)) {
      p.cancel("Cancelled");
      return;
    }
    const selectedSet = new Set(selected as string[]);

    // Build new plugins object: enable=true for selected, drop the rest
    const newPlugins: Record<string, { enabled: boolean }> = {};
    for (const id of selectedSet) newPlugins[id] = { enabled: true };

    raw.plugins = newPlugins;
    persist(path, raw);

    const added = [...selectedSet].filter((id) => !enabledNow.has(id));
    const removed = [...enabledNow].filter((id) => !selectedSet.has(id));
    if (added.length > 0) p.log.success(`Enabled: ${added.join(", ")}`);
    if (removed.length > 0) p.log.warn(`Disabled: ${removed.join(", ")}`);
    if (added.length === 0 && removed.length === 0) p.log.info("No changes");
    p.outro("Run 'navori-ai render' or 'navori-ai sync' to apply.");
  },
});

const qualityGateSubCommand = defineCommand({
  meta: {
    name: "quality-gate",
    description: "Set or update the quality gate commands (fast + full)",
  },
  args: {
    cwd: { type: "string", description: "Directory (default: cwd)" },
    fast: { type: "string", description: "Non-interactive: fast gate command" },
    full: { type: "string", description: "Non-interactive: full gate command" },
  },
  async run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    const { config, path, raw } = loadOrExit(cwd);

    p.intro("navori-ai configure quality-gate");

    let fast = args.fast as string | undefined;
    let full = args.full as string | undefined;

    if (!fast || !full) {
      const fastVal = await p.text({
        message: "Fast gate command (runs on Stop hook)",
        placeholder: config.qualityGate?.fast ?? "pnpm tsc --noEmit",
        defaultValue: config.qualityGate?.fast ?? "",
      });
      if (p.isCancel(fastVal)) {
        p.cancel("Cancelled");
        return;
      }
      fast = (fastVal as string).trim();
      const fullVal = await p.text({
        message: "Full gate command (runs before close session)",
        placeholder: config.qualityGate?.full ?? fast,
        defaultValue: config.qualityGate?.full ?? fast,
      });
      if (p.isCancel(fullVal)) {
        p.cancel("Cancelled");
        return;
      }
      full = (fullVal as string).trim();
    }

    if (!fast || !full) {
      p.cancel("Both fast and full commands are required");
      return;
    }

    raw.qualityGate = { fast, full };
    persist(path, raw);
    p.log.success(`qualityGate updated`);
    p.outro("Done");
  },
});

const languageSubCommand = defineCommand({
  meta: {
    name: "language",
    description: "Switch the language of managed Core assets (es / en)",
  },
  args: {
    cwd: { type: "string", description: "Directory (default: cwd)" },
    value: { type: "positional", description: "es | en", required: false },
  },
  async run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    const { config, path, raw } = loadOrExit(cwd);

    p.intro("navori-ai configure language");

    let value = args.value as string | undefined;
    if (!value) {
      const choice = await p.select<"es" | "en">({
        message: "Language for managed Core assets",
        options: [
          { value: "es", label: "Español (default — full coverage)" },
          { value: "en", label: "English (limited — falls back to es)" },
        ],
        initialValue: config.language,
      });
      if (p.isCancel(choice)) {
        p.cancel("Cancelled");
        return;
      }
      value = choice;
    }

    if (value !== "es" && value !== "en") {
      p.cancel(`Invalid language '${value}'. Must be 'es' or 'en'.`);
      return;
    }

    raw.language = value;
    persist(path, raw);
    p.log.success(`language → ${value}`);
    p.outro("Run 'navori-ai render' to re-render managed blocks in the new language.");
  },
});

const enginesSubCommand = defineCommand({
  meta: {
    name: "engines",
    description: "Add or remove target engines (claude / agents-md / cursor / copilot)",
  },
  args: {
    cwd: { type: "string", description: "Directory (default: cwd)" },
  },
  async run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    const { config, path, raw } = loadOrExit(cwd);

    p.intro("navori-ai configure engines");

    const selected = await p.multiselect<string>({
      message: "Engines to target",
      options: ENGINE_OPTIONS,
      required: true,
      initialValues: config.engines,
    });
    if (p.isCancel(selected)) {
      p.cancel("Cancelled");
      return;
    }

    raw.engines = selected as EngineId[];
    persist(path, raw);
    p.log.success(`engines → ${(selected as string[]).join(", ")}`);
    p.outro("Done");
  },
});

const workspaceSubCommand = defineCommand({
  meta: {
    name: "workspace",
    description: "Associate this repo with a workspace (or remove the association)",
  },
  args: {
    cwd: { type: "string", description: "Directory (default: cwd)" },
    value: { type: "positional", description: "Workspace name (empty to remove)", required: false },
  },
  run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    const { path, raw } = loadOrExit(cwd);
    const value = (args.value as string | undefined)?.trim();

    if (!value) {
      delete raw.workspace;
      persist(path, raw);
      console.log("workspace association removed");
      return;
    }

    raw.workspace = value;
    persist(path, raw);
    console.log(`workspace → ${value}`);
  },
});

export const configureCommand = defineCommand({
  meta: {
    name: "configure",
    description: "Modify navori.config.json sections after init",
  },
  subCommands: {
    plugins: pluginsSubCommand,
    "quality-gate": qualityGateSubCommand,
    language: languageSubCommand,
    engines: enginesSubCommand,
    workspace: workspaceSubCommand,
  },
});
