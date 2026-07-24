import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { getCoreRoot } from "./bundled-assets.ts";
import { NavoriError } from "./errors.ts";

/**
 * Feature manifest (spec 0004) — a multi-phase workflow that orchestrates N
 * existing skills toward a SINGLE deliverable, with a quality gate between
 * phases. A feature introduces NO new runtime: the existing orchestrator
 * (leader) executes it. The manifest only tells the leader, per phase, which
 * skills to compose and which gate to pass before advancing.
 *
 * Source lives in `core-assets/features/<id>/` (bundled) or a local
 * `.navori/features/<id>/` override (local-first, mirroring presets). Each
 * bundle is `feature.json` (this manifest) + `FEATURE.md` (the orchestration
 * contract the leader reads) + `phases/<n>-<slug>.md` (per-phase detail, loaded
 * on-demand when the phase runs).
 */

const KEBAB = /^[a-z0-9][a-z0-9-]*$/;

const FeaturePhaseSchema = z.object({
  /** Phase number — ordering key. Unique within a manifest (see superRefine). */
  n: z.number().int().nonnegative(),
  slug: z.string().regex(KEBAB, "phase slug must be kebab-case"),
  /** What the phase produces. */
  objetivo: z.string().min(1),
  /** Ids of existing skills this phase composes (reuse, not copy). MAY reference
   * ids navori does not bundle — doctor warns, never errors (the skill can be a
   * user global or come from an external CLI). */
  skills: z.array(z.string()).default([]),
  /** Condition to satisfy before advancing (mechanical command or human sign-off). */
  gate: z.string().min(1),
  /** Files / topic keys the phase leaves written. Optional. */
  artifacts: z.array(z.string()).optional(),
  /** Optional tier hints for delegating this phase. */
  model: z.string().optional(),
  effort: z.string().optional(),
});

export const FeatureManifestSchema = z
  .object({
    $schema: z.string().optional(),
    id: z.string().regex(KEBAB, "feature id must be kebab-case"),
    displayName: z.string().min(1),
    /** Must carry natural-language triggers — it becomes the rendered SKILL.md
     * `description`, which is how Claude Code loads the mother skill on-demand. */
    description: z.string().min(1),
    type: z.literal("feature"),
    /** `bootstrap` features CREATE the project (their output is the repo itself,
     * e.g. app-builder); `in-repo` features operate on an existing project. The
     * distinction changes the activation path (init --feature vs add feature). */
    kind: z.enum(["bootstrap", "in-repo"]).default("in-repo"),
    phases: z.array(FeaturePhaseSchema).min(1, "a feature needs at least one phase"),
    /** Load-bearing substrings that MUST appear verbatim in the rendered output.
     * Same contract as plugin/preset invariants — doctor fails when one vanishes
     * (e.g. the render ate a phase). Spec 0004 §4. */
    invariants: z.array(z.string().min(1)).default([]),
  })
  .superRefine((val, ctx) => {
    const seen = new Set<number>();
    for (const ph of val.phases) {
      if (seen.has(ph.n)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["phases"],
          message: `duplicate phase n=${ph.n} — phase numbers must be unique`,
        });
      }
      seen.add(ph.n);
    }
  });

export type FeatureManifest = z.infer<typeof FeatureManifestSchema>;
export type FeaturePhase = z.infer<typeof FeaturePhaseSchema>;

export class FeatureError extends NavoriError {
  readonly issues?: z.ZodIssue[];
  constructor(message: string, issues?: z.ZodIssue[]) {
    super("feature-invalid", message);
    this.issues = issues;
  }
}

/** Where a resolved feature bundle lives, and its origin. */
export interface ResolvedFeature {
  source: "local" | "bundled";
  /** Absolute path to the feature directory. */
  dir: string;
  /** Absolute path to `feature.json`. */
  jsonPath: string;
}

/** A parsed feature manifest plus the directory its assets resolve against. */
export interface LoadedFeature {
  manifest: FeatureManifest;
  dir: string;
  source: "local" | "bundled";
}

/**
 * Resolve a feature id to its bundle directory, LOCAL FIRST (mirrors
 * `resolvePreset`). A repo can ship its own feature under
 * `.navori/features/<id>/feature.json`; it WINS over a bundled feature of the
 * same id. `repoRoot` is where `.navori/` lives (the monorepo root, not a
 * workspace dir). Returns null when neither a local nor a bundled bundle exists.
 */
export function resolveFeature(id: string, repoRoot: string): ResolvedFeature | null {
  // A feature id is a flat slug: a path separator or `..` traversal is rejected
  // up front so a config-supplied id can never resolve outside the features dirs
  // (mirrors resolveLocalSkillPath in skill-meta.ts). Defense-in-depth: the schema
  // already enforces kebab-case, but this guards the direct callers too.
  if (id === "" || id !== id.trim() || /[\\/]/.test(id) || id.split(/[\\/]/).includes("..") || id.includes("..")) {
    return null;
  }
  const localDir = resolve(repoRoot, ".navori/features", id);
  const localJson = resolve(localDir, "feature.json");
  if (existsSync(localJson)) return { source: "local", dir: localDir, jsonPath: localJson };

  const bundledDir = resolve(getCoreRoot(), "core-assets/features", id);
  const bundledJson = resolve(bundledDir, "feature.json");
  if (existsSync(bundledJson)) return { source: "bundled", dir: bundledDir, jsonPath: bundledJson };

  return null;
}

/** True when a feature id resolves to a bundle (local or bundled). */
export function featureExists(id: string, repoRoot: string): boolean {
  return resolveFeature(id, repoRoot) !== null;
}

/**
 * Load + validate a feature manifest by id (local-first). Returns null when the
 * feature does not exist — the caller decides whether that is a soft skip (with
 * a warning) or an error. Throws FeatureError when `feature.json` exists but is
 * unreadable / malformed / fails schema validation, so a broken feature is loud.
 */
export function loadFeature(id: string, repoRoot: string): LoadedFeature | null {
  const resolved = resolveFeature(id, repoRoot);
  if (!resolved) return null;

  let raw: string;
  try {
    raw = readFileSync(resolved.jsonPath, "utf-8").replace(/^﻿/, "");
  } catch (err) {
    throw new FeatureError(`Cannot read feature '${id}': ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new FeatureError(`Invalid JSON in feature '${id}': ${(err as Error).message}`);
  }

  const result = FeatureManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new FeatureError(`Validation failed for feature '${id}'`, result.error.issues);
  }
  if (result.data.id !== id) {
    throw new FeatureError(
      `Feature id mismatch: directory '${id}' but feature.json declares id '${result.data.id}'`,
    );
  }
  return { manifest: result.data, dir: resolved.dir, source: resolved.source };
}

/**
 * Ids of every feature navori can materialize for this repo: the union of local
 * overrides (`.navori/features/*`) and bundled features (`core-assets/features/*`),
 * each a directory carrying a `feature.json`. Order-stable, deduped, local-first.
 */
export function listFeatureIds(repoRoot: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const roots = [
    resolve(repoRoot, ".navori/features"),
    resolve(getCoreRoot(), "core-assets/features"),
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue;
      if (!existsSync(resolve(root, entry.name, "feature.json"))) continue;
      seen.add(entry.name);
      ids.push(entry.name);
    }
  }
  return ids;
}

/** Provenance source stamped on a feature's rendered managed markers, mirroring
 * the plugin `@navori/plugin-<id>` convention. Used as the ownership-guard token
 * when reconciling deactivated features. */
export function featureSource(id: string): string {
  return `@navori/feature-${id}`;
}
