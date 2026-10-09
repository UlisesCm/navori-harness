import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { stripTypeScriptTypes } from "node:module";
import { PassThrough } from "node:stream";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NavoriConfigSchema } from "../../../lib/config/schema.ts";
import { renderPiEngine } from "../index.ts";
import { ownsPiAgent, ownsPiSource } from "../owned-file.ts";
import { PI_EXTENSION_SOURCE } from "../extension-source.ts";

interface ChildStub extends EventEmitter {
  pid: number;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

interface SubagentTool {
  execute: (
    id: string,
    params: { role: "scout" | "implementer" | "reviewer"; task: string; feature?: string },
    signal: AbortSignal,
    onUpdate: () => void,
    context: { cwd: string; isProjectTrusted: () => boolean },
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    details: { role: string; truncated: boolean };
  }>;
}

function childStub(): ChildStub {
  return Object.assign(new EventEmitter(), {
    pid: 123,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
}

function loadRuntime(depth?: string): {
  tool: SubagentTool | undefined;
  calls: Array<{ args: string[]; child: ChildStub }>;
} {
  const calls: Array<{ args: string[]; child: ChildStub }> = [];
  let tool: SubagentTool | undefined;
  const spawn = vi.fn((program: string, args: string[]) => {
    const child = childStub();
    if (program === "navori") {
      child.stdout.write(JSON.stringify({ status: "ok", feature: "pi_engine" }));
      setImmediate(() => child.emit("close", 0));
      return child;
    }
    calls.push({ args, child });
    return child;
  });
  const schemaType = (): object => ({});
  const Type = Object.fromEntries(
    ["Object", "Union", "Literal", "String", "Optional"].map((name) => [name, schemaType]),
  );
  const modules: Record<string, unknown> = {
    "node:child_process": { spawn },
    "node:fs": { readFileSync },
    "node:path": { join },
    "@earendil-works/pi-ai": { Type },
    "@earendil-works/pi-coding-agent": {
      VERSION: "0.87.1",
      defineTool: (value: unknown): unknown => value,
    },
  };
  const exports: Record<string, unknown> = {};
  const compiled = stripTypeScriptTypes(PI_EXTENSION_SOURCE)
    .replace(/^import \{ (.+) \} from "(.+)";$/gm, 'const { $1 } = require("$2");')
    .replace("export default function", "exports.default = function");
  runInNewContext(compiled, {
    exports,
    require: (id: string): unknown => {
      if (!Object.hasOwn(modules, id)) throw new Error(`Unexpected extension import: ${id}`);
      return modules[id];
    },
    process: {
      env: depth ? { NAVORI_PI_CHILD_DEPTH: depth } : {},
      platform: "win32",
      versions: { node: "22.19.0" },
      stderr: { write: () => true },
    },
    Buffer,
    setTimeout,
    clearTimeout,
  });
  const factory = exports.default;
  if (typeof factory !== "function") throw new Error("Pi extension did not export a factory");
  factory({
    on: (): (() => void) => () => {},
    registerTool: (value: SubagentTool): void => {
      tool = value;
    },
  });
  return { tool, calls };
}

function execute(
  tool: SubagentTool,
  cwd: string,
  role: "scout" | "implementer" | "reviewer",
  signal = new AbortController().signal,
): ReturnType<SubagentTool["execute"]> {
  return tool.execute(
    "call-1",
    {
      role,
      task: "Check one scoped behavior",
      ...(role === "reviewer" ? { feature: "pi_engine" } : {}),
    },
    signal,
    () => {},
    { cwd, isProjectTrusted: () => true },
  );
}

function settle(child: ChildStub, answer = "done"): void {
  child.stdout.write(
    `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }] } })}\n`,
  );
  child.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
  child.emit("close", 0);
}

const dirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "navori-pi-subagent-"));
  dirs.push(dir);
  return dir;
}
const config = NavoriConfigSchema.parse({
  name: "pi-roles",
  preset: "custom",
  engines: ["pi"],
  branchBase: "main",
  qualityGate: { fast: "bun test", full: "bun test" },
  models: { scout: "haiku", codexMap: { haiku: "openai-codex/gpt-5" } },
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Pi subagent resources", () => {
  // Covers: R32
  it("resolves a codexMap family instead of emitting the bare family name", () => {
    const dir = freshDir();
    const family = NavoriConfigSchema.parse({
      ...config,
      models: { scout: "haiku", codexMap: { haiku: "luna" } },
    });
    renderPiEngine(dir, family);
    const scout = readFileSync(join(dir, ".pi/agents/scout.md"), "utf8");
    expect(scout).toContain('model: "openai-codex/gpt-6-luna"'); // no catalog: fallback
    expect(scout).not.toContain('model: "luna"');
  });

  // Covers: R2, R8
  it("renders owned roles with descriptions, instructions, concrete model and explicit tools", () => {
    const dir = freshDir();
    renderPiEngine(dir, config);
    const scout = readFileSync(join(dir, ".pi/agents/scout.md"), "utf8");
    expect(ownsPiAgent(scout, "scout")).toBe(true);
    expect(scout).toContain('model: "openai-codex/gpt-5"');
    expect(scout).toContain('tools: ["read","grep","find","ls","write"]');
    expect(scout).toContain("Read-only reconnaissance");
    expect(scout).toContain("# Scout Agent");
    const implementer = readFileSync(join(dir, ".pi/agents/implementer.md"), "utf8");
    expect(implementer).toContain('tools: ["read","grep","find","ls","bash","edit","write"]');
    const reviewer = readFileSync(join(dir, ".pi/agents/reviewer.md"), "utf8");
    expect(reviewer).not.toContain('"edit"');
  });

  // Covers: R2, R8
  it("keeps an edited role file and validates extension ownership and policy", () => {
    const dir = freshDir();
    renderPiEngine(dir, config);
    const path = join(dir, ".pi/agents/scout.md");
    const edited = readFileSync(path, "utf8") + "local edit\n";
    writeFileSync(path, edited);
    const result = renderPiEngine(dir, config);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ".pi/agents/scout.md", status: "user-modified-skipped" }),
      ]),
    );
    expect(readFileSync(path, "utf8")).toBe(edited);
    const extension = readFileSync(join(dir, ".pi/extensions/navori.ts"), "utf8");
    expect(ownsPiSource(extension)).toBe(true);
    expect(extension).toContain('args.push("--no-tools")');
    expect(extension).toContain('args.push("--tools", role.tools.join(","))');
    expect(extension).toContain("const MAX_CHILDREN = 3");
    expect(extension).toContain("const TIMEOUT_MS = 600_000");
    expect(extension).toContain("const GRACE_MS = 5_000");
    expect(extension).toContain("if (process.env.NAVORI_PI_CHILD_DEPTH) return");
    expect(extension).not.toContain("/Users/ulisescm/");
  });

  // Covers: R2, R8
  it("does not publish a new generation when one role collides", () => {
    const dir = freshDir();
    renderPiEngine(dir, config);
    const path = join(dir, ".pi/agents/scout.md");
    const manifestPath = join(dir, ".pi/navori.json");
    const previousManifest = readFileSync(manifestPath, "utf8");
    writeFileSync(path, readFileSync(path, "utf8") + "user note\n");
    const changed = NavoriConfigSchema.parse({ ...config, harness: { scout: false } });
    const result = renderPiEngine(dir, changed);
    expect(result.written).toEqual([]);
    expect(result.warnings).toContain(
      "Pi generation was not committed because at least one owned destination collides or was edited.",
    );
    expect(readFileSync(manifestPath, "utf8")).toBe(previousManifest);
  });
});

