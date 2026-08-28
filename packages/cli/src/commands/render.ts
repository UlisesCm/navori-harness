import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { readConfig, ConfigError, type NavoriConfig } from "../lib/config.ts";
import { scanOrphanedEngineOutputs, type OrphanedEngineOutput } from "../lib/health.ts";
import { planOrphanRemoval, removeEmptyDirs, type OrphanRemovalPlan } from "../lib/removable.ts";
import { createBackup, purgeOldBackups } from "../lib/backup.ts";
import type { AssetPlanEntry, UpdateAvailable } from "../lib/render-plan.ts";
import { renderClaudeEngine, type ClaudeEngineResult } from "../engines/claude/index.ts";
import { renderAgentsMdEngine } from "../engines/agents-md/index.ts";
import { renderCursorEngine } from "../engines/cursor/index.ts";
import { renderCopilotEngine } from "../engines/copilot/index.ts";
import { renderCodexEngine } from "../engines/codex/index.ts";
import type { ProseEngineResult } from "../engines/shared/prose-harness.ts";
import type { SkippedFile } from "../engines/shared/execute-plan.ts";
import { EPHEMERAL_HARNESS_PATHS } from "../engines/shared/ephemeral-paths.ts";
import {
  renderGitignore,
  type GitignoreRenderResult,
} from "../engines/shared/gitignore-harness.ts";
import {
  ensurePrettierIgnore,
  type PrettierIgnoreResult,
} from "../engines/shared/prettierignore-harness.ts";
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
import { t, tc, resolveLang, DEFAULT_LANG, type Lang } from "../lib/i18n.ts";
import { describeCoreProvenance, type CoreProvenance } from "../lib/bundled-assets.ts";
import { effectiveConfigForWorkspace, buildMonorepoContext } from "../lib/monorepo.ts";
import { benchStart, benchMark, benchReport } from "../lib/bench.ts";
import { listRegistryRepos, pruneRegistry, registryPath } from "../lib/registry.ts";

