import { randomUUID } from "node:crypto";
import { fstatSync, lstatSync } from "node:fs";
import { join } from "node:path";
import {
  ensurePrivateAuditDirectory,
  createPrivateAuditFile,
  appendPrivateAuditFile,
  readPrivateAuditFile,
} from "../audit/paths.ts";
import {
  beginSchema,
  comparisonSchema,
  completeSchema,
  expectedSchema,
  identitySchema,
  rootSchema,
  timeSchema,
  diverged,
  MAX_LINE_BYTES,
  MAX_LOG_BYTES,
  type Receipt,
} from "./journal.schema.ts";
import { analyze, type Report } from "./report.ts";

export type Refusal = { ok: false; reason: "invalid" | "unavailable" | "limit" };
export type BeginAck = { ok: true; receipt: Receipt } | Refusal;
export type CompleteAck = { ok: true } | Refusal;
interface Location {
  directory: string;
  file: string;
}

/** Location uses only validated path segments and an explicit local owned boundary. */
function location(root: unknown, hook: string): Location | null {
  const parsed = rootSchema.safeParse(root);
  if (!parsed.success) return null;
  try {
    if (!lstatSync(parsed.data).isDirectory()) return null;
  } catch {
    return null;
  }
  const directory = join(parsed.data, ".navori", "state", "rust-shadow");
  return { directory, file: join(directory, `${hook}.jsonl`) };
}

/** Append every row, including the first, after exclusive empty-file initialization. */
function append(target: Location, line: string): CompleteAck {
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) return { ok: false, reason: "limit" };
  const result = appendPrivateAuditFile(
    target.file,
    (fd: number): string => {
      if (fstatSync(fd).size + Buffer.byteLength(line, "utf8") > MAX_LOG_BYTES)
        throw new Error("limit");
      return line;
    },
    { ownedRoot: target.directory },
  );
  return result.ok ? { ok: true } : { ok: false, reason: "unavailable" };
}

/** Append and acknowledge begin before evaluation/stdin; an unavailable ack keeps the shell route. */
export function begin(root: unknown, identity: unknown): BeginAck {
  const checked = identitySchema.safeParse(identity);
  if (!checked.success) return { ok: false, reason: "invalid" };
  const target = location(root, checked.data.hook);
  if (!target) return { ok: false, reason: "invalid" };
  try {
    const record = beginSchema.safeParse({
      ...checked.data,
      schema: 1,
      kind: "begin",
      id: randomUUID(),
      timeMs: Date.now(),
    });
    if (!record.success) return { ok: false, reason: "invalid" };
    const options = { ownedRoot: target.directory };
    let directory = ensurePrivateAuditDirectory(target.directory, options);
    // Only the three local ancestors may be created; each concurrent mkdir gets one revalidation.
    // Append/short-write operations are never retried.
    for (let retries = 0; retries < 3 && !directory.ok && directory.reason === "exists"; retries++)
      directory = ensurePrivateAuditDirectory(target.directory, options);
    if (!directory.ok) return { ok: false, reason: "unavailable" };
    const created = createPrivateAuditFile(target.file, "", options);
    if (!created.ok && created.reason !== "exists") return { ok: false, reason: "unavailable" };
    const written = append(target, JSON.stringify(record.data) + "\n");
    return written.ok ? { ok: true, receipt: record.data } : written;
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/** Append a structural completion; report alone establishes binding and evidence readiness. */
export function complete(
  root: unknown,
  receipt: unknown,
  comparison: unknown,
  payloadBytes: unknown,
): CompleteAck {
  const start = beginSchema.safeParse(receipt);
  const flags = comparisonSchema.safeParse(comparison);
  const now = timeSchema.safeParse(Date.now());
  if (
    !start.success ||
    !flags.success ||
    !now.success ||
    !(payloadBytes instanceof Uint8Array) ||
    now.data < start.data.timeMs
  )
    return { ok: false, reason: "invalid" };
  const target = location(root, start.data.hook);
  if (!target) return { ok: false, reason: "invalid" };
  if (diverged(flags.data) && Math.ceil(payloadBytes.byteLength / 3) * 4 > MAX_LINE_BYTES)
    return { ok: false, reason: "limit" };
  const end = completeSchema.safeParse({
    ...start.data,
    kind: "complete",
    timeMs: now.data,
    comparison: flags.data,
    ...(diverged(flags.data)
      ? { payloadBase64: Buffer.from(payloadBytes).toString("base64") }
      : {}),
  });
  if (!end.success) return { ok: false, reason: "invalid" };
  return append(target, JSON.stringify(end.data) + "\n");
}

/** Read a checked local snapshot; an unsafe/missing/oversized artifact cannot establish evidence. */
export function report(root: unknown, expected: unknown): Report {
  const checked = expectedSchema.safeParse(expected);
  if (!checked.success) return { available: false, ready: false, reason: "invalid" };
  const target = location(root, checked.data.hook);
  if (!target) return { available: false, ready: false, reason: "invalid" };
  const read = readPrivateAuditFile(target.file, {
    ownedRoot: target.directory,
    maxBytes: MAX_LOG_BYTES,
  });
  return read.ok
    ? analyze(read.value, checked.data, Date.now())
    : { available: false, ready: false, reason: "unavailable" };
}
