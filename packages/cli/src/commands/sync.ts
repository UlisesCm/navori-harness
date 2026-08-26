import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { type NavoriConfig } from "../lib/config.ts";
import { readConfigOrExit } from "../lib/cli-config.ts";
import { renderClaudeEngine, type ClaudeEngineResult } from "../engines/claude/index.ts";
import { renderNonClaudeEngines, type EngineRenderSummary } from "./render.ts";
import {
  effectiveConfigForWorkspace,
  buildMonorepoContext,
  type MonorepoRenderContext,
} from "../lib/monorepo.ts";
import { extractManagedContent } from "../lib/marker.ts";
import { formatLineDiff } from "../lib/diff.ts";
import {
  renderStatusSymbol,
  renderStatusLabel,
  dim,
  color,
  sym,
  brand,
  accent,
} from "../lib/style.ts";
import { tc, resolveLang, DEFAULT_LANG, type Lang } from "../lib/i18n.ts";

/**
 * `sync` re-runs every configured engine but exposes the plan up front so the
 * user can pick what to do about user-modified conflicts:
 *
 *   - Every configured engine is covered. Claude keeps block-level interactive
 *     resolution for CLAUDE.md; whole-file conflicts from any engine stay
 *     untouched unless the user resolves them by hand.
 *   - Monorepos: sync iterates the root + every declared workspace, mirroring
 *     `render`. `--workspace <name>` acota la operación a uno solo (fase 4).
 *   - Modes mirror render: dry-run shows only, --apply / --yes write,
 *     --yes aborts with exit 1 if there are conflicts (CI gate).
 *   - The "apply-all (overwrite my edits)" choice from the legacy sync is
 *     no longer offered as a PROMPT: navori never overwrites user edits by
 *     default. #523 added the explicit, non-interactive way out —
 *     `--accept-new` / `--keep-mine` — because a formatter can invalidate every
 *     managed block's hash at once and the only documented recovery
 *     (`--interactive`) needs a human to answer one prompt per block, which
 *     leaves an agent-driven rollout stuck.
 */
