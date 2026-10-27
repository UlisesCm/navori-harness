import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createKnowledgeClient,
  type KnowledgeClient,
  type KnowledgeServerSpec,
} from "../knowledge-client.ts";
import {
  PI_KNOWLEDGE_SERVERS,
  PI_KNOWLEDGE_TOOL_NAMES,
  piKnowledgeGrants,
} from "../knowledge-tools.ts";
import { renderPiExtensionSource } from "../extension-source.ts";
import { serializeAnonymousFunction } from "../runtime-version.ts";
import { loadEnabledPlugins } from "../../../lib/config/plugins.ts";
import { load, type Handler } from "./fixtures/load-extension.ts";

/**
 * A fake stdio MCP server (newline-delimited JSON-RPC). `FAKE_MODE` picks the behaviour; every
 * start and every received message is appended to `FAKE_LOG` (default `<cwd>/fake.log`).
 */
const FAKE_SERVER = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const mode = process.env.FAKE_MODE || "ok";
const log = process.env.FAKE_LOG || path.join(process.cwd(), "fake.log");
const note = (value) => fs.appendFileSync(log, JSON.stringify(value) + "\n");
note({ event: "start", pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(),
  env: { codegraphTools: process.env.CODEGRAPH_MCP_TOOLS ?? null, secret: process.env.SECRET_TOKEN ?? null,
    child: process.env.NAVORI_PI_CHILD_ROLE ?? null } });
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const sendSlowly = (value) => {
  const text = JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n";
  const cut = Math.floor(text.length / 3);
  process.stdout.write(text.slice(0, cut));
  setTimeout(() => process.stdout.write(text.slice(cut, cut * 2)), 30);
  setTimeout(() => process.stdout.write(text.slice(cut * 2)), 60);
};
fs.writeSync(2, "x".repeat(200000) + "\n"); // a noisy stderr must be drained, never block the server
let buffered = "";
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  for (let at = buffered.indexOf("\n"); at >= 0; at = buffered.indexOf("\n")) {
    const line = buffered.slice(0, at);
    buffered = buffered.slice(at + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
function handle(message) {
  note({ event: "recv", method: message.method, id: message.id, errorCode: message.error ? message.error.code : undefined,
    params: message.params });
  if (message.method === "initialize" && mode === "noinit") return;
  if (message.method === "initialize") {
    send({ id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
    return;
  }
  if (message.method !== "tools/call") return;
  if (mode === "crash") { fs.writeSync(2, "index missing: run codegraph init\n"); process.exit(3); }
  if (mode === "slow") return;
  if (mode === "big") { send({ id: message.id, result: { content: [{ type: "text", text: "é".repeat(100) }] } }); return; }
  const result = { content: [{ type: "text", text: "echo:" + JSON.stringify(message.params.arguments) }] };
  if (mode === "partial") {
    process.stdout.write("starting up, not json\n");
    send({ method: "notifications/message", params: { level: "info", data: "hello" } });
    send({ id: "srv-1", method: "roots/list" });
    sendSlowly({ id: message.id, result });
    return;
  }
  send({ id: message.id, result });
}
`;

const dirs: string[] = [];
const clients: KnowledgeClient[] = [];

/** Shutdown handlers of every child extension a test loaded: they kill the servers it started. */
const shutdowns: Handler[] = [];

afterEach(async () => {
  for (const handler of shutdowns.splice(0)) await handler({ reason: "quit" }, {});
  for (const client of clients.splice(0)) client.shutdown();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "navori-knowledge-"));
  dirs.push(dir);
  return dir;
}

/** The client exactly as the extension embeds it: serialized source, evaluated with no module scope. */
const serializedFactory = new Function(
  `return (${serializeAnonymousFunction(createKnowledgeClient)})`,
)() as typeof createKnowledgeClient;

function fake(
  dir: string,
  mode: string,
  overrides: Partial<KnowledgeServerSpec> = {},
): KnowledgeServerSpec {
  const script = join(dir, "fake-server.cjs");
  if (!existsSync(script)) writeFileSync(script, FAKE_SERVER);
  return {
    command: process.execPath,
    args: [script, "--flag", "{cwd}"],
    env: { FAKE_MODE: mode, FAKE_LOG: join(dir, "fake.log"), CODEGRAPH_MCP_TOOLS: "explore" },
    tools: ["echo_tool"],
    timeoutMs: 5_000,
    ...overrides,
  };
}

function client(
  spec: KnowledgeServerSpec,
  maxBytes = 65_536,
  env: Record<string, string> = {},
): KnowledgeClient {
  const created = serializedFactory(
    spawn,
    { fake: spec },
    { PATH: process.env.PATH, SECRET_TOKEN: "s3cret", ...env },
    maxBytes,
  );
  clients.push(created);
  return created;
}

function events(dir: string): Array<Record<string, unknown>> {
  const file = join(dir, "fake.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("knowledge client (serialized form against a fake MCP server)", () => {
  // Covers: A1
  it("spawns with the fixed argv and a filtered env, and keeps a model query out of argv", async () => {
    const dir = scratch();
    const subject = client(fake(dir, "ok"));
    const result = await subject.call("fake", "echo_tool", { query: "--dangerous -p /etc" }, dir);
    expect(result).toEqual({ text: 'echo:{"query":"--dangerous -p /etc"}', isError: false });
    const [start] = events(dir);
    expect(start).toMatchObject({
      event: "start",
      argv: ["--flag", dir],
      cwd: expect.stringContaining("navori-knowledge-"),
    });
    // Only the allowlisted keys reach the server: the parent's secret and child identity do not.
    expect(start!.env).toEqual({ codegraphTools: "explore", secret: null, child: null });
    const call = events(dir).find((e) => e.method === "tools/call");
    expect(call).toMatchObject({
      params: { name: "echo_tool", arguments: { query: "--dangerous -p /etc" } },
    });
    expect(JSON.stringify(start)).not.toContain("dangerous");
  });

  // Covers: A1
  it("survives partial lines, banners, notifications and server requests (answered -32601)", async () => {
    const dir = scratch();
    const subject = client(fake(dir, "partial"));
    const result = await subject.call("fake", "echo_tool", { query: "q" }, dir);
    expect(result).toEqual({ text: 'echo:{"query":"q"}', isError: false });
    expect(events(dir)).toContainEqual(
      expect.objectContaining({ event: "recv", id: "srv-1", errorCode: -32601 }),
    );
    expect(events(dir).map((e) => e.method)).toContain("notifications/initialized");
  });

  // Covers: A1
  it("refuses a tool outside the closed allowlist before any process starts", async () => {
    const dir = scratch();
    const subject = client(fake(dir, "ok"));
    const result = await subject.call("fake", "mem_save", { title: "x" }, dir);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("not a read-only tool");
    expect((await subject.call("nope", "echo_tool", {}, dir)).isError).toBe(true);
    expect(events(dir)).toEqual([]);
  });

  // Covers: A1
  it("starts one server for concurrent first calls", async () => {
    const dir = scratch();
    const subject = client(fake(dir, "ok"));
    const results = await Promise.all(
      [1, 2, 3, 4].map((n) => subject.call("fake", "echo_tool", { n }, dir)),
    );
    expect(results.map((r) => r.isError)).toEqual([false, false, false, false]);
    expect(events(dir).filter((e) => e.event === "start")).toHaveLength(1);
    expect(events(dir).filter((e) => e.method === "initialize")).toHaveLength(1);
  });

  // Covers: A1
  it("reports a crash mid-call as a tool error with the stderr tail, respawns once, then gives up", async () => {
    const dir = scratch();
    const subject = client(fake(dir, "crash"));
    const first = await subject.call("fake", "echo_tool", {}, dir);
    expect(first.isError).toBe(true);
    expect(first.text).toContain("exited (code 3)");
    expect(first.text).toContain("index missing");
    expect((await subject.call("fake", "echo_tool", {}, dir)).isError).toBe(true);
    const third = await subject.call("fake", "echo_tool", {}, dir);
    expect(third.text).toContain("failed repeatedly");
    expect(events(dir).filter((e) => e.event === "start")).toHaveLength(2);
  });

  // Covers: A1
  it("times out a silent server, tells it to cancel, and honors an abort signal", async () => {
    const dir = scratch();
    const subject = client(fake(dir, "slow", { timeoutMs: 250 }));
    const slow = await subject.call("fake", "echo_tool", {}, dir);
    expect(slow.isError).toBe(true);
    expect(slow.text).toContain("timed out");
    await vi.waitFor(() =>
      expect(events(dir).some((e) => e.method === "notifications/cancelled")).toBe(true),
    );

    const controller = new AbortController();
    const aborted = subject.call("fake", "echo_tool", {}, dir, controller.signal);
    setTimeout(() => controller.abort(), 50);
    expect((await aborted).text).toContain("aborted");
  });

  // Covers: A1
  it("a server that never answers initialize times out, is killed, and a later call respawns up to the limit", async () => {
    const dir = scratch();
    const subject = client(fake(dir, "noinit", { initTimeoutMs: 200 }));
    const first = await subject.call("fake", "echo_tool", {}, dir);
    expect(first.isError).toBe(true);
    expect(first.text).toContain("timed out");
    const pidOf = (n: number): number =>
      (events(dir).filter((e) => e.event === "start")[n]?.pid as number | undefined) ?? 0;
    await vi.waitFor(() => expect(() => process.kill(pidOf(0), 0)).toThrow());
    expect((await subject.call("fake", "echo_tool", {}, dir)).isError).toBe(true);
    const third = await subject.call("fake", "echo_tool", {}, dir);
    expect(third.text).toContain("failed repeatedly");
    expect(events(dir).filter((e) => e.event === "start")).toHaveLength(2);
    await vi.waitFor(() => expect(() => process.kill(pidOf(1), 0)).toThrow());
  });

  // Covers: A1
  it("cuts output by bytes without splitting a UTF-8 sequence", async () => {
    const dir = scratch();
    const subject = client(fake(dir, "big"), 7);
    const result = await subject.call("fake", "echo_tool", {}, dir);
    expect(result.isError).toBe(false);
    // 7 bytes of 2-byte characters: 3 whole characters (6 bytes), never a half one.
    expect(result.text.startsWith("ééé\n[output truncated at 7 bytes]")).toBe(true);
    expect(result.text).not.toContain("�");
  });

  // Covers: A1
  it("turns a missing binary into a clean tool error", async () => {
    const dir = scratch();
    const subject = client(fake(dir, "ok", { command: "navori-no-such-binary" }));
    const result = await subject.call("fake", "echo_tool", {}, dir);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("navori-no-such-binary is not on PATH");
    expect(result.text).toContain("Continue with read/grep/find");
  });

  // Covers: A1
  it("shutdown kills the server and a pending call fails instead of hanging", async () => {
    const dir = scratch();
    const subject = client(fake(dir, "slow", { timeoutMs: 30_000 }));
    const pending = subject.call("fake", "echo_tool", {}, dir);
    await vi.waitFor(() => expect(events(dir).some((e) => e.method === "tools/call")).toBe(true));
    subject.shutdown();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.text).toContain("shut down");
  });
});

describe("the fixed server table", () => {
  // Covers: A1
  it("spawns exactly the read-only argv, never a write tool or a model-controlled flag", () => {
    expect(PI_KNOWLEDGE_SERVERS.engram).toMatchObject({
      command: "engram",
      args: ["mcp", "--tools=mem_search,mem_get_observation"],
      tools: ["mem_search", "mem_get_observation"],
    });
    expect(PI_KNOWLEDGE_SERVERS.codegraph).toMatchObject({
      command: "codegraph",
      args: ["serve", "--mcp", "--no-watch", "-p", "{cwd}"],
      env: expect.objectContaining({ CODEGRAPH_MCP_TOOLS: "explore" }),
      tools: ["codegraph_explore"],
    });
    expect(JSON.stringify(PI_KNOWLEDGE_SERVERS)).not.toContain("mem_save");
    expect(PI_KNOWLEDGE_TOOL_NAMES).toEqual([
      "navori_codegraph_explore",
      "navori_mem_search",
      "navori_mem_get_observation",
    ]);
  });
});

describe("the extension registers the granted tools only in a child", () => {
  type RegisteredTool = {
    name: string;
    execute: (
      id: string,
      params: unknown,
      signal: AbortSignal,
      update: () => void,
      ctx: { cwd: string },
    ) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
  };

  function fakeBin(dir: string): string {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    for (const name of ["codegraph", "engram"]) {
      const file = join(bin, name);
      writeFileSync(file, `#!${process.execPath}\n${FAKE_SERVER}`);
      chmodSync(file, 0o755);
    }
    return bin;
  }

  /** The rendered extension with the real grants for the enabled plugins, loaded as a child of `role`. */
  function child(
    role: string,
    env: Record<string, string> = {},
    liveEnv?: Record<string, string>,
  ): Map<string, RegisteredTool> {
    const plugins = loadEnabledPlugins({
      codegraph: { enabled: true },
      engram: { enabled: true },
    }).loaded;
    const tools = new Map<string, RegisteredTool>();
    const collect = new Map<string, Handler[]>();
    load({
      collect,
      source: renderPiExtensionSource(["codegraph", "engram"], piKnowledgeGrants(plugins)),
      tools: tools as Map<string, unknown>,
      env: { NAVORI_PI_CHILD_DEPTH: "1", NAVORI_PI_CHILD_ROLE: role, ...env },
      ...(liveEnv ? { liveEnv } : {}),
    });
    // In a child the only shutdown handler is the knowledge client's own.
    if (tools.size && role) shutdowns.push(...(collect.get("session_shutdown") ?? []));
    return tools;
  }

  // Covers: A1
  it("grants per role, registers nothing in the parent, and runs the tool through the serialized client", async () => {
    expect([...child("auditor").keys()].sort()).toEqual([
      "navori_codegraph_explore",
      "navori_mem_get_observation",
      "navori_mem_search",
    ]);
    expect([...child("architect").keys()]).toEqual(["navori_codegraph_explore"]);
    expect(child("scribe").size).toBe(0);
    expect(child("publisher").size).toBe(0);
    // The parent only owns navori_subagent: no knowledge tool is registered there.
    expect([...child("", { NAVORI_PI_CHILD_DEPTH: "" }).keys()]).toEqual(["navori_subagent"]);

    const dir = scratch();
    const tools = child("reviewer", { PATH: `${fakeBin(dir)}:${process.env.PATH ?? ""}` });
    const ctx = { cwd: dir };
    const explore = await tools
      .get("navori_codegraph_explore")!
      .execute(
        "c1",
        { query: "login flow", maxFiles: 3, injected: "-p /etc" },
        new AbortController().signal,
        () => {},
        ctx,
      );
    // Unknown keys are dropped and projectPath is forced to the child's own cwd.
    expect(explore.isError).toBeUndefined();
    expect(explore.content[0]!.text).toBe(
      `echo:${JSON.stringify({ query: "login flow", maxFiles: 3, projectPath: dir })}`,
    );
    const memory = await tools
      .get("navori_mem_search")!
      .execute(
        "c2",
        { query: "auth", response_format: "compact" },
        new AbortController().signal,
        () => {},
        ctx,
      );
    expect(memory.content[0]!.text).toBe('echo:{"query":"auth","response_format":"compact"}');
    const starts = readFileSync(join(dir, "fake.log"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; argv: string[] })
      .filter((e) => e.event === "start");
    expect(starts.map((s) => s.argv)).toEqual([
      ["serve", "--mcp", "--no-watch", "-p", dir],
      ["mcp", "--tools=mem_search,mem_get_observation"],
    ]);
  });

  // Covers: A1
  it("re-checks the grant in execute() and fails cleanly without the binary", async () => {
    const dir = scratch();
    const live: Record<string, string> = {};
    const tools = child("reviewer", { PATH: join(dir, "empty") }, live);
    const explore = tools.get("navori_codegraph_explore")!;
    const missing = await explore.execute(
      "c",
      { query: "x" },
      new AbortController().signal,
      () => {},
      { cwd: dir },
    );
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toContain("codegraph is not on PATH");

    // The role changed after registration (tool_call has no default-deny): the tool is refused, not run.
    live.NAVORI_PI_CHILD_ROLE = "architect";
    const refused = await tools
      .get("navori_mem_search")!
      .execute("c", { query: "x" }, new AbortController().signal, () => {}, { cwd: dir });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("is not granted navori_mem_search");
  });
});