describe("Pi extension executable policy", () => {
  // Covers: R2, R8, R9
  it("passes role instructions, model and exact tools to Pi, then returns a settled result", async () => {
    const dir = freshDir();
    renderPiEngine(dir, config);
    const runtime = loadRuntime();
    expect(runtime.tool).toBeDefined();
    const result = execute(runtime.tool!, dir, "scout");
    expect(runtime.calls).toHaveLength(1);
    const { args, child } = runtime.calls[0]!;
    expect(args).toContain("--approve");
    expect(args).toContain("--mode");
    expect(args).toContain("json");
    expect(args).toContain("--no-session");
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual([
      "--model",
      "openai-codex/gpt-5",
    ]);
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual([
      "--tools",
      "read,grep,find,ls,write",
    ]);
    expect(args.at(-1)).toContain("# Scout Agent");
    expect(args.at(-1)).toContain("Task: Check one scoped behavior");
    settle(child, "scout answer");
    await expect(result).resolves.toEqual({
      content: [{ type: "text", text: "scout answer" }],
      details: { role: "scout", truncated: false },
    });
  });

  // Covers: R2, R8
  it("fails closed when role tools are widened, unknown, or missing; empty uses --no-tools", async () => {
    const dir = freshDir();
    renderPiEngine(dir, config);
    const path = join(dir, ".pi/agents/scout.md");
    const original = readFileSync(path, "utf8");
    const runtime = loadRuntime();
    expect(runtime.tool).toBeDefined();
    for (const invalid of ['["read","bash"]', '["read","unknown"]']) {
      writeFileSync(
        path,
        original.replace('tools: ["read","grep","find","ls","write"]', `tools: ${invalid}`),
      );
      await expect(execute(runtime.tool!, dir, "scout")).rejects.toThrow(
        "Unknown or missing Pi role tool mapping",
      );
    }
    writeFileSync(path, original.replace('tools: ["read","grep","find","ls","write"]\n', ""));
    await expect(execute(runtime.tool!, dir, "scout")).rejects.toThrow(
      "Unknown or missing Pi role tool mapping",
    );
    expect(runtime.calls).toHaveLength(0);
    writeFileSync(
      path,
      original.replace('tools: ["read","grep","find","ls","write"]', "tools: []"),
    );
    const pending = execute(runtime.tool!, dir, "scout");
    expect(runtime.calls[0]!.args).toContain("--no-tools");
    expect(runtime.calls[0]!.args).not.toContain("--tools");
    settle(runtime.calls[0]!.child);
    await expect(pending).resolves.toMatchObject({ details: { role: "scout" } });
  });

  // Covers: R8
  it("limits concurrency and removes recursive registration in a child", async () => {
    expect(loadRuntime("1").tool).toBeUndefined();
    const dir = freshDir();
    renderPiEngine(dir, config);
    const runtime = loadRuntime();
    const pending = Array.from({ length: 3 }, () => execute(runtime.tool!, dir, "reviewer"));
    await expect(execute(runtime.tool!, dir, "reviewer")).rejects.toThrow(
      "concurrency limit reached",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runtime.calls).toHaveLength(3);
    for (const call of runtime.calls) settle(call.child);
    await Promise.all(pending);
    const resumed = execute(runtime.tool!, dir, "reviewer");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runtime.calls).toHaveLength(4);
    settle(runtime.calls[3]!.child);
    await expect(resumed).resolves.toMatchObject({ details: { role: "reviewer" } });
  });

  // Covers: R8, R9
  it("terminates on abort and escalates after five seconds without orphaning a timer", async () => {
    vi.useFakeTimers();
    try {
      const dir = freshDir();
      renderPiEngine(dir, config);
      const runtime = loadRuntime();
      const controller = new AbortController();
      const pending = execute(runtime.tool!, dir, "scout", controller.signal);
      const child = runtime.calls[0]!.child;
      controller.abort();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      await vi.advanceTimersByTimeAsync(4_999);
      expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
      await vi.advanceTimersByTimeAsync(1);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      child.emit("close", null);
      await expect(pending).rejects.toThrow("cancelled, timed out, or exceeded output limit");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // Covers: R8, R9
  it("times out after ten minutes and rejects malformed or unsettled JSONL", async () => {
    vi.useFakeTimers();
    try {
      const dir = freshDir();
      renderPiEngine(dir, config);
      const runtime = loadRuntime();
      const pending = execute(runtime.tool!, dir, "scout");
      const child = runtime.calls[0]!.child;
      await vi.advanceTimersByTimeAsync(600_000);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      child.emit("close", null);
      await expect(pending).rejects.toThrow("cancelled, timed out, or exceeded output limit");
      // The SIGKILL escalation outlives the leader's close, then releases itself.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(vi.getTimerCount()).toBe(0);
      const malformed = execute(runtime.tool!, dir, "scout");
      runtime.calls[1]!.child.stdout.write("not JSON\n");
      runtime.calls[1]!.child.emit("close", 0);
      await expect(malformed).rejects.toThrow("Invalid Pi child JSONL event");
      const unsettled = execute(runtime.tool!, dir, "scout");
      runtime.calls[2]!.child.stdout.write(
        `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } })}\n`,
      );
      runtime.calls[2]!.child.emit("close", 0);
      await expect(unsettled).rejects.toThrow("before agent_settled");
    } finally {
      vi.useRealTimers();
    }
  });

  // Covers: R4, R8, R9
  it("bounds a settled assistant result and rejects oversized child records", async () => {
    const dir = freshDir();
    renderPiEngine(dir, config);
    const runtime = loadRuntime();
    const truncated = execute(runtime.tool!, dir, "scout");
    settle(runtime.calls[0]!.child, "x".repeat(70_000));
    const result = await truncated;
    expect(result.content[0]!.text).toHaveLength(65_536);
    expect(result.details.truncated).toBe(true);
    const oversized = execute(runtime.tool!, dir, "scout");
    runtime.calls[1]!.child.stdout.write("x".repeat(8 * 1024 * 1024));
    expect(runtime.calls[1]!.child.kill).not.toHaveBeenCalled();
    runtime.calls[1]!.child.stdout.write("x");
    expect(runtime.calls[1]!.child.kill).toHaveBeenCalledWith("SIGTERM");
    runtime.calls[1]!.child.emit("close", null);
    await expect(oversized).rejects.toThrow("exceeded output limit");
  });

  // Covers: R4
  it("rejects a single oversized raw-byte record before buffering it", async () => {
    const dir = freshDir();
    renderPiEngine(dir, config);
    const runtime = loadRuntime();
    const pending = execute(runtime.tool!, dir, "scout");
    const child = runtime.calls[0]!.child;
    child.stdout.write(Buffer.from("é".repeat(4 * 1024 * 1024 + 1)));
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", 0);
    await expect(pending).rejects.toThrow("exceeded output limit: event record");
  });

  // Covers: R4
  it("bounds joined blocks and resets truncation for a newer snapshot", async () => {
    const dir = freshDir();
    renderPiEngine(dir, config);
    const runtime = loadRuntime();
    const pending = execute(runtime.tool!, dir, "scout");
    const child = runtime.calls[0]!.child;
    child.stdout.write(
      `${JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "x".repeat(65_535) },
            { type: "text", text: "é" },
          ],
        },
      })}\n`,
    );
    child.stdout.write('{"type":"agent_settled"}\n');
    child.emit("close", 0);
    await expect(pending).resolves.toMatchObject({
      content: [{ text: "x".repeat(65_535) + "\n" }],
      details: { truncated: true },
    });
    const latest = execute(runtime.tool!, dir, "scout");
    const next = runtime.calls[1]!.child;
    next.stdout.write(
      `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(70_000) }] } })}\n`,
    );
    settle(next, "short snapshot");
    await expect(latest).resolves.toMatchObject({
      content: [{ text: "short snapshot" }],
      details: { truncated: false },
    });
  });

  // Covers: R4
  it("accepts large cumulative output without retaining deltas or tool events", async () => {
    const dir = freshDir();
    renderPiEngine(dir, config);
    const runtime = loadRuntime();
    const pending = execute(runtime.tool!, dir, "scout");
    const child = runtime.calls[0]!.child;
    for (let index = 0; index < 20; index++) {
      child.stdout.write(`${JSON.stringify({ type: "tool_result", text: "x".repeat(20_000) })}\n`);
      child.stdout.write(`${JSON.stringify({ type: "message_update", text: "ignored" })}\n`);
    }
    settle(child, "final answer");
    await expect(pending).resolves.toMatchObject({
      content: [{ text: "final answer" }],
      details: { truncated: false },
    });
  });

  // Covers: R4
  it("preserves UTF8 across every byte split and joins only the latest snapshot text blocks", async () => {
    const dir = freshDir();
    renderPiEngine(dir, config);
    const runtime = loadRuntime();
    const pending = execute(runtime.tool!, dir, "scout");
    const child = runtime.calls[0]!.child;
    child.stdout.write(
      `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "old" }] } })}\n`,
    );
    const output = Buffer.from(
      `${JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "México 🌮" },
            { type: "toolCall", text: "ignored" },
            { type: "text", text: "你好" },
          ],
        },
      })}\r\n${JSON.stringify({ type: "message_update", text: "ignored" })}\r\n${JSON.stringify({ type: "agent_settled" })}`,
    );
    for (const byte of output) child.stdout.write(Buffer.from([byte]));
    child.emit("close", 0);
    await expect(pending).resolves.toMatchObject({
      content: [{ text: "México 🌮\n你好" }],
      details: { truncated: false },
    });
  });

  // Covers: R4
  it.each([
    [
      "malformed after settled",
      '{"type":"agent_settled"}\nnot JSON\n',
      0,
      "Invalid Pi child JSONL",
    ],
    ["truncated EOF", '{"type":"agent_settled"}\n{"type":', 0, "Invalid Pi child JSONL"],
    ["unsettled EOF", '{"type":"message_update"}\n', 0, "before agent_settled"],
    ["nonzero exit", '{"type":"agent_settled"}\n', 1, "Pi child exited 1"],
    ["aborted settlement", '{"type":"agent_settled","aborted":true}\n', 0, "agent_settled aborted"],
    [
      "bare CR is not a delimiter",
      '{"type":"message_update"}\r{"type":"agent_settled"}\n',
      0,
      "Invalid Pi child JSONL",
    ],
  ])("rejects %s", async (_name: string, output: string, code: number, error: string) => {
    const dir = freshDir();
    renderPiEngine(dir, config);
    const runtime = loadRuntime();
    const pending = execute(runtime.tool!, dir, "scout");
    const child = runtime.calls[0]!.child;
    child.stdout.write(output);
    child.emit("close", code);
    await expect(pending).rejects.toThrow(error);
  });

  // Covers: R4
  it.each([
    ["x".repeat(65_536), "x".repeat(65_536), false],
    ["é".repeat(32_768), "é".repeat(32_768), false],
    ["x".repeat(65_535) + "🌮", "x".repeat(65_535), true],
    ["x".repeat(65_534) + "🌮", "x".repeat(65_534), true],
    ["x".repeat(65_533) + "🌮", "x".repeat(65_533), true],
    ["🌮".repeat(16_385), "🌮".repeat(16_384), true],
  ])(
    "reports byte-accurate truncation (case %#)",
    async (answer: string, expected: string, truncated: boolean) => {
      const dir = freshDir();
      renderPiEngine(dir, config);
      const runtime = loadRuntime();
      const pending = execute(runtime.tool!, dir, "scout");
      settle(runtime.calls[0]!.child, answer);
      await expect(pending).resolves.toMatchObject({
        content: [{ text: expected }],
        details: { truncated },
      });
    },
  );
});
