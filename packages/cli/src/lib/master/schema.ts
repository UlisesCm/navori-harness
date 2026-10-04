/**
 * Zod schemas for the master-plan JSON contracts (spec 0034, design.md
 * "Contracts"): `_master/index.json` (`MasterIndexSchema`), `<stage>/state.json`
 * (`MasterStateSchema`) and `<stage>/parts.json` (`PartsSchema`). All three
 * Legacy state and parts carry `version: 1`; the registry also accepts v2
 * for mixed workflows. An unknown version fails loud, so a newer navori never
 * silently mismatches (T1).
 */
import { z } from "zod";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MESSAGE = "must be an ISO date (YYYY-MM-DD)";

/** Legacy state and parts remain v1-only; registry versions are independent. */
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
    workflow: z.literal("deliveries").optional(),
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
    version: z.number().superRefine((value, ctx) => {
      if (value !== 1 && value !== 2)
        ctx.addIssue({
          code: "custom",
          message: `unsupported _master/index.json version ${value}; this navori reads version 1 or 2`,
        });
    }),
    stages: z.array(StageEntrySchema).default([]),
  })
  .superRefine((index, ctx) => {
    if (index.version === 1 && index.stages.some((stage) => stage.workflow === "deliveries"))
      ctx.addIssue({
        code: "custom",
        message: "deliveries entries require index version 2",
        path: ["stages"],
      });
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
  "ux",
  "executing",
  "closed",
] as const;
export type MasterPhase = (typeof MASTER_PHASES)[number];

/** UX contract decision recorded by `navori master ux` (phase `ux`). Optional
 * in `state.json` so legacy stages round-trip byte-identical. */
export const MASTER_UX_CHOICES = ["none", "md", "md-json"] as const;
export type MasterUxChoice = (typeof MASTER_UX_CHOICES)[number];

export const MASTER_MODES = ["template", "en-curso", "desde-cero"] as const;
export type MasterMode = (typeof MASTER_MODES)[number];

export const SignalSchema = z.object({
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
    closedAt: z.string().regex(DATE, DATE_MESSAGE).optional(),
    abandonment: z.object({ reason: z.string().min(1), phase: z.enum(MASTER_PHASES) }).optional(),
    conversion: z.object({ spec: z.string().min(1), reason: z.string().min(1) }).optional(),
    history: z.array(HistoryEntrySchema).default([]),
    ux: z.enum(MASTER_UX_CHOICES).optional(),
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

// --- ux.json (UX contract consumed by navori-heron) -----------------------

/** Surface ids that would be ambiguous with other ID families (`RN-1`, `UX-1`, ...). */
const RESERVED_SURFACES = ["RN", "RF", "RNF", "UX", "ACT", "SCR", "PT", "API"];
const SURFACE_PART = "[A-Z]{2,}(?:_[A-Z]+)*";

/** ID shape per UX entity kind. Language-neutral: shared by UX.md and ux.json. */
export const UX_ID_PATTERNS = {
  surfaces: new RegExp(`^${SURFACE_PART}$`),
  actors: /^ACT-[A-Z0-9]+(?:-[A-Z0-9]+)*$/,
  journeys: /^J\d{2,}$/,
  flows: /^F\d{2,}$/,
  screens: new RegExp(`^SCR-(${SURFACE_PART})-\\d{2,}$`),
  components: /^C\d{2,}$/,
  patterns: /^PT\d{2,}$/,
  "ux-requirements": /^UX-\d+$/,
} as const;
export type UxEntityKind = keyof typeof UX_ID_PATTERNS;

const REF_PATTERN = /^(?:(?:RN|RF|RNF|UX)-\d+|P\d+(?:\.A\d+)?|(?:\d{2}-[a-z0-9-]+\/)?D\d+)$/;

const idOf = (kind: UxEntityKind) =>
  z.string().regex(UX_ID_PATTERNS[kind], `must be a valid ${kind} id`);
const SURFACE = idOf("surfaces").refine((v) => !RESERVED_SURFACES.includes(v), "reserved id");
const ACTOR = idOf("actors");
const JOURNEY = idOf("journeys");
const FLOW = idOf("flows");
const SCREEN = idOf("screens");
const COMPONENT = idOf("components");
const PATTERN = idOf("patterns");
const UX_REQ = idOf("ux-requirements");
const REF = z.string().regex(REF_PATTERN, "must be RN-/RF-/RNF-/UX-<n>, P<n> or D<n>");
const text = z.string().min(1);
const list = <T extends z.ZodType>(item: T) => z.array(item).default([]);

const UxScreenSchema = z.strictObject({
  id: SCREEN,
  name: text,
  surface: SURFACE,
  actors: z.array(ACTOR).min(1),
  purpose: text,
  requirements: z.array(REF).min(1),
  journeys: list(JOURNEY),
  flows: list(FLOW),
  information: list(text),
  actions: list(
    z.strictObject({ label: text, priority: z.enum(["primary", "secondary", "destructive"]) }),
  ),
  states: z.array(text).min(1),
  conditions: list(text),
  navigation: z
    .strictObject({ from: list(SCREEN), to: list(SCREEN) })
    .default({ from: [], to: [] }),
  permissions: list(ACTOR),
  events: list(text),
});

/** `ux.json`. Strict: unknown keys (`color`, `font`, ...) are rejected so visual
 * decisions cannot be smuggled in; `masterStage` equality is checked in `ux.ts`. */
export const UxContractSchema = z
  .strictObject({
    schemaVersion: versionField("ux.json"),
    masterStage: text,
    surfaces: z.array(
      z.strictObject({
        id: SURFACE,
        name: text,
        actors: list(ACTOR),
        purpose: text,
        capabilities: list(text),
        constraints: list(text),
        requirements: list(REF),
      }),
    ),
    actors: z.array(
      z.strictObject({
        id: ACTOR,
        name: text,
        goal: text,
        capabilities: list(text),
        constraints: list(text),
        surfaces: list(SURFACE),
        forbiddenActions: list(text),
        relations: list(text),
      }),
    ),
    journeys: z.array(
      z.strictObject({
        id: JOURNEY,
        name: text,
        actor: ACTOR,
        goal: text,
        trigger: text,
        initialState: text,
        expectedResult: text,
        flows: z.array(FLOW).min(1),
        requirements: list(REF),
        exceptions: list(text),
      }),
    ),
    flows: z.array(
      z.strictObject({
        id: FLOW,
        name: text,
        actor: ACTOR,
        purpose: text,
        trigger: text,
        preconditions: list(text),
        steps: z.array(text).min(1),
        decisions: list(text),
        alternateStates: list(text),
        errors: list(text),
        result: text,
        screens: z.array(SCREEN).min(1),
        requirements: list(REF),
      }),
    ),
    screens: z.array(UxScreenSchema),
    functionalComponents: z.array(
      z.strictObject({
        id: COMPONENT,
        name: text,
        responsibility: text,
        information: list(text),
        actions: list(text),
        states: list(text),
        screens: z.array(SCREEN).min(1),
        variations: list(text),
      }),
    ),
    patterns: z.array(
      z.strictObject({
        id: PATTERN,
        name: text,
        purpose: text,
        screens: z.array(SCREEN).min(1),
        states: list(text),
        rules: list(text),
        requirements: list(REF),
      }),
    ),
    uxRequirements: z.array(
      z.strictObject({ id: UX_REQ, statement: text, derivedFrom: z.array(REF).min(1) }),
    ),
    traceability: z.array(
      z.strictObject({
        requirement: REF,
        journeys: list(JOURNEY),
        flows: list(FLOW),
        screens: list(SCREEN),
        patterns: list(PATTERN),
      }),
    ),
  })
  .superRefine((doc, ctx) => {
    const fail = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: "custom", message, path });
    };
    const declared = {
      surfaces: new Set(doc.surfaces.map((x) => x.id)),
      flows: new Set(doc.flows.map((x) => x.id)),
      screens: new Set(doc.screens.map((x) => x.id)),
    };
    const kinds = {
      surfaces: doc.surfaces,
      actors: doc.actors,
      journeys: doc.journeys,
      flows: doc.flows,
      screens: doc.screens,
      functionalComponents: doc.functionalComponents,
      patterns: doc.patterns,
      uxRequirements: doc.uxRequirements,
    };
    for (const [kind, items] of Object.entries(kinds)) {
      const seen = new Set<string>();
      items.forEach((item, i) => {
        if (seen.has(item.id)) fail([kind, i, "id"], `duplicate id ${item.id}`);
        seen.add(item.id);
      });
    }
    doc.screens.forEach((screen, i) => {
      if (UX_ID_PATTERNS.screens.exec(screen.id)?.[1] !== screen.surface)
        fail(["screens", i, "surface"], `${screen.id} does not embed surface ${screen.surface}`);
      if (!declared.surfaces.has(screen.surface))
        fail(["screens", i, "surface"], `undeclared surface ${screen.surface}`);
    });
    doc.journeys.forEach((journey, i) =>
      journey.flows.forEach((id) => {
        if (!declared.flows.has(id)) fail(["journeys", i, "flows"], `undeclared flow ${id}`);
      }),
    );
    doc.flows.forEach((flow, i) =>
      flow.screens.forEach((id) => {
        if (!declared.screens.has(id)) fail(["flows", i, "screens"], `undeclared screen ${id}`);
      }),
    );
  });

export type UxContract = z.infer<typeof UxContractSchema>;
