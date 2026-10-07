import { assert, describe, it, expect, afterEach, vi } from "vitest";
import { join } from "node:path";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  openSync,
  writeSync,
  closeSync,
  statSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  ORCHESTRATOR_OWNER,
  attachHookEvents,
  idleBetweenTurns,
  isClassifierExemptCommand,
  isReadLaneCommand,
  isWriteLaneCommand,
  parseAgentRun,
  parseCodexSession,
  parseSession,
  readJsonl,
  sumTokens,
} from "../parse.ts";
import type { AgentRun, SessionAudit } from "../model.ts";
import {
  emptyOrchestrator,
  emptyPermissionDecisions,
  emptyToolErrors,
  AUDIT_READ_LIMITS,
  createAuditReadBudget,
  normalizeAuditRecord,
  qualifyAuditMetadataRecords,
} from "../model.ts";
import { buildReport, publishReport, renderJson, renderMarkdown } from "../report.ts";
import { detectSignals } from "../signals.ts";
import type { HarnessCatalog } from "../harness.ts";
import { readAuditJsonl } from "../paths.ts";
import { codexIdentityFingerprint, findMarkedSessions } from "../discovery.ts";
import { normalizeCodexIdentity } from "../model.ts";

/** The catalog is not what these specs are about: an empty one keeps the
 *  report renderable without pinning a harness shape they never read. */
const EMPTY_CATALOG: HarnessCatalog = {
  agents: [],
  skills: [],
  managedSkills: [],
  sections: [],
  claudeMdTokens: 0,
  mcpFamilies: [],
};

const FIXTURE = join(
  fileURLToPath(new URL("../../../__tests__/fixtures/audit/", import.meta.url)),
  "-tmp-fixture-repo",
  "sess-aaa11111.jsonl",
);

