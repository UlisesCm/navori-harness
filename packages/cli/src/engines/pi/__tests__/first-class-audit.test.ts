import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { stripTypeScriptTypes } from "node:module";
import { PassThrough } from "node:stream";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NavoriConfigSchema } from "../../../lib/config/schema.ts";
import { PI_EXTENSION_SOURCE } from "../extension-source.ts";
import { renderPiEngine } from "../index.ts";
import type { HarnessCatalog } from "../../../lib/audit/harness.ts";
import { createAuditReadBudget } from "../../../lib/audit/model.ts";
import { readAuditJsonl } from "../../../lib/audit/paths.ts";
import {
  inspectPiSession,
  parsePiSession,
  resolvePiSession,
} from "../../../lib/audit/pi-session.ts";
import { buildReport, publishReport, renderMarkdown } from "../../../lib/audit/report.ts";
import { agent, session } from "../../../lib/audit/__tests__/lifecycle-fixtures.ts";

const ID = "0197-pi-parent";
const CWD = "/work/repo-wt";
const CATALOG: HarnessCatalog = {
  agents: [],
  skills: [],
  managedSkills: [],
  sections: [],
  claudeMdTokens: 0,
  mcpFamilies: [],
};
const PROMPT = "SECRET-PROMPT please use sk-ant-ABCDEF123456";
const OUTPUT = "PASSWORD=hunter2-leaked";
const usage = (input: number, output: number) => ({
  input,
  output,
  cacheRead: 5,
  cacheWrite: 1,
  totalTokens: input + output + 6,
  cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
});
const line = (value: unknown): string => JSON.stringify(value) + "\n";
const entry = (i: number, message: unknown) => ({
  type: "message",
  id: "e" + i,
  parentId: null,
  timestamp: `2026-10-10T10:0${i}:00.000Z`,
  message,
});
const result = (i: number, toolName: string, extra: Record<string, unknown> = {}) =>
  entry(i, {
    role: "toolResult",
    toolCallId: "c" + i,
    toolName,
    content: [{ type: "text", text: OUTPUT }],
    isError: false,
    timestamp: Date.parse(`2026-10-10T10:0${i}:00.000Z`),
    ...extra,
  });

let dir: string;
let file: string;
let saved: string | undefined;
const view = (host = "pi") => ({
  records: [
    { event: "start", ts: "2026-10-10T10:00:00.000Z", cwd: CWD, repo: "repo", sessionId: ID, host },
  ],
  budget: createAuditReadBudget(),
});

// Covers: R1 (0053)
it("does not borrow a context marker from another Pi branch", () => {
  appendFileSync(
    file,
    [
      { type: "compaction", id: "compact-left", parentId: "e6" },
      {
        type: "custom_message",
        id: "context-right",
        parentId: "e6",
        customType: "navori-context",
        content: OUTPUT,
      },
    ]
      .map(line)
      .join(""),
  );
  expect(parsePiSession(ID, join(dir, "audit.log"), file, view())?.compactionRecovery).toEqual({
    total: 1,
    contextRestored: 0,
    pending: 1,
  });
});

// Covers: R1 (0053)
it("observes Pi boundaries, restored context and closed child results without retaining text", () => {
  appendFileSync(
    file,
    [
      {
        type: "compaction",
        id: "compact-a",
        parentId: "e6",
        timestamp: "2026-10-10T11:00:00.000Z",
      },
      {
        type: "custom_message",
        id: "context-a",
        parentId: "compact-a",
        customType: "navori-context",
        content: OUTPUT,
      },
      {
        type: "custom_message",
        id: "context-b",
        parentId: "context-a",
        customType: "navori-context",
        content: OUTPUT,
      },
      {
        type: "compaction",
        id: "compact-b",
        parentId: "context-b",
        timestamp: "2026-10-10T11:01:00.000Z",
      },
      result(7, "navori_subagent", {
        details: { role: "reviewer" },
        content: [{ type: "text", text: "APPROVED\n" + OUTPUT }],
      }),
      result(8, "navori_subagent", {
        details: { role: "implementer" },
        content: [{ type: "text", text: "BLOCKED\n" + OUTPUT }],
      }),
    ]
      .map(line)
      .join(""),
  );
  const parsed = parsePiSession(ID, join(dir, "audit.log"), file, view());
  expect(parsed?.compactionRecovery).toEqual({ total: 2, contextRestored: 1, pending: 1 });
  expect(parsed?.agents.at(-2)?.verdict).toBe("APPROVED");
  expect(parsed?.agents.at(-1)?.handoffBlocked).toBe(true);
  expect(JSON.stringify(parsed)).not.toContain(OUTPUT);
});

