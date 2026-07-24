import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync } from "node:fs";
import { renderClaudeEngine, type ClaudeEngineResult } from "../engines/claude/index.ts";
import { globalTarget, type RenderTarget } from "../lib/render-target.ts";
import {
  readGlobalConfig,
  writeGlobalConfig,
  globalConfigPath,
  globalConfigToNavoriConfig,
  globalPermissionsEnabled,
  validateGlobalPlugins,
  GlobalConfigError,
  type GlobalConfig,
} from "../lib/global-config.ts";
import { listKnownPluginIds, loadPlugin } from "../lib/plugins.ts";
import { CORE_MANAGED_ASSETS } from "../lib/render-plan.ts";
import { listMarkers, scanManagedDrift } from "../lib/health.ts";
import { resolveLang, tc, DEFAULT_LANG, type Lang } from "../lib/i18n.ts";
import { brand, dim, accent, color, sym, kv, check } from "../lib/style.ts";

/**
 * Render the global (persona) target with the SAME engine as the repo, pointed
 * at `~/.claude` (or `CLAUDE_CONFIG_DIR`). The engine's marker/hash/backup
 * machinery handles coexistence with a hand-written `~/.claude/CLAUDE.md`
 * automatically: content outside navori markers is preserved and a backup is
 * taken before any write (spec 0005 §2.1). Shared by init/render/sync.
 */
export function runGlobalRender(
  config: GlobalConfig,
  opts: { dryRun?: boolean; force?: boolean; dir?: string } = {},
): { target: RenderTarget; result: ClaudeEngineResult } {
  const target = globalTarget(opts.dir);
  const result = renderClaudeEngine(target.baseDir, globalConfigToNavoriConfig(config), {
    dryRun: opts.dryRun ?? false,
    force: opts.force ?? false,
    scope: "global",
    omitSettings: !globalPermissionsEnabled(config),
  });
  return { target, result };
}

/** Plugin ids whose manifest allows the global scope — the init multiselect set. */
function globalCapablePluginIds(): string[] {
  const out: string[] = [];
  for (const id of listKnownPluginIds()) {
    try {
      if ((loadPlugin(id).manifest.allowedScopes as readonly string[]).includes("global")) out.push(id);
    } catch {
      // unloadable plugin — skip
    }
  }
  return out;
}

const initSubCommand = defineCommand({
  meta: { name: "init", description: "Bootstrap the global (persona) harness at ~/.claude" },
  args: {
    recommended: { type: "boolean", description: "Accept recommended defaults without prompting" },
    yes: { type: "boolean", description: "Alias for --recommended" },
    apply: { type: "boolean", description: "Write to disk (default previews)" },
  },
  async run({ args }) {
    const recommended = Boolean(args.recommended) || Boolean(args.yes);
    const existing = readGlobalConfigSafe();
    const lang = resolveLang(existing?.language);
    const tg = tc(lang).global;
    p.intro(brand("global init"));

    const globalPlugins = globalCapablePluginIds();

    let language: "es" | "en" = existing?.language === "en" ? "en" : "es";
    let selectedPlugins = new Set<string>(
      Object.entries(existing?.plugins ?? {})
        .filter(([, v]) => v.enabled)
        .map(([k]) => k),
    );
    let permissions = existing ? globalPermissionsEnabled(existing) : true;

    if (!recommended) {
      const langAns = await p.select({
        message: tg.initLangPrompt,
        options: [
          { value: "es", label: "Español" },
          { value: "en", label: "English" },
        ],
        initialValue: language,
      });
      if (p.isCancel(langAns)) return void p.cancel(tc(lang).common.aborted);
      language = langAns as "es" | "en";

      if (globalPlugins.length > 0) {
        const plugAns = await p.multiselect({
          message: tg.initPluginsPrompt,
          options: globalPlugins.map((id) => ({ value: id, label: id })),
          initialValues: [...selectedPlugins].filter((id) => globalPlugins.includes(id)),
          required: false,
        });
        if (p.isCancel(plugAns)) return void p.cancel(tc(lang).common.aborted);
        selectedPlugins = new Set(plugAns as string[]);
      }

      const permAns = await p.confirm({ message: tg.initPermsPrompt, initialValue: permissions });
      if (p.isCancel(permAns)) return void p.cancel(tc(lang).common.aborted);
      permissions = permAns;
    } else {
      // Recommended defaults: es unless already en, every global-capable plugin,
      // permissions on. A first-time recommended run enables the identity plugins.
      if (!existing) selectedPlugins = new Set(globalPlugins);
    }

    const config: GlobalConfig = {
      language,
      engines: existing?.engines ?? ["claude"],
      plugins: Object.fromEntries(globalPlugins.map((id) => [id, { enabled: selectedPlugins.has(id) }])),
      permissions,
    };

    const target = globalTarget();
    const apply = Boolean(args.apply);
    if (apply) {
      writeGlobalConfig(config);
      p.log.success(tg.wroteConfig(globalConfigPath()));
    }
    if (existsSync(target.claudeMd)) p.log.info(tg.coexistNote);

    const { result } = runGlobalRender(config, { dryRun: !apply });
    reportRender(target, result, !apply, lang, globalPermissionsEnabled(config));
    p.outro(apply ? color.green(tc(lang).global.doneWord) : color.yellow(`${tg.previewWord} · ${tg.previewHint}`));
  },
});