describe("availability and trusted windows", () => {
  const dirs: string[] = [];
  const file = (raw: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "audit-evidence-"));
    dirs.push(dir);
    const target = join(dir, "session.jsonl");
    writeFileSync(target, raw);
    return target;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const recordFile = (records: readonly object[]): string =>
    file(records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const pairedHook = (
    phase: string,
    seconds: number,
    id: string,
    over: Record<string, unknown> = {},
  ): object => ({
    event: "hook",
    name: "probe",
    phase,
    verdict: "allow",
    ms: 1,
    toolUseId: id,
    sessionId: "s",
    tsMs: Date.parse("2026-09-01T00:00:00Z") + seconds * 1000,
    ...over,
  });
  // Covers: R21
  it("accepts the actual 1MiB line boundary and reports an oversized complete line without retaining it", () => {
    const prefix = '{"type":"user","padding":"';
    const suffix = '"}';
    const exact =
      prefix +
      "x".repeat(AUDIT_READ_LIMITS.maxLineBytes - Buffer.byteLength(prefix + suffix)) +
      suffix;
    const accepted = readJsonl(file(exact + "\n"));
    expect(accepted.health.reading).toMatchObject({
      oversizedLines: 0,
      completeLines: 1,
      stoppedEarly: false,
    });
    expect(accepted.lines).toHaveLength(1);
    const rejected = readJsonl(file(exact.slice(0, -2) + "x" + suffix + "\n"));
    expect(rejected.lines).toEqual([]);
    expect(rejected.health).toMatchObject({
      state: "unavailable",
      reason: "incomplete-enumeration",
    });
    expect(rejected.health.reading).toMatchObject({
      oversizedLines: 1,
      omitted: 1,
      incompleteTail: false,
    });
  });
  // Covers: R21
  it.runIf(process.env.NAVORI_AUDIT_BENCHMARK === "1")(
    "benchmarks ten synthetic 50MiB rollouts without a CI speed threshold",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "audit-benchmark-"));
      dirs.push(dir);
      const budget = createAuditReadBudget();
      const started = performance.now();
      const rssBefore = process.memoryUsage().rss;
      let sampledPeakRss = rssBefore;
      let bytesRead = 0;
      const targetBytes = 50 * 1024 * 1024;
      const chunkBytes = 64 * 1024;
      const messageLine = (bytes: number): string => {
        const prefix = '{"type":"event_msg","payload":{"type":"agent_message","message":"';
        const suffix = '"}}\n';
        return prefix + "x".repeat(bytes - Buffer.byteLength(prefix + suffix)) + suffix;
      };
      for (let index = 0; index < 10; index++) {
        const id = `synthetic-${index}`;
        const target = join(dir, `rollout-${id}.jsonl`);
        const header =
          JSON.stringify({
            type: "session_meta",
            payload: { id, session_id: id, cli_version: "0.160.0", cwd: dir, source: "cli" },
          }) + "\n";
        const fd = openSync(target, "wx", 0o600);
        try {
          writeSync(fd, header);
          const full = messageLine(chunkBytes);
          for (let row = 0; row < 799; row++) writeSync(fd, full);
          writeSync(fd, messageLine(chunkBytes - Buffer.byteLength(header)));
        } finally {
          closeSync(fd);
        }
        expect(statSync(target).size).toBe(targetBytes);
        const rootRecord = {
          event: "start",
          host: "codex",
          sessionId: id,
          cwd: dir,
          ts: "2026-09-01T00:00:00Z",
        };
        const rootLog = recordFile([rootRecord]);
        const reading = readAuditJsonl(rootLog, () => {});
        const session = parseCodexSession(id, rootLog, target, undefined, {
          records: [rootRecord],
          reading,
          budget,
          children: [],
        });
        bytesRead += session?.sources?.rollout?.reading?.bytesRead ?? 0;
        sampledPeakRss = Math.max(sampledPeakRss, process.memoryUsage().rss);
      }
      expect(bytesRead).toBe(10 * targetBytes);
      process.stdout.write(
        JSON.stringify({
          benchmark: "synthetic-10x50MiB",
          runtime: process.version,
          execPath: process.execPath,
          pid: process.pid,
          platform: process.platform,
          arch: process.arch,
          inputBytes: 10 * targetBytes,
          bytesRead,
          elapsedMs: performance.now() - started,
          rssBefore,
          sampledPeakRss,
          sampledRssDelta: sampledPeakRss - rssBefore,
          rssSampling: "before parsing and after each of ten files; not continuous peak RSS",
          budget: budget.diagnostics,
        }) + "\n",
      );
    },
    120_000,
  );
  // Covers: R21
  it("shares a lower report-wide fact ceiling and exposes unknown remainder rather than a complete zero", () => {
    const budget = createAuditReadBudget({ factsPerReport: 4 });
    const target = recordFile(Array.from({ length: 10 }, () => ({ type: "user", sessionId: "s" })));
    const parsed = readJsonl(target, budget, "s");
    expect(parsed.lines).toHaveLength(3); // One private path and three normalized records are retained.
    expect(budget.diagnostics).toMatchObject({
      retainedFacts: 4,
      omittedFacts: null,
      truncated: true,
    });
    expect(parsed.health).toMatchObject({ state: "partial", reason: "incomplete-enumeration" });
    expect(parsed.health.reading).toMatchObject({ stoppedEarly: true, omitted: null });
    expect(budget.diagnostics.omittedLowerBound).toBeGreaterThan(0);
    const later = readJsonl(recordFile([{ type: "user" }]), budget, "other");
    expect(later.health.state).toBe("unavailable");
    expect(budget.diagnostics.retainedFacts).toBeLessThanOrEqual(4);
  });
  // Covers: R21, R5
  it("drops oversized technical identities instead of clipping two distinct owners into one", () => {
    const prefix = "a".repeat(256);
    expect(
      normalizeAuditRecord({ type: "session_meta", payload: { id: prefix } }, "rollout").value,
    ).toMatchObject({ payload: { id: prefix } });
    for (const ending of ["x", "y"]) {
      const normalized = normalizeAuditRecord(
        { type: "session_meta", payload: { id: prefix + ending } },
        "rollout",
      );
      expect(normalized.omitted).toBe(1);
      expect(normalized.value).toMatchObject({ payload: {} });
    }
  });
  // Covers: R8, R10, R21
  it.each(["gate-started", "gate-killed", "arbitrary-verdict"])(
    "qualifies only emitted gate witnesses (%s)",
    (verdict) => {
      const record = {
        wireVersion: 1,
        eventId: "gate-id",
        host: "claude",
        rootSessionId: "s",
        event: "hook",
        name: "quality-gate-pre-commit",
        source: "core",
        phase: "PreToolUse",
        verdict,
        ms: 1,
        tsMs: 1,
      };
      const result = qualifyAuditMetadataRecords([record], createAuditReadBudget(), "s");
      if (verdict === "arbitrary-verdict")
        expect(result).toMatchObject({ records: [], unsupported: 1 });
      else expect(result.records).toEqual([record]);
    },
  );

  // Covers: R8, R21
  it.each([false, true])(
    "excludes every conflicting metadata ID before counts in either order (%s)",
    (reverse) => {
      const hook = {
        wireVersion: 1,
        eventId: "id",
        host: "codex",
        rootSessionId: "s",
        event: "hook",
        name: "test",
        source: "core",
        phase: "PreToolUse",
        verdict: "allow",
        ms: 1,
        tsMs: 1,
      };
      const conflicting = { ...hook, verdict: "deny" };
      const records = reverse ? [conflicting, hook, hook] : [hook, conflicting, hook];
      const result = qualifyAuditMetadataRecords(records, createAuditReadBudget(), "s");
      expect(result).toMatchObject({ records: [], conflicts: 1, unsupported: 0 });
      const same = qualifyAuditMetadataRecords([hook, { ...hook }], createAuditReadBudget(), "s");
      expect(same.records).toHaveLength(1);
      expect(same.conflicts).toBe(0);
    },
  );
  // Covers: R6, R7
  it.each(["unknown-only", "root-and-unknown", "recognized-zero", "unknown-shape"])(
    "qualifies recognized tool evidence independently of descriptive records: %s",
    (mode) => {
      const root = { type: "user", sessionId: "s", timestamp: "2026-09-01T00:00:00Z" };
      const unknown = { ...root, type: "arbitrary-garbage" };
      const records =
        mode === "unknown-only"
          ? [unknown]
          : mode === "recognized-zero"
            ? [root]
            : [root, mode === "unknown-shape" ? { ...root, message: 42 } : unknown];
      const s = parseSession(recordFile(records));
      const observed = mode === "recognized-zero";
      expect(s.sources?.transcript).toMatchObject({
        records: records.length,
        validRecords: mode === "unknown-only" ? 0 : 1,
        parseErrors: 0,
        state: observed ? "observed" : mode === "unknown-only" ? "unavailable" : "partial",
        reason: observed ? null : "incomplete-enumeration",
      });
      expect(s.linesRead).toBe(records.length);
      const json = JSON.parse(
        renderJson(buildReport([s], { repo: "probe", version: "test", catalog: EMPTY_CATALOG })),
      );
      expect(json.availability.tools.observed).toBe(observed ? 1 : 0);
      expect(json.availability.tools.contributors).toBe(mode === "unknown-only" ? 0 : 1);
      expect(json.sessions[0].sources.transcript.reason).toBe(
        observed ? null : "incomplete-enumeration",
      );
      expect(json.availability.tools.state).toBe(
        observed ? "observed" : mode === "unknown-only" ? "unavailable" : "partial",
      );
      // The recognized user record has no tool uses: zero describes only that subset,
      // never the unrecognized remainder or a completely unrecognized stream.
      expect(json.sessions[0].orchestrator.shellReads).toBe(mode === "unknown-only" ? null : 0);
      expect(json.sessions[0].orchestrator.shellWrites).toBe(mode === "unknown-only" ? null : 0);
      if (!observed) expect(detectSignals(s, EMPTY_CATALOG, "en")).toEqual([]);
    },
  );
  // Covers: R6
  it.each([
    { label: "primitive", content: [42], recognized: false, tools: 0 },
    {
      label: "unknown block",
      content: [{ type: "arbitrary-garbage" }],
      recognized: false,
      tools: 0,
    },
    {
      label: "invalid tool name",
      content: [{ type: "tool_use", name: 42 }],
      recognized: false,
      tools: 0,
    },
    { label: "invalid text", content: [{ type: "text", text: 42 }], recognized: false, tools: 0 },
    {
      label: "nested unknown result",
      content: [{ type: "tool_result", content: [42] }],
      recognized: false,
      tools: 0,
    },
    { label: "text", content: [{ type: "text", text: "answer" }], recognized: true, tools: 0 },
    {
      label: "tool",
      content: [{ type: "tool_use", name: "Read", input: { file_path: "fixture.ts" } }],
      recognized: true,
      tools: 1,
    },
    {
      label: "result",
      content: [{ type: "tool_result", content: [{ type: "text", text: "ok" }] }],
      recognized: true,
      tools: 0,
    },
    { label: "explicit empty", content: [], recognized: true, tools: 0 },
  ])("qualifies measurement-bearing content blocks: $label", ({ content, recognized, tools }) => {
    const root = { type: "user", sessionId: "s", timestamp: "2026-09-01T00:00:00Z" };
    const assistant = { ...root, type: "assistant", message: { content } };
    const catalog: HarnessCatalog = { ...EMPTY_CATALOG, skills: ["probe-skill"] };
    for (const includeRoot of [true, false]) {
      const records = includeRoot ? [root, assistant] : [assistant];
      const s = parseSession(recordFile(records));
      const state = recognized ? "observed" : includeRoot ? "partial" : "unavailable";
      expect(s.sources?.transcript).toMatchObject({
        records: records.length,
        validRecords: recognized ? records.length : includeRoot ? 1 : 0,
        parseErrors: 0,
        state,
        reason: recognized ? null : "incomplete-enumeration",
      });
      expect(s.linesRead).toBe(records.length);
      const json = JSON.parse(
        renderJson(buildReport([s], { repo: "blocks", version: "test", catalog })),
      );
      expect(json.availability.tools).toMatchObject({
        eligible: 1,
        observed: recognized ? 1 : 0,
        contributors: recognized || includeRoot ? 1 : 0,
        state,
      });
      expect(json.sessions[0].sources.transcript.reason).toBe(
        recognized ? null : "incomplete-enumeration",
      );
      expect(json.sessions[0].orchestrator.shellReads).toBe(recognized || includeRoot ? 0 : null);
      expect(json.sessions[0].orchestrator.toolCounts).toEqual(
        recognized || includeRoot ? (tools ? { Read: 1 } : {}) : null,
      );
      // A nonempty catalog proves suppression, unlike a vacuous empty-catalog check.
      const signals = detectSignals(s, catalog, "en");
      if (recognized) expect(signals.some((signal) => signal.kind === "unused-skills")).toBe(true);
      else expect(signals).toEqual([]);
    }
  });
  // Covers: R7, R18
  it("unions verified overlapping and disjoint pairs without idle or double counting", () => {
    const s = parseSession(
      recordFile([{ type: "user", sessionId: "s", timestamp: "2026-09-01T00:00:00Z" }]),
    );
    const child = parseAgentRun(
      recordFile([
        { type: "user", sessionId: "s", agentId: "child", timestamp: "2026-09-01T00:00:00Z" },
      ]),
    );
    assert(child);
    s.agents.push(child);
    attachHookEvents(
      s,
      recordFile([
        { event: "start", sessionId: "s", ts: "2026-09-01T00:00:00Z" },
        pairedHook("PreToolUse", 1, "a", { agentId: ORCHESTRATOR_OWNER }),
        pairedHook("PostToolUse", 5, "a", { agentId: ORCHESTRATOR_OWNER }),
        pairedHook("PreToolUse", 3, "b", { agentId: "child" }),
        pairedHook("PostToolUse", 7, "b", { agentId: "child" }),
        pairedHook("PreToolUse", 10, "c"),
        pairedHook("PostToolUseFailure", 12, "c"),
        { event: "stop", sessionId: "s", ts: "2026-09-01T00:00:20Z" },
      ]),
    );
    expect(s.activeMs).toBe(8000);
    expect(s.availability?.activeMs?.state).toBe("observed");
    expect(s.wallClockMs).toBe(20000);
    expect(s.availability?.wallClockMs?.state).toBe("observed");
    // Each run keeps only its own pairs (T10b, M1): never the window nor another owner's.
    const base = Date.parse("2026-09-01T00:00:00Z");
    expect(s.agents[0]?.activeIntervals).toEqual([[base + 3000, base + 7000]]);
  });
  // Covers: R7
  it.each(["unpaired", "reversed", "invalid-time", "wrong-owner", "wrong-session"])(
    "does not invent active time for %s records",
    (kind) => {
      const s = parseSession(
        recordFile([{ type: "user", sessionId: "s", timestamp: "2026-09-01T00:00:00Z" }]),
      );
      const over =
        kind === "invalid-time"
          ? { tsMs: 1e30 }
          : kind === "wrong-owner"
            ? { agentId: "unowned" }
            : kind === "wrong-session"
              ? { sessionId: "other" }
              : {};
      attachHookEvents(
        s,
        recordFile([
          { event: "start", sessionId: "s", ts: "2026-09-01T00:00:00Z" },
          pairedHook("PreToolUse", 3, "x", over),
          ...(kind === "unpaired"
            ? []
            : [pairedHook("PostToolUse", kind === "reversed" ? 1 : 5, "x", over)]),
        ]),
      );
      expect(s.activeMs).toBeNull();
      expect(s.availability?.activeMs?.state).toBe("unavailable");
    },
  );
  // Covers: R7
  it("diagnoses missing/unreadable hooks independently from usable transcript", () => {
    const s = parseSession(
      recordFile([{ type: "user", sessionId: "s", timestamp: "2026-09-01T00:00:00Z" }]),
    );
    attachHookEvents(s, join(dirs[0]!, "absent"));
    expect(s.sources?.["audit-log"]?.reason).toBe("missing");
    expect(s.sources?.transcript?.state).toBe("observed");
    attachHookEvents(s, dirs[0]!);
    expect(s.sources?.["audit-log"]?.reason).toBe("unreadable");
    expect(s.sources?.otlp?.reason).toBe("missing");
  });
  // Covers: R7
  it("counts semantic/time errors once, retains descriptive hooks, and qualifies OTLP independently", () => {
    const s = parseSession(
      recordFile([{ type: "user", sessionId: "s", timestamp: "2026-09-01T00:00:00Z" }]),
    );
    attachHookEvents(
      s,
      recordFile([
        { event: "start", sessionId: "s", ts: "2026-09-01T00:00:00Z" },
        pairedHook("PreToolUse", 1, "x", { tsMs: "unknown" }),
        { event: "hook", ts: "2026-09-01T00:00:01Z" },
        { event: "tool_decision", source: "user_yes", ts: "2026-09-01T00:00:02Z" },
      ]),
    );
    expect(s.parseErrors).toBe(2);
    expect(s.orchestrator.hookEvents).toHaveLength(1);
    expect(s.sources?.["audit-log"]).toMatchObject({ state: "partial", parseErrors: 2 });
    expect(s.sources?.otlp).toMatchObject({ state: "observed", parseErrors: 0 });
    expect(s.permissions.total).toBe(1);
    const other = parseSession(
      recordFile([{ type: "user", sessionId: "s", timestamp: "2026-09-01T00:00:00Z" }]),
    );
    attachHookEvents(
      other,
      recordFile([
        { event: "start", sessionId: "s", ts: "2026-09-01T00:00:00Z" },
        { event: "tool_decision", ts: "2026-09-01T00:00:02Z" },
      ]),
    );
    expect(other.sources?.["audit-log"]?.state).toBe("observed");
    expect(other.sources?.otlp).toMatchObject({ state: "invalid", parseErrors: 1 });
  });
  // Covers: R7
  it.each([
    {
      label: "root",
      owner: ORCHESTRATOR_OWNER,
      id: "s",
      startOwner: undefined,
      sealed: true,
      observed: true,
    },
    {
      label: "historical scoped root",
      owner: undefined,
      id: undefined,
      startOwner: undefined,
      sealed: true,
      observed: true,
    },
    {
      label: "child",
      owner: "child",
      id: "s",
      startOwner: undefined,
      sealed: false,
      observed: false,
    },
    {
      label: "foreign session",
      owner: ORCHESTRATOR_OWNER,
      id: "other",
      startOwner: undefined,
      sealed: false,
      observed: false,
    },
    {
      label: "child start",
      owner: ORCHESTRATOR_OWNER,
      id: "s",
      startOwner: "child",
      sealed: true,
      observed: false,
    },
  ])(
    "requires root lifecycle ownership to seal and certify calendar duration: $label",
    (sample) => {
      for (const event of ["session-end", "stop"]) {
        const s = parseSession(
          recordFile([
            { type: "user", sessionId: "s", timestamp: "2026-09-01T00:00:00Z" },
            {
              type: "assistant",
              sessionId: "s",
              timestamp: "2026-09-01T00:00:10Z",
              message: { content: [] },
            },
          ]),
        );
        attachHookEvents(
          s,
          recordFile([
            {
              event: "start",
              sessionId: "s",
              agentId: sample.startOwner,
              ts: "2026-09-01T00:00:00Z",
            },
            {
              event,
              sessionId: sample.id,
              agentId: sample.owner,
              ts: "2026-09-01T00:00:10Z",
              reason: "logout",
              navoriCli: "terminal-version",
            },
          ]),
        );
        expect(s.sealed).toBe(sample.sealed);
        expect(s.wallClockMs).toBe(10000);
        expect(s.availability?.wallClockMs).toMatchObject({
          state: sample.observed ? "observed" : "partial",
          reason: sample.observed ? null : "unsealed",
        });
        if (!sample.sealed) {
          expect(s.endReason).toBeNull();
          expect(s.navoriAtStop).toBeNull();
        }
      }
    },
  );
  // Covers: R7
  it("never promotes inherited/unowned transcript extrema when an owned hook stop seals", () => {
    const s = parseSession(
      recordFile([
        { type: "user", sessionId: "s", timestamp: "2026-09-01T00:00:10Z" },
        {
          type: "assistant",
          sessionId: "s",
          timestamp: "2026-09-01T00:00:15Z",
          message: { content: [] },
        },
        { type: "user", sessionId: "parent", timestamp: "2026-08-01T00:00:00Z" },
        { type: "user", timestamp: "2026-10-01T00:00:00Z" },
      ]),
    );
    attachHookEvents(
      s,
      recordFile([
        { event: "start", sessionId: "s", ts: "2026-09-01T00:00:10Z" },
        { event: "stop", sessionId: "s", ts: "2026-09-01T00:00:20Z" },
      ]),
    );
    expect(s.startedAt).toBe("2026-09-01T00:00:10.000Z");
    expect(s.wallClockMs).toBe(10000);
    expect(s.availability?.wallClockMs?.state).toBe("observed");
  });
  // Covers: R6, R7
  it("preserves explicit zero, rejects invalid components, and sorts UTC instants", () => {
    const s = parseSession(
      file(
        [
          {
            type: "assistant",
            sessionId: "s",
            timestamp: "2026-09-01T12:00:00+02:00",
            message: { id: "1", usage: { input_tokens: 0, output_tokens: -1 } },
          },
          { type: "user", sessionId: "s", timestamp: "2026-09-01T09:30:00Z" },
        ]
          .map((r) => JSON.stringify(r))
          .join("\n") + "\n",
      ),
    );
    expect(s.availability?.["tokens.input"]?.state).toBe("observed");
    expect(s.availability?.["tokens.output"]?.state).toBe("invalid");
    expect(s.availability?.["tokens.cacheRead"]?.state).toBe("unavailable");
    expect(s.startedAt).toBe("2026-09-01T09:30:00.000Z");
    expect(s.wallClockMs).toBe(30 * 60000);
    expect(s.activeMs).toBeNull();
  });
  // Covers: R7
  it("distinguishes an incomplete live tail from malformed complete records", () => {
    const raw = JSON.stringify({ type: "user", timestamp: "2026-09-01T10:00:00Z" }) + "\n";
    expect(readJsonl(file(raw + "{unfinished")).health).toMatchObject({
      state: "partial",
      incompleteTail: true,
      parseErrors: 0,
      reason: "live-tail",
    });
    expect(readJsonl(file(raw + "{malformed\n")).health).toMatchObject({
      state: "partial",
      incompleteTail: false,
      parseErrors: 1,
      reason: "malformed",
    });
  });
  // Covers: R6, R7
  it("does not use inherited or ownership-unknown rollout extrema as root duration", () => {
    const log = file(
      JSON.stringify({
        event: "start",
        host: "codex",
        sessionId: "s",
        ts: "2026-09-01T10:00:00Z",
      }) + "\n",
    );
    const rollout = file(
      [
        {
          type: "session_meta",
          timestamp: "2026-09-01T10:00:00Z",
          payload: { id: "s", session_id: "s", cli_version: "0.160.0", cwd: "/work" },
        },
        {
          type: "event_msg",
          timestamp: "2026-08-01T00:00:00Z",
          payload: { type: "task_started", turn_id: "inherited" },
        },
        { type: "event_msg", timestamp: "2026-09-01T10:10:00Z", payload: { type: "task_started" } },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );
    const s = parseCodexSession("s", log, rollout);
    expect(s?.availability?.wallClockMs?.state).toBe("unavailable");
    expect(s?.sources?.rollout?.reason).toBe("ownership-unknown");
    expect(s?.availability?.["tokens.cacheCreation"]?.state).toBe("unavailable");
  });
  // Covers: R7
  it("uses explicitly owned hook-free source activity but keeps active time unknown", () => {
    const log = file(
      JSON.stringify({
        event: "start",
        host: "codex",
        sessionId: "s",
        ts: "2026-09-01T10:00:00Z",
      }) + "\n",
    );
    const rollout = file(
      [
        {
          type: "session_meta",
          timestamp: "2026-09-01T10:00:00Z",
          payload: { id: "s", session_id: "s", cli_version: "0.160.0", cwd: "/work" },
        },
        {
          type: "event_msg",
          timestamp: "2026-09-01T10:10:00Z",
          payload: { type: "task_started", turn_id: "own-turn" },
        },
        {
          type: "event_msg",
          timestamp: "2026-09-01T10:10:00Z",
          payload: {
            type: "item_started",
            thread_id: "s",
            turn_id: "own-turn",
            item: { type: "CommandExecution", id: "own-call" },
            started_at_ms: 1788257400000,
          },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );
    expect(parseCodexSession("s", log, rollout)).toMatchObject({
      wallClockMs: 600000,
      activeMs: null,
      availability: { wallClockMs: { state: "partial" } },
    });
  });
});

describe("parse: token dedupe", () => {
  it("counts a streaming-duplicated message once, not twice", () => {
    const { lines } = readJsonl(FIXTURE);
    const total = sumTokens(lines);

    // msg_dup (10/20/100/50/5) appears on TWO lines with an identical usage
    // payload; msg_two adds (1/2/3/4/1); msg_end adds zeros.
    expect(total).toEqual({
      input: 11,
      output: 22,
      cacheRead: 103,
      cacheCreation: 54,
      thinking: 6,
    });

    // Without dedupe every figure would be inflated — this is the number the
    // naive sum would produce, kept here so the regression is unmistakable.
    const naive = lines
      .filter((l) => l.type === "assistant")
      .reduce((acc, l) => {
        const u = (l.message as { usage?: Record<string, number> } | undefined)?.usage ?? {};
        return acc + (u.output_tokens ?? 0);
      }, 0);
    expect(naive).toBe(42);
  });
});

describe("parse: tolerance", () => {
  it("counts a malformed line instead of throwing, and keeps the rest", () => {
    const s = parseSession(FIXTURE);
    expect(s.parseErrors).toBe(1);
    expect(s.linesRead).toBe(12);
    // The unknown record type is skipped without becoming an error.
    expect(s.prs).toEqual([42]);
  });
});

describe("parse: observed artifact writes", () => {
  function transcript(lines: unknown[]): string {
    const dir = mkdtempSync(join(tmpdir(), "navori-artifact-writes-"));
    const file = join(dir, "session.jsonl");
    writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf-8");
    return file;
  }

  it("keeps only a safe repo-relative path and correlates the exact tool result", () => {
    const s = parseSession(
      transcript([
        {
          type: "assistant",
          timestamp: "2026-09-18T12:00:00.000Z",
          cwd: "/workspace/repo",
          message: {
            content: [
              {
                type: "tool_use",
                id: "write-ok",
                name: "Write",
                input: { file_path: "docs/receipt.md" },
              },
              {
                type: "tool_use",
                id: "edit-failed",
                name: "Edit",
                input: { file_path: "src/a.ts" },
              },
              {
                type: "tool_use",
                id: "no-result",
                name: "Write",
                input: { file_path: "src/b.ts" },
              },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "write-ok", is_error: false, content: "ok" },
              {
                type: "tool_result",
                tool_use_id: "edit-failed",
                is_error: true,
                content: "not found",
              },
              { type: "tool_result", tool_use_id: "unrelated", is_error: false, content: "ok" },
            ],
          },
        },
      ]),
    );
    expect(s.observedArtifactWrites).toEqual([
      {
        actor: "orchestrator",
        at: "2026-09-18T12:00:00.000Z",
        source: "native-write",
        outcome: "success",
        location: { state: "repo-relative", path: "docs/receipt.md" },
      },
      {
        actor: "orchestrator",
        at: "2026-09-18T12:00:00.000Z",
        source: "native-edit",
        outcome: "failed",
        location: { state: "repo-relative", path: "src/a.ts" },
      },
      {
        actor: "orchestrator",
        at: "2026-09-18T12:00:00.000Z",
        source: "native-write",
        outcome: "unknown",
        location: { state: "repo-relative", path: "src/b.ts" },
      },
    ]);
  });

  it("uses notebook_path for NotebookEdit and correlates success, failure, and unknown results", () => {
    const s = parseSession(
      transcript([
        {
          type: "assistant",
          timestamp: "2026-09-18T12:00:00.000Z",
          cwd: "/workspace/repo",
          message: {
            content: [
              {
                type: "tool_use",
                id: "notebook-ok",
                name: "NotebookEdit",
                input: { notebook_path: "notebooks/analysis.ipynb" },
              },
              {
                type: "tool_use",
                id: "notebook-failed",
                name: "NotebookEdit",
                input: { notebook_path: "notebooks/missing.ipynb" },
              },
              {
                type: "tool_use",
                id: "notebook-unknown",
                name: "NotebookEdit",
                input: { notebook_path: "notebooks/pending.ipynb" },
              },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "notebook-ok", is_error: false, content: "ok" },
              {
                type: "tool_result",
                tool_use_id: "notebook-failed",
                is_error: true,
                content: "not found",
              },
            ],
          },
        },
      ]),
    );
    expect(s.observedArtifactWrites).toEqual([
      {
        actor: "orchestrator",
        at: "2026-09-18T12:00:00.000Z",
        source: "native-notebook-edit",
        outcome: "success",
        location: { state: "repo-relative", path: "notebooks/analysis.ipynb" },
      },
      {
        actor: "orchestrator",
        at: "2026-09-18T12:00:00.000Z",
        source: "native-notebook-edit",
        outcome: "failed",
        location: { state: "repo-relative", path: "notebooks/missing.ipynb" },
      },
      {
        actor: "orchestrator",
        at: "2026-09-18T12:00:00.000Z",
        source: "native-notebook-edit",
        outcome: "unknown",
        location: { state: "repo-relative", path: "notebooks/pending.ipynb" },
      },
    ]);
  });

  it("does not persist traversal, external, control-character, or secret-shaped paths", () => {
    const files = [
      "../outside.md",
      "..\\outside.md",
      "docs/..\\..\\outside.md",
      "docs\\..\\../outside.md",
      "/private/tmp/outside.md",
      "docs/unsafe\u0000.md",
      "docs/gho_abcdefghijklmnopqrstuvwxyz.md",
    ];
    const s = parseSession(
      transcript([
        {
          type: "assistant",
          timestamp: "2026-09-18T12:00:00.000Z",
          cwd: "/workspace/repo",
          message: {
            content: files.map((file_path, index) => ({
              type: "tool_use",
              id: `write-${index}`,
              name: "Write",
              input: { file_path },
            })),
          },
        },
      ]),
    );
    expect(s.observedArtifactWrites?.map((event) => event.location)).toEqual([
      { state: "outside-workspace" },
      { state: "outside-workspace" },
      { state: "outside-workspace" },
      { state: "outside-workspace" },
      { state: "outside-workspace" },
      { state: "redacted" },
      { state: "redacted" },
    ]);
    const serializedWrites = JSON.stringify(s.observedArtifactWrites);
    expect(serializedWrites).not.toContain("gho_");
    expect(serializedWrites).not.toContain("outside.md");
    expect(serializedWrites).not.toContain("..\\outside.md");
  });
});

