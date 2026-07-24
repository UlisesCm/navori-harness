import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { NavoriError } from "./errors.ts";
import { safeHomedir } from "./home.ts";
import { ENGINES, LANGUAGES, tolerantEnum, tolerantEnumArray } from "./schema.ts";
import type { NavoriConfig } from "./config.ts";
import { loadPlugin } from "./plugins.ts";

/**
 * Global (persona) config — the source of truth for the `~/.claude` render
 * target (spec 0005). Deliberately LEANER than NavoriConfig: the persona has no
 * stack, so there is no `preset`, `qualityGate`, `harness`, `sdd`, `monorepo` or
 * `features` here. Those are all repo-scoped (spec 0004). What the persona owns
 * is identity: language, which engines have a user level, which identity plugins
 * to enable, and whether to manage the permission allowlist.
 *
 * Lives at `~/.navori/global.json` — sibling of `~/.navori/workspaces/` and the
 * backups that already live under `~/.navori`.
 */
const GlobalPluginEntrySchema = z.object({ enabled: z.boolean() });

export const GlobalConfigSchema = z
  .object({
    $schema: z.string().optional(),
    language: tolerantEnum(LANGUAGES, "es"),
    // engines is optional here (unlike NavoriConfig): a persona defaults to
    // claude. Inject the default before the tolerant array so an omitted field
    // doesn't trip the `.min(1)` "expected array" error.
    engines: z.preprocess((v) => v ?? ["claude"], tolerantEnumArray(ENGINES, "claude")),
    /** Identity plugins to render at global scope (engram, ponytail…). Only
     * plugins whose manifest `allowedScopes` includes "global" are valid here;
     * `validateGlobalPlugins` surfaces any that aren't. */
    plugins: z.record(z.string(), GlobalPluginEntrySchema).default({}),
    /** Manage the permission allowlist in `~/.claude/settings.json`. `true`
     * writes the navori baseline; `false` leaves settings untouched. A string
     * names a future named preset (reserved; treated as truthy for now). */
    permissions: z.union([z.boolean(), z.string()]).default(true),
    /** Manage the navori Claude Code Output Style. `true` (default) writes
     * `<dotDir>/output-styles/navori.md` from core-assets and makes navori
     * eligible for activation in settings.json; `false` stops managing it and
     * removes navori's own untouched style file on the next render. This is the
     * PERSISTENT intent — distinct from the per-run `--no-output-style` flag,
     * which only skips ACTIVATION (the file is still written). Global-scope only;
     * the repo target never renders an output style. */
    outputStyle: z.boolean().default(true),
  })
  .passthrough();

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;
export type GlobalConfigInput = z.input<typeof GlobalConfigSchema>;

const SCHEMA_URL = "https://navori.dev/schema/navori.global.v1.json";

export class GlobalConfigError extends NavoriError {
  readonly issues?: z.ZodIssue[];
  constructor(message: string, issues?: z.ZodIssue[]) {
    super("global-config-invalid", message);
    this.issues = issues;
  }
}

/** `~/.navori/global.json` — the global config source of truth. Uses safeHomedir
 * (mockable in tests) so it never resolves against the CWD when HOME is unset. */
export function globalConfigPath(): string {
  return join(safeHomedir(), ".navori", "global.json");
}

/** Read the global config, or null when it does not exist yet (clean machine). */
export function readGlobalConfig(path: string = globalConfigPath()): GlobalConfig | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8").replace(/^﻿/, "");
  } catch (err) {
    throw new GlobalConfigError(`Cannot read ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new GlobalConfigError(`Invalid JSON in ${path}: ${(err as Error).message}`);
  }
  const result = GlobalConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new GlobalConfigError(`Validation failed for ${path}`, result.error.issues);
  }
  return result.data;
}

export function writeGlobalConfig(config: GlobalConfigInput, path: string = globalConfigPath()): void {
  const validated = GlobalConfigSchema.parse({ $schema: SCHEMA_URL, ...config });
  mkdirSync(dirname(path), { recursive: true }); // ~/.navori may not exist yet
  writeFileAtomic(path, JSON.stringify(validated, null, 2) + "\n");
}

/**
 * Enabled plugins declared in the global config whose manifest does NOT allow
 * the global scope — a config smell the global doctor surfaces. An unknown /
 * unloadable plugin is reported separately (via the shared missing-plugin path),
 * so it is skipped here rather than double-counted.
 */
export function validateGlobalPlugins(config: GlobalConfig): Array<{ id: string; reason: string }> {
  const offenders: Array<{ id: string; reason: string }> = [];
  for (const [id, settings] of Object.entries(config.plugins ?? {})) {
    if (settings.enabled !== true) continue;
    let manifest;
    try {
      manifest = loadPlugin(id).manifest;
    } catch {
      continue; // unknown/broken plugin — reported elsewhere
    }
    if (!(manifest.allowedScopes as readonly string[]).includes("global")) {
      offenders.push({ id, reason: "plugin no permite scope global (allowedScopes)" });
    }
  }
  return offenders;
}

/**
 * Adapt a GlobalConfig into the NavoriConfig shape the Claude engine consumes.
 * The engine and computeRenderPlan are written against NavoriConfig; rather than
 * fork them, the global render feeds a synthetic NavoriConfig that carries only
 * the fields a global render reads (language, engines, plugins) plus the two
 * required-by-schema stubs (`name`, `preset`). `preset: "custom"` guarantees no
 * preset extras load; the scope filter drops every repo-only block regardless.
 */
export function globalConfigToNavoriConfig(config: GlobalConfig): NavoriConfig {
  return {
    name: "global",
    version: "1.0.0",
    engines: config.engines,
    preset: "custom",
    language: config.language,
    branchBase: "main",
    commits: "conventional-es",
    plugins: config.plugins,
  } as unknown as NavoriConfig;
}

/** Whether the global config asks navori to manage the permission allowlist. */
export function globalPermissionsEnabled(config: GlobalConfig): boolean {
  return config.permissions !== false;
}

/** Whether the global config asks navori to manage its Output Style file. */
export function globalOutputStyleEnabled(config: GlobalConfig): boolean {
  return config.outputStyle !== false;
}
