import { readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "../primitives/atomic.ts";
import { NavoriError } from "../primitives/errors.ts";
import { NavoriConfigSchema, type NavoriConfig, type NavoriConfigInput } from "./schema.ts";
import { tc, resolveLang } from "../i18n.ts";
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
  "orchestrator",
  "implementer",
  "reviewer",
  "scout",
  "auditor",
  "publisher",
  "scribe",
  "architect",
] as const;

/**
 * A `harness`/`models`/`effort` key navori used to accept and no longer does,
 * with the key that replaces it (spec 0026 T9/T11, R40/R42).
 *
 * Populated in the SAME commit that removes the old keys from the schema
 * (spec 0026 T11): `leader` → `orchestrator`, `researcher`/`explorer` →
 * `scout` (both map to the same replacement — `checkRetiredConfigKeys`
 * reports both values when they differ), `ticketAudit` → `auditor`,
 * `commitPrPilot` → `publisher`. Same invariant `RETIRED_AGENTS` documents
 * (`engines/shared/roster.ts`): empty until the commit that stops accepting
 * the old key, never before.
 *
 * `replacement` is optional (spec 0032, R33): a key retired WITHOUT a
 * successor — the agent it used to gate now always renders, so there is
 * nothing left to rename onto. `harness.architect` is the first case.
 *
 * `sections` is optional too (spec 0032, R33) and restricts the retirement to
 * a subset of `CONFIG_ROLE_SECTIONS` — absent means all three, the shape every
 * rename above needs (the SAME key retires the same way in harness/models/
 * effort). `harness.architect` needs the opposite: `architect` keeps meaning
 * something in `models`/`effort` (R34 tunes the always-on agent's tier), so
 * only `harness` retires it.
 */
export type RetiredConfigKey = {
  readonly key: string;
  readonly replacement?: string;
  readonly sections?: ReadonlyArray<(typeof CONFIG_ROLE_SECTIONS)[number]>;
};
export const RETIRED_CONFIG_KEYS: ReadonlyArray<RetiredConfigKey> = [
  { key: "leader", replacement: "orchestrator" },
  { key: "researcher", replacement: "scout" },
  { key: "explorer", replacement: "scout" },
  { key: "ticketAudit", replacement: "auditor" },
  { key: "commitPrPilot", replacement: "publisher" },
  // Spec 0032, R33: the architect agent now renders unconditionally — the
  // toggle no longer has effect and there is no replacement key to migrate
  // it onto. Scoped to `harness` only: `models.architect`/`effort.architect`
  // still tune the always-on agent (R34).
  { key: "architect", sections: ["harness"] },
];

/** The three config sections that share `AGENT_ROLE_KEYS`' shape (R40). */
const CONFIG_ROLE_SECTIONS = ["harness", "models", "effort"] as const;

/**
 * R40: a `harness`/`models`/`effort` key retired off the schema fails loud
 * instead of getting silently dropped like a generic unknown key (a plain
 * `z.object()` strips it, and `warnUnknownConfigKeys` only advises). Groups by
 * replacement so two retired keys landing on the same one — the documented
 * case where two agents merge into one role — report both conflicting values
 * in a single line instead of two separate, harder-to-reconcile errors.
 *
 * `retired` is injectable (default `RETIRED_CONFIG_KEYS`) so tests can seed
 * entries without mutating the production registry — same pattern
 * `assertRosterIds` uses for `roster-parity.test.ts`.
 */
export function checkRetiredConfigKeys(
  raw: unknown,
  retired: ReadonlyArray<RetiredConfigKey> = RETIRED_CONFIG_KEYS,
): void {
  if (retired.length === 0 || !isRecord(raw)) return;
  const byReplacement = new Map<string, Array<{ path: string; value: unknown }>>();
  const withoutReplacement: string[] = [];
  for (const section of CONFIG_ROLE_SECTIONS) {
    const sectionValue = raw[section];
    if (!isRecord(sectionValue)) continue;
    for (const { key, replacement, sections } of retired) {
      if (sections && !sections.includes(section)) continue;
      if (!(key in sectionValue)) continue;
      const path = `${section}.${key}`;
      if (replacement === undefined) {
        withoutReplacement.push(path);
        continue;
      }
      const replacementPath = `${section}.${replacement}`;
      const entries = byReplacement.get(replacementPath) ?? [];
      entries.push({ path, value: sectionValue[key] });
      byReplacement.set(replacementPath, entries);
    }
  }
  if (byReplacement.size === 0 && withoutReplacement.length === 0) return;

  // Localized off the RAW `language` key: this fires before the schema parses,
  // so there is no validated config to read it from yet.
  const strings = tc(resolveLang(raw.language)).common;
  const lines = [...byReplacement.entries()].map(([replacementPath, entries]) => {
    const keys = entries.map((e) => e.path).join(", ");
    // `effort.orchestrator` doubles as the session-wide `effortLevel` default
    // (build-settings.ts, spec 0026 T11) — the embodied role has no
    // subagent frontmatter to carry it, so a user fixing this key needs to
    // know it drives more than its own agent's tier.
    const note =
      replacementPath === "effort.orchestrator" ? strings.retiredEffortOrchestratorNote : "";
    if (entries.length === 1) return strings.retiredKeyOne(keys, replacementPath, note);
    const values = entries.map((e) => `${e.path}=${JSON.stringify(e.value)}`).join(", ");
    return strings.retiredKeyAmbiguous(keys, replacementPath, values, note);
  });
  for (const path of withoutReplacement) lines.push(strings.retiredKeyRemoved(path));
  throw new ConfigError(strings.retiredConfigKeys(lines.join("; ")));
}

