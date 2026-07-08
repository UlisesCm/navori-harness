import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeConfig, type NavoriConfig } from "../lib/config.ts";
import { readConfigOrExit } from "../lib/cli-config.ts";
import { listKnownPluginIds, loadPlugin } from "../lib/plugins.ts";
import { brand, dim } from "../lib/style.ts";

const ENGINE_OPTIONS = [
  { value: "claude", label: "Claude Code (.claude/)" },
  { value: "agents-md", label: "AGENTS.md (universal — Cursor / Codex / Gemini read it)" },
  { value: "cursor", label: "Cursor (.cursor/rules/)" },
  { value: "copilot", label: "Copilot (.github/copilot-instructions.md)" },
];

type EngineId = "claude" | "agents-md" | "cursor" | "copilot";

function fail(msg: string): never {
  // Use stderr so success output on stdout stays clean for piping/JSON.
  process.stderr.write(`navori: ${msg}\n`);
  process.exit(1);
}

function loadOrExit(cwd: string): { config: NavoriConfig; path: string; raw: Record<string, unknown> } {
  if (!existsSync(cwd)) fail(`Directory not found: ${cwd}`);
  const configPath = resolve(cwd, "navori.config.json");
  if (!existsSync(configPath)) fail(`No navori.config.json at ${configPath}. Run 'navori init' first.`);
  const config = readConfigOrExit(configPath);
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

    p.intro(brand("configure plugins"));

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
    p.outro("Run 'navori render --apply' or 'navori sync' to apply.");
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

    p.intro(brand("configure quality-gate"));

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

    p.intro(brand("configure language"));

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
    p.outro("Run 'navori render --apply' to re-render managed blocks in the new language.");
  },
});

const branchBaseSubCommand = defineCommand({
  meta: {
    name: "branch-base",
    description: "Set the base branch gates diff against (e.g. main, develop)",
  },
  args: {
    cwd: { type: "string", description: "Directory (default: cwd)" },
    value: { type: "positional", description: "Branch name (e.g. develop)", required: false },
  },
  async run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    const { config, path, raw } = loadOrExit(cwd);

    p.intro(brand("configure branch-base"));

    let value = (args.value as string | undefined)?.trim();
    if (!value) {
      const input = await p.text({
        message: "Base branch that gates (semgrep / jscpd / cognitive) diff against",
        placeholder: config.branchBase,
        defaultValue: config.branchBase,
      });
      if (p.isCancel(input)) {
        p.cancel("Cancelled");
        return;
      }
      value = (input as string).trim();
    }

    if (!value) {
      p.cancel("Branch name cannot be empty");
      return;
    }

    raw.branchBase = value;
    persist(path, raw);
    p.log.success(`branchBase → ${value}`);
    p.outro("Run 'navori render --apply' to update the gate scripts.");
  },
});

const prTargetSubCommand = defineCommand({
  meta: {
    name: "pr-target",
    description: "Set the branch PRs target (gh pr create --base); defaults to branchBase",
  },
  args: {
    cwd: { type: "string", description: "Directory (default: cwd)" },
    value: { type: "positional", description: "Branch name (e.g. develop)", required: false },
  },
  async run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    const { config, path, raw } = loadOrExit(cwd);

    p.intro(brand("configure pr-target"));

    let value = (args.value as string | undefined)?.trim();
    if (!value) {
      const fallback = config.prTarget ?? config.branchBase;
      const input = await p.text({
        message: "Branch PRs open against (gh pr create --base)",
        placeholder: fallback,
        defaultValue: fallback,
      });
      if (p.isCancel(input)) {
        p.cancel("Cancelled");
        return;
      }
      value = (input as string).trim();
    }

    if (!value) {
      p.cancel("Branch name cannot be empty");
      return;
    }

    raw.prTarget = value;
    persist(path, raw);
    p.log.success(`prTarget → ${value}`);
    if (value === config.branchBase) {
      p.log.message(dim(`Same as branchBase — PRs target ${value} as before.`));
    }
    p.outro("Run 'navori render --apply' to update the PR skills.");
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

    p.intro(brand("configure engines"));

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
    yes: { type: "boolean", description: "Skip confirmation when removing" },
  },
  async run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    const { path, raw } = loadOrExit(cwd);
    const value = (args.value as string | undefined)?.trim();

    p.intro(brand("configure workspace"));

    if (!value) {
      const currentWorkspace = raw.workspace as string | undefined;
      if (!currentWorkspace) {
        p.outro("No workspace associated. Nothing to remove.");
        return;
      }
      if (!args.yes) {
        const ok = await p.confirm({
          message: `Remove workspace association '${currentWorkspace}'? Plugins inherited from the workspace defaults will no longer be applied on next render.`,
          initialValue: false,
        });
        if (p.isCancel(ok) || !ok) {
          p.cancel("Aborted");
          return;
        }
      }
      delete raw.workspace;
      persist(path, raw);
      p.log.success("Workspace association removed");
      p.outro("Run 'navori render --apply' to apply.");
      return;
    }

    raw.workspace = value;
    persist(path, raw);
    p.log.success(`workspace → ${value}`);
    p.outro("Run 'navori render --apply' to apply.");
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
    "branch-base": branchBaseSubCommand,
    "pr-target": prTargetSubCommand,
    language: languageSubCommand,
    engines: enginesSubCommand,
    workspace: workspaceSubCommand,
  },
});
