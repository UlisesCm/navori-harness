import {
  expectedSchema,
  recordSchema,
  timeSchema,
  diverged,
  MAX_LINE_BYTES,
  MAX_LOG_BYTES,
  type Engine,
  type Receipt,
  type Completion,
  type ShadowRecord,
} from "./journal.schema.ts";

/** Required completed matches per registered engine. */
export const MIN_COMPLETE = 500;
/** Exact elapsed duration; calendar dates and completion delays are not evidence. */
export const MIN_SPAN_MS = 14 * 24 * 60 * 60 * 1000;
export interface EngineReport {
  engine: Engine;
  complete: number;
  matched: number;
  divergences: number;
  pending: number;
  /** Completed calls whose native lane stopped at a branch with effects (spec 0059 D40). */
  unobserved: number;
  spanMs: number;
}
export type Report =
  | { available: false; ready: false; reason: "invalid" | "unavailable" }
  | { available: true; ready: boolean; hook: string; currentImpl: string; engines: EngineReport[] };

/** Bounded lossless UTF-8 JSONL parsing, with no line/tail repair or omitted rows. */
export function decodeRecords(bytes: Uint8Array): ShadowRecord[] | null {
  if (bytes.byteLength > MAX_LOG_BYTES) return null;
  const buffer = Buffer.from(bytes);
  if (buffer.length && buffer[buffer.length - 1] !== 10) return null;
  const text = buffer.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buffer)) return null;
  const lines = text.length ? text.slice(0, -1).split("\n") : [];
  const records: ShadowRecord[] = [];
  try {
    for (const line of lines) {
      if (Buffer.byteLength(line, "utf8") + 1 > MAX_LINE_BYTES) return null;
      const raw: unknown = JSON.parse(line);
      const record = recordSchema.safeParse(raw);
      if (!record.success) return null;
      records.push(record.data);
    }
    return records;
  } catch {
    return null;
  }
}

/** Exact producer identity binding; completion cannot move across hook/version/engine. */
export function sameIdentity(begin: Receipt, end: Completion): boolean {
  return (
    begin.id === end.id &&
    begin.hook === end.hook &&
    begin.engine === end.engine &&
    begin.implementation === end.implementation
  );
}

/** Analyze a validated snapshot as of the CLI clock. Never return payload or raw output. */
export function analyze(bytes: Uint8Array, expected: unknown, nowMs: number): Report {
  const configuration = expectedSchema.safeParse(expected);
  if (!configuration.success || !timeSchema.safeParse(nowMs).success)
    return { available: false, ready: false, reason: "invalid" };
  const rows = decodeRecords(bytes);
  if (rows === null) return { available: false, ready: false, reason: "invalid" };
  const starts = new Map<string, Receipt>();
  const ends = new Map<string, Completion>();
  const wanted = configuration.data;
  for (const row of rows) {
    if (row.hook !== wanted.hook || row.timeMs > nowMs)
      return { available: false, ready: false, reason: "invalid" };
    if (row.kind === "begin") {
      if (starts.has(row.id)) return { available: false, ready: false, reason: "invalid" };
      starts.set(row.id, row);
    } else {
      const begin = starts.get(row.id);
      if (!begin || ends.has(row.id) || !sameIdentity(begin, row) || row.timeMs < begin.timeMs)
        return { available: false, ready: false, reason: "invalid" };
      ends.set(row.id, row);
    }
  }
  const engines: EngineReport[] = wanted.engines.map((engine: Engine): EngineReport => ({
    engine,
    complete: 0,
    matched: 0,
    divergences: 0,
    pending: 0,
    unobserved: 0,
    spanMs: 0,
  }));
  const spans = new Map<Engine, { min: number; max: number }>();
  for (const begin of starts.values()) {
    if (begin.implementation !== wanted.currentImpl) continue;
    const summary = engines.find((entry: EngineReport): boolean => entry.engine === begin.engine);
    if (!summary) return { available: false, ready: false, reason: "invalid" };
    const end = ends.get(begin.id);
    if (!end) {
      summary.pending++;
      continue;
    }
    summary.complete++;
    if (diverged(end.comparison)) summary.divergences++;
    else if (end.comparison.nativeUnobserved === true) {
      // Not evidence either way: it neither matches nor moves the observation window.
      summary.unobserved++;
      continue;
    } else summary.matched++;
    const previous = spans.get(begin.engine);
    spans.set(begin.engine, {
      min: Math.min(previous?.min ?? begin.timeMs, begin.timeMs),
      max: Math.max(previous?.max ?? begin.timeMs, begin.timeMs),
    });
  }
  for (const engine of engines) {
    const span = spans.get(engine.engine);
    engine.spanMs = span ? span.max - span.min : 0;
  }
  const ready =
    engines.some((engine: EngineReport): boolean => engine.engine !== "claude") &&
    engines.every(
      (engine: EngineReport): boolean =>
        engine.matched >= MIN_COMPLETE &&
        engine.divergences === 0 &&
        engine.pending === 0 &&
        engine.spanMs >= MIN_SPAN_MS,
    );
  return { available: true, ready, hook: wanted.hook, currentImpl: wanted.currentImpl, engines };
}