const renderSubCommand = defineCommand({
  meta: { name: "render", description: "Render the global harness into ~/.claude (preview unless --apply)" },
  args: { apply: { type: "boolean", description: "Write changes to disk" } },
  run({ args }) {
    const { config, lang } = loadOrExit();
    const tg = tc(lang).global;
    p.intro(brand("global render"));
    const apply = Boolean(args.apply);
    const { target, result } = runGlobalRender(config, { dryRun: !apply });
    reportRender(target, result, !apply, lang, globalPermissionsEnabled(config));
    p.outro(apply ? color.green(tg.doneWord) : color.yellow(`${tg.previewWord} · ${tg.previewHint}`));
  },
});

const syncSubCommand = defineCommand({
  meta: { name: "sync", description: "Apply pending global harness updates to ~/.claude" },
  args: { apply: { type: "boolean", description: "Write changes to disk (default previews)" } },
  run({ args }) {
    const { config, lang } = loadOrExit();
    const tg = tc(lang).global;
    p.intro(brand("global sync"));
    const apply = Boolean(args.apply);
    const { target, result } = runGlobalRender(config, { dryRun: !apply });
    reportRender(target, result, !apply, lang, globalPermissionsEnabled(config));
    p.outro(apply ? color.green(tg.doneWord) : color.yellow(`${tg.previewWord} · ${tg.previewHint}`));
  },
});

const doctorSubCommand = defineCommand({
  meta: { name: "doctor", description: "Inspect the global harness: drift, scope violations, non-global plugins" },
  args: { json: { type: "boolean", description: "Output as JSON" } },
  run({ args }) {
    const config = readGlobalConfigSafe();
    const lang = resolveLang(config?.language);
    const tg = tc(lang).global;
    if (!config) {
      if (args.json) console.log(JSON.stringify({ ok: false, error: "global-config-missing" }));
      else {
        p.intro(brand("global doctor"));
        p.cancel(tg.noConfig(globalConfigPath()));
      }
      process.exit(1);
    }
    const target = globalTarget();
    const navoriConfig = globalConfigToNavoriConfig(config);
    const drifts = scanManagedDrift(target.baseDir, navoriConfig);
    const nonGlobalPlugins = validateGlobalPlugins(config);
    // Scope violation: a repo-only managed block present in the global CLAUDE.md.
    const violations = repoBlocksInGlobal(target.claudeMd);

    if (args.json) {
      console.log(JSON.stringify({ ok: nonGlobalPlugins.length === 0, drifts, nonGlobalPlugins, violations }, null, 2));
      if (nonGlobalPlugins.length > 0) process.exit(2);
      return;
    }

    p.intro(brand("global doctor"));
    p.note(
      kv([
        ["config", dim(globalConfigPath())],
        ["target", dim(target.claudeMd)],
        ["language", config.language],
        ["engines", config.engines.join(", ")],
        ["permissions", globalPermissionsEnabled(config) ? "on" : "off"],
      ]),
      tg.doctorConfigTitle,
    );
    p.note(`  ${check(existsSync(target.claudeMd))} ${target.claudeMd}`, tg.doctorTargetTitle);

    if (drifts.length > 0) {
      const lines = drifts.map((d) => `  ${color.yellow(sym.update)} ${accent(`${d.filePath}:${d.markerId}`)}`);
      p.log.warn(tg.doctorDrift(drifts.length, lines.join("\n")));
    }
    if (nonGlobalPlugins.length > 0) {
      const lines = nonGlobalPlugins.map((m) => `  ${color.red(sym.fail)} ${accent(m.id)}  ${dim(m.reason)}`);
      p.log.error(tg.doctorNonGlobalPlugins(nonGlobalPlugins.length, lines.join("\n")));
    }
    if (violations.length > 0) {
      const lines = violations.map((id) => `  ${color.red(sym.fail)} ${accent(id)}`);
      p.log.warn(tg.doctorScopeViolations(violations.length, lines.join("\n")));
    }

    p.outro(nonGlobalPlugins.length > 0 ? color.red(tg.doctorIssues) : color.green(tg.doctorOk));
    if (nonGlobalPlugins.length > 0) process.exit(2);
  },
});

