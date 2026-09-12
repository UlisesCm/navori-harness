import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  ORCHESTRATOR_OWNER,
  attachHookEvents,
  isClassifierExemptCommand,
  isReadLaneCommand,
  isWriteLaneCommand,
  parseAgentRun,
  parseSession,
  readJsonl,
  sumTokens,
} from "../parse.ts";
import type { AgentRun, SessionAudit } from "../model.ts";
import { emptyPermissionDecisions, emptyToolErrors } from "../model.ts";
import { buildReport, renderMarkdown } from "../report.ts";
import type { HarnessCatalog } from "../harness.ts";

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
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"), "utf-8");
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

describe("parse: missing input", () => {
  it("returns an empty result instead of throwing", () => {
    expect(readJsonl("/nonexistent/path.jsonl")).toEqual({
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
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"), "utf-8");
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
        { name: "mcp__codegraph__codegraph_explore" },
        { name: "Bash", input: { command: "ls" } },
      ]),
    );
    // The transcript records these as flat tool names, so the data was always
    // there; grouping is what turns it into "did this agent reach engram?".
    expect(run?.mcpCalls).toEqual({
      engram: { mem_save: 2, mem_search: 1 },
      codegraph: { codegraph_explore: 1 },
    });
  });

  // Covers: R9
  it("leaves non-MCP tools out of the grouping", () => {
    const run = parseAgentRun(agentWith([{ name: "Bash", input: { command: "ls" } }]));
    expect(run?.mcpCalls).toEqual({});
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
      orchestrator: {
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, thinking: 0 },
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
    writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n"), "utf-8");
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
