/** Minimal, deliberately separate state contract for the deliveries workflow. */
import { z } from "zod";
import { MASTER_MODES, SignalSchema } from "./schema.ts";

export const DeliveryStateSchema = z.strictObject({
  version: z.literal(2),
  workflow: z.literal("deliveries"),
  phase: z.literal("context"),
  mode: z.enum(MASTER_MODES).nullable(),
  signal: SignalSchema,
  history: z.array(
    z.strictObject({ phase: z.literal("context"), at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  ),
});

export type DeliveryState = z.infer<typeof DeliveryStateSchema>;
