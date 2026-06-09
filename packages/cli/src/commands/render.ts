import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { CORE_MANAGED_ASSETS, resolveAssetPath } from "@navori/core";
import { readConfig, type NavoriConfig } from "../lib/config.ts";
import {
  injectManagedSection,
  removeManagedSection,
  resolveCondition,
  type InjectResult,
} from "../lib/marker.ts";
import { writeFileAtomic } from "../lib/atomic.ts";

interface RenderSummary {
  file: string;
  perAsset: Array<{ id: string; status: InjectResult["status"] | "removed-condition-false" }>;
  written: boolean;
}

export const renderCommand = defineCommand({
  meta: {
    name: "render",
    description: "Render managed Core blocks into CLAUDE.md based on navori.config.json",
  },
  args: {
    cwd: {
      type: "string",
      description: "Directory to render into (default: current working directory)",
    },
    "dry-run": {
      type: "boolean",
      description: "Show what would change without writing",
    },
  },
  async run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    const configPath = `${cwd}/navori.config.json`;
    const claudeMdPath = `${cwd}/CLAUDE.md`;

    p.intro("navori-ai render");

    if (!existsSync(configPath)) {
      p.cancel(`No navori.config.json at ${configPath}. Run 'navori-ai init' first.`);
      process.exit(1);
    }

    const config = readConfig(configPath);

    const existing = existsSync(claudeMdPath)
      ? readFileSync(claudeMdPath, "utf-8")
      : "";

    const summary = renderClaudeMd(claudeMdPath, existing, config, Boolean(args["dry-run"]));

    reportSummary(summary, args["dry-run"]);

    p.outro(args["dry-run"] ? "Dry-run complete (no files written)" : "Done");
  },
});

function renderClaudeMd(
  filePath: string,
  existing: string,
  config: NavoriConfig,
  dryRun: boolean,
): RenderSummary {
  let working = existing;
  const perAsset: RenderSummary["perAsset"] = [];

  for (const asset of CORE_MANAGED_ASSETS) {
    if (asset.condition) {
      const truthy = resolveCondition(config as unknown as Record<string, unknown>, asset.condition);
      if (!truthy) {
        const before = working;
        working = removeManagedSection(working, asset.id);
        perAsset.push({
          id: asset.id,
          status: before === working ? "unchanged" : "removed-condition-false",
        });
        continue;
      }
    }

    const content = readFileSync(resolveAssetPath(asset), "utf-8");
    const result = injectManagedSection(working, asset.id, content);
    perAsset.push({ id: asset.id, status: result.status });
    working = result.output;
  }

  const changed = working !== existing;
  if (changed && !dryRun) {
    writeFileAtomic(filePath, working);
  }

  return {
    file: filePath,
    perAsset,
    written: changed && !dryRun,
  };
}

function reportSummary(summary: RenderSummary, dryRun: boolean): void {
  const lines: string[] = [];
  lines.push(summary.file);
  for (const entry of summary.perAsset) {
    const symbol = symbolFor(entry.status);
    lines.push(`  ${symbol} ${entry.id}  (${entry.status})`);
  }
  if (summary.written) {
    lines.push("  → written");
  } else if (dryRun) {
    lines.push("  → dry-run, no write");
  } else {
    lines.push("  → no changes");
  }
  p.log.message(lines.join("\n"));
}

function symbolFor(status: RenderSummary["perAsset"][number]["status"]): string {
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
