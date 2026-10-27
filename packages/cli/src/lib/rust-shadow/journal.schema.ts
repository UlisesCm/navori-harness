import { z } from "zod";
import { isAbsolute, resolve } from "node:path";

/** Maximum complete UTF-8 JSONL row, including its LF. */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;
/** Historical files above this read limit remain untouched and unavailable. */
export const MAX_LOG_BYTES = 32 * 1024 * 1024;
/** Explicit local project root; never a global HOME/audit fallback. */
export const rootSchema = z
  .string()
  .refine(
    (path: string): boolean =>
      !path.includes("\0") &&
      Buffer.from(path, "utf8").toString("utf8") === path &&
      isAbsolute(path) &&
      resolve(path) === path,
  );
/** One safe hook filename segment. */
export const hookSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9_-]+$/);
/** Current compiled D8 implementation identity. */
export const implementationSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
/** Only protocol engines can establish observations. */
export const engineSchema = z.enum(["claude", "codex", "pi"]);
/** CLI clock values cannot coerce strings, fractions or unsafe integers. */
export const timeSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** Callers supply no producer-assigned UUID, clock or free-form fields. */
export const identitySchema = z.strictObject({
  hook: hookSchema,
  engine: engineSchema,
  implementation: implementationSchema,
});
/** Closed comparison summaries never contain raw stdout/stderr or payload. */
export const comparisonSchema = z.strictObject({
  nativeFailed: z.boolean(),
  shellFailed: z.boolean(),
  codeDiffers: z.boolean(),
  stdoutDiffers: z.boolean(),
  stderrDiffers: z.boolean(),
});
export type Comparison = z.infer<typeof comparisonSchema>;
export type Identity = z.infer<typeof identitySchema>;

/** A controlled native/shell failure is itself a divergence. */
export function diverged(comparison: Comparison): boolean {
  return (
    comparison.nativeFailed ||
    comparison.shellFailed ||
    comparison.codeDiffers ||
    comparison.stdoutDiffers ||
    comparison.stderrDiffers
  );
}

const common = { schema: z.literal(1), id: z.uuid(), ...identitySchema.shape, timeMs: timeSchema };
/** Acknowledged observation start; payload is forbidden by the strict shape. */
export const beginSchema = z.strictObject({ ...common, kind: z.literal("begin") });
const base64Schema = z
  .string()
  .max(MAX_LINE_BYTES)
  // Canonical round-trip rejects malformed padding/characters without regex stack growth.
  .refine((value: string): boolean => Buffer.from(value, "base64").toString("base64") === value);
const completeBaseSchema = z.strictObject({
  ...common,
  kind: z.literal("complete"),
  comparison: comparisonSchema,
  payloadBase64: base64Schema.optional(),
});
/** Payload bytes exist exactly when a completed observation diverged. */
export const completeSchema = completeBaseSchema.refine(
  (row: z.infer<typeof completeBaseSchema>): boolean =>
    diverged(row.comparison) === (row.payloadBase64 !== undefined),
);
/** Strict versioned wire records. */
export const recordSchema = z.discriminatedUnion("kind", [beginSchema, completeSchema]);
/** Required registrations are authoritative inputs, never inferred from the journal. */
export const expectedSchema = z.strictObject({
  hook: hookSchema,
  currentImpl: implementationSchema,
  engines: z
    .array(engineSchema)
    .nonempty()
    .refine((engines: Engine[]): boolean => new Set(engines).size === engines.length),
});
export type Receipt = z.infer<typeof beginSchema>;
export type Completion = z.infer<typeof completeSchema>;
export type ShadowRecord = z.infer<typeof recordSchema>;
export type Expected = z.infer<typeof expectedSchema>;
export type Engine = z.infer<typeof engineSchema>;
