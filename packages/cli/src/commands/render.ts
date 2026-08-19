import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { readConfig, ConfigError, type NavoriConfig } from "../lib/config.ts";
import { scanOrphanedEngineOutputs, type OrphanedEngineOutput } from "../lib/health.ts";
import { createBackup, purgeOldBackups } from "../lib/backup.ts";
import type { AssetPlanEntry, UpdateAvailable } from "../lib/render-plan.ts";
import { renderClaudeEngine, type ClaudeEngineResult } from "../engines/claude/index.ts";
import { renderAgentsMdEngine } from "../engines/agents-md/index.ts";
import { renderCursorEngine } from "../engines/cursor/index.ts";
import { renderCopilotEngine } from "../engines/copilot/index.ts";
import { renderCodexEngine } from "../engines/codex/index.ts";
import type { ProseEngineResult } from "../engines/shared/prose-harness.ts";
import type { SkippedFile } from "../engines/shared/execute-plan.ts";
import {
  renderGitignore,
  type GitignoreRenderResult,
} from "../engines/shared/gitignore-harness.ts";
import {
  renderStatusSymbol,
  renderStatusLabel,
  dim,
  color,
  accent,
  brand,
  sym,
  type RenderStatus,
} from "../lib/style.ts";
import { tc, resolveLang, DEFAULT_LANG, type Lang } from "../lib/i18n.ts";
import { effectiveConfigForWorkspace, buildMonorepoContext } from "../lib/monorepo.ts";
import { benchStart, benchMark, benchReport } from "../lib/bench.ts";
import { listRegistryRepos, pruneRegistry, registryPath } from "../lib/registry.ts";

export interface WorkspaceRenderResult {
  /** Workspace path relative to the repo root (e.g. "apps/backend"). */
  workspacePath: string;
  /** Workspace display name from monorepo.workspaces[].name. */
  workspaceName: string;
  filePath: string;
  entries: AssetPlanEntry[];
  written: boolean;
  languageFallbacks: string[];
  updatesAvailable: UpdateAvailable[];
  /** Managed blocks preserved because a newer navori wrote them (#79). */
  downgrades: UpdateAvailable[];
  backupPath?: string | null;
  /** Claude engine result; absent when "claude" is not in config.engines[]. */
  engineResult?: ClaudeEngineResult;
  /** Non-Claude engines rendered into this workspace (e.g. AGENTS.md). #77. */
  extraEngines: EngineRenderSummary[];
}

/**
 * Per-engine summary for non-Claude engines declared in `config.engines[]`.
 * The Claude engine keeps its rich reporting (entries, workspaces); the others
 * report a flat file list. Engines with no adapter yet surface a warning so the
 * declaration is never silently ignored.
 */
export interface EngineRenderSummary {
  engine: string;
  written: Array<{ path: string; status: RenderStatus }>;
  skipped: SkippedFile[];
  warnings: string[];
  backupPath: string | null;
}

/**
 * Dispatch the non-Claude engines declared in config.engines[] against `cwd`
 * (the repo root or a workspace dir; `repoRoot` resolves shared assets like
 * local presets). `warnMissingAdapters: false` silences the "no adapter yet"
 * entries for per-workspace runs — the root run already warned once.
 */
export function renderNonClaudeEngines(
  cwd: string,
  config: NavoriConfig,
  engines: readonly string[],
  dryRun: boolean,
  options: { repoRoot?: string; warnMissingAdapters?: boolean; lang?: Lang } = {},
): EngineRenderSummary[] {
  const repoRoot = options.repoRoot ?? cwd;
  const warnMissingAdapters = options.warnMissingAdapters ?? true;
  const lang = options.lang ?? resolveLang(config.language);
  // Prose engines that share the AGENTS.md rendering path (same body, different
  // destination/format). Keyed by config engine id.
  const PROSE_ENGINES: Record<
    string,
    (
      cwd: string,
      config: NavoriConfig,
      opts: { dryRun: boolean; repoRoot: string },
    ) => ProseEngineResult
  > = {
    "agents-md": (c, cfg, o) => renderAgentsMdEngine(c, cfg, o),
    cursor: (c, cfg, o) => renderCursorEngine(c, cfg, o),
    copilot: (c, cfg, o) => renderCopilotEngine(c, cfg, o),
    codex: (c, cfg, o) => renderCodexEngine(c, cfg, o),
  };

  const out: EngineRenderSummary[] = [];
  for (const eng of engines) {
    if (eng === "claude") continue;
    if (eng === "agents-md" && engines.includes("codex")) {
      out.push({
        engine: eng,
        written: [],
        skipped: [],
        warnings: [tc(lang).engine.agentsMdRedundantWithCodex],
        backupPath: null,
      });
      continue;
    }
    const render = PROSE_ENGINES[eng];
    if (render) {
      const r = render(cwd, config, { dryRun, repoRoot });
      out.push({ engine: eng, ...r });
    } else if (warnMissingAdapters) {
      // An engine declared in config but with no adapter yet — warn, never ignore.
      out.push({
        engine: eng,
        written: [],
        skipped: [],
        warnings: [tc(lang).render.adapterMissing(eng)],
        backupPath: null,
      });
    }
  }
  return out;
}

export interface RunRenderOptions {
  dryRun?: boolean;
  force?: boolean;
  /**
   * When set, skip the root render and only render the workspace whose name
   * matches. Returns `ok: false` with a clear reason if no monorepo is
   * declared or no workspace by that name exists. Spec 0001 fase 4.
   */
  workspaceFilter?: string | null;
  /**
   * Delete outputs owned only by engines no longer in `config.engines[]`
   * (orphaned `AGENTS.md`, `.codex/`, …) after rendering the enabled engines.
   * Only deletes when combined with a non-preview (apply) run; in preview it's a
   * no-op (the orphans are still reported, never touched). #312.
   */
  prune?: boolean;
}

