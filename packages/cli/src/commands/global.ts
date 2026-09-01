import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { join } from "node:path";
import { brand, check, color, dim as grey, sym } from "../lib/style.ts";
import { t, tc, resolveLang } from "../lib/i18n.ts";
import {
  defaultGlobalConfig,
  deleteGlobalConfig,
  globalConfigExists,
  readGlobalConfig,
  upgradeDefaultBlocks,
  writeGlobalConfig,
  type GlobalConfig,
} from "../lib/global-config.ts";
import { readCliVersion } from "../lib/bundled-assets.ts";
import {
  applyGlobalRender,
  composeBaseline,
  configuredPermissionsCount,
  detectLegacyGlobalHook,
  generateHookScript,
  globalTargetDir,
  migrateLegacyGlobalHook,
  planGlobalRender,
  probeGate,
  readExistingSettings,
  readHookDrift,
  settingsHasPermissions,
  uninstallGlobalRender,
  unreadableSettingsMessage,
  type GlobalRenderPlan,
} from "../engines/claude/global-render.ts";
import { pickGlobalBlocks, pickGlobalPermissions } from "./global-prompts.ts";
import {
  applyGlobalPlugin,
  globalPluginDir,
  planGlobalPlugin,
  pluginDrift,
  pluginInstalled,
  removeGlobalPlugin,
  PLUGIN_HOOK_SCRIPT_REL,
} from "../engines/claude/global-plugin.ts";

/**
 * Persist which permission entries navori owns, right after the write that made
 * it true (#544). It lives in the command layer, not in `applyGlobalRender`, so
 * the renderer keeps writing only to the Claude config dir: a render that also
 * touched `~/.navori/global.json` would put every spec that calls it in reach of
 * the real machine-global store the suite guards (#404/#424).
 */
function recordPermissionOwnership(config: GlobalConfig, plan: GlobalRenderPlan): void {
  const before = JSON.stringify(config.ownedPermissions);
  if (before === JSON.stringify(plan.ownedPermissions)) return;
  config.ownedPermissions = plan.ownedPermissions;
  writeGlobalConfig(config);
}

/** Everything a global render produces, computed before a single byte is written. */
interface GlobalPlans {
  plugin: ReturnType<typeof planGlobalPlugin>;
  settings: GlobalRenderPlan;
}

/**
 * Compose both plans or fail cleanly (a non-global-safe block, an unreadable
 * settings.json).
 *
 * ORDER IS LOAD-BEARING when `migrate` is set. The baseline is composed first,
 * so a block that cannot render in the global scope aborts before any write.
 * The settings plan is computed AFTER the legacy migration, because that
 * migration strips the F1 SessionStart entry from settings.json and
 * `planGlobalRender` merges over whatever is on disk — computing it first would
 * write the entry straight back and leave the gate registered twice.
 */
