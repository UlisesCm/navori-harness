import { describe, it, expect } from "vitest";
import { buildReport, renderMarkdown } from "../report.ts";
import type { HarnessCatalog } from "../harness.ts";
import { type AgentRun, type SessionAudit, emptyTokens } from "../model.ts";

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
    agentType: "implementer",
    model: "claude-opus-5",
    description: "cierra los 5 defectos",
    startedAt: "2026-08-25T10:00:00Z",
    endedAt: "2026-08-25T10:20:00Z",
    durationMs: 20 * 60 * 1000,
    spawnDepth: 1,
    tokens: { ...emptyTokens(), output: 2000, cacheCreation: 100_000, cacheRead: 5_000_000 },
    startupTokens: 17_000,
    overlapsWith: [],
    toolCounts: { Bash: 73, Read: 53 },
    skillsRead: [],
    skills: [],
    skillsDiscarded: 0,
    mcpCalls: {},
    mcpReach: {},
    mcpBarredTokens: {},
    hookEvents: [],
    frictionEvents: 0,
    repeatedCommands: {},
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
    prompts: { typed: 1, queued: 0 },
    gitBranch: "main",
    cwd: "/repo",
    ccVersions: ["2.1.231"],
    permissionModes: {},
    prs: [],
    orchestrator: {
      tokens: emptyTokens(),
      startupTokens: 0,
      toolCounts: {},
      toolCountsByMode: {},
      skillsRead: [],
      skills: [],
      skillsDiscarded: 0,
      mcpCalls: {},
      hookEvents: [],
      frictionEvents: 0,
      repeatedCommands: {},
    },
    agents,
    signals: [],
    hookLogFrom: null,
    parseErrors: 0,
    linesRead: 10,
    ...over,
  };
}

const CATALOG: HarnessCatalog = {
  agents: [
    { name: "implementer", tools: ["Read", "Bash"], hasMcp: false },
    { name: "researcher", tools: ["Read", "mcp__codegraph__*"], hasMcp: true },
    { name: "claude", tools: null, hasMcp: true },
  ],
  skills: [],
  sections: [
    // A CLAUDE.md section that REQUIRES engram: every agent pays for it at
    // startup, reachable or not.
    { title: "Engram", tokens: 950, chars: 3800, requiresMcp: ["engram"] },
  ],
  claudeMdTokens: 8000,
  mcpFamilies: ["codegraph", "engram"],
};

function md(agents: AgentRun[], over: Partial<SessionAudit> = {}): string {
  const report = buildReport([session(agents, over)], {
    repo: "demo",
    version: "0.6.5",
    catalog: CATALOG,
  });
  return renderMarkdown(report, "es");
}

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
    // `researcher` declares mcp__codegraph__* and nothing else.
    expect(out).toMatch(/codegraph\s+disponible · 0 llamadas/);
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
    expect(report.sessions[0]?.agents[0]?.mcpReach).toEqual({ codegraph: false, engram: false });
  });
});

describe("time: sum vs wall clock (#0013)", () => {
  // Covers: R13
  it("does not add up overlapping agents into clock time", () => {
    const parallel = [
      agent({ agentId: "a", startedAt: "2026-08-25T10:00:00Z", endedAt: "2026-08-25T10:20:00Z" }),
      agent({ agentId: "b", startedAt: "2026-08-25T10:05:00Z", endedAt: "2026-08-25T10:25:00Z" }),
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
      agent({ agentId: "a", startedAt: "2026-08-25T10:00:00Z", endedAt: "2026-08-25T10:10:00Z" }),
      agent({ agentId: "b", startedAt: "2026-08-25T11:00:00Z", endedAt: "2026-08-25T11:10:00Z" }),
    ];
    const report = buildReport([session(serial)], {
      repo: "demo",
      version: "0.6.5",
      catalog: CATALOG,
    });
    expect(report.totals.agentWallClockMs).toBe(20 * 60 * 1000);
  });
});

describe("schema (#0013)", () => {
  // Covers: R17
  it("declares schemaVersion 2", () => {
    const report = buildReport([session([])], {
      repo: "demo",
      version: "0.6.5",
      catalog: CATALOG,
    });
    expect(report.schemaVersion).toBe(2);
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
    const report = buildReport([s], { repo: "demo", version: "0.6.5", catalog: CATALOG });
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
