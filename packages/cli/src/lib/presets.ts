import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { getCoreRoot } from "./bundled-assets.ts";
import { safeRelPath } from "./zod-helpers.ts";
import { NavoriError } from "./errors.ts";

/**
 * Preset definition — describes EXTRA managed assets a stack-specific preset
 * contributes ON TOP of the core baseline (CORE_MANAGED_ASSETS + CORE_AGENTS +
 * CORE_SKILLS in render-plan.ts / claude engine).
 *
 * The model is purely additive: a preset never removes or replaces baseline
 * assets, it only declares more. This keeps preset.json small and the merge
 * logic trivial. If we ever need to suppress a baseline asset we can add an
 * explicit `disable: ["asset-id"]` field — out of scope for fase 2.
 *
 * relPath fields are validated as safe relative paths (no `..`, no leading
 * `/`) so a preset cannot reach outside the core package.
 */

const PresetExtraManagedSchema = z.object({
  id: z.string().min(1),
  relPath: safeRelPath,
});

const PresetExtraFileSchema = z.object({
  id: z.string().min(1),
  relPath: safeRelPath,
  /** Where in `.claude/` the file lands (e.g. "skills/medusa-db-migrations.md"). */
  destRelPath: safeRelPath,
});

export const PresetDefinitionSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, "preset id must be kebab-case"),
  displayName: z.string().min(1),
  /** Only "core" is supported in fase 2 — the baseline always applies. */
  extends: z.literal("core").default("core"),
  extras: z
    .object({
      managed: z.array(PresetExtraManagedSchema).default([]),
      agents: z.array(PresetExtraFileSchema).default([]),
      skills: z.array(PresetExtraFileSchema).default([]),
      hooks: z.array(PresetExtraFileSchema).default([]),
    })
    .default({ managed: [], agents: [], skills: [], hooks: [] }),
  /**
   * Load-bearing substrings that MUST appear verbatim in the rendered output
   * when this preset is active. Same contract as PluginManifest.invariants —
   * `navori doctor` fails when any disappears. Spec 0003 §3.1.1.
   */
  invariants: z.array(z.string().min(1)).default([]),
});

export type PresetDefinition = z.infer<typeof PresetDefinitionSchema>;
export type PresetExtraManaged = z.infer<typeof PresetExtraManagedSchema>;
export type PresetExtraFile = z.infer<typeof PresetExtraFileSchema>;

export class PresetError extends NavoriError {
  readonly issues?: z.ZodIssue[];
  constructor(message: string, issues?: z.ZodIssue[]) {
    super("preset-invalid", message);
    this.issues = issues;
  }
}

/** Where a resolved preset's manifest + assets live, and its origin. */
export interface ResolvedPreset {
  source: "local" | "bundled";
  /** Absolute path to the `<id>.json` manifest. */
  jsonPath: string;
  /**
   * Root the preset's `extras.*.relPath` resolve against. For a local preset
   * this is the preset folder (`.navori/presets/<id>`); for a bundled preset
   * it's `core-assets/` (whose relPath already include `presets/<id>/`).
   */
  assetRoot: string;
}

/** A parsed preset definition plus the root its extras resolve against. */
export interface LoadedPreset {
  def: PresetDefinition;
  assetRoot: string;
  source: "local" | "bundled";
}

/**
 * Resolve a preset id to its manifest + asset root, LOCAL FIRST.
 *
 * A project can ship its own presets under `.navori/presets/<id>/<id>.json`
 * (checked in next to navori.config.json). Those WIN over a bundled preset of
 * the same id, so a team can override an official preset. `repoRoot` is the
 * repo root where `.navori/` lives — in a monorepo this is the root, not a
 * workspace dir (local presets are shared across workspaces).
 *
 * Returns null when neither a local nor a bundled manifest exists, and for
 * `"custom"` (the no-extras baseline, which has no manifest).
 */
export function resolvePreset(id: string, repoRoot: string): ResolvedPreset | null {
  if (id === "custom") return null;

  const localDir = resolve(repoRoot, ".navori/presets", id);
  const localJson = resolve(localDir, `${id}.json`);
  if (existsSync(localJson)) {
    return { source: "local", jsonPath: localJson, assetRoot: localDir };
  }

  const bundledJson = resolve(getCoreRoot(), "core-assets/presets", `${id}.json`);
  if (existsSync(bundledJson)) {
    return {
      source: "bundled",
      jsonPath: bundledJson,
      assetRoot: resolve(getCoreRoot(), "core-assets"),
    };
  }

  return null;
}

/**
 * True when a preset id has a backing definition file in the BUNDLED core.
 * Deliberately ignores local presets: the detector uses this to decide the
 * "gap" — whether an OFFICIAL preset exists for a recognized stack — which is
 * independent of whatever a project scaffolded locally. `"custom"` is the
 * canonical no-extras baseline and always counts as existing.
 */
export function presetExists(id: string): boolean {
  if (id === "custom") return true;
  const path = resolve(getCoreRoot(), "core-assets/presets", `${id}.json`);
  return existsSync(path);
}

/**
 * Load a preset definition by id, local-first (see resolvePreset). Returns
 * null when the preset does not exist — the caller decides whether that is a
 * soft fallback (preset = "custom" → no extras) or a hard error (declared
 * preset whose file is missing → warn).
 *
 * Throws PresetError when the manifest exists but cannot be parsed or fails
 * schema validation, so a malformed preset is loud, not silent.
 */
export function loadPreset(id: string, repoRoot: string): LoadedPreset | null {
  const resolved = resolvePreset(id, repoRoot);
  if (!resolved) return null;

  let raw: string;
  try {
    raw = readFileSync(resolved.jsonPath, "utf-8").replace(/^﻿/, "");
  } catch (err) {
    throw new PresetError(`Cannot read preset '${id}': ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new PresetError(`Invalid JSON in preset '${id}': ${(err as Error).message}`);
  }

  const result = PresetDefinitionSchema.safeParse(parsed);
  if (!result.success) {
    throw new PresetError(`Validation failed for preset '${id}'`, result.error.issues);
  }
  return { def: result.data, assetRoot: resolved.assetRoot, source: resolved.source };
}