function planOrExit(config: GlobalConfig, dir: string, migrate: (() => void) | null): GlobalPlans {
  try {
    const baseline = composeBaseline(config);
    if (migrate) migrate();
    const settings = planGlobalRender(config, dir);
    return { plugin: planGlobalPlugin(config, baseline, dir), settings };
  } catch (err) {
    p.cancel(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

/**
 * Refuse to start when the user's machine-wide settings.json exists but cannot
 * be parsed (#497). Checked BEFORE the legacy migration so a broken file never
 * ends with the old hook deleted and the new plugin not installed.
 */
function assertSettingsReadableOrExit(config: GlobalConfig, dir: string): void {
  const read = readExistingSettings(dir);
  if (read.kind === "parse-error" || read.kind === "not-object") {
    p.cancel(unreadableSettingsMessage(read, join(dir, "settings.json"), config.language));
    process.exit(1);
  }
}

/**
 * Move an F1 install onto the plugin layout and say so. Returns the thunk
 * `planOrExit` runs between composing the baseline and planning settings; a
 * machine with no F1 install gets a silent no-op.
 */
function migrateLegacy(dir: string, g: ReturnType<typeof tc>["global"]): () => void {
  return () => {
    const result = migrateLegacyGlobalHook(dir);
    if (result.snapshotPath !== null) p.log.info(g.legacyMigrated(result.snapshotPath));
  };
}

/**
 * Whether `global init` should ask. `--recommended` is the declared headless
 * path; a missing TTY is the undeclared one (a CI job, a pipe), and there the
 * prompts would crash on `setRawMode` instead of failing on their own terms.
 */
function initIsInteractive(recommended: boolean): boolean {
  return !recommended && process.stdin.isTTY === true;
}

/**
 * Run the `init` wizard over `config`, mutating it in place. Returns false when
 * the user aborted, in which case NOTHING has been written yet — the prompts run
 * before the plan, so a cancel costs zero bytes.
 *
 * The non-interactive path leaves `config` exactly as it arrived: the previous
 * selection on a re-`init`, `DEFAULT_GLOBAL_BLOCKS` on a fresh one. That is what
 * `--recommended` means here — take the recommended selection, never reset one
 * the user already made.
 */
async function collectInitChoices(
  config: GlobalConfig,
  recommended: boolean,
  g: ReturnType<typeof tc>["global"],
): Promise<boolean> {
  if (!initIsInteractive(recommended)) {
    if (!recommended) p.log.info(grey(g.initHeadless));
    return true;
  }
  const lang = resolveLang(config.language);
  const blocks = await pickGlobalBlocks(config.blocks.include, lang);
  if (blocks === null) {
    p.cancel(g.initCancelled);
    return false;
  }
  const permissions = await pickGlobalPermissions(config.permissions, lang);
  if (permissions === null) {
    p.cancel(g.initCancelled);
    return false;
  }
  // Assigned only once BOTH answers are in, so an abort halfway leaves the
  // config as untouched as the disk.
  config.blocks.include = blocks;
  config.permissions = permissions;
  return true;
}

/**
 * What an `init` would write, or did — one list, so the preview cannot describe
 * a different install from the one `--apply` performs. It names the hook and the
 * settings file explicitly because those are the two artifacts a user cannot
 * infer from "plugin: <dir>".
 */
function initPlanRows(
  plans: GlobalPlans,
  config: GlobalConfig,
  g: ReturnType<typeof tc>["global"],
): string[] {
  const rows = [
    g.wrotePlugin(plans.plugin.dir, plans.plugin.files.length),
    g.wroteHook(join(plans.plugin.dir, PLUGIN_HOOK_SCRIPT_REL)),
    // A default config merges nothing, so settings.json is not even created;
    // saying "settings: <path>" there would promise a write that never happens.
    plans.settings.settingsChanged
      ? g.wroteSettings(plans.settings.settingsPath)
      : g.settingsUnchanged(plans.settings.settingsPath),
    g.baselineBlocks(config.blocks.include.join(", ")),
  ];
  const permissions = configuredPermissionsCount(config);
  if (permissions > 0) rows.push(g.permsPlanned(permissions));
  return rows;
}

const initSubCommand = defineCommand({
  meta: {
    name: "init",
    description: "Install the global harness baseline into ~/.claude (explicit opt-in)",
  },
  args: {
    lang: { type: "string", description: "Baseline language: es | en (default es)" },
    apply: { type: "boolean", description: "Write files (default: preview)" },
    recommended: {
      type: "boolean",
      description: "Take the recommended selection without prompting (headless / CI)",
    },
  },
  async run({ args }) {
    p.intro(brand("global init"));
    const existing = globalConfigExists() ? readGlobalConfig() : null;
    const langArg = args.lang === "en" ? "en" : args.lang === "es" ? "es" : undefined;
    const language = langArg ?? existing?.language ?? "es";
    const g = tc(resolveLang(language)).global;

    const config = existing ?? defaultGlobalConfig(readCliVersion(), language);
    config.version = readCliVersion();
    config.language = language;
    upgradeDefaultBlocks(config);

    // Read-only, and BEFORE the wizard: an unreadable ~/.claude/settings.json
    // aborts here (#497), so nobody answers prompts for a run that could not
    // have written anything.
    const dir = globalTargetDir();
    assertSettingsReadableOrExit(config, dir);

    if (!(await collectInitChoices(config, Boolean(args.recommended), g))) return;

    // Planning is read-only; the legacy migration is not, so it only runs on the
    // apply path. Without --apply this whole command must leave the machine
    // byte-for-byte as it found it (Spec 0010 §2.4).
    const plans = planOrExit(config, dir, args.apply ? migrateLegacy(dir, g) : null);
    const rows = initPlanRows(plans, config, g);

    if (!args.apply) {
      p.note(rows.map((s) => `  ${color.cyan(sym.bullet)} ${s}`).join("\n"), g.previewTitle);
      p.outro(grey(g.initPreviewHint));
      return;
    }

    writeGlobalConfig(config);
    applyGlobalPlugin(plans.plugin);
    const backupPath = applyGlobalRender(plans.settings);
    recordPermissionOwnership(config, plans.settings);

    if (existing) p.log.info(g.initReinit(dir));
    if (backupPath) rows.push(t(resolveLang(language)).backedUp(1, backupPath));
    p.note(rows.map((s) => `  ${color.cyan(sym.bullet)} ${s}`).join("\n"), g.doctorTitle(dir));
    p.log.info(grey(g.pluginNamespaceHint));
    p.log.info(grey(g.hooksDisabledHint));
    p.outro(color.green(g.initDone(dir)));
  },
});

const renderSubCommand = defineCommand({
  meta: {
    name: "render",
    description: "Re-render the global baseline hook into ~/.claude",
  },
  args: {
    apply: { type: "boolean", description: "Write files (default: preview)" },
  },
  async run({ args }) {
    p.intro(brand("global render"));
    const config = readGlobalConfig();
    const g = tc(resolveLang(config?.language)).global;
    if (!config) {
      p.cancel(g.notInstalled);
      process.exit(1);
    }
    const dir = globalTargetDir();
    assertSettingsReadableOrExit(config, dir);
    // Before planning: the baseline it composes must reflect the upgraded
    // selection, and a preview must show what an apply would actually write.
    const upgradedBlocks = upgradeDefaultBlocks(config);
    const plans = planOrExit(config, dir, args.apply ? migrateLegacy(dir, g) : null);
    const rows = [
      g.wrotePlugin(plans.plugin.dir, plans.plugin.files.length),
      g.wroteSettings(plans.settings.settingsPath),
    ];
    if (args.apply) {
      if (upgradedBlocks) writeGlobalConfig(config);
      applyGlobalPlugin(plans.plugin);
      const backupPath = applyGlobalRender(plans.settings);
      recordPermissionOwnership(config, plans.settings);
      if (backupPath) rows.push(t(resolveLang(config.language)).backedUp(1, backupPath));
      p.note(rows.map((s) => `  ${color.cyan(sym.bullet)} ${s}`).join("\n"), g.previewTitle);
      p.log.info(grey(g.pluginNamespaceHint));
      p.outro(color.green(g.renderApplied(dir)));
    } else {
      const legacy = detectLegacyGlobalHook(dir);
      if (legacy.filePresent) p.log.warn(g.legacyLeftover(legacy.hookPath));
      rows.push(g.baselineBlocks(config.blocks.include.join(", ")));
      p.note(rows.map((s) => `  ${color.cyan(sym.bullet)} ${s}`).join("\n"), g.previewTitle);
      p.outro(grey(g.previewHint));
    }
  },
});

/**
 * Which plugin files drift from what the CLI would render now, or null when the
 * plan itself cannot be built. Doctor reports; it never aborts over a bad block
 * (the baseline check above already said so on its own terms).
 */
function pluginDriftOrNull(config: GlobalConfig, dir: string): string[] | null {
  try {
    return pluginDrift(planGlobalPlugin(config, composeBaseline(config), dir));
  } catch {
    return null;
  }
}

const doctorSubCommand = defineCommand({
  meta: {
    name: "doctor",
    description: "Audit the global harness in ~/.claude",
  },
  async run() {
    p.intro(brand("global doctor"));
    const config = readGlobalConfig();
    const g = tc(resolveLang(config?.language)).global;
    if (!config) {
      p.outro(g.notInstalled);
      return;
    }
    const dir = globalTargetDir();
    const lines: string[] = [];
    let issues = false;

    const hookPath = join(globalPluginDir(dir), PLUGIN_HOOK_SCRIPT_REL);
    // Composed here rather than via `planGlobalRender` on purpose: the plan also
    // reads settings.json and THROWS when it is unreadable (#497), which is a
    // separate finding the checks below report on their own terms. Doctor must
    // not abort over it.
    let expectedHook: string | null = null;
    try {
      expectedHook = generateHookScript(composeBaseline(config));
    } catch (err) {
      lines.push(`  ${color.red(sym.fail)} ${err instanceof Error ? err.message : String(err)}`);
      issues = true;
    }

    if (expectedHook !== null) {
      const drift = readHookDrift(hookPath, expectedHook);
      switch (drift.kind) {
        case "ok":
          lines.push(`  ${check(true)} ${g.hookPresent}`);
          break;
        case "absent":
          lines.push(`  ${color.red(sym.fail)} ${g.hookMissing}`);
          issues = true;
          break;
        case "unmarked":
          lines.push(`  ${color.yellow(sym.update)} ${g.hookUnmarked}`);
          issues = true;
          break;
        case "hand-edited":
          lines.push(`  ${color.red(sym.fail)} ${g.hookHandEdited(hookPath)}`);
          issues = true;
          break;
        case "stale":
          lines.push(
            `  ${color.yellow(sym.update)} ${g.hookStale(drift.installedVersion, drift.expectedVersion)}`,
          );
          issues = true;
          break;
      }

      // Running it is the only check that proves the baseline actually reaches a
      // session (#543); every check above only proves the file's contents.
      if (drift.kind !== "absent") {
        const probe = probeGate(hookPath);
        switch (probe.kind) {
          case "ok":
            lines.push(`  ${check(true)} ${g.gateOk}`);
            break;
          case "no-json-tool":
            lines.push(`  ${color.red(sym.fail)} ${g.gateNoJsonTool}`);
            issues = true;
            break;
          case "no-emit":
            lines.push(`  ${color.red(sym.fail)} ${g.gateNoEmit}`);
            issues = true;
            break;
          case "no-defer":
            lines.push(`  ${color.red(sym.fail)} ${g.gateNoDefer}`);
            issues = true;
            break;
          case "malformed":
            lines.push(`  ${color.red(sym.fail)} ${g.gateMalformed(probe.detail)}`);
            issues = true;
            break;
          case "error":
            lines.push(`  ${color.red(sym.fail)} ${g.gateError(probe.detail)}`);
            issues = true;
            break;
        }
      }
    }

    // The plugin is what makes the agents and the skills exist at all; the hook
    // checks above only prove the baseline prose reaches a session.
    if (!pluginInstalled(dir)) {
      lines.push(`  ${color.red(sym.fail)} ${g.pluginMissing}`);
      issues = true;
    } else {
      const drifted = pluginDriftOrNull(config, dir);
      if (drifted === null || drifted.length > 0) {
        lines.push(`  ${color.yellow(sym.update)} ${g.pluginStale((drifted ?? []).join(", "))}`);
        issues = true;
      } else {
        lines.push(`  ${check(true)} ${g.pluginPresent}`);
      }
    }

    // An F1 install that was never re-rendered still has the loose hook, which
    // would emit the baseline a second time alongside the plugin's.
    const legacy = detectLegacyGlobalHook(dir);
    if (legacy.filePresent || legacy.registeredInSettings) {
      lines.push(`  ${color.yellow(sym.update)} ${g.legacyLeftover(legacy.hookPath)}`);
      issues = true;
    }

    const permsCount = configuredPermissionsCount(config);
    if (permsCount > 0) {
      if (settingsHasPermissions(config, dir)) {
        lines.push(`  ${check(true)} ${g.permsMerged(permsCount)}`);
      } else {
        lines.push(`  ${color.red(sym.fail)} ${g.permsNotMerged}`);
        issues = true;
      }
    }

    const cliVersion = readCliVersion();
    if (config.version === cliVersion) {
      lines.push(`  ${color.cyan(sym.bullet)} ${g.versionOk(config.version)}`);
    } else {
      lines.push(`  ${color.yellow(sym.update)} ${g.versionDrift(config.version, cliVersion)}`);
    }

    p.note(lines.join("\n"), g.doctorTitle(dir));
    p.log.info(grey(g.pluginNamespaceHint));
    p.log.info(grey(g.hooksDisabledHint));
    p.outro(issues ? color.yellow(g.outroIssues) : color.green(g.outroOk));
  },
});

const uninstallSubCommand = defineCommand({
  meta: {
    name: "uninstall",
    description:
      "Remove ONLY navori's global footprint from ~/.claude (leaves other config intact)",
  },
  async run() {
    p.intro(brand("global uninstall"));
    const config = readGlobalConfig();
    const g = tc(resolveLang(config?.language)).global;
    const dir = globalTargetDir();

    const removedPlugin = removeGlobalPlugin(dir);
    const result = uninstallGlobalRender(dir, config);
    const hadConfig = deleteGlobalConfig();

    // #497: an unreadable settings.json is left byte-for-byte alone, so say what
    // is still there instead of reporting a clean uninstall.
    if (result.settingsUnreadable) {
      p.log.warn(g.uninstallSettingsUnreadable(join(dir, "settings.json")));
    }
    if (result.backupPath) {
      p.log.info(t(resolveLang(config?.language)).backedUp(1, result.backupPath));
    }

    if (!removedPlugin && !result.removedHook && !result.updatedSettings && !hadConfig) {
      p.outro(g.uninstallNothing);
      return;
    }
    p.outro(color.green(g.uninstallDone(dir)));
  },
});

export const globalCommand = defineCommand({
  meta: {
    name: "global",
    description: "Manage the optional machine-wide global harness (~/.claude)",
  },
  subCommands: {
    init: initSubCommand,
    render: renderSubCommand,
    doctor: doctorSubCommand,
    uninstall: uninstallSubCommand,
  },
});
