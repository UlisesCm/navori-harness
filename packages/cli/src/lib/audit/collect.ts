import { appendFileSync, existsSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { NavoriError } from "../errors.ts";
import { auditsRoot, sessionLogPath } from "./paths.ts";

/**
 * The OTel events receiver — audit's third source (spec 0021).
 *
 * The hook log says what the harness did and the transcript says what it cost.
 * Neither can say what the HOST decided: `parse.ts` declares both blind spots
 * in its own comments — a granted permission prompt is indistinguishable from
 * a pre-approved tool, and skill activation is inferred from whoever opened a
 * `SKILL.md`. Claude Code's events carry both as facts (`tool_decision.source`,
 * `api_request.skill.name`), and every event carries `session.id`, so the join
 * with the audit store is by equality of id and never by clock window.
 *
 * Events land in the session log the hooks already write, appended with the
 * same `O_APPEND` discipline and the same `ts`/`tsMs` pair: no sidecar, no
 * dump step, and no question about what happens when a session dies before its
 * `--stop`. That only became viable with #689, which added `tsMs` and the
 * chronological reordering — events arrive batched once a second, so without a
 * millisecond key they would pile up at the end of the file unorderable.
 *
 * navori PROVIDES this receiver; the operator RUNS it (`navori audit
 * --collect`). That is invariant 9 of `DIRECTION.md` — navori generates and
 * provides, it does not start processes on its own — and `collect.test.ts`
 * turns it into an executable check: no path outside this file may listen on a
 * port.
 */

/**
 * Loopback only (R6), and not configurable: the receiver appends whatever an
 * unauthenticated POST hands it to the operator's audit store. A `host` option
 * is the one knob that would turn a local debugging aid into an open write
 * endpoint, so it does not exist.
 */
const HOST = "127.0.0.1";

/** The port the env contract in `design.md` tells the operator to export. */
export const DEFAULT_PORT = 4318;

/** The only route that ingests; everything but this and `/healthz` gets a 404. */
const LOGS_PATH = "/v1/logs";

/**
 * A liveness route, and the reason it exists rather than letting a caller
 * infer health from a socket that accepts.
 *
 * `doctor` has to tell three states apart: nobody on the port, THIS receiver
 * on the port, and somebody else's collector on the port. The first two a bare
 * connection can separate; the third it cannot, and an operator who already
 * runs an OTLP collector on 4318 would read a green check while every navori
 * event went into somebody else's pipeline.
 */
const HEALTH_PATH = "/healthz";

/** What `/healthz` answers with, so a caller can tell whose receiver this is. */
export const SERVICE_ID = "navori-audit-collect";

/**
 * Bodies past this are dropped instead of buffered. The exporter batches once
 * a second, so a legitimate batch is kilobytes; the cap is what keeps a stray
 * POST from growing the receiver's heap without bound.
 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * One flattened event, the shape that reaches the session log.
 *
 * It is an ALLOWLIST (R8): these fields and no others. A denylist would have
 * to guess right about every attribute the host adds later, and the host is
 * the side that can send the prompt's text — so the failure mode has to be
 * "did not store it", not "stored it until someone noticed".
 *
 * `session.id` is deliberately NOT among them: the file already belongs to
 * that session, and the hook records next to these carry no id either.
 */
export interface OtelRecord {
  /** Second resolution, exactly like the hook log's `ts`. */
  ts: string;
  /** Epoch milliseconds — the key `chronological()` orders by (#689). */
  tsMs: number;
  /** Host event name without its `claude_code.` prefix, e.g. `tool_decision`. */
  event: string;
  /** `tool_decision` only. */
  tool?: string;
  /** `tool_decision` only. */
  decision?: string;
  /** `tool_decision` only: `config` | `hook` | `user_*` — the R12 grouping. */
  source?: string;
  /** `api_request` only, and the reason that event is kept at all. */
  skill?: string;
  /** `api_request` only. */
  agent?: string;
  /** `api_request` only. */
  model?: string;
}

export interface ReceiverStats {
  /** Events appended to a session log. */
  written: number;
  /** Everything dropped: unreadable body, unmarked session, filtered event. */
  discarded: number;
  /** Distinct sessions this receiver has appended to. */
  sessions: number;
}

export interface OtelReceiver {
  /** The full URL the operator exports as `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`. */
  readonly url: string;
  /** `host:port`, the form the `otel-start` record carries. */
  readonly endpoint: string;
  readonly port: number;
  stats(): ReceiverStats;
  close(): Promise<void>;
}

/**
 * An OTLP attribute value, in the scalar shapes the exporter actually emits.
 *
 * Everything is normalized to a string because every allowlisted field is one:
 * a record whose fields change type with the wire encoding (`intValue` arrives
 * as a JSON string in OTLP/JSON, by spec) is a record every future reader has
 * to re-normalize.
 */
function attrScalar(v: unknown): string | null {
  if (!isRec(v)) return null;
  if (typeof v.stringValue === "string") return v.stringValue;
  if (typeof v.intValue === "string") return v.intValue;
  if (typeof v.intValue === "number") return String(v.intValue);
  if (typeof v.boolValue === "boolean") return String(v.boolValue);
  if (typeof v.doubleValue === "number") return String(v.doubleValue);
  return null;
}

/** Collects `attributes: [{key, value}]` from one OTLP node into `into`. */
function collectAttributes(node: unknown, into: Map<string, string>): void {
  if (!isRec(node) || !Array.isArray(node.attributes)) return;
  for (const attr of node.attributes) {
    if (!isRec(attr) || typeof attr.key !== "string") continue;
    const value = attrScalar(attr.value);
    if (value !== null) into.set(attr.key, value);
  }
}

/** Nanoseconds since the epoch (OTLP sends them as a decimal string) → ms. */
function msFromUnixNano(v: unknown): number | null {
  const raw = typeof v === "string" || typeof v === "number" ? String(v) : null;
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const ms = Number(BigInt(raw) / 1_000_000n);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * The `ts`/`tsMs` pair, stamped exactly as `audit-log.sh` stamps the hook
 * records this file sits next to.
 *
 * `ts` keeps second resolution — the raw log is read by hand when the auditor
 * itself is being debugged, and an epoch integer is not readable — while
 * `tsMs` is what any ordering actually uses (#685, #689).
 */
function stamp(ms: number): { ts: string; tsMs: number } {
  return { ts: `${new Date(ms).toISOString().slice(0, 19)}Z`, tsMs: ms };
}

/**
 * The event name, from the three places an OTLP emitter can put it.
 *
 * Claude Code documents it as the `event.name` attribute, already stripped of
 * the `claude_code.` prefix. The other two are where the OTel spec itself
 * allows it — the record's `eventName` field and its body — and reading all
 * three costs nothing, while getting it wrong silently drops every event of a
 * host version that moved it.
 */
function eventNameOf(record: Rec, attrs: Map<string, string>): string | null {
  const fromAttr = attrs.get("event.name");
  const fromField = typeof record.eventName === "string" ? record.eventName : null;
  const fromBody =
    isRec(record.body) && typeof record.body.stringValue === "string"
      ? record.body.stringValue
      : null;
  const name = (fromAttr ?? fromField ?? fromBody ?? "").trim();
  if (!name) return null;
  return name.replace(/^claude_code\./, "");
}

/** One event, with the session it belongs to kept OUT of the persisted record. */
export interface RoutedEvent {
  sessionId: string;
  record: OtelRecord;
}

/**
 * Flattens one OTLP export request into the events that will reach disk.
 *
 * The envelope nests `resourceLogs → scopeLogs → logRecords` with attributes
 * as `{key, value}` pairs; flattening at WRITE time leaves the file with the
 * same shape as the hook records already in it — one JSON line, flat fields —
 * instead of making every future reader re-implement the unnesting.
 *
 * Returns `null` when the body is not an OTLP envelope at all (R5); the
 * `discarded` count covers events dropped INSIDE a well-formed envelope.
 */
export function flattenOtlp(body: unknown): { events: RoutedEvent[]; discarded: number } | null {
  if (!isRec(body) || !Array.isArray(body.resourceLogs)) return null;
  const events: RoutedEvent[] = [];
  let discarded = 0;
  const receivedAt = Date.now();

  for (const resourceLog of body.resourceLogs) {
    if (!isRec(resourceLog)) continue;
    const resourceAttrs = new Map<string, string>();
    collectAttributes(resourceLog.resource, resourceAttrs);
    const scopeLogs = Array.isArray(resourceLog.scopeLogs) ? resourceLog.scopeLogs : [];

    for (const scopeLog of scopeLogs) {
      if (!isRec(scopeLog)) continue;
      const logRecords = Array.isArray(scopeLog.logRecords) ? scopeLog.logRecords : [];

      for (const record of logRecords) {
        if (!isRec(record)) {
          discarded++;
          continue;
        }
        // Resource attributes first so a record-level key of the same name
        // wins: the inner scope is the more specific statement about the event.
        const attrs = new Map(resourceAttrs);
        collectAttributes(record, attrs);

        const event = eventNameOf(record, attrs);
        const sessionId = attrs.get("session.id");
        // An event that names no session has no log to belong to, and guessing
        // one would invent exactly the join this spec exists to make exact.
        // Same for a nameless event: `event` is not optional on disk.
        if (!event || !sessionId) {
          discarded++;
          continue;
        }

        const declared = attrs.get("event.timestamp");
        const declaredMs = declared ? Date.parse(declared) : Number.NaN;
        const ms = Number.isFinite(declaredMs)
          ? declaredMs
          : (msFromUnixNano(record.timeUnixNano) ??
            msFromUnixNano(record.observedTimeUnixNano) ??
            receivedAt);

        const flat: OtelRecord = { ...stamp(ms), event };

        if (event === "tool_decision") {
          const tool = attrs.get("tool_name");
          // `decision` is what the spec's contract writes; `decision_type` is
          // the spelling the host's own docs show. Reading both and writing
          // one keeps the log's shape stable across that difference.
          const decision = attrs.get("decision") ?? attrs.get("decision_type");
          const source = attrs.get("source");
          if (tool) flat.tool = tool;
          if (decision) flat.decision = decision;
          if (source) flat.source = source;
        } else if (event === "api_request") {
          const skill = attrs.get("skill.name");
          // `api_request` fires on EVERY request and the session log already
          // runs to thousands of lines. Without a skill it carries nothing
          // this spec reads, so it is volume with no reader.
          if (!skill) {
            discarded++;
            continue;
          }
          const agent = attrs.get("agent.name");
          const model = attrs.get("model");
          flat.skill = skill;
          if (agent) flat.agent = agent;
          if (model) flat.model = model;
        }

        events.push({ sessionId, record: flat });
      }
    }
  }

  return { events, discarded };
}

/**
 * The session log an event belongs to, or `null` when nobody marked that
 * session.
 *
 * Scanning the store's repo directories is the same fallback `resolveTranscript`
 * uses, and for the same reason: the event names a session, not a repo, so one
 * receiver serves every repo the operator works in. The result — including the
 * miss — is cached per id, so it costs one `readdir` per new session instead of
 * one per event.
 *
 * Caching the miss has a consequence worth naming: a session whose log appears
 * AFTER its first event stays unresolved until the receiver restarts. In the
 * flow this spec designs for, the log exists first — the hook writes it at
 * SessionStart, before any request could be exported.
 */
function resolveSessionLog(sessionId: string, cache: Map<string, string | null>): string | null {
  const cached = cache.get(sessionId);
  if (cached !== undefined) return cached;

  let found: string | null = null;
  const root = auditsRoot();
  if (existsSync(root)) {
    for (const repo of readdirSync(root)) {
      let candidate: string;
      try {
        // The id came off the network: `sessionLogPath` is what rejects a
        // path-shaped one, and its throw must not take the receiver down.
        candidate = sessionLogPath(repo, sessionId);
      } catch {
        break; // the id itself is unusable — no repo will make it valid
      }
      if (existsSync(candidate)) {
        found = candidate;
        break;
      }
    }
  }
  cache.set(sessionId, found);
  return found;
}

/**
 * Appends the events of one request, grouped so each session's log is opened
 * once per batch rather than once per event.
 *
 * Nothing is created here (R3): the log's existence IS the record that someone
 * opted into auditing that session, and writing one would turn the third source
 * into a back door for activating audit-mode.
 */
function appendEvents(
  events: RoutedEvent[],
  endpoint: string,
  cache: Map<string, string | null>,
  marked: Set<string>,
): { written: number; discarded: number } {
  const bySession = new Map<string, OtelRecord[]>();
  for (const { sessionId, record } of events) {
    const batch = bySession.get(sessionId);
    if (batch) batch.push(record);
    else bySession.set(sessionId, [record]);
  }

  let written = 0;
  let discarded = 0;
  for (const [sessionId, records] of bySession) {
    const logFile = resolveSessionLog(sessionId, cache);
    if (logFile === null) {
      discarded += records.length;
      continue;
    }
    const lines: string[] = [];
    if (!marked.has(sessionId)) {
      // R4: the horizon. Same reason `hookLogFrom` exists — without it "no
      // manual approvals" and "nobody was listening" render identically. It
      // lives in the log rather than in the report so the answer survives the
      // run that produced it.
      lines.push(`${JSON.stringify({ ...stamp(Date.now()), event: "otel-start", endpoint })}\n`);
    }
    for (const record of records) lines.push(`${JSON.stringify(record)}\n`);
    try {
      appendFileSync(logFile, lines.join(""), "utf-8");
      written += records.length;
      marked.add(sessionId);
    } catch {
      // A failed write is data lost, not a reason to stop listening: the
      // session in flight keeps exporting and the next batch may well land.
      discarded += records.length;
    }
  }
  return { written, discarded };
}

/** Reads the whole request body, capped. `null` means it was too large. */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflowed = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        overflowed = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(overflowed ? null : Buffer.concat(chunks).toString("utf-8")));
    req.on("error", () => resolve(null));
  });
}