export const syncCommand = defineCommand({
  meta: {
    name: "sync",
    description: "Sync every configured engine from the bundle, prompting on conflicts",
  },
  args: {
    cwd: { type: "string", description: "Directory to sync (default: cwd)" },
    "dry-run": { type: "boolean", description: "Show plan, do not write" },
    apply: { type: "boolean", description: "Apply changes (skip interactive prompt)" },
    interactive: {
      type: "boolean",
      description:
        "Resolve each CLAUDE.md block conflict: see the diff and pick keep-mine or accept-new.",
    },
    yes: {
      type: "boolean",
      description:
        "Auto-confirm. Implies --apply. Fails with exit 1 if conflicts exist, unless " +
        "--accept-new/--keep-mine already resolved them.",
    },
    "accept-new": {
      type: "boolean",
      description:
        "Resolve EVERY CLAUDE.md block conflict by overwriting your edit with the rendered " +
        "version, without prompting. Destructive: requires --apply (or --yes) to write, and " +
        "backs up CLAUDE.md first. Your user zone is never touched.",
    },
    "keep-mine": {
      type: "boolean",
      description:
        "Resolve EVERY CLAUDE.md block conflict by keeping your edit, applying every " +
        "non-conflicting change, without prompting. Requires --apply (or --yes) to write.",
    },
    workspace: {
      type: "string",
      description:
        "Sync only one workspace by name (skips root). Requires a monorepo config with declared workspaces.",
    },
    json: {
      type: "boolean",
      description:
        "Emit a machine-readable JSON result and suppress human output (for CI/automation).",
    },
  },
  async run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    const configPath = `${cwd}/navori.config.json`;
    const json = Boolean(args.json);

    if (!json) p.intro(brand("sync"));

    if (!existsSync(cwd)) {
      if (json) {
        console.log(
          JSON.stringify({ command: "sync", ok: false, reason: "directory-missing", cwd }),
        );
      } else {
        p.cancel(tc(DEFAULT_LANG).common.dirNotFound(cwd));
      }
      process.exit(1);
    }

    if (!existsSync(configPath)) {
      if (json) {
        console.log(
          JSON.stringify({ command: "sync", ok: false, reason: "config-missing", configPath }),
        );
      } else {
        p.cancel(tc(DEFAULT_LANG).common.noConfig(configPath));
      }
      process.exit(1);
    }

    const config = readConfigOrExit(configPath);
    const lang = resolveLang(config.language);
    const ts = tc(lang).sync;
    const workspaceFilter = (args.workspace as string | undefined) ?? null;

    // #523: bulk, non-interactive conflict resolution. Validated before any
    // rendering so a contradictory invocation fails fast and identically in
    // --json and human mode.
    const bulk = resolveBulkMode(
      {
        acceptNew: Boolean(args["accept-new"]),
        keepMine: Boolean(args["keep-mine"]),
        interactive: Boolean(args.interactive),
      },
      lang,
    );
    if (!bulk.ok) {
      if (json) {
        // `reason` is a STABLE English code; `detail` carries localized text.
        console.log(
          JSON.stringify({
            command: "sync",
            ok: false,
            reason: bulk.reasonCode,
            detail: bulk.reason,
          }),
        );
      } else {
        p.cancel(bulk.reason);
      }
      process.exit(1);
    }
    const bulkMode = bulk.mode;

    const targetsResult = resolveSyncTargets(cwd, config, workspaceFilter);
    if (!targetsResult.ok) {
      if (json) {
        // `reason` is a STABLE English code; `detail` carries localized text.
        console.log(
          JSON.stringify({
            command: "sync",
            ok: false,
            reason: targetsResult.reasonCode,
            detail: targetsResult.reason,
          }),
        );
      } else {
        p.cancel(targetsResult.reason);
      }
      process.exit(1);
    }
    const targets = targetsResult.targets;
    const orphanedWorkspaces = targetsResult.orphanedWorkspaces;

    // Dry-run pass: get the full plan for every target without writing anything.
    const plans = targets.map((target) => renderSyncTarget(target, true));

    const conflicts = collectAllConflicts(plans);
    const pendingCount = plans.reduce((acc, plan) => acc + countTargetWrites(plan), 0);
    const hasOtherChanges = pendingCount > 0;

    // --json: never prompt. Emit the plan; apply the non-conflicting changes
    // only when --apply/--yes is passed (conflicts are always skipped, never
    // overwritten). --yes + conflicts is a CI gate failure (ok:false, exit 1).
    if (json) {
      const autoApply = Boolean(args.apply || args.yes) && !args["dry-run"];
      // A bulk flag ANSWERS the conflicts, so it defuses the --yes CI gate —
      // that gate exists precisely because nobody had decided what to do.
      const yesBlocked = Boolean(args.yes) && conflicts.length > 0 && bulkMode === null;
      let writtenTotal = 0;
      const backups: Array<{ label: string; path: string }> = [];
      if (autoApply && !yesBlocked) {
        const resolutions = buildBulkResolutions(plans, bulkMode);
        for (const t of targets) {
          const applied = renderSyncTarget(t, false, resolutions.get(t.label));
          writtenTotal += countTargetWrites(applied);
          backups.push(...collectTargetBackups(applied));
        }
      }
      const mode = args["dry-run"] ? "dry-run" : autoApply ? "apply" : "plan";
      console.log(
        JSON.stringify(
          buildSyncJson(plans, conflicts, {
            ok: !yesBlocked,
            // Stable English code (never localized) — only present on failure.
            reason: yesBlocked ? "conflicts-detected" : undefined,
            mode,
            resolution: bulkMode,
            pending: pendingCount,
            written: writtenTotal,
            backups,
            orphanedWorkspaces,
          }),
          null,
          2,
        ),
      );
      if (yesBlocked) process.exit(1);
      return;
    }

    reportPlans(plans, lang);

    // #230: declared-but-deleted workspaces are reported, never resurrected.
    // Surface before the up-to-date short-circuit so the user always sees them.
    if (orphanedWorkspaces.length > 0) {
      p.log.warn(
        tc(lang).render.orphanedWorkspaces(
          orphanedWorkspaces.length,
          orphanedWorkspaces.map((w) => `  ${color.yellow(sym.update)} ${w}`).join("\n"),
        ),
      );
    }

    if (!hasOtherChanges && conflicts.length === 0) {
      p.outro(ts.upToDate);
      return;
    }

    // --dry-run: report only, never write
    if (args["dry-run"]) {
      const summary = [
        conflicts.length > 0 ? `${conflicts.length} conflict(s)` : null,
        hasOtherChanges ? `${pendingCount} pending` : null,
      ]
        .filter(Boolean)
        .join(", ");
      p.outro(ts.dryRunComplete(summary));
      return;
    }

    const autoApply = Boolean(args.yes || args.apply);
    const blockConflicts = conflicts.filter((c) => c.kind === "block");
    const fileConflicts = conflicts.filter((c) => c.kind === "file");

    // The CI gate stands only when the conflicts are unanswered: a bulk flag IS
    // the answer, so `--yes --accept-new` must not exit 1 (#523).
    if (args.yes && conflicts.length > 0 && bulkMode === null) {
      const lines = conflicts.map((c) => `  - ${c.path}: ${c.reason}`).join("\n");
      p.cancel(ts.conflictsWithYes(conflicts.length, lines));
      process.exit(1);
    }

    // Per-target conflict resolutions, chosen in --interactive mode or in bulk.
    let resolutions: Map<string, ConflictResolution> = new Map();

    if (bulkMode !== null) {
      // Decided in bulk: never prompt. Writing still requires --apply/--yes —
      // `--accept-new` destroys hand edits, so it must never be the side effect
      // of a bare `navori sync`. Without them this is a preview: the plan above
      // already showed each conflicting block's diff.
      if (!autoApply) {
        p.outro(ts.bulkPreview(`--${bulkMode}`, blockConflicts.length));
        return;
      }
      resolutions = buildBulkResolutions(plans, bulkMode);
      p.log.info(ts.bulkApplied(`--${bulkMode}`, blockConflicts.length));
      // Whole-file conflicts are out of reach for both modes (the plan carries
      // no rendered body for them); say so instead of implying they were fixed.
      if (fileConflicts.length > 0) {
        p.log.warn(ts.fileConflictsRemain(fileConflicts.length));
      }
    } else if (!autoApply) {
      if (conflicts.length > 0 && Boolean(args.interactive)) {
        const resolved = await resolveConflictsInteractively(plans, lang);
        if (resolved === null) {
          p.cancel(tc(lang).common.aborted);
          process.exit(0);
        }
        resolutions = resolved;
        // Whole-file conflicts aren't resolved block-by-block. They stay as-is;
        // surface that explicitly.
        if (fileConflicts.length > 0) {
          p.log.warn(ts.fileConflictsRemain(fileConflicts.length));
        }
      } else if (conflicts.length > 0) {
        const choice = await p.select({
          message: ts.conflictPrompt(conflicts.length),
          options: [
            { value: "skip-conflicts", label: ts.optSkipConflicts },
            { value: "interactive", label: ts.optInteractive },
            { value: "abort", label: ts.optAbort },
          ],
        });
        if (p.isCancel(choice) || choice === "abort") {
          p.cancel(tc(lang).common.aborted);
          process.exit(0);
        }
        if (choice === "interactive") {
          const resolved = await resolveConflictsInteractively(plans, lang);
          if (resolved === null) {
            p.cancel(tc(lang).common.aborted);
            process.exit(0);
          }
          resolutions = resolved;
        }
      } else {
        const ok = await p.confirm({
          message: ts.applyChanges,
          initialValue: true,
        });
        if (p.isCancel(ok) || !ok) {
          p.cancel(tc(lang).common.aborted);
          process.exit(0);
        }
      }
    }

    // Apply pass: actually write. Engines skip conflict files automatically
    // (user-modified-skipped never lands in `pending`); accept-new resolutions
    // are passed as forceIds so those CLAUDE.md blocks are overwritten.
    let writtenTotal = 0;
    for (const t of targets) {
      const res = resolutions.get(t.label);
      const applied = renderSyncTarget(t, false, res);
      writtenTotal += countTargetWrites(applied);
      for (const backup of collectTargetBackups(applied)) {
        p.log.message(`${dim(`${tc(lang).common.backupLabel} [${backup.label}]`)} ${backup.path}`);
      }
    }

    // `--accept-new` resolved every block conflict, so only the whole-file ones
    // are still "kept"; reporting the original count would contradict the run.
    const keptConflicts = bulkMode === "accept-new" ? fileConflicts.length : conflicts.length;
    p.log.success(ts.wroteFiles(writtenTotal));
    p.outro(`${color.green(ts.doneWord)} ${summarize(writtenTotal, keptConflicts, lang)}`);
  },
});

