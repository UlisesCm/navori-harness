import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readConfig, writeConfig, type NavoriConfig } from "../lib/config.ts";
import { detectProject } from "../lib/detect.ts";
import { runRender } from "./render.ts";
import { brand, dim, color, accent, sym } from "../lib/style.ts";

interface ConfigDiff {
  field: string;
  before: string;
  after: string;
}

/** Order-independent string-set equality (library-skill ids, engines, …). */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  return b.every((x) => seen.has(x));
}

/** Merge a patch into the raw `project` object, tolerating it being absent. */
function withProject(current: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  const base = current && typeof current === "object" ? (current as Record<string, unknown>) : {};
  return { ...base, ...patch };
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

  // Library skills (detected from deps) — the additive cross-preset layer.
  // Refresh whenever detection and config disagree (a dep added/removed a skill).
  // Without this an existing repo never gains the library-skills architecture.
  const currentLibs = current.project?.libraries ?? [];
  if (!sameSet(currentLibs, detected.libraries)) {
    out.push({
      field: "project.libraries",
      before: currentLibs.length ? currentLibs.join(", ") : "(none)",
      after: detected.libraries.length ? detected.libraries.join(", ") : "(none)",
    });
  }

  // Code language drives the language-aware baseline (e.g. TS-only tipado-fuerte).
  const detectedLang = detected.stack.language;
  if (detectedLang && detectedLang !== "unknown") {
    const currentLang = current.project?.codeLanguage;
    if (currentLang !== detectedLang) {
      out.push({ field: "project.codeLanguage", before: currentLang ?? "(none)", after: detectedLang });
    }
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
    } else if (d.field === "project.libraries") {
      raw.project = withProject(raw.project, { libraries: detected.libraries });
    } else if (d.field === "project.codeLanguage") {
      raw.project = withProject(raw.project, { codeLanguage: detected.stack.language });
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

    // Preview the FULL engine render (CLAUDE.md + the .claude/ tree) against the
    // current config. This surfaces bundle / version drift a config-field diff
    // can't see — new core skills, settings fixes, the skills-index — and is the
    // same engine the apply pass runs, so the preview matches what will happen.
    const preview = runRender(cwd, true);
    const previewWrites = preview.engineResult?.written ?? [];
    const previewConflicts = preview.engineResult?.skipped ?? [];
    const updates = preview.updatesAvailable ?? [];

    if (diffs.length === 0 && previewWrites.length === 0 && previewConflicts.length === 0) {
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

    if (previewWrites.length > 0) {
      const shown = previewWrites
        .slice(0, 12)
        .map((w) => `  ${color.cyan(sym.update)} ${w.path} ${dim(`(${w.status})`)}`);
      const more = previewWrites.length > 12 ? `\n  ${dim(`… +${previewWrites.length - 12} más`)}` : "";
      p.log.info(`Archivos que se actualizarían (${previewWrites.length}):\n${shown.join("\n")}${more}`);
    }

    if (updates.length > 0) {
      const lines = updates.map(
        (u) => `  ${color.cyan(sym.update)} ${u.id}  ${dim(`(${u.source}  ${u.fromVersion} → ${u.toVersion})`)}`,
      );
      p.log.info(`Managed block updates available (${updates.length}):\n${lines.join("\n")}`);
    }

    if (previewConflicts.length > 0) {
      p.log.warn(`${previewConflicts.length} archivo(s) con ediciones tuyas — 'navori sync' los resuelve interactivamente`);
    }

    if (args["dry-run"]) {
      if (diffs.some((d) => d.field === "project.libraries")) {
        p.log.message(
          dim("Nota: aplicar el diff de project.libraries materializa las library skills (el preview de arriba refleja el config actual)."),
        );
      }
      p.outro("Dry-run complete (no files written)");
      return;
    }

    // Confirm apply (the config diffs are the part worth a look; the render skips
    // any managed block you edited by hand rather than clobbering it).
    if (!args.yes && diffs.length > 0) {
      const ok = await p.confirm({
        message: `Apply ${diffs.length} config update${diffs.length === 1 ? "" : "s"} + re-render?`,
        initialValue: true,
      });
      if (p.isCancel(ok) || !ok) {
        p.cancel("Aborted");
        return;
      }
    }

    // Apply config diffs first so the render below reflects them.
    if (diffs.length > 0) {
      const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      delete raw.$schema;
      applyDiffs(raw, detected, diffs);
      writeConfig(configPath, raw as Parameters<typeof writeConfig>[1]);
      p.log.success(`Updated ${configPath}`);
    }

    if (args["config-only"]) {
      p.outro("Config updated. Corre 'navori sync' para refrescar CLAUDE.md + .claude/.");
      return;
    }

    // Full engine sync: CLAUDE.md + the .claude/ tree (skills, agents, settings,
    // hooks). Re-detected library skills and preset shifts only materialize here.
    // (Earlier this re-rendered CLAUDE.md alone, leaving the .claude/ tree stale.)
    const result = runRender(cwd, false);
    if (!result.ok) {
      p.log.error(result.reason ?? "Render failed");
      p.outro("Done (config actualizado, pero el render falló)");
      return;
    }
    const written = result.engineResult?.written ?? [];
    const skipped = result.engineResult?.skipped ?? [];
    if (skipped.length > 0) {
      p.log.warn(`${skipped.length} archivo(s) con ediciones tuyas no se tocaron — 'navori sync' para resolver`);
    }
    if (written.length > 0) {
      p.log.success(`Re-rendered ${written.length} archivo(s) (CLAUDE.md + .claude/)`);
    } else {
      p.log.info("No re-render needed");
    }

    p.outro("Done");
  },
});