/** One path `render --prune` deliberately did NOT delete, with its reason. */
export type KeptEngineOutput = OrphanRemovalPlan["keep"][number];

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
   * Only DELETES when combined with a non-preview (apply) run; preview still
   * computes the full plan and reports it in `prunedEngineOutputs` /
   * `keptEngineOutputs` without touching a single file (#312, #521).
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
  /** FILES the prune deleted — or, in preview, WOULD delete (#521): the ones
   *  that carry navori's own marker. `undefined` when `--prune` was not asked
   *  for or there was nothing orphaned; the caller tells preview from apply by
   *  the `dryRun` it passed (`--json` publishes it as `mode`). A reported orphan
   *  directory is never deleted whole — see `keptEngineOutputs` for what stays
   *  behind (#496). */
  prunedEngineOutputs?: string[];
  /** Paths inside an orphaned output that the prune left — or would leave — in
   *  place, with the reason: `foreign` (navori never wrote it), `newer` (navori
   *  wrote it, but a release ahead of this CLI, so rolling it back is not ours
   *  to do — #79), `ephemeral` (machine-local harness state the harness never
   *  versions) or `symlink` (a link, neither followed nor unlinked — its target
   *  is usually outside the repository). Same preview/apply semantics as
   *  `prunedEngineOutputs`. */
  keptEngineOutputs?: KeptEngineOutput[];
  /** Where the pre-prune snapshot landed, or null when nothing was deleted. */
  prunedBackupPath?: string | null;
  /** Harness `.gitignore` block reconciliation (#313). Absent when
   *  `gitignoreHarness` is `"off"` — navori doesn't touch `.gitignore` then. */
  gitignore?: GitignoreRenderResult | null;
  /** Harness `.prettierignore` block reconciliation (#523). Absent when the repo
   *  does not run prettier — navori installs no opinion about a tool it doesn't
   *  detect. */
  prettierignore?: PrettierIgnoreResult | null;
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

  // #523 follow-up: reconcile the harness `.prettierignore` too, once at the
  // repo root. The prevention shipped wired into `init` alone, which reaches
  // repos onboarded AFTER it — never the already-onboarded ones, and the repo
  // that motivated it was one of those. Every install converges here instead:
  // `update` ends in a render, so the next one closes the gap on its own.
  // Returns null when prettier isn't detected (file never read or created).
  const prettierignore = ensurePrettierIgnore(cwd, config, {
    dryRun,
    force: forceFlag,
    lang,
  });

  // #312: outputs owned only by engines no longer in config.engines[] (a stale
  // AGENTS.md/.codex after narrowing to claude) linger because render never
  // revisits a disabled engine. Report them always; with --prune on an apply
  // run, back them up and delete them.
  const orphanedEngineOutputs = scanOrphanedEngineOutputs(cwd, config);
  let prunedEngineOutputs: string[] | undefined;
  let keptEngineOutputs: KeptEngineOutput[] | undefined;
  let prunedBackupPath: string | null = null;
  if (pruneFlag && orphanedEngineOutputs.length > 0) {
    const paths = orphanedEngineOutputs.flatMap((o) => o.paths);
    // #496: `paths` are OWNERSHIP paths from a static per-engine map — "a
    // disabled engine would write here" — not evidence that what is there is
    // navori's. Deleting them recursively took the user's hand-written AGENTS.md
    // and their whole `.cursor/` (own rules + mcp.json) with it. So the tree is
    // walked and each file judged by the SAME authorship test the engine delete
    // path uses (lib/removable.ts): navori's files go, everything else stays and
    // is reported back so the run says what it spared and why.
    // #521: the plan is PURE (it only reads), so it runs in preview too — that
    // is the whole point. `render --prune` without `--apply` used to re-print
    // the orphan ROOTS and nothing else, so the file-by-file verdict this plan
    // computes (what goes, what stays and why) only ever appeared AFTER the
    // deletion. Preview now answers it before. Only the writes below stay
    // behind `!dryRun`.
    const plan = planOrphanRemoval(cwd, paths, EPHEMERAL_HARNESS_PATHS);
    if (!dryRun && plan.remove.length > 0) {
      // Back up before deleting so a mistaken prune is recoverable (same safety
      // net the prose engine uses for overwrites). The excludes are NOT optional:
      // an orphaned engine dir is exactly where the ephemerals live (`.codex/
      // progress/` under a dropped Codex engine), and copying them is what filled
      // a disk with 131 GB of backups in #348. `commitWrites` already does this
      // for the render backup; this second entry point had been missed (#373).
      // Second guard, on purpose: `planOrphanRemoval` already skips the same
      // paths, so this holds the #348 invariant even if that skip ever narrows.
      const handle = createBackup(cwd, plan.remove, { exclude: [...EPHEMERAL_HARNESS_PATHS] });
      if (handle.files.length > 0) {
        prunedBackupPath = handle.path;
        purgeOldBackups();
      }
      // Never recursive: the plan enumerated FILES, so a directory can only go
      // away through `removeEmptyDirs` — i.e. when nothing of the user's is left.
      for (const rel of plan.remove) rmSync(resolve(cwd, rel), { force: true });
      removeEmptyDirs(cwd, paths);
    }
    prunedEngineOutputs = plan.remove;
    keptEngineOutputs = plan.keep;
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
    keptEngineOutputs,
    prunedBackupPath,
    gitignore,
    prettierignore,
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

    // Which core did this render actually read? `render` and `pnpm check:render`
    // can silently disagree because they read DIFFERENT copies of the same asset
    // (build copy vs live sources); publishing the provenance is what lets a
    // user tell the two apart instead of chasing a phantom "unchanged".
    const provenance = describeCoreProvenance();

    // --json: structured result, no human output. Keys are stable English and
    // bypass i18n on purpose — this is machine-readable output for CI.
    if (json) {
      console.log(JSON.stringify(buildRenderJson(result, preview, provenance), null, 2));
      benchReport();
      return;
    }

    p.log.message(dim(tr.coreSource(provenance.root, provenance.bundled)));
    if (provenance.staleSource) p.log.warn(tr.staleCoreBundle(provenance.staleSource));

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

    if (result.prettierignore) reportPrettierIgnore(result.prettierignore, result.language);

    // #312: orphaned outputs from disabled engines. With --prune the run reports
    // its file-by-file plan — what it deleted, or (in preview, #521) what it
    // WOULD delete; otherwise it warns about the roots and points at --prune.
    // `prunedEngineOutputs` being defined at all means the plan ran, so an empty
    // one is "--prune found nothing of navori's here", not "no --prune": the
    // kept list below carries that answer and the roots warning would contradict
    // it by promising a deletion that will not happen.
    if (result.prunedEngineOutputs) {
      if (result.prunedEngineOutputs.length > 0) {
        const lines = result.prunedEngineOutputs
          .map((path) => `  ${preview ? color.magenta(sym.removed) : color.green(sym.ok)} ${path}`)
          .join("\n");
        const count = result.prunedEngineOutputs.length;
        if (preview) p.log.warn(tr.prunePreviewEngineOutputs(count, lines));
        else p.log.info(tr.prunedEngineOutputs(count, lines));
      }
    } else if (result.orphanedEngineOutputs && result.orphanedEngineOutputs.length > 0) {
      const lines = result.orphanedEngineOutputs
        .flatMap((o) =>
          o.paths.map((path) => `  ${color.yellow(sym.update)} ${path} ${dim(`(${o.engine})`)}`),
        )
        .join("\n");
      const count = result.orphanedEngineOutputs.reduce((n, o) => n + o.paths.length, 0);
      p.log.warn(tr.orphanedEngineOutputs(count, lines));
    }

    // #496: what the prune deliberately did NOT delete. Printed even when
    // nothing was deleted — "I walked your .cursor/ and every file in it is
    // yours" is the answer the user needs, and silence there reads as success.
    if (result.keptEngineOutputs && result.keptEngineOutputs.length > 0) {
      const lines = result.keptEngineOutputs
        .map(
          (k) =>
            `  ${color.yellow(sym.update)} ${k.path} ${dim(`(${tr.keptEngineOutputReason(k.reason)})`)}`,
        )
        .join("\n");
      const count = result.keptEngineOutputs.length;
      p.log.info(
        preview ? tr.keptEngineOutputsPreview(count, lines) : tr.keptEngineOutputs(count, lines),
      );
    }

    const allDowngrades = result.downgrades.concat(...result.workspaces.map((w) => w.downgrades));
    const downgradeWarn = formatDowngradeWarning(allDowngrades, result.language);
    if (downgradeWarn) p.log.warn(downgradeWarn);

    // In preview mode `written` means "would write" — the engine populates it
    // with pending changes without touching disk.
    const anyPending = resultHasPendingWrites(result);
    // A `skipped` file is neither a pending write nor "up to date": render
    // REFUSED to write it. The per-file line says so, but the outro is the line
    // everyone reads, and it used to claim "Al día" over a mirror that render
    // knowingly left stale.
    const skipped = countSkippedFiles(result);
    const skippedTail = skipped > 0 ? ` ${dim("·")} ${color.yellow(tr.skippedOutro(skipped))}` : "";
    const summary = summarize(countRenderStatuses(result));
    if (anyPending) {
      const word = preview ? color.yellow(tr.previewWord) : color.green(tr.doneWord);
      const hint = preview ? ` ${dim(`· ${tr.previewHint}`)}` : "";
      p.outro(`${word} ${summary}${hint}${skippedTail}`);
    } else if (skipped > 0) {
      p.outro(`${color.yellow(tr.skippedWord)} ${summary}${skippedTail}`);
    } else {
      const hint = preview ? ` ${dim(`· ${tr.upToDateHint}`)}` : "";
      p.outro(`${dim(tr.upToDate)} ${summary}${hint}`);
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
 *
 * It deliberately ignores `skipped` — a refusal to overwrite is NOT a pending
 * write, and `--json`'s `pending` key means exactly that. The outro asks
 * `countSkippedFiles` separately so "nothing pending" can't be reported as
 * "up to date" while render is knowingly leaving files stale.
 */
export function resultHasPendingWrites(result: ReturnType<typeof runRender>): boolean {
  return (
    result.written ||
    result.workspaces.some((w) => w.written) ||
    (result.extraEngines ?? []).some((e) => e.written.length > 0) ||
    result.workspaces.some((w) => w.extraEngines.some((e) => e.written.length > 0)) ||
    result.gitignore?.status === "created" ||
    result.gitignore?.status === "updated" ||
    result.prettierignore?.status === "created" ||
    result.prettierignore?.status === "updated"
  );
}

/**
 * How many FILES render refused to write this run (hand-edited managed block, or
 * a block written by a newer navori). Same partition `scripts/check-render.mjs`
 * calls `blocked`: file-level skips only — CLAUDE.md block-level
 * `user-modified-skipped` entries are already surfaced by `summarize()` as a red
 * "N conflict", and the guard buckets them apart as `staleBlocks`.
 */
export function countSkippedFiles(result: ReturnType<typeof runRender>): number {
  const claudeSkips = (engine: ClaudeEngineResult | undefined): number =>
    engine?.skipped.length ?? 0;
  const extraSkips = (engines: EngineRenderSummary[] | undefined): number =>
    (engines ?? []).reduce((n, e) => n + e.skipped.length, 0);
  return (
    claudeSkips(result.engineResult) +
    extraSkips(result.extraEngines) +
    result.workspaces.reduce(
      (n, w) => n + claudeSkips(w.engineResult) + extraSkips(w.extraEngines),
      0,
    ) +
    (result.gitignore?.status.endsWith("-skipped") ? 1 : 0) +
    (result.prettierignore?.status.endsWith("-skipped") ? 1 : 0)
  );
}

/**
 * Engine files the Claude engine inspected and found already up to date.
 *
 * `CLAUDE.md` is discounted on purpose: `reportClaudeMd` owns that file and
 * enumerates its managed blocks one by one, so leaving it in counts it twice —
 * once as a file, once per block. The engine plans it like any other
 * destination (`inspected` includes it) and it is absent from `written` exactly
 * when it did not change, which is the only case that reaches this residual.
 */
export function countUnchangedEngineFiles(engine: ClaudeEngineResult | undefined): number {
  if (!engine) return 0;
  const claudeMdWritten = engine.written.some((w) => w.path === "CLAUDE.md");
  const residual = engine.inspected - engine.written.length - engine.skipped.length;
  return Math.max(0, residual - (claudeMdWritten ? 0 : 1));
}

/**
 * Count, by status, EVERYTHING this render's own report enumerates: the
 * CLAUDE.md managed blocks (root + every workspace) AND the engine files —
 * `.claude/**`, `AGENTS.md`, `.codex/…`, the harness `.gitignore` — in the root
 * and in every workspace.
 *
 * #519: the outro and `--json`'s `summary` counted the blocks alone. A rollout
 * whose listing enumerated 5 created / 53 updated announced "1 created, 18
 * updated" — a number that reads as a total while describing under a third of
 * what `--apply` was about to write, and a `--json` consumer inherited the
 * undercount with no way to detect it. The three summaries (outro, `--json`,
 * multi-repo `renderRepoRows`) share this one counter so they cannot diverge
 * again.
 *
 * Two deliberate exclusions:
 * - File-level SKIPS. They are neither written nor unchanged: render REFUSED
 *   them, and `countSkippedFiles` reports them on its own channel (the outro
 *   tail, `--json`'s per-scope `skipped`). Counting them here would report the
 *   same refusal twice. Block-level skips stay in, as the red "N conflict".
 * - Unchanged files of the non-Claude (prose) engines, which report no
 *   `inspected` count — invisible in the listing too, so the summary matches it.
 */
export function countRenderStatuses(result: ReturnType<typeof runRender>): Record<string, number> {
  const counts: Record<string, number> = {};
  const bump = (status: string, n = 1): void => {
    if (n > 0) counts[status] = (counts[status] ?? 0) + n;
  };
  const countScope = (
    entries: AssetPlanEntry[],
    engine: ClaudeEngineResult | undefined,
    extraEngines: EngineRenderSummary[],
  ): void => {
    for (const e of entries) bump(e.status);
    // `CLAUDE.md` dropped for the same reason `reportEngineFiles` drops it from
    // its section: the entries above already account for it, block by block.
    for (const w of engine?.written ?? []) {
      if (w.path !== "CLAUDE.md") bump(w.status);
    }
    bump("unchanged", countUnchangedEngineFiles(engine));
    for (const ee of extraEngines) {
      for (const w of ee.written) bump(w.status);
    }
  };
  countScope(result.entries, result.engineResult, result.extraEngines ?? []);
  for (const ws of result.workspaces) countScope(ws.entries, ws.engineResult, ws.extraEngines);
  // The harness `.gitignore` is one more line of the same listing. Its skips go
  // to `countSkippedFiles`, like every other file-level skip.
  if (result.gitignore && !result.gitignore.status.endsWith("-skipped")) {
    bump(result.gitignore.status);
  }
  // ...and so is the harness `.prettierignore`, on the same terms.
  if (result.prettierignore && !result.prettierignore.status.endsWith("-skipped")) {
    bump(result.prettierignore.status);
  }
  return counts;
}

/**
 * Machine-readable render result. Keys are stable English (never localized) so
 * CI/automation can parse the same shape regardless of `config.language`.
 * Status tokens come straight from the render plan (created/updated/…).
 *
 * `coreRoot` / `bundled` / `staleCore` are the render's PROVENANCE: which copy
 * of the core produced this answer, and whether that copy is behind its sources.
 * Without them a `--json` consumer can't distinguish "the mirror is fine" from
 * "the CLI was reading a stale build copy" — the two look identical.
 */
function buildRenderJson(
  result: ReturnType<typeof runRender>,
  preview: boolean,
  provenance: CoreProvenance,
) {
  const entryJson = (e: AssetPlanEntry) => ({ id: e.asset.id, status: e.status });
  const engineJson = (ee: EngineRenderSummary) => ({
    engine: ee.engine,
    written: ee.written.map((w) => ({ path: w.path, status: w.status })),
    skipped: ee.skipped.map((s) => ({ path: s.path, reason: s.reason })),
    warnings: ee.warnings,
    backupPath: ee.backupPath,
  });
  // Claude's per-FILE plan (`.claude/**` + CLAUDE.md), same shape the non-Claude
  // engines already expose. `changed` only says "something would be written";
  // without these lists a CI consumer can't name WHICH files are stale — the
  // whole point of #421, where 15 rendered files (hooks included) drifted.
  // In preview mode `written` means "would write".
  // `unchangedFiles` travels with them (#519): the engine reports its up-to-date
  // files as a COUNT, not a list, and without it `summary.unchanged` cannot be
  // recomputed from this payload — which is precisely the audit a consumer needs
  // to trust the summary at all.
  const claudeFilesJson = (engineResult: ClaudeEngineResult | undefined) => ({
    written: (engineResult?.written ?? []).map((w) => ({ path: w.path, status: w.status })),
    skipped: (engineResult?.skipped ?? []).map((s) => ({ path: s.path, reason: s.reason })),
    unchangedFiles: countUnchangedEngineFiles(engineResult),
  });
  const pending = resultHasPendingWrites(result);
  const downgrades = result.downgrades
    .concat(...result.workspaces.map((w) => w.downgrades))
    .map((d) => ({ id: d.id, fromVersion: d.fromVersion, toVersion: d.toVersion }));
  return {
    command: "render",
    ok: true,
    mode: preview ? "preview" : "apply",
    coreRoot: provenance.root,
    bundled: provenance.bundled,
    staleCore: provenance.staleSource,
    root: {
      filePath: result.filePath,
      changed: result.written,
      entries: result.entries.map(entryJson),
      ...claudeFilesJson(result.engineResult),
      languageFallbacks: result.languageFallbacks,
      backupPath: result.backupPath ?? null,
    },
    workspaces: result.workspaces.map((w) => ({
      name: w.workspaceName,
      path: w.workspacePath,
      filePath: w.filePath,
      changed: w.written,
      entries: w.entries.map(entryJson),
      ...claudeFilesJson(w.engineResult),
      languageFallbacks: w.languageFallbacks,
      backupPath: w.backupPath ?? null,
      extraEngines: w.extraEngines.map(engineJson),
    })),
    extraEngines: (result.extraEngines ?? []).map(engineJson),
    orphanedWorkspaces: result.orphanedWorkspaces ?? [],
    orphanedEngineOutputs: result.orphanedEngineOutputs ?? [],
    prunedEngineOutputs: result.prunedEngineOutputs ?? [],
    // #496: what the prune spared travels with what it deleted. Publishing one
    // without the other is the #479 shape — a `--json` consumer that sees an
    // empty `prunedEngineOutputs` cannot tell "nothing was orphaned" from
    // "everything there is yours, and here is why I left it".
    keptEngineOutputs: result.keptEngineOutputs ?? [],
    gitignore: result.gitignore
      ? {
          path: result.gitignore.path,
          status: result.gitignore.status,
          backupPath: result.gitignore.backupPath ?? null,
        }
      : null,
    // #523 follow-up. `entries` travels because it is the answer to "what is
    // this block protecting?" — a consumer seeing `unchanged` with an empty
    // list knows the user's own rules already cover the harness, which is a
    // different state from "navori wrote nothing".
    prettierignore: result.prettierignore
      ? {
          path: result.prettierignore.path,
          status: result.prettierignore.status,
          entries: result.prettierignore.entries,
          backupPath: result.prettierignore.backupPath ?? null,
        }
      : null,
    downgrades,
    // CONTRACT (#519): counts every managed block AND every engine file this
    // render touched or checked, not just the CLAUDE.md blocks. The numbers grew
    // — they now match the listing above them, which is the whole fix. Recompute
    // it from `root`/`workspaces`/`extraEngines` (`entries` + `written` +
    // `unchangedFiles`) if you need the breakdown.
    summary: countRenderStatuses(result),
    pending,
  };
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

/** The outro's colored one-liner, from `countRenderStatuses`' buckets. */
function summarize(counts: Record<string, number>): string {
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
  // #458: `.gitignore` is the one file navori edits without having authored it,
  // so the pre-write snapshot is the user's way back to their own rules.
  if (gitignore.backupPath) {
    lines.push(`  ${dim(tc(lang).common.backupLabel)} ${gitignore.backupPath}`);
  }
  p.log.message(lines.join("\n"));
}

/**
 * Report the harness `.prettierignore` reconciliation (#523). Same shape as
 * `reportGitignore` — one status line, a hand-edited block surfaces as a skip.
 * Absent (null) when the repo does not run prettier.
 *
 * `unchanged` with no entries is its own sentence: it means the user's own
 * ignore rules already cover every harness path, which is a success and not a
 * no-op. Left as a bare "unchanged" line it reads like navori checked nothing.
 */
function reportPrettierIgnore(prettierignore: PrettierIgnoreResult, lang: Lang): void {
  const tr = tc(lang).render;
  const lines: string[] = [tr.prettierIgnoreTitle];
  if (
    prettierignore.status === "user-modified-skipped" ||
    prettierignore.status === "downgrade-skipped"
  ) {
    lines.push(
      `  ${color.yellow("!")} ${prettierignore.path}  ${dim("(")}${color.yellow("skipped")}${dim(")")}`,
    );
    if (prettierignore.skippedReason) lines.push(`      ${dim(prettierignore.skippedReason)}`);
  } else if (prettierignore.status === "unchanged" && prettierignore.entries.length === 0) {
    lines.push(`  ${renderStatusSymbol("unchanged")} ${dim(t(lang).prettierIgnoreAlreadyCovered)}`);
  } else {
    lines.push(
      `  ${renderStatusSymbol(prettierignore.status)} ${prettierignore.path}  ${dim("(")}${renderStatusLabel(prettierignore.status)}${dim(")")}`,
    );
  }
  // Same reason as `.gitignore`: navori edits this file without having authored
  // it, so the pre-write snapshot is the user's way back to their own rules.
  if (prettierignore.backupPath) {
    lines.push(`  ${dim(tc(lang).common.backupLabel)} ${prettierignore.backupPath}`);
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
  // Discounts CLAUDE.md the same way `written` does above — it has its own
  // section — so this "+N unchanged" and the outro's summary count one set.
  const unchangedCount = countUnchangedEngineFiles(engine);

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
  changed: Array<{ id: string; status: RenderStatus }>;
  /** Engine advisories (root + every workspace, every engine), deduped. The
   * single-repo render prints these, but the batch used to drop them — and the
   * batch is exactly where they bite: a fleet rollout with a `project.libraries`
   * id gone from the registry (the socketio split, audit v0.5.1 A1) lost its
   * skill in 15 repos with zero signal. Empty for missing/error rows. */
  warnings: string[];
}

/** Compact per-repo counts for the multi-repo render table, from the same
 *  `countRenderStatuses` buckets the single-repo outro prints (#519). */
export function summarizeRenderEntries(counts: Record<string, number>): string {
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
      // "unchanged" next to a "would-write" status. This walk feeds the --verbose
      // per-file list; the row's counts come from `countRenderStatuses`, the same
      // counter the single-repo outro and `--json` use (#519).
      const engineFiles: Array<{ id: string; status: RenderStatus }> = [];
      // Warnings ride the same walk as the files. Deduped (Set) because a
      // monorepo re-emits repo-level advisories once per workspace render — the
      // batch row needs each message once, not once per workspace.
      const engineWarnings = new Set<string>();
      const collectEngine = (eng?: {
        written: Array<{ path: string; status: RenderStatus }>;
        warnings: string[];
      }): void => {
        // `CLAUDE.md` is listed by its blocks, right below; naming the file too
        // would print (and count) the same change twice.
        for (const w of eng?.written ?? []) {
          if (w.path !== "CLAUDE.md") engineFiles.push({ id: w.path, status: w.status });
        }
        for (const w of eng?.warnings ?? []) engineWarnings.add(w);
      };
      collectEngine(result.engineResult);
      for (const ee of result.extraEngines ?? []) collectEngine(ee);
      for (const ws of result.workspaces) {
        collectEngine(ws.engineResult);
        for (const ee of ws.extraEngines) collectEngine(ee);
      }
      const counts = countRenderStatuses(result);
      const anyPending = resultHasPendingWrites(result);
      const conflicts = counts["user-modified-skipped"] ?? 0;
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
        detail: summarizeRenderEntries(counts),
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
