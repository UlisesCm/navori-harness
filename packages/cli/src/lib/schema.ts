import { z } from "zod";
import { safeRelPath } from "./zod-helpers.ts";

const ENGINES = ["claude", "agents-md", "cursor", "copilot"] as const;
const MODELS = ["opus", "sonnet", "haiku"] as const;
const COMMITS = ["conventional", "conventional-es", "free"] as const;
const LANGUAGES = ["es", "en"] as const;

/**
 * Forward-compat enum helpers (issue #70). A config written by a NEWER navori
 * may carry an engine / commit-style / language this CLI doesn't know. A plain
 * `z.enum` makes `readConfig` throw on that value — breaking EVERY command for
 * a config a teammate checked in. These drop the unknown values (keeping the
 * known ones) and fall back to a sane default so an older CLI keeps working.
 * readConfig surfaces a warning listing what it dropped.
 */
function tolerantEnumArray<T extends readonly [string, ...string[]]>(values: T, fallback: T[number]) {
  return z.preprocess((val) => {
    if (!Array.isArray(val)) return val; // let z.array report a non-array
    const known = val.filter((v) => (values as readonly string[]).includes(v as string));
    // Substitute the fallback only when the array had values but they were ALL
    // unknown (forward-version config). A genuinely empty [] stays empty so
    // `.min(1)` still flags it as a real error.
    if (known.length === 0 && val.length > 0) return [fallback];
    return known;
  }, z.array(z.enum(values)).min(1));
}

function tolerantEnum<T extends readonly [string, ...string[]]>(values: T, fallback: T[number]) {
  return z.preprocess(
    (val) => (val === undefined || (values as readonly string[]).includes(val as string) ? val : fallback),
    z.enum(values).default(fallback),
  );
}

const QualityGateSchema = z.object({
  fast: z.string().min(1),
  full: z.string().min(1),
});

const MonorepoWorkspaceSchema = z.object({
  name: z.string().min(1),
  path: safeRelPath,
  preset: z.string().optional(),
  qualityGate: QualityGateSchema.optional(),
});

const MonorepoSchema = z.object({
  enabled: z.boolean(),
  tool: z.enum(["pnpm", "turbo", "nx", "rush", "lerna", "npm"]).optional(),
  workspaces: z.array(MonorepoWorkspaceSchema).default([]),
});

const SddSchema = z.object({
  enabled: z.boolean().default(true),
  specsDir: z.string().default("specs"),
  applyWhen: z.array(z.string()).default([]),
  doesNotApplyTo: z.array(z.string()).default([]),
});

const HarnessSchema = z.object({
  leader: z.boolean().default(true),
  implementer: z.boolean().default(true),
  reviewer: z.boolean().default(true),
  researcher: z.boolean().default(true),
  ticketAudit: z.boolean().default(true),
  commitPrPilot: z.boolean().default(true),
  explorer: z.boolean().default(true),
});

const ModelsSchema = z.object({
  leader: z.enum(MODELS).optional(),
  implementer: z.enum(MODELS).optional(),
  reviewer: z.enum(MODELS).optional(),
  researcher: z.enum(MODELS).optional(),
  ticketAudit: z.enum(MODELS).optional(),
  commitPrPilot: z.enum(MODELS).optional(),
  explorer: z.enum(MODELS).optional(),
});

const PluginEntrySchema = z.object({
  enabled: z.boolean(),
});

const AGENT_ROLES_FOR_SCHEMA = [
  "leader",
  "implementer",
  "reviewer",
  "researcher",
  "ticket-audit",
  "commit-pr-pilot",
  "explorer",
] as const;

const AgentAssignmentsSchema = z.record(z.string(), z.enum(AGENT_ROLES_FOR_SCHEMA));

const SkillsSchema = z.object({
  auto: z.array(z.string()).default([]),
  optIn: z.array(z.string()).default([]),
});

// Progress files live inside the repo by definition — accepting absolute
// paths or `..` segments would let the adapter write outside the workspace
// (issue #5). Reuse the same containment regex plugins already use for
// script/skill paths.
//
// `checkpointsDir` / `archiveAfterDays` were removed (issue #75): nothing
// ever consumed them. Old configs that still carry them keep validating —
// z.object strips unknown keys by default — and readConfig surfaces a soft
// warning so users know they're dead config they can delete.
const ProgressSchema = z.object({
  dir: safeRelPath.default("progress"),
  currentFile: safeRelPath.default("current.md"),
  historyFile: safeRelPath.default("history.md"),
});

