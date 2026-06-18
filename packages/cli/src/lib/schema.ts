import { z } from "zod";
import { safeRelPath } from "./zod-helpers.ts";

const ENGINES = ["claude", "agents-md", "cursor", "copilot"] as const;
const MODELS = ["opus", "sonnet", "haiku"] as const;

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
const ProgressSchema = z.object({
  dir: safeRelPath.default("progress"),
  currentFile: safeRelPath.default("current.md"),
  historyFile: safeRelPath.default("history.md"),
  checkpointsDir: safeRelPath.default("progress/checkpoints"),
  archiveAfterDays: z.number().int().positive().default(30),
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
  })
  .passthrough();

export const NavoriConfigSchema = z
  .object({
    $schema: z.string().optional(),
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "name must be kebab-case"),
    version: z.string().default("1.0.0"),
    workspace: z.string().optional(),
    engines: z.array(z.enum(ENGINES)).min(1),
    preset: z.string().min(1),
    language: z.enum(["es", "en"]).default("es"),
    branchBase: z.string().default("main"),
    commits: z.enum(["conventional", "conventional-es", "free"]).default("conventional-es"),
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
