import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { brand, check, color, dim as grey, sym } from "../lib/style.ts";
import { t, tc, resolveLang } from "../lib/i18n.ts";
import {
  defaultGlobalConfig,
  deleteGlobalConfig,
  globalConfigExists,
  readGlobalConfig,
  writeGlobalConfig,
  type GlobalConfig,
} from "../lib/global-config.ts";
import { readCliVersion } from "../lib/bundled-assets.ts";
import {
  applyGlobalRender,
  configuredPermissionsCount,
  globalHookPath,
  globalTargetDir,
  planGlobalRender,
  settingsHasBaseline,
  settingsHasPermissions,
  uninstallGlobalRender,
  type GlobalRenderPlan,
} from "../engines/claude/global-render.ts";

/** Compose the render plan or fail cleanly (e.g. a non-global-safe block). */
function planOrExit(config: GlobalConfig): GlobalRenderPlan {
  try {
    return planGlobalRender(config);
  } catch (err) {
    p.cancel(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

const initSubCommand = defineCommand({
  meta: {
    name: "init",
    description: "Install the global harness baseline into ~/.claude (explicit opt-in)",
  },
  args: {
    lang: { type: "string", description: "Baseline language: es | en (default es)" },
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

    // Plan BEFORE persisting anything: an unreadable ~/.claude/settings.json
    // aborts here (#497), and a run that installs nothing should leave no
    // ~/.navori/global.json claiming otherwise.
    const plan = planOrExit(config);
    writeGlobalConfig(config);
    const backupPath = applyGlobalRender(plan);

    if (existing) p.log.info(g.initReinit(plan.dir));
    const rows = [
      g.wroteHook(plan.hookPath),
      g.wroteSettings(plan.settingsPath),
      g.baselineBlocks(config.blocks.include.join(", ")),
    ];
    if (backupPath) rows.push(t(resolveLang(language)).backedUp(1, backupPath));
    p.note(rows.map((s) => `  ${color.cyan(sym.bullet)} ${s}`).join("\n"), g.doctorTitle(plan.dir));
    p.log.info(grey(g.hooksDisabledHint));
    p.outro(color.green(g.initDone(plan.dir)));
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
    const plan = planOrExit(config);
    const rows = [g.wroteHook(plan.hookPath), g.wroteSettings(plan.settingsPath)];
    if (args.apply) {
      const backupPath = applyGlobalRender(plan);
      if (backupPath) rows.push(t(resolveLang(config.language)).backedUp(1, backupPath));
      p.note(rows.map((s) => `  ${color.cyan(sym.bullet)} ${s}`).join("\n"), g.previewTitle);
      p.outro(color.green(g.renderApplied(plan.dir)));
    } else {
      rows.push(g.baselineBlocks(config.blocks.include.join(", ")));
      p.note(rows.map((s) => `  ${color.cyan(sym.bullet)} ${s}`).join("\n"), g.previewTitle);
      p.outro(grey(g.previewHint));
    }
  },
});

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

    if (existsSync(globalHookPath(dir))) {
      lines.push(`  ${check(true)} ${g.hookPresent}`);
    } else {
      lines.push(`  ${color.red(sym.fail)} ${g.hookMissing}`);
      issues = true;
    }

    if (settingsHasBaseline(dir)) {
      lines.push(`  ${check(true)} ${g.settingsRegistered}`);
    } else {
      lines.push(`  ${color.red(sym.fail)} ${g.settingsNotRegistered}`);
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

    const result = uninstallGlobalRender(dir);
    const hadConfig = deleteGlobalConfig();

    // #497: an unreadable settings.json is left byte-for-byte alone, so say what
    // is still there instead of reporting a clean uninstall.
    if (result.settingsUnreadable) {
      p.log.warn(g.uninstallSettingsUnreadable(join(dir, "settings.json")));
    }
    if (result.backupPath) {
      p.log.info(t(resolveLang(config?.language)).backedUp(1, result.backupPath));
    }

    if (!result.removedHook && !result.updatedSettings && !hadConfig) {
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
