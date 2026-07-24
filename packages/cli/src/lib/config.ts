import { readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { NavoriError } from "./errors.ts";
import { NavoriConfigSchema, type NavoriConfig, type NavoriConfigInput } from "./schema.ts";

const SCHEMA_URL = "https://navori.dev/schema/navori.config.v1.json";

/**
 * The tolerant enum schema DROPS unknown values on parse (issue #70) so an old
 * CLI can still *read* a config a newer navori wrote. But dropping them on
 * WRITE makes the loss permanent on disk — a stale CLI running `update` would
 * strip e.g. a future engine out of a config a teammate checked in (#79 crítico
 * 2). This mirrors the top-level `.passthrough()` intent for the enum fields
 * validation transforms: keep whatever the input carried, so forward-compat
 * data round-trips untouched. A newer CLI later re-recognizes it; an older one
 * keeps ignoring it in memory (with the read-time warning).
 */
function preserveForwardCompatEnums(
  input: NavoriConfigInput,
  validated: NavoriConfig,
): NavoriConfig {
  const raw = input as Record<string, unknown>;
  const out = { ...(validated as Record<string, unknown>) };

  if (Array.isArray(raw.engines)) {
    const strings = [...new Set(raw.engines.filter((e): e is string => typeof e === "string"))];
    if (strings.length > 0) out.engines = strings;
  }

  for (const key of ["commits", "language"] as const) {
    const rawVal = raw[key];
    if (typeof rawVal === "string" && rawVal !== (validated as Record<string, unknown>)[key]) {
      out[key] = rawVal;
    }
  }

  return out as NavoriConfig;
}

export function writeConfig(path: string, input: NavoriConfigInput): void {
  const validated = NavoriConfigSchema.parse({ $schema: SCHEMA_URL, ...input });
  const preserved = preserveForwardCompatEnums(input, validated);
  writeFileAtomic(path, JSON.stringify(preserved, null, 2) + "\n");
}

/**
 * Return a config with derived defaults filled in for rendering only — never
 * for persistence. Kept out of the schema on purpose: a schema transform would
 * persist the derived values into every config on the next write. Idempotent.
 *
 * Derives:
 *  - `prTarget`: falls back to branchBase so `{{prTarget}}` always resolves.
 *  - `project.typedLanguage`: whether the TS-ecosystem baseline (e.g. the
 *    `any`/`unknown` `tipado-fuerte` block) applies. Suppressed only for
 *    languages where it plainly doesn't (python/rust/go). Absent/unknown is
 *    treated as JS/TS so configs written before `codeLanguage` existed keep it.
 *  - `sdd`: defaults `enabled` to true and `specsDir` to "specs" so the SDD
 *    managed block (`condition: "sdd.enabled"`) renders by default even when a
 *    config omits the `sdd` section. Opt out with `"sdd": { "enabled": false }`.
 */
export function effectiveConfig(config: NavoriConfig): NavoriConfig {
  const codeLanguage = config.project?.codeLanguage;
  const typedLanguage = !(
    codeLanguage === "python" ||
    codeLanguage === "rust" ||
    codeLanguage === "go"
  );
  return {
    ...config,
    prTarget: config.prTarget ?? config.branchBase,
    project: { ...(config.project ?? {}), typedLanguage } as NavoriConfig["project"],
    sdd: {
      ...(config.sdd ?? {}),
      enabled: config.sdd?.enabled ?? true,
      specsDir: config.sdd?.specsDir ?? "specs",
      applyWhen: config.sdd?.applyWhen ?? [],
      doesNotApplyTo: config.sdd?.doesNotApplyTo ?? [],
    },
  };
}

export class ConfigError extends NavoriError {
  readonly issues?: z.ZodIssue[];
  constructor(message: string, issues?: z.ZodIssue[]) {
    super("config-invalid", message);
    this.issues = issues;
  }
}

export function readConfig(path: string): NavoriConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8").replace(/^﻿/, ""); // strip BOM if present
  } catch (err) {
    throw new ConfigError(`Cannot read ${path}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`Invalid JSON in ${path}: ${(err as Error).message}`);
  }

  const result = NavoriConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(`Validation failed for ${path}`, result.error.issues);
  }
  warnDroppedEnums(parsed, result.data);
  warnRemovedProgressKeys(parsed);
  return result.data;
}

/**
 * Surface (stderr, so stdout stays clean for --json) any enum values the
 * tolerant schema dropped — i.e. this config was likely written by a newer
 * navori. Silent dropping would hide that the CLI is out of date. Issue #70.
 */
function warnDroppedEnums(raw: unknown, parsed: NavoriConfig): void {
  if (!raw || typeof raw !== "object") return;
  const r = raw as Record<string, unknown>;
  const dropped: string[] = [];
  if (Array.isArray(r.engines)) {
    for (const e of r.engines) {
      if (typeof e === "string" && !(parsed.engines as string[]).includes(e)) {
        dropped.push(`engines: "${e}"`);
      }
    }
  }
  for (const key of ["commits", "language"] as const) {
    const v = r[key];
    if (typeof v === "string" && v !== parsed[key]) dropped.push(`${key}: "${v}"`);
  }
  if (dropped.length > 0) {
    process.stderr.write(
      `navori: valores de config desconocidos ignorados (¿config de un navori más nuevo? actualiza el CLI): ${dropped.join(", ")}\n`,
    );
  }
}

/**
 * `progress.checkpointsDir` / `progress.archiveAfterDays` were removed from
 * the schema (issue #75) — nothing ever consumed them. Old configs that still
 * carry them keep validating (z.object strips unknown keys), but warn softly
 * so users know they can delete the dead keys.
 */
function warnRemovedProgressKeys(raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const progress = (raw as Record<string, unknown>).progress;
  if (!progress || typeof progress !== "object") return;
  const removed = ["checkpointsDir", "archiveAfterDays"].filter(
    (key) => key in (progress as Record<string, unknown>),
  );
  if (removed.length > 0) {
    process.stderr.write(
      `navori: claves obsoletas ignoradas en "progress" (puedes borrarlas del navori.config.json): ${removed.join(", ")}\n`,
    );
  }
}

export type { NavoriConfig, NavoriConfigInput };
