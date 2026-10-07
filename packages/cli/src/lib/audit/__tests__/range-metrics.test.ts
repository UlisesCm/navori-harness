import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildReport, publishReport, renderMarkdown } from "../report.ts";
import { attachHookEvents, parseCodexSession, parseSession } from "../parse.ts";
import { createAuditReadBudget, type AuditReadBudget } from "../model.ts";
import type { HarnessCatalog } from "../harness.ts";
import { agent as unmeasuredAgent, session as unmeasuredSession } from "./lifecycle-fixtures.ts";
import type { AgentRun, SessionAudit, MetricEvidence, HookEvent } from "../model.ts";

// These report fixtures intentionally supply measured counters, including explicit zeros.
// Parser-created sessions below keep their real source evidence instead of inheriting this fixture.
const transcriptEvidence: MetricEvidence = {
  state: "observed",
  reason: null,
  source: "transcript",
  adapter: "claude-transcript",
  sourceVersion: null,
};
const hookEvidence: MetricEvidence = {
  ...transcriptEvidence,
  source: "audit-log",
  adapter: "audit-log",
};
const measuredAvailability: Record<string, MetricEvidence> = Object.fromEntries(
  [
    "tools",
    "contextPeak",
    "startupTokens",
    "durationMs",
    "tokens.input",
    "tokens.output",
    "tokens.cacheRead",
    "tokens.cacheCreation",
    "tokens.thinking",
  ].map((key) => [key, transcriptEvidence]),
);
measuredAvailability.hooks = hookEvidence;

/** Build an explicitly measured Claude report fixture, not a parser fallback. */
function session(over: Partial<SessionAudit> = {}): SessionAudit {
  return unmeasuredSession({
    availability: { ...measuredAvailability },
    ...over,
  });
}

/** Each synthesized child supplies the same explicit measured fixture provenance. */
function agent(over: Partial<AgentRun> = {}): AgentRun {
  return unmeasuredAgent({
    availability: { ...measuredAvailability },
    ...over,
  });
}

const CATALOG: HarnessCatalog = {
  agents: [
    { name: "implementer", tools: null, hasMcp: true },
    { name: "reviewer", tools: null, hasMcp: true },
  ],
  skills: [],
  managedSkills: [],
  sections: [],
  claudeMdTokens: 0,
  mcpFamilies: [],
};

function report(sessions: ReturnType<typeof session>[]) {
  return buildReport(sessions, {
    repo: "demo",
    version: "0.11.0",
    catalog: CATALOG,
  });
}

function writeLines(dir: string, name: string, lines: unknown[]): string {
  const file = join(dir, name);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
  return file;
}

