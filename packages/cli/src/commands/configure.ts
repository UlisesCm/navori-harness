import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeConfig, type NavoriConfig } from "../lib/config.ts";
import { readConfigOrExit } from "../lib/cli-config.ts";
import { listKnownPluginIds, loadPlugin } from "../lib/plugins.ts";
import { EXCLUDABLE_BLOCK_IDS } from "../lib/render-plan.ts";
import { brand, dim } from "../lib/style.ts";
import { tc, resolveLang, DEFAULT_LANG } from "../lib/i18n.ts";

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

function loadOrExit(cwd: string): {
  config: NavoriConfig;
  path: string;
  raw: Record<string, unknown>;
} {
  if (!existsSync(cwd)) fail(tc(DEFAULT_LANG).common.dirNotFound(cwd));
  const configPath = resolve(cwd, "navori.config.json");
  if (!existsSync(configPath)) fail(tc(DEFAULT_LANG).common.noConfig(configPath));
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
    const tr = tc(resolveLang(config.language)).configure;

    p.intro(brand("configure plugins"));

    const allIds = listKnownPluginIds();
    const current = config.plugins ?? {};
    const enabledNow = new Set(
      Object.entries(current)
        .filter(([, v]) => v.enabled)
        .map(([k]) => k),
    );

    const options = allIds
      .map((id) => {
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
      })
      .filter((o): o is NonNullable<typeof o> => o !== null);

    const selected = await p.multiselect<string>({
      message: tr.pluginsPrompt,
      options,
      required: false,
      initialValues: [...enabledNow],
    });
    if (p.isCancel(selected)) {
      p.cancel(tr.cancelled);
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
    if (added.length > 0) p.log.success(tr.enabled(added.join(", ")));
    if (removed.length > 0) p.log.warn(tr.disabled(removed.join(", ")));
    if (forcedEngram) p.log.warn(tr.engramAlwaysOn);
    if (added.length === 0 && removed.length === 0 && !forcedEngram) p.log.info(tr.noChanges);
    p.outro(tr.renderOrSyncHint);
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
    const tr = tc(resolveLang(config.language)).configure;

    p.intro(brand("configure quality-gate"));

    let fast = args.fast as string | undefined;
    let full = args.full as string | undefined;

    if (!fast || !full) {
      const fastVal = await p.text({
        message: tr.fastGatePrompt,
        placeholder: config.qualityGate?.fast ?? "pnpm tsc --noEmit",
        defaultValue: config.qualityGate?.fast ?? "",
      });
      if (p.isCancel(fastVal)) {
        p.cancel(tr.cancelled);
        return;
      }
      fast = (fastVal as string).trim();
      const fullVal = await p.text({
        message: tr.fullGatePrompt,
        placeholder: config.qualityGate?.full ?? fast,
        defaultValue: config.qualityGate?.full ?? fast,
      });
      if (p.isCancel(fullVal)) {
        p.cancel(tr.cancelled);
        return;
      }
      full = (fullVal as string).trim();
    }

    if (!fast || !full) {
      p.cancel(tr.bothGatesRequired);
      return;
    }

    raw.qualityGate = { fast, full };
    persist(path, raw);
    p.log.success(tr.qualityGateUpdated);
    p.outro(tr.done);
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
    const tr = tc(resolveLang(config.language)).configure;

    p.intro(brand("configure language"));

    let value = args.value as string | undefined;
    if (!value) {
      const choice = await p.select<"es" | "en">({
        message: tr.languagePrompt,
        options: [
          { value: "es", label: tr.languageEs },
          { value: "en", label: tr.languageEn },
        ],
        initialValue: config.language,
      });
      if (p.isCancel(choice)) {
        p.cancel(tr.cancelled);
        return;
      }
      value = choice;
    }

    if (value !== "es" && value !== "en") {
      p.cancel(tr.invalidLanguage(value));
      return;
    }

    raw.language = value;
    persist(path, raw);
    const nextTr = tc(value).configure;
    p.log.success(nextTr.languageUpdated(value));
    p.outro(nextTr.languageRenderHint);
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
    const tr = tc(resolveLang(config.language)).configure;

    p.intro(brand("configure branch-base"));

    let value = (args.value as string | undefined)?.trim();
    if (!value) {
      const input = await p.text({
        message: tr.branchBasePrompt,
        placeholder: config.branchBase,
        defaultValue: config.branchBase,
      });
      if (p.isCancel(input)) {
        p.cancel(tr.cancelled);
        return;
      }
      value = (input as string).trim();
    }

    if (!value) {
      p.cancel(tr.branchRequired);
      return;
    }

    raw.branchBase = value;
    persist(path, raw);
    p.log.success(tr.branchBaseUpdated(value));
    p.outro(tr.branchBaseRenderHint);
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
    const tr = tc(resolveLang(config.language)).configure;

    p.intro(brand("configure pr-target"));

    let value = (args.value as string | undefined)?.trim();
    if (!value) {
      const fallback = config.prTarget ?? config.branchBase;
      const input = await p.text({
        message: tr.prTargetPrompt,
        placeholder: fallback,
        defaultValue: fallback,
      });
      if (p.isCancel(input)) {
        p.cancel(tr.cancelled);
        return;
      }
      value = (input as string).trim();
    }

    if (!value) {
      p.cancel(tr.branchRequired);
      return;
    }

    raw.prTarget = value;
    persist(path, raw);
    p.log.success(tr.prTargetUpdated(value));
    if (value === config.branchBase) {
      p.log.message(dim(tr.prTargetSame(value)));
    }
    p.outro(tr.prTargetRenderHint);
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
    const tr = tc(resolveLang(config.language)).configure;

    p.intro(brand("configure engines"));

    const selected = await p.multiselect<string>({
      message: tr.enginesPrompt,
      options: ENGINE_OPTIONS,
      required: true,
      initialValues: config.engines,
    });
    if (p.isCancel(selected)) {
      p.cancel(tr.cancelled);
      return;
    }

    raw.engines = selected as EngineId[];
    persist(path, raw);
    p.log.success(tr.enginesUpdated((selected as string[]).join(", ")));
    p.outro(tr.done);
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
    const { config, path, raw } = loadOrExit(cwd);
    const tr = tc(resolveLang(config.language)).configure;
    const value = (args.value as string | undefined)?.trim();

    p.intro(brand("configure workspace"));

    if (!value) {
      const currentWorkspace = raw.workspace as string | undefined;
      if (!currentWorkspace) {
        p.outro(tr.noWorkspace);
        return;
      }
      if (!args.yes) {
        // Rendered files are NOT tied to the workspace (defaults are only
        // applied at init time); the association only feeds workspace
        // commands — don't imply the render will change.
        const ok = await p.confirm({
          message: tr.removeWorkspacePrompt(currentWorkspace),
          initialValue: false,
        });
        if (p.isCancel(ok) || !ok) {
          p.cancel(tr.aborted);
          return;
        }
      }
      delete raw.workspace;
      persist(path, raw);
      p.log.success(tr.workspaceRemoved);
      p.outro(tr.workspaceRemovedDone);
      return;
    }

    raw.workspace = value;
    persist(path, raw);
    p.log.success(tr.workspaceUpdated(value));
    p.outro(tr.workspaceLinkHint);
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
    const tr = tc(resolveLang(config.language)).configure;

    p.intro(brand("configure blocks"));

    const current = new Set(config.blocks?.exclude ?? []);
    const selected = await p.multiselect<string>({
      message: tr.blocksPrompt,
      options: EXCLUDABLE_BLOCK_IDS.map((id) => ({ value: id, label: id })),
      required: false,
      initialValues: [...current].filter((id) =>
        (EXCLUDABLE_BLOCK_IDS as readonly string[]).includes(id),
      ),
    });
    if (p.isCancel(selected)) {
      p.cancel(tr.cancelled);
      return;
    }

    // Preserve any excluded ids the multiselect didn't offer — a non-excludable
    // core block or an id from a newer navori this CLI doesn't know — so we never
    // silently drop the user's intent (`doctor` warns about the ineffective ones).
    const known = new Set<string>(EXCLUDABLE_BLOCK_IDS);
    const preserved = [...current].filter((id) => !known.has(id));
    const exclude = [...new Set([...(selected as string[]), ...preserved])];

    if (exclude.length === 0) {
      delete (raw as Record<string, unknown>).blocks;
    } else {
      raw.blocks = { exclude };
    }
    persist(path, raw);

    if (exclude.length > 0) p.log.success(tr.blocksUpdated(exclude.join(", ")));
    else p.log.info(tr.blocksCleared);
    p.outro(tr.blocksRenderHint);
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
    blocks: blocksSubCommand,
  },
});
