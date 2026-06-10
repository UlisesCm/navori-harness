import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { readConfig } from "../lib/config.ts";
import { computeRenderPlan, type AssetPlanEntry } from "../lib/render-plan.ts";
import { writeFileAtomic } from "../lib/atomic.ts";
import { createBackup, purgeOldBackups } from "../lib/backup.ts";
import { renderStatusSymbol, renderStatusLabel, dim, color, brand } from "../lib/style.ts";

/**
 * Run the render flow against `cwd`. Reusable from other commands (e.g. init).
 * Returns the plan summary for the caller to print.
 */
export function runRender(cwd: string, dryRun = false): {
  ok: boolean;
  reason?: string;
  filePath: string;
  entries: AssetPlanEntry[];
  written: boolean;
  languageFallbacks: string[];
  updatesAvailable: Array<{ id: string; source: string; fromVersion: string; toVersion: string }>;
  backupPath?: string | null;
} {
  const configPath = `${cwd}/navori.config.json`;
  const claudeMdPath = `${cwd}/CLAUDE.md`;

  if (!existsSync(configPath)) {
    return {
      ok: false,
      reason: `No navori.config.json at ${configPath}`,
      filePath: claudeMdPath,
      entries: [],
      written: false,
      languageFallbacks: [],
      updatesAvailable: [],
      backupPath: null,
    };
  }

  const config = readConfig(configPath);
  const existing = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, "utf-8") : "";
  const plan = computeRenderPlan(existing, config);

  let backupPath: string | null = null;
  if (plan.changed && !dryRun) {
    // Backup BEFORE writing, only when the target file exists (first
    // render has nothing to back up).
    if (existsSync(claudeMdPath)) {
      const handle = createBackup(cwd, ["CLAUDE.md"]);
      backupPath = handle.path;
      purgeOldBackups();
    }
    writeFileAtomic(claudeMdPath, plan.next);
  }

  return {
    ok: true,
    filePath: claudeMdPath,
    entries: plan.entries,
    written: plan.changed && !dryRun,
    languageFallbacks: plan.languageFallbacks,
    updatesAvailable: plan.updatesAvailable,
    backupPath,
  };
}

export const renderCommand = defineCommand({
  meta: {
    name: "render",
    description: "Render managed Core blocks into CLAUDE.md based on navori.config.json",
  },
  args: {
    cwd: { type: "string", description: "Directory to render into (default: cwd)" },
    "dry-run": { type: "boolean", description: "Show what would change without writing" },
  },
  async run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());

    p.intro(brand("render"));

    if (!existsSync(cwd)) {
      p.cancel(`Directory not found: ${cwd}`);
      process.exit(1);
    }

    const result = runRender(cwd, Boolean(args["dry-run"]));
    if (!result.ok) {
      p.cancel(`${result.reason}. Run 'navori init' first.`);
      process.exit(1);
    }

    reportPlan(result.filePath, result.entries, result.written, Boolean(args["dry-run"]));
    if (result.languageFallbacks.length > 0) {
      p.log.warn(
        `Language fallback to Spanish for: ${result.languageFallbacks.join(", ")} (English version not available yet)`,
      );
    }
    if (result.backupPath) {
      p.log.message(`${dim("Backup:")} ${result.backupPath}`);
    }
    const summary = summarize(result.entries);
    if (args["dry-run"]) {
      p.outro(`${dim("Dry-run complete")} ${summary}`);
    } else if (result.written) {
      p.outro(`${color.green("Done")} ${summary}`);
    } else {
      p.outro(`${dim("Up to date")} ${summary}`);
    }
  },
});

function summarize(entries: AssetPlanEntry[]): string {
  const counts = entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.status] = (acc[e.status] ?? 0) + 1;
    return acc;
  }, {});
  const parts: string[] = [];
  if (counts.created) parts.push(color.green(`${counts.created} created`));
  if (counts.updated) parts.push(color.yellow(`${counts.updated} updated`));
  if (counts["user-modified-skipped"]) parts.push(color.red(`${counts["user-modified-skipped"]} conflict`));
  if (counts["removed-condition-false"]) parts.push(color.magenta(`${counts["removed-condition-false"]} removed`));
  if (counts.unchanged) parts.push(dim(`${counts.unchanged} unchanged`));
  return parts.length > 0 ? `${dim("—")} ${parts.join(dim(", "))}` : "";
}

function reportPlan(file: string, entries: AssetPlanEntry[], changed: boolean, dryRun: boolean): void {
  const lines: string[] = [file];
  for (const e of entries) {
    const sym = renderStatusSymbol(e.status);
    const label = renderStatusLabel(e.status);
    lines.push(`  ${sym} ${e.asset.id}  ${dim("(")}${label}${dim(")")}`);
  }
  if (changed && !dryRun) lines.push(`  ${dim("→ written")}`);
  else if (dryRun) lines.push(`  ${dim("→ dry-run, no write")}`);
  else lines.push(`  ${dim("→ no changes")}`);
  p.log.message(lines.join("\n"));
}