export interface SyncTarget {
  /** Display label (e.g. "root", "workspace:backend"). */
  label: string;
  /** Absolute path the engine writes into. */
  cwd: string;
  /** Repo root where `.navori/presets/` lives (root for every target). */
  repoRoot: string;
  /** Effective config for this target (root config or workspace-effective). */
  config: NavoriConfig;
  /** Monorepo map context for a workspace target; undefined for the root (which
   * reads `config.monorepo` directly). Keeps the workspace's "## Monorepo" block
   * in sync with what `render` writes. */
  monorepoContext?: MonorepoRenderContext;
}

export interface TargetPlan {
  target: SyncTarget;
  /** Rich Claude plan when the target enables the Claude engine. */
  claude?: ClaudeEngineResult;
  /** Flat summaries for every configured non-Claude engine. */
  engines: EngineRenderSummary[];
}

export type SyncTargetsResult =
  | {
      ok: true;
      targets: SyncTarget[];
      /** Declared workspaces whose directory no longer exists on disk (#230).
       * They are NOT synced (never resurrected); the caller surfaces them so the
       * user prunes config, mirroring `render`/`doctor`. */
      orphanedWorkspaces: string[];
    }
  /** `reason` is the LOCALIZED human message; `reasonCode` is a stable
   * kebab-case code for `--json` consumers (never localized). */
  | { ok: false; reason: string; reasonCode: string };

