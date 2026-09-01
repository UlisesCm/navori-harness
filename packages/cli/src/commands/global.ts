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
  writeGlobalConfig,
  type GlobalConfig,
} from "../lib/global-config.ts";
import { readCliVersion } from "../lib/bundled-assets.ts";
import {
  applyGlobalRender,
  composeBaseline,
  configuredPermissionsCount,
  generateHookScript,
  globalHookPath,
  globalTargetDir,
  planGlobalRender,
  probeGate,
  readHookDrift,
  settingsHasBaseline,
  settingsHasPermissions,
  uninstallGlobalRender,
  type GlobalRenderPlan,
} from "../engines/claude/global-render.ts";

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
    recordPermissionOwnership(config, plan);

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
      recordPermissionOwnership(config, plan);
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

    const hookPath = globalHookPath(dir);
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
