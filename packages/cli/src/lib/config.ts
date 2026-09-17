import { readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { NavoriError } from "./errors.ts";
import { NavoriConfigSchema, type NavoriConfig, type NavoriConfigInput } from "./schema.ts";
import { tc, resolveLang } from "./i18n.ts";
import { schemaUrl } from "./schema-url.ts";

const SCHEMA_URL = schemaUrl("navori.config.v1.json");

type ConfigObjectRule = {
  /** Keys declared at this JSON object level. */
  keys: readonly string[];
  /** Declared object-valued children that should be checked recursively. */
  children?: Readonly<Record<string, ConfigObjectRule>>;
  /** A record whose keys are intentionally open, but whose values share a shape. */
  recordValues?: ConfigObjectRule;
  /** An array whose object entries share this shape. */
  arrayItems?: ConfigObjectRule;
  /** This level accepts extension keys (for example plugin prompt fields). */
  allowExtensions?: boolean;
};

/**
 * Exported (spec 0026 T8, R42) solely so `roster-parity.test.ts` can verify it
 * against `engines/shared/roster.ts`'s canonical `harnessKey` list without a
 * second hand-copied set living inside the test file itself.
 */
export const AGENT_ROLE_KEYS = [
  "leader",
  "implementer",
  "reviewer",
  "researcher",
  "ticketAudit",
  "commitPrPilot",
  "explorer",
  "auditor",
] as const;

const QUALITY_GATE_RULE: ConfigObjectRule = { keys: ["fast", "full"] };

/**
 * Raw-config key map used for advisory typo diagnostics.
 *
 * This intentionally describes JSON, rather than inspecting Zod internals:
 * Zod's object shape is not a stable public API, while this map makes extension
 * points explicit in the same place as the warning policy. `project` accepts
 * plugin-defined prompt fields and `plugins` accepts arbitrary plugin ids, so
 * their open keys are not reported. We still inspect known nested structures
 * such as `project.foreignHarness` and each plugin entry.
 */
const CONFIG_KEY_RULE: ConfigObjectRule = {
  keys: [
    "$schema",
    "name",
    "version",
    "workspace",
    "engines",
    "preset",
    "language",
    "branchBase",
    "gitignoreHarness",
    "prTarget",
    "commits",
    "qualityGate",
    "hooks",
    "audit",
    "packageManager",
    "sdd",
    "harness",
    "models",
    "effort",
    "plugins",
    "blocks",
    "progress",
    "project",
    "monorepo",
  ],
  children: {
    qualityGate: QUALITY_GATE_RULE,
    hooks: { keys: ["verifyOnStop"] },
    audit: { keys: ["mode"] },
    sdd: { keys: ["enabled", "specsDir", "applyWhen", "doesNotApplyTo"] },
    harness: { keys: AGENT_ROLE_KEYS },
    models: {
      keys: [...AGENT_ROLE_KEYS, "codexMap"],
      children: { codexMap: { keys: ["opus", "sonnet", "haiku"] } },
    },
    effort: { keys: AGENT_ROLE_KEYS },
    plugins: { keys: [], recordValues: { keys: ["enabled"] }, allowExtensions: true },
    blocks: { keys: ["exclude"] },
    progress: { keys: ["dir", "currentFile", "historyFile"] },
    project: {
      keys: [
        "legacyPaths",
        "criticalAreas",
        "testRunner",
        "posture",
        "reviewRigor",
        "architectureRule",
        "testsForNewCode",
        "testsExclude",
        "localSkills",
        "foreignHarness",
        "libraries",
        "libraryMigrations",
        "codeLanguage",
      ],
      // Plugin prompt fields are declared dynamically, so warning on them would
      // turn the supported extension point into noise.
      allowExtensions: true,
      children: {
        foreignHarness: { keys: ["acknowledged"] },
        libraryMigrations: { keys: [], arrayItems: { keys: ["legacy", "preferred", "domain"] } },
      },
    },
    monorepo: {
      keys: ["enabled", "tool", "workspaces", "workspaceHarness"],
      children: {
        workspaces: {
          keys: [],
          arrayItems: {
            keys: ["name", "path", "preset", "qualityGate", "libraries", "libraryMigrations"],
            children: {
              qualityGate: QUALITY_GATE_RULE,
              libraryMigrations: {
                keys: [],
                arrayItems: { keys: ["legacy", "preferred", "domain"] },
              },
            },
          },
        },
      },
    },
  },
};

export type UnknownConfigKey = {
  path: string;
  suggestion?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizedKey(value: string): string {
  return value.replace(/[-_]/g, "").toLowerCase();
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    let diagonal = previous[0]!;
    previous[0] = row;
    for (let column = 1; column <= right.length; column++) {
      const above = previous[column]!;
      previous[column] = Math.min(
        previous[column]! + 1,
        previous[column - 1]! + 1,
        diagonal + Number(left[row - 1] !== right[column - 1]),
      );
      diagonal = above;
    }
  }
  return previous[right.length]!;
}

function closestKey(key: string, candidates: readonly string[]): string | undefined {
  const normalized = normalizedKey(key);
  const exactFormatMatch = candidates.find((candidate) => normalizedKey(candidate) === normalized);
  if (exactFormatMatch) return exactFormatMatch;

  let closest: string | undefined;
  let distance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const candidateDistance = editDistance(normalized, normalizedKey(candidate));
    if (candidateDistance < distance) {
      closest = candidate;
      distance = candidateDistance;
    }
  }
  return distance <= Math.max(2, Math.floor(normalized.length * 0.3)) ? closest : undefined;
}