export function resolveSyncTargets(
  cwd: string,
  config: NavoriConfig,
  workspaceFilter: string | null,
): SyncTargetsResult {
  const declared = config.monorepo?.workspaces ?? [];
  const ts = tc(resolveLang(config.language)).sync;

  if (workspaceFilter) {
    if (declared.length === 0) {
      return {
        ok: false,
        reason: ts.workspaceRequiresMonorepo,
        reasonCode: "workspace-requires-monorepo",
      };
    }
    const match = declared.find((w) => w.name === workspaceFilter);
    if (!match) {
      const known = declared.map((w) => w.name).join(", ");
      return {
        ok: false,
        reason: ts.workspaceNotFound(workspaceFilter, known),
        reasonCode: "workspace-not-found",
      };
    }
    // An explicit `--workspace <name>` targets that one on purpose; mirror
    // `render`, which does NOT guard existsSync in the filtered path (if you
    // ask for it by name, you get it). The #230 orphan guard applies only to
    // the implicit all-workspaces loop below.
    return {
      ok: true,
      orphanedWorkspaces: [],
      targets: [
        {
          label: `workspace:${match.name}`,
          cwd: resolve(cwd, match.path),
          repoRoot: cwd,
          config: effectiveConfigForWorkspace(config, match),
          monorepoContext: buildMonorepoContext(config, match),
        },
      ],
    };
  }

  const targets: SyncTarget[] = [{ label: "root", cwd, repoRoot: cwd, config }];
  const orphanedWorkspaces: string[] = [];
  for (const ws of declared) {
    const wsCwd = resolve(cwd, ws.path);
    // #230: a workspace deleted from disk (or dropped from the workspace glob)
    // but still declared in config must NOT be resurrected — renderSyncTarget
    // would mkdir it and write a full `.claude/` tree into a dir that should not
    // exist. Skip + surface it so the user prunes config. This mirrors the guard
    // in `render` (render.ts) and doctor's "in config, missing on disk" row;
    // without it, `sync --apply` contradicts both by recreating the tree.
    if (!existsSync(wsCwd)) {
      orphanedWorkspaces.push(ws.path);
      continue;
    }
    targets.push({
      label: `workspace:${ws.name}`,
      cwd: wsCwd,
      repoRoot: cwd,
      config: effectiveConfigForWorkspace(config, ws),
      monorepoContext: buildMonorepoContext(config, ws),
    });
  }
  return { ok: true, targets, orphanedWorkspaces };
}

export interface Conflict {
  path: string;
  reason: string;
  /**
   * `block` — a managed block inside CLAUDE.md. Resolvable one by one
   * (`--interactive`) or in bulk (`--accept-new` / `--keep-mine`), because the
   * plan carries the rendered body for it.
   * `file` — a whole managed file the user hand-edited (`.claude/agents/*.md`,
   * `AGENTS.md`, `.cursor/rules/*`). NO resolution flag reaches these: the plan
   * has no rendered body to put in their place, so navori never overwrites them
   * automatically. Reported so nobody reads a clean exit as "all fixed".
   */
  kind: ConflictKind;
}

export type ConflictKind = "block" | "file";

export interface ConflictResolution {
  /** CLAUDE.md block ids to keep the user's edit (skip render). */
  skipIds: Set<string>;
  /** CLAUDE.md block ids to overwrite with the rendered version (accept-new). */
  forceIds: Set<string>;
}