describe("parse: session shape", () => {
  const s = parseSession(FIXTURE);

  it("takes the typed prompt, not the injected one", () => {
    expect(s.initialPrompt).toBe("arregla el bug en audit mode");
  });

  it("records the permission mode, which the tool histogram depends on", () => {
    expect(s.permissionModes).toEqual({ auto: 2 });
  });

  it("counts hook blocks that reached the context", () => {
    expect(s.orchestrator.frictionEvents).toBe(1);
  });

  it("detects skills read through Bash, not only the Skill tool", () => {
    expect(s.orchestrator.skillsRead).toEqual(["review-diff"]);
  });

  it("flags a command repeated 3+ times", () => {
    expect(s.orchestrator.repeatedCommands).toEqual({ "pnpm test": 3 });
  });
});

describe("parse: tool error taxonomy (#686)", () => {
  /** A transcript that is nothing but error results, one per line. */
  function errors(contents: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "navori-errors-"));
    const file = join(dir, "sess-err.jsonl");
    const lines = contents.map((content) => ({
      type: "user",
      message: { content: [{ type: "tool_result", is_error: true, content }] },
    }));
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
    return file;
  }

  it("classifies every error instead of keeping four literals and dropping the rest", () => {
    const s = parseSession(
      errors([
        "[navori] BLOCKED by guard-search-routing: busqueda recursiva por shell",
        "<tool_use_error>Blocked: sleep 45 followed by: tail -30 /tmp/out",
        "Permission for this action was denied",
        "Exit code 1\n  M packages/cli/src/index.ts",
        "<tool_use_error>Error: No such tool available: Grep.",
        "<tool_use_error>String to replace not found in file. String: 3. **Rebi",
        "content is required for mem_session_summary",
      ]),
    );
    expect(s.orchestrator.toolErrors).toEqual({
      harnessBlock: 2,
      permissionDenied: 1,
      shellFailure: 1,
      toolUnavailable: 1,
      editMiss: 1,
      other: 1,
    });
  });

  it("counts the guard's `Blocked:` spelling, which the old list missed", () => {
    // Two real blocks in this repo's transcripts went uncounted: the list knew
    // only `BLOCKED by guard`. A false negative whose whole output is one
    // integer is invisible by construction.
    const s = parseSession(errors(["<tool_use_error>Blocked: rm -rf /tmp/x"]));
    expect(s.orchestrator.toolErrors.harnessBlock).toBe(1);
    expect(s.orchestrator.frictionEvents).toBe(1);
  });

  it("keeps frictionEvents meaning blocks and denials, not every error", () => {
    // The breakdown widens what is RECORDED. It must not silently redefine the
    // number the existing signal and the already-published JSON stand on.
    const s = parseSession(
      errors([
        "BLOCKED by guard-destructive",
        "Permission for this action was denied",
        "Exit code 2",
        "Exit code 1",
      ]),
    );
    expect(s.orchestrator.frictionEvents).toBe(2);
    expect(s.orchestrator.toolErrors.shellFailure).toBe(2);
  });

  it("tests `Exit code` as a prefix, so printing the words is not failing", () => {
    const s = parseSession(errors(['no match for "Exit code 1" in docs/troubleshooting.md']));
    expect(s.orchestrator.toolErrors.shellFailure).toBe(0);
    expect(s.orchestrator.toolErrors.other).toBe(1);
  });
});

describe("parse: subagents", () => {
  const s = parseSession(FIXTURE);

  it("reads agentType from the sidecar meta.json", () => {
    const withMeta = s.agents.find((a) => a.agentId === "withmeta1");
    expect(withMeta?.agentType).toBe("implementer");
    expect(withMeta?.description).toBe("implementa X");
  });

  it("falls back to the parent's subagent_type when the sidecar is missing", () => {
    const orphan = s.agents.find((a) => a.agentId === "orphan2");
    expect(orphan?.agentType).toBe("implementer");
  });

  it("attributes startup cost to the first assistant message", () => {
    expect(s.agents.find((a) => a.agentId === "withmeta1")?.startupTokens).toBe(1000);
    expect(s.agents.find((a) => a.agentId === "orphan2")?.startupTokens).toBe(500);
  });

  it("dedupes each subagent's own transcript too", () => {
    const withMeta = s.agents.find((a) => a.agentId === "withmeta1");
    expect(withMeta?.tokens).toEqual({
      input: 7,
      output: 8,
      cacheRead: 9,
      cacheCreation: 1000,
      thinking: 2,
    });
  });

  it("captures the review verdict", () => {
    expect(s.agents.find((a) => a.agentId === "withmeta1")?.verdict).toBe("CHANGES_REQUESTED");
  });

  it("marks non-overlapping windows as non-parallel", () => {
    for (const a of s.agents) expect(a.overlapsWith).toEqual([]);
  });
});

describe("parse: native agent turn limit (R41, R42)", () => {
  const probe = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(
          "../../__tests__/fixtures/claude-live-2.1.287/probe2-agent-tool-result-transcript-record.json",
          import.meta.url,
        ),
      ),
      "utf-8",
    ),
  ) as { record: Record<string, unknown> };

  function sessionWith(result: Record<string, unknown>, toolName = "Agent"): SessionAudit {
    const dir = mkdtempSync(join(tmpdir(), "navori-turn-limit-"));
    const file = join(dir, "session.jsonl");
    const subagents = join(dir, "session", "subagents");
    mkdirSync(subagents, { recursive: true });
    writeFileSync(
      join(subagents, "agent-<agent_id>.jsonl"),
      `${JSON.stringify({ type: "assistant", agentId: "<agent_id>", message: { content: [] } })}\n`,
    );
    writeFileSync(
      file,
      [
        {
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "<tool_use_id>", name: toolName }] },
        },
        result,
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    );
    return parseSession(file);
  }

  // Covers: R41, R42
  it("attributes the literal 2.1.287 Agent result to the matching run", () => {
    const session = sessionWith(probe.record);
    expect(session.agents.find((agent) => agent.agentId === "<agent_id>")?.turnLimitHit).toBe(true);
  });

  // Covers: R41, R42
  it("ignores a non-Agent tool result carrying the same text", () => {
    expect(sessionWith(probe.record, "Bash").agents[0]?.turnLimitHit).toBe(false);
  });

  // Covers: R41, R42
  it("does not attribute a cap to a different Agent run", () => {
    const result = structuredClone(probe.record);
    (result.toolUseResult as Record<string, unknown>).agentId = "other-agent";
    expect(sessionWith(result).agents[0]?.turnLimitHit).toBe(false);
  });

  // Covers: R41, R42
  it("ignores the cap phrase in ordinary user text", () => {
    expect(
      sessionWith({ type: "user", message: { content: "stopped at its 3-turn limit" } }).agents[0]
        ?.turnLimitHit,
    ).toBe(false);
  });

  // Covers: R41, R42, R11
  it("ignores a supplied cap flag when the matching result contains no native cap", () => {
    const result = structuredClone(probe.record);
    const message = result.message as { content: Record<string, unknown>[] };
    message.content[0]!.content = "ok";
    message.content[0]!._auditClaude = { cap: true, bytes: 999, error: "harnessBlock" };
    expect(sessionWith(result).agents[0]?.turnLimitHit).toBe(false);
  });
});

describe("parse: missing input", () => {
  it("returns an empty result instead of throwing", () => {
    expect(readJsonl("/nonexistent/path.jsonl")).toMatchObject({
      lines: [],
      parseErrors: 0,
      linesRead: 0,
    });
  });
});

describe("parse: user message coverage (#489)", () => {
  /**
   * The session log only ever sees messages that START a turn. Anything typed
   * while the agent works is queued and delivered inside the running turn, so
   * it fires no hook and the log is blind to it — on a real session that was 7
   * of 19 messages. The transcript has both, which is why the count lives here
   * and not in the hook.
   */
  function transcript(lines: object[]): string {
    const dir = mkdtempSync(join(tmpdir(), "navori-parse-"));
    const file = join(dir, "sess-cov.jsonl");
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
    return file;
  }

  const typed = (text: string) => ({
    type: "user",
    promptSource: "typed",
    timestamp: "2026-08-25T10:00:00.000Z",
    message: { role: "user", content: text },
  });
  const enqueue = (text: string) => ({
    type: "queue-operation",
    operation: "enqueue",
    timestamp: "2026-08-25T10:01:00.000Z",
    content: text,
  });
  const removed = (text: string) => ({
    type: "queue-operation",
    operation: "remove",
    timestamp: "2026-08-25T10:02:00.000Z",
    content: text,
  });

  it("counts turn-starting prompts and queued ones separately", () => {
    const s = parseSession(
      transcript([typed("uno"), enqueue("mid"), removed("mid"), typed("dos")]),
    );
    expect(s.prompts).toEqual({ typed: 2, queued: 1, queuedSystem: 0 });
  });

  it("counts a queued message once, not twice", () => {
    // A queued message leaves a second record when the turn consumes or drops
    // it; counting anything but `enqueue` would double the figure.
    const s = parseSession(transcript([typed("uno"), enqueue("a"), removed("a")]));
    expect(s.prompts.queued).toBe(1);
  });

  it("reports zero queued when the human never interrupted", () => {
    const s = parseSession(transcript([typed("uno"), typed("dos")]));
    expect(s.prompts).toEqual({ typed: 2, queued: 0, queuedSystem: 0 });
  });

  /**
   * The queue is not the human's alone: the host enqueues its own notifications
   * through the same record. Measured over this project's transcripts, 415 of
   * 551 enqueues opened with `<task-notification>` and 9 with
   * `<cross-session-message` — so an unfiltered `queued` reports mostly machine
   * traffic as things the human said.
   */
  it("does not count a host task notification as a human message", () => {
    const s = parseSession(
      transcript([typed("uno"), enqueue("<task-notification>\n<task-id>abc</task-id>\n")]),
    );
    expect(s.prompts.queued).toBe(0);
    expect(s.prompts.queuedSystem).toBe(1);
  });

  it("does not count a cross-session message as a human message", () => {
    const s = parseSession(
      transcript([enqueue('<cross-session-message from="uds:/tmp/cc-socks/1.sock">hola</a>')]),
    );
    expect(s.prompts.queued).toBe(0);
    expect(s.prompts.queuedSystem).toBe(1);
  });

  it("keeps a human message that merely opens with an angle bracket", () => {
    // The test is an explicit prefix list, not "starts with `<`": a heuristic
    // that broad would erase a human asking about `<div>`.
    const s = parseSession(transcript([enqueue("<div> no renderiza, revisalo")]));
    expect(s.prompts.queued).toBe(1);
    expect(s.prompts.queuedSystem).toBe(0);
  });

  it("accounts for every enqueue: human plus host equals the record count", () => {
    const s = parseSession(
      transcript([
        typed("uno"),
        enqueue("<task-notification>\nlisto\n"),
        enqueue("tambien revisa el gate"),
        enqueue('<cross-session-message from="uds:/tmp/cc-socks/2.sock">x</a>'),
        removed("tambien revisa el gate"),
      ]),
    );
    // The discard is contable, like `skillsDiscarded`: the report can state the
    // filter's size instead of quietly shrinking a number.
    expect(s.prompts.queued).toBe(1);
    expect(s.prompts.queuedSystem).toBe(2);
  });
});

/**
 * Spec 0013, lote C — what the parser must now distinguish.
 */

/** A subagent transcript with the given tool calls, written to a temp file. */
function agentWith(uses: Array<{ name: string; input?: Record<string, unknown> }>): string {
  const dir = mkdtempSync(join(tmpdir(), "navori-parse-"));
  const file = join(dir, "agent-a1.jsonl");
  const lines = [
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-25T10:00:00Z",
      message: {
        model: "claude-opus-5",
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 10 },
        content: uses.map((u) => ({ type: "tool_use", name: u.name, input: u.input ?? {} })),
      },
    }),
    JSON.stringify({ type: "assistant", timestamp: "2026-08-25T10:05:00Z", message: {} }),
  ];
  writeFileSync(file, `${lines.join("\n")}\n`, "utf-8");
  return file;
}

describe("MCP calls grouped by server (#0013)", () => {
  // Covers: R9
  it("groups mcp__<server>__<op> under its server, with per-op counts", () => {
    const run = parseAgentRun(
      agentWith([
        { name: "mcp__engram__mem_save" },
        { name: "mcp__engram__mem_save" },
        { name: "mcp__engram__mem_search" },
        { name: "mcp__playwright__browser_click" },
        { name: "Bash", input: { command: "ls" } },
      ]),
    );
    // The transcript records these as flat tool names, so the data was always
    // there; grouping is what turns it into "did this agent reach engram?".
    expect(run?.mcpCalls).toEqual({
      engram: { mem_save: 2, mem_search: 1 },
      playwright: { browser_click: 1 },
    });
  });

  // Covers: R9
  it("leaves non-MCP tools out of the grouping", () => {
    const run = parseAgentRun(agentWith([{ name: "Bash", input: { command: "ls" } }]));
    expect(run?.mcpCalls).toEqual({});
  });
});

/**
 * #728 — the read that makes no call.
 *
 * The engram plugin's `SessionStart` hook fetches the project's memory and
 * prints it; the host splices that stdout into the context as
 * `additionalContext`. So the largest engram read of a session is invisible to
 * every count of `mem_search`, which is half of what made "268 saves against 56
 * searches" read as a verdict on how the memory is used.
 */
describe("context injected by a SessionStart hook (#728)", () => {
  const MARKER = "## Memory from Previous Sessions";
  /** The plugin prints its protocol block ABOVE the memory: instruction, not a
   *  read, and folding it in would inflate the figure by its own length. */
  const PROTOCOL = "## Engram Persistent Memory — ACTIVE PROTOCOL\ncall mem_save often.\n";
  const MEMORY = `${MARKER}\n### Recent Sessions\n- sess-a: shipped the audit\n`;

  function injection(stdout: string, hookName = "SessionStart:startup"): Record<string, unknown> {
    return {
      type: "attachment",
      timestamp: "2026-08-25T10:00:00.000Z",
      attachment: { type: "hook_success", hookName, hookEvent: "SessionStart", stdout },
    };
  }

  function sessionWith(lines: Array<Record<string, unknown>>): string {
    const dir = mkdtempSync(join(tmpdir(), "navori-inject-"));
    const file = join(dir, "sess-inject.jsonl");
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
    return file;
  }

  it("counts the injection and sizes it from the memory heading down", () => {
    const s = parseSession(sessionWith([injection(PROTOCOL + MEMORY)]));
    expect(s.orchestrator.mcpInjectedContext).toEqual({
      engram: { count: 1, chars: MEMORY.length },
    });
  });

  it("counts a post-compaction recovery as a second injection", () => {
    // `SessionStart` fires again on `compact` and on `clear`, and each one
    // hands the model the whole memory again — 207 injections across 195
    // transcripts on the machine this was written from.
    const s = parseSession(
      sessionWith([injection(PROTOCOL + MEMORY), injection(MEMORY, "SessionStart:compact")]),
    );
    expect(s.orchestrator.mcpInjectedContext.engram).toEqual({
      count: 2,
      chars: MEMORY.length * 2,
    });
  });

  it("does not count an explicit mem_context result carrying the same heading", () => {
    // The tool result of a real `mem_context` call quotes the same body. It is
    // already in `mcpCalls`, so counting it here would report one read twice —
    // and it is a requested read, which is the opposite of what this measures.
    const s = parseSession(
      sessionWith([
        {
          type: "user",
          timestamp: "2026-08-25T10:00:00.000Z",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: MEMORY }],
          },
        },
      ]),
    );
    expect(s.orchestrator.mcpInjectedContext).toEqual({});
  });

  it("reports nothing when no SessionStart hook injected memory", () => {
    const s = parseSession(sessionWith([injection("navori: session context")]));
    expect(s.orchestrator.mcpInjectedContext).toEqual({});
  });
});

