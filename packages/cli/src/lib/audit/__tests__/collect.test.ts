import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startReceiver, type OtelReceiver } from "../collect.ts";
import { sessionLogPath } from "../paths.ts";
import { getCoreRoot } from "../../bundled-assets.ts";
import { NavoriError } from "../../errors.ts";

/**
 * The receiver is exercised over REAL HTTP against an ephemeral port, never by
 * calling the handler.
 *
 * What is in doubt is the contract with an external emitter — the route, the
 * method, the status code it gets back — and a direct call proves none of it.
 * The emitter is Claude Code's OTLP exporter, which retries on a failed export:
 * the status code is load-bearing for the audited session's latency, not a
 * detail (R5).
 */

const REPO = "demo";

let root: string;
const open: OtelReceiver[] = [];

async function receiver(): Promise<OtelReceiver> {
  // Port 0: the OS picks a free one. A hardcoded 4318 would make the suite
  // fail for whoever happens to have a real --collect running.
  const r = await startReceiver({ port: 0 });
  open.push(r);
  return r;
}

/** A session marked with audit-mode — the log the hook writes at SessionStart. */
function markSession(sessionId: string, repo = REPO): string {
  const file = sessionLogPath(repo, sessionId);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ ts: "2026-09-11T18:29:00Z", tsMs: 1789496940000, event: "start", repo, sessionId })}\n`,
    "utf-8",
  );
  return file;
}

/** An OTLP/JSON export envelope carrying one log record per event. */
function otlpBatch(events: Array<Record<string, string>>): string {
  return JSON.stringify({
    resourceLogs: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
        scopeLogs: [
          {
            logRecords: events.map((attrs) => ({
              timeUnixNano: "1789496999000000000",
              body: { stringValue: "" },
              attributes: Object.entries(attrs).map(([key, value]) => ({
                key,
                value: { stringValue: value },
              })),
            })),
          },
        ],
      },
    ],
  });
}

async function post(url: string, body: string): Promise<Response> {
  return await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function linesOf(sessionId: string, repo = REPO): Array<Record<string, unknown>> {
  const file = sessionLogPath(repo, sessionId);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "navori-audit-collect-"));
  process.env.NAVORI_AUDITS_ROOT = root;
});

afterEach(async () => {
  // Closed here and not at the end of each test: a failed assertion skips the
  // rest of the test body, and a live server keeps vitest's process alive.
  while (open.length > 0) await open.pop()?.close();
  process.env.NAVORI_AUDITS_ROOT = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe("startReceiver (#0021)", () => {
  // Covers: R1, R2, R6, R7
  it("escribe cada evento del lote en el log de su sesión", async () => {
    markSession("sess-one");
    // A second session in a DIFFERENT repo: the event names a session, not a
    // repo, so one receiver serves every repo the operator works in.
    markSession("sess-two", "otro-repo");

    const r = await receiver();
    // R1/R6: what it confirms is an address, and it is a loopback one.
    expect(r.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/logs$/);
    expect(r.port).toBeGreaterThan(0);

    const res = await post(
      r.url,
      otlpBatch([
        {
          "event.name": "tool_decision",
          "event.timestamp": "2026-09-11T18:30:00.456Z",
          "session.id": "sess-one",
          tool_name: "Bash",
          decision: "accept",
          source: "user_temporary",
        },
        {
          "event.name": "claude_code.api_request",
          "event.timestamp": "2026-09-11T18:30:04.880Z",
          "session.id": "sess-one",
          "skill.name": "structural-search",
          "agent.name": "researcher",
          model: "claude-opus-5",
        },
        {
          "event.name": "tool_decision",
          "event.timestamp": "2026-09-11T18:31:00.000Z",
          "session.id": "sess-two",
          tool_name: "Read",
          decision: "accept",
          source: "config",
        },
      ]),
    );
    expect(res.status).toBe(200);

    // R2: appended, never rewritten — the hook's `start` record is still the
    // first line of the file.
    const one = linesOf("sess-one");
    expect(one[0]?.event).toBe("start");
    // `ts` keeps the hook log's second resolution; `tsMs` is what orders them.
    // `session.id` is NOT persisted: the file already belongs to that session.
    expect(one[2]).toEqual({
      ts: "2026-09-11T18:30:00Z",
      tsMs: Date.parse("2026-09-11T18:30:00.456Z"),
      event: "tool_decision",
      tool: "Bash",
      decision: "accept",
      source: "user_temporary",
    });
    // The `claude_code.` prefix is stripped: the log names the event the way
    // the report will read it.
    expect(one[3]).toEqual({
      ts: "2026-09-11T18:30:04Z",
      tsMs: Date.parse("2026-09-11T18:30:04.880Z"),
      event: "api_request",
      skill: "structural-search",
      agent: "researcher",
      model: "claude-opus-5",
    });

    expect(linesOf("sess-two", "otro-repo").map((l) => l.event)).toEqual([
      "start",
      "otel-start",
      "tool_decision",
    ]);
    expect(r.stats()).toEqual({ written: 3, discarded: 0, sessions: 2 });
  });

  // Covers: R1, R2, R6, R7
  it("falla sin crear archivos cuando la dirección está ocupada", async () => {
    const squatter = createServer();
    await new Promise<void>((done) => squatter.listen(0, "127.0.0.1", () => done()));
    const address = squatter.address();
    const taken = typeof address === "object" && address !== null ? address.port : 0;

    // The typical cause is a previous --collect still recording a live
    // session: taking its address would be bad, truncating its output worse.
    await expect(startReceiver({ port: taken })).rejects.toThrow(NavoriError);
    await expect(startReceiver({ port: taken })).rejects.toThrow(String(taken));
    // R7 is about the disk, not the message: nothing was created.
    expect(readdirSync(root)).toEqual([]);

    await new Promise<void>((done) => squatter.close(() => done()));
  });

  // Covers: R3, R4
  it("no crea el log de una sesión que nadie marcó", async () => {
    const r = await receiver();

    const res = await post(
      r.url,
      otlpBatch([
        {
          "event.name": "tool_decision",
          "event.timestamp": "2026-09-11T18:30:00.000Z",
          "session.id": "sin-marcar",
          tool_name: "Bash",
          decision: "accept",
          source: "user_permanent",
        },
      ]),
    );
    expect(res.status).toBe(200);

    // Creating it would make the third source a back door into audit-mode,
    // which is opt-in per session by design. The event is lost, and that is
    // the correct outcome: nobody asked to audit that session.
    expect(existsSync(sessionLogPath(REPO, "sin-marcar"))).toBe(false);
    expect(readdirSync(root)).toEqual([]);
    expect(r.stats()).toEqual({ written: 0, discarded: 1, sessions: 0 });
  });

  // Covers: R3, R4
  it("marca su horizonte la primera vez que escribe en una sesión", async () => {
    markSession("sess-horizonte");
    const r = await receiver();

    const event = {
      "event.name": "tool_decision",
      "event.timestamp": "2026-09-11T18:30:00.000Z",
      "session.id": "sess-horizonte",
      tool_name: "Bash",
      decision: "reject",
      source: "user_reject",
    };
    await post(r.url, otlpBatch([event]));
    await post(r.url, otlpBatch([event]));

    // Exactly ONE horizon, on the first write and not on the second: without
    // it "no manual approvals" and "nobody was listening" read the same, and
    // repeating it per batch would make that instant meaningless.
    const events = linesOf("sess-horizonte").map((l) => l.event);
    expect(events).toEqual(["start", "otel-start", "tool_decision", "tool_decision"]);

    const horizon = linesOf("sess-horizonte")[1];
    expect(horizon?.endpoint).toBe(r.endpoint);
    expect(typeof horizon?.tsMs).toBe("number");
    // It lives in the LOG, not in the report: the answer survives the run that
    // produced it.
    expect(horizon?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  // Covers: R5, R8
  it("descarta un cuerpo que no es OTLP y responde 200", async () => {
    markSession("sess-basura");
    const r = await receiver();

    // An error would make the exporter RETRY, which spends the audited
    // session's latency on telemetry it already failed to deliver.
    const notJson = await post(r.url, "this is not json at all");
    expect(notJson.status).toBe(200);

    // The second case is the one a naive parser lets through: valid JSON with
    // no OTLP envelope in it.
    const jsonButNotOtlp = await post(r.url, JSON.stringify({ hello: "world", logs: [1, 2, 3] }));
    expect(jsonButNotOtlp.status).toBe(200);

    // An event inside a well-formed envelope that names no session has no log
    // to belong to; guessing one would invent the join this spec exists to
    // make exact.
    const noSession = await post(r.url, otlpBatch([{ "event.name": "tool_decision" }]));
    expect(noSession.status).toBe(200);

    expect(linesOf("sess-basura").map((l) => l.event)).toEqual(["start"]);
    expect(r.stats()).toEqual({ written: 0, discarded: 3, sessions: 0 });
  });

  it("responde su propia ruta de salud, para que doctor sepa de quién es el puerto", async () => {
    // #697: a bare connection proves only that SOMETHING holds 4318. The
    // operator who already runs an OTLP collector there would read a green
    // check while every navori event went into somebody else's pipeline.
    const r = await receiver();
    const res = await fetch(`http://127.0.0.1:${r.port}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.service).toBe("navori-audit-collect");
    expect(body).toEqual({
      service: "navori-audit-collect",
      written: 0,
      discarded: 0,
      sessions: 0,
    });
  });

  // Covers: R5, R8
  it("no persiste el texto del prompt aunque el emisor lo mande", async () => {
    markSession("sess-prompt");
    const r = await receiver();
    const secret = "el texto completo del prompt del usuario, que nunca debe tocar disco";

    const res = await post(
      r.url,
      otlpBatch([
        {
          "event.name": "user_prompt",
          "event.timestamp": "2026-09-11T18:30:00.000Z",
          "session.id": "sess-prompt",
          prompt: secret,
          prompt_length: "71",
        },
        {
          "event.name": "api_request",
          "event.timestamp": "2026-09-11T18:30:01.000Z",
          "session.id": "sess-prompt",
          "skill.name": "structural-search",
          model: "claude-opus-5",
          // Cost and tokens are NOT in the allowlist: the transcript already
          // carries tokens, and an allowlist that grows by accident is a
          // denylist with extra steps.
          cost_usd: "0.42",
          input_tokens: "1200",
        },
        // `api_request` without a skill is the volume case: it fires on every
        // request and carries nothing this spec reads.
        {
          "event.name": "api_request",
          "event.timestamp": "2026-09-11T18:30:02.000Z",
          "session.id": "sess-prompt",
          model: "claude-opus-5",
          cost_usd: "0.01",
        },
      ]),
    );
    expect(res.status).toBe(200);

    const raw = readFileSync(sessionLogPath(REPO, "sess-prompt"), "utf-8");
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain("0.42");
    expect(raw).not.toContain("1200");

    const lines = linesOf("sess-prompt");
    // The event is still recorded — R2 is one line per event — it just carries
    // nothing but the allowlisted fields.
    expect(lines[2]).toEqual({
      ts: "2026-09-11T18:30:00Z",
      tsMs: Date.parse("2026-09-11T18:30:00.000Z"),
      event: "user_prompt",
    });
    expect(lines[3]).toEqual({
      ts: "2026-09-11T18:30:01Z",
      tsMs: Date.parse("2026-09-11T18:30:01.000Z"),
      event: "api_request",
      skill: "structural-search",
      model: "claude-opus-5",
    });
    expect(lines).toHaveLength(4);
    expect(r.stats()).toEqual({ written: 2, discarded: 1, sessions: 1 });
  });
});