/** A retired key that was renamed onto its replacement, both fully qualified. */
export type RetiredKeyRename = { readonly from: string; readonly to: string };

/**
 * An N:1 collision `migrateRetiredConfigKeys` refuses to resolve: two retired
 * keys map to the same replacement carrying DIFFERENT values, and the
 * replacement itself is unset. R40's invariant — the value is never inferred.
 */
export type RetiredKeyDecision = {
  readonly target: string;
  readonly candidates: ReadonlyArray<{ readonly path: string; readonly value: unknown }>;
};

export type RetiredKeyMigration = {
  /** Deep-ish copy of the input with every resolvable retired key renamed. */
  readonly config: Record<string, unknown>;
  /** Renames applied (1:1, or N:1 whose values agreed / were chosen). */
  readonly renamed: ReadonlyArray<RetiredKeyRename>;
  /** Retired keys dropped because their replacement was ALREADY set. */
  readonly dropped: ReadonlyArray<RetiredKeyRename>;
  /** Collisions left untouched: the caller must ask, never guess. */
  readonly decisions: ReadonlyArray<RetiredKeyDecision>;
  /** Keys retired WITHOUT a replacement (R33): deleted outright, nothing to rename. */
  readonly removed: ReadonlyArray<{ readonly path: string }>;
};

/**
 * Pure counterpart of `checkRetiredConfigKeys` (R40): instead of throwing, it
 * returns what a repaired config would look like. `checkRetiredConfigKeys`
 * keeps failing exactly as before — this is the tool that lets a command fix
 * the file, since every other entry point goes through `readConfig` and aborts
 * (issue #920).
 *
 * Rules, per `harness`/`models`/`effort` section and per replacement:
 *  - replacement already present → the retired keys are dropped (the
 *    replacement the user already set wins; that is the shape all the
 *    `ticketAudit`/`auditor` pairs in the wild carry).
 *  - exactly one retired key → renamed onto the replacement.
 *  - several retired keys with the SAME value → renamed onto it (nothing to
 *    decide: any choice yields the same config).
 *  - several with DIFFERENT values → a `decisions` entry, unless `choices`
 *    carries the fully-qualified target (e.g. `{"models.scout": "sonnet"}`).
 *    Never inferred: that is the point of R40.
 *
 * Input is not mutated. `retired` is injectable for the same reason
 * `checkRetiredConfigKeys` allows it: tests seed entries without touching the
 * production registry.
 */
export function migrateRetiredConfigKeys(
  raw: unknown,
  choices: Readonly<Record<string, unknown>> = {},
  retired: ReadonlyArray<RetiredConfigKey> = RETIRED_CONFIG_KEYS,
): RetiredKeyMigration {
  const renamed: RetiredKeyRename[] = [];
  const dropped: RetiredKeyRename[] = [];
  const decisions: RetiredKeyDecision[] = [];
  const removed: Array<{ path: string }> = [];
  if (!isRecord(raw)) return { config: {}, renamed, dropped, decisions, removed };

  const config: Record<string, unknown> = { ...raw };
  for (const section of CONFIG_ROLE_SECTIONS) {
    const sectionValue = config[section];
    if (!isRecord(sectionValue)) continue;

    const next = { ...sectionValue };
    const byReplacement = new Map<string, Array<{ key: string; path: string; value: unknown }>>();
    for (const { key, replacement, sections } of retired) {
      if (sections && !sections.includes(section)) continue;
      if (!(key in next)) continue;
      if (replacement === undefined) {
        removed.push({ path: `${section}.${key}` });
        delete next[key];
        continue;
      }
      const entries = byReplacement.get(replacement) ?? [];
      entries.push({ key, path: `${section}.${key}`, value: next[key] });
      byReplacement.set(replacement, entries);
    }
    config[section] = next;
    if (byReplacement.size === 0) continue;

    for (const [replacement, entries] of byReplacement) {
      const target = `${section}.${replacement}`;
      const remove = (): void => {
        for (const entry of entries) delete next[entry.key];
      };

      if (replacement in next) {
        for (const entry of entries) dropped.push({ from: entry.path, to: target });
        remove();
        continue;
      }

      const values = entries.map((e) => JSON.stringify(e.value));
      const ambiguous = entries.length > 1 && !values.every((v) => v === values[0]);
      const choice = choices[target];
      if (ambiguous && choice === undefined) {
        decisions.push({
          target,
          candidates: entries.map(({ path, value }) => ({ path, value })),
        });
        continue;
      }

      next[replacement] = ambiguous ? choice : entries[0]!.value;
      for (const entry of entries) renamed.push({ from: entry.path, to: target });
      remove();
    }

    config[section] = next;
  }

  return { config, renamed, dropped, decisions, removed };
}

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
    // `scribeOwnsMarkdown`/`planTiers` (spec 0030 R13, spec 0032 R30) are harness
    // FLAGS, not roster agents — added here directly instead of in
    // `AGENT_ROLE_KEYS`, which `roster-parity.test.ts` checks 1:1 against the
    // agent roster. `architect` is excluded here (spec 0032 R33): the agent
    // now always renders, so `harness.architect` is a retired key, not a
    // known one — `models.architect`/`effort.architect` still tune the
    // always-on agent, so `architect` stays in `AGENT_ROLE_KEYS` for those.
    harness: {
      keys: [
        ...AGENT_ROLE_KEYS.filter((k) => k !== "architect"),
        "scribeOwnsMarkdown",
        "planTiers",
      ],
    },
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

  // R40: retired keys fail loud, before the tolerant schema has a chance to
  // silently drop them like any other unknown key.
  checkRetiredConfigKeys(parsed);

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
