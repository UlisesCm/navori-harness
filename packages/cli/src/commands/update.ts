import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeConfig, type NavoriConfig } from "../lib/config.ts";
import { readConfigOrExit } from "../lib/cli-config.ts";
import { detectProject } from "../lib/detect.ts";
import { scanMonorepoWorkspaces } from "../lib/scan.ts";
import { runRender, formatDowngradeWarning } from "./render.ts";
import type { UpdateAvailable } from "../lib/render-plan.ts";
import { brand, dim, color, accent, sym, type RenderStatus } from "../lib/style.ts";

/** Progress keys removed from the schema (#75). `update` cleans them when it
 * rewrites config so the "dead keys" warning doesn't recur forever (#79). */
const DEAD_PROGRESS_KEYS = ["checkpointsDir", "archiveAfterDays"] as const;

interface AggregatedRender {
  writes: Array<{ path: string; status: RenderStatus; scope: string }>;
  conflicts: Array<{ path: string; reason: string; scope: string }>;
  updates: UpdateAvailable[];
  downgrades: UpdateAvailable[];
}

/**
 * Flatten a runRender result — root engine + every workspace + the non-Claude
 * engines (AGENTS.md) — into single lists. `update` used to read only the root
 * `engineResult`, so in a monorepo `--dry-run` hid workspace/agents-md writes
 * and `--yes` wrote them without reporting (#79 crítico 3).
 */
export function aggregateRender(result: ReturnType<typeof runRender>): AggregatedRender {
  const writes: AggregatedRender["writes"] = [];
  const conflicts: AggregatedRender["conflicts"] = [];
  const updates: UpdateAvailable[] = [];
  const downgrades: UpdateAvailable[] = [];

  const addEngine = (
    scope: string,
    eng?: {
      written: Array<{ path: string; status: RenderStatus }>;
      skipped: Array<{ path: string; reason: string }>;
    },
  ): void => {
    for (const w of eng?.written ?? []) writes.push({ ...w, scope });
    for (const s of eng?.skipped ?? []) conflicts.push({ ...s, scope });
  };

  addEngine("root", result.engineResult);
  for (const ee of result.extraEngines ?? []) addEngine(`root · ${ee.engine}`, ee);
  updates.push(...(result.updatesAvailable ?? []));
  downgrades.push(...(result.downgrades ?? []));

  for (const ws of result.workspaces) {
    addEngine(ws.workspaceName, ws.engineResult);
    for (const ee of ws.extraEngines) addEngine(`${ws.workspaceName} · ${ee.engine}`, ee);
    updates.push(...ws.updatesAvailable);
    downgrades.push(...ws.downgrades);
  }

  return { writes, conflicts, updates, downgrades };
}

/** Which dead progress keys the on-disk config still carries (for cleanup). */
export function deadProgressKeys(raw: Record<string, unknown>): string[] {
  const progress = raw.progress;
  if (!progress || typeof progress !== "object") return [];
  return DEAD_PROGRESS_KEYS.filter((k) => k in (progress as Record<string, unknown>));
}

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

type MigrationEntry = { legacy: string; preferred: string; domain: string };
function sameMigrations(a: readonly MigrationEntry[], b: readonly MigrationEntry[]): boolean {
  if (a.length !== b.length) return false;
  const key = (m: MigrationEntry) => `${m.legacy}|${m.preferred}|${m.domain}`;
  const seen = new Set(a.map(key));
  return b.every((m) => seen.has(key(m)));
}

/**
 * #90 — reconcile `project.libraryMigrations` (which `init` AUTO-populates from
 * detection) with a fresh detection, keyed by `legacy`, so new migrations are
 * still adopted while genuine manual edits survive. Three cases per `legacy`:
 *
 *   - detected legacy NOT in config → NEW pair → adopt it (append).
 *   - legacy in both but `preferred`/`domain` differ → the user hand-edited the
 *     successor → real override → keep the CONFIG pair and flag it.
 *   - config legacy no longer detected → keep it (the "removed the legacy dep
 *     but want to remember the rule" case from the original #90 fix).
 *
 * Returns the merged set (config entries first, then newly-detected ones, for a
 * stable/idempotent write) plus the config pairs the user actually overrode
 * (so the caller only warns about REAL overrides, not plain new adoptions).
 */
export function mergeLibraryMigrations(
  current: readonly MigrationEntry[],
  detected: readonly MigrationEntry[],
): { merged: MigrationEntry[]; changedOverrides: MigrationEntry[] } {
  const detByLegacy = new Map(detected.map((m) => [m.legacy, m]));
  const curLegacies = new Set(current.map((m) => m.legacy));
  const merged: MigrationEntry[] = [];
  const changedOverrides: MigrationEntry[] = [];

  for (const cur of current) {
    merged.push(cur); // every existing pair is preserved…
    const det = detByLegacy.get(cur.legacy);
    // …and when detection disagrees on the SAME legacy, the user's edit wins.
    if (det && (det.preferred !== cur.preferred || det.domain !== cur.domain)) {
      changedOverrides.push(cur);
    }
  }
  for (const det of detected) {
    if (!curLegacies.has(det.legacy)) merged.push(det); // brand-new → adopt
  }
  return { merged, changedOverrides };
}