/**
 * Finds unknown keys without rejecting or rewriting the raw config. Keeping
 * this advisory preserves both custom prompt fields and configs produced by a
 * newer navori version.
 */
export function findUnknownConfigKeys(raw: unknown): UnknownConfigKey[] {
  const unknown: UnknownConfigKey[] = [];

  const visit = (value: unknown, rule: ConfigObjectRule, path: string): void => {
    if (Array.isArray(value)) {
      if (rule.arrayItems) {
        value.forEach((item, index) => visit(item, rule.arrayItems!, `${path}[${index}]`));
      }
      return;
    }
    if (!isRecord(value)) return;

    for (const key of Object.keys(value)) {
      if (!rule.keys.includes(key) && !rule.allowExtensions) {
        const suggestion = closestKey(key, rule.keys);
        unknown.push({
          path: path ? `${path}.${key}` : key,
          ...(suggestion ? { suggestion } : {}),
        });
      }
    }

    for (const [key, childRule] of Object.entries(rule.children ?? {})) {
      if (key in value) visit(value[key], childRule, path ? `${path}.${key}` : key);
    }
    if (rule.recordValues) {
      for (const [key, child] of Object.entries(value)) {
        visit(child, rule.recordValues, path ? `${path}.${key}` : key);
      }
    }
  };

  visit(raw, CONFIG_KEY_RULE, "");
  return unknown;
}

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
  warnUnknownConfigKeys(parsed, result.data.language);
  warnDroppedEnums(parsed, result.data);
  warnRemovedProgressKeys(parsed, result.data.language);
  warnDeprecatedConfigKeys(parsed, result.data.language);
  return result.data;
}

/**
 * A Zod schema has two deliberately tolerant modes: `.passthrough()` retains
 * unknown keys and normal `z.object()` drops them. Both used to make a typo
 * silent. Diagnose either shape from the raw JSON, but never reject it: a newer
 * navori may legitimately have added the key and an older CLI must still run.
 */
function warnUnknownConfigKeys(raw: unknown, language: unknown): void {
  const unknown = findUnknownConfigKeys(raw);
  if (unknown.length === 0) return;
  const listed = unknown
    .map(({ path, suggestion }) => {
      if (!suggestion) return path;
      const parent = path.lastIndexOf(".");
      const suggestedPath = parent < 0 ? suggestion : `${path.slice(0, parent + 1)}${suggestion}`;
      return `${path} → ${suggestedPath}`;
    })
    .join(", ");
  process.stderr.write(`${tc(resolveLang(language)).common.unknownConfigKeys(listed)}\n`);
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
      `${tc(resolveLang(parsed.language)).common.unknownConfigValues(dropped.join(", "))}\n`,
    );
  }
}

/**
 * `progress.checkpointsDir` / `progress.archiveAfterDays` were removed from
 * the schema (issue #75) — nothing ever consumed them. Old configs that still
 * carry them keep validating (z.object strips unknown keys), but warn softly
 * so users know they can delete the dead keys.
 */
function warnRemovedProgressKeys(raw: unknown, language: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const progress = (raw as Record<string, unknown>).progress;
  if (!progress || typeof progress !== "object") return;
  const removed = ["checkpointsDir", "archiveAfterDays"].filter(
    (key) => key in (progress as Record<string, unknown>),
  );
  if (removed.length > 0) {
    process.stderr.write(
      `${tc(resolveLang(language)).common.deadProgressKeys(removed.join(", "))}\n`,
    );
  }
}

/**
 * These fields are accepted for backwards compatibility, but are not fully
 * honoured during a running session. Warn instead of silently promising a
 * configurable runtime path / test runner that the renderer does not supply.
 */
function warnDeprecatedConfigKeys(raw: unknown, language: unknown): void {
  if (!isRecord(raw)) return;
  const deprecated: string[] = [];
  if (isRecord(raw.project) && "testRunner" in raw.project) {
    deprecated.push("project.testRunner");
  }
  if (isRecord(raw.progress)) {
    for (const key of ["dir", "currentFile", "historyFile"]) {
      if (key in raw.progress) deprecated.push(`progress.${key}`);
    }
  }
  if (deprecated.length > 0) {
    process.stderr.write(
      `${tc(resolveLang(language)).common.deprecatedConfigKeys(deprecated.join(", "))}\n`,
    );
  }
}

export type { NavoriConfig, NavoriConfigInput };