/**
 * Run the render flow against `cwd`. Reusable from other commands (e.g. init).
 * The top-level fields always describe the repo root render so existing callers
 * (init.ts) keep working unchanged. When `config.monorepo.workspaces[]` is
 * non-empty, each workspace is also rendered and reported under `workspaces`.
 *
 * With `workspaceFilter`, only that workspace is rendered — root is skipped,
 * `engineResult` is undefined, and the top-level fields are empty stubs,
 * except `extraEngines`, which carries the workspace's non-Claude engines
 * (there is no root render to conflict with, #77). This is the "iterate one
 * app" path for monorepos.
 */
export function runRender(
  cwd: string,
  dryRunOrOptions: boolean | RunRenderOptions = false,
  force = false,
): {
  ok: boolean;
  /** Human-readable, LOCALIZED failure reason for terminal output. */
  reason?: string;
  /** Stable machine-readable failure code (kebab-case, never localized) for
   * `--json` consumers. Pairs with `reason` (the localized detail). */
  reasonCode?: string;
  /** Resolved output locale (config.language), so callers localize messages
   * without re-reading the config. Defaults to DEFAULT_LANG on error paths. */
  language: Lang;
  filePath: string;
  entries: AssetPlanEntry[];
  written: boolean;
  languageFallbacks: string[];
  updatesAvailable: UpdateAvailable[];
  /** Root managed blocks preserved because a newer navori wrote them (#79). */
  downgrades: UpdateAvailable[];
  backupPath?: string | null;
  engineResult?: ClaudeEngineResult;
  workspaces: WorkspaceRenderResult[];
  /** Declared workspaces whose directory no longer exists on disk (#70). */
  orphanedWorkspaces?: string[];
  /** Non-Claude engines (agents-md, plus warnings for cursor/copilot). */
  extraEngines?: EngineRenderSummary[];
  /** Outputs owned only by engines no longer in config.engines[] (#312). */
  orphanedEngineOutputs?: OrphanedEngineOutput[];
  /** Orphaned-output paths deleted this run (only with --prune + --apply). */
  prunedEngineOutputs?: string[];
  /** Harness `.gitignore` block reconciliation (#313). Absent when
   *  `gitignoreHarness` is `"off"` — navori doesn't touch `.gitignore` then. */
  gitignore?: GitignoreRenderResult | null;
} {
  // Back-compat: callers passing (cwd, dryRun, force) keep working.
  const opts: RunRenderOptions =
    typeof dryRunOrOptions === "boolean" ? { dryRun: dryRunOrOptions, force } : dryRunOrOptions;
  const dryRun = Boolean(opts.dryRun);
  const forceFlag = Boolean(opts.force);
  const pruneFlag = Boolean(opts.prune);
  const workspaceFilter = opts.workspaceFilter ?? null;

  const configPath = `${cwd}/navori.config.json`;
  const claudeMdPath = `${cwd}/CLAUDE.md`;

  if (!existsSync(configPath)) {
    return {
      ok: false,
      reason: `No navori.config.json at ${configPath}`,
      reasonCode: "config-missing",
      language: DEFAULT_LANG,
      filePath: claudeMdPath,
      entries: [],
      written: false,
      languageFallbacks: [],
      updatesAvailable: [],
      downgrades: [],
      backupPath: null,
      workspaces: [],
    };
  }

  // A broken config is a per-repo failure, not a process-level one: `render
  // --all` and `workspace render` loop over repos and expect `ok:false` back so
  // one corrupt repo can't abort the batch. Exiting here (the old
  // `readConfigOrExit`) killed the whole run — `process.exit` doesn't throw, so
  // the caller's try/catch never saw it (#340). Same shape as `config-missing`
  // above; single-repo `render` still exits 1 via its own `!result.ok` branch.
  let config: NavoriConfig;
  try {
    config = readConfig(configPath);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    const detail = (err.issues ?? [])
      .map((issue) => `\n  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("");
    return {
      ok: false,
      reason: `${err.message}${detail}`,
      reasonCode: "config-invalid",
      language: DEFAULT_LANG,
      filePath: claudeMdPath,
      entries: [],
      written: false,
      languageFallbacks: [],
      updatesAvailable: [],
      downgrades: [],
      backupPath: null,
      workspaces: [],
    };
  }
  const lang = resolveLang(config.language);
  benchMark("loadConfig");

  // Engine dispatch: render Claude only when it's a declared engine (the
  // default). Before this, render hardcoded Claude and silently ignored any
  // other engines[]. Now non-Claude engines are dispatched too — at the root
  // AND per workspace (#77).
  const engines: readonly string[] = config.engines ?? ["claude"];
  const renderClaude = engines.includes("claude");

  // --workspace filter path: skip root, render only the matching workspace.
  if (workspaceFilter) {
    const declared = config.monorepo?.workspaces ?? [];
    if (declared.length === 0) {
      return {
        ok: false,
        reason: tc(lang).sync.workspaceRequiresMonorepo,
        reasonCode: "workspace-requires-monorepo",
        language: lang,
        filePath: claudeMdPath,
        entries: [],
        written: false,
        languageFallbacks: [],
        updatesAvailable: [],
        downgrades: [],
        backupPath: null,
        workspaces: [],
      };
    }
    const match = declared.find((w) => w.name === workspaceFilter);
    if (!match) {
      const known = declared.map((w) => w.name).join(", ");
      return {
        ok: false,
        reason: tc(lang).sync.workspaceNotFound(workspaceFilter, known),
        reasonCode: "workspace-not-found",
        language: lang,
        filePath: claudeMdPath,
        entries: [],
        written: false,
        languageFallbacks: [],
        updatesAvailable: [],
        downgrades: [],
        backupPath: null,
        workspaces: [],
      };
    }
    const wsCwd = resolve(cwd, match.path);
    const wsConfig = effectiveConfigForWorkspace(config, match);
    const wsResult = renderClaude
      ? renderClaudeEngine(wsCwd, wsConfig, {
          dryRun,
          force: forceFlag,
          repoRoot: cwd,
          monorepoContext: buildMonorepoContext(config, match),
        })
      : undefined;
    // #77: --workspace must also render the non-Claude engines for that
    // workspace. There is no root render here, so the summaries land in the
    // top-level `extraEngines` (same field the normal path uses for the root)
    // and adapter-missing warnings stay on.
    const wsExtraEngines = renderNonClaudeEngines(wsCwd, wsConfig, engines, dryRun, {
      repoRoot: cwd,
      lang,
    });
    return {
      ok: true,
      language: lang,
      filePath: claudeMdPath,
      entries: [],
      written: false,
      languageFallbacks: [],
      updatesAvailable: [],
      downgrades: [],
      backupPath: null,
      engineResult: undefined,
      workspaces: [
        {
          workspacePath: match.path,
          workspaceName: match.name,
          filePath: `${wsCwd}/CLAUDE.md`,
          entries: wsResult?.claudeMdEntries ?? [],
          written: (wsResult?.written.length ?? 0) > 0,
          languageFallbacks: wsResult?.languageFallbacks ?? [],
          updatesAvailable: wsResult?.updatesAvailable ?? [],
          downgrades: wsResult?.downgrades ?? [],
          backupPath: wsResult?.backupPath ?? null,
          engineResult: wsResult,
          extraEngines: [],
        },
      ],
      extraEngines: wsExtraEngines,
    };
  }

  const engineResult = renderClaude
    ? renderClaudeEngine(cwd, config, { dryRun, force: forceFlag })
    : undefined;

  const workspaces: WorkspaceRenderResult[] = [];
  const orphanedWorkspaces: string[] = [];
  for (const ws of config.monorepo?.workspaces ?? []) {
    const wsCwd = resolve(cwd, ws.path);
    // #70: a workspace deleted from disk (or removed from the workspace glob)
    // but still declared in config must NOT be resurrected — renderClaudeEngine
    // would mkdir it and write a full .claude/ tree into a dir that shouldn't
    // exist. Skip + surface it so the user prunes config (mirrors the guard in
    // the cross-repo workspace render).
    if (!existsSync(wsCwd)) {
      orphanedWorkspaces.push(ws.path);
      continue;
    }
    const wsConfig = effectiveConfigForWorkspace(config, ws);
    const wsResult = renderClaude
      ? renderClaudeEngine(wsCwd, wsConfig, {
          dryRun,
          force: forceFlag,
          repoRoot: cwd,
          monorepoContext: buildMonorepoContext(config, ws),
        })
      : undefined;
    // #77: non-Claude engines (AGENTS.md) render per workspace too. The root
    // call below already warns once about adapterless engines (cursor/copilot),
    // so those warnings are muted here.
    const wsExtraEngines = renderNonClaudeEngines(wsCwd, wsConfig, engines, dryRun, {
      repoRoot: cwd,
      warnMissingAdapters: false,
      lang,
    });
    workspaces.push({
      workspacePath: ws.path,
      workspaceName: ws.name,
      filePath: `${wsCwd}/CLAUDE.md`,
      entries: wsResult?.claudeMdEntries ?? [],
      written: (wsResult?.written.length ?? 0) > 0,
      languageFallbacks: wsResult?.languageFallbacks ?? [],
      updatesAvailable: wsResult?.updatesAvailable ?? [],
      downgrades: wsResult?.downgrades ?? [],
      backupPath: wsResult?.backupPath ?? null,
      engineResult: wsResult,
      extraEngines: wsExtraEngines,
    });
  }

  const extraEngines = renderNonClaudeEngines(cwd, config, engines, dryRun, { lang });

  // #313: reconcile the harness `.gitignore` once at the repo root (it's a
  // repo-level file, not per-engine). Returns null in mode "off" (untouched).
  const gitignore = renderGitignore(cwd, config, { dryRun, force: forceFlag, lang });

  // #312: outputs owned only by engines no longer in config.engines[] (a stale
  // AGENTS.md/.codex after narrowing to claude) linger because render never
  // revisits a disabled engine. Report them always; with --prune on an apply
  // run, back them up and delete them.
  const orphanedEngineOutputs = scanOrphanedEngineOutputs(cwd, config);
  let prunedEngineOutputs: string[] | undefined;
  if (pruneFlag && !dryRun && orphanedEngineOutputs.length > 0) {
    const paths = orphanedEngineOutputs.flatMap((o) => o.paths);
    // Back up before deleting so a mistaken prune is recoverable (same safety
    // net the prose engine uses for overwrites).
    const handle = createBackup(cwd, paths);
    if (handle.files.length > 0) purgeOldBackups();
    for (const rel of paths) rmSync(resolve(cwd, rel), { recursive: true, force: true });
    prunedEngineOutputs = paths;
  }

  return {
    ok: true,
    language: lang,
    filePath: claudeMdPath,
    entries: engineResult?.claudeMdEntries ?? [],
    written: (engineResult?.written.length ?? 0) > 0,
    languageFallbacks: engineResult?.languageFallbacks ?? [],
    updatesAvailable: engineResult?.updatesAvailable ?? [],
    downgrades: engineResult?.downgrades ?? [],
    backupPath: engineResult?.backupPath ?? null,
    engineResult,
    workspaces,
    orphanedWorkspaces,
    extraEngines,
    orphanedEngineOutputs,
    prunedEngineOutputs,
    gitignore,
  };
}

export const renderCommand = defineCommand({
  meta: {
    name: "render",
    description: "Render every configured engine from navori.config.json",
  },
  args: {
    cwd: { type: "string", description: "Directory to render into (default: cwd)" },
    apply: {
      type: "boolean",
      description: "Write changes to disk. Without it, render only previews (no files touched).",
    },
    "dry-run": {
      type: "boolean",
      description:
        "Deprecated: preview is the default now. Kept as an explicit alias for --no-apply.",
    },
    force: {
      type: "boolean",
      description:
        "Regenerate settings.json even if corrupted or missing the $navori marker. The previous file is backed up.",
    },
    workspace: {
      type: "string",
      description:
        "Render only one workspace by name (skips root). Requires a monorepo config with declared workspaces.",
    },
    json: {
      type: "boolean",
      description:
        "Emit a machine-readable JSON result and suppress human output (for CI/automation).",
    },
    all: {
      type: "boolean",
      description:
        "Render EVERY repo in the global registry (~/.navori/registry.json), not just the current one. Use after a navori bump to roll changes into all your projects at once.",
    },
    prune: {
      type: "boolean",
      description:
        "With --all: drop registry entries whose repo no longer exists before rendering. " +
        "In a single repo (with --apply): delete outputs left by engines no longer in config.engines (orphaned AGENTS.md/.codex/…), backing them up first.",
    },
    verbose: {
      type: "boolean",
      description: "With --all: list each changed managed block per repo, not just the counts.",
    },
  },
  async run({ args }) {
    benchStart();
    const cwd = resolve(args.cwd ?? process.cwd());
    const json = Boolean(args.json);

    if (args.all) {
      renderAllRepos({
        preview: !args.apply || Boolean(args["dry-run"]),
        force: Boolean(args.force),
        prune: Boolean(args.prune),
        verbose: Boolean(args.verbose),
        json,
      });
      return;
    }

    if (!json) p.intro(brand("render"));

    // Preview-default (spec 0003 §3.1.3, breaking change v0.1→v0.2): render
    // never touches disk unless --apply is passed. --dry-run is kept as a
    // back-compat alias; when combined with --apply, preview wins (safer).
    const apply = Boolean(args.apply);
    const preview = !apply || Boolean(args["dry-run"]);
    const workspaceFilter = (args.workspace as string | undefined) ?? null;

    if (!existsSync(cwd)) {
      if (json) {
        console.log(
          JSON.stringify({ command: "render", ok: false, reason: "directory-missing", cwd }),
        );
      } else {
        p.cancel(tc(DEFAULT_LANG).common.dirNotFound(cwd));
      }
      process.exit(1);
    }

    const result = runRender(cwd, {
      dryRun: preview,
      force: Boolean(args.force),
      workspaceFilter,
      prune: Boolean(args.prune),
    });
    const tr = tc(result.language).render;

    if (!result.ok) {
      if (json) {
        // `reason` is a STABLE English code for CI; `detail` carries the
        // localized human text (non-stable, locale-dependent).
        console.log(
          JSON.stringify({
            command: "render",
            ok: false,
            reason: result.reasonCode ?? "render-failed",
            detail: result.reason ?? tr.renderFailed,
          }),
        );
      } else {
        // Workspace errors are user-recoverable (typo in name, no monorepo yet);
        // 'navori init' is not always the right fix, so emit the raw reason.
        p.cancel(result.reason ?? tr.renderFailed);
      }
      process.exit(1);
    }

    // --json: structured result, no human output. Keys are stable English and
    // bypass i18n on purpose — this is machine-readable output for CI.
    if (json) {
      console.log(JSON.stringify(buildRenderJson(result, preview), null, 2));
      benchReport();
      return;
    }

    const hasWorkspaces = result.workspaces.length > 0;
    if (hasWorkspaces && result.engineResult) {
      p.log.message(`${dim(tr.rootLabel)}`);
    }
    if (result.engineResult) {
      reportClaudeMd(result.filePath, result.entries, result.written, preview, result.language);
      reportEngineFiles(result.engineResult, result.language);
    }
    if (result.languageFallbacks.length > 0) {
      p.log.warn(tr.langFallback(result.languageFallbacks.join(", ")));
    }
    if (result.backupPath) {
      p.log.message(`${dim(tc(result.language).common.backupLabel)} ${result.backupPath}`);
    }

    for (const ws of result.workspaces) {
      p.log.message(
        `${dim(tr.workspaceLabel)} ${color.cyan(ws.workspaceName)} ${dim(`(${ws.workspacePath})`)}`,
      );
      if (ws.engineResult) {
        reportClaudeMd(ws.filePath, ws.entries, ws.written, preview, result.language);
        reportEngineFiles(ws.engineResult, result.language);
      }
      reportExtraEngines(ws.extraEngines, result.language);
      if (ws.languageFallbacks.length > 0) {
        p.log.warn(tr.langFallbackWs(ws.workspaceName, ws.languageFallbacks.join(", ")));
      }
      if (ws.backupPath) {
        p.log.message(`${dim(tc(result.language).common.backupLabel)} ${ws.backupPath}`);
      }
    }

    if (result.orphanedWorkspaces && result.orphanedWorkspaces.length > 0) {
      p.log.warn(
        tr.orphanedWorkspaces(
          result.orphanedWorkspaces.length,
          result.orphanedWorkspaces.map((w) => `  ${color.yellow(sym.update)} ${w}`).join("\n"),
        ),
      );
    }

    reportExtraEngines(result.extraEngines ?? [], result.language);

    if (result.gitignore) reportGitignore(result.gitignore, result.language);

    // #312: orphaned outputs from disabled engines. If pruned this run, confirm
    // what was deleted; otherwise warn (and point at --prune) without touching.
    if (result.prunedEngineOutputs && result.prunedEngineOutputs.length > 0) {
      p.log.info(
        tr.prunedEngineOutputs(
          result.prunedEngineOutputs.length,
          result.prunedEngineOutputs.map((path) => `  ${color.green(sym.ok)} ${path}`).join("\n"),
        ),
      );
    } else if (result.orphanedEngineOutputs && result.orphanedEngineOutputs.length > 0) {
      const lines = result.orphanedEngineOutputs
        .flatMap((o) =>
          o.paths.map((path) => `  ${color.yellow(sym.update)} ${path} ${dim(`(${o.engine})`)}`),
        )
        .join("\n");
      const count = result.orphanedEngineOutputs.reduce((n, o) => n + o.paths.length, 0);
      p.log.warn(tr.orphanedEngineOutputs(count, lines));
    }

    const allDowngrades = result.downgrades.concat(...result.workspaces.map((w) => w.downgrades));
    const downgradeWarn = formatDowngradeWarning(allDowngrades, result.language);
    if (downgradeWarn) p.log.warn(downgradeWarn);

    const allEntries = result.entries.concat(...result.workspaces.map((w) => w.entries));
    // In preview mode `written` means "would write" — the engine populates it
    // with pending changes without touching disk.
    const anyPending = resultHasPendingWrites(result);
    const summary = summarize(allEntries);
    if (preview) {
      if (anyPending) {
        p.outro(`${color.yellow(tr.previewWord)} ${summary} ${dim(`· ${tr.previewHint}`)}`);
      } else {
        p.outro(`${dim(tr.upToDate)} ${summary} ${dim(`· ${tr.upToDateHint}`)}`);
      }
    } else if (anyPending) {
      p.outro(`${color.green(tr.doneWord)} ${summary}`);
    } else {
      p.outro(`${dim(tr.upToDate)} ${summary}`);
    }

    benchReport();
  },
});

/**
 * True when a render result has ANY pending (or, when applying, written) change:
 * the Claude CLAUDE.md at the root or a workspace, OR a non-Claude engine file
 * (`AGENTS.md`, cursor/copilot/codex) at the root or a workspace. All three
 * render summaries — single-repo, `buildRenderJson`, and the multi-repo
 * `renderRepoRows` — must agree, so they share this one predicate. Leaving
 * `extraEngines` out of any of them makes a repo whose only pending change is a
 * non-Claude file read as "up-to-date" and drop out of the roll-up (#276).
 */
export function resultHasPendingWrites(result: ReturnType<typeof runRender>): boolean {
  return (
    result.written ||
    result.workspaces.some((w) => w.written) ||
    (result.extraEngines ?? []).some((e) => e.written.length > 0) ||
    result.workspaces.some((w) => w.extraEngines.some((e) => e.written.length > 0)) ||
    result.gitignore?.status === "created" ||
    result.gitignore?.status === "updated"
  );
}

/**
 * Machine-readable render result. Keys are stable English (never localized) so
 * CI/automation can parse the same shape regardless of `config.language`.
 * Status tokens come straight from the render plan (created/updated/…).
 */
function buildRenderJson(result: ReturnType<typeof runRender>, preview: boolean) {
  const entryJson = (e: AssetPlanEntry) => ({ id: e.asset.id, status: e.status });
  const engineJson = (ee: EngineRenderSummary) => ({
    engine: ee.engine,
    written: ee.written.map((w) => ({ path: w.path, status: w.status })),
    skipped: ee.skipped.map((s) => ({ path: s.path, reason: s.reason })),
    warnings: ee.warnings,
    backupPath: ee.backupPath,
  });
  const allEntries = result.entries.concat(...result.workspaces.map((w) => w.entries));
  const pending = resultHasPendingWrites(result);
  const downgrades = result.downgrades
    .concat(...result.workspaces.map((w) => w.downgrades))
    .map((d) => ({ id: d.id, fromVersion: d.fromVersion, toVersion: d.toVersion }));
  return {
    command: "render",
    ok: true,
    mode: preview ? "preview" : "apply",
    root: {
      filePath: result.filePath,
      changed: result.written,
      entries: result.entries.map(entryJson),
      languageFallbacks: result.languageFallbacks,
      backupPath: result.backupPath ?? null,
    },
    workspaces: result.workspaces.map((w) => ({
      name: w.workspaceName,
      path: w.workspacePath,
      filePath: w.filePath,
      changed: w.written,
      entries: w.entries.map(entryJson),
      languageFallbacks: w.languageFallbacks,
      backupPath: w.backupPath ?? null,
      extraEngines: w.extraEngines.map(engineJson),
    })),
    extraEngines: (result.extraEngines ?? []).map(engineJson),
    orphanedWorkspaces: result.orphanedWorkspaces ?? [],
    orphanedEngineOutputs: result.orphanedEngineOutputs ?? [],
    prunedEngineOutputs: result.prunedEngineOutputs ?? [],
    gitignore: result.gitignore
      ? { path: result.gitignore.path, status: result.gitignore.status }
      : null,
    downgrades,
    summary: countStatuses(allEntries),
    pending,
  };
}

/** Count render-plan entries by status for the --json summary object. */
function countStatuses(entries: AssetPlanEntry[]): Record<string, number> {
  return entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.status] = (acc[e.status] ?? 0) + 1;
    return acc;
  }, {});
}

/**
 * Build the anti-retroceso (#79) warning: one or more managed blocks on disk
 * were written by a NEWER navori and preserved as-is. Returns null when there's
 * nothing to warn about. Shared by `render` and `update` so the message and the
 * "upgrade your CLI" call to action stay consistent.
 */
export function formatDowngradeWarning(
  downgrades: UpdateAvailable[],
  lang: Lang = DEFAULT_LANG,
): string | null {
  if (downgrades.length === 0) return null;
  const newest = downgrades
    .map((d) => d.fromVersion)
    .sort()
    .at(-1);
  const ids = [...new Set(downgrades.map((d) => d.id))];
  const shown = ids.slice(0, 6).join(", ");
  const more = ids.length > 6 ? ` (+${ids.length - 6})` : "";
  return tc(lang).render.downgradeWarning({
    count: downgrades.length,
    newest: newest ?? "",
    ids: `${dim(shown)}${dim(more)}`,
  });
}

function summarize(entries: AssetPlanEntry[]): string {
  const counts = entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.status] = (acc[e.status] ?? 0) + 1;
    return acc;
  }, {});
  const parts: string[] = [];
  if (counts.created) parts.push(color.green(`${counts.created} created`));
  if (counts.updated) parts.push(color.yellow(`${counts.updated} updated`));
  if (counts["user-modified-skipped"])
    parts.push(color.red(`${counts["user-modified-skipped"]} conflict`));
  if (counts["downgrade-skipped"])
    parts.push(color.yellow(`${counts["downgrade-skipped"]} downgrade-skip`));
  if (counts["removed-condition-false"])
    parts.push(color.magenta(`${counts["removed-condition-false"]} removed`));
  if (counts.unchanged) parts.push(dim(`${counts.unchanged} unchanged`));
  return parts.length > 0 ? `${dim("—")} ${parts.join(dim(", "))}` : "";
}

function reportClaudeMd(
  file: string,
  entries: AssetPlanEntry[],
  changed: boolean,
  preview: boolean,
  lang: Lang,
): void {
  const tr = tc(lang).render;
  const lines: string[] = [file];
  for (const e of entries) {
    const sym = renderStatusSymbol(e.status);
    const label = renderStatusLabel(e.status);
    lines.push(`  ${sym} ${e.asset.id}  ${dim("(")}${label}${dim(")")}`);
  }
  if (preview) lines.push(`  ${dim(changed ? tr.wouldWrite : tr.noChangePreview)}`);
  else if (changed) lines.push(`  ${dim(tr.written)}`);
  else lines.push(`  ${dim(tr.noChanges)}`);
  p.log.message(lines.join("\n"));
}

/**
 * Report the harness `.gitignore` reconciliation (#313). One line with the same
 * status symbol/label the rest of the render uses; a hand-edited block surfaces
 * as a skip with its reason. Absent (null) when `gitignoreHarness` is `"off"`.
 * The outro conveys preview vs. apply, so no per-line "would write" here.
 */
function reportGitignore(gitignore: GitignoreRenderResult, lang: Lang): void {
  const tr = tc(lang).render;
  const lines: string[] = [tr.gitignoreTitle];
  if (gitignore.status === "user-modified-skipped" || gitignore.status === "downgrade-skipped") {
    lines.push(
      `  ${color.yellow("!")} ${gitignore.path}  ${dim("(")}${color.yellow("skipped")}${dim(")")}`,
    );
    if (gitignore.skippedReason) lines.push(`      ${dim(gitignore.skippedReason)}`);
  } else {
    lines.push(
      `  ${renderStatusSymbol(gitignore.status)} ${gitignore.path}  ${dim("(")}${renderStatusLabel(gitignore.status)}${dim(")")}`,
    );
  }
  p.log.message(lines.join("\n"));
}

/** Report the non-Claude engine summaries (root or one workspace). */
function reportExtraEngines(extraEngines: EngineRenderSummary[], lang: Lang): void {
  const common = tc(lang).common;
  const tr = tc(lang).render;
  for (const ee of extraEngines) {
    p.log.message(`${dim(tr.engineLabel)} ${color.cyan(ee.engine)}`);
    for (const w of ee.written) {
      p.log.message(
        `  ${renderStatusSymbol(w.status)} ${w.path}  ${dim("(")}${renderStatusLabel(w.status)}${dim(")")}`,
      );
    }
    for (const s of ee.skipped) p.log.warn(`  ${s.path}: ${s.reason}`);
    for (const warn of ee.warnings) p.log.warn(`  ${warn}`);
    if (ee.backupPath) p.log.message(`  ${dim(common.backupLabel)} ${ee.backupPath}`);
  }
}

function reportEngineFiles(engine: ClaudeEngineResult, lang: Lang): void {
  // CLAUDE.md is reported separately by reportClaudeMd; filter it out here.
  // Header used to say ".claude/" which was misleading — progress/ also lands
  // here. "Engine files" describes the union (settings, agents, skills, hooks,
  // progress).
  const written = engine.written.filter((w) => w.path !== "CLAUDE.md");
  const unchangedCount = Math.max(
    0,
    engine.inspected - engine.written.length - engine.skipped.length,
  );

  if (
    written.length === 0 &&
    engine.skipped.length === 0 &&
    engine.warnings.length === 0 &&
    unchangedCount === 0
  ) {
    return;
  }

  const lines: string[] = [tc(lang).render.engineFilesTitle];
  for (const w of written) {
    const sym = renderStatusSymbol(w.status);
    const label = renderStatusLabel(w.status);
    lines.push(`  ${sym} ${w.path}  ${dim("(")}${label}${dim(")")}`);
  }
  for (const s of engine.skipped) {
    lines.push(
      `  ${color.yellow("!")} ${s.path}  ${dim("(")}${color.yellow("skipped")}${dim(")")}`,
    );
    lines.push(`      ${dim(s.reason)}`);
  }
  if (unchangedCount > 0 && written.length === 0 && engine.skipped.length === 0) {
    // All inspected files were already up to date — give the user a positive
    // signal so they don't wonder whether the engine even ran.
    lines.push(`  ${dim(`· ${unchangedCount} unchanged`)}`);
  } else if (unchangedCount > 0) {
    lines.push(`  ${dim(`· (+${unchangedCount} unchanged)`)}`);
  }
  for (const w of engine.warnings) {
    lines.push(`  ${color.yellow("·")} ${dim(w)}`);
  }
  p.log.message(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Multi-repo render — shared by `workspace render <name>` and `render --all`.
// Both roll the render across a list of repos and print one status row each;
// keeping the loop and the report in one place avoids drift (and the jscpd
// duplication gate). `render --all` reads the global registry; `workspace
// render` reads one workspace's repos[].
// ---------------------------------------------------------------------------

export type RepoRenderStatus = "written" | "would-write" | "up-to-date" | "missing" | "error";

export interface RepoRenderRow {
  name: string;
  status: RepoRenderStatus;
  detail: string;
  /** Managed blocks the user hand-edited; render left them untouched. Surfaced
   * loudly because in a rollout these are exactly what needs attention. */
  conflicts: number;
  /** The individual entries that are not `unchanged` (created/updated/conflict/
   * removed), for the `--verbose` per-file listing. Empty for missing/error. */
  changed: Array<{ id: string; status: string }>;
  /** Engine advisories (root + every workspace, every engine), deduped. The
   * single-repo render prints these, but the batch used to drop them — and the
   * batch is exactly where they bite: a fleet rollout with a `project.libraries`
   * id gone from the registry (the socketio split, audit v0.5.1 A1) lost its
   * skill in 15 repos with zero signal. Empty for missing/error rows. */
  warnings: string[];
}

/** Compact per-repo counts for the multi-repo render table. */
export function summarizeRenderEntries(entries: Array<{ status: string }>): string {
  const counts = entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.status] = (acc[e.status] ?? 0) + 1;
    return acc;
  }, {});
  const parts: string[] = [];
  if (counts.created) parts.push(`${counts.created} created`);
  if (counts.updated) parts.push(`${counts.updated} updated`);
  if (counts["user-modified-skipped"]) parts.push(`${counts["user-modified-skipped"]} conflict`);
  if (counts["removed-condition-false"]) parts.push(`${counts["removed-condition-false"]} removed`);
  if (counts.unchanged) parts.push(`${counts.unchanged} unchanged`);
  return parts.join(", ");
}

