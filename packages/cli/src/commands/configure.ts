import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  writeConfig,
  migrateRetiredConfigKeys,
  type NavoriConfig,
  type RetiredKeyDecision,
  type RetiredKeyRename,
} from "../lib/config.ts";
import { createBackup } from "../lib/backup.ts";
import { readConfigOrExit } from "../lib/cli-config.ts";
import { listKnownPluginIds, loadPlugin } from "../lib/plugins.ts";
import { EXCLUDABLE_BLOCK_IDS } from "../lib/render-plan.ts";
import { brand, dim } from "../lib/style.ts";
import { tc, resolveLang, type Lang } from "../lib/i18n.ts";

const ENGINE_OPTIONS = [
  { value: "claude", label: "Claude Code (.claude/)" },
  { value: "agents-md", label: "AGENTS.md (universal — Cursor / Codex / Gemini read it)" },
  { value: "codex", label: "Codex (full — agents, skills, hooks, MCP)" },
  { value: "cursor", label: "Cursor (.cursor/rules/)" },
  { value: "copilot", label: "Copilot (.github/copilot-instructions.md)" },
];

type EngineId = "claude" | "agents-md" | "cursor" | "copilot" | "codex";

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
  if (!existsSync(cwd)) fail(`Directory not found: ${cwd}`);
  const configPath = resolve(cwd, "navori.config.json");
  if (!existsSync(configPath))
    fail(`No navori.config.json at ${configPath}. Run 'navori init' first.`);
  const config = readConfigOrExit(configPath);
  const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  return { config, path: configPath, raw };
}

type ConfigureStrings = ReturnType<typeof tc>["configure"];

/**
 * Locale for a repo whose config may not even load: read straight off the raw
 * `language` key, since `readConfig` aborts on the very configs `migrate`
 * repairs. Unreadable config falls back to the default locale.
 */
function rawConfigLang(cwd: string): Lang {
  try {
    const raw = JSON.parse(readFileSync(resolve(cwd, "navori.config.json"), "utf-8")) as unknown;
    return resolveLang((raw as Record<string, unknown>)?.language);
  } catch {
    return resolveLang(undefined);
  }
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
    const tcfg = tc(resolveLang(config.language)).configure;

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
      message: tcfg.pluginsPrompt,
      options,
      required: false,
      initialValues: [...enabledNow],
    });
    if (p.isCancel(selected)) {
      p.cancel(tcfg.cancelled);
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
    if (added.length > 0) p.log.success(tcfg.enabled(added.join(", ")));
    if (removed.length > 0) p.log.warn(tcfg.disabled(removed.join(", ")));
    if (forcedEngram) p.log.warn(tcfg.engramAlwaysOn);
    if (added.length === 0 && removed.length === 0 && !forcedEngram) p.log.info(tcfg.noChanges);
    p.outro(tcfg.renderOrSyncHint);
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
    const tcfg = tc(resolveLang(config.language)).configure;

    p.intro(brand("configure quality-gate"));

    let fast = args.fast as string | undefined;
    let full = args.full as string | undefined;

    if (!fast || !full) {
      const fastVal = await p.text({
        message: tcfg.fastGatePrompt,
        placeholder: config.qualityGate?.fast ?? "pnpm tsc --noEmit",
        defaultValue: config.qualityGate?.fast ?? "",
      });
      if (p.isCancel(fastVal)) {
        p.cancel(tcfg.cancelled);
        return;
      }
      fast = (fastVal as string).trim();
      const fullVal = await p.text({
        message: tcfg.fullGatePrompt,
        placeholder: config.qualityGate?.full ?? fast,
        defaultValue: config.qualityGate?.full ?? fast,
      });
      if (p.isCancel(fullVal)) {
        p.cancel(tcfg.cancelled);
        return;
      }
      full = (fullVal as string).trim();
    }

    if (!fast || !full) {
      p.cancel(tcfg.bothGatesRequired);
      return;
    }

    raw.qualityGate = { fast, full };
    persist(path, raw);
    p.log.success(tcfg.qualityGateUpdated);
    p.outro(tcfg.done);
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
    const tcfg = tc(resolveLang(config.language)).configure;

    p.intro(brand("configure language"));

    let value = args.value as string | undefined;
    if (!value) {
      const choice = await p.select<"es" | "en">({
        message: tcfg.languagePrompt,
        options: [
          { value: "es", label: tcfg.languageEs },
          { value: "en", label: tcfg.languageEn },
        ],
        initialValue: config.language,
      });
      if (p.isCancel(choice)) {
        p.cancel(tcfg.cancelled);
        return;
      }
      value = choice;
    }

    if (value !== "es" && value !== "en") {
      p.cancel(tcfg.invalidLanguage(value));
      return;
    }

    raw.language = value;
    persist(path, raw);
    p.log.success(tcfg.languageUpdated(value));
    p.outro(tcfg.languageRenderHint);
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
    const tcfg = tc(resolveLang(config.language)).configure;

    p.intro(brand("configure branch-base"));

    let value = (args.value as string | undefined)?.trim();
    if (!value) {
      const input = await p.text({
        message: tcfg.branchBasePrompt,
        placeholder: config.branchBase,
        defaultValue: config.branchBase,
      });
      if (p.isCancel(input)) {
        p.cancel(tcfg.cancelled);
        return;
      }
      value = (input as string).trim();
    }

    if (!value) {
      p.cancel(tcfg.branchRequired);
      return;
    }

    raw.branchBase = value;
    persist(path, raw);
    p.log.success(tcfg.branchBaseUpdated(value));
    p.outro(tcfg.branchBaseRenderHint);
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
    const tcfg = tc(resolveLang(config.language)).configure;

    p.intro(brand("configure pr-target"));

    let value = (args.value as string | undefined)?.trim();
    if (!value) {
      const fallback = config.prTarget ?? config.branchBase;
      const input = await p.text({
        message: tcfg.prTargetPrompt,
        placeholder: fallback,
        defaultValue: fallback,
      });
      if (p.isCancel(input)) {
        p.cancel(tcfg.cancelled);
        return;
      }
      value = (input as string).trim();
    }

    if (!value) {
      p.cancel(tcfg.branchRequired);
      return;
    }

    raw.prTarget = value;
    persist(path, raw);
    p.log.success(tcfg.prTargetUpdated(value));
    if (value === config.branchBase) {
      p.log.message(dim(tcfg.prTargetSame(value)));
    }
    p.outro(tcfg.prTargetRenderHint);
  },
});

