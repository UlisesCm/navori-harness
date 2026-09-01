import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { attachHookEvents, parseAgentRun, parseSession, sumTokens, readJsonl } from "../parse.ts";
import type { AgentRun, SessionAudit } from "../model.ts";

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
    expect(s.prompts).toEqual({ typed: 2, queued: 1 });
  });

  it("counts a queued message once, not twice", () => {
    // Every enqueue is matched by a `remove` when consumed; counting both
    // would double the figure the report shows.
    const s = parseSession(transcript([typed("uno"), enqueue("a"), removed("a")]));
    expect(s.prompts.queued).toBe(1);
  });

  it("reports zero queued when the human never interrupted", () => {
    const s = parseSession(transcript([typed("uno"), typed("dos")]));
    expect(s.prompts).toEqual({ typed: 2, queued: 0 });
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

  function session(agents: AgentRun[]): SessionAudit {
    return {
      sessionId: "s1",
      startedAt: "2026-08-25T09:00:00.000Z",
      endedAt: "2026-08-25T12:00:00.000Z",
      wallClockMs: 10_800_000,
      initialPrompt: "haz X",
      prompts: { typed: 1, queued: 0 },
      gitBranch: "main",
      cwd: "/tmp/repo",
      ccVersions: [],
      permissionModes: {},
      prs: [],
      orchestrator: {
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, thinking: 0 },
        startupTokens: 0,
        toolCounts: {},
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
    // The orchestrator's own events carry the repo `cwd` as their id, which
    // matches no agent by construction. Falling through to the time window put
    // ~294 of them inside subagent cards in the reference session.
    const s = session([agent({ agentId: "a1" })]);
    attachHookEvents(s, log([hook({ agentId: "/Users/x/repo" })]));
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
});