/**
 * Run render across a list of repos and return one status row each. `missing`
 * marks a path that no longer exists on disk; `error` a repo whose render
 * failed — neither aborts the batch, so one broken repo can't block the rest.
 */
export function renderRepoRows(
  repos: Array<{ name: string; path: string }>,
  opts: { preview: boolean; force: boolean },
): RepoRenderRow[] {
  const rows: RepoRenderRow[] = [];
  for (const repo of repos) {
    if (!existsSync(repo.path)) {
      rows.push({
        name: repo.name,
        status: "missing",
        detail: repo.path,
        conflicts: 0,
        changed: [],
        warnings: [],
      });
      continue;
    }
    try {
      const result = runRender(repo.path, { dryRun: opts.preview, force: opts.force });
      if (!result.ok) {
        rows.push({
          name: repo.name,
          status: "error",
          // One row per repo: a schema failure's `reason` carries the per-field
          // detail on its own lines (#340), which would spill down the table and
          // break its alignment. Flattened here only — the single-repo path
          // keeps the multi-line message, where it reads better.
          detail: (result.reason ?? "render failed").replace(/\n\s*/g, "; "),
          conflicts: 0,
          changed: [],
          warnings: [],
        });
        continue;
      }
      const allEntries = result.entries.concat(...result.workspaces.map((w) => w.entries));
      // Engine-written files (.claude/ tree + AGENTS.md), root + every workspace.
      // These carry changes the CLAUDE.md block entries don't — a repo whose only
      // pending change is a hook/agent/skill/settings file would otherwise read as
      // "unchanged" next to a "would-write" status. Folded into the summary and the
      // --verbose list so the detail always explains the status.
      const engineFiles: Array<{ id: string; status: string }> = [];
      // Warnings ride the same walk as the files. Deduped (Set) because a
      // monorepo re-emits repo-level advisories once per workspace render — the
      // batch row needs each message once, not once per workspace.
      const engineWarnings = new Set<string>();
      const collectEngine = (eng?: {
        written: Array<{ path: string; status: string }>;
        warnings: string[];
      }): void => {
        for (const w of eng?.written ?? []) engineFiles.push({ id: w.path, status: w.status });
        for (const w of eng?.warnings ?? []) engineWarnings.add(w);
      };
      collectEngine(result.engineResult);
      for (const ee of result.extraEngines ?? []) collectEngine(ee);
      for (const ws of result.workspaces) {
        collectEngine(ws.engineResult);
        for (const ee of ws.extraEngines) collectEngine(ee);
      }
      const combined = allEntries
        .map((e) => ({ status: e.status }))
        .concat(engineFiles.map((f) => ({ status: f.status })));
      const anyPending = resultHasPendingWrites(result);
      const conflicts = combined.filter((e) => e.status === "user-modified-skipped").length;
      const changed = allEntries
        .filter((e) => e.status !== "unchanged")
        .map((e) => ({ id: e.asset.id, status: e.status }))
        .concat(engineFiles.filter((f) => f.status !== "unchanged"));
      const status: RepoRenderStatus = anyPending
        ? opts.preview
          ? "would-write"
          : "written"
        : "up-to-date";
      rows.push({
        name: repo.name,
        status,
        detail: summarizeRenderEntries(combined),
        conflicts,
        changed,
        warnings: [...engineWarnings],
      });
    } catch (err) {
      rows.push({
        name: repo.name,
        status: "error",
        detail: (err as Error).message,
        conflicts: 0,
        changed: [],
        warnings: [],
      });
    }
  }
  return rows;
}

