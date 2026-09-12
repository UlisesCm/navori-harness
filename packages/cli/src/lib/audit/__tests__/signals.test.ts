import { describe, it, expect } from "vitest";
import type { HarnessCatalog } from "../harness.ts";
import type { AgentRun, SessionAudit } from "../model.ts";
import { emptyPermissionDecisions, emptyTokens, emptyToolErrors } from "../model.ts";
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

function session(over: Partial<SessionAudit> = {}): SessionAudit {
  return {
    sessionId: "s1",
    startedAt: "2026-08-25T10:00:00.000Z",
    endedAt: "2026-08-25T11:00:00.000Z",
    wallClockMs: 3600000,
    initialPrompt: "haz X",
    prompts: { typed: 1, queued: 0, queuedSystem: 0 },
    gitBranch: "main",
    cwd: "/tmp/repo",
    ccVersions: ["2.1.228"],
    navori: { rendered: null, cli: null },
    navoriAtStop: null,
    sealed: false,
    endReason: null,
    permissionModes: {},
    prs: [],
    orchestrator: {
      tokens: emptyTokens(),
      startupTokens: 0,
      models: {},
      shellReads: 0,
      shellWrites: 0,
      toolCounts: {},
      toolCountsByMode: {},
      classifierExemptBashByMode: {},

      skillsRead: [],
      skills: [],
      skillsDiscarded: 0,
      skillAttributionRecords: 0,
      mcpCalls: {},
      hookEvents: [],
      frictionEvents: 0,
      toolErrors: emptyToolErrors(),
      repeatedCommands: {},
    },
    agents: [],
    signals: [],
    hookLogFrom: null,
    otelFrom: null,
    permissions: emptyPermissionDecisions(),
    toolErrorTypes: {},
    hostSkills: [],
    parseErrors: 0,
    linesRead: 100,
    ...over,
  };
}