/** Merge a patch into the raw `project` object, tolerating it being absent. */
function withProject(current: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  const base = current && typeof current === "object" ? (current as Record<string, unknown>) : {};
  return { ...base, ...patch };
}

/**
 * Re-home per-workspace library skills + migrations in a monorepo config by
 * re-scanning each workspace's package.json. A config written before per-
 * workspace scoping — or by a pre-#80 navori that aggregated every workspace's
 * libs onto the root — has stale/absent `monorepo.workspaces[].libraries`; this
 * migrates those libs onto the workspace that actually ships them instead of
 * letting them vanish when the root array is trimmed to root-only. Mutates
 * `raw` in place; returns true when any workspace entry changed. No-op (and no
 * spurious write) when every workspace is already correctly scoped.
 */
export function refreshWorkspaceScopes(raw: Record<string, unknown>, cwd: string): boolean {
  const mono = raw.monorepo as { workspaces?: Array<Record<string, unknown>> } | undefined;
  if (!mono?.workspaces?.length) return false;
  const byPath = new Map(scanMonorepoWorkspaces(cwd).map((s) => [s.path, s]));
  let changed = false;
  for (const ws of mono.workspaces) {
    const det = byPath.get(ws.path as string);
    if (!det) continue; // orphan (path gone) — leave as-is; render skips it
    const curLibs = (ws.libraries as string[] | undefined) ?? [];
    if (!sameSet(curLibs, det.libraries)) {
      if (det.libraries.length > 0) ws.libraries = det.libraries;
      else delete ws.libraries;
      changed = true;
    }
    const curMigs = (ws.libraryMigrations as MigrationEntry[] | undefined) ?? [];
    if (!sameMigrations(curMigs, det.migrations)) {
      if (det.migrations.length > 0) ws.libraryMigrations = det.migrations;
      else delete ws.libraryMigrations;
      changed = true;
    }
  }
  return changed;
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

  // Library migrations — reconciled by `legacy` (see mergeLibraryMigrations, #90)
  // so a NEW detected pair is adopted while a hand-edited successor survives. We
  // diff against the MERGED set, not raw detection, so a manual override never
  // reads as "drift to overwrite".
  const currentMigs = current.project?.libraryMigrations ?? [];
  const { merged: mergedMigs } = mergeLibraryMigrations(currentMigs, detected.migrations);
  if (!sameMigrations(currentMigs, mergedMigs)) {
    const fmt = (ms: readonly MigrationEntry[]) =>
      ms.length ? ms.map((m) => `${m.legacy}→${m.preferred}`).join(", ") : "(none)";
    out.push({
      field: "project.libraryMigrations",
      before: fmt(currentMigs),
      after: fmt(mergedMigs),
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
    } else if (d.field === "project.libraryMigrations") {
      // Apply the reconciled merge (adopt new, preserve overrides), not raw
      // detection — recomputed here from `raw` for the same deterministic result.
      const rawProject = raw.project as { libraryMigrations?: MigrationEntry[] } | undefined;
      const { merged } = mergeLibraryMigrations(rawProject?.libraryMigrations ?? [], detected.migrations);
      raw.project = withProject(raw.project, { libraryMigrations: merged });
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

    const config = readConfigOrExit(configPath);
    const detected = detectProject(cwd);
    const diffs = diffConfig(config, detected);

    // #90: `project.libraryMigrations` is reconciled by `legacy` in diffConfig/
    // applyDiffs (new pairs adopted, hand-edited successors preserved). Here we
    // only surface the REAL manual overrides — a config pair whose successor the
    // user changed away from detection — so they know we're honoring their edit
    // (and NOT clobbering it), without crying "override" on a plain new adoption.
    const { changedOverrides } = mergeLibraryMigrations(
      config.project?.libraryMigrations ?? [],
      detected.migrations,
    );
    if (changedOverrides.length > 0) {
      const detByLegacy = new Map(detected.migrations.map((m) => [m.legacy, m]));
      const detail = changedOverrides
        .map((m) => {
          const det = detByLegacy.get(m.legacy);
          return `${m.legacy}→${m.preferred}${det ? ` (detección sugiere ${det.legacy}→${det.preferred})` : ""}`;
        })
        .join(", ");
      p.log.info(
        `project.libraryMigrations: respeto tu override manual — ${detail}. No lo sobrescribo; edítalo a mano si quieres adoptar la sugerencia.`,
      );
    }

    const rawConfig = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    const deadKeys = deadProgressKeys(rawConfig);
    // Re-home per-workspace library skills (mutates rawConfig). Persisted below
    // with the other config writes; the apply-pass render then materializes them.
    const wsScopesChanged = refreshWorkspaceScopes(rawConfig, cwd);
    const willWriteConfig = diffs.length > 0 || deadKeys.length > 0 || wsScopesChanged;

    // Preview the FULL engine render (CLAUDE.md + the .claude/ tree) against the
    // current config, aggregating root + every workspace + non-Claude engines.
    // This surfaces bundle / version drift a config-field diff can't see — new
    // core skills, settings fixes, the skills-index — and is the same engine the
    // apply pass runs, so the preview matches what will happen.
    const preview = runRender(cwd, true);
    const agg = aggregateRender(preview);

    if (!willWriteConfig && agg.writes.length === 0 && agg.conflicts.length === 0 && agg.downgrades.length === 0) {
      p.outro("Up to date — nothing to update");
      return;
    }

    if (diffs.length > 0) {
      const lines = diffs.map(
        (d) => `  ${color.yellow(sym.updated)} ${accent(d.field)}${dim(":")} ${color.red(d.before)} ${dim("→")} ${color.green(d.after)}`,
      );
      p.log.info(`Config drift detected (${diffs.length}):\n${lines.join("\n")}`);
    } else if (!wsScopesChanged) {
      p.log.info("Config is in sync with the repo");
    }

    if (wsScopesChanged) {
      p.log.info("Re-homed per-workspace library skills onto monorepo.workspaces[] (scoping migration)");
    }

    if (deadKeys.length > 0) {
      p.log.info(`Claves obsoletas en "progress" que se limpiarán: ${deadKeys.join(", ")}`);
    }

    if (agg.writes.length > 0) {
      const shown = agg.writes
        .slice(0, 12)
        .map((w) => `  ${color.cyan(sym.update)} ${dim(`[${w.scope}]`)} ${w.path} ${dim(`(${w.status})`)}`);
      const more = agg.writes.length > 12 ? `\n  ${dim(`… +${agg.writes.length - 12} más`)}` : "";
      p.log.info(`Archivos que se actualizarían (${agg.writes.length}):\n${shown.join("\n")}${more}`);
    }

    if (agg.updates.length > 0) {
      const lines = agg.updates.map(
        (u) => `  ${color.cyan(sym.update)} ${u.id}  ${dim(`(${u.source}  ${u.fromVersion} → ${u.toVersion})`)}`,
      );
      p.log.info(`Managed block updates available (${agg.updates.length}):\n${lines.join("\n")}`);
    }

    if (agg.conflicts.length > 0) {
      p.log.warn(`${agg.conflicts.length} archivo(s) con ediciones tuyas — 'navori sync' los resuelve interactivamente`);
    }

    // Anti-retroceso (#79): shown even with --yes — a silent downgrade is the
    // exact failure this guards against.
    const downgradeWarn = formatDowngradeWarning(agg.downgrades);
    if (downgradeWarn) p.log.warn(downgradeWarn);

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
    if (!args.yes && willWriteConfig) {
      const ok = await p.confirm({
        message: `Apply config changes + re-render?`,
        initialValue: true,
      });
      if (p.isCancel(ok) || !ok) {
        p.cancel("Aborted");
        return;
      }
    }

    // Apply config diffs first so the render below reflects them. Unknown enum
    // values (a future engine written by a newer navori) survive because
    // writeConfig preserves forward-compat enums (#79 crítico 2).
    if (willWriteConfig) {
      delete rawConfig.$schema;
      applyDiffs(rawConfig, detected, diffs);
      if (deadKeys.length > 0 && rawConfig.progress && typeof rawConfig.progress === "object") {
        for (const k of deadKeys) delete (rawConfig.progress as Record<string, unknown>)[k];
      }
      writeConfig(configPath, rawConfig as Parameters<typeof writeConfig>[1]);
      p.log.success(`Updated ${configPath}`);
    }

    if (args["config-only"]) {
      p.outro("Config updated. Corre 'navori sync' para refrescar CLAUDE.md + .claude/.");
      return;
    }

    // Full engine sync: CLAUDE.md + the .claude/ tree (skills, agents, settings,
    // hooks). Re-detected library skills and preset shifts only materialize here.
    // (Earlier this re-rendered CLAUDE.md alone, leaving the .claude/ tree stale.)
    let result: ReturnType<typeof runRender>;
    try {
      result = runRender(cwd, false);
    } catch (err) {
      // A mid-write render crash used to bubble a raw citty stack, leaving the
      // config updated and the tree partial. Surface a clean message with the
      // backup breadcrumb the engine's RenderWriteError carries (#79).
      p.log.error(err instanceof Error ? err.message : String(err));
      p.outro("El render falló tras actualizar el config — revisa el backup y corre 'navori render --apply'");
      return;
    }
    if (!result.ok) {
      p.log.error(result.reason ?? "Render failed");
      p.outro("Done (config actualizado, pero el render falló)");
      return;
    }
    const applied = aggregateRender(result);
    if (applied.conflicts.length > 0) {
      p.log.warn(`${applied.conflicts.length} archivo(s) con ediciones tuyas no se tocaron — 'navori sync' para resolver`);
    }
    const applyDowngradeWarn = formatDowngradeWarning(applied.downgrades);
    if (applyDowngradeWarn) p.log.warn(applyDowngradeWarn);
    if (applied.writes.length > 0) {
      p.log.success(`Re-rendered ${applied.writes.length} archivo(s) (CLAUDE.md + .claude/, incluidos workspaces)`);
    } else {
      p.log.info("No re-render needed");
    }

    p.outro("Done");
  },
});