/**
 * Roll up per-repo render rows into batch counts. Shared by the human table
 * (`reportRepoRenderRows`) and the `--json` path so the summary numbers can never
 * diverge between the two output modes.
 */
export function rollupRenderRows(rows: RepoRenderRow[]): {
  failed: number;
  pending: number;
  conflicts: number;
  warnings: number;
  ok: number;
} {
  const failed = rows.filter((r) => r.status === "error" || r.status === "missing").length;
  const pending = rows.filter((r) => r.status === "written" || r.status === "would-write").length;
  const conflicts = rows.reduce((n, r) => n + r.conflicts, 0);
  const warnings = rows.reduce((n, r) => n + r.warnings.length, 0);
  const ok = rows.length - failed;
  return { failed, pending, conflicts, warnings, ok };
}

/**
 * Print the multi-repo render table and return the roll-up counts. The table is
 * meant to read as a record of what happened for *anyone* running it — one line
 * per repo (marker · name · status · what changed), conflict and engine-warning
 * blocks naming the affected repos, and a roll-up that always shows the
 * conflict/warning/failed columns so a "0" is an explicit all-clear, not a
 * silent omission.
 */
export function reportRepoRenderRows(
  rows: RepoRenderRow[],
  preview: boolean,
  verbose = false,
): {
  failed: number;
  pending: number;
  ok: number;
  conflicts: number;
  warnings: number;
  summary: string;
} {
  const marker: Record<RepoRenderStatus, string> = {
    written: color.green(sym.ok),
    "would-write": color.yellow(sym.bullet),
    "up-to-date": dim(sym.bullet),
    missing: color.red(sym.fail),
    error: color.red(sym.fail),
  };
  const lines: string[] = [];
  for (const r of rows) {
    // A conflict outranks the write status in the marker — it's the row that
    // needs a human, even when the repo is otherwise up to date.
    const glyph = r.conflicts > 0 ? color.yellow(sym.conflict) : marker[r.status];
    const detail = r.detail ? dim(`  ${r.detail}`) : "";
    lines.push(`  ${glyph} ${accent(r.name)}  ${dim(r.status)}${detail}`);
    // --verbose: name each changed managed block under its repo, so the log is
    // a file-level record (not just counts) of what the rollout touched.
    if (verbose) {
      for (const e of r.changed) {
        lines.push(
          `      ${renderStatusSymbol(e.status)} ${dim(e.id)} ${dim(`(${renderStatusLabel(e.status)})`)}`,
        );
      }
    }
  }
  if (lines.length > 0) p.log.message(lines.join("\n"));

  const { failed, pending, conflicts, warnings, ok } = rollupRenderRows(rows);

  // Name the repos with conflicts so the record says exactly where to look; the
  // managed block was hand-edited and render refused to overwrite it.
  if (conflicts > 0) {
    const names = rows
      .filter((r) => r.conflicts > 0)
      .map((r) => r.name)
      .join(", ");
    p.log.warn(
      `${conflicts} hand-edited managed block(s) left untouched in: ${names}. ` +
        `Reconcile with 'navori sync' in that repo, or re-apply with '--force'.`,
    );
  }

  // Engine warnings, grouped by message with the affected repos named — the
  // same "say where to look" contract as the conflict block. Grouped because a
  // registry-wide advisory (e.g. a `project.libraries` id removed in this CLI
  // version) fires identically in every repo of a rollout: one line naming all
  // 15 repos is a signal; 15 near-identical lines are noise the operator skims
  // past. Each message already carries its own remedy (e.g. 'navori update').
  if (warnings > 0) {
    const byMessage = new Map<string, string[]>();
    for (const r of rows) {
      for (const w of r.warnings) byMessage.set(w, [...(byMessage.get(w) ?? []), r.name]);
    }
    for (const [message, names] of byMessage) {
      p.log.warn(`${message}\n${dim(`in: ${names.join(", ")}`)}`);
    }
  }

  const summary =
    `${ok}/${rows.length} ok · ${pending} ${preview ? "would change" : "changed"} · ` +
    `${conflicts} conflict · ${warnings} warning · ${failed} failed`;
  return { failed, pending, ok, conflicts, warnings, summary };
}

