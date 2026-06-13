import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readConfig } from "../lib/config.ts";
import type { AssetPlanEntry, UpdateAvailable } from "../lib/render-plan.ts";
import {
  renderClaudeEngine,
  type ClaudeEngineResult,
} from "../engines/claude/index.ts";
import { renderStatusSymbol, renderStatusLabel, dim, color, brand } from "../lib/style.ts";

/**
 * Run the render flow against `cwd`. Reusable from other commands (e.g. init).
 * Returns a back-compat shape so existing callers (init.ts) keep working,
 * plus the full engine result for new callers.
 */
export function runRender(cwd: string, dryRun = false): {
  ok: boolean;
  reason?: string;
  filePath: string;
  entries: AssetPlanEntry[];
  written: boolean;
  languageFallbacks: string[];
  updatesAvailable: UpdateAvailable[];
  backupPath?: string | null;
  engineResult?: ClaudeEngineResult;
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
  const engineResult = renderClaudeEngine(cwd, config, { dryRun });

  return {
    ok: true,
    filePath: claudeMdPath,
    entries: engineResult.claudeMdEntries,
    written: engineResult.written.length > 0,
    languageFallbacks: engineResult.languageFallbacks,
    updatesAvailable: engineResult.updatesAvailable,
    backupPath: engineResult.backupPath,
    engineResult,
  };
}

export const renderCommand = defineCommand({
  meta: {
    name: "render",
    description: "Render managed Core blocks into CLAUDE.md + .claude/ from navori.config.json",
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

    reportClaudeMd(result.filePath, result.entries, result.written, Boolean(args["dry-run"]));
    if (result.engineResult) {
      reportEngineFiles(result.engineResult);
    }
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

function reportClaudeMd(file: string, entries: AssetPlanEntry[], changed: boolean, dryRun: boolean): void {
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

function reportEngineFiles(engine: ClaudeEngineResult): void {
  // CLAUDE.md is reported separately by reportClaudeMd; filter it out here
  // so the user sees ".claude/" entries under the ".claude/" header only.
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

  const lines: string[] = [".claude/"];
  for (const w of written) {
    const sym = renderStatusSymbol(w.status);
    const label = renderStatusLabel(w.status);
    lines.push(`  ${sym} ${w.path}  ${dim("(")}${label}${dim(")")}`);
  }
  for (const s of engine.skipped) {
    lines.push(`  ${color.yellow("!")} ${s.path}  ${dim("(")}${color.yellow("skipped")}${dim(")")}`);
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