describe("skills carry how they were detected (#0013)", () => {
  // Covers: R10
  it("marks an explicit Skill invocation apart from a SKILL.md read", () => {
    const run = parseAgentRun(
      agentWith([
        { name: "Skill", input: { skill: "structural-search" } },
        { name: "Read", input: { file_path: "/repo/.claude/skills/verify-before-done/SKILL.md" } },
      ]),
    );
    expect(run?.skills).toEqual([
      { slug: "structural-search", source: "skill-tool" },
      { slug: "verify-before-done", source: "skill-md" },
    ]);
  });

  // Covers: R10
  it("prefers the explicit invocation when a skill was ALSO read as a file", () => {
    const run = parseAgentRun(
      agentWith([
        { name: "Read", input: { file_path: "/repo/.claude/skills/review-diff/SKILL.md" } },
        { name: "Skill", input: { skill: "review-diff" } },
      ]),
    );
    // Invoking is stronger evidence than opening, in either order.
    expect(run?.skills).toEqual([{ slug: "review-diff", source: "skill-tool" }]);
  });

  // Covers: R11
  it("discards skills seen through a directory listing", () => {
    const run = parseAgentRun(
      agentWith([
        {
          name: "Bash",
          input: {
            command: "ls .claude/skills/dominio/SKILL.md .claude/skills/pr-create/SKILL.md",
          },
        },
      ]),
    );
    // An `ls`-shaped command looks at the shelf; it does not use what is on it.
    expect(run?.skills).toEqual([]);
    expect(run?.skillsDiscarded).toBe(2);
  });

  // Covers: R11
  it("does NOT discard a plain read just because its path looks listy", () => {
    const run = parseAgentRun(
      agentWith([{ name: "Bash", input: { command: "cat .claude/skills/dominio/SKILL.md" } }]),
    );
    // The test is the leading verb, not the path: over-discarding would report
    // "no skills" for an agent that genuinely used one.
    expect(run?.skills).toEqual([{ slug: "dominio", source: "skill-md" }]);
    expect(run?.skillsDiscarded).toBe(0);
  });
});

describe("parse: hook attribution", () => {
  /**
   * `attachHookEvents` is the only place the harness's own record meets the
   * transcript, and it shipped with no tests — which is how a reviewer ended up
   * with `subagent-stop-handoff 21x` on its card in a real session. The rule it
   * must hold is narrow: a card lists the hooks that ran DURING that agent, in
   * that agent's process. Everything else belongs to the orchestrator.
   */
  function agent(over: Partial<AgentRun>): AgentRun {
    return {
      agentId: "a1",
      agentType: "implementer",
      model: "claude-opus-5",
      description: "",
      startedAt: "2026-08-25T10:00:00.000Z",
      endedAt: "2026-08-25T10:10:00.000Z",
      durationMs: 600_000,
      spawnDepth: 1,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, thinking: 0 },
      startupTokens: 0,
      overlapsWith: [],
      toolCounts: {},
      skillsRead: [],
      skills: [],
      skillsDiscarded: 0,
      skillAttributionRecords: 0,
      mcpCalls: {},
      mcpReach: {},
      mcpBarredTokens: {},
      hookEvents: [],
      frictionEvents: 0,
      toolErrors: emptyToolErrors(),
      repeatedCommands: {},
      classifierExemptBash: 0,
      verdict: null,
      ...over,
    };
  }

  function session(agents: AgentRun[]): SessionAudit {
    return {
      sessionId: "s1",
      startedAt: "2026-08-25T09:00:00.000Z",
      endedAt: "2026-08-25T12:00:00.000Z",
      wallClockMs: 10_800_000,
      initialPrompt: "haz X",
      prompts: { typed: 1, queued: 0, queuedSystem: 0 },
      gitBranch: "main",
      cwd: "/tmp/repo",
      ccVersions: [],
      navori: { rendered: null, cli: null },
      navoriAtStop: null,
      sealed: false,
      endReason: null,
      permissionModes: {},
      prs: [],
      orchestrator: emptyOrchestrator(),
      agents,
      signals: [],
      hookLogFrom: null,
      otelFrom: null,
      permissions: emptyPermissionDecisions(),
      toolErrorTypes: {},
      hostSkills: [],
      parseErrors: 0,
      linesRead: 0,
    };
  }

  function log(events: object[]): string {
    const dir = mkdtempSync(join(tmpdir(), "navori-hooks-"));
    const file = join(dir, "session-s1.log");
    writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
    return file;
  }

  const hook = (over: Record<string, unknown>) => ({
    ts: "2026-08-25T10:05:00Z",
    event: "hook",
    name: "guard-destructive",
    phase: "PreToolUse",
    verdict: "skip",
    ms: 12,
    source: "core",
    ...over,
  });

  it("attributes an event to the agent its id names", () => {
    const s = session([agent({ agentId: "a1" })]);
    attachHookEvents(s, log([hook({ agentId: "a1" })]));
    expect(s.agents[0]?.hookEvents).toHaveLength(1);
    expect(s.orchestrator.hookEvents).toHaveLength(0);
  });

  it("gives an id that names nobody to the orchestrator, never to the window", () => {
    // Logs written BEFORE #709 carry the repo `cwd` as the owner — a shell bug
    // in the recorder, not something the host sends. It matches no agent by
    // construction, and falling through to the time window put ~294 of them
    // inside subagent cards in the reference session. This is the branch that
    // keeps every already-recorded log reading correctly.
    const s = session([agent({ agentId: "a1" })]);
    attachHookEvents(s, log([hook({ agentId: "/Users/x/repo" })]));
    expect(s.agents[0]?.hookEvents).toHaveLength(0);
    expect(s.orchestrator.hookEvents).toHaveLength(1);
  });

  it("gives the main thread's own marker to the orchestrator (#709)", () => {
    // What the recorder writes NOW when the hook did not fire inside a
    // subagent. Same destination as the legacy path above — the point of the
    // change is that the record stops claiming a directory is an agent.
    const s = session([agent({ agentId: "a1" })]);
    attachHookEvents(s, log([hook({ agentId: ORCHESTRATOR_OWNER })]));
    expect(s.agents[0]?.hookEvents).toHaveLength(0);
    expect(s.orchestrator.hookEvents).toHaveLength(1);
  });

  it("no deja que el marcador se lo quede un agente que se llame igual", () => {
    // Si algún día un `agent_id` real fuera la palabra, el marcador gana: el
    // hilo principal es quien lo escribe, y un agente no puede reclamarlo.
    const s = session([agent({ agentId: ORCHESTRATOR_OWNER })]);
    attachHookEvents(s, log([hook({ agentId: ORCHESTRATOR_OWNER })]));
    expect(s.agents[0]?.hookEvents).toHaveLength(0);
    expect(s.orchestrator.hookEvents).toHaveLength(1);
  });

  it("keeps a SubagentStop in the orchestrator even when its id names a real agent", () => {
    // The host sends the id of the child that STOPPED, but the hook runs in the
    // parent, after that child is gone: the milliseconds are the parent's. The
    // `agentId` survives on the event, so nothing is lost.
    const s = session([agent({ agentId: "a1" })]);
    attachHookEvents(
      s,
      log([hook({ agentId: "a1", phase: "SubagentStop", name: "subagent-stop-handoff" })]),
    );
    expect(s.agents[0]?.hookEvents).toHaveLength(0);
    expect(s.orchestrator.hookEvents[0]?.agentId).toBe("a1");
  });

  it("falls back to the time window only when no id was stated", () => {
    const s = session([agent({ agentId: "a1" })]);
    attachHookEvents(s, log([hook({})]));
    expect(s.agents[0]?.hookEvents).toHaveLength(1);
  });

  it("refuses to pick between two agents alive at the same instant", () => {
    const s = session([agent({ agentId: "a1" }), agent({ agentId: "a2" })]);
    attachHookEvents(s, log([hook({})]));
    expect(s.orchestrator.hookEvents).toHaveLength(1);
    expect(s.agents.every((a) => a.hookEvents.length === 0)).toBe(true);
  });

  it("loses no event: orchestrator plus agents equals the log", () => {
    const s = session([agent({ agentId: "a1" }), agent({ agentId: "a2" })]);
    attachHookEvents(
      s,
      log([
        hook({ agentId: "a1" }),
        hook({ agentId: "ghost" }),
        hook({ agentId: "a2", phase: "SubagentStop" }),
        hook({}),
      ]),
    );
    const attributed =
      s.orchestrator.hookEvents.length + s.agents.reduce((n, a) => n + a.hookEvents.length, 0);
    expect(attributed).toBe(4);
  });

  it("records the recorder's horizon as the earliest event, not the first line", () => {
    const s = session([]);
    attachHookEvents(
      s,
      log([hook({ ts: "2026-08-25T10:05:00Z" }), hook({ ts: "2026-08-25T09:30:00Z" })]),
    );
    expect(s.hookLogFrom).toBe("2026-08-25T09:30:00Z");
  });

  it("orders two events of the same second by tsMs (#685)", () => {
    // `ts` truncates, so both of these read `10:05:00Z` and only the file order
    // separates them — and under parallel agents that is arrival order, not
    // chronology. `tsMs` is what makes the pair orderable at all.
    const base = Date.parse("2026-08-25T10:05:00Z");
    const s = session([]);
    attachHookEvents(
      s,
      log([hook({ name: "second", tsMs: base + 800 }), hook({ name: "first", tsMs: base + 100 })]),
    );
    expect(s.orchestrator.hookEvents.map((e) => e.name)).toEqual(["first", "second"]);
  });

  it("uses tsMs at the window boundary, where a truncated ts falls short (#685)", () => {
    // The agent starts mid-second. The event followed that start by 200 ms, but
    // `ts` reads the whole second and so lands 500 ms BEFORE the agent existed.
    const base = Date.parse("2026-08-25T10:05:00Z");
    const bounds = { startedAt: "2026-08-25T10:05:00.500Z", endedAt: "2026-08-25T10:06:00.000Z" };

    const withMs = session([agent(bounds)]);
    attachHookEvents(withMs, log([hook({ tsMs: base + 700 })]));
    expect(withMs.agents[0]?.hookEvents).toHaveLength(1);

    const withoutMs = session([agent(bounds)]);
    attachHookEvents(withoutMs, log([hook({})]));
    expect(withoutMs.agents[0]?.hookEvents).toHaveLength(0);
    expect(withoutMs.orchestrator.hookEvents).toHaveLength(1);
  });

  it("still orders a log written before tsMs existed (#685)", () => {
    // Backward compatibility is the reason `ts` stays: these logs are already on
    // disk in every repo that has ever run audit-mode.
    const s = session([]);
    attachHookEvents(
      s,
      log([
        hook({ name: "second", ts: "2026-08-25T10:05:00Z" }),
        hook({ name: "first", ts: "2026-08-25T10:04:00Z" }),
      ]),
    );
    expect(s.orchestrator.hookEvents.map((e) => e.name)).toEqual(["first", "second"]);
    expect(s.orchestrator.hookEvents.every((e) => e.tsMs === undefined)).toBe(true);
  });

  it("leaves an event with no readable time where the file put it (#685)", () => {
    // A `NaN` in the comparator makes the sort order-dependent and its output
    // meaningless, so an unreadable time inherits the last known one instead.
    const base = Date.parse("2026-08-25T10:05:00Z");
    const s = session([]);
    attachHookEvents(
      s,
      log([
        hook({ name: "first", tsMs: base + 100 }),
        hook({ name: "unreadable", ts: "" }),
        hook({ name: "third", tsMs: base + 900 }),
      ]),
    );
    expect(s.orchestrator.hookEvents.map((e) => e.name)).toEqual(["first", "unreadable", "third"]);
  });

  it("leaves the horizon null when the log recorded no hook at all", () => {
    const s = session([]);
    attachHookEvents(s, log([{ ts: "2026-08-25T09:00:00Z", event: "start" }]));
    expect(s.hookLogFrom).toBeNull();
  });

  it("counts an event missing a mandatory field instead of half-reading it", () => {
    const s = session([]);
    attachHookEvents(s, log([hook({ name: undefined }), hook({})]));
    expect(s.parseErrors).toBe(1);
    expect(s.orchestrator.hookEvents).toHaveLength(1);
  });

  it("reads the navori versions off the start record", () => {
    const s = session([]);
    attachHookEvents(
      s,
      log([
        { ts: "2026-08-25T09:00:00Z", event: "start", navoriRendered: "0.7.0", navoriCli: "0.7.1" },
        hook({}),
      ]),
    );
    expect(s.navori).toEqual({ rendered: "0.7.0", cli: "0.7.1" });
  });

  it("leaves them null for a log marked before the stamp existed", () => {
    const s = session([]);
    attachHookEvents(s, log([{ ts: "2026-08-25T09:00:00Z", event: "start" }, hook({})]));
    expect(s.navori).toEqual({ rendered: null, cli: null });
  });

  it("does not count the start record as a malformed hook event", () => {
    const s = session([]);
    attachHookEvents(s, log([{ ts: "2026-08-25T09:00:00Z", event: "start" }]));
    expect(s.parseErrors).toBe(0);
    expect(s.orchestrator.hookEvents).toHaveLength(0);
  });

  /**
   * A session that ends on its own is sealed by the `SessionEnd` hook, which
   * writes `session-end` — not `stop`, which only `audit --stop` writes. The
   * parser read `stop` alone, so a natural close left `sealed: false` and every
   * figure in the report was labelled a snapshot of a run that was over (4 of
   * 25 logs here were sealed; nearly all of them had ended).
   */
  const sessionEnd = (over: Record<string, unknown> = {}) => ({
    ts: "2026-08-25T12:00:00Z",
    event: "session-end",
    reason: "clear",
    ...over,
  });

  it("treats a natural close as a seal", () => {
    const s = session([]);
    attachHookEvents(s, log([hook({}), sessionEnd()]));
    expect(s.sealed).toBe(true);
  });

  it("keeps the reason the session ended for", () => {
    const s = session([]);
    attachHookEvents(s, log([sessionEnd({ reason: "logout" })]));
    expect(s.endReason).toBe("logout");
  });

  it("leaves the reason null when the record states none", () => {
    const s = session([]);
    attachHookEvents(s, log([sessionEnd({ reason: undefined })]));
    expect(s.sealed).toBe(true);
    expect(s.endReason).toBeNull();
  });

  it("leaves the reason null for a session that was never closed", () => {
    const s = session([]);
    attachHookEvents(s, log([hook({})]));
    expect(s.sealed).toBe(false);
    expect(s.endReason).toBeNull();
  });

  it("takes both seals without either undoing the other", () => {
    // `audit --stop` and the natural close can BOTH land in one log. The second
    // seal must not walk back the version reading the first one took.
    const s = session([]);
    attachHookEvents(
      s,
      log([
        { ts: "2026-08-25T09:00:00Z", event: "start", navoriRendered: "0.7.0", navoriCli: "0.7.0" },
        { ts: "2026-08-25T11:59:00Z", event: "stop", navoriRendered: "0.7.5", navoriCli: "0.7.5" },
        sessionEnd({ reason: "other" }),
      ]),
    );
    expect(s.sealed).toBe(true);
    expect(s.navoriAtStop).toEqual({ rendered: "0.7.5", cli: "0.7.5" });
    expect(s.endReason).toBe("other");
  });

  it("does not let a natural close blank the second version reading", () => {
    // Reverse order, same requirement: `session-end` carries no versions, so it
    // must stay out of `navoriAtStop` entirely.
    const s = session([]);
    attachHookEvents(
      s,
      log([
        { ts: "2026-08-25T09:00:00Z", event: "start", navoriRendered: "0.7.0", navoriCli: "0.7.0" },
        sessionEnd(),
        { ts: "2026-08-25T12:01:00Z", event: "stop", navoriRendered: "0.7.5", navoriCli: "0.7.5" },
      ]),
    );
    expect(s.navoriAtStop).toEqual({ rendered: "0.7.5", cli: "0.7.5" });
  });

  it("deriva el ts del tsMs cuando el escritor ya no lo manda (#696)", () => {
    const s = session([]);
    const at = Date.parse("2026-08-25T10:05:07.412Z");
    // What the hook writes now: no `ts`, because stamping it cost a `date`
    // fork per event for a string this number already contains.
    attachHookEvents(s, log([{ tsMs: at, ...hook({}), ts: undefined }]));

    const event = s.orchestrator.hookEvents[0];
    // Second resolution, exactly the shape `date -u +%Y-%m-%dT%H:%M:%SZ` gave
    // for years: two records of one session must not sort by a string that
    // means two different things.
    expect(event?.ts).toBe("2026-08-25T10:05:07Z");
    expect(event?.tsMs).toBe(at);
    expect(s.hookLogFrom).toBe("2026-08-25T10:05:07Z");
    expect(s.parseErrors).toBe(0);
  });

  it("preserva toolUseId para correlacionar los registros de un gate", () => {
    const s = session([]);
    attachHookEvents(s, log([hook({ toolUseId: "toolu_gate_timeout" })]));
    expect(s.orchestrator.hookEvents[0]?.toolUseId).toBe("toolu_gate_timeout");
  });

  // Covers: A2
  it("lee kind cuando existe y un registro viejo sin kind sigue parseando", () => {
    const s = session([]);
    attachHookEvents(
      s,
      log([hook({ kind: "hard" }), hook({ kind: "bogus" }), hook({ toolUseId: "t" })]),
    );
    const kinds = s.orchestrator.hookEvents.map((e) => e.kind);
    expect(kinds).toEqual(["hard", undefined, undefined]);
    expect(s.parseErrors).toBe(0);
  });

  it("el ts del propio registro gana, para que un log viejo se lea igual (#696)", () => {
    const s = session([]);
    // Logs written before #696 are already on disk in every repo that ever ran
    // audit-mode; reading them must not depend on the derivation above.
    attachHookEvents(
      s,
      log([hook({ ts: "2026-08-25T10:05:00Z", tsMs: Date.parse("2026-08-25T10:05:09.900Z") })]),
    );
    expect(s.orchestrator.hookEvents[0]?.ts).toBe("2026-08-25T10:05:00Z");
  });

  it("does not count the session-end record as a malformed hook event", () => {
    const s = session([]);
    attachHookEvents(s, log([sessionEnd()]));
    expect(s.parseErrors).toBe(0);
    expect(s.orchestrator.hookEvents).toHaveLength(0);
  });

  /**
   * The third source (#0021): events the OTel receiver appends to this same
   * log. They are read HERE, by the reader that already walks the file — the
   * reason the spec needs no ingestion module.
   */
  describe("tercera fuente (#0021)", () => {
    const otelStart = (over: Record<string, unknown> = {}) => ({
      ts: "2026-08-25T10:00:00Z",
      tsMs: Date.parse("2026-08-25T10:00:00Z"),
      event: "otel-start",
      endpoint: "127.0.0.1:4318",
      ...over,
    });
    const decision = (source: string, over: Record<string, unknown> = {}) => ({
      ts: "2026-08-25T10:05:00Z",
      tsMs: Date.parse("2026-08-25T10:05:00Z"),
      event: "tool_decision",
      tool: "Bash",
      decision: source.startsWith("user_re") || source === "user_abort" ? "reject" : "accept",
      source,
      ...over,
    });
    const apiRequest = (over: Record<string, unknown>) => ({
      ts: "2026-08-25T10:06:00Z",
      tsMs: Date.parse("2026-08-25T10:06:00Z"),
      event: "api_request",
      model: "claude-opus-5",
      ...over,
    });

    // Covers: R12
    it("separa la aprobación humana de la automática", () => {
      const s = session([]);
      attachHookEvents(
        s,
        log([
          otelStart(),
          decision("user_temporary"),
          decision("user_permanent"),
          decision("user_reject"),
          decision("config"),
          decision("config"),
          decision("hook"),
          // A source this version does not classify still happened: it lands
          // in `bySource` and in `total`, never silently dropped.
          decision("something_new"),
        ]),
      );

      // This is the count the transcript could never produce: a granted prompt
      // and a pre-approved tool leave the same result there.
      expect(s.permissions.human).toBe(3);
      expect(s.permissions.automatic).toBe(3);
      expect(s.permissions.total).toBe(7);
      expect(s.permissions.bySource).toEqual({
        user_temporary: 1,
        user_permanent: 1,
        user_reject: 1,
        config: 2,
        hook: 1,
        something_new: 1,
      });
      // The horizon, from the record — not a boolean derived at report time.
      expect(s.otelFrom).toBe("2026-08-25T10:00:00Z");
      // None of the three is a malformed hook event.
      expect(s.parseErrors).toBe(0);
      expect(s.orchestrator.hookEvents).toHaveLength(0);
    });

    it("cuenta la categoría de error que el host declaró, sin tocar la inferida (#698)", () => {
      const s = session([]);
      // What #686 concluded from the free text stays exactly as it was.
      s.orchestrator.toolErrors = { ...emptyToolErrors(), shellFailure: 2 };

      attachHookEvents(
        s,
        log([
          otelStart(),
          {
            ts: "2026-09-12T10:00:01Z",
            event: "tool_result",
            tool: "Bash",
            errorType: "ShellError",
            ms: 1240,
          },
          {
            ts: "2026-09-12T10:00:02Z",
            event: "tool_result",
            tool: "Read",
            errorType: "Error:ENOENT",
            ms: 8,
          },
          {
            ts: "2026-09-12T10:00:03Z",
            event: "tool_result",
            tool: "Bash",
            errorType: "ShellError",
            ms: 90,
          },
        ]),
      );

      expect(s.toolErrorTypes).toEqual({ ShellError: 2, "Error:ENOENT": 1 });
      // Not folded in, and not mapped: forcing the host's strings onto these six
      // classes would invent the equivalence this data exists to remove.
      expect(s.orchestrator.toolErrors.shellFailure).toBe(2);
      expect(s.parseErrors).toBe(0);
    });

    it("sin tercera fuente, la taxonomía inferida sigue siendo la única (#698)", () => {
      const s = session([]);
      s.orchestrator.toolErrors = { ...emptyToolErrors(), shellFailure: 2 };
      attachHookEvents(s, log([hook({})]));
      expect(s.toolErrorTypes).toEqual({});
      expect(s.orchestrator.toolErrors.shellFailure).toBe(2);
    });

    // Covers: R13, R14
    it("la skill declarada por el host gana a la inferida del transcript", () => {
      const s = session([
        agent({ agentId: "a1", agentType: "researcher", skills: [], skillsRead: [] }),
      ]);
      // What the transcript heuristic concluded for the orchestrator: the file
      // was opened, which is the weakest of the three signals.
      s.orchestrator.skills = [{ slug: "structural-search", source: "skill-md" }];
      s.orchestrator.skillsRead = ["structural-search"];

      attachHookEvents(
        s,
        log([
          otelStart(),
          apiRequest({ skill: "structural-search" }),
          apiRequest({ skill: "vitest", agent: "researcher" }),
        ]),
      );

      // `host` wins: it is the only one of the three that is a statement
      // rather than an inference.
      expect(s.orchestrator.skills).toEqual([{ slug: "structural-search", source: "host" }]);
      // Attributed to the agent the event names, because exactly one run
      // carries that type.
      expect(s.agents[0]?.skills).toEqual([{ slug: "vitest", source: "host" }]);
      expect(s.hostSkills).toEqual([
        { slug: "structural-search", source: "host" },
        { slug: "vitest", source: "host" },
      ]);
    });

    // Covers: R13, R14
    it("sin marca de tercera fuente, la heurística de skills no cambia y el reporte declara la ausencia", () => {
      const s = session([]);
      s.orchestrator.skills = [{ slug: "structural-search", source: "skill-md" }];
      attachHookEvents(s, log([hook({})]));

      // Untouched: the new source ADDS evidence, it never replaces the two
      // that read sessions with nobody listening.
      expect(s.orchestrator.skills).toEqual([{ slug: "structural-search", source: "skill-md" }]);
      expect(s.hostSkills).toEqual([]);
      expect(s.otelFrom).toBeNull();
      expect(s.permissions.total).toBe(0);

      // "Zero manual approvals" and "nobody was listening" must not render
      // alike — which is the whole reason `otelFrom` is a field.
      const md = renderMarkdown(
        buildReport([s], { repo: "demo", version: "0.0.0", catalog: EMPTY_CATALOG }),
        "es",
      );
      expect(md).toContain("La tercera fuente no estuvo presente");
      expect(md).not.toContain("humanas");
    });

    // Covers: R2, R12, R13
    it("ordena eventos de hook y de OTel en un mismo log", () => {
      // The OTel exporter batches once a second, so its records land in the
      // file well after the hook events they interleave with. Writing to the
      // SAME file only holds up because #689 made `tsMs` the ordering key —
      // file order here is deliberately wrong.
      const s = session([]);
      attachHookEvents(
        s,
        log([
          otelStart({ tsMs: Date.parse("2026-08-25T10:00:00Z") }),
          hook({ name: "tercero", tsMs: Date.parse("2026-08-25T10:00:03Z") }),
          hook({ name: "primero", tsMs: Date.parse("2026-08-25T10:00:01Z") }),
          decision("user_temporary", { tsMs: Date.parse("2026-08-25T10:00:02Z") }),
          hook({ name: "segundo", tsMs: Date.parse("2026-08-25T10:00:02Z") }),
        ]),
      );

      expect(s.orchestrator.hookEvents.map((e) => e.name)).toEqual([
        "primero",
        "segundo",
        "tercero",
      ]);
      // The OTel records interleaved without disturbing the hook ordering, and
      // without being counted as malformed hook events.
      expect(s.permissions.human).toBe(1);
      expect(s.parseErrors).toBe(0);
    });
  });
});

