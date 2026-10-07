import { describe, it, expect, vi } from "vitest";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { checkReceipt, signReceipt } from "../../diagnose/receipt.ts";
import { createHash } from "node:crypto";
import {
  buildReport,
  publishReport,
  renderJson,
  renderMarkdown,
  weightedTokens,
} from "../report.ts";
import type { HarnessCatalog } from "../harness.ts";
import {
  type AgentRun,
  type AuditReport,
  type HookEvent,
  type InjectedContext,
  type SessionAudit,
  type CodexRunFacts,
  type CodexResponseFact,
  type MetricEvidence,
  type MetricPopulation,
  type CliEvent,
  type ReceiptOutcome,
  type ReviewOutcome,
  emptyOrchestrator,
  emptyPermissionDecisions,
  emptyTokens,
  emptyToolErrors,
  createAuditReadBudget,
  retainAuditFact,
} from "../model.ts";

// Pass-through spies: the outcomes report must never run a check or spawn git.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
    spawnSync: vi.fn(actual.spawnSync),
    execFileSync: vi.fn(actual.execFileSync),
  };
});
vi.mock("../../diagnose/receipt.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../diagnose/receipt.ts")>();
  return {
    ...actual,
    checkReceipt: vi.fn(actual.checkReceipt),
    signReceipt: vi.fn(actual.signReceipt),
  };
});