describe("range metrics: published flat under schemaVersion 11", () => {
  // Covers: R6
  it("keeps unmeasured legacy fixture counters distinct from explicitly measured zeros", () => {
    const unavailable = report([unmeasuredSession()]);
    const observedZero = report([session()]);
    expect(unavailable.rangeMetrics["hooks.ms"]).toBeNull();
    expect(unavailable.rangeMetrics["edits.calls"]).toBeNull();
    expect(observedZero.rangeMetrics["hooks.ms"]).toBe(0);
    expect(observedZero.rangeMetrics["edits.calls"]).toBe(0);
  });
  // Covers: R15
  it("separates hook work from concurrent observable toll and sequential phases", () => {
    const event = (name: string, phase: string, ms: number, toolUseId = "call-1"): HookEvent => ({
      ts: "2026-09-30T10:00:00Z",
      name,
      phase,
      verdict: "allow",
      ms,
      source: "core",
      tool: "Bash",
      toolUseId,
    });
    const s = session({
      agents: [
        agent({
          hookEvents: [event("first", "PreToolUse", 100), event("second", "PreToolUse", 100)],
        }),
      ],
    });
    let m = report([s]).rangeMetrics;
    expect(m["hooks.ms"]).toBe(200);
    expect(m["hooks.tollMs"]).toBe(100);
    expect(m["hooks.tollEvents"]).toBe(1);
    s.agents[0]!.hookEvents.push(event("third", "PostToolUse", 50));
    m = report([s]).rangeMetrics;
    expect(m["hooks.ms"]).toBe(250);
    expect(m["hooks.tollMs"]).toBe(150);
    expect(m["hooks.tollEvents"]).toBe(2);
  });

  // Covers: R6, R10, R11, R15
  it("marks uncorrelated hook toll and Codex nested calls unavailable", () => {
    const dir = mkdtempSync(join(tmpdir(), "navori-owned-exec-"));
    const log = writeLines(dir, "session-root.log", [
      { event: "start", host: "codex", sessionId: "root", cwd: "/repo" },
    ]);
    const rollout = writeLines(dir, "rollout.jsonl", [
      {
        type: "session_meta",
        payload: {
          id: "root",
          session_id: "root",
          cli_version: "0.160.0",
          cwd: "/repo",
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_started",
          thread_id: "root",
          turn_id: "turn-1",
          item: { type: "CommandExecution", id: "exec-1" },
        },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "exec-1",
          input: "true",
        },
      },
    ]);
    const codex = parseCodexSession("root", log, rollout)!;
    expect(codex.orchestrator.codex?.source.state).toBe("observed");
    expect(codex.orchestrator.codex?.activity).toContainEqual({
      kind: "tool",
      id: "exec-1",
      name: "exec",
      at: null,
    });
    codex.availability = { ...codex.availability, hooks: hookEvidence };
    codex.orchestrator.hookEvents = [
      {
        ts: "2026-09-30T10:00:00Z",
        name: "guard-destructive",
        phase: "PreToolUse",
        verdict: "allow",
        ms: 100,
        source: "core",
        tool: "Bash",
      },
    ];
    const r = report([codex]);
    expect(r.rangeMetrics["hooks.ms"]).toBe(100);
    expect(r.rangeMetrics["hooks.tollMs"]).toBeNull();
    expect(r.rangeMetrics["hooks.ungroupedFires"]).toBe(1);
    expect(r.rangeMetrics["hooks.bashTranscriptCalls"]).toBeNull();
    expect(r.rangeMetrics["hooks.bashCoveragePct"]).toBeNull();
    expect(r.rangeMetrics["codex.execWrappers"]).toBe(1);
    expect(r.rangeMetrics["codex.nestedToolCalls"]).toBeNull();
    expect(publishReport(r).sessions[0]?.rollout).toMatchObject({ toolCalls: { exec: 1 } });
    expect(renderMarkdown(r, "en")).toContain("Codex exec: 1 wrappers, not internal tools");
    const unavailable = structuredClone(r);
    unavailable.sessions[0]!.availability!.tools = {
      ...transcriptEvidence,
      source: "rollout",
      adapter: "codex-rollout",
      state: "unavailable",
      reason: "ownership-unknown",
    };
    expect(publishReport(unavailable).sessions[0]?.rollout).toMatchObject({
      toolCalls: { exec: null },
    });
    expect(renderMarkdown(unavailable, "en")).toContain(
      "Codex exec: n/d wrappers, not internal tools",
    );
  });

  // Covers: R15
  it("uses Claude transcript Bash calls as the coverage denominator", () => {
    const s = session();
    s.orchestrator.toolCounts = { Bash: 2 };
    s.orchestrator.hookEvents = [
      {
        ts: "2026-09-30T10:00:00Z",
        name: "guard-destructive",
        phase: "PreToolUse",
        verdict: "allow",
        ms: 10,
        source: "core",
        tool: "Bash",
        toolUseId: "call-1",
      },
    ];
    const m = report([s]).rangeMetrics;
    expect(m["hooks.bashTranscriptCalls"]).toBe(2);
    expect(m["hooks.bashCoveragePct"]).toBe(50);
  });
  // Covers: R64, R65
  it("reports per-run turns, context peak and turn-limit hits per agent type", () => {
    const r = report([
      session({
        agents: [
          agent({
            agentId: "a1",
            agentType: "implementer",
            turns: 10,
            turnLimitHit: false,
          }),
          agent({
            agentId: "a2",
            agentType: "implementer",
            turns: 50,
            turnLimitHit: true,
          }),
          agent({
            agentId: "a3",
            agentType: "implementer",
            turns: 20,
            turnLimitHit: false,
          }),
        ],
      }),
    ]);
    expect(r.schemaVersion).toBe(11);
    expect(r.rangeMetrics["agent.implementer.turns.p50"]).toBe(20);
    expect(r.rangeMetrics["agent.implementer.turns.p90"]).toBe(50);
    expect(r.rangeMetrics["agent.implementer.turnLimitHits"]).toBe(1);
    // A declared agent that never ran: zero sessions, but turns UNAVAILABLE.
    expect(r.rangeMetrics["agent.reviewer.sessions"]).toBe(0);
    expect(r.rangeMetrics["agent.reviewer.turns.p90"]).toBeNull();
    expect(r.rangeMetrics["agent.reviewer.turnLimitHits"]).toBeNull();
  });

  // Covers: R65
  it("reports the main-thread context peak and compactions per session", () => {
    const withOrch = (contextPeak: number, compactions: number, id: string) => {
      const s = session({ sessionId: id });
      s.orchestrator.contextPeak = contextPeak;
      s.orchestrator.compactions = compactions;
      s.orchestrator.turns = 7;
      return s;
    };
    const r = report([withOrch(100_000, 1, "s1"), withOrch(300_000, 2, "s2")]);
    expect(r.rangeMetrics["agent.main-thread.contextPeak.p50"]).toBe(100_000);
    expect(r.rangeMetrics["agent.main-thread.contextPeak.p90"]).toBe(300_000);
    expect(r.rangeMetrics["agent.main-thread.compactions"]).toBe(3);
    expect(r.rangeMetrics["agent.main-thread.turns.p50"]).toBe(7);
  });

  // Covers: R64
  it("reports calls split main/subagents and result-size quantiles per tool", () => {
    const s = session({
      agents: [
        agent({
          toolCounts: { codegraph_explore: 2 },
          toolResultBytes: { codegraph_explore: [1000, 9000] },
        }),
      ],
    });
    s.orchestrator.toolCounts = { codegraph_explore: 1 };
    s.orchestrator.toolResultBytes = { codegraph_explore: [4000] };
    const m = report([s]).rangeMetrics;
    expect(m["tool.codegraph_explore.calls"]).toBe(3);
    expect(m["tool.codegraph_explore.callsMain"]).toBe(1);
    expect(m["tool.codegraph_explore.callsAgents"]).toBe(2);
    expect(m["tool.codegraph_explore.resultBytes.p50"]).toBe(4000);
    expect(m["tool.codegraph_explore.resultBytes.p90"]).toBe(9000);
  });

  // Covers: R48
  it("adds a main-thread row with tokens and session counts beside each agent type", () => {
    const s1 = session({
      sessionId: "s1",
      agents: [agent({ agentId: "a1" }), agent({ agentId: "a2" })],
    });
    s1.orchestrator.tokens = {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheCreation: 4,
      thinking: 5,
    };
    const s2 = session({ sessionId: "s2", agents: [agent({ agentId: "a3" })] });
    const { byAgentType } = report([s1, s2]).totals;
    expect(byAgentType["main-thread"]).toMatchObject({
      count: 2,
      sessions: 2,
      tokens: {
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheCreation: 4,
        thinking: 5,
      },
    });
    // Two launches in one session and one in another: count 3, sessions 2.
    expect(byAgentType.reviewer).toMatchObject({ count: 3, sessions: 2 });
  });

  // Covers: R49
  it("counts WebFetch and WebSearch per agent type", () => {
    const s = session({
      agents: [
        agent({
          agentType: "researcher",
          toolCounts: { WebFetch: 3, WebSearch: 1 },
        }),
        agent({
          agentId: "a2",
          agentType: "researcher",
          toolCounts: { WebFetch: 2 },
        }),
      ],
    });
    const r = report([s]);
    expect(r.totals.byAgentType.researcher).toMatchObject({
      webFetch: 5,
      webSearch: 1,
    });
    expect(r.rangeMetrics["agent.researcher.web.fetch"]).toBe(5);
    expect(r.rangeMetrics["agent.researcher.web.search"]).toBe(1);
  });
});