/**
 * Non-interactive bulk resolution for CLAUDE.md block conflicts (#523).
 *
 * `accept-new` — overwrite every conflicting block with the rendered version.
 * `keep-mine`  — keep every hand-edited block, apply everything else.
 */
export type BulkMode = "accept-new" | "keep-mine";

export type BulkModeResult =
  | { ok: true; mode: BulkMode | null }
  /** `reason` is the LOCALIZED human message; `reasonCode` is the stable
   *  kebab-case code `--json` consumers branch on (never localized). */
  | { ok: false; reason: string; reasonCode: string };

/**
 * Validate the mutually exclusive bulk flags.
 *
 * Both at once is a contradiction (`--accept-new` destroys the very edits
 * `--keep-mine` preserves). Either one together with `--interactive` is also a
 * contradiction: one decides without asking, the other asks per block. Both
 * fail fast with exit 1 rather than picking a winner silently.
 */
export function resolveBulkMode(
  flags: { acceptNew: boolean; keepMine: boolean; interactive: boolean },
  lang: Lang = DEFAULT_LANG,
): BulkModeResult {
  const ts = tc(lang).sync;
  if (flags.acceptNew && flags.keepMine) {
    return { ok: false, reason: ts.bulkFlagsConflict, reasonCode: "bulk-flags-conflict" };
  }
  const mode: BulkMode | null = flags.acceptNew
    ? "accept-new"
    : flags.keepMine
      ? "keep-mine"
      : null;
  if (mode !== null && flags.interactive) {
    return { ok: false, reason: ts.bulkFlagsInteractive, reasonCode: "bulk-flags-interactive" };
  }
  return { ok: true, mode };
}

/**
 * Turn a bulk mode into the per-target resolutions the render consumes.
 *
 * `accept-new` collects EVERY conflicting CLAUDE.md block id into `forceIds`, so
 * the render overwrites the hand-edited body with the freshly rendered one. The
 * user zone is out of its reach by construction: the Claude engine carves that
 * zone off before any managed-block work and re-emits it verbatim, so `forceIds`
 * can only ever reach text between navori's own markers.
 *
 * `keep-mine` returns an EMPTY map on purpose — that is not an oversight. The
 * engine ALREADY refuses to touch a hand-edited block, so "keep mine" has
 * nothing to tell it; it only means "don't ask me, write the rest". Passing the
 * ids as `skipIds` instead would drop them from the plan entirely and the report
 * would stop naming the conflicts that are still there.
 */
export function buildBulkResolutions(
  plans: TargetPlan[],
  mode: BulkMode | null,
): Map<string, ConflictResolution> {
  const resolutions = new Map<string, ConflictResolution>();
  if (mode !== "accept-new") return resolutions;
  for (const tp of plans) {
    const ids = (tp.claude?.claudeMdEntries ?? [])
      .filter((e) => e.status === "user-modified-skipped")
      .map((e) => e.asset.id);
    if (ids.length === 0) continue;
    resolutions.set(tp.target.label, { skipIds: new Set(), forceIds: new Set(ids) });
  }
  return resolutions;
}

function renderSyncTarget(
  target: SyncTarget,
  dryRun: boolean,
  resolution?: ConflictResolution,
): TargetPlan {
  const engines = target.config.engines ?? ["claude"];
  const claude = engines.includes("claude")
    ? renderClaudeEngine(target.cwd, target.config, {
        dryRun,
        skipIds: resolution?.skipIds,
        forceIds: resolution?.forceIds,
        repoRoot: target.repoRoot,
        monorepoContext: target.monorepoContext,
      })
    : undefined;
  const additional = renderNonClaudeEngines(target.cwd, target.config, engines, dryRun, {
    repoRoot: target.repoRoot,
    warnMissingAdapters: target.label === "root",
  });
  return { target, claude, engines: additional };
}

function countTargetWrites(plan: TargetPlan): number {
  return (
    (plan.claude?.written.length ?? 0) +
    plan.engines.reduce((count, engine) => count + engine.written.length, 0)
  );
}

function collectTargetBackups(plan: TargetPlan): Array<{ label: string; path: string }> {
  const backups: Array<{ label: string; path: string }> = [];
  if (plan.claude?.backupPath) {
    backups.push({ label: `${plan.target.label}:claude`, path: plan.claude.backupPath });
  }
  for (const engine of plan.engines) {
    if (engine.backupPath) {
      backups.push({
        label: `${plan.target.label}:${engine.engine}`,
        path: engine.backupPath,
      });
    }
  }
  return backups;
}