/** Match an opaque public category while asserting its original label is withheld. */
function opaqueLabel(value: string): string {
  return `unknown-${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

describe("closed miner evidence", () => {
  const evidence: MetricPopulation = {
    state: "partial",
    reason: "incomplete-enumeration",
    source: "transcript",
    adapter: "claude-transcript",
    sourceVersion: null,
    eligible: 1,
    observed: 0,
    partial: 1,
    unavailable: 0,
    unsupported: 0,
    invalid: 0,
    contributors: 1,
  };
  // Covers: R4, R11, R21
  it("accepts actual miner keys and refuses arbitrary/core/coverage evidence overrides", () => {
    const measured = session([]);
    const report = buildReport([measured], {
      repo: "synthetic",
      version: "0",
      catalog: CATALOG,
      extraMetrics: {
        "search.shell": 2,
        "search.good.pct": 100,
        "activation.sessions.graded": 1,
        "search.arbitrary": 9,
        "activation.arbitrary": 9,
        "tokens.input": 999,
        "sessions.total": 999,
        "coverage.pct": 100,
      },
      extraAvailability: Object.fromEntries(
        [
          "search.shell",
          "search.good.pct",
          "activation.sessions.graded",
          "search.arbitrary",
          "activation.arbitrary",
          "tokens.input",
          "sessions.total",
          "coverage.pct",
        ].map((key) => [
          key,
          key.startsWith("search.") || key.startsWith("activation.")
            ? evidence
            : { ...evidence, state: "invalid" as const, eligible: 999 },
        ]),
      ),
    });
    expect(report.rangeMetrics["search.shell"]).toBe(2);
    expect(report.availability?.["search.shell"]?.state).toBe("partial");
    expect(report.rangeMetrics["search.good.pct"]).toBeNull();
    expect(report.rangeMetrics["activation.sessions.graded"]).toBeNull();
    expect(report.rangeMetrics["search.arbitrary"]).toBeUndefined();
    expect(report.rangeMetrics["activation.arbitrary"]).toBeUndefined();
    expect(report.rangeMetrics["sessions.total"]).toBe(1);
    expect(report.availability?.["tokens.input"]?.state).toBe("observed");
    expect(report.availability?.["coverage.pct"]?.state).toBe("partial");
    expect(report.availability?.["coverage.pct"]?.eligible).not.toBe(999);
  });
  // Covers: R21
  it("does not infer miner completeness from a complete ordinary parser", () => {
    const report = buildReport([session([])], {
      repo: "synthetic",
      version: "0",
      catalog: CATALOG,
      extraMetrics: { "search.shell": 0, "activation.total.pct": 100 },
    });
    expect(report.rangeMetrics["search.shell"]).toBeNull();
    expect(report.rangeMetrics["activation.total.pct"]).toBeNull();
    expect(report.availability?.["search.shell"]?.state).toBe("unavailable");
  });
});

describe("Codex canonical report view", () => {
  // Covers: R4, R5, R8, R9
  it("shares owned provider facts across run, by-type and text without mutating inputs or charging inherited rows", () => {
    const evidence: MetricEvidence = {
      state: "observed",
      reason: null,
      source: "rollout",
      adapter: "codex-rollout",
      sourceVersion: "0.160.0",
    };
    const values: CodexRunFacts["usage"] = {
      inputTotal: 100,
      ordinaryInput: 70,
      cacheRead: 20,
      cacheWrite: 10,
      output: 40,
      reasoning: 15,
      totalTokens: 140,
    };
    const availability = Object.fromEntries(
      Object.keys(values).map((key) => [key, evidence]),
    ) as CodexRunFacts["usageAvailability"];
    const response: CodexResponseFact = {
      threadId: "child",
      rootSessionId: "root",
      turnId: "t1",
      responseId: "private-response-id",
      at: null,
      model: null,
      values,
      evidence: availability,
    };
    const facts: CodexRunFacts = {
      threadId: "child",
      rootSessionId: "root",
      parentThreadId: "root",
      sourceVersion: "0.160.0",
      capturedAt: "2026-10-04T12:00:00Z",
      source: evidence,
      responses: [
        response,
        structuredClone(response),
        { ...response, threadId: "parent", responseId: "inherited" },
      ],
      activity: [],
      usage: values,
      usageAvailability: availability,
    };
    const input = session(
      [
        agent({
          agentId: "child",
          agentType: "codex-child",
          codex: facts,
          availability: {},
        }),
      ],
      {
        host: "codex",
        unavailable: "transcript",
        availability: {},
      },
    );
    input.orchestrator.codex = {
      ...facts,
      threadId: "root",
      parentThreadId: null,
      responses: [],
      capturedAt: null,
    };
    const before = JSON.stringify(input);
    const report = buildReport([input], {
      repo: "r",
      version: "0",
      catalog: CATALOG,
    });
    expect(report.totals.tokens.output).toBe(40);
    expect(report.totals.byAgentType["codex-child"]?.tokens.output).toBe(40);
    expect(publishReport(report).sessions[0]?.agents[0]?.tokens.output).toBe(40);
    expect(report.availability?.["tokens.output"]?.contributors).toBe(1);
    expect(renderMarkdown(report, "en")).toContain(
      "input 100 · ordinary input 70 · output 40 · total 140",
    );
    expect(renderMarkdown(report, "en")).not.toContain("weighted, input-token equivalents");
    expect(renderJson(report)).not.toContain("private-response-id");
    expect(JSON.stringify(input)).toBe(before);
  });
});

/**
 * Spec 0013 — the report's job changed from "one line per agent" to "one card
 * per agent".
 *
 * Everything the card shows was ALREADY captured; the previous renderer threw it
 * away. So these specs are about what reaches the reader, which is where the
 * defect lived.
 */

function agent(over: Partial<AgentRun> = {}): AgentRun {
  return {
    agentId: "ag_01",
    availability: Object.fromEntries(
      [
        "tools",
        "startupTokens",
        "durationMs",
        "hooks",
        "tokens.input",
        "tokens.output",
        "tokens.cacheRead",
        "tokens.cacheCreation",
        "tokens.thinking",
      ].map((key) => [
        key,
        {
          state: "observed" as const,
          reason: null,
          source: "transcript" as const,
          adapter: "claude-transcript" as const,
          sourceVersion: "2.1.231",
        },
      ]),
    ),
    agentType: "implementer",
    model: "claude-opus-5",
    description: "cierra los 5 defectos",
    startedAt: "2026-08-25T10:00:00Z",
    endedAt: "2026-08-25T10:20:00Z",
    durationMs: 20 * 60 * 1000,
    spawnDepth: 1,
    tokens: {
      ...emptyTokens(),
      output: 2000,
      cacheCreation: 100_000,
      cacheRead: 5_000_000,
    },
    startupTokens: 17_000,
    overlapsWith: [],
    toolCounts: { Bash: 73, Read: 53 },
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

function session(agents: AgentRun[], over: Partial<SessionAudit> = {}): SessionAudit {
  return {
    sessionId: "sess1",
    startedAt: "2026-08-25T10:00:00Z",
    endedAt: "2026-08-25T11:00:00Z",
    wallClockMs: 3_600_000,
    initialPrompt: "haz X",
    prompts: { typed: 1, queued: 0, queuedSystem: 0 },
    gitBranch: "main",
    cwd: "/repo",
    ccVersions: ["2.1.231"],
    navori: { rendered: "0.7.1", cli: "0.7.1" },
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
    availability: Object.fromEntries(
      [
        "tools",
        "startupTokens",
        "hooks",
        "wallClockMs",
        "tokens.input",
        "tokens.output",
        "tokens.cacheRead",
        "tokens.cacheCreation",
        "tokens.thinking",
      ].map((key) => [
        key,
        {
          state: "observed" as const,
          reason: null,
          source: "transcript" as const,
          adapter: "claude-transcript" as const,
          sourceVersion: "2.1.231",
        },
      ]),
    ),
    parseErrors: 0,
    linesRead: 10,
    ...over,
  };
}

const CATALOG: HarnessCatalog = {
  agents: [
    { name: "implementer", tools: ["Read", "Bash"], hasMcp: false },
    { name: "researcher", tools: ["Read", "mcp__playwright__*"], hasMcp: true },
    { name: "claude", tools: null, hasMcp: true },
  ],
  skills: [],
  managedSkills: [],
  sections: [
    // A CLAUDE.md section that REQUIRES engram: every agent pays for it at
    // startup, reachable or not.
    { title: "Engram", tokens: 950, chars: 3800, requiresMcp: ["engram"] },
  ],
  claudeMdTokens: 8000,
  // TWO families on purpose, and the second is deliberately not one navori
  // bundles: what the card has to get right is the CROSSING (this agent reaches
  // that server), and a catalogue with a single family can only ever exercise
  // the degenerate case. The real `mcpFamilies` comes from the hint table; this
  // one comes from the fixture, which is the level the crossing lives at.
  mcpFamilies: ["engram", "playwright"],
};

/** Synthetic publication/budget probes: no host logs or filesystem writes. */
describe("private report publication and bounded qualified views", () => {
  // Covers: R6, R10, R11
  it("publishes numeric and null coverage only in its envelope, withholding malformed values", () => {
    const report = buildReport([], {
      repo: "r",
      version: "0.1.0",
      catalog: CATALOG,
    });
    report.coverage = [
      { repo: "r", roots: [], host: 1, audited: 0, captured: 0, ratio: 0 },
      {
        repo: "r",
        roots: [],
        host: 0,
        audited: 0,
        captured: null,
        ratio: null,
      },
    ];
    expect(
      publishReport(report).coverage?.map(({ captured, ratio }) => ({
        captured,
        ratio,
      })),
    ).toEqual([
      { captured: 0, ratio: 0 },
      { captured: null, ratio: null },
    ]);
    const secret = "SECRET-coverage-field";
    for (const malformed of [secret, { summary: secret }, [1], true, Infinity, NaN]) {
      Object.assign(report.coverage[0]!, {
        captured: malformed,
        ratio: malformed,
      });
      const published = publishReport(report);
      expect(published.coverage?.[0]).not.toHaveProperty("captured");
      expect(published.coverage?.[0]).not.toHaveProperty("ratio");
      expect(renderJson(report)).not.toContain(secret);
    }
    Object.assign(report, { captured: 1, ratio: 1 });
    expect(publishReport(report)).not.toHaveProperty("captured");
    expect(publishReport(report)).not.toHaveProperty("ratio");
  });

  // Covers: R6, R10, R11
  it("preserves finite activation keys and renders the section while hiding dynamic segments", () => {
    const report = buildReport([], {
      repo: "r",
      version: "0.1.0",
      catalog: CATALOG,
    });
    const secret = "SECRET-dynamic-activation";
    Object.assign(report.rangeMetrics, {
      "coverage.pct": 75,
      "activation.total.opportunities": 4,
      "activation.total.hits": 3,
      "activation.total.pct": 75,
      "activation.implementer.opportunities": 4,
      "activation.implementer.hits": 3,
      "activation.implementer.pct": 75,
      [`activation.${secret}.opportunities`]: 1,
      [`activation.total.${secret}`]: 1,
    });
    expect(publishReport(report).rangeMetrics).toMatchObject({
      "coverage.pct": 75,
      "activation.total.opportunities": 4,
      "activation.total.hits": 3,
      "activation.total.pct": 75,
      "activation.implementer.opportunities": 4,
    });
    expect(renderMarkdown(report, "en")).toContain("Activation");
    expect(renderJson(report)).not.toContain(secret);
    expect(renderMarkdown(report, "en")).not.toContain(secret);
  });

  function hookEvent(over: Partial<HookEvent> = {}): HookEvent {
    return {
      ts: "2026-08-25T10:00:00Z",
      name: "guard-destructive",
      phase: "PreToolUse",
      verdict: "allow",
      ms: 10,
      source: "core",
      tool: "Bash",
      ...over,
    };
  }
  /** Build distinct owned facts so dropped evidence cannot look like measured zero. */
  function provider(count = 1): SessionAudit {
    const evidence: MetricEvidence = {
      state: "observed",
      reason: null,
      source: "rollout",
      adapter: "codex-rollout",
      sourceVersion: "0.160.0",
    };
    const values: CodexRunFacts["usage"] = {
      inputTotal: 10,
      ordinaryInput: 10,
      cacheRead: 0,
      cacheWrite: null,
      output: 7,
      reasoning: null,
      totalTokens: 17,
    };
    const availability = Object.fromEntries(
      Object.keys(values).map((key) => [
        key,
        {
          ...evidence,
          state: values[key as keyof typeof values] === null ? "unsupported" : "observed",
          reason: values[key as keyof typeof values] === null ? "unsupported-component" : null,
        },
      ]),
    ) as CodexRunFacts["usageAvailability"];
    const facts: CodexRunFacts = {
      threadId: "root",
      rootSessionId: "root",
      parentThreadId: null,
      sourceVersion: "0.160.0",
      capturedAt: null,
      source: evidence,
      responses: Array.from({ length: count }, (_, index): CodexResponseFact => ({
        threadId: "root",
        rootSessionId: "root",
        turnId: `turn-${index}`,
        responseId: `response-${index}`,
        at: null,
        model: "gpt-6.1-sol",
        values,
        evidence: availability,
      })),
      activity: [],
      usage: values,
      usageAvailability: availability,
    };
    const root = session([], {
      sessionId: "root",
      host: "codex",
      availability: {},
    });
    root.orchestrator.codex = facts;
    return root;
  }

  // Covers: R10, R11
  it("withholds human content, unknown labels, map keys and private identities in every default output", () => {
    const sentinel = "SECRET-private-example";
    const run = Object.assign(
      agent({
        agentType: sentinel,
        model: `gpt-6-${sentinel}`,
        description: sentinel,
        toolCounts: { Bash: 3, [sentinel]: 1 },
        mcpCalls: { [sentinel]: { [sentinel]: 2 } },
        hookEvents: [hookEvent({ name: sentinel, reason: sentinel })],
        blockedCommands: { tool_1: sentinel },
        repeatedCommands: { [sentinel]: 3 },
        observedArtifactWrites: [
          {
            actor: "orchestrator",
            at: null,
            source: "native-write",
            outcome: "success",
            location: {
              state: "repo-relative",
              path: `.navori/state/handoffs/impl_${sentinel}.json`,
            },
          },
        ],
      }),
      {
        ownerKey: sentinel,
        sourcePath: sentinel,
        sourceHeaderFingerprint: sentinel,
      },
    );
    const report = buildReport([session([run], { initialPrompt: sentinel })], {
      repo: "r",
      version: "0.1.0",
      catalog: CATALOG,
    });
    for (const output of [
      renderJson(report),
      JSON.stringify(publishReport(report)),
      renderMarkdown(report, "en"),
      renderMarkdown(report, "es"),
    ]) {
      expect(output).not.toContain(sentinel);
      expect(output).not.toContain("sourceHeaderFingerprint");
      expect(output).not.toContain("ownerKey");
      expect(output).not.toContain("sourcePath");
    }
    expect(publishReport(report).sessions[0]?.agents[0]?.toolCounts?.Bash).toBe(3);
  });

  // Covers: R10, R11
  it("opts into selected examples for one generation without enabling raw command or path content", () => {
    const prompt = "Selected prompt example";
    const description = "Selected description example";
    const secret = "SECRET-command-or-path";
    const report = buildReport(
      [
        session(
          [
            agent({
              description,
              blockedCommands: { tool_1: secret },
              repeatedCommands: { [secret]: 2 },
              hookEvents: [hookEvent({ reason: secret })],
            }),
          ],
          { initialPrompt: prompt, cwd: secret },
        ),
      ],
      { repo: "r", version: "0.1.0", catalog: CATALOG },
    );
    const before = renderJson(report);
    expect(before).not.toContain(prompt);
    expect(before).not.toContain(description);
    for (const output of [
      renderJson(report, { includeHumanContent: true }),
      renderMarkdown(report, "en", { includeHumanContent: true }),
    ]) {
      expect(output).toContain(prompt);
      expect(output).toContain(description);
      expect(output).not.toContain(secret);
    }
    expect(renderJson(report)).toBe(before);
  });

  // Covers: R6, R10, R11
  it("preserves known numeric evidence and nested metric keys through safe publication", () => {
    const root = session([]);
    root.orchestrator.toolCountsByMode = { default: { Bash: 3 } };
    root.agents = [
      agent({
        model: "gpt-6.1-sol",
        toolCounts: { Bash: 3 },
        mcpCalls: { engram: { Read: 2 } },
        observedArtifactWrites: [
          {
            actor: "orchestrator",
            at: null,
            source: "native-write",
            outcome: "success",
            location: { state: "repo-relative", path: "navori.config.json" },
          },
        ],
      }),
    ];
    const report = buildReport([root], {
      repo: "r",
      version: "0.1.0",
      catalog: CATALOG,
    });
    const published = publishReport(report);
    expect(published.totals.tokens.output).toBe(report.totals.tokens.output);
    expect(published.sessions[0]?.orchestrator.toolCountsByMode?.default?.Bash).toBe(3);
    expect(published.sessions[0]?.agents[0]?.mcpCalls?.engram?.Read).toBe(2);
    expect(published.sessions[0]?.agents[0]?.observedArtifactWrites?.[0]?.location).toEqual({
      state: "repo-relative",
      path: "navori.config.json",
    });
    expect(published.availability?.["tokens.output"]).toEqual(
      report.availability?.["tokens.output"],
    );
  });

  // Covers: R6, R10, R11
  it("keeps safe artifact paths only in their location context and projects frozen aliases once", () => {
    const privateLabel = "private-project-label";
    const run = Object.assign(agent({ model: `gpt-6-${privateLabel}` }), {
      path: "AGENTS.md",
      ownerKey: "private-source-id",
    });
    run.observedArtifactWrites = [
      {
        actor: "orchestrator",
        at: null,
        source: "native-write",
        outcome: "success",
        location: { state: "repo-relative", path: "AGENTS.md" },
      },
      {
        actor: "orchestrator",
        at: null,
        source: "native-write",
        outcome: "success",
        location: {
          state: "repo-relative",
          path: `.navori/state/handoffs/impl_${privateLabel}.json`,
        },
      },
    ];
    const report = buildReport([session([run])], {
      repo: "r",
      version: "0.1.0",
      catalog: CATALOG,
    });
    freezeTree(report);
    const before = JSON.stringify(report);
    const defaultJson = renderJson(report);
    const published = publishReport(report, { includeHumanContent: true });
    expect(
      published.sessions[0]?.agents[0]?.observedArtifactWrites?.map((event) => event.location),
    ).toEqual([
      { state: "repo-relative", path: "AGENTS.md" },
      { state: "repo-relative", path: "redacted" },
    ]);
    expect(published.sessions[0]?.agents[0]).not.toHaveProperty("path");
    expect(JSON.stringify(published)).not.toContain(privateLabel);
    expect(JSON.stringify(published)).not.toContain("private-source-id");
    expect(published.availability?.["tokens.output"]?.state).toBe(
      report.availability?.["tokens.output"]?.state,
    );
    expect(renderJson(report)).toBe(defaultJson);
    expect(JSON.stringify(report)).toBe(before);
  });

  // Covers: R6, R21
  it("does not certify zero when a shared budget is exhausted before the first provider fact", () => {
    const budget = createAuditReadBudget({ factsPerReport: 1 });
    expect(retainAuditFact(budget, "earlier-session", { retained: true })).toBe(true);
    const report = buildReport([provider()], {
      repo: "r",
      version: "0.1.0",
      catalog: CATALOG,
      readBudget: budget,
    });
    const published = publishReport(report);
    expect(published.totals.tokens.output).toBeNull();
    expect(budget.diagnostics.retainedFacts).toBeLessThanOrEqual(1);
    expect(budget.diagnostics.truncated).toBe(true);
    expect(budget.diagnostics.omittedLowerBound).toBeGreaterThan(0);
  });

  // Covers: R6, R21
  it("retains a known contribution after one fact while exposing the omitted remainder", () => {
    const measured = createAuditReadBudget();
    buildReport([provider()], {
      repo: "r",
      version: "0.1.0",
      catalog: CATALOG,
      readBudget: measured,
    });
    const limit = measured.diagnostics.retainedFacts;
    expect(limit).toBeGreaterThan(0);
    const budget = createAuditReadBudget({ factsPerReport: limit });
    const report = buildReport([provider(2)], {
      repo: "r",
      version: "0.1.0",
      catalog: CATALOG,
      readBudget: budget,
    });
    const published = publishReport(report);
    expect(published.totals.tokens.output).toBe(7);
    expect(published.availability?.["tokens.output"]?.state).toBe("partial");
    expect(budget.diagnostics.retainedFacts).toBeLessThanOrEqual(limit);
    expect(budget.diagnostics.omittedLowerBound).toBeGreaterThan(0);
  });

  // Covers: R6, R21
  it("publishes loss diagnostics even when the input has no source health shell", () => {
    const budget = createAuditReadBudget({ factsPerReport: 1 });
    retainAuditFact(budget, "earlier-session", { retained: true });
    const input = provider();
    expect(input.sources).toBeUndefined();
    const report = buildReport([input], {
      repo: "r",
      version: "0.1.0",
      catalog: CATALOG,
      readBudget: budget,
    });
    const published = publishReport(report);
    const budgets = Object.values(published.sessions[0]?.sources ?? {}).flatMap((source) =>
      source?.budget ? [source.budget] : [],
    );
    expect(budgets.length).toBeGreaterThan(0);
    expect(budgets[0]?.truncated).toBe(true);
    expect(budgets[0]?.omittedLowerBound).toBeGreaterThan(0);
    expect(renderMarkdown(report, "en")).toContain("Resource diagnostics");
    expect(renderMarkdown(report, "en")).toContain("omitted");
  });

  /** Freeze aliases once; the reducer may clone shells but never mutate callers. */
  function freezeTree(value: unknown, seen = new WeakSet<object>()): void {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const child of Object.values(value)) freezeTree(child, seen);
    Object.freeze(value);
  }

  // Covers: R4, R5, R8, R9, R21
  it("preserves deeply frozen provider aliases across independent report generations", () => {
    const input = provider();
    const response = input.orchestrator.codex!.responses[0]!;
    input.orchestrator.codex!.responses.push(response);
    const before = JSON.stringify(input);
    freezeTree(input);
    const options = {
      repo: "r",
      version: "0.1.0",
      catalog: CATALOG,
      now: new Date("2026-10-04T00:00:00Z"),
    };
    const first = buildReport([input], {
      ...options,
      readBudget: createAuditReadBudget(),
    });
    const second = buildReport([input], {
      ...options,
      readBudget: createAuditReadBudget(),
    });
    expect(first.totals.tokens.output).toBe(7);
    expect(renderJson(second)).toBe(renderJson(first));
    expect(JSON.stringify(input)).toBe(before);
    expect(input.orchestrator.codex!.responses[0]).toBe(input.orchestrator.codex!.responses[1]);
  });
});

describe("schema11 evidence projection", () => {
  // Covers: R6
  it.each([false, true])(
    "shares projected agent counts across JSON and text: observed=%s",
    (observed) => {
      const root = session([], {
        availability: observed ? session([]).availability : {},
      });
      const report = buildReport([root], {
        repo: "summary",
        version: "test",
        catalog: CATALOG,
      });
      expect(JSON.parse(renderJson(report)).totals.agents).toBe(observed ? 0 : null);
      for (const lang of ["en", "es"] as const) {
        const header = renderMarkdown(report, lang)
          .split("\n")
          .find((line) => line.startsWith(lang === "en" ? "Range:" : "Rango:"));
        expect(header).toContain(
          `${observed ? 0 : "unavailable"} ${lang === "en" ? "agents" : "agentes"}`,
        );
      }
    },
  );
  // Covers: R6
  it("enumerates every public numeric path without certifying missing measurements", () => {
    const root = session([agent({ availability: {} })], { availability: {} });
    const report = buildReport([root], {
      repo: "unknown",
      version: "test",
      catalog: CATALOG,
    });
    const numbers: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (typeof value === "number") numbers.push(path);
      else if (Array.isArray(value))
        value.forEach((item: unknown, index: number) => walk(item, `${path}.${index}`));
      else if (value !== null && typeof value === "object")
        Object.entries(value).forEach(([key, item]: [string, unknown]) =>
          walk(item, path ? `${path}.${key}` : key),
        );
    };
    walk(publishReport(report), "");
    const diagnostics =
      /^(schemaVersion|totals.sessions|sessions\.\d+\.(parseErrors|linesRead|prs\.\d+)|sessions\.\d+\.agents\.\d+\.spawnDepth|availability(?:ByAgentType)?\.|rangeMetrics\.(sessions\.|.*\.n$))/;
    expect(numbers.filter((path) => !diagnostics.test(path))).toEqual([]);
    expect(numbers).toContain("sessions.0.agents.0.spawnDepth");
    expect(publishReport(report).sessions[0]?.agents[0]?.model).toBe("claude-opus-5");
  });
  // Covers: R6
  it.each(["child-only", "root-only"])(
    "uses exact root/child contributors for %s usage",
    (mode) => {
      const child = agent({
        tokens: { ...emptyTokens(), input: 23 },
        availability: mode === "root-only" ? {} : agent().availability,
      });
      const root = session([child], {
        availability: mode === "child-only" ? {} : session([]).availability,
      });
      root.orchestrator.tokens.input = 17;
      const report = buildReport([root], {
        repo: "mixed",
        version: "test",
        catalog: CATALOG,
      });
      const json = JSON.parse(renderJson(report));
      expect(json.totals.tokens.input).toBe(mode === "child-only" ? 23 : 17);
      expect(json.availability["tokens.input"]).toMatchObject({
        state: "partial",
        eligible: 2,
        observed: 1,
        partial: 0,
        unavailable: 1,
        contributors: 1,
      });
      expect(json.totals.byAgentType.implementer.tokens.input).toBe(
        mode === "child-only" ? 23 : null,
      );
      expect(json.availabilityByAgentType.implementer["tokens.input"]).toMatchObject({
        eligible: 1,
        observed: mode === "child-only" ? 1 : 0,
      });
    },
  );
  // Covers: R6, R10, R11
  it("never certifies an unrelated all-missing type or tool-observed missing components", () => {
    const root = session(
      [
        agent(),
        agent({
          agentId: "missing",
          agentType: "researcher",
          availability: {},
        }),
      ],
      { availability: { tools: session([]).availability!.tools! } },
    );
    root.orchestrator.tokens = {
      input: 987654321,
      output: 987654321,
      cacheRead: 987654321,
      cacheCreation: 987654321,
      thinking: 987654321,
    };
    root.orchestrator.startupTokens = 987654321;
    root.orchestrator.contextPeak = 987654321;
    root.orchestrator.skills = [
      {
        slug: "probe",
        source: "attribution",
        attributedOutputTokens: 987654321,
        attributedRecords: 1,
      },
    ];
    const report = buildReport([root], {
      repo: "mixed",
      version: "test",
      catalog: CATALOG,
    });
    const json = JSON.parse(renderJson(report));
    expect(json.totals.byAgentType.researcher.tokens.input).toBeNull();
    expect(json.totals.byAgentType.researcher.count).toBeNull();
    expect(json.sessions[0].orchestrator.contextPeak).toBeNull();
    for (const value of Object.values(json.sessions[0].orchestrator.tokens))
      expect(value).toBeNull();
    expect(json.sessions[0].orchestrator.startupTokens).toBeNull();
    expect(json.sessions[0].orchestrator.skills[0].attributedOutputTokens).toBeNull();
    expect(
      json.totals.skills.find((row: { slug: string }) => row.slug === opaqueLabel("probe"))
        .outputTokens,
    ).toBeNull();
    expect(json.rangeMetrics["agent.main-thread.contextPeak.n"]).toBe(0);
    expect(renderJson(report)).not.toContain("987654321");
    const text = renderMarkdown(report, "en");
    expect(text).not.toContain("987654321");
    expect(text).toContain("main-thread / tokens.input | unavailable");
    expect(text).toContain("Combined token spend unavailable");
    expect(text).toContain(`\`${opaqueLabel("probe")}\` | — | 1 | — | 1 | unavailable`);
  });
  // Covers: R6
  it("publishes only contributed partial components and excludes them from statistics", () => {
    const root = session([]);
    root.availability = {
      tools: root.availability!.tools!,
      "tokens.input": {
        ...root.availability!["tokens.input"]!,
        state: "partial",
        reason: "live-tail",
      },
      "tokens.output": root.availability!["tokens.output"]!,
    };
    root.orchestrator.tokens = {
      input: 41,
      output: 0,
      cacheRead: 987654321,
      cacheCreation: 987654321,
      thinking: 987654321,
    };
    const report = buildReport([root], {
      repo: "partial",
      version: "test",
      catalog: CATALOG,
    });
    const json = JSON.parse(renderJson(report));
    expect(json.totals.tokens).toEqual({
      input: 41,
      output: 0,
      cacheRead: null,
      cacheCreation: null,
      thinking: null,
    });
    expect(json.availability["tokens.input"]).toMatchObject({
      eligible: 1,
      observed: 0,
      partial: 1,
      contributors: 1,
    });
    expect(json.rangeMetrics["session.cacheRead.p50"]).toBeNull();
    expect(renderMarkdown(report, "en")).toContain(
      "main-thread / tokens.input | 41 | partial | live-tail",
    );
  });
  // Covers: R6, R8
  it("does not certify an empty population as measured zero", () => {
    const report = buildReport([], {
      repo: "empty",
      version: "test",
      catalog: CATALOG,
      requestedRange: {
        from: "2026-09-01T00:00:00.000Z",
        to: "2026-09-02T00:00:00.000Z",
      },
    });
    const json = JSON.parse(renderJson(report));
    expect(json.totals.tokens.input).toBeNull();
    expect(json.availability["tokens.input"].eligible).toBe(0);
    expect(json.range.from).toBe("2026-09-01T00:00:00.000Z");
    expect(report.signals).toEqual([]);
    expect(renderMarkdown(report, "en")).toContain("unavailable");
  });
  // Covers: R6
  it("preserves measured zero, excludes unavailable and invalid contributors, and reports N", () => {
    const known = session([], { sessionId: "known" });
    known.orchestrator.tokens.input = 0;
    const missing = session([], { sessionId: "missing", availability: {} });
    missing.orchestrator.tokens.input = 999;
    const report = buildReport([known, missing], {
      repo: "mixed",
      version: "test",
      catalog: CATALOG,
    });
    const json = JSON.parse(renderJson(report));
    expect(json.sessions[0].orchestrator.tokens.input).toBe(0);
    expect(json.sessions[1].orchestrator.tokens.input).toBeNull();
    expect(json.totals.tokens.input).toBe(0);
    expect(json.availability["tokens.input"]).toMatchObject({
      state: "partial",
      eligible: 2,
      observed: 1,
      unavailable: 1,
    });
  });
  // Covers: R6
  it("does not retroactively certify legacy initialized counters", () => {
    const report = buildReport([session([], { availability: undefined })], {
      repo: "legacy",
      version: "test",
      catalog: CATALOG,
    });
    expect(JSON.parse(renderJson(report)).sessions[0].orchestrator.tokens.input).toBeNull();
  });
});