describe("per-task metrics stay out of rangeMetrics (spec 0042 T10b)", () => {
  // Covers: R17, R18
  it("keeps efficiency and lifecycle inside outcomes: no snapshot-comparable per-task key", () => {
    const hex = (c: string): string => c.repeat(64);
    const identity = {
      alg: "navori-content/v1",
      fp: hex("1"),
      base: "b".repeat(40),
      gate: hex("2"),
      inputs: hex("3"),
    };
    const at = Date.parse("2026-09-30T10:00:00Z");
    const s = session({
      cliEvents: [
        {
          tsMs: at,
          event: "cli",
          name: "review-outcome",
          verdict: "approved",
          outcomePayload: {
            name: "review-outcome",
            verdict: "approved",
            schemaVersion: 1,
            featureKey: hex("f"),
            sidecar: hex("5"),
            critical: 0,
            high: 0,
            medium: 0,
            low: 0,
            correlation: "correlated",
            nonce: "00000000-0000-4000-8000-000000000001",
            startedAtMs: at - 1000,
            sealedAtMs: at,
            ...identity,
          },
        },
      ],
    });
    const built = report([s]);
    expect(built.outcomes?.summary).toBeDefined();
    const keys = Object.keys(built.rangeMetrics).concat(Object.keys(built.availability ?? {}));
    expect(
      keys.filter((key) => /task|episode|efficiency|lifecycle|accept|idle|unclassified/i.test(key)),
    ).toEqual([]);
    expect(Object.keys(publishReport(built).rangeMetrics)).toEqual(Object.keys(built.rangeMetrics));
  });
});