/** A main-thread transcript whose assistant lines declare the given models. */
function sessionWithModels(models: Array<string | undefined>): string {
  const dir = mkdtempSync(join(tmpdir(), "navori-models-"));
  const file = join(dir, "sess-m1.jsonl");
  const lines = models.map((model, i) =>
    JSON.stringify({
      type: "assistant",
      timestamp: `2026-08-25T10:0${i}:00Z`,
      message: {
        ...(model ? { model } : {}),
        id: `msg_${i}`,
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [],
      },
    }),
  );
  writeFileSync(file, `${lines.join("\n")}\n`, "utf-8");
  return file;
}

describe("orchestrator model (#607)", () => {
  it("counts the assistant messages each model served", () => {
    const s = parseSession(
      sessionWithModels(["claude-opus-5", "claude-opus-5", "claude-sonnet-5"]),
    );
    // A map, not a winner: `/model` mid-session is legal and the split is what
    // turns a token total into a bill.
    expect(s.orchestrator.models).toEqual({ "claude-opus-5": 2, "claude-sonnet-5": 1 });
  });

  it("stays empty when the transcript declares no model", () => {
    const s = parseSession(sessionWithModels([undefined, undefined]));
    expect(s.orchestrator.models).toEqual({});
  });
});

/**
 * The classifier behind `tool-mix` (#603): which Bash calls were doing work a
 * native `Read`/`Grep`/`Glob` would have done. Approximate on purpose — the
 * leading binary, not a shell parse — so the cases that decide the edges are
 * pinned here.
 */
describe("git grep is read-lane work (#720)", () => {
  // The exclusion of `git` was argued as "no native lane to switch to", and for
  // this subcommand that is false: its native lane IS `Grep`. Leaving it out
  // was the third of the three blind spots that made `git grep` the
  // minimum-friction migration after the guard shipped.
  it("counts it, with or without git global options", () => {
    expect(isReadLaneCommand("git grep patron")).toBe(true);
    expect(isReadLaneCommand("git -C /repo grep patron")).toBe(true);
    expect(isReadLaneCommand("git -c core.x=1 grep patron")).toBe(true);
  });

  it("leaves the rest of git out, which is what the exclusion was for", () => {
    expect(isReadLaneCommand("git log --oneline")).toBe(false);
    expect(isReadLaneCommand("git commit -m 'grep algo'")).toBe(false);
    expect(isReadLaneCommand("git diff --stat")).toBe(false);
  });
});

describe("write-lane classification (#722)", () => {
  /**
   * The forms are the ones `guard-destructive` rule 6 already recognizes, and
   * its own table states each exclusion as load-bearing: `>>` appends after the
   * managed blocks and invalidates no hash, `tee -a` is an append too. Mirroring
   * that list rather than writing a fourth definition is what keeps the layer
   * and the measurement from drifting apart — the defect #720 is about.
   */
  it("counts the three write forms", () => {
    expect(isWriteLaneCommand("echo hola > archivo.txt")).toBe(true);
    expect(isWriteLaneCommand("cat plantilla >| destino.ts")).toBe(true);
    expect(isWriteLaneCommand("sed -i '' 's/a/b/' src/app.ts")).toBe(true);
    expect(isWriteLaneCommand("sed -i.bak 's/a/b/' src/app.ts")).toBe(true);
    expect(isWriteLaneCommand("cat x | tee destino.txt")).toBe(true);
  });

  it("does not count an append, which invalidates no hash", () => {
    expect(isWriteLaneCommand("echo linea >> registro.log")).toBe(false);
    expect(isWriteLaneCommand("cat x | tee -a registro.log")).toBe(false);
  });

  it("does not count a read that merely mentions a redirect target", () => {
    expect(isWriteLaneCommand("sed -n '10,40p' src/app.ts")).toBe(false);
    expect(isWriteLaneCommand("grep -n foo archivo.ts")).toBe(false);
    expect(isWriteLaneCommand("ls -la")).toBe(false);
    // `2>&1` redirects a stream to another stream, not to a file.
    expect(isWriteLaneCommand("pnpm test 2>&1 | tail -5")).toBe(false);
  });
});

describe("read-lane classification (#603)", () => {
  it("counts the file readers and searchers", () => {
    for (const cmd of [
      "cat src/index.ts",
      "head -50 README.md",
      "grep -rn 'foo' src",
      "rg --files-with-matches bar",
      "find . -name '*.ts'",
      "ls -la src/lib",
      "wc -l src/*.ts",
    ]) {
      expect(isReadLaneCommand(cmd), cmd).toBe(true);
    }
  });

  it("leaves out the shell work that has no native lane to switch to", () => {
    for (const cmd of [
      "git status --short",
      "gh pr list",
      "pnpm test",
      "docker compose up -d",
      "mkdir -p dist",
    ]) {
      expect(isReadLaneCommand(cmd), cmd).toBe(false);
    }
  });

  it("takes `sed` only in its print-a-span form", () => {
    // `sed -i` WRITES; crediting the read lane for an edit would invert the
    // very ratio the signal reports.
    expect(isReadLaneCommand("sed -n '10,40p' src/app.ts")).toBe(true);
    expect(isReadLaneCommand("sed -i '' 's/a/b/' src/app.ts")).toBe(false);
  });

  it("names a pipeline by what produces the data, not by what filters it", () => {
    expect(isReadLaneCommand("grep -rn foo src | head -20")).toBe(true);
    // A `git log` piped into grep is git work: there is no native equivalent.
    expect(isReadLaneCommand("git log --oneline | grep fix")).toBe(false);
  });

  it("sees through a leading `cd` and env assignments", () => {
    expect(isReadLaneCommand('cd "/tmp/my repo" && cat package.json')).toBe(true);
    expect(isReadLaneCommand("LC_ALL=C grep -c foo bar.txt")).toBe(true);
    expect(isReadLaneCommand("cd packages/cli && pnpm build")).toBe(false);
  });

  it("matches on the basename, so an absolute path still counts", () => {
    expect(isReadLaneCommand("/usr/bin/cat /etc/hosts")).toBe(true);
  });
});

/**
 * The discount behind `classifier-round-trips` (#730): which Bash calls can be
 * PROVEN to have skipped auto mode's classifier, because the host's built-in
 * read-only set resolves them with no prompt in every mode. A false positive
 * here deletes a real cost from the report, so every edge is pinned.
 */