const statusSubCommand = defineCommand({
  meta: { name: "status", description: "One-line global harness status" },
  args: { json: { type: "boolean", description: "Output as JSON" } },
  run({ args }) {
    const config = readGlobalConfigSafe();
    const lang = resolveLang(config?.language);
    const tg = tc(lang).global;
    if (!config) {
      if (args.json) console.log(JSON.stringify({ configured: false }));
      else {
        p.intro(brand("global status"));
        p.log.info(tg.noConfig(globalConfigPath()));
        p.outro(dim(globalConfigPath()));
      }
      return;
    }
    const target = globalTarget();
    const navoriConfig = globalConfigToNavoriConfig(config);
    const drifts = scanManagedDrift(target.baseDir, navoriConfig);
    if (args.json) {
      console.log(JSON.stringify({ configured: true, target: target.claudeMd, drift: drifts.length }));
      return;
    }
    p.intro(brand("global status"));
    p.log.message(drifts.length === 0 ? color.green(tg.statusOk) : color.yellow(tg.statusDrift(drifts.length)));
    p.outro(dim(target.claudeMd));
  },
});

// ─────────────────────────── helpers ───────────────────────────

function readGlobalConfigSafe(): GlobalConfig | null {
  try {
    return readGlobalConfig();
  } catch (err) {
    if (err instanceof GlobalConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

function loadOrExit(): { config: GlobalConfig; lang: Lang } {
  const config = readGlobalConfigSafe();
  if (!config) {
    process.stderr.write(`${tc(DEFAULT_LANG).global.noConfig(globalConfigPath())}\n`);
    process.exit(1);
  }
  return { config, lang: resolveLang(config.language) };
}

/** Managed-block ids present in the global CLAUDE.md that belong to the repo
 * scope — a scope violation the doctor surfaces (spec 0005 §2.4). The repo-only
 * set is DERIVED from CORE_MANAGED_ASSETS (same as doctor.ts `scanCrossScope`)
 * rather than hardcoded, so the two doctor surfaces can never drift apart when a
 * block's scope changes or a new repo-scope asset is added. */
export function repoBlocksInGlobal(claudeMdPath: string): string[] {
  const ids = new Set(listMarkers(claudeMdPath).map((m) => m.id));
  const repoOnly = CORE_MANAGED_ASSETS.filter((a) => (a.scope ?? "repo") === "repo").map((a) => a.id);
  return repoOnly.filter((id) => ids.has(id));
}

function reportRender(
  target: RenderTarget,
  result: ClaudeEngineResult,
  preview: boolean,
  lang: Lang,
  settingsManaged = false,
): void {
  const tg = tc(lang).global;
  const lines: string[] = [target.claudeMd];
  for (const e of result.claudeMdEntries) {
    // Skip blocks the scope filter stripped/left absent (repo-only ids): they
    // report `unchanged` with no content, which reads as noise at global scope.
    if (e.newContent === null && e.status === "unchanged") continue;
    lines.push(`  ${color.cyan(sym.bullet)} ${e.asset.id}  ${dim(`(${e.status})`)}`);
  }
  for (const w of result.written) {
    lines.push(`  ${color.green(sym.ok)} ${w.path}  ${dim(`(${w.status})`)}`);
  }
  if (result.written.length === 0) lines.push(`  ${dim(tg.upToDate)}`);
  p.log.message(lines.join("\n"));
  if (result.backupPath) p.log.message(`${dim(tc(lang).common.backupLabel)} ${result.backupPath}`);
  // Disclose the settings.json ownership boundary: once navori manages the
  // permissions allowlist, later hand edits are regenerated over, not merged.
  if (settingsManaged) p.log.info(dim(tg.settingsManagedNote));
}

export const globalCommand = defineCommand({
  meta: { name: "global", description: "Manage the global (persona) harness in ~/.claude (spec 0005)" },
  subCommands: {
    init: initSubCommand,
    render: renderSubCommand,
    sync: syncSubCommand,
    doctor: doctorSubCommand,
    status: statusSubCommand,
  },
});