/**
 * Walk each target's CLAUDE.md conflicts and ask, per block, whether to keep
 * the user's edit or accept the newly rendered version — showing the diff.
 * Returns per-target {skipIds, forceIds}, or null if the user cancelled.
 *
 * Only CLAUDE.md managed blocks are resolved here; all whole-file conflicts
 * stay as-is (reported separately by the caller).
 */
export async function resolveConflictsInteractively(
  plans: TargetPlan[],
  lang: Lang = DEFAULT_LANG,
): Promise<Map<string, ConflictResolution> | null> {
  const ts = tc(lang).sync;
  const resolutions = new Map<string, ConflictResolution>();
  for (const tp of plans) {
    const cmConflicts =
      tp.claude?.claudeMdEntries.filter((e) => e.status === "user-modified-skipped") ?? [];
    if (cmConflicts.length === 0) continue;

    const claudeMdPath = join(tp.target.cwd, "CLAUDE.md");
    const existing = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, "utf-8") : "";
    const skipIds = new Set<string>();
    const forceIds = new Set<string>();

    for (const e of cmConflicts) {
      const actual = extractManagedContent(existing, e.asset.id) ?? "";
      const proposed = e.newContent ?? "";
      p.log.message(
        `${color.yellow(ts.conflictHeader(tp.target.label, accent(e.asset.id)))}\n` +
          `${dim(ts.conflictDiffLegend)}\n${formatLineDiff(actual, proposed)}`,
      );
      const choice = await p.select({
        message: ts.conflictChoice(e.asset.id),
        options: [
          { value: "keep", label: ts.optKeepMine },
          { value: "accept", label: ts.optAcceptNew },
        ],
      });
      if (p.isCancel(choice)) return null;
      if (choice === "accept") forceIds.add(e.asset.id);
      else skipIds.add(e.asset.id);
    }
    resolutions.set(tp.target.label, { skipIds, forceIds });
  }
  return resolutions;
}

/**
 * Machine-readable sync result. Keys are stable English (never localized) so
 * CI/automation can parse the same shape regardless of `config.language`.
 */
function buildSyncJson(
  plans: TargetPlan[],
  conflicts: Conflict[],
  meta: {
    ok: boolean;
    /** Stable English failure code; omitted from the payload when undefined. */
    reason?: string;
    mode: string;
    /** Bulk conflict resolution applied this run, or null when none (#523). */
    resolution: BulkMode | null;
    pending: number;
    written: number;
    backups: Array<{ label: string; path: string }>;
    /** Declared workspaces absent on disk — reported, never synced (#230). */
    orphanedWorkspaces: string[];
  },
) {
  return {
    command: "sync",
    ok: meta.ok,
    ...(meta.reason ? { reason: meta.reason } : {}),
    mode: meta.mode,
    resolution: meta.resolution,
    targets: plans.map(({ target, claude, engines }) => ({
      label: target.label,
      claudeMd: (claude?.claudeMdEntries ?? []).map((e) => ({
        id: e.asset.id,
        status: e.status,
      })),
      written: (claude?.written ?? [])
        .filter((w) => w.path !== "CLAUDE.md")
        .map((w) => ({ path: w.path, status: w.status })),
      skipped: (claude?.skipped ?? []).map((s) => ({
        path: s.path,
        reason: s.reason,
        status: s.status,
      })),
      updatesAvailable: (claude?.updatesAvailable ?? []).map((u) => ({
        id: u.id,
        fromVersion: u.fromVersion,
        toVersion: u.toVersion,
      })),
      engines: engines.map((engine) => ({
        engine: engine.engine,
        written: engine.written.map((w) => ({ path: w.path, status: w.status })),
        skipped: engine.skipped.map((s) => ({
          path: s.path,
          reason: s.reason,
          status: s.status,
        })),
        warnings: engine.warnings,
      })),
    })),
    // `kind` tells automation which conflicts `--accept-new`/`--keep-mine` can
    // reach ("block") and which no flag can ("file") — see the Conflict docs.
    conflicts: conflicts.map((c) => ({ path: c.path, reason: c.reason, kind: c.kind })),
    orphanedWorkspaces: meta.orphanedWorkspaces,
    pending: meta.pending,
    written: meta.written,
    backups: meta.backups,
  };
}