const enginesSubCommand = defineCommand({
  meta: {
    name: "engines",
    description: "Add or remove target engines (claude / agents-md / cursor / copilot / codex)",
  },
  args: {
    cwd: { type: "string", description: "Directory (default: cwd)" },
  },
  async run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    const { config, path, raw } = loadOrExit(cwd);
    const tcfg = tc(resolveLang(config.language)).configure;

    p.intro(brand("configure engines"));

    const selected = await p.multiselect<string>({
      message: tcfg.enginesPrompt,
      options: ENGINE_OPTIONS,
      required: true,
      initialValues: config.engines,
    });
    if (p.isCancel(selected)) {
      p.cancel(tcfg.cancelled);
      return;
    }

    raw.engines = selected as EngineId[];
    persist(path, raw);
    p.log.success(tcfg.enginesUpdated((selected as string[]).join(", ")));
    p.outro(tcfg.done);
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
    const tcfg = tc(resolveLang(config.language)).configure;
    const value = (args.value as string | undefined)?.trim();

    p.intro(brand("configure workspace"));

    if (!value) {
      const currentWorkspace = raw.workspace as string | undefined;
      if (!currentWorkspace) {
        p.outro(tcfg.noWorkspace);
        return;
      }
      if (!args.yes) {
        // Rendered files are NOT tied to the workspace (defaults are only
        // applied at init time); the association only feeds workspace
        // commands — don't imply the render will change.
        const ok = await p.confirm({
          message: tcfg.removeWorkspacePrompt(currentWorkspace),
          initialValue: false,
        });
        if (p.isCancel(ok) || !ok) {
          p.cancel(tcfg.aborted);
          return;
        }
      }
      delete raw.workspace;
      persist(path, raw);
      p.log.success(tcfg.workspaceRemoved);
      p.outro(tcfg.workspaceRemovedDone);
      return;
    }

    raw.workspace = value;
    persist(path, raw);
    p.log.success(tcfg.workspaceUpdated(value));
    p.outro(tcfg.workspaceLinkHint);
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
    const tcfg = tc(resolveLang(config.language)).configure;

    p.intro(brand("configure blocks"));

    const current = new Set(config.blocks?.exclude ?? []);
    const selected = await p.multiselect<string>({
      message: tcfg.blocksPrompt,
      options: EXCLUDABLE_BLOCK_IDS.map((id) => ({ value: id, label: id })),
      required: false,
      initialValues: [...current].filter((id) =>
        (EXCLUDABLE_BLOCK_IDS as readonly string[]).includes(id),
      ),
    });
    if (p.isCancel(selected)) {
      p.cancel(tcfg.cancelled);
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

    if (exclude.length > 0) p.log.success(tcfg.blocksUpdated(exclude.join(", ")));
    else p.log.info(tcfg.blocksCleared);
    p.outro(tcfg.blocksRenderHint);
  },
});

