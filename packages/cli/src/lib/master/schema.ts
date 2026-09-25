/**
 * Zod schemas for the master-plan JSON contracts (spec 0034, design.md
 * "Contracts"): `_master/index.json` (`MasterIndexSchema`), `<stage>/state.json`
 * (`MasterStateSchema`) and `<stage>/parts.json` (`PartsSchema`). All three
 * carry `version: 1`; an unknown version fails loud with a message naming the
 * version this navori supports, so a config written by a newer navori never
 * silently mismatches (T1).
 */
import { z } from "zod";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MESSAGE = "must be an ISO date (YYYY-MM-DD)";

/** Every JSON contract in this module is versioned the same way: a plain
 * number that must equal the version this navori understands. Centralized so
 * the three schemas fail with the same wording (T1: "una versión desconocida
 * falla con un mensaje que nombra la versión de navori necesaria"). */
function versionField(kind: string) {
  return z.number().superRefine((value, ctx) => {
    if (value !== 1) {
      ctx.addIssue({
        code: "custom",
        message:
          `unsupported ${kind} version ${value}; this navori reads version 1 ` +
          `(a newer navori wrote this file)`,
      });
    }
  });
}

// --- index.json -------------------------------------------------------

export const MASTER_STAGE_STATES = ["activa", "cerrada", "convertida", "abandonada"] as const;
export type MasterStageState = (typeof MASTER_STAGE_STATES)[number];

const StageEntrySchema = z
  .object({
    number: z.number().int().positive(),
    slug: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "slug must be kebab-case"),
    dir: z.string().min(1),
    state: z.enum(MASTER_STAGE_STATES),
    openedAt: z.string().regex(DATE, DATE_MESSAGE),
    closedAt: z.string().regex(DATE, DATE_MESSAGE).nullable(),
    spec: z.string().min(1).nullable().default(null),
  })
  .superRefine((entry, ctx) => {
    const expectedDir = `${String(entry.number).padStart(2, "0")}-${entry.slug}`;
    if (entry.dir !== expectedDir) {
      ctx.addIssue({
        code: "custom",
        message: `dir must be "${expectedDir}" (got "${entry.dir}")`,
        path: ["dir"],
      });
    }
    if (entry.state === "activa" && entry.closedAt !== null) {
      ctx.addIssue({
        code: "custom",
        message: "an 'activa' stage must not have closedAt",
        path: ["closedAt"],
      });
    }
    if (entry.state !== "activa" && entry.closedAt === null) {
      ctx.addIssue({
        code: "custom",
        message: `a '${entry.state}' stage requires closedAt`,
        path: ["closedAt"],
      });
    }
    if (entry.state !== "convertida" && entry.spec !== null) {
      ctx.addIssue({
        code: "custom",
        message: "spec is only set when state is 'convertida'",
        path: ["spec"],
      });
    }
  });

export type StageEntry = z.infer<typeof StageEntrySchema>;

export const MasterIndexSchema = z
  .object({
    version: versionField("_master/index.json"),
    stages: z.array(StageEntrySchema).default([]),
  })
  .superRefine((index, ctx) => {
    const active = index.stages.filter((s) => s.state === "activa");
    if (active.length > 1) {
      ctx.addIssue({
        code: "custom",
        message: `only one stage can be 'activa'; found ${active.length}: ${active
          .map((s) => s.dir)
          .join(", ")}`,
        path: ["stages"],
      });
    }
    for (let i = 1; i < index.stages.length; i++) {
      const prev = index.stages[i - 1]!;
      const curr = index.stages[i]!;
      if (curr.number <= prev.number) {
        ctx.addIssue({
          code: "custom",
          message: `stage numbers must be strictly increasing (${prev.number} then ${curr.number})`,
          path: ["stages", i, "number"],
        });
      }
    }
  });

export type MasterIndex = z.infer<typeof MasterIndexSchema>;

// --- state.json ---------------------------------------------------------

export const MASTER_PHASES = [
  "context",
  "transcribed",
  "mapped",
  "planned",
  "questioned",
  "mastered",
  "executing",
  "closed",
] as const;
export type MasterPhase = (typeof MASTER_PHASES)[number];

const MASTER_MODES = ["template", "en-curso"] as const;
export type MasterMode = (typeof MASTER_MODES)[number];