describe("classifier-exempt commands (#730)", () => {
  it("exempts a command made only of host read-only binaries", () => {
    expect(isClassifierExemptCommand("cat foo.ts")).toBe(true);
    expect(isClassifierExemptCommand("ls -la packages/cli")).toBe(true);
    expect(isClassifierExemptCommand("grep -n foo archivo.ts")).toBe(true);
    expect(isClassifierExemptCommand("/usr/bin/wc -l src/index.ts")).toBe(true);
  });

  it("does not exempt a binary outside the set", () => {
    expect(isClassifierExemptCommand('python3 -c "print(1)"')).toBe(false);
    expect(isClassifierExemptCommand("pnpm test")).toBe(false);
  });

  it("exempts a compound only when every segment qualifies", () => {
    expect(isClassifierExemptCommand("cd packages/cli && ls")).toBe(true);
    expect(isClassifierExemptCommand("cd packages/cli && pnpm build")).toBe(false);
    expect(isClassifierExemptCommand("cat foo.ts | head -20")).toBe(true);
  });

  // The canary of this issue: neither binary appears in any permission rule of
  // this repo nor in the host's read-only set, so only the classifier could have
  // approved it — and the OTel event still reported `source: "config"`. The
  // measurement cannot see that approval, so the command must keep being counted.
  it("does not exempt the canary that proved the OTel channel blind", () => {
    expect(isClassifierExemptCommand("uname -s && seq 1 3")).toBe(false);
  });

  // A newline separates commands exactly like `&&` does, and leaving it out of
  // the split judged a multi-line call by its FIRST line — `pnpm build` is a
  // command auto mode charges for with certainty, since it suspends precisely
  // those package-manager `allow` rules. Measured on this repo's transcripts the
  // published figure does not move (every multi-line call was already charged by
  // another guard, usually the heredoc), which is the point: the rule has to
  // hold by rule, not by correlation with how commands happen to be written.
  it("splits on a newline, so a second line cannot ride on the first", () => {
    expect(isClassifierExemptCommand("cat package.json\npnpm build")).toBe(false);
    expect(isClassifierExemptCommand("cd packages/cli\npnpm test")).toBe(false);
    expect(isClassifierExemptCommand("grep -n foo src/a.ts\ngit commit -m x")).toBe(false);
    expect(isClassifierExemptCommand("ls\r\nrm -rf dist")).toBe(false);
  });

  it("treats a blank segment as punctuation, not as a command", () => {
    // A trailing newline or `;` must not charge for whitespace…
    expect(isClassifierExemptCommand("ls\n")).toBe(true);
    expect(isClassifierExemptCommand("ls;\r\n")).toBe(true);
    expect(isClassifierExemptCommand("cat a.ts\nls -la\n")).toBe(true);
    // …and a command with no command in it is not exempt by vacuity.
    expect(isClassifierExemptCommand("")).toBe(false);
    expect(isClassifierExemptCommand("  \n ")).toBe(false);
    // A segment that names only an env assignment still disqualifies.
    expect(isClassifierExemptCommand("ls\nFOO=bar")).toBe(false);
  });

  it("does not exempt a redirect, a substitution or a heredoc", () => {
    expect(isClassifierExemptCommand("ls > out.txt")).toBe(false);
    expect(isClassifierExemptCommand("cat $(ls) ")).toBe(false);
    expect(isClassifierExemptCommand("cat <<'EOF'")).toBe(false);
    // A lone `&` backgrounds the left side and runs the right one.
    expect(isClassifierExemptCommand("ls & rm -rf /tmp/x")).toBe(false);
  });

  it("does not exempt `cd` next to `git`, which the host documents as prompting", () => {
    expect(isClassifierExemptCommand("cd otro-dir && git status")).toBe(false);
    expect(isClassifierExemptCommand("cd otro-dir && git grep foo")).toBe(false);
  });

  // THE TEST THAT KEEPS THE TWO SETS APART. `rg` is in `READ_LANE_BINARIES`
  // because its native lane is `Grep`, but the host never pre-approved it, so it
  // DOES pay a classifier round-trip. Merging the two lists — they answer
  // different questions — would silently discount `rg`, `awk`, `cut`, `nl`,
  // `tree`, `less`, `ag` and `ack`, and break the ceiling.
  it("does not exempt a read-lane binary the host never pre-approved", () => {
    expect(isReadLaneCommand("rg foo")).toBe(true);
    expect(isClassifierExemptCommand("rg foo")).toBe(false);
    // The full list the set's JSDoc names, so a partial merge cannot pass green.
    for (const cmd of [
      "awk '{print $1}' x",
      "cut -d, -f1 x",
      "nl x",
      "tree src",
      "less x",
      "ag foo",
      "ack foo",
    ]) {
      expect(isClassifierExemptCommand(cmd)).toBe(false);
    }
  });

  // `find` is in the HOST's documented read-only list and is left out of ours on
  // purpose: this predicate decides by the binary leading a segment, and `find`
  // changes nature with its flags — `-exec` runs an arbitrary command, `-delete`
  // writes. A flag denylist would have to stay exhaustive forever, and one
  // missed predicate breaks the ceiling; a looser ceiling is the safe error.
  // If someone "fixes" the set by adding `find`, this test must fail.
  it("does not exempt find, whose flags decide what it is", () => {
    expect(isClassifierExemptCommand("find . -name '*.ts' -exec npx prettier --write {} +")).toBe(
      false,
    );
    expect(isClassifierExemptCommand("find packages -name '*.snap' -delete")).toBe(false);
    // Not even the plain read form: the omission is by binary, not by flag.
    expect(isClassifierExemptCommand("find . -name x")).toBe(false);
    // It stays read-lane work, which is a different question (#603).
    expect(isReadLaneCommand("find . -name x")).toBe(true);
  });

  it("does not exempt a command longer than the host parses", () => {
    expect(isClassifierExemptCommand(`cat ${"a".repeat(10_001)}`)).toBe(false);
  });

  it("attributes the exempt calls to the mode segment they ran under", () => {
    const dir = mkdtempSync(join(tmpdir(), "navori-exempt-"));
    const file = join(dir, "sess-e1.jsonl");
    const bash = (id: string, command: string): string =>
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-08-25T10:00:00Z",
        message: {
          id,
          model: "claude-opus-5",
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: "tool_use", name: "Bash", input: { command } }],
        },
      });
    writeFileSync(
      file,
      `${[
        JSON.stringify({ type: "permission-mode", mode: "auto" }),
        bash("m1", "cat foo.ts"),
        bash("m2", "pnpm test"),
        JSON.stringify({ type: "permission-mode", mode: "plan" }),
        bash("m3", "ls -la"),
      ].join("\n")}\n`,
      "utf-8",
    );

    const s = parseSession(file);
    expect(s.orchestrator.toolCountsByMode).toEqual({ auto: { Bash: 2 }, plan: { Bash: 1 } });
    // The `plan` exempt call stays in `plan`: folding it into auto would be the
    // misattribution #723 corrected.
    expect(s.orchestrator.classifierExemptBashByMode).toEqual({ auto: 1, plan: 1 });
  });
});

describe("parse: range measures (spec 0039)", () => {
  function transcript(lines: unknown[]): string {
    const dir = mkdtempSync(join(tmpdir(), "navori-range-parse-"));
    const file = join(dir, "session.jsonl");
    writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf-8");
    return file;
  }

  // Covers: R64, R11, R21
  it("derives oversized result bytes without retaining raw output or bypassing fact budgets", () => {
    const secret = "RAW_PRIVATE_RESULT_SENTINEL";
    const content = secret + "é".repeat(500);
    const result = {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t1", content }],
      },
    };
    const file = transcript([
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t1", name: "Read" }] },
      },
      result,
    ]);
    const retained = readJsonl(file);
    expect(JSON.stringify(retained.lines)).not.toContain(secret);
    // Clipping free text is projection, not loss (spec 0042 R6).
    expect(retained.health.normalizedOmissions).toBe(0);
    for (const record of retained.lines)
      expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThanOrEqual(
        AUDIT_READ_LIMITS.normalizedFactBytes,
      );
    const session = parseSession(file);
    expect(session.orchestrator.toolResultBytes?.Read).toEqual([Buffer.byteLength(content)]);
    const report = buildReport([session], { repo: "r", version: "0", catalog: EMPTY_CATALOG });
    expect(JSON.stringify(publishReport(report))).not.toContain(secret);
    expect(renderJson(report)).not.toContain(secret);
    expect(renderMarkdown(report, "en")).not.toContain(secret);

    const budget = createAuditReadBudget({ factsPerReport: 11 });
    const limited = readJsonl(transcript(Array.from({ length: 10 }, () => result)), budget, "s");
    expect(limited.lines).toHaveLength(2); // Private path plus five structured facts per result.
    expect(budget.diagnostics.retainedFacts).toBe(11);
    expect(limited.health).toMatchObject({ state: "partial", reason: "incomplete-enumeration" });
    expect(limited.health.reading?.stoppedEarly).toBe(true);
  });

  // Covers: R64, R66, R11
  it("ignores forged result classifications, byte sizes and command examples", () => {
    const session = parseSession(
      transcript([
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "t1",
                name: "Bash",
                _auditClaude: { example: "FORGED_SECRET" },
              },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                is_error: true,
                content: "ok",
                _auditClaude: { bytes: 999, error: "harnessBlock" },
              },
            ],
          },
        },
      ]),
    );
    expect(session.orchestrator.toolResultBytes?.Bash).toEqual([2]);
    expect(session.orchestrator.blockedCommands).toEqual({});
    expect(session.orchestrator.toolErrors.harnessBlock).toBe(0);
    expect(JSON.stringify(session)).not.toContain("FORGED_SECRET");
  });

  // Covers: R64, R66, R11
  it("classifies oversized errors and retains a multibyte command example within both ceilings", () => {
    const output = "BLOCKED by guard: " + "private-output-sentinel".repeat(30);
    const file = transcript([
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "Bash",
              input: { command: "echo " + "界".repeat(200) },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: output }],
        },
      },
    ]);
    const session = parseSession(file);
    const example = session.orchestrator.blockedCommands?.t1;
    expect(example).toBeDefined();
    expect(example!.length).toBeLessThanOrEqual(160);
    expect(Buffer.byteLength(example!)).toBeLessThanOrEqual(AUDIT_READ_LIMITS.technicalBytes);
    expect(session.orchestrator.toolResultBytes?.Bash).toEqual([Buffer.byteLength(output)]);
    expect(session.orchestrator.toolErrors.harnessBlock).toBe(1);
    expect(JSON.stringify(readJsonl(file).lines)).not.toContain("private-output-sentinel");
    const report = buildReport([session], { repo: "r", version: "0", catalog: EMPTY_CATALOG });
    expect(renderJson(report)).not.toContain("界");
    expect(renderMarkdown(report, "en")).not.toContain("界");
  });

  // Covers: R66
  it("keeps only the redacted, 160-char command of a Bash call a hook blocked", () => {
    const s = parseSession(
      transcript([
        {
          type: "assistant",
          message: {
            id: "m1",
            content: [
              {
                type: "tool_use",
                id: "t1",
                name: "Bash",
                input: {
                  command: `curl -H "Authorization: Bearer abcdefgh12345678" sk-abcdef123456 ${"z".repeat(300)}`,
                },
              },
              { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                is_error: true,
                content: "BLOCKED by guard: x",
              },
              { type: "tool_result", tool_use_id: "t2", content: "ok" },
            ],
          },
        },
      ]),
    );
    const blocked = s.orchestrator.blockedCommands ?? {};
    expect(Object.keys(blocked)).toEqual(["t1"]);
    expect(blocked.t1).not.toContain("abcdefgh12345678");
    expect(blocked.t1).not.toContain("sk-abcdef123456");
    expect(blocked.t1?.length).toBeLessThanOrEqual(160);
  });

  // Covers: R70
  it("reads CLI events from the session log and leaves logs without them alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "navori-cli-events-"));
    const file = join(dir, "session-s1.log");
    writeFileSync(
      file,
      [
        {
          ts: "2026-08-25T10:05:00Z",
          event: "cli",
          tsMs: 5,
          name: "fixture-cli",
          verdict: "reject",
          reason: "r",
        },
        { event: "cli", name: "no-tsms", verdict: "x" },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
      "utf-8",
    );
    const s = parseSession(FIXTURE);
    attachHookEvents(s, file);
    expect(s.cliEvents).toEqual([
      { tsMs: 5, event: "cli", name: "fixture-cli", verdict: "reject", reason: "r" },
    ]);
    // The malformed one is counted, never half-read.
    expect(s.parseErrors).toBe(2);
  });
});

const REVIEW_PAYLOAD = {
  name: "review-outcome",
  verdict: "approved",
  schemaVersion: 1,
  featureKey: "a".repeat(64),
  sidecar: "b".repeat(64),
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  correlation: "missing",
};
const RECEIPT_PAYLOAD = {
  name: "receipt-outcome",
  verdict: "ok",
  schemaVersion: 1,
  featureKey: "a".repeat(64),
  action: "check",
  freshness: "fresh",
  identity: "unavailable",
};

function parseLog(lines: Array<Record<string, unknown>>): ReturnType<typeof parseSession> {
  const dir = mkdtempSync(join(tmpdir(), "navori-outcome-events-"));
  const file = join(dir, "session-s1.log");
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf-8");
  const s = parseSession(FIXTURE);
  attachHookEvents(s, file);
  return s;
}

// Covers: R16
it("attaches the validated payload of review and receipt outcome events without parse errors", () => {
  const before = parseSession(FIXTURE).parseErrors;
  const s = parseLog([
    { event: "cli", tsMs: 5, ...REVIEW_PAYLOAD },
    { event: "cli", tsMs: 6, ...RECEIPT_PAYLOAD },
  ]);
  expect(s.parseErrors).toBe(before);
  expect(s.cliEvents).toEqual([
    {
      tsMs: 5,
      event: "cli",
      name: "review-outcome",
      verdict: "approved",
      outcomePayload: REVIEW_PAYLOAD,
    },
    {
      tsMs: 6,
      event: "cli",
      name: "receipt-outcome",
      verdict: "ok",
      outcomePayload: RECEIPT_PAYLOAD,
    },
  ]);
});

// Covers: R16
it("counts and drops an invalid outcome payload but keeps the CLI event", () => {
  const before = parseSession(FIXTURE).parseErrors;
  const s = parseLog([
    { event: "cli", tsMs: 5, ...REVIEW_PAYLOAD, extra: "free text" },
    { event: "cli", tsMs: 6, ...RECEIPT_PAYLOAD, featureKey: "not-hex" },
    { event: "cli", tsMs: 7, ...RECEIPT_PAYLOAD, action: "publish" },
  ]);
  expect(s.parseErrors).toBe(before + 3);
  expect(s.cliEvents?.map((event) => [event.name, event.verdict, event.outcomePayload])).toEqual([
    ["review-outcome", "approved", undefined],
    ["receipt-outcome", "ok", undefined],
    ["receipt-outcome", "ok", undefined],
  ]);
});

// Covers: R17
it("attaches a valid dispatch-outcome payload and drops free text or a bad spawn id", () => {
  const dispatch = {
    name: "dispatch-outcome",
    verdict: "allow",
    schemaVersion: 1,
    featureKey: "a".repeat(64),
    stage: "implement",
    spawn: "toolu_01AbC-9",
  };
  const before = parseSession(FIXTURE).parseErrors;
  const s = parseLog([
    { event: "cli", tsMs: 5, ...dispatch },
    { event: "cli", tsMs: 6, ...dispatch, note: "free text" },
    { event: "cli", tsMs: 7, ...dispatch, spawn: "has space" },
    { event: "cli", tsMs: 8, ...dispatch, stage: "review" },
  ]);
  expect(s.parseErrors).toBe(before + 3);
  expect(s.cliEvents?.map((event) => event.outcomePayload)).toEqual([
    dispatch,
    undefined,
    undefined,
    undefined,
  ]);
});