// Source-of-truth for project-shape facts that user-section templates
// interpolate via `{{project.X}}` (see spec 0002 §DT-5). Plugins can
// extend with arbitrary keys via their `prompts[]` entries; passthrough
// preserves those.
const ProjectSchema = z
  .object({
    legacyPaths: z.array(z.string()).default([]),
    criticalAreas: z.array(z.string()).default([]),
    testRunner: z.string().optional(),
    /** Repo stage / risk posture: greenfield | production | migration. */
    posture: z.string().optional(),
    /** Review strictness: strict | pragmatic. */
    reviewRigor: z.string().optional(),
    /** One-line architecture/data-flow rule new code must follow. */
    architectureRule: z.string().optional(),
    /** Tests policy for new code: always | when-applicable | none. */
    testsForNewCode: z.string().optional(),
    /** Skill ids the user owns under `.claude/skills/<id>.md`. navori never
     * writes their content — it only indexes them so agents discover them. */
    localSkills: z.array(z.string()).default([]),
    /** Library-skill ids detected in the repo's deps (socketio, mongoose, …).
     * Cross-preset: a skill is materialized whenever its dependency is present,
     * independent of the active preset. Supersedes the old zod/joiValidation
     * flags. See lib/library-skills.ts. */
    libraries: z.array(z.string()).default([]),
    /** Active dependency migrations (legacy + successor both present in deps).
     * Each renders a "prefer the new, freeze the legacy" rule in the project-
     * context block. Detected from deps (lib/library-skills.ts MIGRATION_PAIRS)
     * and refreshed on `update`. */
    libraryMigrations: z
      .array(
        z.object({
          legacy: z.string(),
          preferred: z.string(),
          domain: z.string(),
        }),
      )
      .default([]),
    /** Programming language of the repo (ts/js/python/rust/go/unknown), from
     * detection. Drives language-aware baseline blocks — e.g. the TS-only
     * `tipado-fuerte` (any/unknown) is suppressed in python/rust/go. The render
     * derives `typedLanguage` from this; absence is treated as JS/TS for
     * back-compat with configs written before this field existed. */
    codeLanguage: z.string().optional(),
  })
  .passthrough();

export const NavoriConfigSchema = z
  .object({
    $schema: z.string().optional(),
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "name must be kebab-case"),
    version: z.string().default("1.0.0"),
    workspace: z.string().optional(),
    engines: tolerantEnumArray(ENGINES, "claude"),
    preset: z.string().min(1),
    language: tolerantEnum(LANGUAGES, "es"),
    branchBase: z.string().default("main"),
    /** Target branch for PRs (`gh pr create --base`). When omitted, PRs target
     * branchBase. Decouples the fork point / protected branch (branchBase) from
     * the PR target — e.g. branch off `main` but open PRs against `develop`.
     * The render derives the effective value (prTarget ?? branchBase) so this
     * stays out of configs that don't need it. */
    prTarget: z.string().optional(),
    commits: tolerantEnum(COMMITS, "conventional-es"),
    qualityGate: QualityGateSchema.optional(),
    sdd: SddSchema.optional(),
    harness: HarnessSchema.optional(),
    models: ModelsSchema.optional(),
    plugins: z.record(z.string(), PluginEntrySchema).optional(),
    /** Override of which agent owns which skill/managed-block id. Plugins
     * declare their own recommendedAgent; entries here override that. */
    agentAssignments: AgentAssignmentsSchema.optional(),
    skills: SkillsSchema.optional(),
    progress: ProgressSchema.optional(),
    project: ProjectSchema.optional(),
    monorepo: MonorepoSchema.optional(),
  })
  // Preserve unknown top-level fields so downgrades / forward-compat
  // don't silently destroy data the user added (custom tooling fields,
  // fields from a newer version of navori, etc).
  .passthrough();

export type NavoriConfig = z.infer<typeof NavoriConfigSchema>;
export type NavoriConfigInput = z.input<typeof NavoriConfigSchema>;