function md(agents: AgentRun[], over: Partial<SessionAudit> = {}): string {
  const report = buildReport([session(agents, over)], {
    repo: "demo",
    version: "0.6.5",
    catalog: CATALOG,
  });
  return renderMarkdown(report, "es");
}

/**
 * #778 — the detector that would have caught alertaciudadana with data the
 * pipeline already had. The versions were PRINTED per session for releases and
 * no finding ever read them, so "0.3% adoption" was published about a range in
 * which the plugin being measured did not exist yet.
 */
describe("range finding: the sessions ran under another harness (#778)", () => {
  /** Sessions with distinct ids so the evidence can name them. */
  function range(...navori: Array<{ rendered: string | null; cli: string | null }>) {
    return navori.map((n, i) => session([], { sessionId: `sess${i}0000000`, navori: n }));
  }

  function report(sessions: SessionAudit[], harnessVersion: string | null) {
    return buildReport(sessions, {
      repo: "demo",
      version: "0.8.6",
      catalog: CATALOG,
      harnessVersion,
      lang: "es",
    });
  }

  it("emits nothing when every session ran the harness the repo has today", () => {
    const r = report(
      range(
        { rendered: "0.8.6", cli: "0.8.6" },
        { rendered: "0.8.6", cli: "0.8.6" },
        // Newer than the repo's disk: that is an upgrade in flight, not a stale
        // measurement, and calling it one would fire on every rollout.
        { rendered: "0.8.7", cli: "0.8.7" },
      ),
      "0.8.6",
    );
    expect(r.rangeSignals).toEqual([]);
    expect(renderMarkdown(r, "es")).not.toContain("Hallazgos del rango");
  });

  it("reports how many sessions and which versions — the alertaciudadana range", () => {
    // 8 sessions with no version recorded, 2 on 0.7.0, 1 on 0.7.5, repo at 0.8.6.
    const r = report(
      range(
        ...Array.from({ length: 8 }, () => ({ rendered: null, cli: null })),
        { rendered: "0.7.0", cli: "0.7.0" },
        { rendered: "0.7.0", cli: "0.7.0" },
        { rendered: "0.7.5", cli: "0.7.5" },
      ),
      "0.8.6",
    );
    const sig = r.rangeSignals[0];
    expect(sig?.kind).toBe("harness-regime");
    // Not one session ran the current harness: the aggregates describe nothing
    // that is on disk, which is the severity this case earns.
    expect(sig?.severity).toBe("high");
    expect(sig?.summary).toContain("11 de 11 sesiones");
    expect(sig?.summary).toContain("0.8.6");
    expect(sig?.evidence).toContain("8 sin versión registrada");
    expect(sig?.evidence).toContain("0.7.0 ×2");
    expect(sig?.evidence).toContain("0.7.5 ×1");
    // The claim that makes the finding actionable rather than trivia.
    expect(sig?.evidence).toContain("regímenes distintos");
  });

  it("downgrades to warn when the range merely straddles an upgrade", () => {
    const r = report(
      range({ rendered: "0.7.5", cli: "0.7.5" }, { rendered: "0.8.6", cli: "0.8.6" }),
      "0.8.6",
    );
    expect(r.rangeSignals[0]?.severity).toBe("warn");
    expect(r.rangeSignals[0]?.summary).toContain("1 de 2 sesiones");
  });

  it("fires on rendered ≠ cli alone — the divergence model.ts already called a finding", () => {
    const r = report(range({ rendered: "0.8.6", cli: "0.8.7" }), "0.8.6");
    expect(r.rangeSignals[0]?.evidence).toContain("rendered ≠ cli");
    // Short id, the same 8 chars every other line of the report names a session by.
    expect(r.rangeSignals[0]?.evidence).toContain("sess0000 (0.8.6 / CLI 0.8.7)");
  });

  it("prints the caveat BEFORE the figures it qualifies", () => {
    const r = report(range({ rendered: null, cli: null }), "0.8.6");
    const out = renderMarkdown(r, "es");
    const caveat = out.indexOf("Hallazgos del rango");
    const firstSession = out.indexOf("## Sesión");
    expect(caveat).toBeGreaterThan(-1);
    expect(caveat).toBeLessThan(firstSession);
  });
});

/**
 * `generatedBy` describes the file; this describes the session. A report built
 * after an upgrade used to state only the former, so every cross-release
 * comparison read the generator's version as if it were the harness's.
 */
describe("session header: the navori that ran the session", () => {
  it("states the rendered version, not the generator's", () => {
    // The generator is 0.6.5 (see `md`), the session ran under 0.7.0.
    const out = md([], { navori: { rendered: "0.7.0", cli: "0.7.0" } });
    expect(out).toContain("navori 0.7.0");
    expect(out).toContain("generado por navori@0.6.5");
  });

  it("names both when the CLI moved ahead of the render", () => {
    const out = md([], { navori: { rendered: "0.6.5", cli: "0.7.1" } });
    expect(out).toContain("navori 0.6.5 (CLI 0.7.1)");
  });

  it("says unknown for a session marked before the stamp existed", () => {
    const out = md([], { navori: { rendered: null, cli: null } });
    expect(out).toContain("navori ? (sesión previa al registro)");
  });
});

/**
 * A gate hook fires on every Bash call but acts only on a commit, so its
 * timings are bimodal and the mean describes neither mode. The line used to
 * print only `n×` and the total, which reads as a per-call tax: the measured
 * `check-semgrep 902× 191.2s` looks like 212ms on every shell command when 876
 * of those runs cost 49.6s between them and 26 real scans cost the other 141.6s.
 */
describe("hook line: constant toll vs the gate doing its job", () => {
  /** `n` pass-throughs at `fastMs`, plus `slow` real runs at `slowMs`. */
  function hookRuns(name: string, n: number, fastMs: number, slow: number, slowMs: number) {
    return [
      ...Array.from({ length: n }, () => ({
        ts: "2026-08-25T10:00:00Z",
        name,
        phase: "PreToolUse",
        verdict: "allow",
        ms: fastMs,
        source: "plugin:semgrep",
      })),
      ...Array.from({ length: slow }, () => ({
        ts: "2026-08-25T10:00:00Z",
        name,
        phase: "PreToolUse",
        verdict: "allow",
        ms: slowMs,
        source: "plugin:semgrep",
      })),
    ];
  }

  it("reports the median and splits out the runs over a second", () => {
    const out = md([agent({ hookEvents: hookRuns("check-semgrep", 20, 40, 4, 5000) })]);
    // 24 runs, 20.8s total — but one more command would pay 40ms, not 867ms.
    expect(out).toContain("check-semgrep 24× 20.8s · mediana 40ms · 4 corridas >1s = 20.0s");
  });

  it("says nothing about long runs for a hook that never had one", () => {
    const out = md([agent({ hookEvents: hookRuns("guard-destructive", 10, 58, 0, 0) })]);
    expect(out).toContain("guard-destructive 10× 0.6s · mediana 58ms");
    expect(out).not.toContain("corridas >1s");
  });

  it("still names the blocks it produced", () => {
    const events = hookRuns("guard-destructive", 3, 50, 0, 0);
    events.push({
      ...(events[0] as (typeof events)[number]),
      verdict: "block",
    });
    expect(md([agent({ hookEvents: events })])).toContain("1 bloqueos");
  });

  it("states that the timings include the recorder that produced them", () => {
    const out = md([agent({ hookEvents: hookRuns("check-jscpd", 2, 30, 0, 0) })]);
    expect(out).toContain("incluyen el costo del propio recorder");
  });

  it("does not count a gate-started timeout witness as a completed hook run", () => {
    const out = md([
      agent({
        hookEvents: [
          {
            ts: "2026-08-25T10:00:00Z",
            name: "quality-gate-pre-commit",
            phase: "PreToolUse",
            verdict: "gate-started",
            ms: 3,
            source: "core",
            toolUseId: "toolu_gate_timeout",
          },
        ],
      }),
    ]);
    expect(out).not.toContain("quality-gate-pre-commit");
  });
});

