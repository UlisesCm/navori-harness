/** Versioned, separate contracts for the opt-in deliveries workflow. */
import { z } from "zod";
import { MASTER_MODES, SignalSchema } from "./schema.ts";

const Id = z.string().regex(/^[A-Za-z][A-Za-z0-9-]*$/);
const RequirementId = z.string().regex(/^(?:RN|RF|RNF)-\d+$/);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Nonempty = z.string().trim().min(1);
const RelativePath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.split(/[\\/]/).some((segment) => segment === ".." || segment === "."),
    "path must be repository-relative without traversal",
  );

const SourceSchema = z.strictObject({
  id: Id,
  path: RelativePath,
  digest: Digest,
  locator: Nonempty,
  requirements: z.array(RequirementId).min(1),
  uiBearing: z.boolean(),
});
const CriterionSchema = z.discriminatedUnion("method", [
  z.strictObject({
    id: z.string().regex(/^A\d+$/),
    method: z.literal("test"),
    description: Nonempty,
    command: Nonempty,
    expected: Nonempty,
  }),
  z.strictObject({
    id: z.string().regex(/^A\d+$/),
    method: z.literal("command"),
    description: Nonempty,
    command: Nonempty,
    expected: Nonempty,
  }),
  z.strictObject({
    id: z.string().regex(/^A\d+$/),
    method: z.literal("manual"),
    description: Nonempty,
    check: Nonempty,
    artifact: RelativePath,
  }),
]);
const DesignSchema = z.discriminatedUnion("ui", [
  z.strictObject({ ui: z.literal("none"), reason: Nonempty }),
  z.strictObject({
    ui: z.literal("reuse"),
    architecture: RelativePath,
    flow: RelativePath,
    system: RelativePath,
    reviewedRevision: Nonempty,
  }),
  z.strictObject({
    ui: z.literal("new"),
    architecture: RelativePath,
    flow: RelativePath,
    system: RelativePath,
    reviewedRevision: Nonempty,
    foundationPartId: z.string().regex(/^P\d+$/),
  }),
]);

export const DeliveryPartsSchema = z.strictObject({
  version: z.literal(2),
  workflow: z.literal("deliveries"),
  revision: z.number().int().positive(),
  digest: Digest,
  sources: z.array(SourceSchema).min(1),
  requirements: z
    .array(
      z.strictObject({
        id: RequirementId,
        sourceId: Id,
        disposition: z.enum(["in-scope", "excluded", "deferred"]),
        reason: Nonempty.nullable(),
      }),
    )
    .min(1),
  design: DesignSchema,
  deliveries: z
    .array(
      z.strictObject({
        id: z.string().regex(/^E\d+$/),
        title: Nonempty,
        outcome: Nonempty,
        partIds: z.array(z.string().regex(/^P\d+$/)).min(1),
        dependsOn: z.array(z.string().regex(/^E\d+$/)),
        git: z.strictObject({
          branch: Nonempty,
          base: Nonempty,
          integrationTarget: Nonempty,
          prTarget: Nonempty,
        }),
        timing: Nonempty.optional(),
      }),
    )
    .min(1),
  parts: z
    .array(
      z.strictObject({
        id: z.string().regex(/^P\d+$/),
        deliveryId: z.string().regex(/^E\d+$/),
        title: Nonempty,
        objective: Nonempty,
        scope: z.array(Nonempty).min(1),
        outOfScope: z.array(Nonempty),
        dependsOn: z.array(z.string().regex(/^P\d+$/)),
        sourceIds: z.array(Id).min(1),
        requirementIds: z.array(RequirementId).min(1),
        spec: RelativePath.nullable(),
        foundation: z.boolean(),
        acceptance: z.array(CriterionSchema).min(1),
        questions: z.array(
          z.strictObject({
            text: Nonempty,
            blocking: z.boolean(),
            assignedPartId: z
              .string()
              .regex(/^P\d+$/)
              .nullable(),
          }),
        ),
      }),
    )
    .min(1),
});

export type DeliveryParts = z.infer<typeof DeliveryPartsSchema>;

const AuthoritySchema = z.strictObject({
  identity: Digest,
  contractDigest: Digest,
  sourceDigest: Digest,
  designDigest: Digest,
  masterDigest: Digest,
  approvedBy: z.literal("user"),
  approvedAt: z.string().datetime(),
});
const QueueSchema = z.strictObject({
  identity: Digest,
  baselineIdentity: Digest,
  deliveryId: z.string().regex(/^E\d+$/),
  partIds: z.array(z.string().regex(/^P\d+$/)).min(1),
  approvedBy: z.literal("user"),
  approvedAt: z.string().datetime(),
});

export const DeliveryStateSchema = z.strictObject({
  version: z.literal(2),
  workflow: z.literal("deliveries"),
  phase: z.enum(["context", "execution", "review", "closed"]),
  mode: z.enum(MASTER_MODES).nullable(),
  signal: SignalSchema,
  history: z.array(
    z.strictObject({
      phase: z.enum(["context", "execution", "review", "closed"]),
      at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }),
  ),
  baseline: AuthoritySchema.optional(),
  authorization: QueueSchema.optional(),
  authorizationHistory: z.array(QueueSchema).optional(),
});

export type DeliveryState = z.infer<typeof DeliveryStateSchema>;