describe("parse: transcript measures", () => {
  const dir = mkdtempSync(join(tmpdir(), "navori-range-metrics-"));

  // Covers: R65
  it("counts turns by unique message.id, not by transcript line", () => {
    const usage = (n: number) => ({
      input_tokens: n,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
    });
    const file = writeLines(dir, "turns.jsonl", [
      {
        type: "assistant",
        message: { id: "m1", usage: usage(1), content: [{ type: "thinking" }] },
      },
      {
        type: "assistant",
        message: {
          id: "m1",
          usage: usage(1),
          content: [{ type: "text", text: "x" }],
        },
      },
      {
        type: "assistant",
        message: { id: "m2", usage: usage(100), content: [] },
      },
      { type: "system", subtype: "compact_boundary" },
      { type: "system", subtype: "compact_boundary" },
    ]);
    const s = parseSession(file);
    expect(s.orchestrator.turns).toBe(2);
    // input + cache_read + cache_creation of the heaviest message.
    expect(s.orchestrator.contextPeak).toBe(115);
    expect(s.orchestrator.compactions).toBe(2);
  });

  // Covers: R64
  it("sizes each tool result by the tool that produced it", () => {
    const file = writeLines(dir, "sizes.jsonl", [
      {
        type: "assistant",
        message: {
          id: "m1",
          content: [
            { type: "tool_use", id: "t1", name: "Read", input: {} },
            { type: "tool_use", id: "t2", name: "Read", input: {} },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "12345" },
            {
              type: "tool_result",
              tool_use_id: "t2",
              content: [{ type: "text", text: "ab" }],
            },
          ],
        },
      },
    ]);
    expect(parseSession(file).orchestrator.toolResultBytes).toEqual({
      Read: [5, 2],
    });
  });
});

describe("codex sessions (R71)", () => {
  const dir = mkdtempSync(join(tmpdir(), "navori-codex-"));

  function codexLog(host: string): string {
    return writeLines(dir, `${host}.jsonl`, [
      { ts: "2026-09-30T10:00:00Z", event: "start", host, cwd: "/repo" },
      {
        ts: "2026-09-30T10:00:05Z",
        tsMs: 1_790_000_005_000,
        event: "hook",
        name: "guard-destructive",
        phase: "PreToolUse",
        verdict: "block",
        ms: 12,
        tool: "Bash",
        toolUseId: "call_1",
      },
    ]);
  }

  // Covers: R71
  it("reports hooks and verdicts, and marks the transcript metrics unavailable", () => {
    const codex = parseCodexSession("codex-1", codexLog("codex"));
    expect(codex).not.toBeNull();
    expect(codex?.unavailable).toBe("transcript");
    expect(codex?.orchestrator.turns).toBeNull();
    expect(codex?.orchestrator.contextPeak).toBeNull();
    expect(codex?.orchestrator.compactions).toBeNull();

    const claude = session({ sessionId: "claude-1" });
    claude.orchestrator.turns = 4;
    const r = report([claude, ...(codex ? [codex] : [])]);
    expect(r.totals.sessions).toBe(2);
    expect(r.rangeMetrics["sessions.codex"]).toBe(1);
    expect(r.rangeMetrics["hook.guard-destructive.fires"]).toBe(1);
    expect(r.rangeMetrics["mechanism.guard-destructive.block"]).toBe(1);
    // The main-thread row is measured over the session that HAS a transcript.
    expect(r.totals.byAgentType["main-thread"]?.sessions).toBe(1);
    expect(r.rangeMetrics["agent.main-thread.turns.p50"]).toBe(4);
    expect(renderMarkdown(r, "en")).toContain("Codex session");
    expect(renderMarkdown(r, "es")).toContain("Sesión Codex");
    expect(codex?.availability?.tools?.state).not.toBe("observed");
  });

  // Covers: R71
  it("yields null, not 0, when only Codex sessions are in the range", () => {
    const codex = parseCodexSession("codex-1", codexLog("codex"));
    const r = report(codex ? [codex] : []);
    expect(r.rangeMetrics["sessions.transcript"]).toBe(0);
    expect(r.rangeMetrics["agent.main-thread.turns.p90"]).toBeUndefined();
    expect(r.rangeMetrics["hooks.fires"]).toBe(1);
    expect(r.rangeMetrics["codex.execWrappers"]).toBeNull();
    expect(r.rangeMetrics["codex.nestedToolCalls"]).toBeNull();
    expect(r.totals.byAgentType["main-thread"]).toBeUndefined();
  });

  // Covers: R71
  it("does not invent a Codex session for a log that never declared the host", () => {
    expect(parseCodexSession("claude-1", codexLog("claude"))).toBeNull();
  });
});

