/**
 * Zod schema for the workplan JSON (`.claude/progress/workplan_<feature>.json`).
 * Levels 1 and 2 share this one schema and validator (design.md, "The plan
 * is the default…"): level 2 only adds the `solution`/`phases`/`risks`
 * sections, which stay optional here and are required by `lib/plan/check.ts`
 * instead — the schema decides SHAPE, `check.ts` decides shape PER LEVEL
 * (R15).
 */
import { z } from "zod";

/** A level `classify` (or the user, for level 3) can assign to a task. */
export const PLAN_LEVELS = [0, 1, 2, 3] as const;
const PlanLevelSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);

const ACCEPTANCE_ID = /^A\d+$/;

/** `classify`'s output, embedded verbatim so the workplan carries the
 * evidence it was leveled from (R6, R13). */
export const ClassificationSchema = z.object({
  score: z.number().int().min(0).max(10),
  level: PlanLevelSchema,
  signals: z.array(z.string()),
});

/** Criterion = comand + expected output (Codex ExecPlan precedent, design.md
 * "Decisions"): a criterion without a command cannot be verified. */
export const AcceptanceCriterionSchema = z.object({
  id: z.string().regex(ACCEPTANCE_ID, "acceptance id must look like A1, A2, ..."),
  description: z.string().min(1),
  command: z.string().min(1),
  expected: z.string().min(1),
});

export const FileEntrySchema = z.object({
  path: z.string().min(1),
  new: z.boolean(),
});

export const ProgressStatusSchema = z.enum(["pendiente", "cumplido", "bloqueado"]);

export const DecisionSchema = z.object({
  text: z.string().min(1),
  date: z.string().min(1),
});

/** Level 2 only (R14). */
export const SolutionSchema = z.object({
  path: z.string().min(1),
  verdict: z.enum(["READY", "CONCERNS", "BLOCKED"]),
});

/** Level 2 only (R14). */
export const PhaseSchema = z.object({
  name: z.string().min(1),
  acceptance: z.array(z.string().regex(ACCEPTANCE_ID)),
});

/** Level 2 only (R14). */
export const RiskSchema = z.object({
  risk: z.string().min(1),
  rollback: z.string().min(1),
});

export const WorkplanSchema = z.object({
  feature: z.string().min(1),
  level: PlanLevelSchema,
  classification: ClassificationSchema,
  objective: z.string().min(1),
  acceptance: z.array(AcceptanceCriterionSchema).min(1),
  outOfScope: z.array(z.string()).default([]),
  files: z.array(FileEntrySchema).default([]),
  /** Keyed by `A<n>`; validated against `acceptance`'s ids by `check.ts`,
   * not here — the schema alone cannot see across sibling fields cheaply
   * with a plain `z.record`. */
  progress: z.record(z.string().regex(ACCEPTANCE_ID), ProgressStatusSchema).default({}),
  decisions: z.array(DecisionSchema).default([]),
  solution: SolutionSchema.optional(),
  phases: z.array(PhaseSchema).optional(),
  risks: z.array(RiskSchema).optional(),
});

export type PlanLevel = (typeof PLAN_LEVELS)[number];
export type Workplan = z.infer<typeof WorkplanSchema>;
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;
export type ProgressStatus = z.infer<typeof ProgressStatusSchema>;