/** What `migrateRepoConfig` did (or would do) to one repo's config. */
export type MigrateStatus = "migrated" | "would-migrate" | "clean" | "needs-decision" | "error";

export interface MigrateRepoResult {
  readonly name: string;
  readonly path: string;
  readonly status: MigrateStatus;
  readonly renamed: ReadonlyArray<RetiredKeyRename>;
  readonly dropped: ReadonlyArray<RetiredKeyRename>;
  readonly decisions: ReadonlyArray<RetiredKeyDecision>;
  /** Set only when the config was actually rewritten. */
  readonly backupPath?: string;
  readonly error?: string;
}

/**
 * Repair ONE repo's `navori.config.json` by renaming its retired keys (#920).
 *
 * Deliberately bypasses `readConfig`: that is the function whose R40 check
 * aborts on exactly the configs this command exists to fix, so it reads the
 * raw JSON instead — the same `JSON.parse` the other subcommands already do
 * alongside `readConfigOrExit`.
 *
 * Writes nothing unless `apply` is true, and never writes a config that still
 * has an undecided N:1 collision. When it does write, `createBackup` runs
 * FIRST: this touches a file in the user's repo, so the previous version is
 * always recoverable via `navori backup restore`.
 */
export function migrateRepoConfig(
  repoRoot: string,
  opts: { apply: boolean; choices: Readonly<Record<string, unknown>> },
): MigrateRepoResult {
  const configPath = resolve(repoRoot, "navori.config.json");
  const base = { name: basename(repoRoot), path: repoRoot } as const;
  const asError = (error: string): MigrateRepoResult => ({
    ...base,
    status: "error",
    renamed: [],
    dropped: [],
    decisions: [],
    error,
  });

  if (!existsSync(configPath)) return asError(`No navori.config.json at ${configPath}`);

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8").replace(/^﻿/, "")) as Record<string, unknown>;
  } catch (err) {
    return asError(`Invalid JSON in ${configPath}: ${(err as Error).message}`);
  }

  const name = typeof raw.name === "string" ? raw.name : base.name;
  const { config, renamed, dropped, decisions } = migrateRetiredConfigKeys(raw, opts.choices);
  const common = { ...base, name, renamed, dropped, decisions } as const;

  if (decisions.length > 0) return { ...common, status: "needs-decision" };
  if (renamed.length === 0 && dropped.length === 0) return { ...common, status: "clean" };
  if (!opts.apply) return { ...common, status: "would-migrate" };

  try {
    // Backup BEFORE the rewrite, always — the write itself is atomic, but the
    // previous content is only recoverable from here.
    const backup = createBackup(repoRoot, ["navori.config.json"]);
    persist(configPath, config);
    return { ...common, status: "migrated", backupPath: backup.path };
  } catch (err) {
    return asError(`${configPath}: ${(err as Error).message}`);
  }
}

/** Fully-qualified choices (`models.scout`, `effort.scout`) from the flags. */
function choicesFromFlags(scout?: string, scoutEffort?: string): Record<string, unknown> {
  const choices: Record<string, unknown> = {};
  if (scout) choices["models.scout"] = scout;
  if (scoutEffort) choices["effort.scout"] = scoutEffort;
  return choices;
}

