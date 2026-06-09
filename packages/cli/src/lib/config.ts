import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import {
  NavoriConfigSchema,
  type NavoriConfig,
  type NavoriConfigInput,
} from "./schema.ts";

const SCHEMA_URL = "https://navori.dev/schema/navori.config.v1.json";

export function writeConfig(path: string, input: NavoriConfigInput): void {
  const validated = NavoriConfigSchema.parse({ $schema: SCHEMA_URL, ...input });
  writeFileSync(path, JSON.stringify(validated, null, 2) + "\n", "utf-8");
}

export class ConfigError extends Error {
  constructor(message: string, public readonly issues?: z.ZodIssue[]) {
    super(message);
    this.name = "ConfigError";
  }
}

export function readConfig(path: string): NavoriConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
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