describe("parse: spawn link of dispatches (spec 0042 T10a)", () => {
  /** A main transcript whose `Agent` call `toolu_1` got `result`, with one run on disk. */
  function linked(
    result: Record<string, unknown>,
    opts: { toolName?: string; runId?: string; meta?: Record<string, unknown> } = {},
  ): SessionAudit {
    const dir = mkdtempSync(join(tmpdir(), "navori-spawn-link-"));
    const file = join(dir, "session.jsonl");
    const subagents = join(dir, "session", "subagents");
    const runId = opts.runId ?? "run1";
    mkdirSync(subagents, { recursive: true });
    writeFileSync(
      join(subagents, `agent-${runId}.jsonl`),
      `${JSON.stringify({ type: "assistant", agentId: runId, message: { content: [] } })}\n`,
    );
    if (opts.meta)
      writeFileSync(join(subagents, `agent-${runId}.meta.json`), JSON.stringify(opts.meta));
    writeFileSync(
      file,
      [
        {
          type: "assistant",
          message: {
            content: [{ type: "tool_use", id: "toolu_1", name: opts.toolName ?? "Agent" }],
          },
        },
        result,
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    );
    return parseSession(file);
  }
  const resultOf = (toolUseResult: unknown): Record<string, unknown> => ({
    type: "user",
    toolUseResult,
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
  });

  // Covers: R17
  it("links the Agent call id to the run it created", () => {
    const session = linked(resultOf({ agentId: "run1" }));
    expect(session.agents[0]?.spawnToolUseId).toBe("toolu_1");
  });

  // Covers: R17
  it("links a background (async_launched) spawn too", () => {
    const session = linked(resultOf({ status: "async_launched", agentId: "run1" }));
    expect(session.agents[0]?.spawnToolUseId).toBe("toolu_1");
  });

  // Covers: R17
  it("links nothing for a call a hook denied (string result) or for another run id", () => {
    expect(
      linked(resultOf("PreToolUse:Agent hook error: plan-gate")).agents[0]?.spawnToolUseId,
    ).toBeUndefined();
    expect(linked(resultOf({ agentId: "other" })).agents[0]?.spawnToolUseId).toBeUndefined();
  });

  // Covers: R17
  it("ignores a non-Agent tool result and never links a nested run", () => {
    expect(
      linked(resultOf({ agentId: "run1" }), { toolName: "Bash" }).agents[0]?.spawnToolUseId,
    ).toBeUndefined();
    const nested = linked(resultOf({ agentId: "run1" }), { meta: { spawnDepth: 2 } });
    expect(nested.agents[0]?.spawnToolUseId).toBeUndefined();
  });
});

describe("Codex discovered usage ownership (spec 0042 T6)", () => {
  const dirs: string[] = [];
  const SECRET = "SYNTHETIC-USAGE-HISTORY-SECRET";
  const ROOT = "usage-root";
  const CHILD = "usage-child";
  const TS = "2026-10-03T03:11:18.000Z";
  type Row = { type: string; payload: Record<string, unknown>; timestamp?: string };
  let checkout: string | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    checkout = undefined;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Complete synthetic TokenUsage snapshots have no response or sequence ownership. */
  function counter(total: number): Record<string, number> {
    return {
      input_tokens: total,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: total,
    };
  }

  /** Pinned TokenUsageRecord identities survive physical copies and inherited history. */
  function response(thread: string, output = 40): Row {
    return {
      type: "token_usage_record",
      timestamp: TS,
      payload: {
        thread_id: thread,
        session_id: ROOT,
        turn_id: `${thread}-turn`,
        root_turn_id: `${ROOT}-turn`,
        response_id: `${thread}-response`,
        usage: {
          input_tokens: 100,
          cached_input_tokens: 20,
          cache_write_input_tokens: 10,
          output_tokens: output,
          reasoning_output_tokens: 15,
          total_tokens: 100 + output,
        },
        turn_token_usage: counter(9999),
        thread_token_usage: counter(99999),
      },
    };
  }

  /** Read private synthetic markers through discovery and the command's parser projection. */
  function discovered(
    rootRows: Row[],
    childRows: Row[],
    childHeader: Record<string, unknown> = {},
  ): SessionAudit {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "audit-usage-lineage-")));
    dirs.push(dir);
    const cwd = (checkout ??= join(dir, "work"));
    mkdirSync(join(cwd, ".git"), { recursive: true, mode: 0o700 });
    const store = join(dir, "audit");
    const codex = join(dir, "codex");
    mkdirSync(join(store, "fixture"), { recursive: true, mode: 0o700 });
    mkdirSync(join(codex, "sessions"), { recursive: true, mode: 0o700 });
    vi.stubEnv("NAVORI_AUDITS_ROOT", store);
    vi.stubEnv("CODEX_HOME", codex);
    const header = (thread: string): Record<string, unknown> => ({
      id: thread,
      session_id: ROOT,
      cli_version: "0.160.0",
      cwd,
      timestamp: TS,
      base_instructions: SECRET,
      ...(thread === CHILD
        ? {
            parent_thread_id: ROOT,
            source: { subagent: { thread_spawn: { parent_thread_id: ROOT } } },
            forked_from_id: ROOT,
            ...childHeader,
          }
        : { source: "cli" }),
    });
    const rootPath = join(codex, "sessions", "root.jsonl");
    const childPath = join(codex, "sessions", "child.jsonl");
    for (const [thread, path, rows] of [
      [ROOT, rootPath, rootRows],
      [CHILD, childPath, childRows],
    ] as const)
      writeFileSync(
        path,
        [{ type: "session_meta", timestamp: TS, payload: header(thread) }, ...rows]
          .map((row) => JSON.stringify(row))
          .join("\n") + "\n",
        { mode: 0o600 },
      );
    const identity = normalizeCodexIdentity({ ...header(CHILD), parent_thread_id: ROOT }, cwd);
    assert(identity.status === "verified");
    const log = join(store, "fixture", `session-${ROOT}.log`);
    writeFileSync(
      log,
      [
        { event: "start", ts: TS, host: "codex", sessionId: ROOT, cwd, transcript: rootPath },
        ...[TS, "2026-10-03T03:12:18.000Z"].map((observedAt) => ({
          event: "child-source",
          schemaVersion: 1,
          host: "codex",
          rootSessionId: ROOT,
          threadId: CHILD,
          parentThreadId: ROOT,
          sourceVersion: "0.160.0",
          sourcePath: childPath,
          sourceHeaderFingerprint: codexIdentityFingerprint(identity.identity),
          observedAt,
        })),
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
      { mode: 0o600 },
    );
    const marker = findMarkedSessions("fixture", { session: ROOT })[0];
    assert(marker?.sourceStatus === "verified");
    const parsed = parseCodexSession(ROOT, marker.logFile, marker.rollout, undefined, {
      records: marker.auditLogRecords ?? [],
      reading: marker.auditReading,
      normalizationLoss: marker.auditNormalizationLoss,
      budget: marker.readBudget ?? createAuditReadBudget(),
      children: marker.childSources ?? [],
    });
    assert(parsed);
    return parsed;
  }

  // Covers: R4, R5
  it.each([false, true])(
    "deduplicates discovered root/fork/resume physical copies: reverse=%s",
    (reverse) => {
      const inherited = response(ROOT);
      const own = response(CHILD);
      const history: Row = {
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: SECRET }] },
      };
      const rootTurn: Row = {
        type: "event_msg",
        payload: { type: "task_started", turn_id: `${ROOT}-turn` },
      };
      const childTurn: Row = {
        type: "event_msg",
        payload: { type: "task_started", turn_id: `${CHILD}-turn` },
      };
      const resume: Row = {
        type: "event_msg",
        payload: {
          type: "collab_resume_begin",
          call_id: "resume-call",
          sender_thread_id: ROOT,
          receiver_thread_id: CHILD,
        },
      };
      const sessions = [
        discovered(
          [rootTurn, inherited, own, resume],
          [history, rootTurn, inherited, childTurn, own, own],
        ),
        discovered(
          [rootTurn, inherited, own, resume],
          [history, rootTurn, inherited, childTurn, own],
        ),
      ];
      if (reverse) sessions.reverse();
      for (const parsed of sessions) {
        expect(parsed.agents).toHaveLength(1);
        expect(parsed.agents[0]?.turns).toBe(1);
        expect(parsed.orchestrator.turns).toBe(1);
        expect(parsed.agents[0]?.codex?.responses.every((row) => row.threadId === CHILD)).toBe(
          true,
        );
      }
      expect(sessions.map((parsed) => parsed.agents[0]?.codex?.responses.length).sort()).toEqual([
        1, 2,
      ]);
      const report = buildReport(sessions, { repo: "r", version: "0", catalog: EMPTY_CATALOG });
      expect(publishReport(report).totals.tokens).toMatchObject({
        input: 140,
        cacheRead: 40,
        cacheCreation: 20,
        output: 80,
        thinking: 30,
      });
      expect(report.sessions[0]?.agents[0]?.codex?.usage.totalTokens).toBe(140);
      expect(report.sessions[0]?.orchestrator.codex?.usage.totalTokens).toBe(140);
      expect(renderJson(report)).not.toContain(SECRET);
      expect(renderMarkdown(report, "en")).not.toContain(SECRET);
      expect(renderJson(report)).not.toContain(`${CHILD}-response`);
    },
  );

  // Covers: R4, R5
  it.each([false, true])(
    "retains new owned execution after resume across discovered historical copies: reverse=%s",
    (reverse) => {
      const inherited = response(ROOT);
      const beforeResponse = response(CHILD);
      const resumedAt = "2026-10-03T03:12:18.000Z";
      const afterResponse: Row = {
        ...response(CHILD),
        timestamp: "2026-10-03T03:13:18.000Z",
        payload: {
          ...response(CHILD).payload,
          turn_id: `${CHILD}-resumed-turn`,
          response_id: `${CHILD}-resumed-response`,
        },
      };
      const rootTurn: Row = {
        type: "event_msg",
        timestamp: TS,
        payload: { type: "task_started", turn_id: `${ROOT}-turn` },
      };
      const beforeTurn: Row = {
        type: "event_msg",
        timestamp: TS,
        payload: { type: "task_started", turn_id: `${CHILD}-turn` },
      };
      const afterTurn: Row = {
        type: "event_msg",
        timestamp: afterResponse.timestamp,
        payload: { type: "task_started", turn_id: `${CHILD}-resumed-turn` },
      };
      const resume: Row = {
        type: "event_msg",
        timestamp: resumedAt,
        payload: {
          type: "collab_resume_begin",
          call_id: "new-execution-resume",
          sender_thread_id: ROOT,
          receiver_thread_id: CHILD,
        },
      };
      const before = discovered([rootTurn, inherited], [beforeTurn, beforeResponse]);
      const after = discovered(
        [rootTurn, inherited, resume],
        [rootTurn, inherited, beforeTurn, beforeResponse, resume, afterTurn, afterResponse],
      );
      expect(before.agents[0]?.turns).toBe(1);
      expect(after.agents[0]?.turns).toBe(2);
      expect(after.agents[0]?.codex?.responses.map((row) => row.responseId)).toEqual([
        `${CHILD}-response`,
        `${CHILD}-resumed-response`,
      ]);
      expect(after.agents[0]?.codex?.responses.every((row) => row.threadId === CHILD)).toBe(true);
      expect(
        after.agents[0]?.codex?.responses.reduce(
          (sum, row) => sum + (row.values.totalTokens ?? 0),
          0,
        ),
      ).toBe(280);
      expect(after.orchestrator.turns).toBe(1);
      const sessions = reverse ? [after, before] : [before, after];
      const report = buildReport(sessions, { repo: "r", version: "0", catalog: EMPTY_CATALOG });
      const published = publishReport(report);
      const resumedIndex = reverse ? 0 : 1;
      expect(report.sessions[resumedIndex]?.agents[0]?.turns).toBe(reverse ? 2 : 1);
      expect(report.sessions[resumedIndex]?.agents[0]?.codex?.usage.totalTokens).toBe(
        reverse ? 280 : 140,
      );
      expect(published.sessions[resumedIndex]?.agents[0]?.turns).toBe(reverse ? 2 : 1);
      expect(published.totals.tokens).toEqual({
        input: 210,
        cacheRead: 60,
        cacheCreation: 30,
        output: 120,
        thinking: 45,
      });
      expect(
        report.sessions.reduce((sum, session) => sum + (session.agents[0]?.turns ?? 0), 0),
      ).toBe(2);
      expect(
        published.sessions.reduce((sum, session) => sum + (session.agents[0]?.turns ?? 0), 0),
      ).toBe(2);
      expect(
        report.sessions.reduce(
          (sum, session) =>
            sum +
            (session.orchestrator.codex?.usage.totalTokens ?? 0) +
            (session.agents[0]?.codex?.usage.totalTokens ?? 0),
          0,
        ),
      ).toBe(420);
      const rendered = JSON.parse(renderJson(report)) as typeof published;
      expect(rendered.totals.tokens).toEqual(published.totals.tokens);
      expect(
        rendered.sessions.reduce((sum, session) => sum + (session.agents[0]?.turns ?? 0), 0),
      ).toBe(2);
      const markdown = renderMarkdown(report, "en");
      expect(
        [...markdown.matchAll(/^Turns: (\d+)$/gm)].reduce(
          (sum, match) => sum + Number(match[1]),
          0,
        ),
      ).toBe(3);
      expect(
        [...markdown.matchAll(/ · total (\d+) · reasoning subset/g)].reduce(
          (sum, match) => sum + Number(match[1]),
          0,
        ),
      ).toBe(420);
      expect(renderJson(report)).not.toContain(`${CHILD}-resumed-response`);
      expect(markdown).not.toContain(`${CHILD}-resumed-response`);
    },
  );

  // Covers: R4, R5
  it.each([false, true])(
    "withholds conflicting amounts across parsed source copies: reverse=%s",
    (reverse) => {
      const sessions = [
        discovered([response(ROOT)], [response(CHILD)]),
        discovered([response(ROOT)], [response(CHILD, 60)]),
      ];
      if (reverse) sessions.reverse();
      const report = buildReport(sessions, { repo: "r", version: "0", catalog: EMPTY_CATALOG });
      expect(publishReport(report).totals.tokens.output).toBe(40);
      expect(publishReport(report).totals.tokens.input).toBe(140);
      expect(report.availability?.["tokens.output"]).toMatchObject({
        state: "partial",
        contributors: 1,
      });
      expect(report.sessions[0]?.agents[0]?.codex?.usageAvailability.output).toMatchObject({
        state: "invalid",
        reason: "identity-conflict",
      });
      for (const parsed of report.sessions)
        expect(parsed.agents[0]?.codex?.usage.output).toBeNull();
    },
  );

  // Covers: R4, R5
  it("keeps absent raw cache-write unavailable in the pinned adapter", () => {
    const row = response(CHILD);
    const usage = row.payload.usage as Record<string, unknown>;
    delete usage.cache_write_input_tokens;
    const parsed = discovered([response(ROOT)], [row]);
    const report = buildReport([parsed], { repo: "r", version: "0", catalog: EMPTY_CATALOG });
    expect(report.sessions[0]?.agents[0]?.codex?.usage.cacheWrite).toBeNull();
    expect(report.sessions[0]?.agents[0]?.codex?.usageAvailability.cacheWrite).toMatchObject({
      state: "unavailable",
      reason: "not-observed",
    });
    expect(publishReport(report).sessions[0]?.agents[0]?.tokens.cacheCreation).toBeNull();
  });

  // Covers: R4, R5
  it.each(["thread_id", "turn_id", "response_id"])(
    "excludes usage without required %s ownership",
    (field) => {
      const row = response(CHILD);
      delete row.payload[field];
      const report = buildReport([discovered([], [row])], {
        repo: "r",
        version: "0",
        catalog: EMPTY_CATALOG,
      });
      expect(publishReport(report).totals.tokens.output).toBeNull();
      expect(report.sessions[0]?.agents[0]?.codex?.responses).toEqual([]);
      expect(report.sessions[0]?.agents[0]?.codex?.usageAvailability.output.state).toBe(
        "unavailable",
      );
    },
  );

  // Covers: R4, R5
  it("rejects ambiguous child lineage without attributing response usage", () => {
    const parsed = discovered([], [response(CHILD)], { parent_thread_id: "different-parent" });
    const report = buildReport([parsed], { repo: "r", version: "0", catalog: EMPTY_CATALOG });
    expect(publishReport(report).totals.tokens.output).toBeNull();
    expect(parsed.agents[0]?.codex?.source).toMatchObject({
      state: "unavailable",
      reason: "identity-conflict",
    });
  });

  // Covers: R4, R5
  it.each([false, true])(
    "never imputes opening balance or adds unowned cumulative resets: response=%s",
    (hasResponse) => {
      const snapshots: Row[] = [900, 1000, 20, 50].map((total_tokens) => ({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: counter(total_tokens), last_token_usage: counter(10) },
        },
      }));
      const parsed = discovered([], [...snapshots, ...(hasResponse ? [response(CHILD)] : [])]);
      const report = buildReport([parsed], { repo: "r", version: "0", catalog: EMPTY_CATALOG });
      expect(publishReport(report).totals.tokens.output).toBe(hasResponse ? 40 : null);
      expect(report.sessions[0]?.agents[0]?.codex?.usage.totalTokens).toBe(
        hasResponse ? 140 : null,
      );
      expect(report.sessions[0]?.agents[0]?.codex?.responses).toHaveLength(hasResponse ? 1 : 0);
    },
  );
});

