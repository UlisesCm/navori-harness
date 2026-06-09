import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readConfig } from "../lib/config.ts";
import { computeRenderPlan, applyPlanWithSkips, type AssetPlanEntry } from "../lib/render-plan.ts";
import { extractManagedContent } from "../lib/marker.ts";
import { writeFileAtomic } from "../lib/atomic.ts";
import { createBackup, purgeOldBackups } from "../lib/backup.ts";
import { formatLineDiff } from "../lib/diff.ts";

export const syncCommand = defineCommand({
  meta: {
    name: "sync",
    description: "Pull updates from managed Core into local files (with backups and conflict prompts)",
  },
  args: {
    cwd: { type: "string", description: "Directory to sync (default: cwd)" },
    "dry-run": { type: "boolean", description: "Show plan, do not write" },
    apply: { type: "boolean", description: "Apply changes (skip interactive prompt)" },
    yes: { type: "boolean", description: "Auto-confirm. Implies --apply. Fails with exit 1 if conflicts exist." },
    "no-backup": { type: "boolean", description: "Skip backup before writing (not recommended)" },
  },
  async run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    const configPath = `${cwd}/navori.config.json`;
    const claudeMdPath = `${cwd}/CLAUDE.md`;

    p.intro("navori-ai sync");

    if (!existsSync(configPath)) {
      p.cancel(`No navori.config.json at ${configPath}. Run 'navori-ai init' first.`);
      process.exit(1);
    }

    const config = readConfig(configPath);
    const existing = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, "utf-8") : "";
    const plan = computeRenderPlan(existing, config);

    reportPlan(plan.entries);

    const conflicts = plan.entries.filter((e) => e.status === "user-modified-skipped");
    const hasOtherChanges = plan.changed;

    if (!hasOtherChanges && conflicts.length === 0) {
      p.outro("Up to date — no changes");
      return;
    }

    // --dry-run: just report, never write
    if (args["dry-run"]) {
      if (conflicts.length > 0) renderConflictDiffs(existing, conflicts);
      const summary = [
        conflicts.length > 0 ? `${conflicts.length} conflict(s)` : null,
        hasOtherChanges ? "other changes pending" : null,
      ].filter(Boolean).join(", ");
      p.outro(`Dry-run complete${summary ? ` — ${summary}` : ""}`);
      return;
    }

    // --yes implies --apply
    const autoApply = Boolean(args.yes || args.apply);

    if (args.yes && conflicts.length > 0) {
      p.cancel(`${conflicts.length} conflict(s) detected with --yes. Resolve interactively or use --apply alone.`);
      process.exit(1);
    }

    // Interactive flow
    let applyConflicts = false;

    if (!autoApply) {
      if (conflicts.length > 0) {
        renderConflictDiffs(existing, conflicts);
        const choice = await p.select({
          message: `Found ${conflicts.length} conflict(s). What do you want to do?`,
          options: [
            { value: "skip-conflicts", label: "Apply non-conflict changes, keep my edits in conflicts" },
            { value: "apply-all", label: "Apply ALL changes (overwrite my edits in conflicts)" },
            { value: "abort", label: "Abort — write nothing" },
          ],
        });
        if (p.isCancel(choice) || choice === "abort") {
          p.cancel("Aborted");
          process.exit(0);
        }
        applyConflicts = choice === "apply-all";
      } else {
        const ok = await p.confirm({
          message: "Apply changes?",
          initialValue: true,
        });
        if (p.isCancel(ok) || !ok) {
          p.cancel("Aborted");
          process.exit(0);
        }
      }
    }

    // Build the final content
    const skipIds = !applyConflicts
      ? new Set(conflicts.map((c) => c.asset.id))
      : new Set<string>();
    const finalContent = applyPlanWithSkips(existing, config, skipIds);

    if (finalContent === existing) {
      p.outro("Nothing to apply after conflict resolution");
      return;
    }

    // Backup before writing
    let backupPath: string | null = null;
    if (!args["no-backup"]) {
      const handle = createBackup(cwd, ["CLAUDE.md"]);
      backupPath = handle.path;
      const purged = purgeOldBackups();
      if (purged.length > 0) {
        p.log.info(`Purged ${purged.length} backup(s) older than 30 days`);
      }
    }

    writeFileAtomic(claudeMdPath, finalContent);
    p.log.success(`Wrote ${claudeMdPath}`);
    if (backupPath) p.log.message(`Backup: ${backupPath}`);

    p.outro("Done");
  },
});

function reportPlan(entries: AssetPlanEntry[]): void {
  const lines: string[] = [];
  for (const e of entries) {
    const sym = symbolFor(e.status);
    const cond = e.asset.condition ? ` [cond: ${e.asset.condition}]` : "";
    lines.push(`  ${sym} ${e.asset.id}  (${e.status})${cond}`);
  }
  p.log.message(["Plan:", ...lines].join("\n"));
}

function renderConflictDiffs(existing: string, conflicts: AssetPlanEntry[]): void {
  for (const c of conflicts) {
    const current = extractManagedContent(existing, c.asset.id);
    const diff = formatLineDiff(current, c.newContent);
    p.log.warn(`Conflict in '${c.asset.id}':\n${diff}`);
  }
}

function symbolFor(status: AssetPlanEntry["status"]): string {
  switch (status) {
    case "created":
      return "+";
    case "updated":
      return "~";
    case "unchanged":
      return "·";
    case "user-modified-skipped":
      return "!";
    case "removed-condition-false":
      return "-";
  }
}