/**
 * Starts the receiver. Resolves once it is listening; rejects — without having
 * touched the disk — when the address is taken (R7), which is what a previous
 * `--collect` still running looks like.
 */
export function startReceiver(opts: { port?: number }): Promise<OtelReceiver> {
  const port = opts.port ?? DEFAULT_PORT;
  /** Session id → its log, or `null` for "nobody marked it". */
  const logCache = new Map<string, string | null>();
  /** Sessions whose horizon this receiver already wrote. */
  const marked = new Set<string>();
  let written = 0;
  let discarded = 0;
  let endpoint = `${HOST}:${port}`;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === HEALTH_PATH) {
      // Counts only. The store's path would hand the home directory to any
      // local process that can reach an unauthenticated loopback port.
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ service: SERVICE_ID, written, discarded, sessions: marked.size }));
      return;
    }
    if (req.method !== "POST" || path !== LOGS_PATH) {
      res.writeHead(404, { "content-type": "application/json" }).end("{}");
      return;
    }
    void readBody(req).then((raw) => {
      // 200 even on garbage (R5): OTLP exporters RETRY a failed export, so an
      // error here buys the operator a retry storm and latency in the session
      // being audited — observability that costs the thing it observes.
      const respond = (): void => {
        res.writeHead(200, { "content-type": "application/json" }).end('{"partialSuccess":{}}');
      };
      if (raw === null) {
        discarded++;
        respond();
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        discarded++;
        respond();
        return;
      }
      const flat = flattenOtlp(parsed);
      // Valid JSON that is not an OTLP envelope is the case a naive parser
      // lets through: it has no `resourceLogs`, so it yields no events and is
      // counted once, like any other unreadable body.
      if (flat === null) {
        discarded++;
        respond();
        return;
      }
      discarded += flat.discarded;
      const result = appendEvents(flat.events, endpoint, logCache, marked);
      written += result.written;
      discarded += result.discarded;
      respond();
    });
  });

  return new Promise<OtelReceiver>((resolve, reject) => {
    const onListenError = (err: NodeJS.ErrnoException): void => {
      const address = `${HOST}:${port}`;
      reject(
        new NavoriError(
          "audit-collect-address-in-use",
          err.code === "EADDRINUSE"
            ? `${address} is already in use — another 'navori audit --collect' is probably still ` +
                `running. Nothing was written: stop that one, or free the address, and try again.`
            : `Could not listen on ${address}: ${err.message}`,
        ),
      );
    };
    server.once("error", onListenError);
    server.listen(port, HOST, () => {
      server.removeListener("error", onListenError);
      // Past startup an error is one connection's problem, not the process's:
      // the receiver has to outlive a peer that resets mid-export.
      server.on("error", () => {});
      const bound = server.address();
      const actualPort = typeof bound === "object" && bound !== null ? bound.port : port;
      endpoint = `${HOST}:${actualPort}`;
      resolve({
        url: `http://${endpoint}${LOGS_PATH}`,
        endpoint,
        port: actualPort,
        stats: () => ({ written, discarded, sessions: marked.size }),
        close: () =>
          new Promise<void>((done) => {
            // Keep-alive sockets outlive `close()` on their own, and the
            // exporter holds one open: without this the command never exits.
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
