import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readConfig } from "../lib/config.ts";
import { renderClaudeEngine, type ClaudeEngineResult } from "../engines/claude/index.ts";
import { renderStatusSymbol, renderStatusLabel, dim, color, sym, brand } from "../lib/style.ts";

/**
 * `sync` re-runs the Claude engine but exposes the plan up front so the
 * user can pick what to do about user-modified conflicts:
 *
 *   - `.claude/` and CLAUDE.md are both covered (P0-fix B2 — before this,
 *     sync only knew about CLAUDE.md and silently ignored agent / skill /
 *     hook conflicts that doctor was telling the user to "run sync" for).
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

    // Dry-run pass: get the full plan without writing anything.
    const plan = renderClaudeEngine(cwd, config, { dryRun: true });

    reportPlan(plan);

    const conflicts = collectConflicts(plan);
    const hasOtherChanges = plan.written.length > 0;

    if (!hasOtherChanges && conflicts.length === 0) {
      p.outro("Up to date — no changes");
      return;
    }

    // --dry-run: report only, never write
    if (args["dry-run"]) {
      const summary = [
        conflicts.length > 0 ? `${conflicts.length} conflict(s)` : null,
        hasOtherChanges ? `${plan.written.length} pending` : null,
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
    const applied = renderClaudeEngine(cwd, config);

    p.log.success(`Wrote ${applied.written.length} file(s)`);
    if (applied.backupPath) {
      p.log.message(`${dim("Backup:")} ${applied.backupPath}`);
    }

    p.outro(`${color.green("Done")} ${summarize(applied, conflicts.length)}`);
  },
});

interface Conflict {
  path: string;
  reason: string;
}

function collectConflicts(plan: ClaudeEngineResult): Conflict[] {
  const out: Conflict[] = [];
  // CLAUDE.md conflicts surface via claudeMdEntries (legacy flow inside
  // renderClaudeEngine still uses computeRenderPlan).
  for (const e of plan.claudeMdEntries) {
    if (e.status === "user-modified-skipped") {
      out.push({ path: `CLAUDE.md (${e.asset.id})`, reason: "managed block edited" });
    }
  }
  // `.claude/` conflicts come through engine.skipped. The adapter uses the
  // word "editado" / "edited" in the reason for user-modified cases.
  for (const s of plan.skipped) {
    if (/editad|edit/i.test(s.reason)) {
      out.push({ path: s.path, reason: s.reason });
    }
  }
  return out;
}

function reportPlan(plan: ClaudeEngineResult): void {
  const lines: string[] = ["Plan:"];

  // CLAUDE.md managed blocks
  for (const e of plan.claudeMdEntries) {
    const symStr = renderStatusSymbol(e.status);
    const label = renderStatusLabel(e.status);
    const cond = e.asset.condition ? dim(` [cond: ${e.asset.condition}]`) : "";
    lines.push(`  ${symStr} CLAUDE.md:${e.asset.id}  ${dim("(")}${label}${dim(")")}${cond}`);
  }

  // .claude/ files (engine.written in dryRun mode lists what WOULD be written)
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

function summarize(result: ClaudeEngineResult, conflictCount: number): string {
  const parts: string[] = [];
  const counts = result.written.reduce<Record<string, number>>((acc, w) => {
    acc[w.status] = (acc[w.status] ?? 0) + 1;
    return acc;
  }, {});
  if (counts.created) parts.push(color.green(`${counts.created} created`));
  if (counts.updated) parts.push(color.yellow(`${counts.updated} updated`));
  if (conflictCount > 0) {
    parts.push(color.red(`${conflictCount} conflict kept`));
  }
  return parts.length > 0 ? `${dim("—")} ${parts.join(dim(", "))}` : "";
}