/**
 * Invariant 9 of `DIRECTION.md` — "navori generates, it does not run" — in
 * executable form.
 *
 * Without this, "navori opens no ports" is a promise the next PR can break in
 * silence, and the whole argument for making the operator run the receiver
 * evaporates. Read over the SHIPPED sources and assets, the same way
 * `agent-descriptions.test.ts` reads the real assets instead of a fixture.
 */
const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RECEIVER = resolve(SRC_ROOT, "lib", "audit", "collect.ts");

/** Code-shaped ways to bind a port. Prose can say "listen"; it can't say `.listen(`. */
const LISTENS = [/\.listen\s*\(/, /createServer\s*\(/, /\bBun\.serve\s*\(/, /\bDeno\.serve\s*\(/];

/**
 * Only what navori EXECUTES — its own source, its hook scripts, and the JSON
 * that declares hook commands.
 *
 * Markdown is deliberately outside: the shipped skills are prose for a human
 * or an agent to read, and `lib-skills/supertest.md` legitimately writes
 * `app.listen()` while TEACHING the reader not to call it. Flagging that would
 * make the invariant fire on documentation about other people's servers, which
 * is not what "navori does not run processes" means.
 */
const EXECUTABLE = new Set([".ts", ".js", ".mjs", ".cjs", ".sh", ".py", ".json"]);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      yield* walk(full);
      continue;
    }
    yield full;
  }
}

describe("invariante 9 (#0021, R9)", () => {
  // Covers: R9
  it("solo el receptor escucha en un puerto", () => {
    const offenders: string[] = [];
    for (const dir of [SRC_ROOT, getCoreRoot()]) {
      for (const file of walk(dir)) {
        if (file === RECEIVER || file.endsWith(".test.ts")) continue;
        if (!EXECUTABLE.has(extname(file))) continue;
        let text: string;
        try {
          text = readFileSync(file, "utf-8");
        } catch {
          continue; // unreadable or binary: nothing to bind a port with
        }
        if (LISTENS.some((re) => re.test(text))) offenders.push(relative(SRC_ROOT, file));
      }
    }
    // Named, not counted: the point of the failure is telling the author which
    // file just made navori a server.
    expect(offenders).toEqual([]);
  });
});