const SignalSchema = z.object({
  commits: z.number().int().nonnegative().nullable(),
  firstCommit: z.string().regex(DATE, DATE_MESSAGE).nullable(),
  filesChangedSinceFirst: z.number().int().nonnegative().nullable(),
  framework: z.string().nullable(),
  libraries: z.array(z.string()).default([]),
  suggested: z.enum(MASTER_MODES),
});
export type MasterSignal = z.infer<typeof SignalSchema>;

const HistoryEntrySchema = z.object({
  phase: z.enum(MASTER_PHASES),
  at: z.string().regex(DATE, DATE_MESSAGE),
});

export const MasterStateSchema = z
  .object({
    version: versionField("state.json"),
    phase: z.enum(MASTER_PHASES),
    mode: z.enum(MASTER_MODES).nullable(),
    signal: SignalSchema,
    outcome: z.enum(["entregada", "convertida", "abandonada"]).nullable().default(null),
    abandonment: z.object({ reason: z.string().min(1), phase: z.enum(MASTER_PHASES) }).optional(),
    conversion: z.object({ spec: z.string().min(1), reason: z.string().min(1) }).optional(),
    history: z.array(HistoryEntrySchema).default([]),
  })
  .superRefine((state, ctx) => {
    if (state.outcome === "convertida" && !state.conversion) {
      ctx.addIssue({
        code: "custom",
        message: "outcome 'convertida' requires 'conversion'",
        path: ["conversion"],
      });
    }
    if (state.outcome !== "convertida" && state.conversion) {
      ctx.addIssue({
        code: "custom",
        message: "'conversion' is only set when outcome is 'convertida'",
        path: ["conversion"],
      });
    }
    if (state.outcome === "abandonada" && !state.abandonment) {
      ctx.addIssue({
        code: "custom",
        message: "outcome 'abandonada' requires 'abandonment'",
        path: ["abandonment"],
      });
    }
    if (state.outcome !== "abandonada" && state.abandonment) {
      ctx.addIssue({
        code: "custom",
        message: "'abandonment' is only set when outcome is 'abandonada'",
        path: ["abandonment"],
      });
    }
  });

export type MasterState = z.infer<typeof MasterStateSchema>;

// --- parts.json -----------------------------------------------------------

const PART_ID = /^P\d+$/;
const ACCEPTANCE_ID = /^A\d+$/;

export const PART_STATES = ["pendiente", "parcial", "hecho", "descartada", "diferida"] as const;
export type PartState = (typeof PART_STATES)[number];

const RunEvidenceSchema = z.object({
  kind: z.literal("run"),
  command: z.string().min(1),
  result: z.string().min(1),
  commit: z.string().min(1),
  date: z.string().regex(DATE, DATE_MESSAGE),
});

const ApprovalEvidenceSchema = z.object({
  kind: z.literal("approval"),
  approvedBy: z.literal("user"),
  date: z.string().regex(DATE, DATE_MESSAGE),
});

const EvidenceSchema = z.union([RunEvidenceSchema, ApprovalEvidenceSchema]).nullable();

const AcceptanceBase = z.object({
  id: z.string().regex(ACCEPTANCE_ID, "acceptance id must look like A1, A2, ..."),
  description: z.string().min(1),
  evidence: EvidenceSchema.default(null),
});

/** Discriminated by `method` (R59): exactly one detail block matches the
 * declared method, and `test.file`/`command.run`/`manual.check` all it takes
 * for a criterion of that method to exist — the union rejects a stray block
 * from another method (T1: "dos bloques de método en un criterio fallan"). */
export const AcceptanceCriterionSchema = z
  .discriminatedUnion("method", [
    AcceptanceBase.extend({
      method: z.literal("test"),
      test: z.object({ file: z.string().min(1), case: z.string().min(1) }),
    }),
    AcceptanceBase.extend({
      method: z.literal("comando"),
      command: z.object({ run: z.string().min(1), expected: z.string().min(1) }),
    }),
    AcceptanceBase.extend({
      method: z.literal("manual"),
      manual: z.object({ check: z.string().min(1), how: z.string().min(1) }),
    }),
  ])
  .superRefine((criterion, ctx) => {
    if (!criterion.evidence) return;
    if (criterion.evidence.kind === "run" && criterion.method === "manual") {
      ctx.addIssue({
        code: "custom",
        message: "evidence 'run' is only valid for method 'test' or 'comando'",
        path: ["evidence"],
      });
    }
    if (criterion.evidence.kind === "approval" && criterion.method !== "manual") {
      ctx.addIssue({
        code: "custom",
        message: "evidence 'approval' is only valid for method 'manual'",
        path: ["evidence"],
      });
    }
  });