describe("per-agent card (#0013)", () => {
  // Covers: R8, R12
  it("renders the agent's skills, tools, MCP and hooks in one card", () => {
    const out = md([
      agent({
        skills: [{ slug: "structural-search", source: "skill-tool" }],
        mcpCalls: { engram: { mem_save: 3 } },
        hookEvents: [
          {
            ts: "2026-08-25T10:05:00Z",
            name: "guard-destructive",
            phase: "PreToolUse",
            verdict: "block",
            ms: 9,
            source: "core",
            reason: "rm -rf",
          },
        ],
      }),
    ]);
    expect(out).toContain("structural-search (tool Skill)");
    expect(out).toContain("Bash 73");
    expect(out).toContain("mem_save 3");
    expect(out).toContain("guard-destructive");
    // Duration belongs on the card: tokens alone do not say what a run COST in
    // the only currency the user waits in.
    expect(out).toContain("20m");
  });

  // Covers: R8
  it("keeps MCP tools out of the plain tools line", () => {
    const out = md([agent({ toolCounts: { Bash: 5, mcp__engram__mem_save: 3 } })]);
    // Counting them twice would inflate the tool histogram with calls the MCP
    // line already reports.
    expect(out).not.toContain("mcp__engram__mem_save 3");
  });
});

describe("MCP reach: barred vs available (#0013)", () => {
  // Covers: R19
  it("distinguishes a server barred by tools: from one available and unused", () => {
    const out = md([agent({ agentType: "researcher" })]);
    // `researcher` declares mcp__playwright__* and nothing else.
    expect(out).toMatch(/playwright\s+disponible · 0 llamadas/);
    expect(out).toMatch(/engram\s+⚠ vedado por su tools:/);
  });

  // Covers: R19
  it("treats an absent tools: as reaching everything", () => {
    const out = md([agent({ agentType: "claude" })]);
    // Omitting `tools:` inherits the full toolset — reporting it as barred would
    // invent a restriction the harness never declared.
    expect(out).not.toContain("⚠ vedado");
  });

  // Covers: R20
  it("says what the bar COSTS, not just that it exists", () => {
    const out = md([agent({ agentType: "researcher" })]);
    // `researcher` cannot reach engram, yet ships the engram section in every
    // startup. A label alone leaves the reader unable to weigh the finding.
    expect(out).toMatch(/engram\s+⚠ vedado por su tools: · 950 tok de instrucciones inejecutables/);
  });

  // Covers: R19
  it("persists the reach in the JSON, not only in the markdown", () => {
    const report = buildReport([session([agent({ agentType: "implementer" })])], {
      repo: "demo",
      version: "0.6.5",
      catalog: CATALOG,
    });
    expect(report.sessions[0]?.agents[0]?.mcpReach).toEqual({
      engram: false,
      playwright: false,
    });
  });
});

/**
 * #728 — the engram card used to put raw `mem_save` next to raw `mem_search`,
 * and that pairing invites a verdict neither counter supports: writes carry a
 * ceremony the closing protocol demands, and reads exclude the injection the
 * `SessionStart` hook makes with no call at all.
 */
describe("engram: ceremony vs content, requested vs injected reads (#728)", () => {
  function engramCard(
    ops: Record<string, number>,
    injected: Record<string, InjectedContext> = {},
  ): string {
    const s = session([]);
    s.orchestrator.mcpCalls = { engram: ops };
    s.orchestrator.mcpInjectedContext = injected;
    const report = buildReport([s], {
      repo: "demo",
      version: "0.6.5",
      catalog: CATALOG,
    });
    return renderMarkdown(report, "es");
  }

  it("splits the writes into content and ceremony instead of summing them", () => {
    const out = engramCard({
      mem_save: 9,
      mem_session_summary: 3,
      mem_search: 5,
    });
    // The per-op detail stays whole — the split explains it, never replaces it.
    expect(out).toContain("engram     17 (mem_save 9, mem_search 5, mem_session_summary 3)");
    expect(out).toContain("escrituras  9 de contenido + 3 de ceremonia (mem_session_summary");
  });

  it("names the ceremony operations it actually counted", () => {
    // The bucket holds more than `mem_session_summary`; a line that names the
    // wrong one is the same defect as the count it replaces.
    const out = engramCard({ mem_save: 1, mem_save_prompt: 2 });
    expect(out).toContain("1 de contenido + 2 de ceremonia (mem_save_prompt");
    expect(out).not.toContain("(mem_session_summary");
  });

  it("says so when every write was content, rather than printing a zero", () => {
    const out = engramCard({ mem_save: 4, mem_search: 2 });
    expect(out).toContain("escrituras  4, ninguna de ceremonia");
  });

  it("reports the SessionStart injection as a read, with its own label", () => {
    const out = engramCard({ mem_save: 9, mem_search: 5 }, { engram: { count: 2, chars: 16_000 } });
    // Never folded into `mem_search`: one is asked for, the other arrives on
    // its own, and merging them would hide the distinction that motivated this.
    expect(out).toContain(
      "lecturas    5 pedidas + 2 inyectadas por el hook SessionStart (~16k car)",
    );
    expect(out).toContain("mem_search 5");
  });

  it("surfaces an injection even when the session never called engram", () => {
    // The worst case for the old card: memory was read and engram appeared
    // nowhere, because the line was built from call counts alone.
    const out = engramCard({}, { engram: { count: 1, chars: 8000 } });
    expect(out).toContain("engram     0 llamadas");
    expect(out).toContain("0 pedidas + 1 inyectadas por el hook SessionStart (~8k car)");
  });

  it("states the absence as what the transcript shows, not as zero injections", () => {
    const out = engramCard({ mem_search: 3 });
    expect(out).toContain(
      "lecturas    3 pedidas · el transcript no registra inyección de contexto por SessionStart",
    );
  });

  it("invents no breakdown for an agent that cannot reach engram", () => {
    // `researcher` declares `mcp__playwright__*` and nothing else, so printing
    // "0 requested reads" on its card would read as "it did not search" when
    // the truth is that it could not — the distinction #728 exists to keep.
    const out = md([agent({ agentType: "researcher" })]);
    expect(out).toMatch(/engram\s+⚠ vedado por su tools:/);
    expect(out).not.toContain("lecturas");
    expect(out).not.toContain("escrituras");
  });
});

describe("time: sum vs wall clock (#0013)", () => {
  // Covers: R13
  it("does not add up overlapping agents into clock time", () => {
    const parallel = [
      agent({
        agentId: "a",
        startedAt: "2026-08-25T10:00:00Z",
        endedAt: "2026-08-25T10:20:00Z",
      }),
      agent({
        agentId: "b",
        startedAt: "2026-08-25T10:05:00Z",
        endedAt: "2026-08-25T10:25:00Z",
      }),
    ];
    const report = buildReport([session(parallel)], {
      repo: "demo",
      version: "0.6.5",
      catalog: CATALOG,
    });
    // 20m + 20m of work, but 10:00→10:25 of clock. Reporting 40m would describe
    // time nobody waited — and parallel fan-out is the harness's main lever, so
    // overstating its cost argues against the thing that works.
    expect(report.totals.agentDurationMs).toBe(40 * 60 * 1000);
    expect(report.totals.agentWallClockMs).toBe(25 * 60 * 1000);
  });

  // Covers: R13
  it("adds disjoint windows in full", () => {
    const serial = [
      agent({
        agentId: "a",
        startedAt: "2026-08-25T10:00:00Z",
        endedAt: "2026-08-25T10:10:00Z",
      }),
      agent({
        agentId: "b",
        startedAt: "2026-08-25T11:00:00Z",
        endedAt: "2026-08-25T11:10:00Z",
      }),
    ];
    const report = buildReport([session(serial)], {
      repo: "demo",
      version: "0.6.5",
      catalog: CATALOG,
    });
    expect(report.totals.agentWallClockMs).toBe(20 * 60 * 1000);
  });
});

/**
 * #693 — the firing count of `SubagentStop` reads as a count of subagents, and
 * that misreading has a receipt: it produced #673, an issue that #694 had to
 * refute after a full investigation. The attribution was never wrong; the label
 * was.
 */
describe("hooks del host vs conteo de subagentes (#693)", () => {
  function hookEvent(over: Partial<HookEvent> = {}): HookEvent {
    return {
      ts: "2026-08-25T10:05:00Z",
      tsMs: Date.parse("2026-08-25T10:05:00Z"),
      name: "subagent-stop-handoff",
      phase: "SubagentStop",
      verdict: "skip",
      ms: 8,
      source: "core",
      ...over,
    };
  }

  it("anota la línea con lo que el número significa, y con cuántos agentes hubo", () => {
    const agents = [agent({ agentId: "a1" }), agent({ agentId: "a2" })];
    const out = md(agents, {
      orchestrator: {
        ...session([]).orchestrator,
        hookEvents: [hookEvent(), hookEvent(), hookEvent()],
      },
    });
    // The count stays — it is correct as "times the hook fired", and hiding it
    // would trade one wrong reading for a missing one.
    expect(out).toContain("subagent-stop-handoff 3×");
    // What changes is that it can no longer be read as delegation.
    expect(out).toContain("disparos del host, no subagentes (agentes: 2)");
  });

  it("no anota los hooks que dispara el harness", () => {
    const out = md([], {
      orchestrator: {
        ...session([]).orchestrator,
        hookEvents: [hookEvent({ name: "guard-destructive", phase: "PreToolUse" })],
      },
    });
    expect(out).toContain("guard-destructive 1×");
    // Keyed on the phase, so a hook navori itself fires carries no caveat: an
    // unconditional note is noise, and noise is what makes the next one skimmed.
    expect(out).not.toContain("disparos del host");
  });
});

describe("schema (#0013)", () => {
  // Covers: R17
  // Covers: R6
  it("declares nullable schemaVersion 11", () => {
    const report = buildReport([session([])], {
      repo: "demo",
      version: "0.6.5",
      catalog: CATALOG,
    });
    expect(report.schemaVersion).toBe(11);
    // The bump to 10 adds `rangeMetrics`; older shapes lose nothing.
    expect(report.rangeMetrics["sessions.total"]).toBe(1);
    // Same contract for the bump to 8 (#778): `rangeSignals` is a scope the
    // payload never carried, so a consumer must be able to tell it exists
    // rather than read its absence as "the range has no caveat".
    expect(report.rangeSignals).toEqual([]);
    // The bump is what the field below is FOR: a consumer pinned to 5 must be
    // able to tell that `orphanSessions` exists without probing for it.
    expect(report.orphanSessions).toEqual([]);
    // Same contract for the bump to 7: `mcpInjectedContext` is a whole class of
    // read the JSON never carried, so a consumer must be able to tell it is
    // there instead of reading its absence as "nothing was injected" (#728).
    expect(report.sessions[0]?.orchestrator.mcpInjectedContext).toEqual({});
  });

  it("carries the marked logs whose transcript never resolved (#675)", () => {
    const report = buildReport([session([])], {
      repo: "demo",
      version: "0.6.5",
      catalog: CATALOG,
      orphanSessions: ["sess-gho"],
    });
    expect(report.orphanSessions).toEqual(["sess-gho"]);
  });

  it("stamps when it was built, which `generatedBy` never said", () => {
    const report = buildReport([session([])], {
      repo: "demo",
      version: "0.6.5",
      catalog: CATALOG,
      now: new Date("2026-09-08T12:00:00.000Z"),
    });
    expect(report.generatedAt).toBe("2026-09-08T12:00:00.000Z");
  });
});

describe("the orchestrator gets a card too (#0013)", () => {
  // Covers: R8
  it("renders the session's own run, with its hooks", () => {
    const s = session([agent()]);
    s.orchestrator.hookEvents = [
      {
        ts: "2026-08-25T10:01:00Z",
        name: "guard-destructive",
        phase: "PreToolUse",
        verdict: "allow",
        ms: 11,
        source: "core",
      },
    ];
    s.orchestrator.toolCounts = { Bash: 302 };
    const report = buildReport([s], {
      repo: "demo",
      version: "0.6.5",
      catalog: CATALOG,
    });
    const out = renderMarkdown(report, "es");
    // Most of a session happens in the orchestrator, and every hook event that
    // could not be attributed to a subagent lands on it. A real session showed
    // 340 events on its one subagent and hid the orchestrator's 187.
    expect(out).toContain("orquestador");
    expect(out).toContain("Bash 302");
    expect(out).toMatch(/hooks\s+guard-destructive 1×/);
  });

  // Covers: R8
  it("keeps the verdict label separated from its value", () => {
    const out = md([agent({ verdict: "CHANGES_REQUESTED" })]);
    // `veredicto` is itself nine characters, so a nine-wide label column glued
    // it to the value: `veredictoCHANGES_REQUESTED`.
    expect(out).not.toContain("veredictoCHANGES_REQUESTED");
    expect(out).toMatch(/veredicto\s+CHANGES_REQUESTED/);
  });
});

describe("an empty hook list is not the same as no record", () => {
  /**
   * The recorder is inlined into the managed hooks, so it exists only once the
   * harness carrying it is on disk. Render or update it mid-session and the
   * agents that finished earlier show an empty list for a reason that has
   * nothing to do with hooks — nine of nineteen in the session that motivated
   * this. Rendering both as "—" makes the report claim something it cannot know.
   */
  const HORIZON = "2026-08-25T10:30:00Z";

  it("says 'sin registro' for an agent that finished before the recorder started", () => {
    const out = md([agent({ endedAt: "2026-08-25T10:20:00Z", hookEvents: [] })], {
      hookLogFrom: HORIZON,
    });
    expect(out).toContain("sin registro · el recorder arrancó a las 10:30:00Z");
  });

  it("keeps the plain dash for an agent the recorder DID cover", () => {
    const out = md([agent({ endedAt: "2026-08-25T10:40:00Z", hookEvents: [] })], {
      hookLogFrom: HORIZON,
    });
    expect(out).not.toContain("sin registro");
  });

  it("keeps the plain dash when the log recorded no hook at all", () => {
    const out = md([agent({ hookEvents: [] })], { hookLogFrom: null });
    expect(out).not.toContain("sin registro");
  });
});

