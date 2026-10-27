import { readFileSync } from "node:fs";
import { defineCommand } from "citty";
import { z } from "zod";
import { begin, complete, report } from "./journal.ts";
import { engineSchema } from "./journal.schema.ts";

/**
 * Spec 0057 D9 — machine bridge between the native shadow executor and the private journal.
 * The CLI stays the only writer (D12): `navori-rust` never appends journal rows itself.
 * Every verb prints one JSON line on stdout and exits 0 only on an acknowledged result.
 */

/** `complete` input read from stdin; payload bytes travel only when the comparison diverged. */
const completionInputSchema = z.strictObject({
  receipt: z.unknown(),
  comparison: z.unknown(),
  payloadBase64: z.string().optional(),
});

/** Decoded payload, or null when the base64 is not canonical (a lossy decode is never accepted). */
export function decodePayload(base64: string | undefined): Uint8Array | null {
  if (base64 === undefined) return new Uint8Array();
  const bytes = Buffer.from(base64, "base64");
  return bytes.toString("base64") === base64 ? new Uint8Array(bytes) : null;
}

/** `complete` over a raw stdin document; invalid input is a refusal, never an exception. */
export function completeFromInput(root: string, input: string): ReturnType<typeof complete> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const checked = completionInputSchema.safeParse(parsed);
  if (!checked.success) return { ok: false, reason: "invalid" };
  const payload = decodePayload(checked.data.payloadBase64);
  if (payload === null) return { ok: false, reason: "invalid" };
  return complete(root, checked.data.receipt, checked.data.comparison, payload);
}

/** Comma-separated engines exactly as `report` requires them, or null when any is unknown. */
export function parseEngines(value: string): string[] | null {
  const engines = value.split(",");
  return engines.every((engine: string): boolean => engineSchema.safeParse(engine).success)
    ? engines
    : null;
}

function emit(value: unknown, ok: boolean): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  if (!ok) process.exitCode = 1;
}

const beginCommand = defineCommand({
  meta: { name: "begin", description: "Acknowledge a shadow observation before reading stdin" },
  args: {
    root: { type: "string", required: true, description: "Absolute project root" },
    hook: { type: "string", required: true, description: "Hook id" },
    engine: { type: "string", required: true, description: "claude | codex | pi" },
    impl: { type: "string", required: true, description: "Compiled sha256 implementation" },
  },
  run({ args }) {
    const ack = begin(args.root, {
      hook: args.hook,
      engine: args.engine,
      implementation: args.impl,
    });
    emit(ack.ok ? ack.receipt : ack, ack.ok);
  },
});

const completeCommand = defineCommand({
  meta: { name: "complete", description: "Record a shadow comparison read from stdin" },
  args: {
    root: { type: "string", required: true, description: "Absolute project root" },
  },
  run({ args }) {
    let input: string;
    try {
      input = readFileSync(0, "utf8");
    } catch {
      emit({ ok: false, reason: "unavailable" }, false);
      return;
    }
    const ack = completeFromInput(args.root, input);
    emit(ack, ack.ok);
  },
});

const reportCommand = defineCommand({
  meta: { name: "report", description: "Summarize shadow evidence for one hook" },
  args: {
    root: { type: "string", required: true, description: "Absolute project root" },
    hook: { type: "string", required: true, description: "Hook id" },
    impl: { type: "string", required: true, description: "Current compiled implementation" },
    engines: { type: "string", required: true, description: "Comma-separated engines" },
  },
  run({ args }) {
    const engines = parseEngines(args.engines);
    const result =
      engines === null
        ? { available: false, ready: false, reason: "invalid" }
        : report(args.root, { hook: args.hook, currentImpl: args.impl, engines });
    emit(result, result.ready);
  },
});

/** `navori tools rust-shadow`: machine verbs for the D9 shadow journal. */
export const rustShadowCommand = defineCommand({
  meta: { name: "rust-shadow", description: "Machine bridge to the native shadow journal" },
  subCommands: { begin: beginCommand, complete: completeCommand, report: reportCommand },
});