export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

function acceptanceIdsAreConsecutive(acceptance: readonly AcceptanceCriterion[]): string | null {
  const numbers = acceptance.map((a) => Number(a.id.slice(1)));
  const seen = new Set<number>();
  for (const n of numbers) {
    if (seen.has(n)) return `duplicate acceptance id A${n}`;
    seen.add(n);
  }
  const sorted = [...numbers].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] !== i + 1) return "acceptance ids must be consecutive starting at A1";
  }
  return null;
}

const PartSchema = z
  .object({
    id: z.string().regex(PART_ID, "part id must look like P1, P2, ..."),
    title: z.string().min(1),
    objective: z.string().min(1),
    scope: z.array(z.string()).default([]),
    outOfScope: z.array(z.string()).default([]),
    dependsOn: z.array(z.string().regex(PART_ID)).default([]),
    seedRequirements: z.array(z.string()).default([]),
    acceptance: z.array(AcceptanceCriterionSchema).min(1),
    inheritedFrom: z.string().min(1).nullable().default(null),
    state: z.enum(PART_STATES).default("pendiente"),
    reason: z.string().min(1).nullable().default(null),
    spec: z.string().min(1).nullable().default(null),
    issue: z.number().int().positive().nullable().default(null),
  })
  .superRefine((part, ctx) => {
    const needsReason = part.state === "descartada" || part.state === "diferida";
    if (needsReason && part.reason === null) {
      ctx.addIssue({
        code: "custom",
        message: `part ${part.id} in state '${part.state}' requires a reason`,
        path: ["reason"],
      });
    }
    if (!needsReason && part.reason !== null) {
      ctx.addIssue({
        code: "custom",
        message: "reason is only allowed when state is 'descartada' or 'diferida'",
        path: ["reason"],
      });
    }
    const acceptanceError = acceptanceIdsAreConsecutive(part.acceptance);
    if (acceptanceError) {
      ctx.addIssue({
        code: "custom",
        message: `${part.id}: ${acceptanceError}`,
        path: ["acceptance"],
      });
    }
  });

export type Part = z.infer<typeof PartSchema>;

/** DFS cycle detection over `dependsOn`. Returns the id of a part that sits on
 * a cycle, or null when the graph is acyclic. */
function findCycle(parts: readonly Part[]): string | null {
  const graph = new Map(parts.map((p) => [p.id, p.dependsOn]));
  const state = new Map<string, "visiting" | "done">();

  function visit(id: string): boolean {
    state.set(id, "visiting");
    for (const dep of graph.get(id) ?? []) {
      const depState = state.get(dep);
      if (depState === "visiting") return true;
      if (depState === undefined && graph.has(dep) && visit(dep)) return true;
    }
    state.set(id, "done");
    return false;
  }

  for (const id of graph.keys()) {
    if (!state.has(id) && visit(id)) return id;
  }
  return null;
}

export const PartsSchema = z
  .object({
    version: versionField("parts.json"),
    parts: z.array(PartSchema).default([]),
  })
  .superRefine((doc, ctx) => {
    const ids = doc.parts.map((p) => Number(p.id.slice(1)));
    const idSet = new Set(doc.parts.map((p) => p.id));
    const seen = new Set<number>();
    for (const n of ids) {
      if (seen.has(n)) {
        ctx.addIssue({ code: "custom", message: `duplicate part id P${n}`, path: ["parts"] });
      }
      seen.add(n);
    }
    const sorted = [...ids].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i] !== i + 1) {
        ctx.addIssue({
          code: "custom",
          message: "part ids must be consecutive starting at P1",
          path: ["parts"],
        });
        break;
      }
    }
    for (const part of doc.parts) {
      for (const dep of part.dependsOn) {
        if (!idSet.has(dep)) {
          ctx.addIssue({
            code: "custom",
            message: `${part.id} depends on unknown part ${dep}`,
            path: ["parts"],
          });
        }
      }
    }
    const cycleAt = findCycle(doc.parts);
    if (cycleAt) {
      ctx.addIssue({
        code: "custom",
        message: `dependsOn has a cycle involving ${cycleAt}`,
        path: ["parts"],
      });
    }
  });

export type PartsDocument = z.infer<typeof PartsSchema>;
