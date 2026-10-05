/** Versioned, separate contracts for the opt-in deliveries workflow. */
import { z } from "zod";
import { MASTER_MODES, SignalSchema } from "./schema.ts";
import { DeliveryEvidenceBindingSchema } from "../plan/evidence.ts";
import { RecordedEvidenceSchema, DeliveryPlanSourceSchema } from "../plan/schema.ts";

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
  generation: z.number().int().positive().optional(),
  transition: z.enum(["replacement", "continuation"]).optional(),
});

const ProofTreeSchema = z.strictObject({
  head: z.string(),
  worktreeTree: Nonempty,
});
const CriterionProofSchema = z.strictObject({
  qualifiedId: z.string().regex(/^P\d+\.A\d+$/),
  baselineIdentity: Digest,
  criterionIdentity: Digest,
  recordedAt: z.string().datetime(),
  proof: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("recorded"),
      feature: Nonempty,
      criterionId: z.string().regex(/^A\d+$/),
      binding: DeliveryEvidenceBindingSchema,
      evidence: RecordedEvidenceSchema,
      source: DeliveryPlanSourceSchema,
    }),
    z.strictObject({
      kind: z.literal("operator-attestation"),
      approvedBy: z.literal("user"),
      artifactDigest: Digest,
      tree: ProofTreeSchema,
      authorityGeneration: z.number().int().positive(),
      queueIdentity: Digest,
    }),
  ]),
});
const VerifiedPartSchema = z.strictObject({
  partId: z.string().regex(/^P\d+$/),
  identity: Digest,
  baselineIdentity: Digest,
  criteriaIdentity: Digest,
  tree: ProofTreeSchema,
  reviewDigest: Digest,
  feature: Nonempty,
  verifiedAt: z.string().datetime(),
  authorityGeneration: z.number().int().positive(),
  kind: z.literal("operator-attested-technical-review"),
  approvedBy: z.literal("user"),
  producerId: Nonempty,
  reviewerId: Nonempty,
  report: z.string().refine((value) => value.trim().length > 0),
  envelope: z.string().refine((value) => value.trim().length > 0),
  receipt: z.string().refine((value) => value.trim().length > 0),
  receiptDigest: Digest,
  envelopeDigest: Digest,
  gate: Nonempty,
  gateIdentity: Nonempty,
  inputsIdentity: Nonempty,
});

/** Reviewer-authored claims; the operator, not the CLI, attests identity separation and QA. */
export const DeliveryReviewEnvelopeSchema = z
  .strictObject({
    kind: z.literal("operator-attested-technical-review"),
    feature: Nonempty,
    stageSlug: Nonempty,
    partId: z.string().regex(/^P\d+$/),
    baselineIdentity: Digest,
    authorityGeneration: z.number().int().positive(),
    queueIdentity: Digest,
    criteriaIdentity: Digest,
    worktreeTree: Nonempty,
    producerId: Nonempty,
    reviewerId: Nonempty,
    verdict: z.literal("APPROVED"),
    reportDigest: Digest,
    gate: Nonempty,
    exitCode: z.literal(0),
    executionReference: Nonempty,
  })
  .refine(
    (record) => record.producerId !== record.reviewerId,
    "reviewer and producer labels must differ",
  );

const PresentationSchema = z.strictObject({
  deliveryId: z.string().regex(/^E\d+$/),
  identity: Digest,
  baselineIdentity: Digest,
  authorityGeneration: z.number().int().positive(),
  partIdentities: z.array(Digest).min(1),
  tree: ProofTreeSchema,
  presentedAt: z.string().datetime(),
});
const DeliveryDecisionSchema = z
  .strictObject({
    kind: z.literal("operator-attestation"),
    deliveryId: z.string().regex(/^E\d+$/),
    reviewedIdentity: Digest,
    decision: z.enum(["accepted", "declined", "deferred", "discarded"]),
    approvedBy: z.literal("user"),
    reason: Nonempty.optional(),
    reference: Nonempty.optional(),
    recordedAt: z.string().datetime(),
  })
  .refine(
    (record) => record.decision === "accepted" || Boolean(record.reason),
    "non-acceptance requires a reason",
  );
const PublicationSchema = z.strictObject({
  deliveryId: z.string().regex(/^E\d+$/),
  reviewedIdentity: Digest,
  kind: z.enum(["release", "deploy"]),
  reference: Nonempty,
  recordedBy: z.literal("user"),
  recordedAt: z.string().datetime(),
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
  authorityGeneration: z.number().int().positive().optional(),
  criteria: z.array(CriterionProofSchema).optional(),
  verifiedParts: z.array(VerifiedPartSchema).optional(),
  presentations: z.array(PresentationSchema).optional(),
  decisions: z.array(DeliveryDecisionSchema).optional(),
  publications: z.array(PublicationSchema).optional(),
  closure: z
    .strictObject({
      closedAt: z.string().datetime(),
      baselineIdentity: Digest,
      authorityGeneration: z.number().int().positive(),
      pendingPublication: z.array(z.string().regex(/^E\d+$/)),
    })
    .optional(),
});

export type DeliveryState = z.infer<typeof DeliveryStateSchema>;
