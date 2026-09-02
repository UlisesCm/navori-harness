import { describe, it, expect } from "vitest";
import type { HarnessCatalog } from "../harness.ts";
import type { AgentRun, SessionAudit } from "../model.ts";
import { emptyTokens } from "../model.ts";
import { detectSignals } from "../signals.ts";

function agent(over: Partial<AgentRun> = {}): AgentRun {
  return {
    agentId: "a1",
    agentType: "implementer",
    model: "claude-opus-5",
    description: "",
    startedAt: "2026-08-25T10:00:00.000Z",
    endedAt: "2026-08-25T10:05:00.000Z",
    durationMs: 300000,
    spawnDepth: 1,
    tokens: emptyTokens(),
    startupTokens: 25000,
    overlapsWith: [],
    toolCounts: {},
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

function session(over: Partial<SessionAudit> = {}): SessionAudit {
  return {
    sessionId: "s1",
    startedAt: "2026-08-25T10:00:00.000Z",
    endedAt: "2026-08-25T11:00:00.000Z",
    wallClockMs: 3600000,
    initialPrompt: "haz X",
    prompts: { typed: 1, queued: 0 },
    gitBranch: "main",
    cwd: "/tmp/repo",
    ccVersions: ["2.1.228"],
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
    agents: [],
    signals: [],
    hookLogFrom: null,
    parseErrors: 0,
    linesRead: 100,
    ...over,
  };
}

function catalog(over: Partial<HarnessCatalog> = {}): HarnessCatalog {
  return {
    agents: [],
    skills: [],
    sections: [],
    claudeMdTokens: 8000,
    mcpFamilies: ["codegraph", "engram"],
    ...over,
  };
}

const kinds = (s: SessionAudit, c: HarnessCatalog): string[] =>
  detectSignals(s, c, "es").map((x) => x.kind);

describe("signal: unreachable-instructions", () => {
  const mcpSection = { title: "CodeGraph", chars: 2200, tokens: 550, requiresMcp: ["codegraph"] };

  it("fires when a section orders MCP and the spawned agents cannot reach it", () => {
    const s = session({ agents: [agent({ agentType: "implementer" })] });
    const c = catalog({
      sections: [mcpSection],
      agents: [{ name: "implementer", tools: ["Read", "Bash"], hasMcp: false }],
    });
    const found = detectSignals(s, c, "es").find((x) => x.kind === "unreachable-instructions");
    expect(found?.severity).toBe("high");
    expect(found?.tokens).toBe(550);
  });

  it("stays silent when the agent DOES have MCP access", () => {
    const s = session({ agents: [agent({ agentType: "implementer" })] });
    const c = catalog({
      sections: [mcpSection],
      agents: [{ name: "implementer", tools: ["Read", "mcp__codegraph__explore"], hasMcp: true }],
    });
    expect(kinds(s, c)).not.toContain("unreachable-instructions");
  });

  it("stays silent when `tools:` is omitted, since that inherits everything", () => {
    const s = session({ agents: [agent({ agentType: "implementer" })] });
    const c = catalog({
      sections: [mcpSection],
      agents: [{ name: "implementer", tools: null, hasMcp: true }],
    });
    expect(kinds(s, c)).not.toContain("unreachable-instructions");
  });

  it("scales the cost by how many blind agents actually ran", () => {
    const s = session({ agents: [agent({ agentId: "a" }), agent({ agentId: "b" })] });
    const c = catalog({
      sections: [mcpSection],
      agents: [{ name: "implementer", tools: ["Bash"], hasMcp: false }],
    });
    const found = detectSignals(s, c, "es").find((x) => x.kind === "unreachable-instructions");
    expect(found?.tokens).toBe(1100);
  });
});

describe("signal: serial-fanout", () => {
  it("fires for read-only agents that ran back-to-back", () => {
    const s = session({
      agents: [
        agent({
          agentId: "r1",
          agentType: "researcher",
          startedAt: "2026-08-25T10:00:00.000Z",
          endedAt: "2026-08-25T10:02:00.000Z",
        }),
        agent({
          agentId: "r2",
          agentType: "researcher",
          startedAt: "2026-08-25T10:03:00.000Z",
          endedAt: "2026-08-25T10:05:00.000Z",
        }),
      ],
    });
    expect(kinds(s, catalog())).toContain("serial-fanout");
  });

  it("stays silent when their windows overlap", () => {
    const s = session({
      agents: [
        agent({
          agentId: "r1",
          agentType: "researcher",
          startedAt: "2026-08-25T10:00:00.000Z",
          endedAt: "2026-08-25T10:05:00.000Z",
          overlapsWith: ["r2"],
        }),
        agent({
          agentId: "r2",
          agentType: "researcher",
          startedAt: "2026-08-25T10:01:00.000Z",
          endedAt: "2026-08-25T10:06:00.000Z",
          overlapsWith: ["r1"],
        }),
      ],
    });
    expect(kinds(s, catalog())).not.toContain("serial-fanout");
  });

  it("ignores writers, which must not be parallelized blindly", () => {
    const s = session({
      agents: [
        agent({
          agentId: "i1",
          startedAt: "2026-08-25T10:00:00.000Z",
          endedAt: "2026-08-25T10:02:00.000Z",
        }),
        agent({
          agentId: "i2",
          startedAt: "2026-08-25T10:03:00.000Z",
          endedAt: "2026-08-25T10:05:00.000Z",
        }),
      ],
    });
    expect(kinds(s, catalog())).not.toContain("serial-fanout");
  });
});

describe("signal: permission-mode", () => {
  it("reports auto, because the tool histogram cannot be read without it", () => {
    const s = session({ permissionModes: { auto: 100, default: 3 } });
    expect(kinds(s, catalog())).toContain("permission-mode");
  });

  it("stays silent when the dominant mode is the default one", () => {
    const s = session({ permissionModes: { default: 100, auto: 3 } });
    expect(kinds(s, catalog())).not.toContain("permission-mode");
  });
});

describe("signal: format-drift", () => {
  it("fires above a 1% unreadable-line ratio", () => {
    const s = session({ parseErrors: 5, linesRead: 100 });
    const found = detectSignals(s, catalog(), "es").find((x) => x.kind === "format-drift");
    expect(found?.severity).toBe("high");
  });

  it("stays silent below the threshold", () => {
    expect(kinds(session({ parseErrors: 0, linesRead: 100 }), catalog())).not.toContain(
      "format-drift",
    );
  });
});

describe("signal: review-cycles and rework", () => {
  it("needs two rejected reviews before it counts as a pattern", () => {
    const one = session({ agents: [agent({ verdict: "CHANGES_REQUESTED" })] });
    expect(kinds(one, catalog())).not.toContain("review-cycles");

    const two = session({
      agents: [
        agent({ agentId: "a", verdict: "CHANGES_REQUESTED" }),
        agent({ agentId: "b", verdict: "CHANGES_REQUESTED" }),
      ],
    });
    expect(kinds(two, catalog())).toContain("review-cycles");
  });

  it("reports repeated commands as rework", () => {
    const s = session({
      orchestrator: { ...session().orchestrator, repeatedCommands: { "pnpm test": 5 } },
    });
    expect(kinds(s, catalog())).toContain("repeated-commands");
  });
});

describe("signal ordering", () => {
  it("puts high severity first", () => {
    const s = session({
      agents: [agent({ agentType: "implementer" })],
      parseErrors: 50,
      linesRead: 100,
      permissionModes: { auto: 10 },
    });
    const c = catalog({
      sections: [{ title: "CodeGraph", chars: 2200, tokens: 550, requiresMcp: ["codegraph"] }],
      agents: [{ name: "implementer", tools: ["Bash"], hasMcp: false }],
    });
    const severities = detectSignals(s, c, "es").map((x) => x.severity);
    expect(severities[0]).toBe("high");
    expect(severities[severities.length - 1]).toBe("info");
  });
});

describe("report language", () => {
  it("renders summaries in the configured language", () => {
    const s = session({ permissionModes: { auto: 10 } });
    const es = detectSignals(s, catalog(), "es")[0]?.summary ?? "";
    const en = detectSignals(s, catalog(), "en")[0]?.summary ?? "";
    expect(es).not.toBe(en);
    expect(en).toContain("permission mode");
  });
});

describe("signal: classifier-round-trips (#574)", () => {
  /**
   * The cost of auto mode that the session's own token usage never shows: the
   * classifier runs on its own model, with its own slice of the transcript, and
   * only the shell pays for it. Reads, in-workspace edits and `allow`-covered
   * MCP calls skip the check, which is why the number to report is the Bash
   * count and not "how much Bash there was relative to Read".
   */
  const withBash = (orchestrator: number, agentBash: number[], mode = "auto") =>
    session({
      permissionModes: { [mode]: 10 },
      orchestrator: { ...session().orchestrator, toolCounts: { Bash: orchestrator } },
      agents: agentBash.map((n, i) => agent({ agentId: `a${i}`, toolCounts: { Bash: n } })),
    });

  const found = (s: ReturnType<typeof session>) =>
    detectSignals(s, catalog(), "es").find((x) => x.kind === "classifier-round-trips");

  it("counts the orchestrator's and the subagents' shell commands", () => {
    const signal = found(withBash(298, [300, 237]));
    expect(signal?.summary).toContain("835");
    expect(signal?.evidence).toContain("298");
    expect(signal?.evidence).toContain("537");
  });

  it("stays out of a session that is not in auto mode", () => {
    // Outside auto mode there is no classifier, so the count means nothing.
    expect(found(withBash(298, [], "default"))).toBeUndefined();
  });

  it("stays quiet when nothing went through the shell", () => {
    expect(found(withBash(0, [0]))).toBeUndefined();
  });

  it("reports no token figure, because it cannot know one", () => {
    // Each check sends "a portion of the transcript" this report cannot see.
    // A made-up number next to measured ones is worse than no number.
    expect(found(withBash(10, []))?.tokens).toBeUndefined();
  });
});

describe("signal: hook-log-coverage", () => {
  const HORIZON = "2026-08-25T10:30:00.000Z";

  it("fires for agents that finished before the recorder existed", () => {
    const s = session({
      hookLogFrom: HORIZON,
      agents: [
        agent({
          agentId: "a1",
          startedAt: "2026-08-25T10:00:00.000Z",
          endedAt: "2026-08-25T10:10:00.000Z",
        }),
        agent({
          agentId: "a2",
          startedAt: "2026-08-25T10:40:00.000Z",
          endedAt: "2026-08-25T10:50:00.000Z",
        }),
      ],
    });
    const found = detectSignals(s, catalog(), "es").find((x) => x.kind === "hook-log-coverage");
    expect(found?.summary).toContain("1 de 2");
    // The gap is what explains it: a harness rendered 30 min into the session.
    expect(found?.evidence).toContain("30 min");
  });

  it("still fires when every agent ran under the recorder (#559)", () => {
    // The agents are covered; the SESSION is not. The orchestrator spans the
    // whole hour, so its hook counts are short by whatever fired in the first
    // 30 min — a truncation nothing used to declare, because the signal keyed
    // on blind agents instead of on the horizon.
    const s = session({
      hookLogFrom: HORIZON,
      agents: [
        agent({ startedAt: "2026-08-25T10:40:00.000Z", endedAt: "2026-08-25T10:50:00.000Z" }),
      ],
    });
    const found = detectSignals(s, catalog(), "es").find((x) => x.kind === "hook-log-coverage");
    expect(found?.summary).toContain("50%");
    // No agent fell in the gap, so the summary claims none did.
    expect(found?.summary).not.toContain("agentes");
  });

  it("states the observed fraction, not just when the recorder started (#559)", () => {
    const s = session({ hookLogFrom: HORIZON });
    const es = detectSignals(s, catalog(), "es").find((x) => x.kind === "hook-log-coverage");
    const en = detectSignals(s, catalog(), "en").find((x) => x.kind === "hook-log-coverage");
    expect(es?.summary).toContain("el recorder observó 50% de la sesión");
    expect(en?.summary).toContain("the recorder observed 50% of the session");
    expect(es?.evidence).toContain("30 min");
  });

  it("stays silent when the recorder was already running at the session start", () => {
    // Nothing to declare: the log covers the whole run.
    const s = session({
      startedAt: "2026-08-25T10:30:00.000Z",
      hookLogFrom: "2026-08-25T10:30:00.000Z",
    });
    expect(kinds(s, catalog())).not.toContain("hook-log-coverage");
  });

  it("never reports negative coverage on broken timestamps", () => {
    // A horizon beyond the session's own wall clock is broken input, not a
    // number to print: clamped to 0%, never "-40% observed".
    const s = session({ wallClockMs: 60_000, hookLogFrom: HORIZON });
    const found = detectSignals(s, catalog(), "es").find((x) => x.kind === "hook-log-coverage");
    expect(found?.summary).toContain("0%");
  });

  it("stays silent when the log holds no hook to draw a horizon from", () => {
    const s = session({
      hookLogFrom: null,
      agents: [agent({ endedAt: "2026-08-25T10:10:00.000Z" })],
    });
    expect(kinds(s, catalog())).not.toContain("hook-log-coverage");
  });
});

describe("signal: hook-log-coverage stays quiet on a gap that rounds away (#584)", () => {
  it("does not report 100% coverage as a finding", () => {
    // Reporting the healthy case as a signal is how a reader learns to skip the
    // section where the real ones live.
    const s = session({
      startedAt: "2026-08-25T10:00:00.000Z",
      wallClockMs: 20 * 60 * 60 * 1000,
      hookLogFrom: "2026-08-25T10:01:00.000Z",
    });
    expect(kinds(s, catalog())).not.toContain("hook-log-coverage");
  });

  it("still fires when an agent fell inside that gap, however small", () => {
    // Rounding hides the minute; it must not hide the agent whose hooks that
    // minute swallowed.
    const s = session({
      startedAt: "2026-08-25T10:00:00.000Z",
      wallClockMs: 20 * 60 * 60 * 1000,
      hookLogFrom: "2026-08-25T10:01:00.000Z",
      agents: [
        agent({ startedAt: "2026-08-25T10:00:10.000Z", endedAt: "2026-08-25T10:00:40.000Z" }),
      ],
    });
    expect(kinds(s, catalog())).toContain("hook-log-coverage");
  });
});