describe("parse: Codex rollout adapter (spec 0041 T18)", () => {
  const SECRET = "SYNTHETIC-SECRET-do-not-leak-7f3a";
  const SID = "01a10108-38f8-7470-ae6a-fbec838f6c4c";

  /** Synthetic, 0.160.0-shaped rollout (key names only match a real one). */
  function rolloutLines(): string[] {
    const rec = (timestamp: string, type: string, payload: Record<string, unknown>, ordinal = 0) =>
      JSON.stringify({ ordinal, timestamp, type, payload });
    return [
      rec("2026-10-03T03:11:18.000Z", "session_meta", {
        id: SID,
        session_id: SID,
        cli_version: "0.160.0",
        cwd: "/work/repo",
        base_instructions: SECRET,
      }),
      rec("2026-10-03T03:11:19.000Z", "event_msg", { type: "task_started", turn_id: "t1" }),
      rec("2026-10-03T03:11:19.500Z", "turn_context", {
        turn_id: "t1",
        model: "gpt-5.5",
        cwd: "/work/repo",
      }),
      rec("2026-10-03T03:11:19.600Z", "event_msg", {
        type: "item_started",
        thread_id: SID,
        turn_id: "t1",
        item: { type: "CommandExecution", id: "c1" },
        started_at_ms: 1790997079600,
      }),
      rec("2026-10-03T03:11:19.700Z", "event_msg", {
        type: "collab_agent_interaction_begin",
        call_id: "c2",
        sender_thread_id: SID,
      }),
      rec("2026-10-03T03:11:20.000Z", "response_item", {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: SECRET }],
      }),
      rec("2026-10-03T03:11:21.000Z", "response_item", {
        type: "custom_tool_call",
        name: "exec",
        call_id: "c1",
        input: `echo ${SECRET}`,
      }),
      rec("2026-10-03T03:11:22.000Z", "response_item", {
        type: "custom_tool_call_output",
        call_id: "c1",
        output: SECRET,
      }),
      rec("2026-10-03T03:11:23.000Z", "response_item", {
        type: "function_call",
        name: "send_message",
        call_id: "c2",
        arguments: JSON.stringify({ message: SECRET }),
      }),
      rec("2026-10-03T03:11:24.000Z", "event_msg", { type: "task_complete", turn_id: "t1" }),
    ];
  }

  function fixture(rollout: string | null): { log: string; rollout: string | null } {
    const dir = mkdtempSync(join(tmpdir(), "navori-codex-rollout-"));
    const log = join(dir, `session-${SID}.log`);
    writeFileSync(
      log,
      `${JSON.stringify({ ts: "2026-10-03T03:11:17.000Z", event: "start", host: "codex", cwd: "/work/repo" })}\n`,
    );
    if (rollout === null) return { log, rollout: null };
    const file = join(dir, `rollout-2026-10-03T03-11-18-${SID}.jsonl`);
    writeFileSync(file, rollout);
    return { log, rollout: file };
  }

  // Covers: R24
  it("parses a 0.160.0-shaped rollout into a Codex session identified by engine", () => {
    const { log, rollout } = fixture(`${rolloutLines().join("\n")}\n`);
    const session = parseCodexSession(SID, log, rollout);
    expect(session?.host).toBe("codex");
    expect(session?.rollout).toMatchObject({
      status: "parsed",
      cliVersion: "0.160.0",
      turns: 1,
      toolCalls: { exec: 1, send_message: 1 },
      models: { "gpt-5.5": 1 },
    });
    expect(session?.orchestrator.turns).toBe(1);
    expect(session?.unavailable).toBe("transcript");
  });

  // Covers: R4, R5
  it("deduplicates response usage without adding cumulative snapshots or default-zero subsets", () => {
    const usage = JSON.stringify({
      type: "token_usage_record",
      timestamp: "2026-10-03T03:11:23.000Z",
      payload: {
        thread_id: SID,
        session_id: SID,
        turn_id: "t1",
        response_id: "response-private",
        usage: {
          input_tokens: 100,
          cached_input_tokens: 20,
          cache_write_input_tokens: 10,
          output_tokens: 40,
          reasoning_output_tokens: 15,
          total_tokens: 140,
        },
        turn_token_usage: { total_tokens: 9999 },
        thread_token_usage: { total_tokens: 99999 },
      },
    });
    const snapshot = JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { total_tokens: 50000 },
          last_token_usage: { total_tokens: 50000 },
        },
      },
    });
    const { log, rollout } = fixture(
      `${[...rolloutLines(), usage, usage, snapshot, snapshot].join("\n")}\n`,
    );
    const parsed = parseCodexSession(SID, log, rollout)!;
    const before = JSON.stringify(parsed);
    const report = buildReport([parsed], {
      repo: "r",
      version: "0",
      catalog: { agents: [], skills: [], hooks: [] } as unknown as HarnessCatalog,
    });
    expect(report.totals.tokens).toMatchObject({
      input: 70,
      cacheRead: 20,
      cacheCreation: 10,
      output: 40,
      thinking: 15,
    });
    expect(report.sessions[0]?.orchestrator.codex?.usage).toMatchObject({
      inputTotal: 100,
      totalTokens: 140,
    });
    expect(JSON.stringify(parsed)).toBe(before);
    expect(JSON.stringify(publishReport(report))).not.toContain("response-private");
    expect(renderMarkdown(report, "en")).toContain(
      "input 100 · ordinary input 70 · output 40 · total 140",
    );
  });

  // Covers: R4, R5
  it("retains unknown unowned activity instead of qualifying copied tool and turn rows", () => {
    const lines = rolloutLines().filter(
      (line) => !line.includes("item_started") && !line.includes("collab_agent_interaction_begin"),
    );
    const { log, rollout } = fixture(`${lines.join("\n")}\n`);
    const parsed = parseCodexSession(SID, log, rollout)!;
    const report = buildReport([parsed], {
      repo: "r",
      version: "0",
      catalog: { agents: [], skills: [], hooks: [] } as unknown as HarnessCatalog,
    });
    expect(parsed.availability?.tools).toMatchObject({
      state: "unavailable",
      reason: "ownership-unknown",
    });
    expect(publishReport(report).sessions[0]?.orchestrator.toolCounts).toBeNull();
    expect(publishReport(report).sessions[0]?.orchestrator.turns).toBeNull();
  });

  // Covers: R4, R5
  it.each([false, true])(
    "does not charge conflicting response copies in either order: reverse=%s",
    (reverse) => {
      const responses = [40, 60].map((output) =>
        JSON.stringify({
          type: "token_usage_record",
          payload: {
            thread_id: SID,
            session_id: SID,
            turn_id: "t1",
            response_id: "conflict",
            usage: {
              input_tokens: 100,
              cached_input_tokens: 20,
              cache_write_input_tokens: 10,
              output_tokens: output,
              total_tokens: 100 + output,
              reasoning_output_tokens: 15,
            },
          },
        }),
      );
      if (reverse) responses.reverse();
      const { log, rollout } = fixture(`${[...rolloutLines(), ...responses].join("\n")}\n`);
      const report = buildReport([parseCodexSession(SID, log, rollout)!], {
        repo: "r",
        version: "0",
        catalog: { agents: [], skills: [], hooks: [] } as unknown as HarnessCatalog,
      });
      const published = publishReport(report);
      expect(published.totals.tokens.output).toBeNull();
      expect(published.totals.tokens.input).toBe(70);
      expect(report.sessions[0]?.orchestrator.codex?.usageAvailability.output).toMatchObject({
        state: "invalid",
        reason: "identity-conflict",
      });
      expect(report.availability?.["tokens.output"]?.contributors).toBe(0);
    },
  );

  // Covers: R4, R5
  it.each([0, 100])(
    "distinguishes provider-default zero subsets from mathematically constrained zero input=%s",
    (input) => {
      const response = JSON.stringify({
        type: "token_usage_record",
        payload: {
          thread_id: SID,
          session_id: SID,
          turn_id: "t1",
          response_id: "zero-subsets",
          usage: {
            input_tokens: input,
            output_tokens: input,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens: 2 * input,
          },
        },
      });
      const { log, rollout } = fixture(`${[...rolloutLines(), response].join("\n")}\n`);
      const report = buildReport([parseCodexSession(SID, log, rollout)!], {
        repo: "r",
        version: "0",
        catalog: { agents: [], skills: [], hooks: [] } as unknown as HarnessCatalog,
      });
      const published = publishReport(report);
      expect(published.totals.tokens.cacheRead).toBe(input === 0 ? 0 : null);
      expect(published.totals.tokens.thinking).toBe(input === 0 ? 0 : null);
      expect(report.availability?.["tokens.cacheRead"]?.contributors).toBe(input === 0 ? 1 : 0);
      expect(report.sessions[0]?.orchestrator.codex?.usage.inputTotal).toBe(input);
    },
  );

  // Covers: R4, R5, R9
  it("withholds amounts with contradictory response root ownership rather than repairing the IDs", () => {
    const response = JSON.stringify({
      type: "token_usage_record",
      payload: {
        thread_id: SID,
        session_id: "different-root",
        turn_id: "t1",
        response_id: "wrong-root-response",
        usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140 },
      },
    });
    const { log, rollout } = fixture(`${[...rolloutLines(), response].join("\n")}\n`);
    const parsed = parseCodexSession(SID, log, rollout)!;
    expect(parsed.sources?.rollout).toMatchObject({
      state: "invalid",
      reason: "identity-conflict",
    });
    const report = buildReport([parsed], {
      repo: "r",
      version: "0",
      catalog: { agents: [], skills: [], hooks: [] } as unknown as HarnessCatalog,
    });
    expect(publishReport(report).totals.tokens.output).toBeNull();
    expect(report.availability?.["tokens.output"]?.contributors).toBe(0);
  });

  // Covers: R3
  it("accepts a hostless historical start only with verified recovery supplied", () => {
    const { log, rollout } = fixture(`${rolloutLines().join("\n")}\n`);
    const original = readFileSync(log, "utf-8").replace(',"host":"codex"', "");
    writeFileSync(log, original);
    expect(parseCodexSession(SID, log, rollout)).toBeNull();
    expect(parseCodexSession(SID, log, rollout, "recovered:rollout")?.host).toBe("codex");
    expect(readFileSync(log, "utf-8")).toBe(original);
  });

  // Covers: R24
  it("never lets raw message, tool input or output text reach the session or the report", () => {
    const { log, rollout } = fixture(`${rolloutLines().join("\n")}\n`);
    const session = parseCodexSession(SID, log, rollout);
    assert(session);
    expect(JSON.stringify(session)).not.toContain(SECRET);
    const catalog = { agents: [], skills: [], hooks: [] } as unknown as HarnessCatalog;
    const report = buildReport([session], { repo: "r", version: "0", catalog });
    for (const lang of ["es", "en"] as const) {
      const md = renderMarkdown(report, lang);
      expect(md).not.toContain(SECRET);
      expect(md).toContain("Codex 0.160.0");
    }
  });

  // Covers: R24
  it("reports the rollout as unavailable, without throwing, when missing or unreadable", () => {
    const none = fixture(null);
    expect(parseCodexSession(SID, none.log, null)?.rollout).toEqual({
      status: "unavailable",
      reason: "missing",
    });
    const missing = parseCodexSession(SID, none.log, "/nonexistent/rollout.jsonl")?.rollout;
    expect(missing).toMatchObject({
      status: "unavailable",
      reason: "missing",
    });
    expect(missing?.health).toMatchObject({
      source: "rollout",
      state: "unavailable",
      reason: "missing",
      reading: { sourceStatus: "unavailable", reason: "missing" },
    });
    const dirAsFile = fixture(null);
    const unreadable = parseCodexSession(SID, dirAsFile.log, join(dirAsFile.log, ".."))?.rollout;
    expect(unreadable).toMatchObject({
      status: "unavailable",
      reason: "unreadable",
    });
    expect(unreadable?.health).toMatchObject({
      source: "rollout",
      state: "invalid",
      reason: "unreadable",
      reading: { sourceStatus: "invalid", reason: "unsafe" },
    });
    const garbage = fixture(`not json ${SECRET}\n{broken\n`);
    const parsed = parseCodexSession(SID, garbage.log, garbage.rollout);
    expect(parsed?.rollout).toMatchObject({ status: "unavailable", reason: "unreadable" });
    expect(parsed?.sources?.rollout).toMatchObject({
      state: "invalid",
      reason: "malformed",
      parseErrors: 2,
    });
    expect(JSON.stringify(parsed)).not.toContain(SECRET);
  });
});

describe("idle between turns (spec 0042 T10b, M4)", () => {
  const at = (sec: number): string => new Date(Date.UTC(2026, 8, 1, 0, 0, sec)).toISOString();
  const typed = (sec: number) => ({
    type: "user",
    promptSource: "typed",
    timestamp: at(sec),
    message: { content: "SYNTHETIC-PROMPT-SECRET" },
  });
  const record = (type: string, sec: number, extra: object = {}) => ({
    type,
    timestamp: at(sec),
    ...extra,
  });
  const ms = (sec: number): number => Date.parse(at(sec));
  const window = (from: number, to: number): AgentRun =>
    ({ startedAt: at(from), endedAt: at(to) }) as AgentRun;

  // Covers: R18
  it("is the gap from the last main-thread record to the next typed prompt", () => {
    const lines = [
      typed(0),
      record("assistant", 5),
      record("user", 6),
      typed(20),
      record("assistant", 22),
      typed(30),
    ];
    expect(idleBetweenTurns(lines, [])).toEqual([
      [ms(6), ms(20)],
      [ms(22), ms(30)],
    ]);
  });

  // Covers: R18
  it("has no gap for consecutive typed prompts, a first prompt or sidechain records", () => {
    expect(idleBetweenTurns([typed(0), typed(5)], [])).toEqual([]);
    expect(idleBetweenTurns([record("assistant", 1, { isSidechain: true }), typed(9)], [])).toEqual(
      [],
    );
    // Bookkeeping records between turns are not the end of the turn.
    expect(
      idleBetweenTurns([record("assistant", 2), record("permission-mode", 8), typed(10)], []),
    ).toEqual([[ms(2), ms(10)]]);
  });

  // Covers: R18
  it("subtracts the time a subagent was running in the background", () => {
    expect(idleBetweenTurns([record("assistant", 0), typed(30)], [window(5, 25)])).toEqual([
      [ms(0), ms(5)],
      [ms(25), ms(30)],
    ]);
  });

  // Covers: R18
  it("is carried by a parsed Claude session and never holds prompt content", () => {
    const s = parseSession(FIXTURE);
    expect(Array.isArray(s.idleBetweenTurns)).toBe(true);
    expect(JSON.stringify(s.idleBetweenTurns)).not.toMatch(/[a-z]/i);
  });
});

describe("parse: Claude 2.1.29x transcripts clip content without losing measurements", () => {
  const usage = (n: number): Record<string, number> => ({
    input_tokens: n,
    output_tokens: 1,
    cache_read_input_tokens: 10 * n,
    cache_creation_input_tokens: 0,
  });

  // Covers: R6, R21
  it("clips display text silently but still counts a clipped technical key", () => {
    const long = "x".repeat(5000);
    const text = normalizeAuditRecord({ type: "assistant", text: long }, "transcript");
    expect(text.omitted).toBe(0);
    expect(text.value).toMatchObject({ type: "assistant", text: "" });
    const lines = normalizeAuditRecord(
      { type: "attachment", lines: Array(300).fill("a") },
      "transcript",
    );
    expect(lines.omitted).toBe(0);
    const technical = normalizeAuditRecord({ type: "assistant", model: long }, "transcript");
    expect(technical.omitted).toBeGreaterThan(0);
    const blocks = normalizeAuditRecord(
      { type: "assistant", message: { content: Array(200).fill({ type: "text" }) } },
      "transcript",
    );
    expect(blocks.omitted).toBeGreaterThan(0);
  });

  // Covers: R6, R21
  it("keeps usage and tool_use name/id of an over-cap assistant record", () => {
    const record = {
      type: "assistant",
      timestamp: "2026-10-05T10:00:00.000Z",
      diagnostics: Object.fromEntries(
        Array.from({ length: 100 }, (_, i) => [`k${i}`, "y".repeat(60)]),
      ),
      message: {
        id: "msg_1",
        model: "m",
        usage: usage(7),
        content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }],
      },
    };
    expect(Buffer.byteLength(JSON.stringify(record))).toBeGreaterThan(
      AUDIT_READ_LIMITS.normalizedFactBytes,
    );
    const { value, omitted } = normalizeAuditRecord(record, "transcript");
    expect(omitted).toBe(0);
    expect(value).toMatchObject({
      message: { id: "msg_1", usage: usage(7), content: [{ name: "Bash", id: "toolu_1" }] },
    });
    expect(normalizeAuditRecord(record, "audit-log").value).toBeNull();
  });
});
