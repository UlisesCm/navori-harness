import { z } from "zod";

export const BenchEngineSchema = z.enum(["claude", "pi"]);
export type BenchEngine = z.infer<typeof BenchEngineSchema>;
const ModelSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/);

const EngineRunSchema = z
  .strictObject({
    sessionId: z.uuid(),
    task: z.number().int().min(1).max(5),
    launched: z.boolean(),
    model: ModelSchema.nullable(),
    version: z.string().trim().min(1).max(200).nullable(),
  })
  .refine((value): boolean => !value.launched || (value.model !== null && value.version !== null), {
    message: "A launch attempt must record its declared model and native CLI version",
  });

export const LiveRunSchema = z.strictObject({
  schemaVersion: z.literal(1),
  taskSet: z.literal("0053-fixed-five-tasks"),
  createdAt: z.iso.datetime(),
  engines: z.strictObject({ claude: EngineRunSchema, pi: EngineRunSchema }),
});
export type LiveRun = z.infer<typeof LiveRunSchema>;

export const BenchAuditHeaderSchema = z.object({
  event: z.literal("start"),
  host: BenchEngineSchema,
  sessionId: z.uuid(),
  cwd: z.string().min(1),
});

/** Validate the producer envelope without interpreting or discarding its metric payloads. */
export const BenchReportEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskSet: z.literal("0053-fixed-five-tasks"),
    result: z.enum(["pass", "fail", "inconclusive"]),
    comparisonVerification: z.literal("unverified").optional(),
    inconclusiveReasons: z.array(z.string().max(500)).max(200),
    engines: z.array(z.object({ engine: BenchEngineSchema }).passthrough()).length(2),
  })
  .passthrough()
  .refine(
    (value): boolean =>
      new Set(value.engines.map((engine): BenchEngine => engine.engine)).size === 2,
  );
export type BenchReportEnvelope = z.infer<typeof BenchReportEnvelopeSchema>;

export const LiveOptionsSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("prepare") }),
  z.strictObject({ action: z.literal("collect"), root: z.string().min(1) }),
  z.strictObject({
    action: z.literal("task"),
    root: z.string().min(1),
    engine: BenchEngineSchema,
    task: z
      .string()
      .regex(/^[2-5]$/)
      .transform(Number),
  }),
  z
    .strictObject({
      action: z.literal("launch"),
      root: z.string().min(1),
      engine: BenchEngineSchema,
      model: ModelSchema,
    })
    .refine(
      (value): boolean =>
        value.engine === "claude" ? value.model === "sonnet" : value.model.includes("/"),
      {
        message: "Use --model sonnet for Claude or an explicit provider/model for Pi",
      },
    ),
]);
