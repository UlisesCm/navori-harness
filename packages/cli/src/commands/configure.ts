import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeConfig, type NavoriConfig } from "../lib/config.ts";
import { readConfigOrExit } from "../lib/cli-config.ts";
import { listKnownPluginIds, loadPlugin } from "../lib/plugins.ts";
import { EXCLUDABLE_BLOCK_IDS, SECURITY_BLOCK_IDS } from "../lib/render-plan.ts";
import { brand, dim } from "../lib/style.ts";

const ENGINE_OPTIONS = [
  { value: "claude", label: "Claude Code (.claude/)" },
  { value: "agents-md", label: "AGENTS.md (universal — Cursor / Codex / Gemini read it)" },
  { value: "cursor", label: "Cursor (.cursor/rules/)" },
  { value: "copilot", label: "Copilot (.github/copilot-instructions.md)" },
];

type EngineId = "claude" | "agents-md" | "cursor" | "copilot";

/** The always-on plugin — ships with navori and can't be disabled (#68). */
const ENGRAM_ID = "engram";

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
    // Engram is always-on (invariant, #68): it never gets disabled here even if
    // the user deselected it. Force it back in and tell them why.
    let forcedEngram = false;
    if (enabledNow.has(ENGRAM_ID) && !selectedSet.has(ENGRAM_ID)) {
      selectedSet.add(ENGRAM_ID);
      forcedEngram = true;
    }

    // Build the new plugins object. A deselected plugin becomes `enabled:false`
    // rather than being dropped — the disabled entry is what lets the next
    // render strip its managed blocks, injectInto sub-blocks and scripts. Delete
    // the key and that cleanup never runs, leaving orphans behind (#80). To
    // fully forget a plugin (prune the key) after cleanup, use `navori remove`.
    const newPlugins: Record<string, { enabled: boolean }> = {};
    for (const id of new Set([...Object.keys(current), ...selectedSet])) {
      newPlugins[id] = { enabled: selectedSet.has(id) };
    }

    raw.plugins = newPlugins;
    persist(path, raw);

    const added = [...selectedSet].filter((id) => !enabledNow.has(id));
    const removed = [...enabledNow].filter((id) => !selectedSet.has(id));
    if (added.length > 0) p.log.success(`Enabled: ${added.join(", ")}`);
    if (removed.length > 0) p.log.warn(`Disabled: ${removed.join(", ")}`);
    if (forcedEngram) p.log.warn(`engram is always-on with navori — kept enabled.`);
    if (added.length === 0 && removed.length === 0 && !forcedEngram) p.log.info("No changes");
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

const nameSubCommand = defineCommand({
  meta: {
    name: "name",
    description: "Set the project name (kebab-case; app-builder phase 0 syncs the definitive name here)",
  },
  args: {
    cwd: { type: "string", description: "Directory (default: cwd)" },
    value: { type: "positional", description: "Project name (kebab-case)", required: false },
  },
  async run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    const { config, path, raw } = loadOrExit(cwd);

    p.intro(brand("configure name"));

    let value = (args.value as string | undefined)?.trim();
    if (!value) {
      const input = await p.text({
        message: "Project name (kebab-case)",
        placeholder: config.name,
        defaultValue: config.name,
      });
      if (p.isCancel(input)) {
        p.cancel("Cancelled");
        return;
      }
      value = (input as string).trim();
    }

    if (!value) {
      p.cancel("Name cannot be empty");
      return;
    }
    // The schema requires kebab-case; validate here for a friendly message
    // instead of letting writeConfig throw a raw validation error.
    if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
      p.cancel(`Invalid name '${value}'. Must be kebab-case (lowercase letters, digits, hyphens).`);
      return;
    }

    raw.name = value;
    persist(path, raw);
    p.log.success(`name → ${value}`);
    p.outro("Run 'navori render --apply' to re-render with the new name.");
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
        // Rendered files are NOT tied to the workspace (defaults are only
        // applied at init time); the association only feeds workspace
        // commands — don't imply the render will change.
        const ok = await p.confirm({
          message: `Remove workspace association '${currentWorkspace}'? This only detaches the repo from workspace commands (cross-repo tickets, 'navori workspace render'); rendered files are not affected.`,
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
      p.outro("Done. Rendered files are unaffected.");
      return;
    }

    raw.workspace = value;
    persist(path, raw);
    p.log.success(`workspace → ${value}`);
    p.outro(`Run 'navori workspace link' to register this repo in the workspace's local registry.`);
  },
});

const blocksSubCommand = defineCommand({
  meta: {
    name: "blocks",
    description: "Opt out of core managed blocks (e.g. exclude orquestacion / sdd)",
  },
  args: {
    cwd: { type: "string", description: "Directory (default: cwd)" },
  },
  async run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    const { config, path, raw } = loadOrExit(cwd);

    p.intro(brand("configure blocks"));

    const current = new Set(config.blocks?.exclude ?? []);
    const selected = await p.multiselect<string>({
      message: "Core managed blocks to EXCLUDE (checked = opted out of CLAUDE.md)",
      options: EXCLUDABLE_BLOCK_IDS.map((id) => ({ value: id, label: id })),
      required: false,
      initialValues: [...current].filter((id) => (EXCLUDABLE_BLOCK_IDS as readonly string[]).includes(id)),
    });
    if (p.isCancel(selected)) {
      p.cancel("Cancelled");
      return;
    }

    // Excluding a SECURITY block (e.g. operaciones-seguras) weakens the harness
    // guardrails, so it can't be a silent side effect of the multiselect —
    // require an explicit confirm for any newly-added security exclusion.
    const security = new Set<string>(SECURITY_BLOCK_IDS);
    const newlyExcludedSecurity = (selected as string[]).filter(
      (id) => security.has(id) && !current.has(id),
    );
    if (newlyExcludedSecurity.length > 0) {
      const ok = await p.confirm({
        message: `Excluding security block(s) (${newlyExcludedSecurity.join(", ")}) weakens the harness safety rules (force-push / --no-verify / destructive rm guardrails). Continue?`,
        initialValue: false,
      });
      if (p.isCancel(ok) || !ok) {
        p.cancel("Aborted");
        return;
      }
    }

    // Preserve any excluded ids the multiselect didn't offer (an id from a newer
    // navori that this CLI doesn't know as a core block) so we never silently
    // drop the user's intent on a downgrade.
    const known = new Set<string>(EXCLUDABLE_BLOCK_IDS);
    const preserved = [...current].filter((id) => !known.has(id));
    const exclude = [...new Set([...(selected as string[]), ...preserved])];

    if (exclude.length === 0) {
      delete (raw as Record<string, unknown>).blocks;
    } else {
      raw.blocks = { exclude };
    }
    persist(path, raw);

    if (exclude.length > 0) p.log.success(`blocks.exclude → ${exclude.join(", ")}`);
    else p.log.info("blocks.exclude cleared — all core blocks render");
    p.outro("Run 'navori render --apply' or 'navori sync' to apply (excluded blocks are removed).");
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
    name: nameSubCommand,
    "branch-base": branchBaseSubCommand,
    "pr-target": prTargetSubCommand,
    language: languageSubCommand,
    engines: enginesSubCommand,
    workspace: workspaceSubCommand,
    blocks: blocksSubCommand,
  },
});
