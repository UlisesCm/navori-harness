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

/**
 * Load a preset definition by id from the bundled core (or workspace dev
 * tree). Returns null when the preset file does not exist — the caller
 * decides whether that is a soft fallback (preset = "custom" → no extras)
 * or a hard error (preset = "medusa" but file missing → warn).
 *
 * Throws PresetError when the file exists but cannot be parsed or fails
 * schema validation, so a malformed preset is loud, not silent.
 */
export function loadPreset(id: string): PresetDefinition | null {
  const path = resolve(getCoreRoot(), "core-assets/presets", `${id}.json`);
  if (!existsSync(path)) return null;

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8").replace(/^﻿/, "");
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
  return result.data;
}