beforeEach(() => {
  saved = process.env.PI_CODING_AGENT_SESSION_DIR;
  dir = mkdtempSync(join(tmpdir(), "navori-pi-audit-"));
  process.env.PI_CODING_AGENT_SESSION_DIR = dir;
  mkdirSync(join(dir, "--work-repo-wt--"));
  file = join(dir, "--work-repo-wt--", `2026-10-10T10-00-00-000Z_${ID}.jsonl`);
  writeFileSync(
    file,
    line({ type: "session", version: 3, id: ID, timestamp: "2026-10-10T10:00:00.000Z", cwd: CWD }),
  );
  const rows = [
    entry(1, { role: "user", content: PROMPT, timestamp: 1 }),
    entry(2, {
      role: "assistant",
      content: [{ type: "text", text: PROMPT }],
      model: "gpt-5.5",
      usage: usage(100, 20),
      timestamp: 2,
    }),
    result(3, "bash", { details: { command: OUTPUT } }),
    result(4, "navori_subagent", {
      details: { role: "implementer", truncated: false },
      usage: usage(40, 8),
      durationMs: 60_000,
    }),
    result(5, "navori_subagent", {
      details: { role: "reviewer", truncated: false },
      durationMs: 1000,
    }),
    entry(6, {
      role: "assistant",
      content: [],
      model: "gpt-5.5",
      usage: usage(10, 2),
      timestamp: 6,
    }),
  ];
  for (const row of rows) appendFileSync(file, line(row));
});
afterEach(() => {
  if (saved === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
  else process.env.PI_CODING_AGENT_SESSION_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

const parse = () => parsePiSession(ID, "/unused.log", file, view())!;
const report = (sessions = [parse()]) =>
  buildReport(sessions, { repo: "repo", version: "0.1.0", catalog: CATALOG });

describe("Pi session audit (spec 0047 R12)", () => {
  // Covers: R3 — a native refusal before spawn is a denial, never a failed child.
  it("counts native denials without retaining their text or manufacturing a dispatch", () => {
    writeFileSync(
      file,
      line({ type: "session", id: ID, cwd: CWD }) +
        line(
          result(1, "navori_subagent", {
            isError: true,
            content: [
              { type: "text", text: "Navori plan gate unavailable; subagent blocked\n" + OUTPUT },
            ],
          }),
        ) +
        line(
          result(2, "powershell", {
            isError: true,
            content: [{ type: "text", text: "Navori disabled Pi's powershell tool: " + OUTPUT }],
          }),
        ) +
        line(
          result(3, "bash", {
            isError: true,
            content: [{ type: "text", text: "Navori disabled Pi's powershell tool: " + OUTPUT }],
          }),
        ) +
        line(
          result(4, "powershell", {
            isError: false,
            content: [{ type: "text", text: "Navori disabled Pi's powershell tool: " + OUTPUT }],
          }),
        ),
    );
    const parsed = parse();
    expect(parsed.piExtensionDenials).toEqual({ "plan-gate": 1, powershell: 1 });
    expect(parsed.agents).toEqual([]);
    expect(JSON.stringify(parsed)).not.toContain(OUTPUT);
    expect(JSON.stringify(publishReport(report([parsed])))).not.toContain(OUTPUT);
  });

  // Covers: R3 — overlapping children of one role must never be attributed by role or time window.
  it("joins hooks and CLI events to exact Pi invocations while preserving public ordinal IDs", () => {
    writeFileSync(
      file,
      line({ type: "session", id: ID, cwd: CWD }) +
        ["second", "first"]
          .map((id: string, index: number): string =>
            line(
              result(index + 1, "navori_subagent", {
                toolCallId: id,
                details: { role: "scout" },
                durationMs: 600_000,
              }),
            ),
          )
          .join(""),
    );
    const stamp = Date.parse("2026-10-10T10:00:00Z");
    const records = [
      ...view().records,
      ...["first", "second", "unconfirmed"].flatMap((id: string, index: number) => [
        {
          event: "hook",
          wireVersion: 1,
          eventId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          host: "pi",
          rootSessionId: ID,
          name: "probe",
          source: "core",
          phase: "PreToolUse",
          verdict: "allow",
          ms: 1,
          tsMs: stamp + index,
          agentId: "pi-scout-" + id,
          toolUseId: "bash",
        },
        {
          event: "cli",
          name: "plan-gate",
          verdict: "block",
          tsMs: stamp + index,
          agentId: "pi-scout-" + id,
        },
      ]),
    ];
    const logFile = join(dir, "owners.log");
    writeFileSync(logFile, records.map(line).join(""));
    const parsed = parsePiSession(ID, logFile, file, {
      records,
      reading: readAuditJsonl(logFile, (): void => {}),
      budget: createAuditReadBudget(),
    })!;
    expect(
      parsed.agents.map((agent) => [
        agent.spawnToolUseId,
        agent.hookEvents.map((hook) => hook.tsMs),
      ]),
    ).toEqual([
      ["second", [stamp + 1]],
      ["first", [stamp]],
    ]);
    expect(parsed.orchestrator.hookEvents).toHaveLength(1);
    expect(parsed.cliEvents?.map((event) => event.agentId)).toEqual([
      "pi-scout-2",
      "pi-scout-1",
      "unattributed-pi",
    ]);
    expect(JSON.stringify(publishReport(report([parsed])))).not.toContain("pi-scout-first");
    // A duplicate invocation cannot alias the public ordinal of an unrelated child.
    writeFileSync(
      file,
      line({ type: "session", id: ID, cwd: CWD }) +
        [1, 2]
          .map((index: number): string =>
            line(
              result(index, "navori_subagent", { toolCallId: "first", details: { role: "scout" } }),
            ),
          )
          .join(""),
    );
    const ambiguous = parsePiSession(ID, logFile, file, {
      records,
      reading: readAuditJsonl(logFile, (): void => {}),
      budget: createAuditReadBudget(),
    })!;
    expect(ambiguous.agents.every((agent) => agent.hookEvents.length === 0)).toBe(true);
    expect(ambiguous.orchestrator.hookEvents).toHaveLength(3);
  });

  // Covers: R3
  it("retains all seven child roles and exact parent invocation IDs without publishing them", () => {
    const roles = [
      "scout",
      "implementer",
      "reviewer",
      "scribe",
      "auditor",
      "architect",
      "publisher",
    ];
    writeFileSync(file, line({ type: "session", id: ID, cwd: CWD }));
    roles.forEach((role: string, index: number): void => {
      appendFileSync(
        file,
        line(
          result(index + 1, "navori_subagent", {
            toolCallId: `private_call_${index}`,
            details: { role },
          }),
        ),
      );
    });
    const parsed = parse();
    expect(parsed.agents.map((run) => run.agentType)).toEqual(roles);
    expect(parsed.agents.map((run) => run.spawnToolUseId)).toEqual(
      roles.map((_role: string, index: number): string => `private_call_${index}`),
    );
    const published = publishReport(report([parsed]));
    expect(Object.keys(published.totals.byAgentType).sort()).toEqual(
      [...roles, "main-thread"].sort(),
    );
    expect(JSON.stringify(published)).not.toContain("private_call_");
  });

  // Covers: R3
  it("joins serial Pi calls to dispatch outcomes by invocation ID instead of role or order", () => {
    writeFileSync(
      file,
      line({ type: "session", id: ID, cwd: CWD }) +
        line(
          result(1, "navori_subagent", {
            toolCallId: "call_first",
            details: { role: "implementer" },
          }),
        ) +
        line(
          result(2, "navori_subagent", {
            toolCallId: "call_second",
            details: { role: "implementer" },
          }),
        ) +
        line(
          result(3, "navori_subagent", {
            toolCallId: "failed_call",
            isError: true,
            details: { role: "implementer" },
          }),
        ) +
        line(
          result(4, "navori_subagent", {
            toolCallId: "unknown_state",
            isError: undefined,
            details: { role: "implementer" },
          }),
        ) +
        line(
          result(5, "navori_subagent", {
            toolCallId: "unknown_role",
            details: { role: "unregistered" },
          }),
        ) +
        line(
          result(6, "navori_subagent", {
            toolCallId: "failed_with_k2",
            isError: true,
            details: {
              role: "implementer",
              agentId: "pi-implementer-failed_with_k2",
              parentSession: ID,
              outcome: "failed",
              failure: "Pi child exited 2",
              head: null,
              worktreeTree: null,
              handoff: "none",
              truncated: false,
            },
          }),
        ),
    );
    const logFile = join(dir, "session.log");
    const records = [
      ...view().records,
      ...[
        "call_second",
        "failed_call",
        "unknown_state",
        "unknown_role",
        "missing_call",
        "failed_with_k2",
        "call_first",
      ].map((spawn: string, index: number): Record<string, unknown> => ({
        event: "cli",
        tsMs: Date.parse("2026-10-10T10:00:00Z") + index,
        name: "dispatch-outcome",
        verdict: "allow",
        schemaVersion: 1,
        featureKey: "a".repeat(64),
        stage: "implement",
        spawn,
      })),
    ];
    writeFileSync(logFile, records.map(line).join(""));
    const reading = readAuditJsonl(logFile, (): void => {});
    const parsed = parsePiSession(ID, logFile, file, {
      records,
      reading,
      budget: createAuditReadBudget(),
    })!;
    expect(parsed.agents.map((run) => run.spawnToolUseId)).toEqual([
      "call_first",
      "call_second",
      undefined,
      undefined,
      undefined,
      "failed_with_k2",
    ]);
    const published = publishReport(report([parsed]));
    expect(published.outcomes?.dispatch).toMatchObject({
      events: 7,
      confirmed: 3,
      unconfirmed: 4,
      unlinkable: 0,
    });
    expect(JSON.stringify(published)).not.toContain("call_first");
    expect(JSON.stringify(published)).not.toContain("call_second");
  });

  // Covers: R3
  it("keeps legacy identities and rejects malformed invocation IDs and unknown roles", () => {
    expect(parse().agents.map((run) => run.spawnToolUseId)).toEqual(["c4", "c5"]);
    for (const toolCallId of [undefined, "", "../private-path", "x".repeat(257), 42]) {
      writeFileSync(
        file,
        line({ type: "session", id: ID, cwd: CWD }) +
          line(result(1, "navori_subagent", { toolCallId, details: { role: "unregistered" } })),
      );
      const parsed = parse();
      expect(parsed.agents[0]).toMatchObject({ agentId: "pi-unknown-1", agentType: "unknown" });
      expect(parsed.agents[0]?.spawnToolUseId).toBeUndefined();
      expect(JSON.stringify(parsed)).not.toContain("private-path");
    }
  });

  // Covers: R3
  it("requires the complete K2 identity before attributing a post-spawn failure", () => {
    const details = {
      role: "scout",
      agentId: "pi-scout-failed_call",
      parentSession: ID,
      outcome: "failed",
      failure: "Pi child exited 2",
      head: null,
      worktreeTree: null,
      handoff: "none",
      truncated: false,
    };
    for (const [patch, attributed] of [
      [{}, true],
      [{ parentSession: "another-parent" }, false],
      [{ agentId: "pi-scout-another-call" }, false],
      [{ role: "reviewer" }, false],
      [{ outcome: "completed" }, false],
      [{ failure: undefined }, false],
      [{ failure: "x".repeat(2049) }, false],
      [{ head: "partial" }, false],
      [{ worktreeTree: undefined }, false],
      [{ handoff: "valid" }, false],
      [{ truncated: undefined }, false],
    ] as const) {
      writeFileSync(
        file,
        line({ type: "session", id: ID, cwd: CWD }) +
          line(
            result(1, "navori_subagent", {
              toolCallId: "failed_call",
              isError: true,
              details: { ...details, ...patch },
            }),
          ),
      );
      const parsed = parse();
      expect(parsed.agents[0]!.spawnToolUseId).toBe(attributed ? "failed_call" : undefined);
      expect(JSON.stringify(publishReport(report([parsed])))).not.toContain("Pi child exited 2");
    }
  });

  // Covers: R12
  it("bounded redacted parent-child correlation", () => {
    expect(resolvePiSession(ID)).toBe(file);
    expect(inspectPiSession(file, ID, CWD)).toBe("verified");
    expect(inspectPiSession(file, ID, "/other/worktree")).toBe("identity-conflict");
    expect(inspectPiSession(file, "someone-else", CWD)).toBe("identity-conflict");
    expect(parsePiSession(ID, "/unused.log", file, view("claude"))).toBeNull();

    const s = parse();
    // Identities: parent session id + cwd, children by role and ordinal.
    expect(s).toMatchObject({ sessionId: ID, host: "pi", cwd: CWD });
    expect(s.agents.map((a) => [a.agentId, a.agentType, a.spawnDepth])).toEqual([
      ["pi-implementer-1", "implementer", 1],
      ["pi-reviewer-2", "reviewer", 1],
    ]);
    expect(s.orchestrator.tokens).toMatchObject({
      input: 110,
      output: 22,
      cacheRead: 10,
      cacheCreation: 2,
    });
    expect(s.orchestrator.toolCounts).toEqual({ bash: 1, navori_subagent: 2 });
    expect(s.agents[0]!.tokens.output).toBe(8);

    // Partial coverage: the child without usage is unavailable, never 0.
    expect(s.agents[0]!.availability?.["tokens.output"]?.state).toBe("observed");
    expect(s.agents[1]!.availability?.["tokens.output"]).toMatchObject({
      state: "unavailable",
      reason: "not-observed",
    });
    const md = renderMarkdown(report(), "en");
    expect(md).toContain("Pi usage (implementer pi-implementer-1): in 40 · out 8");
    expect(md).toContain("Pi usage (reviewer pi-reviewer-2): unavailable");

    // Redaction: no prompt, assistant text, tool output or credential reaches any rendered output.
    const published = JSON.stringify(publishReport(report()));
    for (const text of [published, md, JSON.stringify(s)])
      for (const secret of [PROMPT, "SECRET-PROMPT", "sk-ant", OUTPUT, "hunter2"])
        expect(text).not.toContain(secret);
    expect(published).toContain('"pi"');

    // Bounded: a flood of records stops at the shared read ceiling and says so.
    writeFileSync(
      file,
      line({ type: "session", id: ID, cwd: CWD }) +
        line(entry(1, { role: "user", content: "x" })).repeat(100_050),
    );
    const capped = parse();
    expect(capped.linesRead).toBeLessThanOrEqual(100_002);
    expect(capped.sources?.transcript?.state).toBe("partial");

    // A source that cannot be read is unavailable, not an empty zero-token session.
    rmSync(file);
    const gone = parse();
    expect(gone.availability?.["tokens.output"]?.state).toBe("unavailable");
    expect(gone.orchestrator.turns).toBeNull();
  });

  // Covers: R12
  it("leaves Claude and Codex audit output untouched when a Pi session joins the range", () => {
    const seen = {
      state: "observed",
      reason: null,
      source: "transcript",
      adapter: "claude-transcript",
      sourceVersion: "1",
    } as const;
    const keys = [
      "tools",
      "startupTokens",
      "hooks",
      "wallClockMs",
      "tokens.input",
      "tokens.output",
      "tokens.cacheRead",
      "tokens.cacheCreation",
      "tokens.thinking",
    ];
    const availability = Object.fromEntries(keys.map((k) => [k, seen]));
    const claude = session({
      sessionId: "claude-1",
      availability,
      agents: [
        agent({
          agentId: "c1",
          agentType: "implementer",
          availability,
          tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4, thinking: 0 },
        }),
      ],
    });
    const alone = publishReport(report([claude]));
    const mixed = publishReport(report([claude, parse()]));
    expect(mixed.totals.byAgentType["implementer"]?.tokens.output).toBe(2 + 8);
    expect(alone.totals.byAgentType["implementer"]?.tokens.output).toBe(2);
    expect(mixed.sessions.find((x) => x.sessionId === "claude-1")).toEqual(
      alone.sessions.find((x) => x.sessionId === "claude-1"),
    );
  });

  // Covers: R12
  it("the extension returns the summed child usage, and none when a message lacks it", async () => {
    type Tool = {
      execute: (
        ...args: unknown[]
      ) => Promise<{ isError?: boolean; details: unknown; usage?: unknown }>;
    };
    const roles = mkdtempSync(join(tmpdir(), "navori-pi-audit-roles-"));
    renderPiEngine(
      roles,
      NavoriConfigSchema.parse({
        name: "pi-roles",
        preset: "custom",
        engines: ["pi"],
        branchBase: "main",
        qualityGate: { fast: "bun test", full: "bun test" },
        models: { scout: "haiku", codexMap: { haiku: "openai-codex/gpt-5" } },
      }),
    );
    const environments: NodeJS.ProcessEnv[] = [];
    const run = async (
      messages: unknown[],
      exitCode = 0,
      callId = "1",
    ): Promise<Awaited<ReturnType<Tool["execute"]>>> => {
      let tool: Tool | undefined;
      const spawn = (
        _program: string,
        _args: string[],
        options: { env: NodeJS.ProcessEnv },
      ): unknown => {
        environments.push(options.env);
        const child = Object.assign(new EventEmitter(), {
          pid: 1,
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
        });
        setImmediate(() => {
          for (const message of messages)
            child.stdout.write(
              line({
                type: "message_end",
                message: { role: "assistant", content: [], ...(message as object) },
              }),
            );
          child.stdout.write(line({ type: "agent_settled" }));
          child.emit("close", exitCode);
        });
        return child;
      };
      const exports: Record<string, unknown> = {};
      const modules: Record<string, unknown> = {
        "node:child_process": { spawn },
        "node:fs": { existsSync, readFileSync, statSync },
        "node:path": { join },
        "@earendil-works/pi-ai": { Type: new Proxy({}, { get: () => () => ({}) }) },
        "@earendil-works/pi-coding-agent": {
          VERSION: "1.1.0",
          defineTool: (value: unknown) => value,
        },
      };
      const code = stripTypeScriptTypes(PI_EXTENSION_SOURCE)
        .replace(/^import \{ (.+) \} from "(.+)";$/gm, 'const { $1 } = require("$2");')
        .replace("export default function", "exports.default = function");
      runInNewContext(code, {
        exports,
        require: (id: string) => modules[id],
        process: {
          env: {
            NAVORI_AUDIT_HOST: "codex",
            NAVORI_AUDIT_SESSION_ID: "outer-session",
            NAVORI_AUDIT_AGENT_ID: "outer-agent",
            CODEX_SESSION_ID: "outer-session",
            CODEX_THREAD_ID: "outer-session",
            CLAUDE_CODE_SESSION_ID: "outer-claude",
          },
          platform: "win32",
          versions: { node: "22.19.0" },
          stderr: { write: () => true },
        },
        Buffer,
        setTimeout,
        clearTimeout,
      });
      (exports.default as (pi: unknown) => void)({
        on: () => {},
        registerTool: (value: Tool) => (tool = value),
      });
      return tool!.execute(
        callId,
        { role: "scout", task: "t" },
        new AbortController().signal,
        () => {},
        {
          cwd: roles,
          isProjectTrusted: () => true,
          model: { provider: "p", id: "m" },
          sessionManager: { getSessionId: () => ID },
        },
      );
    };
    const summed = await run([{ usage: usage(10, 2) }, { usage: usage(5, 1) }]);
    expect(summed.usage).toMatchObject({
      input: 15,
      output: 3,
      cacheRead: 10,
      totalTokens: 30,
      cost: { total: 0.6 },
    });
    expect(summed.details).toEqual({
      role: "scout",
      truncated: false,
      agentId: "pi-scout-1",
      parentSession: ID,
      outcome: "completed",
      head: null,
      worktreeTree: null,
      handoff: "none",
    });
    expect((await run([{ usage: usage(10, 2) }, {}])).usage).toBeUndefined();
    // Covers: R3 — consume the actual failed extension result, not a hand-authored success fixture.
    const failed = await run([], 2);
    expect(failed).toMatchObject({
      isError: true,
      details: { outcome: "failed", failure: expect.stringContaining("exited 2") },
    });
    writeFileSync(
      file,
      line({ type: "session", id: ID, cwd: CWD }) +
        line(result(1, "navori_subagent", { ...failed, toolCallId: "1" })),
    );
    expect(parse().agents[0]!.spawnToolUseId).toBe("1");
    expect(parse().agents[0]!.piOutcome).toBe("failed");
    const published = JSON.stringify(publishReport(report()));
    expect(published).not.toContain("exited 2");
    expect(parse().agents[0]).not.toHaveProperty("parentSession");
    expect(parse().agents[0]).not.toHaveProperty("failure");
    // Covers: R3 — the spawned environment and K2 share one parent/invocation identity.
    const concurrent = await Promise.all([
      run([], 0, "first"),
      run([], 0, "second"),
      run([], 2, "failed"),
    ]);
    for (const [index, call] of ["first", "second", "failed"].entries()) {
      const env = environments.at(index - 3)!;
      expect(env).toMatchObject({
        NAVORI_PI_PARENT_SESSION: ID,
        NAVORI_PI_CHILD_ID: "pi-scout-" + call,
        NAVORI_AUDIT_HOST: "pi",
        NAVORI_AUDIT_SESSION_ID: ID,
        NAVORI_AUDIT_AGENT_ID: "pi-scout-" + call,
      });
      for (const key of ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID"])
        expect(env).not.toHaveProperty(key);
      expect(concurrent[index]!.details).toMatchObject({
        agentId: env.NAVORI_AUDIT_AGENT_ID,
        parentSession: ID,
      });
    }
    const native = await run([], 2, "tool:1:native");
    writeFileSync(
      file,
      line({ type: "session", id: ID, cwd: CWD }) +
        line(result(1, "navori_subagent", { ...native, toolCallId: "tool:1:native" })),
    );
    expect(parse().agents[0]!.spawnToolUseId).toBe("tool:1:native");
    rmSync(roles, { recursive: true, force: true });
  });
});