describe("the orchestrator's hook counts declare the window they cover (#559)", () => {
  /**
   * The subagent case (#558) is an EMPTY list that needs explaining. The
   * orchestrator's is worse: its card spans the whole session, so a recorder
   * that started late leaves real counts drawn from part of the run —
   * `guard-destructive 212x` next to 298 Bash calls, with nothing saying 86
   * fired before the log existed. Printed beside subagent cards that DO declare
   * their gap, a bare number reads as the complete one.
   */
  const HORIZON = "2026-08-25T10:30:00Z";

  /** The orchestrator with hooks of its own, over a session that starts at 10:00. */
  function withOrchestratorHooks(over: Partial<SessionAudit> = {}): string {
    return md([agent()], {
      orchestrator: {
        ...session([]).orchestrator,
        toolCounts: { Bash: 298 },
        hookEvents: [
          {
            ts: "2026-08-25T10:35:00Z",
            name: "guard-destructive",
            phase: "PreToolUse",
            verdict: "allow",
            ms: 12,
            source: "core",
          },
        ],
      },
      ...over,
    });
  }

  it("marks the counts partial and states the fraction observed", () => {
    const out = withOrchestratorHooks({ hookLogFrom: HORIZON });
    expect(out).toContain("guard-destructive 1×");
    expect(out).toContain("parcial · el recorder cubre 50% de la sesión, desde 10:30:00Z");
    expect(out).toContain("30 min sin registrar");
  });

  it("says nothing when the recorder covered the whole session", () => {
    const out = withOrchestratorHooks({ hookLogFrom: null });
    expect(out).toContain("guard-destructive 1×");
    expect(out).not.toContain("parcial");
  });

  it("replaces the dash when the orchestrator recorded no hook of its own", () => {
    // A bare "—" under a late recorder claims the orchestrator ran no hook,
    // which is exactly what the log cannot say.
    const out = md([agent()], { hookLogFrom: HORIZON });
    expect(out).toContain("parcial · el recorder cubre 50% de la sesión");
  });

  it("renders the note in English too", () => {
    const report = buildReport([session([agent()], { hookLogFrom: HORIZON })], {
      repo: "demo",
      version: "0.6.5",
      catalog: CATALOG,
    });
    expect(renderMarkdown(report, "en")).toContain(
      "partial · the recorder covers 50% of the session, from 10:30:00Z (30 min unrecorded)",
    );
  });
});

/**
 * #584 — one histogram for a session that switched modes describes no moment of
 * it.
 *
 * The modes are not interchangeable: `auto` tells the model to work through the
 * shell and charges a classifier round-trip per command, `plan` forbids writing
 * outright. The report used to publish a single pile plus a note naming the
 * dominant mode — so "Bash 217" was unreadable, and every claim about how the
 * harness behaves outside `auto` was unfalsifiable from the report.
 */
describe("the tool histogram is split by permission mode (#584)", () => {
  const mixed = (over: Partial<SessionAudit> = {}): SessionAudit =>
    session([], {
      permissionModes: { auto: 53, plan: 4, acceptEdits: 4 },
      orchestrator: {
        ...session([]).orchestrator,
        toolCounts: { Bash: 30, Write: 1 },
        toolCountsByMode: {
          auto: { Bash: 20 },
          plan: { Bash: 9, Write: 1 },
          acceptEdits: { Bash: 1 },
        },
      },
      ...over,
    });

  const render = (s: SessionAudit): string =>
    renderMarkdown(buildReport([s], { repo: "demo", version: "0.6.5", catalog: CATALOG }), "es");

  it("prints one row per mode, busiest first", () => {
    const lines = render(mixed())
      .split("\n")
      .filter((l) => /^\s+(auto|plan|acceptEdits)\s/.test(l));
    expect(lines.map((l) => l.trim().split(/\s+/)[0])).toEqual(["auto", "plan", "acceptEdits"]);
  });

  it("keeps each mode's counts apart, which is the whole point", () => {
    const out = render(mixed());
    // The `Write` under `plan` is exactly the kind of thing a merged histogram
    // hides — plan mode forbids writing.
    expect(out).toMatch(/plan\s+Bash 9 · Write 1/);
    expect(out).toMatch(/auto\s+Bash 20/);
  });

  it("says the split covers the main thread only", () => {
    // A subagent's transcript declares no mode; inferring one from the parent
    // would be a guess dressed as a measurement.
    expect(render(mixed())).toContain("solo el hilo principal");
  });

  it("stays silent for a single-mode session", () => {
    const single = mixed({
      permissionModes: { auto: 10 },
      orchestrator: {
        ...session([]).orchestrator,
        toolCounts: { Bash: 20 },
        toolCountsByMode: { auto: { Bash: 20 } },
      },
    });
    // The card above already IS that histogram; repeating it under a heading
    // would be noise.
    expect(render(single)).not.toContain("por modo");
  });
});

/**
 * #559 follow-up — a caveat that walks itself back teaches the reader to skim
 * the next one. The line shipped as "parcial · el recorder cubre 100% de la
 * sesión", which contradicts itself in one breath: a gap that rounds away is
 * not a caveat.
 */
describe("a recorder gap that rounds away is not announced (#584)", () => {
  it("says nothing when coverage rounds to 100%", () => {
    const s = session([], {
      startedAt: "2026-08-25T10:00:00Z",
      wallClockMs: 20 * 60 * 60 * 1000,
      hookLogFrom: "2026-08-25T10:01:00Z", // one minute into twenty hours
    });
    const out = renderMarkdown(
      buildReport([s], { repo: "demo", version: "0.6.5", catalog: CATALOG }),
      "es",
    );
    expect(out).not.toContain("parcial");
  });

  it("still announces a gap big enough to change a number", () => {
    const s = session([], {
      startedAt: "2026-08-25T10:00:00Z",
      wallClockMs: 60 * 60 * 1000,
      hookLogFrom: "2026-08-25T10:30:00Z", // half the session unobserved
    });
    const out = renderMarkdown(
      buildReport([s], { repo: "demo", version: "0.6.5", catalog: CATALOG }),
      "es",
    );
    expect(out).toContain("parcial");
    expect(out).toContain("50%");
  });
});

/** Like `md`, but with the report's clock pinned so the live-session warning
 *  is deterministic. */
function mdAt(now: string, over: Partial<SessionAudit> = {}): string {
  const report = buildReport([session([], over)], {
    repo: "demo",
    version: "0.6.5",
    catalog: CATALOG,
    now: new Date(now),
  });
  return renderMarkdown(report, "es");
}

/**
 * The same session audited three hours apart reported 154 vs 184 Bash calls,
 * 1h13m vs 1h24m and 2 vs 4 PRs — both times as a total, because nothing read
 * the `stop` record the CLI had been writing all along.
 */
describe("session header: a run that is still going (#607)", () => {
  // The session ends at 11:00Z (see `session`).
  it("warns when the log is unsealed and the transcript just moved", () => {
    const out = mdAt("2026-08-25T11:10:00Z", { sealed: false });
    expect(out).toContain("**Sesión en curso.**");
    expect(out).toContain("navori audit --stop sess1");
  });

  it("stays silent for an old unsealed session, which is the common case", () => {
    // A session that ends normally seals itself now, but a killed run never
    // does, and neither does one whose close hook took a fail-open exit.
    // Those logs never gain a seal, so treating "unsealed" as "running" would
    // fire the warning on them forever.
    const out = mdAt("2026-08-28T11:00:00Z", { sealed: false });
    expect(out).not.toContain("Sesión en curso");
  });

  it("stays silent once the session is sealed, however recent", () => {
    const out = mdAt("2026-08-25T11:01:00Z", { sealed: true });
    expect(out).not.toContain("Sesión en curso");
  });
});

/**
 * `3f9cf38a` began under rendered 0.7.0; the rollout PR merged 26 minutes in
 * and the rest of the run worked under 0.7.5. One stamp credited it all to
 * 0.7.0 — in the report whose purpose is comparing versions.
 */
describe("session header: a harness that moved mid-session (#607)", () => {
  it("shows both readings when the rendered version moved", () => {
    const out = md([], {
      navori: { rendered: "0.7.0", cli: "0.7.5" },
      navoriAtStop: { rendered: "0.7.5", cli: "0.7.5" },
    });
    expect(out).toContain("navori 0.7.0 (CLI 0.7.5) → 0.7.5");
  });

  it("shows one when nothing moved", () => {
    const out = md([], {
      navori: { rendered: "0.7.5", cli: "0.7.5" },
      navoriAtStop: null,
    });
    // Scoped to the version segment: the range line of the header carries its
    // own arrow, so a bare `not.toContain("→")` would pass for the wrong reason.
    expect(out).toContain("navori 0.7.5 ·");
    expect(out).not.toContain("navori 0.7.5 →");
  });
});

/**
 * The orchestrator is where most of the spend happens — one audited session
 * billed 433k tokens with zero subagents — and its card never named the model
 * those tokens were priced at, while every subagent card did.
 */
describe("orchestrator card: which model spent the tokens (#607)", () => {
  const withModels = (models: Record<string, number>) =>
    md([], { orchestrator: { ...session([]).orchestrator, models } });

  it("names the model, like a subagent's card does", () => {
    expect(withModels({ "claude-opus-5": 554 })).toContain("claude-opus-5 · 1h 0m");
  });

  it("splits the messages when the session switched with /model", () => {
    const out = withModels({ "claude-opus-5": 400, "claude-sonnet-5": 154 });
    expect(out).toContain("claude-opus-5:400, claude-sonnet-5:154");
  });

  it("drops the segment when the transcript declared no model", () => {
    expect(withModels({})).toContain("1h 0m · 1 mensajes del usuario");
  });
});

/**
 * Audit finding A3 — thinking is a SUBSET of output, not a bucket beside it.
 *
 * Measured over the 1028 assistant messages of the reference transcript
 * (`4935c4d7`, CC 2.1.236): `output_tokens_details.thinking_tokens <=
 * output_tokens` in 100% of them. Both cards printed `output + thinking` as
 * "razonamiento", so every thinking token was counted twice — and `contexto`,
 * which is whatever is LEFT of the raw total, was understated by exactly the
 * same amount. In a report whose entire product is the number, that is the
 * most expensive kind of defect.
 */
describe("thinking counts once, inside output (A3)", () => {
  // Round values so `k()` is exact and the card's three lines add up by hand:
  // 17k startup + 2k reasoning + 83k context = 102k raw.
  const thinker = (over: Partial<AgentRun> = {}): AgentRun =>
    agent({
      startupTokens: 17_000,
      tokens: {
        ...emptyTokens(),
        output: 2000,
        thinking: 1000,
        cacheCreation: 100_000,
      },
      ...over,
    });

  it("prints the agent's reasoning as output alone", () => {
    // 2k, not the 3k the old `output + thinking` produced.
    expect(md([thinker()])).toMatch(/razonamiento\s+2k/);
  });

  it("names the thinking share as a sub-line, not as an addend", () => {
    expect(md([thinker()])).toContain("de los cuales ~1k thinking");
  });

  it("says nothing about thinking when there was none", () => {
    const out = md([
      thinker({
        tokens: { ...emptyTokens(), output: 2000, cacheCreation: 100_000 },
      }),
    ]);
    expect(out).not.toContain("de los cuales");
  });

  it("does the same on the orchestrator's card", () => {
    const out = md([], {
      orchestrator: {
        ...session([]).orchestrator,
        startupTokens: 5000,
        tokens: {
          ...emptyTokens(),
          output: 4000,
          thinking: 3000,
          cacheCreation: 50_000,
        },
      },
    });
    expect(out).toMatch(/razonamiento\s+4k/);
    expect(out).toContain("de los cuales ~3k thinking");
  });

  it("keeps the card's three lines inside the raw total of the body", () => {
    const out = md([thinker()]);
    // The raw headline and the card describe the same tokens: 17 + 2 + 83 = 102.
    // The weighted figure alongside it is a DIFFERENT scale on purpose: output
    // is 5x, cacheCreation 1.25x — 2000*5 + 100_000*1.25 = 135_000 ("135k"),
    // with cache_read at 0 in this fixture contributing nothing.
    expect(out).toContain("TOTAL 102k tokens (135k ponderados, equivalentes a input)");
    expect(out).toMatch(/arranque\s+17k/);
    expect(out).toMatch(/razonamiento\s+2k/);
    expect(out).toMatch(/contexto\s+83k/);
  });

  it("labels the headline row with the arithmetic it actually does", () => {
    const out = md([thinker()]);
    // The row always summed `total.output` alone; only its label claimed
    // otherwise, which is how the wrong formula looked authoritative.
    expect(out).not.toContain("razonamiento (output + thinking)");
    expect(out).toContain("razonamiento (output)");
  });

  it("renders the sub-line in English too", () => {
    const report = buildReport([session([thinker()])], {
      repo: "demo",
      version: "0.6.5",
      catalog: CATALOG,
    });
    const out = renderMarkdown(report, "en");
    expect(out).toContain("of which ~1k thinking");
    expect(out).toContain("reasoning (output)");
  });
});

/**
 * #927 — tokens weighted into input-token equivalents.
 *
 * `cache_read` used to be excluded from `billable()` entirely. Weighting it
 * down (0.1x by default) keeps it visible without letting it drown the rest —
 * and the weight has to resolve per model, because three models bill it at a
 * different rate.
 */