function planLines(result: MigrateRepoResult, tcfg: ConfigureStrings): string[] {
  return [
    ...result.renamed.map((r) => tcfg.migrateRenamedLine(r.from, r.to)),
    ...result.dropped.map((r) => tcfg.migrateDroppedLine(r.from, r.to)),
  ];
}

/**
 * Resolve every pending N:1 collision by asking, one target at a time. Returns
 * null when the user cancels. Only ever ASKS — the flags are the
 * non-interactive path, and nothing is inferred either way (R40).
 */
async function askForDecisions(
  decisions: ReadonlyArray<RetiredKeyDecision>,
  tcfg: ConfigureStrings,
): Promise<Record<string, unknown> | null> {
  const chosen: Record<string, unknown> = {};
  for (const decision of decisions) {
    const answer = await p.select<string>({
      message: tcfg.migrateScoutPrompt(decision.target),
      options: decision.candidates.map((c) => ({
        value: JSON.stringify(c.value),
        label: `${JSON.stringify(c.value)} (${c.path})`,
      })),
    });
    if (p.isCancel(answer)) return null;
    chosen[decision.target] = JSON.parse(answer as string) as unknown;
  }
  return chosen;
}

const migrateSubCommand = defineCommand({
  meta: {
    name: "migrate",
    description: "Rename retired harness/models/effort keys so the config loads again",
  },
  args: {
    cwd: { type: "string", description: "Directory (default: cwd)" },
    "dry-run": { type: "boolean", description: "Show the plan without writing" },
    yes: { type: "boolean", description: "Skip the confirmation (non-interactive)" },
    scout: { type: "string", description: "Value for models.scout when researcher/explorer clash" },
    "scout-effort": { type: "string", description: "Value for effort.scout in the same case" },
  },
  async run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    if (!existsSync(cwd)) fail(`Directory not found: ${cwd}`);
    const lang = rawConfigLang(cwd);
    const tcfg = tc(lang).configure;
    const tcommon = tc(lang).common;
    const dryRun = Boolean(args["dry-run"]);

    p.intro(brand("configure migrate"));

    const choices = choicesFromFlags(
      args.scout as string | undefined,
      args["scout-effort"] as string | undefined,
    );
    let preview = migrateRepoConfig(cwd, { apply: false, choices });

    if (preview.status === "needs-decision" && !args.yes) {
      const answers = await askForDecisions(preview.decisions, tcfg);
      if (answers === null) {
        p.cancel(tcfg.cancelled);
        return;
      }
      Object.assign(choices, answers);
      preview = migrateRepoConfig(cwd, { apply: false, choices });
    }

    if (preview.status === "error") fail(preview.error ?? "unknown error");
    if (preview.status === "clean") {
      p.log.info(tcfg.migrateNothingToDo);
      p.outro(tcfg.done);
      return;
    }

    const lines = planLines(preview, tcfg);
    if (lines.length > 0) p.log.message(`${tcfg.migratePlanHeader}\n${lines.join("\n")}`);

    if (preview.status === "needs-decision") {
      p.cancel(tcfg.migrateDecisionPending(preview.decisions.map((d) => d.target).join(", ")));
      p.log.info(tcfg.migrateDecisionHint);
      process.exit(1);
    }

    if (dryRun) {
      p.outro(tcfg.migrateDryRun);
      return;
    }

    if (!args.yes) {
      const ok = await p.confirm({
        message: tcfg.migrateConfirm(lines.length),
        initialValue: true,
      });
      if (p.isCancel(ok) || !ok) {
        p.cancel(tcfg.aborted);
        return;
      }
    }

    const applied = migrateRepoConfig(cwd, { apply: true, choices });
    if (applied.status === "error") fail(applied.error ?? "unknown error");
    if (applied.backupPath) p.log.message(dim(`${tcommon.backupLabel} ${applied.backupPath}`));
    p.log.success(tcfg.migrateApplied(planLines(applied, tcfg).length));
    p.outro(tcfg.migrateRenderHint);
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
    migrate: migrateSubCommand,
    engines: enginesSubCommand,
    workspace: workspaceSubCommand,
    blocks: blocksSubCommand,
  },
});