describe("range metrics: Claude 2.1.29x window is measured, real loss still is not (spec 0039 R43)", () => {
  const usage = (n: number): Record<string, number> => ({
    input_tokens: n,
    output_tokens: 1,
    cache_read_input_tokens: 100 * n,
    cache_creation_input_tokens: 0,
  });
  /** An assistant record over the 2 KB fact cap: only the skeleton can carry it. */
  const heavy = (id: string, n: number, blocks: unknown[]): Record<string, unknown> => ({
    type: "assistant",
    timestamp: "2026-10-05T10:00:00.000Z",
    diagnostics: Object.fromEntries(
      Array.from({ length: 100 }, (_, k) => [`k${k}`, "y".repeat(60)]),
    ),
    message: { id, model: "m", usage: usage(n), content: blocks },
  });

  /** Three sessions, each with two implementer subagents and Bash calls with hooks. */
  function window(budget?: AuditReadBudget): SessionAudit[] {
    return [0, 1, 2].map((i) => {
      const dir = mkdtempSync(join(tmpdir(), "navori-r43-"));
      const main = writeLines(dir, `s${i}.jsonl`, [
        { type: "mode" },
        { type: "attachment", attachment: { content: "z".repeat(9000) } },
        heavy("m1", 1, [
          { type: "tool_use", id: `bash${i}`, name: "Bash", input: { command: "ls" } },
        ]),
        heavy("m2", 2, [{ type: "tool_use", id: `agent${i}`, name: "Agent" }]),
      ]);
      const subagents = join(dir, `s${i}`, "subagents");
      mkdirSync(subagents, { recursive: true });
      for (const run of ["a", "b"]) {
        writeLines(subagents, `agent-${run}${i}.jsonl`, [
          heavy(`sub-${run}${i}`, 3 + i, [{ type: "text", text: "t".repeat(3000) }]),
        ]);
        writeFileSync(
          join(subagents, `agent-${run}${i}.meta.json`),
          JSON.stringify({ agentType: "implementer", description: "d" }),
        );
      }
      const session = parseSession(main, budget);
      const log = writeLines(dir, `session-s${i}.log`, [
        {
          event: "start",
          sessionId: `s${i}`,
          repo: "demo",
          cwd: "/repo",
          ts: "2026-10-05T10:00:00Z",
        },
        {
          event: "hook",
          ts: "2026-10-05T10:00:01Z",
          name: "guard",
          phase: "PreToolUse",
          verdict: "allow",
          ms: 5,
          source: "core",
          tool: "Bash",
          toolUseId: `bash${i}`,
        },
      ]);
      attachHookEvents(session, log);
      return session;
    });
  }
  const keys = [
    "agent.implementer.launches",
    "agent.implementer.sessions",
    "agent.implementer.cacheRead.p50",
    "hooks.perBashCall",
  ] as const;

  // Covers: R43, R6, R21
  it("measures the R43 metrics when only display content was clipped", () => {
    const budget = createAuditReadBudget();
    const r = buildReport(window(budget), {
      repo: "demo",
      version: "0.11.0",
      catalog: CATALOG,
      readBudget: budget,
    });
    expect(budget.diagnostics.truncated).toBe(false);
    expect(r.rangeMetrics["agent.implementer.launches"]).toBe(6);
    expect(r.rangeMetrics["agent.implementer.sessions"]).toBe(3);
    expect(r.rangeMetrics["agent.implementer.cacheRead.p50"]).toBe(400);
    expect(r.rangeMetrics["hooks.perBashCall"]).toBe(1);
    for (const key of keys) expect(r.availability?.[key]).toMatchObject({ unavailable: 0 });
  });

  // Covers: R43, R6, R21
  it("stays null, never zero, when the read budget genuinely refuses facts", () => {
    const budget = createAuditReadBudget({ factsPerReport: 30 });
    const r = buildReport(window(budget), {
      repo: "demo",
      version: "0.11.0",
      catalog: CATALOG,
      readBudget: budget,
    });
    expect(budget.diagnostics.truncated).toBe(true);
    for (const key of keys) expect(r.rangeMetrics[key]).toBeNull();
  });
});
