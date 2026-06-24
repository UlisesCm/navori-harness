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
  return result.data;
}

export type { NavoriConfig, NavoriConfigInput };
