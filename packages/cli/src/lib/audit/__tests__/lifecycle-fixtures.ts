import type { AgentRun, SessionAudit } from "../model.ts";
import { emptyPermissionDecisions, emptyTokens, emptyToolErrors } from "../model.ts";

/**
 * Shared fixture builders for the R53/R54 reviewer-lifecycle tests
 * (`reviewer-lifecycle.test.ts` and `reviewer-gate-ownership.test.ts`).
 *
 * Extracted rather than duplicated per file — `signals.test.ts` and
 * `report.test.ts` each keep their own copy because they predate this pair
 * and jscpd's threshold never caught them, but two brand-new files with the
 * same ~80-line block is exactly the clone jscpd exists to flag.
 */
export function agent(over: Partial<AgentRun> = {}): AgentRun {
  return {
    agentId: "a1",
    agentType: "reviewer",
    model: "claude-opus-5",
    description: "",
    startedAt: "2026-09-14T10:00:00.000Z",
    endedAt: "2026-09-14T10:05:00.000Z",
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

export function session(over: Partial<SessionAudit> = {}): SessionAudit {
  return {
    sessionId: "s1",
    startedAt: "2026-09-14T10:00:00.000Z",
    endedAt: "2026-09-14T11:00:00.000Z",
    wallClockMs: 3600000,
    initialPrompt: "revisa X",
    prompts: { typed: 1, queued: 0, queuedSystem: 0 },
    gitBranch: "main",
    cwd: "/tmp/repo",
    ccVersions: ["2.1.228"],
    navori: { rendered: null, cli: null },
    navoriAtStop: null,
    sealed: true,
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
      mcpInjectedContext: {},
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