function collectAllConflicts(plans: TargetPlan[]): Conflict[] {
  const out: Conflict[] = [];
  for (const tp of plans) {
    for (const c of collectTargetConflicts(tp)) out.push(c);
  }
  return out;
}

export function collectTargetConflicts({ target, claude, engines }: TargetPlan): Conflict[] {
  const out: Conflict[] = [];
  const prefix = target.label === "root" ? "" : `[${target.label}] `;
  for (const e of claude?.claudeMdEntries ?? []) {
    if (e.status === "user-modified-skipped") {
      out.push({
        path: `${prefix}CLAUDE.md (${e.asset.id})`,
        reason: "managed block edited",
        kind: "block",
      });
    }
  }
  // #241: a whole-file conflict is a managed file the user hand-edited, flagged
  // by the stable `user-modified-skipped` status — NOT by regexing localized
  // skip prose (which broke on any rewording or new locale). `downgrade-skipped`
  // (block from a newer navori) is intentionally not a conflict.
  for (const s of claude?.skipped ?? []) {
    if (s.status === "user-modified-skipped") {
      out.push({ path: `${prefix}${s.path}`, reason: s.reason, kind: "file" });
    }
  }
  for (const engine of engines) {
    for (const skipped of engine.skipped) {
      if (skipped.status === "user-modified-skipped") {
        out.push({
          path: `${prefix}[${engine.engine}] ${skipped.path}`,
          reason: skipped.reason,
          kind: "file",
        });
      }
    }
  }
  return out;
}

function reportPlans(plans: TargetPlan[], lang: Lang): void {
  for (const tp of plans) {
    reportTargetPlan(tp, lang);
  }
}

function reportTargetPlan({ target, claude, engines }: TargetPlan, lang: Lang): void {
  const ts = tc(lang).sync;
  const lines: string[] = [ts.planTitle(target.label)];

  const claudeMdEntries = claude?.claudeMdEntries ?? [];
  // #523: the plan used to say `user-modified-skipped` and nothing else, so
  // deciding whether a conflict was "just emphasis quotes" or "my paragraph is
  // about to go" meant opening every file by hand. Read CLAUDE.md once, and only
  // when there IS a block conflict to diff.
  const hasBlockConflict = claudeMdEntries.some((e) => e.status === "user-modified-skipped");
  const claudeMdOnDisk = hasBlockConflict ? readClaudeMd(target.cwd) : "";

  for (const e of claudeMdEntries) {
    const symStr = renderStatusSymbol(e.status);
    const label = renderStatusLabel(e.status);
    const cond = e.asset.condition ? dim(` [cond: ${e.asset.condition}]`) : "";
    lines.push(
      `  ${symStr} [claude] CLAUDE.md:${e.asset.id}  ${dim("(")}${label}${dim(")")}${cond}`,
    );
    if (e.status === "user-modified-skipped") {
      lines.push(
        ...formatConflictDiffLines(
          extractManagedContent(claudeMdOnDisk, e.asset.id) ?? "",
          e.newContent ?? "",
          lang,
        ),
      );
    }
  }

  for (const w of claude?.written ?? []) {
    if (w.path === "CLAUDE.md") continue; // already shown via claudeMdEntries
    const symStr = renderStatusSymbol(w.status);
    const label = renderStatusLabel(w.status);
    lines.push(`  ${symStr} [claude] ${w.path}  ${dim("(")}${label}${dim(")")}`);
  }

  for (const s of claude?.skipped ?? []) {
    lines.push(
      `  ${color.yellow(sym.conflict)} [claude] ${s.path}  ${dim("(skipped:")} ${dim(s.reason)}${dim(")")}`,
    );
  }

  if ((claude?.updatesAvailable.length ?? 0) > 0) {
    lines.push("");
    lines.push(`  ${dim(ts.updatesAvailableTitle)}`);
    for (const u of claude?.updatesAvailable ?? []) {
      lines.push(
        `    ${color.cyan(sym.update)} ${u.id}  ${dim(`${u.fromVersion} → ${u.toVersion}`)}`,
      );
    }
  }

  for (const engine of engines) {
    for (const w of engine.written) {
      const symStr = renderStatusSymbol(w.status);
      const label = renderStatusLabel(w.status);
      lines.push(`  ${symStr} [${engine.engine}] ${w.path}  ${dim("(")}${label}${dim(")")}`);
    }
    for (const skipped of engine.skipped) {
      lines.push(
        `  ${color.yellow(sym.conflict)} [${engine.engine}] ${skipped.path}  ${dim("(skipped:")} ${dim(skipped.reason)}${dim(")")}`,
      );
    }
    for (const warning of engine.warnings) {
      lines.push(`  ${color.yellow(sym.conflict)} [${engine.engine}] ${warning}`);
    }
  }

  // Whole-file conflicts get NO diff (see formatConflictDiffLines): the plan
  // carries no rendered body for them. Say it once per target rather than
  // letting the silence read as "nothing differs".
  const hasFileConflict =
    (claude?.skipped ?? []).some((s) => s.status === "user-modified-skipped") ||
    engines.some((engine) => engine.skipped.some((s) => s.status === "user-modified-skipped"));
  if (hasFileConflict) lines.push(`      ${dim(ts.conflictDiffFileLevel)}`);

  p.log.message(lines.join("\n"));
}

