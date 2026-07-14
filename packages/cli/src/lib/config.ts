import { readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { NavoriError } from "./errors.ts";
import {
  NavoriConfigSchema,
  type NavoriConfig,
  type NavoriConfigInput,
} from "./schema.ts";

const SCHEMA_URL = "https://navori.dev/schema/navori.config.v1.json";

export function writeConfig(path: string, input: NavoriConfigInput): void {
  const validated = NavoriConfigSchema.parse({ $schema: SCHEMA_URL, ...input });
  writeFileAtomic(path, JSON.stringify(validated, null, 2) + "\n");
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
 */
export function effectiveConfig(config: NavoriConfig): NavoriConfig {
  const codeLanguage = config.project?.codeLanguage;
  const typedLanguage = !(
    codeLanguage === "python" || codeLanguage === "rust" || codeLanguage === "go"
  );
  return {
    ...config,
    prTarget: config.prTarget ?? config.branchBase,
    project: { ...(config.project ?? {}), typedLanguage } as NavoriConfig["project"],
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
    throw new ConfigError(
      `Validation failed for ${path}`,
      result.error.issues,
    );
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