describe("weightedTokens: cache_read weighted per model (#927)", () => {
  it("applies the standard 0.1x default", () => {
    const t = { ...emptyTokens(), input: 100, cacheRead: 10_000 };
    // 100 input + 10_000 * 0.1 = 1100.
    expect(weightedTokens(t, "claude-sonnet-5")).toBe(1100);
  });

  it("falls back to the default for an unknown model instead of throwing", () => {
    const t = { ...emptyTokens(), cacheRead: 10_000 };
    expect(weightedTokens(t, "some-future-model-nobody-declared")).toBe(1000);
  });

  it("falls back to the default when the run carries no model at all", () => {
    const t = { ...emptyTokens(), cacheRead: 10_000 };
    expect(weightedTokens(t, null)).toBe(1000);
  });

  it("overrides to 0.025x for Claude Fable 5.1 and Claude Mythos 5.1", () => {
    const t = { ...emptyTokens(), cacheRead: 10_000 };
    expect(weightedTokens(t, "claude-fable-5-1-20260101")).toBe(250);
    expect(weightedTokens(t, "claude-mythos-5-1-20260101")).toBe(250);
  });

  it("overrides to 0.05x for Claude Opus 5.5", () => {
    const t = { ...emptyTokens(), cacheRead: 10_000 };
    expect(weightedTokens(t, "claude-opus-5-5-20260101")).toBe(500);
  });

  it("weights output at 5x and cache write at 1.25x, uniformly across models", () => {
    const t = { ...emptyTokens(), output: 100, cacheCreation: 100 };
    // 100*5 + 100*1.25 = 625, same regardless of which model ran it.
    expect(weightedTokens(t, "claude-opus-5")).toBe(625);
    expect(weightedTokens(t, "claude-haiku-4-5")).toBe(625);
  });
});

/**
 * #927 — the rankings sort by the weighted axis, not the excluding one.
 *
 * `billable()` excluded `cache_read`, so an agent whose spend was almost
 * entirely re-reads of cached context ranked as nearly free. Weighting makes
 * that spend visible in the sort key too — otherwise the ranking and the
 * headline would describe two different sessions.
 */
describe("rankings order by the weighted axis (#927)", () => {
  const cacheHeavy = agent({
    agentId: "ag_cache",
    agentType: "implementer",
    description: "reads a lot of cached context",
    // Fable 5.1's 0.025x override still outweighs a small reasoning-heavy run:
    // 10_000_000 * 0.025 = 250_000.
    model: "claude-fable-5-1",
    tokens: { ...emptyTokens(), cacheRead: 10_000_000 },
    startupTokens: 0,
  });
  const reasoningHeavy = agent({
    agentId: "ag_reason",
    agentType: "reviewer",
    description: "does a lot of actual reasoning",
    model: "claude-sonnet-5",
    // Raw (old billable) total is 1000 — bigger than cacheHeavy's raw total of
    // 0, since cache_read was excluded there. Weighted, cacheHeavy wins.
    tokens: { ...emptyTokens(), output: 1000 },
    startupTokens: 0,
  });

  // Covers: R10, R11
  it("puts the cache-heavy agent first in the timeline", () => {
    const out = md([reasoningHeavy, cacheHeavy]);
    const timeline = out.split("### Línea de tiempo")[1] ?? "";
    expect(timeline.indexOf("implementer")).toBeGreaterThanOrEqual(0);
    expect(timeline.indexOf("implementer")).toBeLessThan(timeline.indexOf("reviewer"));
  });

  // Covers: R10, R11
  it("puts the cache-heavy agent's card first", () => {
    const out = md([reasoningHeavy, cacheHeavy]);
    const cards = out.split("### Ficha por agente")[1] ?? "";
    expect(cards.indexOf("implementer")).toBeGreaterThanOrEqual(0);
    expect(cards.indexOf("implementer")).toBeLessThan(cards.indexOf("reviewer"));
  });

  // Covers: R10, R11
  it("puts the cache-heavy type first in the by-agent-type table", () => {
    const out = md([reasoningHeavy, cacheHeavy]);
    const byType = out.split("### Por tipo de agente")[1] ?? "";
    expect(byType.indexOf("implementer")).toBeGreaterThanOrEqual(0);
    expect(byType.indexOf("implementer")).toBeLessThan(byType.indexOf("reviewer"));
  });
});

describe("the host's own queued messages are stated, not silently dropped (A4)", () => {
  it("reports the discard beside the human count", () => {
    const out = md([], { prompts: { typed: 2, queued: 1, queuedSystem: 415 } });
    expect(out).toContain("**Mensajes del usuario:** 3");
    expect(out).toContain("el host encoló 415 mensajes suyos");
  });

  it("states it even when no human message was queued, which is the common case", () => {
    // 415 host notifications against zero queued human messages is what a real
    // session looks like here; the old counter read all 415 as things the
    // human said.
    const out = md([], { prompts: { typed: 2, queued: 0, queuedSystem: 415 } });
    expect(out).toContain("**Mensajes del usuario:** 2, todos al inicio de un turno.");
    expect(out).toContain("el host encoló 415 mensajes suyos");
  });

  it("says nothing when the host queued nothing", () => {
    const out = md([], { prompts: { typed: 2, queued: 1, queuedSystem: 0 } });
    expect(out).not.toContain("el host encoló");
  });

  it("renders in English too", () => {
    const report = buildReport(
      [session([], { prompts: { typed: 2, queued: 1, queuedSystem: 9 } })],
      { repo: "demo", version: "0.6.5", catalog: CATALOG },
    );
    expect(renderMarkdown(report, "en")).toContain("the host queued 9 messages of its own");
  });
});

/**
 * El agregado de skills del rango (#725, A5).
 *
 * "¿se están usando las skills?" es una pregunta de PARQUE y el pipeline la
 * respondía por sesión, así que se respondió a mano una vez —"8 de 12 nunca
 * invocadas en 48h"— y ese número fijó una moratoria. Esta tabla es ese número,
 * calculado en vez de ensamblado.
 */
describe("totals.skills — el histograma del rango", () => {
  const build = (sessions: SessionAudit[], skills: string[]) =>
    buildReport(sessions, {
      repo: "demo",
      version: "0.6.5",
      catalog: { ...CATALOG, skills, managedSkills: skills },
    });

  const withSkills = (
    list: Array<{
      slug: string;
      source: "skill-tool" | "attribution" | "skill-md";
      records?: number;
      tokens?: number;
    }>,
  ) =>
    session([], {
      orchestrator: {
        ...session([]).orchestrator,
        skills: list.map((s) => ({
          slug: s.slug,
          source: s.source,
          ...(s.records !== undefined ? { attributedRecords: s.records } : {}),
          ...(s.tokens !== undefined ? { attributedOutputTokens: s.tokens } : {}),
        })),
        skillsRead: list.map((s) => s.slug),
      },
    });

  it("cuenta las tres vías por separado y NO las suma", () => {
    const r = build(
      [
        withSkills([{ slug: "a", source: "skill-tool" }]),
        withSkills([{ slug: "a", source: "attribution", records: 20, tokens: 5000 }]),
        withSkills([{ slug: "a", source: "skill-md" }]),
      ],
      ["a"],
    );
    expect(r.totals.skills).toEqual([
      {
        slug: "a",
        invoked: 1,
        inherited: 1,
        browsed: 1,
        records: 20,
        outputTokens: 5000,
      },
    ]);
  });

  it("cuenta SESIONES, no detecciones: el mismo slug en varias corridas es una", () => {
    const s = session([agent({ skills: [{ slug: "a", source: "skill-tool" }] })], {
      orchestrator: {
        ...session([]).orchestrator,
        skills: [{ slug: "a", source: "skill-tool" }],
        skillsRead: ["a"],
      },
    });
    expect(build([s], ["a"]).totals.skills[0]?.invoked).toBe(1);
  });

  it("da fila a una skill declarada que no hizo nada", () => {
    // La mitad de la pregunta que decide si una skill se queda en el catálogo.
    const r = build([withSkills([])], ["nunca-usada"]);
    expect(r.totals.skills).toEqual([
      {
        slug: "nunca-usada",
        invoked: 0,
        inherited: 0,
        browsed: 0,
        records: 0,
        outputTokens: 0,
      },
    ]);
  });

  it("descarta el ruido de la heurística: solo-abierta y no declarada", () => {
    // `SKILL_PATH_RE` casa `<palabra>/SKILL.md` en cualquier comando, así que una
    // ruta escrita en prosa o un patrón de grep producen un slug. En este repo
    // aparecieron `bare`, `buena`, `dup`, `real` y `memory`. Por sesión era
    // sobrevivible; en una tabla que dice listar las skills del repo, se lee
    // como un hecho.
    const r = build([withSkills([{ slug: "buena", source: "skill-md" }])], ["real-skill"]);
    expect(r.totals.skills.map((s) => s.slug)).toEqual(["real-skill"]);
  });

  it("pero conserva una NO declarada que sí se invocó", () => {
    // El filtro es sobre la EVIDENCIA, no sobre el catálogo: algo que corrió y
    // este repo no declara es un hallazgo, no ruido.
    const r = build([withSkills([{ slug: "de-otro-lado", source: "skill-tool" }])], ["real-skill"]);
    expect(r.totals.skills.map((s) => s.slug)).toContain("de-otro-lado");
  });

  it("la sección dice cuántas no hicieron nada", () => {
    const r = build(
      [withSkills([{ slug: "usada", source: "skill-tool" }])],
      ["usada", "dormida", "otra-dormida"],
    );
    const out = renderMarkdown(r, "es");
    expect(out).toContain("## Skills en el rango");
    expect(out).toContain("**2 de 3** no se invocaron ni se heredaron");
  });
});

/**
 * #924 — the hooks block printed one total per hook name with no arithmetic
 * BETWEEN the rows, so adding the column added hooks that ran AT THE SAME TIME.
 * Over this repo's own store the column said 1,564.3s where the blocking cost
 * was 928.1s, and that 1.69x already produced a documented false conclusion
 * (a hook argued for on latency grounds it saves ~3ms of).
 *
 * The fixture is ONE REAL host tool call lifted verbatim from
 * `~/.navori/audits/navori-harness/`: `toolu_0112ZZBL716tqEDSLigb8tci`, five
 * hooks racing on its `PreToolUse` plus one on its `PostToolUse`. It is the
 * smallest slice that exercises BOTH halves of the grouping key, which is why
 * an invented fixture would not do: the phase is what keeps the Pre and the
 * Post — genuinely sequential — from being merged into one 43ms event.
 */
describe("peaje por evento de hooks concurrentes (#924)", () => {
  /** The `PreToolUse` fan-out of one real Bash call. Max 43ms, sum 114ms. */
  const REAL_PRE: HookEvent[] = [
    { name: "guard-destructive", verdict: "skip", ms: 18, source: "core" },
    {
      name: "quality-gate-pre-commit",
      verdict: "skip",
      ms: 17,
      source: "core",
    },
    { name: "check-jscpd", verdict: "allow", ms: 17, source: "plugin:jscpd" },
    {
      name: "check-semgrep",
      verdict: "allow",
      ms: 19,
      source: "plugin:semgrep",
    },
    { name: "model-advisor", verdict: "skip", ms: 43, source: "core" },
  ].map((e) => ({
    ...e,
    ts: "2026-09-21T14:38:01Z",
    phase: "PreToolUse",
    agentId: "a3c95de62d202e757",
    toolUseId: "toolu_0112ZZBL716tqEDSLigb8tci",
  }));

  /** The `PostToolUse` of the SAME tool call: same id, different phase. */
  const REAL_POST: HookEvent = {
    ts: "2026-09-21T14:38:01Z",
    name: "managed-drift-watch",
    phase: "PostToolUse",
    verdict: "skip",
    ms: 33,
    source: "core",
    agentId: "a3c95de62d202e757",
    toolUseId: "toolu_0112ZZBL716tqEDSLigb8tci",
  };

  /** A real `SessionEnd` run: no `toolUseId`, because nothing else has one. */
  const REAL_SESSION_END: HookEvent = {
    ts: "2026-09-21T14:40:00Z",
    name: "worktree-reclaim",
    phase: "SessionEnd",
    verdict: "clean",
    ms: 835,
    source: "core",
    agentId: "orchestrator",
  };

  function withHooks(hookEvents: HookEvent[]): string {
    return md([], {
      orchestrator: { ...session([]).orchestrator, hookEvents },
    });
  }

  it("cobra el más lento de cada evento y deja ver la suma que NO se paga", () => {
    const out = withHooks([...REAL_PRE, REAL_POST]);
    // Two events, not six: 43ms (the slowest of the fan-out) + 33ms.
    expect(out).toContain("peaje por evento: 76ms en 2 eventos");
    // The naive figure stays visible and labelled as what it is — hiding it
    // would trade one wrong reading for a missing one.
    expect(out).toContain("las filas de arriba suman 147ms");
    expect(out).toContain("1 eventos de hooks en paralelo");
    // The per-hook rows survive untouched: they answer another question.
    expect(out).toContain("model-advisor 1×");
    expect(out).toContain("managed-drift-watch 1×");
  });

  it("nombra a quien marca el paso con su ahorro contrafactual, no con su total", () => {
    const out = withHooks([...REAL_PRE, REAL_POST]);
    expect(out).toContain("marca el paso model-advisor en 1 de 1");
    // 24ms, not its 43ms total: removing it promotes check-semgrep's 19ms.
    // This is the number that says whether retiring a hook buys latency.
    expect(out).toContain("retirarlo bajaría el peaje 24ms");
  });

  it("deja intacta la suma de las fases de ciclo de vida", () => {
    const out = withHooks([...REAL_PRE, REAL_POST, REAL_SESSION_END]);
    // 43 + 33 + 835. The SessionEnd run is its own event because it carries no
    // `toolUseId`, and that is the CORRECT treatment, not a fallback: Claude
    // Code gives every SessionEnd hook a shared 1.5s budget, so there the sum
    // is what describes the wait. Keying on the id makes it fall out.
    expect(out).toContain("peaje por evento: 911ms en 3 eventos");
  });

  it("calla cuando ningún hook compitió con otro", () => {
    const out = withHooks([REAL_POST]);
    expect(out).toContain("managed-drift-watch 1×");
    // With one hook per event the toll IS the total. Printing it twice teaches
    // the reader to skim the next line. (The block's footnote names the figure
    // in prose either way, hence the colon: what must be absent is the ROW.)
    expect(out).not.toContain("peaje por evento:");
  });
});