/**
 * `render --all`: render every repo in the global registry in one pass. Preview
 * by default (no files touched) — `--apply` writes. `--prune` first drops
 * entries whose repo no longer exists. Exits 1 if any repo failed.
 */
export function renderAllRepos(opts: {
  preview: boolean;
  force: boolean;
  prune: boolean;
  verbose: boolean;
  json: boolean;
}): void {
  // In --json mode all human output (intro/log/outro) is suppressed so stdout is
  // a single parseable object — parity with single-repo `render --json` (#276).
  if (!opts.json) p.intro(brand(`render ${accent("--all")}`));

  if (opts.prune) {
    const { removed } = pruneRegistry();
    if (removed.length > 0 && !opts.json) {
      p.log.info(`Pruned ${removed.length} missing repo(s) from the registry.`);
    }
  }

  const repos = listRegistryRepos();
  const mode = opts.preview ? "preview" : "apply";
  if (repos.length === 0) {
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            command: "render",
            scope: "all",
            ok: true,
            mode,
            repos: [],
            summary: { ok: 0, pending: 0, conflicts: 0, warnings: 0, failed: 0 },
          },
          null,
          2,
        ),
      );
      return;
    }
    p.log.info(
      "No repos registered. Bootstrap with 'navori registry scan <dir>' or run 'navori init' in a repo.",
    );
    p.outro(dim("Done"));
    return;
  }

  // Name the source and mode up front so the log is self-explanatory to whoever
  // reads it later: which registry, how many repos, preview vs. write.
  if (!opts.json) {
    p.log.info(
      `${repos.length} repo(s) from ${dim(registryPath())} · ${
        opts.preview ? color.yellow("preview (no files touched)") : color.green("apply (writing)")
      }`,
    );
  }

  const rows = renderRepoRows(
    repos.map((r) => ({ name: r.name ?? r.path, path: r.path })),
    { preview: opts.preview, force: opts.force },
  );

  if (opts.json) {
    const { failed, pending, conflicts, warnings, ok } = rollupRenderRows(rows);
    console.log(
      JSON.stringify(
        {
          command: "render",
          scope: "all",
          ok: failed === 0,
          mode,
          repos: rows.map((r) => ({
            name: r.name,
            status: r.status,
            detail: r.detail,
            conflicts: r.conflicts,
            changed: r.changed,
            warnings: r.warnings,
          })),
          summary: { ok, pending, conflicts, warnings, failed },
        },
        null,
        2,
      ),
    );
    if (failed > 0) process.exit(1);
    return;
  }

  const { failed, summary } = reportRepoRenderRows(rows, opts.preview, opts.verbose);

  if (failed > 0) {
    p.outro(`${color.yellow("Done with errors")} ${dim(summary)}`);
    process.exit(1);
  }
  p.outro(`${opts.preview ? color.yellow("Preview") : color.green("Done")} ${dim(summary)}`);
}
