import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { type NavoriConfig } from "../lib/config.ts";
import { readConfigOrExit } from "../lib/cli-config.ts";
import { renderClaudeEngine, type ClaudeEngineResult } from "../engines/claude/index.ts";
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
 * `sync` re-runs the Claude engine but exposes the plan up front so the
 * user can pick what to do about user-modified conflicts:
 *
 *   - `.claude/` and CLAUDE.md are both covered (P0-fix B2 — before this,
 *     sync only knew about CLAUDE.md and silently ignored agent / skill /
 *     hook conflicts that doctor was telling the user to "run sync" for).
 *   - Monorepos: sync iterates the root + every declared workspace, mirroring
 *     `render`. `--workspace <name>` acota la operación a uno solo (fase 4).
 *   - Modes mirror render: dry-run shows only, --apply / --yes write,
 *     --yes aborts with exit 1 if there are conflicts (CI gate).
 *   - The "apply-all (overwrite my edits)" choice from the legacy sync is
 *     no longer offered: navori prefers losing user edits never. Users who
 *     want to overwrite a conflict resolve it by hand and re-run.
 */
export const syncCommand = defineCommand({
  meta: {
    name: "sync",
    description:
      "Sync managed blocks from the bundle into CLAUDE.md and .claude/, prompting on conflicts",
  },
  args: {
    cwd: { type: "string", description: "Directory to sync (default: cwd)" },
    "dry-run": { type: "boolean", description: "Show plan, do not write" },
    apply: { type: "boolean", description: "Apply changes (skip interactive prompt)" },
    interactive: {
      type: "boolean",
      description:
        "Resolve each CLAUDE.md conflict one by one: see the diff and pick keep-mine or accept-new.",
    },
    yes: {
      type: "boolean",
      description: "Auto-confirm. Implies --apply. Fails with exit 1 if conflicts exist.",
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

    // Dry-run pass: get the full plan for every target without writing anything.
    const plans: TargetPlan[] = targets.map((t) => ({
      target: t,
      plan: renderClaudeEngine(t.cwd, t.config, {
        dryRun: true,
        repoRoot: t.repoRoot,
        monorepoContext: t.monorepoContext,
      }),
    }));

    const conflicts = collectAllConflicts(plans);
    const hasOtherChanges = plans.some((pl) => pl.plan.written.length > 0);
    const pendingCount = plans.reduce((acc, pl) => acc + pl.plan.written.length, 0);

    // --json: never prompt. Emit the plan; apply the non-conflicting changes
    // only when --apply/--yes is passed (conflicts are always skipped, never
    // overwritten). --yes + conflicts is a CI gate failure (ok:false, exit 1).
    if (json) {
      const autoApply = Boolean(args.apply || args.yes) && !args["dry-run"];
      const yesBlocked = Boolean(args.yes) && conflicts.length > 0;
      let writtenTotal = 0;
      const backups: Array<{ label: string; path: string }> = [];
      if (autoApply && !yesBlocked) {
        for (const t of targets) {
          const applied = renderClaudeEngine(t.cwd, t.config, {
            repoRoot: t.repoRoot,
            monorepoContext: t.monorepoContext,
          });
          writtenTotal += applied.written.length;
          if (applied.backupPath) backups.push({ label: t.label, path: applied.backupPath });
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
            pending: pendingCount,
            written: writtenTotal,
            backups,
          }),
          null,
          2,
        ),
      );
      if (yesBlocked) process.exit(1);
      return;
    }

    reportPlans(plans, lang);

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

    if (args.yes && conflicts.length > 0) {
      const lines = conflicts.map((c) => `  - ${c.path}: ${c.reason}`).join("\n");
      p.cancel(ts.conflictsWithYes(conflicts.length, lines));
      process.exit(1);
    }

    // Per-target conflict resolutions chosen in --interactive mode.
    let resolutions: Map<string, ConflictResolution> = new Map();

    if (!autoApply) {
      if (conflicts.length > 0 && Boolean(args.interactive)) {
        const resolved = await resolveConflictsInteractively(plans, lang);
        if (resolved === null) {
          p.cancel(tc(lang).common.aborted);
          process.exit(0);
        }
        resolutions = resolved;
        // .claude/ file conflicts aren't resolved block-by-block (they're whole
        // managed files). They stay as-is; surface that explicitly.
        const fileConflicts = conflicts.filter((c) => !c.path.includes("CLAUDE.md"));
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

    // Apply pass: actually write. The engine skips conflict files automatically
    // (user-modified-skipped never lands in `pending`); accept-new resolutions
    // are passed as forceIds so those CLAUDE.md blocks are overwritten.
    let writtenTotal = 0;
    for (const t of targets) {
      const res = resolutions.get(t.label);
      const applied = renderClaudeEngine(t.cwd, t.config, {
        skipIds: res?.skipIds,
        forceIds: res?.forceIds,
        repoRoot: t.repoRoot,
        monorepoContext: t.monorepoContext,
      });
      writtenTotal += applied.written.length;
      if (applied.backupPath) {
        p.log.message(
          `${dim(`${tc(lang).common.backupLabel} [${t.label}]`)} ${applied.backupPath}`,
        );
      }
    }

    p.log.success(ts.wroteFiles(writtenTotal));
    p.outro(`${color.green(ts.doneWord)} ${summarize(writtenTotal, conflicts.length, lang)}`);
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
  plan: ClaudeEngineResult;
}

export type SyncTargetsResult =
  | { ok: true; targets: SyncTarget[] }
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
    return {
      ok: true,
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
  for (const ws of declared) {
    targets.push({
      label: `workspace:${ws.name}`,
      cwd: resolve(cwd, ws.path),
      repoRoot: cwd,
      config: effectiveConfigForWorkspace(config, ws),
      monorepoContext: buildMonorepoContext(config, ws),
    });
  }
  return { ok: true, targets };
}

export interface Conflict {
  path: string;
  reason: string;
}

interface ConflictResolution {
  /** CLAUDE.md block ids to keep the user's edit (skip render). */
  skipIds: Set<string>;
  /** CLAUDE.md block ids to overwrite with the rendered version (accept-new). */
  forceIds: Set<string>;
}

/**
 * Walk each target's CLAUDE.md conflicts and ask, per block, whether to keep
 * the user's edit or accept the newly rendered version — showing the diff.
 * Returns per-target {skipIds, forceIds}, or null if the user cancelled.
 *
 * Only CLAUDE.md managed blocks are resolved here; .claude/ file conflicts are
 * whole-file and stay as-is (reported separately by the caller).
 */
export async function resolveConflictsInteractively(
  plans: TargetPlan[],
  lang: Lang = DEFAULT_LANG,
): Promise<Map<string, ConflictResolution> | null> {
  const ts = tc(lang).sync;
  const resolutions = new Map<string, ConflictResolution>();
  for (const tp of plans) {
    const cmConflicts = tp.plan.claudeMdEntries.filter((e) => e.status === "user-modified-skipped");
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
    pending: number;
    written: number;
    backups: Array<{ label: string; path: string }>;
  },
) {
  return {
    command: "sync",
    ok: meta.ok,
    ...(meta.reason ? { reason: meta.reason } : {}),
    mode: meta.mode,
    targets: plans.map(({ target, plan }) => ({
      label: target.label,
      claudeMd: plan.claudeMdEntries.map((e) => ({ id: e.asset.id, status: e.status })),
      written: plan.written
        .filter((w) => w.path !== "CLAUDE.md")
        .map((w) => ({ path: w.path, status: w.status })),
      skipped: plan.skipped.map((s) => ({ path: s.path, reason: s.reason })),
      updatesAvailable: plan.updatesAvailable.map((u) => ({
        id: u.id,
        fromVersion: u.fromVersion,
        toVersion: u.toVersion,
      })),
    })),
    conflicts: conflicts.map((c) => ({ path: c.path, reason: c.reason })),
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

function collectTargetConflicts({ target, plan }: TargetPlan): Conflict[] {
  const out: Conflict[] = [];
  const prefix = target.label === "root" ? "" : `[${target.label}] `;
  for (const e of plan.claudeMdEntries) {
    if (e.status === "user-modified-skipped") {
      out.push({
        path: `${prefix}CLAUDE.md (${e.asset.id})`,
        reason: "managed block edited",
      });
    }
  }
  for (const s of plan.skipped) {
    if (/editad|edit/i.test(s.reason)) {
      out.push({ path: `${prefix}${s.path}`, reason: s.reason });
    }
  }
  return out;
}

function reportPlans(plans: TargetPlan[], lang: Lang): void {
  for (const tp of plans) {
    reportTargetPlan(tp, lang);
  }
}

function reportTargetPlan({ target, plan }: TargetPlan, lang: Lang): void {
  const ts = tc(lang).sync;
  const lines: string[] = [ts.planTitle(target.label)];

  for (const e of plan.claudeMdEntries) {
    const symStr = renderStatusSymbol(e.status);
    const label = renderStatusLabel(e.status);
    const cond = e.asset.condition ? dim(` [cond: ${e.asset.condition}]`) : "";
    lines.push(`  ${symStr} CLAUDE.md:${e.asset.id}  ${dim("(")}${label}${dim(")")}${cond}`);
  }

  for (const w of plan.written) {
    if (w.path === "CLAUDE.md") continue; // already shown via claudeMdEntries
    const symStr = renderStatusSymbol(w.status);
    const label = renderStatusLabel(w.status);
    lines.push(`  ${symStr} ${w.path}  ${dim("(")}${label}${dim(")")}`);
  }

  for (const s of plan.skipped) {
    lines.push(
      `  ${color.yellow(sym.conflict)} ${s.path}  ${dim("(skipped:")} ${dim(s.reason)}${dim(")")}`,
    );
  }

  if (plan.updatesAvailable.length > 0) {
    lines.push("");
    lines.push(`  ${dim(ts.updatesAvailableTitle)}`);
    for (const u of plan.updatesAvailable) {
      lines.push(
        `    ${color.cyan(sym.update)} ${u.id}  ${dim(`${u.fromVersion} → ${u.toVersion}`)}`,
      );
    }
  }

  p.log.message(lines.join("\n"));
}

function summarize(writtenCount: number, conflictCount: number, lang: Lang): string {
  const ts = tc(lang).sync;
  const parts: string[] = [];
  if (writtenCount > 0) parts.push(color.green(ts.writtenToken(writtenCount)));
  if (conflictCount > 0) parts.push(color.red(ts.conflictKeptToken(conflictCount)));
  return parts.length > 0 ? `${dim("—")} ${parts.join(dim(", "))}` : "";
}