describe("range sections (spec 0039 F0b)", () => {
  const hookEvent = (over: Partial<HookEvent> = {}): HookEvent => ({
    ts: "2026-08-25T10:00:00Z",
    name: "guard-destructive",
    phase: "PreToolUse",
    verdict: "allow",
    ms: 10,
    source: "core",
    tool: "Bash",
    ...over,
  });

  function range(
    agents: AgentRun[],
    over: Partial<SessionAudit> = {},
    managedAgents: string[] = [],
  ) {
    const s = session(agents, over);
    const report = buildReport([s], {
      repo: "demo",
      version: "0.11.0",
      catalog: CATALOG,
      managedAgents,
      lang: "en",
    });
    return { report, md: renderMarkdown(report, "en") };
  }

  // Covers: R46
  it("lists every declared agent with its session count, zeros included", () => {
    const { report, md } = range([agent({ agentType: "implementer" })]);
    expect(report.rangeMetrics["agent.implementer.sessions"]).toBe(1);
    expect(report.rangeMetrics["agent.researcher.sessions"]).toBe(0);
    expect(report.rangeMetrics["agent.claude.sessions"]).toBe(0);
    expect(md).toContain("## Agents over the range");
    expect(md).toContain("| `researcher` | 0 | 0 |");
  });

  // Covers: R47
  it("flags an unused managed agent as a candidate with the sessions it rests on, never an own one", () => {
    const { report } = range([agent({ agentType: "implementer" })], {}, [
      "researcher",
      "implementer",
    ]);
    const candidate = report.rangeSignals.find((x) => x.kind === "unused-managed-candidates");
    expect(candidate?.summary).toContain("1 sessions");
    expect(candidate?.evidence).toContain("researcher");
    // `claude` is declared and unused but not managed: the user's to judge.
    expect(candidate?.evidence).not.toContain("claude");
    expect(candidate?.evidence).not.toContain("implementer");
  });

  // Covers: R63
  it("groups hooks per Bash call by toolUseId and sums fires and time per hook", () => {
    const events = [
      hookEvent({ toolUseId: "t1", name: "guard-destructive", ms: 10 }),
      hookEvent({ toolUseId: "t1", name: "routing-watch", ms: 5 }),
      hookEvent({
        toolUseId: "t1",
        name: "routing-watch",
        phase: "PostToolUse",
        ms: 5,
      }),
      hookEvent({ toolUseId: "t2", name: "guard-destructive", ms: 30 }),
      // Not a Bash call: never part of the per-call figure.
      hookEvent({ toolUseId: "t3", tool: "Read", name: "guard-destructive" }),
    ];
    const { report, md } = range([agent({ hookEvents: events })]);
    const m = report.rangeMetrics;
    expect(m["hooks.bashCalls"]).toBe(2);
    // t1 ran three distinct hook executions, t2 one: mean 2.
    expect(m["hooks.perBashCall"]).toBe(2);
    expect(m["hooks.perBashCall.p90"]).toBe(3);
    expect(m["hook.guard-destructive.fires"]).toBe(3);
    expect(m["hook.guard-destructive.ms"]).toBe(10 + 30 + 10);
    expect(md).toContain("Hooks per Bash call: **2**");
  });

  // Covers: R66
  // Covers: R10, R11
  it("groups blocks per rule while withholding command examples in every generation", () => {
    const secret = "ghp_abcdefghijklmnop1234";
    const blocked: Record<string, string> = {};
    const events: HookEvent[] = [];
    for (let i = 0; i < 5; i++) {
      blocked[`t${i}`] = `git push https://x:${secret}@host/r --token ${secret} ${"y".repeat(400)}`;
      events.push(
        hookEvent({
          toolUseId: `t${i}`,
          verdict: "block",
          reason: "rule 4: force push",
        }),
      );
    }
    const { report, md } = range([agent({ hookEvents: events, blockedCommands: blocked })]);
    expect(report.rangeMetrics["hook.guard-destructive.blocks"]).toBe(5);
    expect(report.rangeMetrics["hook.guard-destructive.blocks.rule 4: force push"]).toBe(5);
    expect(publishReport(report).rangeMetrics["hook.guard-destructive.blocks"]).toBe(5);
    const examples = md.split("\n").filter((l) => l.startsWith("  - `git push"));
    expect(examples).toHaveLength(0);
    expect(renderMarkdown(report, "en", { includeHumanContent: true })).not.toContain("git push");
    expect(md).not.toContain(secret);
    // Free text never reaches the flat metrics.
    expect(JSON.stringify(report.rangeMetrics)).not.toContain("git push");
  });

  // Covers: R70, R10, R11
  it("tabulates any name x verdict from hooks and CLI events", () => {
    const { report, md } = range(
      [
        agent({
          hookEvents: [hookEvent({ name: "fixture-hook", verdict: "advise" })],
        }),
      ],
      {
        cliEvents: [
          {
            tsMs: 1,
            event: "cli",
            name: "fixture-cli",
            verdict: "reject",
            reason: "r",
          },
          { tsMs: 2, event: "cli", name: "fixture-cli", verdict: "reject" },
          { tsMs: 3, event: "cli", name: "fixture-cli", verdict: "accept" },
        ],
      },
    );
    expect(report.rangeMetrics["mechanism.fixture-cli.reject"]).toBe(2);
    expect(report.rangeMetrics["mechanism.fixture-cli.accept"]).toBe(1);
    expect(report.rangeMetrics["mechanism.fixture-hook.advise"]).toBe(1);
    expect(md).toContain("## Mechanisms: name × verdict");
    expect(md).toContain(`| \`${opaqueLabel("fixture-cli")}\` | 1 | 0 | 2 |`);
    expect(md).not.toContain("fixture-cli");
  });

  // Covers: R16
  it("keeps review-outcome events out of the mechanism tally and its public labels readable", () => {
    const { report, md } = range([agent({})], {
      cliEvents: [
        { tsMs: 1, event: "cli", name: "review-outcome", verdict: "approved" },
        { tsMs: 2, event: "cli", name: "fixture-cli", verdict: "reject" },
      ],
    });
    expect(Object.keys(report.rangeMetrics).some((key) => key.includes("review-outcome"))).toBe(
      false,
    );
    expect(report.rangeMetrics["mechanism.fixture-cli.reject"]).toBe(1);
    expect(md).not.toContain("review-outcome");
  });

  // Covers: R70
  it("counts evidence rejection and repeat-failure advice as separate mechanisms", () => {
    const { report, md } = range(
      [
        agent({
          hookEvents: [hookEvent({ name: "bash-outcome-watch", verdict: "advise" })],
        }),
      ],
      {
        cliEvents: [
          {
            tsMs: 1,
            event: "cli",
            name: "plan-update-evidence",
            verdict: "block",
          },
        ],
      },
    );
    expect(report.rangeMetrics["mechanism.bash-outcome-watch.advise"]).toBe(1);
    expect(report.rangeMetrics["mechanism.plan-update-evidence.block"]).toBe(1);
    expect(md).toContain("`bash-outcome-watch`");
    expect(md).toContain("`plan-update-evidence`");
  });
});