function catalog(over: Partial<HarnessCatalog> = {}): HarnessCatalog {
  return {
    agents: [],
    skills: [],
    managedSkills: [],
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
    // `warn`, not `high`: one startup paying 550 tok is real and worth printing,
    // and nowhere near the thousands that earn the top severity (#605).
    expect(found?.severity).toBe("warn");
    expect(found?.tokens).toBe(550);
  });

  it("escalates to high once the waste crosses the token threshold", () => {
    const s = session({
      agents: [agent({ agentId: "a" }), agent({ agentId: "b" }), agent({ agentId: "c" })],
    });
    const c = catalog({
      sections: [{ ...mcpSection, tokens: 700 }],
      agents: [{ name: "implementer", tools: ["Bash"], hasMcp: false }],
    });
    const found = detectSignals(s, c, "es").find((x) => x.kind === "unreachable-instructions");
    expect(found?.tokens).toBe(2100);
    expect(found?.severity).toBe("high");
  });

  /**
   * The defect this signal shipped with: `hasMcp` is true if the agent reaches
   * ANY server, so an agent barred from ONE of two was counted as sighted and
   * its unreachable section vanished from the finding — while the per-agent
   * card kept printing it. One report, two numbers (#605).
   */
  it("counts a server the agent cannot reach even when it reaches another", () => {
    const s = session({ agents: [agent({ agentType: "researcher" })] });
    const c = catalog({
      sections: [
        mcpSection,
        { title: "Engram", chars: 2712, tokens: 678, requiresMcp: ["engram"] },
      ],
      // Reaches codegraph, not engram — `hasMcp` says "has MCP" and hides it.
      agents: [{ name: "researcher", tools: ["Read", "mcp__codegraph__*"], hasMcp: true }],
    });
    const found = detectSignals(s, c, "es").find((x) => x.kind === "unreachable-instructions");
    expect(found?.tokens).toBe(678);
    expect(found?.evidence).toContain("engram");
    expect(found?.evidence).not.toContain("codegraph");
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

describe("signal: tool-errors (#686)", () => {
  const withErrors = (over: Partial<AgentRun["toolErrors"]>): SessionAudit =>
    session({ agents: [agent({ toolErrors: { ...emptyToolErrors(), ...over } })] });

  it("stays quiet when nothing failed", () => {
    expect(kinds(session({ agents: [agent()] }), catalog())).not.toContain("tool-errors");
  });

  it("reports the classes the friction count used to discard", () => {
    const found = detectSignals(withErrors({ shellFailure: 7, editMiss: 1 }), catalog(), "es").find(
      (x) => x.kind === "tool-errors",
    );
    expect(found?.summary).toContain("8 errores de tool");
    expect(found?.summary).toContain("7 shell");
    expect(found?.severity).toBe("info");
  });

  it("does not double-count what `friction` already reports", () => {
    // A block is the harness working as designed; a failed command is the agent
    // getting it wrong. Reporting the first in both places would inflate both.
    const s = withErrors({ harnessBlock: 5, permissionDenied: 5 });
    expect(kinds(s, catalog())).not.toContain("tool-errors");
  });

  it("escalates to warn at the same threshold as friction", () => {
    const found = detectSignals(withErrors({ shellFailure: 20 }), catalog(), "es").find(
      (x) => x.kind === "tool-errors",
    );
    expect(found?.severity).toBe("warn");
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
  const withBash = (
    orchestrator: number,
    agentBash: number[],
    byMode: Record<string, number> = { auto: orchestrator },
  ) =>
    session({
      permissionModes: Object.fromEntries(Object.keys(byMode).map((m) => [m, 10])),
      orchestrator: {
        ...session().orchestrator,
        toolCounts: { Bash: orchestrator },
        toolCountsByMode: Object.fromEntries(
          Object.entries(byMode).map(([mode, n]) => [mode, { Bash: n }]),
        ),
      },
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
    expect(found(withBash(298, [], { default: 298 }))).toBeUndefined();
  });

  it("stays quiet when nothing went through the shell", () => {
    expect(found(withBash(0, [0]))).toBeUndefined();
  });

  it("reports no token figure, because it cannot know one", () => {
    // Each check sends "a portion of the transcript" this report cannot see.
    // A made-up number next to measured ones is worse than no number.
    expect(found(withBash(10, []))?.tokens).toBeUndefined();
  });

  /**
   * Spec 0016 T4.1 — the old test was "is auto the MOST FREQUENT mode?", which
   * reported zero for exactly the sessions a reader most needs: the mixed ones,
   * where the auto stretch still paid per command.
   */
  describe("counted per mode segment, not per dominant mode (spec 0016 T4.1)", () => {
    it("fires for a session where auto is a MINORITY of the modes", () => {
      const signal = found(withBash(140, [], { default: 100, auto: 40 }));
      expect(signal?.summary).toContain("40");
    });

    it("counts only the auto segment's commands, not the whole session's", () => {
      // 100 of the 140 ran under default: they never met a classifier.
      const signal = found(withBash(140, [], { default: 100, auto: 40 }));
      expect(signal?.summary).not.toContain("140");
    });

    it("excludes subagent commands in a MIXED session, and says why", () => {
      // A subagent transcript declares no mode, so its Bash cannot be placed in
      // a segment; folding it in silently would be invention.
      const signal = found(withBash(140, [300], { default: 100, auto: 40 }));
      expect(signal?.summary).toContain("40");
      expect(signal?.evidence).toContain("300");
      expect(signal?.evidence).toContain("no declara modo");
    });

    it("includes subagent commands when the session never left auto", () => {
      // Nothing to misattribute: every stretch was auto, so theirs paid too.
      expect(found(withBash(298, [300, 237]))?.summary).toContain("835");
    });
  });
});

/**
 * Spec 0016 T4.2 — the gap #576 and #583 left written down: nothing measured
 * whether the search ladder ever starts. Deliberately mode-blind, because the
 * corpus found the same Bash-dominant shape under default and acceptEdits too.
 */
describe("signal: tool-mix (spec 0016 T4.2, métrica de #603)", () => {
  const withMix = (
    counts: Record<string, number>,
    shellReads: number,
    modes: Record<string, number> = { auto: 10 },
  ) =>
    session({
      permissionModes: modes,
      orchestrator: { ...session().orchestrator, toolCounts: counts, shellReads },
    });

  const found = (s: ReturnType<typeof session>) =>
    detectSignals(s, catalog(), "es").find((x) => x.kind === "tool-mix");

  it("fires when the reads went through the shell, with the lane breakdown", () => {
    const signal = found(withMix({ Bash: 90, Read: 3, Grep: 2, mcp__codegraph__explore: 5 }, 45));
    expect(signal?.severity).toBe("warn");
    // 5 native of 50 reads = 10%.
    expect(signal?.summary).toContain("10%");
    expect(signal?.evidence).toContain("5 lecturas nativas");
    expect(signal?.evidence).toContain("45 comandos de shell");
    expect(signal?.evidence).toContain("5 llamadas MCP");
  });

  it("fires under default and acceptEdits too — the habit is not auto's fault", () => {
    for (const mode of ["default", "acceptEdits"]) {
      const signal = found(withMix({ Bash: 95, Read: 5 }, 60, { [mode]: 10 }));
      expect(signal, mode).toBeDefined();
      expect(signal?.evidence, mode).toContain(mode);
    }
  });

  /**
   * The two worst sessions of the 13 audited: ZERO native reads, 175 and 35
   * shell reads — and 65 and 21 `Edit`/`Write` calls that dragged the old
   * Bash-share metric to 83% and 84%, just under its 85% line. Editing work
   * masked the read habit the signal exists to catch (#603).
   */
  it("fires for a session with zero native reads that the Bash share missed", () => {
    const signal = found(withMix({ Bash: 438, Edit: 60, Write: 5 }, 175));
    expect(signal?.summary).toContain("0%");
  });

  it("stays quiet when half the reads took the native lane", () => {
    // Measured: the sessions that DID climb the ladder sit at 50-61%.
    expect(found(withMix({ Bash: 120, Read: 54, Edit: 63 }, 55))).toBeUndefined();
  });

  it("stays quiet below the read floor, where the ratio is an accident", () => {
    // No native reads at all, but on 6 shell reads it describes nothing.
    expect(found(withMix({ Bash: 38, Edit: 6 }, 6))).toBeUndefined();
  });

  it("ignores writes, which are the ground the host concedes", () => {
    // 12 native reads of 40 = 30%, over the line. The 200 Edits neither
    // rescue a bad ratio nor sink a good one.
    expect(found(withMix({ Bash: 250, Read: 12, Edit: 200 }, 28))).toBeUndefined();
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
      otelFrom: null,
      permissions: emptyPermissionDecisions(),
      hostSkills: [],
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

/**
 * The finding used to name every idle skill in one bag — 35 of them on a real
 * session — which told the reader nothing about what to do next: a skill the
 * preset ships and one the user wrote are the same sentence but different
 * decisions (#607).
 */
describe("signal: unused-skills splits by provenance", () => {
  // `skills` Y `skillsRead`, como los deja el parser: los dos salen de la misma
  // pasada, y un fixture que solo poblara el segundo probaría un estado que no
  // existe. Desde #725/A5 la señal lee `skills` —necesita la FUENTE, no solo el
  // slug— así que la inconsistencia habría pasado por un cambio de conducta.
  const s = () =>
    session({
      orchestrator: {
        ...session().orchestrator,
        skillsRead: ["dominio"],
        skills: [{ slug: "dominio", source: "skill-tool" as const }],
      },
    });

  it("separates the user's skills from navori's", () => {
    const c = catalog({
      skills: ["dominio", "review-diff", "tamagui-v1", "zod-validation-expert"],
      managedSkills: ["dominio", "review-diff"],
    });
    const found = detectSignals(s(), c, "es").find((x) => x.kind === "unused-skills");
    expect(found?.summary).toContain("3 de 4");
    // `toContain`, not `toBe`: what this test sostiene es el DESGLOSE por
    // procedencia, y la evidencia gana además el caveat de #725 cuando el host
    // no atribuyó nada — que es el caso de este fixture. Fijar la cadena entera
    // hacía que cualquier añadido honesto al mensaje rompiera el test por el
    // motivo equivocado.
    expect(found?.evidence).toContain(
      "tuyas (2): tamagui-v1, zod-validation-expert · de navori (1): review-diff",
    );
  });

  it("names only the half that exists", () => {
    const c = catalog({
      skills: ["dominio", "review-diff"],
      managedSkills: ["dominio", "review-diff"],
    });
    const found = detectSignals(s(), c, "es").find((x) => x.kind === "unused-skills");
    expect(found?.evidence).toContain("de navori (1): review-diff");
    expect(found?.evidence).not.toContain("tuyas");
  });

  /**
   * "No se usaron" y "el instrumento no vio nada" son hechos distintos que
   * imprimían igual (#725). El campo `attributionSkill` no está documentado y
   * la doc del host dice que el formato del transcript "is internal to Claude
   * Code and changes between versions", así que un release que lo renombre
   * convertiría cada sesión en "las skills no se usan". El conteo declara
   * cuándo es un piso.
   */
  it("declara que el conteo es un piso cuando el host no atribuyó nada", () => {
    const c = catalog({ skills: ["dominio", "review-diff"], managedSkills: ["review-diff"] });
    const found = detectSignals(s(), c, "es").find((x) => x.kind === "unused-skills");
    expect(found?.evidence).toContain("piso");
  });

  /**
   * Abrir el archivo de una skill no es usarla (#725, A5).
   *
   * `skillsRead` no distingue CÓMO se detectó, y `skill-md` —el archivo abierto—
   * es 92 de las 135 detecciones del parque auditado. Una sesión detectó trece
   * skills y las trece eran eso: habría reportado casi nada sin usar mientras no
   * invocaba ninguna. El caso límite es un auditor leyendo el catálogo, y no es
   * hipotético: es lo que hacen las sesiones de este repo.
   */
  it("una skill solo ABIERTA sigue contando como nunca invocada", () => {
    const base = session();
    const onlyRead = {
      ...base,
      orchestrator: {
        ...base.orchestrator,
        skillsRead: ["dominio", "review-diff"],
        skills: [
          { slug: "dominio", source: "skill-md" as const },
          { slug: "review-diff", source: "skill-md" as const },
        ],
      },
    };
    const c = catalog({ skills: ["dominio", "review-diff"], managedSkills: ["review-diff"] });
    const found = detectSignals(onlyRead, c, "es").find((x) => x.kind === "unused-skills");
    expect(found?.summary).toContain("2 de 2");
    // Y lo dice: abierta y no invocada es un caso distinto de nunca tocada.
    expect(found?.evidence).toContain("se abrieron como archivo pero nunca se invocaron");
    expect(found?.evidence).toContain("dominio, review-diff");
  });

  it("no llama 'abierta' a la que nadie tocó", () => {
    const c = catalog({ skills: ["dominio", "review-diff"], managedSkills: [] });
    const found = detectSignals(session(), c, "es").find((x) => x.kind === "unused-skills");
    expect(found?.evidence).not.toContain("se abrieron como archivo");
  });

  it("una skill declarada por el host cuenta como invocada aunque no se pueda atribuir", () => {
    // `applyHostSkills` se niega a adivinar entre dos `researcher`, así que deja
    // la skill solo en la sesión. Nadie la leía de vuelta: inofensivo mientras el
    // titular era "no se usaron", contradictorio ahora que es "nunca se invocaron"
    // —sería negar la fuente más fuerte que tiene la auditoría—.
    const base = session();
    const declared = { ...base, hostSkills: [{ slug: "review-diff", source: "host" as const }] };
    const c = catalog({ skills: ["dominio", "review-diff"], managedSkills: ["review-diff"] });
    const found = detectSignals(declared, c, "es").find((x) => x.kind === "unused-skills");
    expect(found?.summary).toContain("1 de 2");
    expect(found?.evidence).not.toContain("review-diff");
  });

  it("se calla cuando SÍ hubo atribución — el conteo ya no es ciego", () => {
    const base = s();
    const withSpan = {
      ...base,
      orchestrator: { ...base.orchestrator, skillAttributionRecords: 12 },
    };
    const c = catalog({ skills: ["dominio", "review-diff"], managedSkills: ["review-diff"] });
    const found = detectSignals(withSpan, c, "es").find((x) => x.kind === "unused-skills");
    expect(found?.evidence).not.toContain("piso");
  });
});

describe("signal: routing-notice (spec 0020 R5)", () => {
  /**
   * The note has to be COUNTABLE, not merely emitted. `routing-watch` injects
   * it at most once per session, and an injected note leaves no trace a later
   * reading of the transcript can find — so the hook records the emission in
   * the audit log (`verdict: "notify"`) and this signal reads it back.
   *
   * Without it, the question the whole spec exists to answer — did the ladder
   * fire, and did delegation follow? — has no source. #623 is the standing
   * reason the two halves are asserted apart: "the hook emitted it" and "the
   * session acted on it" are different claims.
   */
  const notice = (reason: string) => ({
    ts: "2026-09-10T12:00:00Z",
    name: "routing-watch",
    phase: "PostToolUse",
    verdict: "notify",
    ms: 3,
    source: "core",
    reason,
  });

  const withNotice = (reason: string, agents: SessionAudit["agents"] = []) =>
    session({
      orchestrator: { ...session().orchestrator, hookEvents: [notice(reason)] },
      agents,
    });

  const routing = (s: SessionAudit) =>
    detectSignals(s, catalog(), "es").filter((x) => x.kind === "routing-notice");

  it("counts the session's routing notice and carries its detail", () => {
    // Covers: R5
    const found = routing(withNotice("7 archivos del hilo principal, sin subagente"));
    expect(found).toHaveLength(1);
    expect(found[0]?.evidence).toContain("7 archivos");
  });

  it("warns when the note fired and the session still never delegated", () => {
    // Covers: R5
    const found = routing(withNotice("4 archivos del hilo principal, sin subagente"));
    expect(found[0]?.severity).toBe("warn");
    expect(found[0]?.summary).toContain("sin delegar");
  });

  it("reports info — not a warning — when delegation followed", () => {
    // Covers: R5
    const agents = [agent({ agentType: "implementer" }), agent({ agentType: "reviewer" })];
    const found = routing(withNotice("4 archivos del hilo principal, sin subagente", agents));
    expect(found[0]?.severity).toBe("info");
    expect(found[0]?.summary).toContain("2 subagentes");
  });

  it("stays silent when the note never fired — silence is not a finding", () => {
    // Covers: R5
    expect(routing(session())).toEqual([]);
    // A routing-watch run that did NOT notify is not a notice either.
    const ran = session({
      orchestrator: {
        ...session().orchestrator,
        hookEvents: [{ ...notice("x"), verdict: "skip" }],
      },
    });
    expect(routing(ran)).toEqual([]);
  });
});

/**
 * #723 — the figure counted every Bash call in auto mode as a classifier
 * round-trip, and the host's own documentation says otherwise: *"narrow Bash
 * and PowerShell allow rules such as `Bash(npm test)` stay in effect in auto
 * mode, and Claude Code resolves them before the classifier runs"*. Only the
 * broad rules that grant arbitrary execution get suspended.
 *
 * Subtracting the covered commands needs the repo's allow list and the host's
 * own rule matcher, which is its own work. What this test pins is the part that
 * costs nothing and was the actual defect: a number that reads as measured when
 * it is a ceiling.
 */
describe("classifier round-trips are a ceiling, not a total (#723)", () => {
  it("says so in the evidence, in both languages", () => {
    const s = session({ permissionModes: { auto: 10 } });
    s.orchestrator.toolCountsByMode = { auto: { Bash: 7 } };
    const c = catalog({});

    const es = detectSignals(s, c, "es").find((x) => x.kind === "classifier-round-trips");
    expect(es?.evidence).toContain("TECHO");
    expect(es?.evidence).toContain("allow");

    const en = detectSignals(s, c, "en").find((x) => x.kind === "classifier-round-trips");
    expect(en?.evidence).toContain("CEILING");
  });
});

/**
 * #730 — the ceiling, tightened. The host's built-in read-only set runs with no
 * prompt in every mode and resolves ahead of the classifier, so those calls are
 * the one subset that can be discounted without reading repo state or
 * re-implementing the host's rule matcher. The framing does not change: what is
 * published is still a TECHO.
 */
describe("classifier round-trips discount the host's read-only set (#730)", () => {
  const found = (s: SessionAudit, lang: "es" | "en" = "es") =>
    detectSignals(s, catalog({}), lang).find((x) => x.kind === "classifier-round-trips");

  it("subtracts the exempt calls of the auto segment from the total", () => {
    const s = session({ permissionModes: { auto: 10 } });
    s.orchestrator.toolCountsByMode = { auto: { Bash: 20 } };
    s.orchestrator.classifierExemptBashByMode = { auto: 8 };

    expect(found(s)?.summary).toContain("12 comandos");
    expect(found(s)?.evidence).toContain("menos 8");
    // The frame survives the discount: what is left is still a ceiling.
    expect(found(s)?.evidence).toContain("TECHO");
    expect(found(s, "en")?.evidence).toContain("CEILING");
  });

  it("names the allow-rule suspension, which is why the rest cannot be subtracted", () => {
    const s = session({ permissionModes: { auto: 10 } });
    s.orchestrator.toolCountsByMode = { auto: { Bash: 5 } };

    expect(found(s)?.evidence).toContain("SUSPENDE");
    expect(found(s)?.evidence).toContain("pnpm test:*");
    expect(found(s, "en")?.evidence).toContain("SUSPENDS");
  });

  it("subtracts a subagent's exempt calls only when the session never left auto", () => {
    const agents = [agent({ toolCounts: { Bash: 10 }, classifierExemptBash: 4 })];
    const autoOnly = session({ permissionModes: { auto: 3 }, agents });
    autoOnly.orchestrator.toolCountsByMode = { auto: { Bash: 6 } };
    autoOnly.orchestrator.classifierExemptBashByMode = { auto: 1 };
    // 6 + 10 − (1 + 4)
    expect(found(autoOnly)?.summary).toContain("11 comandos");

    const mixed = session({ permissionModes: { auto: 3, plan: 1 }, agents });
    mixed.orchestrator.toolCountsByMode = { auto: { Bash: 6 } };
    mixed.orchestrator.classifierExemptBashByMode = { auto: 1 };
    // The subagent's Bash calls were never in the total, so neither is its
    // discount: 6 − 1.
    expect(found(mixed)?.summary).toContain("5 comandos");
  });

  it("ignores exempt calls attributed to another mode segment", () => {
    const s = session({ permissionModes: { auto: 3, plan: 1 } });
    s.orchestrator.toolCountsByMode = { auto: { Bash: 4 }, plan: { Bash: 9 } };
    s.orchestrator.classifierExemptBashByMode = { auto: 1, plan: 9 };
    // Discounting `plan`'s exempt calls against the auto stretch would be the
    // same misattribution #723 corrected: 4 − 1, never 4 − 10.
    expect(found(s)?.summary).toContain("3 comandos");
  });

  it("emits nothing when every auto command was exempt", () => {
    const s = session({ permissionModes: { auto: 10 } });
    s.orchestrator.toolCountsByMode = { auto: { Bash: 5 } };
    s.orchestrator.classifierExemptBashByMode = { auto: 5 };
    expect(found(s)).toBeUndefined();
  });

  it("still says nothing about a session with no auto stretch", () => {
    const s = session({ permissionModes: { plan: 4 } });
    s.orchestrator.toolCountsByMode = { plan: { Bash: 30 } };
    s.orchestrator.classifierExemptBashByMode = { plan: 12 };
    expect(found(s)).toBeUndefined();
  });
});
