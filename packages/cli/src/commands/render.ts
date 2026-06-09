import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { readConfig } from "../lib/config.ts";
import { computeRenderPlan, type AssetPlanEntry } from "../lib/render-plan.ts";
import { writeFileAtomic } from "../lib/atomic.ts";

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
    };
  }

  const config = readConfig(configPath);
  const existing = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, "utf-8") : "";
  const plan = computeRenderPlan(existing, config);

  if (plan.changed && !dryRun) {
    writeFileAtomic(claudeMdPath, plan.next);
  }

  return {
    ok: true,
    filePath: claudeMdPath,
    entries: plan.entries,
    written: plan.changed && !dryRun,
    languageFallbacks: plan.languageFallbacks,
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

    p.intro("navori-ai render");

    const result = runRender(cwd, Boolean(args["dry-run"]));
    if (!result.ok) {
      p.cancel(`${result.reason}. Run 'navori-ai init' first.`);
      process.exit(1);
    }

    reportPlan(result.filePath, result.entries, result.written, Boolean(args["dry-run"]));
    if (result.languageFallbacks.length > 0) {
      p.log.warn(
        `Language fallback to Spanish for: ${result.languageFallbacks.join(", ")} (English version not available yet)`,
      );
    }
    p.outro(args["dry-run"] ? "Dry-run complete (no files written)" : "Done");
  },
});

function reportPlan(file: string, entries: AssetPlanEntry[], changed: boolean, dryRun: boolean): void {
  const lines: string[] = [file];
  for (const e of entries) {
    const sym = symbolFor(e.status);
    lines.push(`  ${sym} ${e.asset.id}  (${e.status})`);
  }
  if (changed && !dryRun) lines.push("  → written");
  else if (dryRun) lines.push("  → dry-run, no write");
  else lines.push("  → no changes");
  p.log.message(lines.join("\n"));
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
