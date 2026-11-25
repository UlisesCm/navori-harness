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
/** Closed hook protocol exit codes (0 permit, 1 error, 2 block, 3 stdin untouched). */
const protocolCodeSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
/** Closed comparison summaries never contain raw stdout/stderr or payload. */
export const comparisonSchema = z.strictObject({
  /** Spec 0059 D40: the native lane stopped at a branch with effects; nothing was compared. */
  nativeUnobserved: z.literal(true).optional(),
  nativeFailed: z.boolean(),
  shellFailed: z.boolean(),
  codeDiffers: z.boolean(),
  stdoutDiffers: z.boolean(),
  stderrDiffers: z.boolean(),
  /** Protocol code of each lane, only on a divergence and only when that lane finished. */
  shellCode: protocolCodeSchema.optional(),
  nativeCode: protocolCodeSchema.optional(),
});
export type Comparison = z.infer<typeof comparisonSchema>;
export type Identity = z.infer<typeof identitySchema>;

/** A controlled native/shell failure is itself a divergence; an unobserved native lane is not. */
export function diverged(comparison: Comparison): boolean {
  if (comparison.shellFailed) return true;
  if (comparison.nativeUnobserved === true) return false;
  return (
    comparison.nativeFailed ||
    comparison.codeDiffers ||
    comparison.stdoutDiffers ||
    comparison.stderrDiffers
  );
}

const common = { schema: z.literal(1), id: z.uuid(), ...identitySchema.shape, timeMs: timeSchema };
/** Acknowledged observation start; payload is forbidden by the strict shape. */
export const beginSchema = z.strictObject({ ...common, kind: z.literal("begin") });
const completeShape = {
  ...common,
  kind: z.literal("complete"),
  comparison: comparisonSchema,
};
/** Written completion: the payload is forbidden by the strict shape. */
export const completeSchema = z
  .strictObject(completeShape)
  .refine(
    ({ comparison }: { comparison: Comparison }): boolean =>
      diverged(comparison) ||
      (comparison.shellCode === undefined && comparison.nativeCode === undefined),
    { message: "protocol codes only on a divergence" },
  );
/**
 * Read-side completion. Rows written before the payload was dropped may still carry
 * `payloadBase64`: it is accepted so old evidence stays readable, never inspected, and counted
 * by the report so the journal can be deleted.
 */
const completeReadSchema = z.strictObject({
  ...completeShape,
  payloadBase64: z.string().max(MAX_LINE_BYTES).optional(),
});
/** Strict versioned wire records (write side). */
export const recordSchema = z.discriminatedUnion("kind", [beginSchema, completeSchema]);
/** Records as they may exist on disk, including legacy completions. */
export const readRecordSchema = z.discriminatedUnion("kind", [beginSchema, completeReadSchema]);
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