describe("review/receipt outcomes in the report (spec 0042 T9b)", () => {
  const hex = (c: string): string => c.repeat(64);
  const identity = {
    alg: "navori-content/v1",
    fp: hex("1"),
    base: "b".repeat(40),
    gate: hex("2"),
    inputs: hex("3"),
  };
  const at = (hhmm: string): number => Date.parse(`2026-08-25T${hhmm}:00Z`);
  const reviewEvent = (over: Partial<ReviewOutcome> = {}, tsMs = at("10:30")): CliEvent => {
    const outcome: ReviewOutcome = {
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
      startedAtMs: Date.parse("2026-08-25T10:00:00Z"),
      sealedAtMs: Date.parse("2026-08-25T10:30:00Z"),
      head: "c".repeat(40),
      ...identity,
      ...over,
    };
    return {
      tsMs,
      event: "cli",
      name: outcome.name,
      verdict: outcome.verdict,
      outcomePayload: outcome,
    };
  };
  const receiptEvent = (tsMs = at("10:31")): CliEvent => {
    const outcome: ReceiptOutcome = {
      name: "receipt-outcome",
      verdict: "ok",
      schemaVersion: 1,
      featureKey: hex("f"),
      action: "check",
      freshness: "fresh",
      identity: "stable",
      receipt: hex("4"),
      ...identity,
    };
    return {
      tsMs,
      event: "cli",
      name: outcome.name,
      verdict: outcome.verdict,
      outcomePayload: outcome,
    };
  };
  const build = (sessions: SessionAudit[]) =>
    buildReport(sessions, {
      repo: "synthetic",
      version: "0.1.0",
      catalog: CATALOG,
      requestedRange: { from: "2026-08-25", to: "2026-08-26" },
    });

  // Covers: R16
  it("adds an additive outcomes key to schema 11 with availability per kind", () => {
    const report = build([
      session([], { sessionId: "with", cliEvents: [reviewEvent(), receiptEvent()] }),
      session([], { sessionId: "silent" }),
    ]);
    const json = JSON.parse(renderJson(report));
    expect(json.schemaVersion).toBe(11);
    expect(json.outcomes).toMatchObject({
      schemaVersion: 1,
      totals: { tasks: 1, accepted: 1, open: 0, ambiguous: 0 },
    });
    const [task] = json.outcomes.tasks;
    expect(task.feature).toMatch(/^unknown-[a-f0-9]{12}$/);
    expect(task.episodes[0]).toMatchObject({
      accepted: true,
      leftCensored: false,
      reviews: { rounds: 1, approved: 1, correlated: 1, uncorrelatedByReason: {} },
      receipts: { observations: 1, ok: 1, fresh: 1 },
    });
    // The silent session is unknown, not "no review": partial, never zero-observed.
    for (const kind of ["outcomes.review", "outcomes.receipt"]) {
      expect(json.availability[kind]).toMatchObject({
        state: "partial",
        eligible: 2,
        observed: 1,
        unavailable: 1,
      });
    }
  });

  const dispatchEvent = (spawnId: string | undefined, tsMs = at("09:59")): CliEvent => ({
    tsMs,
    event: "cli",
    name: "dispatch-outcome",
    verdict: "allow",
    outcomePayload: {
      name: "dispatch-outcome",
      verdict: "allow",
      schemaVersion: 1,
      featureKey: hex("e"),
      stage: "implement",
      ...(spawnId ? { spawn: spawnId } : {}),
    },
  });

  // Covers: R17
  it("exposes dispatch availability and orphan counts inside outcomes only", () => {
    const report = build([
      session([agent({ spawnToolUseId: "toolu_ok" })], {
        sessionId: "claude-s",
        cliEvents: [reviewEvent(), dispatchEvent("toolu_ok"), dispatchEvent("toolu_lost")],
      }),
      session([], { sessionId: "codex-s", host: "codex", cliEvents: [dispatchEvent("c1")] }),
      session([], { sessionId: "silent" }),
    ]);
    const json = JSON.parse(renderJson(report));
    expect(json.outcomes.dispatch).toEqual({
      events: 3,
      confirmed: 1,
      unconfirmed: 1,
      unlinkable: 1,
      nestedUnlinked: 0,
      dispatchWithoutRounds: 1,
      roundsWithoutDispatch: 1,
    });
    // Codex is partial (never a full observation), a silent session is unknown.
    expect(json.availability["outcomes.dispatch"]).toMatchObject({
      state: "partial",
      eligible: 3,
      observed: 1,
      partial: 1,
      unavailable: 1,
    });
    expect(renderJson(report)).not.toContain("spawnToolUseId");
    expect(renderJson(report)).not.toContain("toolu_ok");
  });

  // Covers: R17
  it("reports dispatch availability as unknown, not zero, when no session logged one", () => {
    const json = JSON.parse(renderJson(build([session([], { cliEvents: [reviewEvent()] })])));
    expect(json.availability["outcomes.dispatch"]).toMatchObject({
      state: "unavailable",
      observed: 0,
      eligible: 1,
    });
    expect(json.outcomes).not.toHaveProperty("dispatch");
  });

  // Covers: R17
  it("keeps the dispatch field names hashed outside the outcomes subtree", () => {
    const report = build([session([], { cliEvents: [reviewEvent(), dispatchEvent("toolu_x")] })]);
    Object.assign(report.rangeMetrics, { "tokens.confirmed.unlinkable": 1 });
    const published = publishReport(report);
    expect(Object.keys(published.rangeMetrics)).not.toContain("tokens.confirmed.unlinkable");
    expect(published.outcomes?.dispatch).toMatchObject({ events: 1, unconfirmed: 1 });
    expect(published.availability).toHaveProperty("outcomes.dispatch");
  });

  describe("task efficiency and lifecycle (spec 0042 T10b)", () => {
    const dispatchOf = (spawn: string, tsMs: number): CliEvent => ({
      tsMs,
      event: "cli",
      name: "dispatch-outcome",
      verdict: "allow",
      outcomePayload: {
        name: "dispatch-outcome",
        verdict: "allow",
        schemaVersion: 1,
        featureKey: hex("f"),
        stage: "implement",
        spawn,
      },
    });
    const accepted = (spawn = "toolu_secret"): SessionAudit =>
      session([agent({ spawnToolUseId: spawn, activeIntervals: [[at("09:00"), at("09:30")]] })], {
        sessionId: "impl",
        sealed: true,
        availability: {
          ...session([]).availability,
          activeMs: {
            state: "observed",
            reason: null,
            source: "audit-log",
            adapter: "audit-log",
            sourceVersion: null,
          },
        },
        idleBetweenTurns: [[at("09:40"), at("09:50")]],
        cliEvents: [dispatchOf(spawn, at("09:00")), reviewEvent(), receiptEvent()],
      });

    // Covers: R17, R18
    it("publishes episode and summary figures inside outcomes with real numbers and null for the unknown", () => {
      const report = build([accepted()]);
      const json = JSON.parse(renderJson(report));
      // The allowlist drops nothing the join produced: no field name or label is lost or hashed.
      expect(json.outcomes).toEqual(JSON.parse(JSON.stringify(report.outcomes)));
      const episode = json.outcomes.tasks[0].episodes[0];
      expect(json.schemaVersion).toBe(11);
      expect(episode.efficiency).toMatchObject({
        tokenScope: "implementer-dispatch",
        attributedRuns: 1,
        rounds: 1,
        firstApproval: true,
      });
      expect(typeof episode.efficiency.tokens.output).toBe("number");
      expect(episode.lifecycle).toMatchObject({
        start: "dispatch",
        elapsedMs: at("10:31") - at("09:00"),
        // 30 min of the run's tool pairs + the 30 min review, not the idle gap.
        active: { value: 3_600_000, state: "observed" },
        idleBetweenTurns: { value: at("09:50") - at("09:40"), state: "observed" },
        idleHost: "claude",
      });
      const { r17, r18, unattributed } = json.outcomes.summary;
      expect(r17.tokenScope).toBe("implementer-dispatch");
      expect(r17.tokenCoverage).toEqual({ episodes: 1, withDispatch: 1, withoutDispatch: 0 });
      expect(r17.tokensPerAcceptedTask.output).toMatchObject({ n: 1, eligible: 1, censored: 0 });
      expect(r18.timeToAcceptance).toMatchObject({ n: 1, state: "observed" });
      expect(r18.idleBetweenTurns.codex).toMatchObject({ n: 0, p50: null, state: "unavailable" });
      expect(unattributed.runs).toEqual({ attributed: 1, unattributed: 0 });
      // Unknown stays null in the JSON, never 0: this task has no gate execution at all.
      expect(r17.gate).toMatchObject({ executions: 0, failures: 0, withoutGateExecution: 1 });
    });

    // Covers: R17, R18
    it("publishes every reason and state label of unobserved, open and Codex tasks unchanged", () => {
      const codex = session([], {
        sessionId: "cx",
        host: "codex",
        cliEvents: [reviewEvent({ featureKey: hex("c"), nonce: undefined }), receiptEvent()],
      });
      const open = session([], {
        sessionId: "open",
        cliEvents: [
          dispatchOf("toolu_open", at("09:00")),
          reviewEvent({
            featureKey: hex("d"),
            verdict: "changes-requested",
            correlation: "missing",
          }),
        ],
      });
      const report = build([accepted(), codex, open]);
      const json = JSON.parse(renderJson(report));
      expect(json.outcomes).toEqual(JSON.parse(JSON.stringify(report.outcomes)));
      const text = JSON.stringify(json.outcomes);
      for (const label of ["no-dispatch-event", "ownership-unknown", "censored", "no-source"])
        expect(text).toContain(label);
      expect(text).not.toMatch(/"(?:reason|state|idleHost|start|tokenScope)":"unknown-/);
    });

    // Covers: R17, R18
    it("never publishes join keys, spawn ids or raw intervals", () => {
      const text = renderJson(build([accepted()]));
      for (const secret of ["toolu_secret", "spawnToolUseId", "activeIntervals", "featureKey"])
        expect(text).not.toContain(secret);
      expect(text).not.toMatch(/"idleBetweenTurns":\s*\[/);
    });

    // Covers: R17, R18
    it("scopes the new field names to the outcomes subtree and leaves the global allowlists alone", () => {
      const report = build([accepted()]);
      Object.assign(report, { efficiency: { tokens: { output: 1 } }, unattributed: { runs: 1 } });
      Object.assign(report.sessions[0] as object, { lifecycle: { elapsedMs: 5 } });
      const published = JSON.parse(renderJson(report));
      for (const leaked of ["efficiency", "unattributed", "lifecycle"]) {
        expect(published).not.toHaveProperty(leaked);
        expect(published.sessions[0]).not.toHaveProperty(leaked);
      }
      expect(published.outcomes.summary).toBeDefined();
      expect(Object.keys(published.rangeMetrics).join()).not.toMatch(
        /efficiency|lifecycle|accepted/,
      );
    });

    // Covers: R17, R18
    it("renders a short Markdown section with scope, censoring and the quality caveat", () => {
      const md = renderMarkdown(build([accepted()]), "en");
      expect(md).toContain("Efficiency per accepted task");
      expect(md).toContain("Lifecycle");
      expect(md).toContain("implementer-dispatch");
      expect(md).toContain("Fewer tokens does not mean better quality");
      expect(md).toMatch(/Time to acceptance \(from dispatch\) \| \d+s/);
      // Without a summary (no episode) there is no section.
      expect(renderMarkdown(build([session([])]), "en")).not.toContain("Efficiency per accepted");
    });
  });

  // Covers: R16
  it("reports unknown availability and no outcomes key when no session logged one", () => {
    const json = JSON.parse(renderJson(build([session([])])));
    expect(json).not.toHaveProperty("outcomes");
    expect(json.availability["outcomes.review"]).toMatchObject({
      state: "unavailable",
      observed: 0,
      eligible: 1,
    });
  });

  // Covers: R16
  it("publishes no hash, raw payload or reason outside the closed vocabulary", () => {
    const stray = reviewEvent(
      {
        correlation: "changed-after-review",
        fp: undefined,
        alg: undefined,
        gate: undefined,
        inputs: undefined,
        base: undefined,
        head: undefined,
        nonce: "00000000-0000-4000-8000-000000000002",
        sealedAtMs: at("10:45"),
      },
      at("10:45"),
    );
    const text = renderJson(
      build([session([], { cliEvents: [reviewEvent(), receiptEvent(), stray] })]),
    );
    expect(text).not.toMatch(/[a-f0-9]{40,}/);
    expect(text).not.toContain("outcomePayload");
    expect(text).not.toContain("featureKey");
    const episode = JSON.parse(text).outcomes.tasks[0].episodes[0];
    expect(episode.reviews.uncorrelatedByReason).toEqual({ "changed-after-review": 1 });
    expect(episode.boundary).toBe("ambiguous");
  });

  // Covers: R16
  it("keeps outcome events out of the mechanism tally and renders a short section", () => {
    const report = build([session([], { cliEvents: [reviewEvent(), receiptEvent()] })]);
    expect(Object.keys(report.rangeMetrics).some((key) => key.includes("-outcome"))).toBe(false);
    const md = renderMarkdown(report, "en");
    expect(md).toContain("Review outcomes");
    expect(md).toContain("1 tasks · 1 locally accepted");
    expect(md).not.toContain("receipt-outcome");
  });

  // Covers: R16
  it("renders old v11 reports without outcomes unchanged", () => {
    const report = build([session([])]);
    expect(report.outcomes).toBeUndefined();
    expect(renderMarkdown(report, "en")).not.toContain("Review outcomes");
  });

  // Covers: R16
  it("never invokes checkReceipt, signReceipt or spawns git while building and rendering", () => {
    vi.mocked(checkReceipt).mockClear();
    vi.mocked(signReceipt).mockClear();
    for (const fn of [spawn, spawnSync, execFileSync]) vi.mocked(fn).mockClear();
    const report = build([session([], { cliEvents: [reviewEvent(), receiptEvent()] })]);
    renderJson(report);
    renderMarkdown(report, "en");
    publishReport(report);
    expect(checkReceipt).not.toHaveBeenCalled();
    expect(signReceipt).not.toHaveBeenCalled();
    for (const fn of [spawn, spawnSync, execFileSync]) expect(fn).not.toHaveBeenCalled();
  });

  // Covers: R16
  it("publishes the outcomes block but keeps hashing generic key parts outside it", () => {
    const report = build([session([], { cliEvents: [reviewEvent(), receiptEvent()] })]);
    Object.assign(report.rangeMetrics, { "tokens.open.error": 3 });
    Object.assign(report.availability ?? {}, {
      "tokens.ok.findings": report.availability?.["outcomes.review"],
    });
    const published = publishReport(report);
    // Outside outcomes: parts that merely equal an outcomes field name stay hashed.
    expect(Object.keys(published.rangeMetrics)).toContain(
      `tokens.${opaqueLabel("open")}.${opaqueLabel("error")}`,
    );
    expect(Object.keys(published.rangeMetrics)).not.toContain("tokens.open.error");
    expect(Object.keys(published.availability)).toContain(
      `tokens.${opaqueLabel("ok")}.${opaqueLabel("findings")}`,
    );
    // Inside outcomes (and its two availability entries): fields still published.
    expect(published.availability).toHaveProperty("outcomes.review");
    expect(published.availability).toHaveProperty("outcomes.receipt");
    expect(published.outcomes?.tasks[0]?.episodes[0]).toMatchObject({
      accepted: true,
      reviews: { rounds: 1, approved: 1, correlated: 1 },
      receipts: { observations: 1, ok: 1, fresh: 1 },
    });
  });
});

describe("comparison and recommendations in the published report (spec 0042 T11)", () => {
  const build = (sessions: SessionAudit[]) =>
    buildReport(sessions, { repo: "demo", version: "0.11.2", catalog: CATALOG });
  const comparison = (key: string): NonNullable<AuditReport["comparison"]> => ({
    base: {
      format: 2,
      scope: "repo",
      range: { from: "2026-09-01", to: "2026-09-08" },
      sessions: 3,
    },
    current: {
      format: 2,
      scope: "repo",
      range: { from: "2026-09-15", to: "2026-09-22" },
      sessions: 3,
    },
    rows: [
      {
        key,
        base: 100,
        current: 88,
        delta: -12,
        relativeChange: -0.12,
        outcome: "matched",
        reasons: [],
        contrast: "regime",
        n: { base: 120, current: 130 },
        criterion: {
          source: "spec-0039/R43",
          threshold: -0.1,
          minN: 100,
          observedChange: -0.12,
          state: "threshold-met-unverified",
          noiseBand: "unmeasured",
          uncontrolled: ["task-mix"],
        },
      },
    ],
    totals: { matched: 1, descriptive: 0, inconclusive: 0, notControlled: 0 },
  });

  // Covers: R19
  it("re-attaches the comparison after the numeric projection: negative deltas survive", () => {
    const report = build([session([])]);
    report.comparison = comparison("agent.implementer.cacheRead.p50");
    const published = publishReport(report);
    expect(published.comparison?.rows[0]).toMatchObject({
      delta: -12,
      relativeChange: -0.12,
      criterion: { observedChange: -0.12, state: "threshold-met-unverified" },
    });
    // The pre-fix shape: every figure of an unknown key came out null.
    expect(JSON.parse(renderJson(report)).comparison.rows[0].delta).toBe(-12);
    expect(publishReport(build([session([])]))).not.toHaveProperty("comparison");
  });

  // Covers: R19
  it("publishes a free-text key of the comparison as an opaque label", () => {
    const report = build([session([])]);
    report.comparison = comparison("agent.my-secret-agent.turns.p50");
    const text = JSON.stringify(publishReport(report).comparison);
    expect(text).not.toContain("my-secret-agent");
    expect(text).toContain(`agent.${opaqueLabel("my-secret-agent")}.turns.p50`);
  });

  // Covers: R20
  it("always computes recommendations and publishes their figures, closed ids and keys", () => {
    const empty = publishReport(build([session([])]));
    expect(empty.recommendations).toEqual([]);
    const report = build([session([])]);
    report.recommendations = [
      {
        group: "blocking-ms",
        cause: "hook-toll",
        status: "fact",
        rank: 1,
        impact: { unit: "ms", value: 5000, n: 40, state: "partial" },
        scope: { sessions: 2, eligibleSessions: 2 },
        evidence: { metrics: ["hook.secret-hook.ms", "hooks.tollMs"], signals: [] },
        hypotheses: [{ id: "toll-share-by-hook", nextProbe: "parallel-group-ids" }],
      },
    ];
    const rec = publishReport(report).recommendations?.[0];
    expect(rec?.impact).toEqual({ unit: "ms", value: 5000, n: 40, state: "partial" });
    expect(rec?.evidence.metrics).toEqual([
      `hook.${opaqueLabel("secret-hook")}.ms`,
      "hooks.tollMs",
    ]);
    expect(rec?.hypotheses[0]?.id).toBe("toll-share-by-hook");
    expect(JSON.stringify(publishReport(report))).not.toContain("secret-hook");
  });

  // Covers: R20
  it("keeps the generic allowlist closed: the recommendation words stay hashed outside their subtree", () => {
    const report = build([session([])]);
    Object.assign(report.rangeMetrics, { "tokens.hypotheses.rank": 3, "tokens.impact.status": 1 });
    const keys = Object.keys(publishReport(report).rangeMetrics);
    expect(keys).toContain(`tokens.${opaqueLabel("hypotheses")}.${opaqueLabel("rank")}`);
    expect(keys).not.toContain("tokens.impact.status");
  });

  // Covers: R20
  it("prints the observed causes in the private Markdown, facts and hypotheses apart", () => {
    const report = build([session([])]);
    report.recommendations = [
      {
        group: "per-tool-call",
        cause: "friction",
        status: "lead",
        rank: null,
        impact: { unit: "ratio", value: 0.04, n: 50, state: "observed" },
        scope: { sessions: 1, eligibleSessions: 1 },
        evidence: { metrics: [], signals: ["friction"] },
        hypotheses: [{ id: "blocks-cost-context", nextProbe: "tokens-after-block" }],
      },
    ];
    const text = renderMarkdown(report, "en");
    expect(text).toContain("Observed causes");
    expect(text).toContain(
      "| per-tool-call | — | friction | lead | 0.04 ratio (observed) | 50 | 1/1 | blocks-cost-context → tokens-after-block |",
    );
  });
});
