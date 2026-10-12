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
    type Tool = { execute: (...args: unknown[]) => Promise<{ details: unknown; usage?: unknown }> };
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
    const run = async (messages: unknown[]): Promise<Awaited<ReturnType<Tool["execute"]>>> => {
      let tool: Tool | undefined;
      const spawn = (): unknown => {
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
          child.emit("close", 0);
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
          env: {},
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
        "1",
        { role: "scout", task: "t" },
        new AbortController().signal,
        () => {},
        { cwd: roles, isProjectTrusted: () => true, model: { provider: "p", id: "m" } },
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
    expect(summed.details).toEqual({ role: "scout", truncated: false });
    expect((await run([{ usage: usage(10, 2) }, {}])).usage).toBeUndefined();
    rmSync(roles, { recursive: true, force: true });
  });
});
