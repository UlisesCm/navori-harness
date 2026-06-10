import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readConfig, writeConfig, type NavoriConfig } from "../lib/config.ts";
import { detectProject } from "../lib/detect.ts";
import { computeRenderPlan } from "../lib/render-plan.ts";
import { writeFileAtomic } from "../lib/atomic.ts";
import { createBackup, purgeOldBackups } from "../lib/backup.ts";
import { brand, dim, color, accent, sym } from "../lib/style.ts";

interface ConfigDiff {
  field: string;
  before: string;
  after: string;
}

function diffConfig(current: NavoriConfig, detected: ReturnType<typeof detectProject>): ConfigDiff[] {
  const out: ConfigDiff[] = [];

  // Preset
  if (current.preset !== detected.suggestedPreset && detected.suggestedPreset !== "custom") {
    out.push({ field: "preset", before: current.preset, after: detected.suggestedPreset });
  }

  // Quality gate (only suggest if the project gained new scripts)
  if (detected.qualityGate) {
    const beforeFast = current.qualityGate?.fast ?? "(none)";
    const beforeFull = current.qualityGate?.full ?? "(none)";
    if (beforeFast !== detected.qualityGate.fast) {
      out.push({ field: "qualityGate.fast", before: beforeFast, after: detected.qualityGate.fast });
    }
    if (beforeFull !== detected.qualityGate.full) {
      out.push({ field: "qualityGate.full", before: beforeFull, after: detected.qualityGate.full });
    }
  }

  // Branch base only when detection has a real value and config differs
  if (detected.branchBase && current.branchBase !== detected.branchBase) {
    out.push({ field: "branchBase", before: current.branchBase, after: detected.branchBase });
  }

  // Engines (suggest adding ones detected in the repo, not removing)
  const currentEngines = new Set(current.engines);
  const newlyDetected = detected.existingEngines.filter((e) => !currentEngines.has(e as typeof current.engines[number]));
  if (newlyDetected.length > 0) {
    out.push({
      field: "engines",
      before: current.engines.join(", "),
      after: [...current.engines, ...newlyDetected].join(", "),
    });
  }

  return out;
}

function applyDiffs(raw: Record<string, unknown>, detected: ReturnType<typeof detectProject>, diffs: ConfigDiff[]): void {
  for (const d of diffs) {
    if (d.field === "preset") {
      raw.preset = detected.suggestedPreset;
    } else if (d.field === "qualityGate.fast" || d.field === "qualityGate.full") {
      raw.qualityGate = detected.qualityGate ?? raw.qualityGate;
    } else if (d.field === "branchBase") {
      raw.branchBase = detected.branchBase;
    } else if (d.field === "engines") {
      const currentEngines = new Set(((raw.engines as string[]) ?? []));
      for (const e of detected.existingEngines) currentEngines.add(e);
      raw.engines = [...currentEngines];
    }
  }
}

export const updateCommand = defineCommand({
  meta: {
    name: "update",
    description: "Re-detect the repo, refresh config and run sync (one shot 'bring me up to date')",
  },
  args: {
    cwd: { type: "string", description: "Directory (default: cwd)" },
    yes: { type: "boolean", description: "Apply detected diffs and sync without prompting" },
    "dry-run": { type: "boolean", description: "Show what would change, do not write" },
    "config-only": { type: "boolean", description: "Update config but skip the sync step" },
  },
  async run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    const configPath = `${cwd}/navori.config.json`;

    p.intro(brand("update"));

    if (!existsSync(cwd)) {
      p.cancel(`Directory not found: ${cwd}`);
      process.exit(1);
    }

    if (!existsSync(configPath)) {
      p.cancel(`No navori.config.json at ${configPath}. Run 'navori init' first.`);
      process.exit(1);
    }

    const config = readConfig(configPath);
    const detected = detectProject(cwd);
    const diffs = diffConfig(config, detected);

    // Render plan with current config to surface updates available
    const claudeMd = existsSync(`${cwd}/CLAUDE.md`) ? readFileSync(`${cwd}/CLAUDE.md`, "utf-8") : "";
    const plan = computeRenderPlan(claudeMd, config);

    // Report
    if (diffs.length === 0 && !plan.changed && plan.updatesAvailable.length === 0) {
      p.outro("Up to date — nothing to update");
      return;
    }

    if (diffs.length > 0) {
      const lines = diffs.map(
        (d) => `  ${color.yellow(sym.updated)} ${accent(d.field)}${dim(":")} ${color.red(d.before)} ${dim("→")} ${color.green(d.after)}`,
      );
      p.log.info(`Config drift detected (${diffs.length}):\n${lines.join("\n")}`);
    } else {
      p.log.info("Config is in sync with the repo");
    }

    if (plan.updatesAvailable.length > 0) {
      const lines = plan.updatesAvailable.map(
        (u) => `  ${color.cyan(sym.update)} ${u.id}  ${dim(`(${u.source}  ${u.fromVersion} → ${u.toVersion})`)}`,
      );
      p.log.info(`Managed block updates available (${plan.updatesAvailable.length}):\n${lines.join("\n")}`);
    }

    const conflicts = plan.entries.filter((e) => e.status === "user-modified-skipped");
    if (conflicts.length > 0) {
      p.log.warn(`${conflicts.length} conflict(s) in managed blocks — sync will need a decision`);
    }

    if (args["dry-run"]) {
      p.outro("Dry-run complete (no files written)");
      return;
    }

    // Confirm apply
    if (!args.yes && diffs.length > 0) {
      const ok = await p.confirm({
        message: `Apply ${diffs.length} config update${diffs.length === 1 ? "" : "s"}?`,
        initialValue: true,
      });
      if (p.isCancel(ok) || !ok) {
        p.cancel("Aborted");
        return;
      }
    }

    // Apply config diffs
    if (diffs.length > 0) {
      const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      delete raw.$schema;
      applyDiffs(raw, detected, diffs);
      writeConfig(configPath, raw as Parameters<typeof writeConfig>[1]);
      p.log.success(`Updated ${configPath}`);
    }

    if (args["config-only"]) {
      p.outro("Config updated. Run 'navori sync' when ready to refresh CLAUDE.md.");
      return;
    }

    // Run sync (re-render after possible config changes)
    if (plan.changed || plan.updatesAvailable.length > 0 || diffs.length > 0) {
      const freshConfig = readConfig(configPath);
      const claudeMdNow = existsSync(`${cwd}/CLAUDE.md`) ? readFileSync(`${cwd}/CLAUDE.md`, "utf-8") : "";
      const freshPlan = computeRenderPlan(claudeMdNow, freshConfig);
      const fresheConflicts = freshPlan.entries.filter((e) => e.status === "user-modified-skipped");

      if (fresheConflicts.length > 0 && !args.yes) {
        p.log.warn(
          `${fresheConflicts.length} conflict(s) detected — run 'navori sync' to resolve interactively`,
        );
        p.outro("Done (config updated, sync deferred due to conflicts)");
        return;
      }

      if (freshPlan.changed) {
        if (existsSync(`${cwd}/CLAUDE.md`)) {
          const handle = createBackup(cwd, ["CLAUDE.md"]);
          purgeOldBackups();
          p.log.message(`Backup: ${handle.path}`);
        }
        writeFileAtomic(`${cwd}/CLAUDE.md`, freshPlan.next);
        p.log.success(`Re-rendered ${cwd}/CLAUDE.md`);
      } else {
        p.log.info("No re-render needed");
      }
    }

    p.outro("Done");
  },
});