/** On-disk CLAUDE.md for a target, or "" when it does not exist yet. */
function readClaudeMd(cwd: string): string {
  const path = join(cwd, "CLAUDE.md");
  return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

/** How many diff lines the plan preview prints per conflicting block. Small on
 *  purpose: a formatter-induced conflict hits every block at once (17 of 19 in
 *  #523), and a full diff each would bury the plan. */
export const CONFLICT_DIFF_MAX_LINES = 6;

export interface ConflictDiffPreview {
  /** Total diff lines between the two bodies (`-` and `+` counted separately). */
  changed: number;
  /** The first `max` of them, `- ` = on disk, `+ ` = what navori would render. */
  lines: string[];
  /** Diff lines left out by the cap; 0 when the whole diff fits. */
  hidden: number;
}

/**
 * Bounded diff between a managed block as it sits on disk and as navori would
 * render it.
 *
 * WHAT IT SHOWS: the number of differing lines, then the first `max` of them.
 * WHAT IT DOES NOT SHOW: everything past the cap (the caller prints how many
 * were dropped and points at `sync --interactive`, which renders the full diff).
 *
 * The comparison is POSITIONAL — line i against line i, the same cheap scan
 * `formatLineDiff` uses — not a Myers diff. It is exact for the case #523 is
 * about (a formatter rewriting lines in place: `*forms*` → `_forms_`), and it
 * over-reports when lines were inserted or deleted, because every line after the
 * shift compares unequal. That is why the summary line says "diff lines" and not
 * "lines you changed": it must not claim a precision it does not have.
 */
export function summarizeConflictDiff(
  actual: string,
  proposed: string,
  max: number = CONFLICT_DIFF_MAX_LINES,
): ConflictDiffPreview {
  const a = actual.split("\n");
  const b = proposed.split("\n");
  const changed: string[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const ai = a[i];
    const bi = b[i];
    if (ai === bi) continue;
    if (ai !== undefined) changed.push(`- ${ai}`);
    if (bi !== undefined) changed.push(`+ ${bi}`);
  }
  return {
    changed: changed.length,
    lines: changed.slice(0, max),
    hidden: Math.max(0, changed.length - max),
  };
}

/** The indented, colorized preview block the plan prints under a conflicting
 *  CLAUDE.md entry. Empty when the two bodies are identical (which shouldn't
 *  happen for a conflict, but an empty preview beats a lying one). */
function formatConflictDiffLines(actual: string, proposed: string, lang: Lang): string[] {
  const ts = tc(lang).sync;
  const preview = summarizeConflictDiff(actual, proposed);
  if (preview.changed === 0) return [];
  const out = [`      ${dim(ts.conflictDiffSummary(preview.changed, preview.lines.length))}`];
  for (const line of preview.lines) {
    out.push(`      ${line.startsWith("-") ? color.red(line) : color.green(line)}`);
  }
  if (preview.hidden > 0) out.push(`      ${dim(ts.conflictDiffTruncated(preview.hidden))}`);
  return out;
}

function summarize(writtenCount: number, conflictCount: number, lang: Lang): string {
  const ts = tc(lang).sync;
  const parts: string[] = [];
  if (writtenCount > 0) parts.push(color.green(ts.writtenToken(writtenCount)));
  if (conflictCount > 0) parts.push(color.red(ts.conflictKeptToken(conflictCount)));
  return parts.length > 0 ? `${dim("—")} ${parts.join(dim(", "))}` : "";
}
