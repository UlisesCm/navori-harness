import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readConfig, type NavoriConfig } from "../lib/config.ts";
import { renderClaudeEngine, type ClaudeEngineResult } from "../engines/claude/index.ts";
import { effectiveConfigForWorkspace } from "../lib/monorepo.ts";
import { renderStatusSymbol, renderStatusLabel, dim, color, sym, brand } from "../lib/style.ts";

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
    description: "Sync managed blocks from the bundle into CLAUDE.md and .claude/, prompting on conflicts",
  },
  args: {
    cwd: { type: "string", description: "Directory to sync (default: cwd)" },
    "dry-run": { type: "boolean", description: "Show plan, do not write" },
    apply: { type: "boolean", description: "Apply changes (skip interactive prompt)" },
    yes: { type: "boolean", description: "Auto-confirm. Implies --apply. Fails with exit 1 if conflicts exist." },
    workspace: {
      type: "string",
      description:
        "Sync only one workspace by name (skips root). Requires a monorepo config with declared workspaces.",
    },
  },
  async run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    const configPath = `${cwd}/navori.config.json`;

    p.intro(brand("sync"));

    if (!existsSync(cwd)) {
      p.cancel(`Directory not found: ${cwd}`);
      process.exit(1);
    }

    if (!existsSync(configPath)) {
      p.cancel(`No navori.config.json at ${configPath}. Run 'navori init' first.`);
      process.exit(1);
    }

    const config = readConfig(configPath);
    const workspaceFilter = (args.workspace as string | undefined) ?? null;

    const targetsResult = resolveSyncTargets(cwd, config, workspaceFilter);
    if (!targetsResult.ok) {
      p.cancel(targetsResult.reason);
      process.exit(1);
    }
    const targets = targetsResult.targets;

    // Dry-run pass: get the full plan for every target without writing anything.
    const plans: TargetPlan[] = targets.map((t) => ({
      target: t,
      plan: renderClaudeEngine(t.cwd, t.config, { dryRun: true }),
    }));

    reportPlans(plans);

    const conflicts = collectAllConflicts(plans);
    const hasOtherChanges = plans.some((p) => p.plan.written.length > 0);

    if (!hasOtherChanges && conflicts.length === 0) {
      p.outro("Up to date — no changes");
      return;
    }

    // --dry-run: report only, never write
    if (args["dry-run"]) {
      const pending = plans.reduce((acc, p) => acc + p.plan.written.length, 0);
      const summary = [
        conflicts.length > 0 ? `${conflicts.length} conflict(s)` : null,
        hasOtherChanges ? `${pending} pending` : null,
      ].filter(Boolean).join(", ");
      p.outro(`Dry-run complete${summary ? ` — ${summary}` : ""}`);
      return;
    }

    const autoApply = Boolean(args.yes || args.apply);

    if (args.yes && conflicts.length > 0) {
      const lines = conflicts.map((c) => `  - ${c.path}: ${c.reason}`).join("\n");
      p.cancel(
        `${conflicts.length} conflict(s) detected with --yes. Resolvelos a mano o corré 'sync --apply' sin --yes para el flujo interactivo.\n${lines}`,
      );
      process.exit(1);
    }

    if (!autoApply) {
      if (conflicts.length > 0) {
        const choice = await p.select({
          message: `Encontré ${conflicts.length} conflict(s). ¿Qué hago?`,
          options: [
            {
              value: "skip-conflicts",
              label: "Aplicar los cambios sin conflict, dejar mis ediciones intactas",
            },
            { value: "abort", label: "Abortar — no escribir nada" },
          ],
        });
        if (p.isCancel(choice) || choice === "abort") {
          p.cancel("Aborted");
          process.exit(0);
        }
      } else {
        const ok = await p.confirm({
          message: "Aplicar cambios?",
          initialValue: true,
        });
        if (p.isCancel(ok) || !ok) {
          p.cancel("Aborted");
          process.exit(0);
        }
      }
    }

    // Apply pass: actually write. The engine already skips conflict files
    // automatically (user-modified-skipped never lands in `pending`), so
    // "skip-conflicts" is the default behavior — no extra wiring needed.
    let writtenTotal = 0;
    for (const t of targets) {
      const applied = renderClaudeEngine(t.cwd, t.config);
      writtenTotal += applied.written.length;
      if (applied.backupPath) {
        p.log.message(`${dim(`Backup [${t.label}]:`)} ${applied.backupPath}`);
      }
    }

    p.log.success(`Wrote ${writtenTotal} file(s)`);
    p.outro(`${color.green("Done")} ${summarize(writtenTotal, conflicts.length)}`);
  },
});

export interface SyncTarget {
  /** Display label (e.g. "root", "workspace:backend"). */
  label: string;
  /** Absolute path the engine writes into. */
  cwd: string;
  /** Effective config for this target (root config or workspace-effective). */
  config: NavoriConfig;
}

interface TargetPlan {
  target: SyncTarget;
  plan: ClaudeEngineResult;
}

export type SyncTargetsResult =
  | { ok: true; targets: SyncTarget[] }
  | { ok: false; reason: string };

export function resolveSyncTargets(
  cwd: string,
  config: NavoriConfig,
  workspaceFilter: string | null,
): SyncTargetsResult {
  const declared = config.monorepo?.workspaces ?? [];

  if (workspaceFilter) {
    if (declared.length === 0) {
      return {
        ok: false,
        reason: `--workspace requires a monorepo with declared workspaces; this config has none. Run 'navori scan' first.`,
      };
    }
    const match = declared.find((w) => w.name === workspaceFilter);
    if (!match) {
      const known = declared.map((w) => w.name).join(", ");
      return {
        ok: false,
        reason: `Workspace '${workspaceFilter}' not found. Known: ${known}`,
      };
    }
    return {
      ok: true,
      targets: [
        {
          label: `workspace:${match.name}`,
          cwd: resolve(cwd, match.path),
          config: effectiveConfigForWorkspace(config, match),
        },
      ],
    };
  }

  const targets: SyncTarget[] = [{ label: "root", cwd, config }];
  for (const ws of declared) {
    targets.push({
      label: `workspace:${ws.name}`,
      cwd: resolve(cwd, ws.path),
      config: effectiveConfigForWorkspace(config, ws),
    });
  }
  return { ok: true, targets };
}

export interface Conflict {
  path: string;
  reason: string;
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

function reportPlans(plans: TargetPlan[]): void {
  for (const tp of plans) {
    reportTargetPlan(tp);
  }
}

function reportTargetPlan({ target, plan }: TargetPlan): void {
  const lines: string[] = [`Plan [${target.label}]:`];

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
    lines.push(`  ${color.yellow(sym.conflict)} ${s.path}  ${dim("(skipped:")} ${dim(s.reason)}${dim(")")}`);
  }

  if (plan.updatesAvailable.length > 0) {
    lines.push("");
    lines.push(`  ${dim("Updates available:")}`);
    for (const u of plan.updatesAvailable) {
      lines.push(`    ${color.cyan(sym.update)} ${u.id}  ${dim(`${u.fromVersion} → ${u.toVersion}`)}`);
    }
  }

  p.log.message(lines.join("\n"));
}

function summarize(writtenCount: number, conflictCount: number): string {
  const parts: string[] = [];
  if (writtenCount > 0) parts.push(color.green(`${writtenCount} written`));
  if (conflictCount > 0) parts.push(color.red(`${conflictCount} conflict kept`));
  return parts.length > 0 ? `${dim("—")} ${parts.join(dim(", "))}` : "";
}
