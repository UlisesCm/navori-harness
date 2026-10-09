import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { stripTypeScriptTypes } from "node:module";
import { PassThrough } from "node:stream";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NavoriConfigSchema } from "../../../lib/config/schema.ts";
import { renderPiEngine } from "../index.ts";
import { PI_EXTENSION_SOURCE } from "../extension-source.ts";

interface Child extends EventEmitter {
  pid: number | undefined;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}
type Execute = (
  id: string,
  params: { role: "scout"; task: string },
  signal: AbortSignal,
  onUpdate: () => void,
  context: {
    cwd: string;
    isProjectTrusted: () => boolean;
    model?: { provider: string; id: string };
  },
) => Promise<{ content: Array<{ text: string }>; details: { truncated: boolean } }>;

const GROUP = 4242;

/** Loads the rendered extension against a POSIX process stub that records group kills. */
function load(pid: number | null = GROUP): {
  run: (signal?: AbortSignal) => ReturnType<Execute>;
  children: Child[];
  groupKills: Array<[number, string]>;
  spawnFailure: () => void;
} {
  const children: Child[] = [];
  const groupKills: Array<[number, string]> = [];
  let execute: Execute | undefined;
  const spawn = (): Child => {
    const child = Object.assign(new EventEmitter(), {
      pid: pid ?? undefined,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    children.push(child);
    return child;
  };
  const modules: Record<string, unknown> = {
    "node:child_process": { spawn },
    "node:fs": { readFileSync },
    "node:path": { join },
    "@earendil-works/pi-ai": {
      Type: Object.fromEntries(
        ["Object", "Union", "Literal", "String", "Optional"].map((name) => [name, () => ({})]),
      ),
    },
    "@earendil-works/pi-coding-agent": { VERSION: "1.1.0", defineTool: (value: unknown) => value },
  };
  const exports: Record<string, unknown> = {};
  const compiled = stripTypeScriptTypes(PI_EXTENSION_SOURCE)
    .replace(/^import \{ (.+) \} from "(.+)";$/gm, 'const { $1 } = require("$2");')
    .replace("export default function", "exports.default = function");
  runInNewContext(compiled, {
    exports,
    require: (id: string): unknown => modules[id],
    process: {
      env: {},
      platform: "linux",
      versions: { node: "22.19.0" },
      stderr: { write: () => true },
      kill: (target: number, signal: string): void => {
        groupKills.push([target, signal]);
      },
    },
    Buffer,
    setTimeout,
    clearTimeout,
  });
  (exports.default as (pi: unknown) => void)({
    on: () => {},
    registerTool: (value: { execute: Execute }) => {
      execute = value.execute;
    },
  });
  const cwd = dirCwd();
  return {
    run: (signal = new AbortController().signal) =>
      execute!("c", { role: "scout", task: "t" }, signal, () => {}, {
        cwd,
        isProjectTrusted: () => true,
        model: { provider: "openai-codex", id: "gpt-parent" },
      }),
    children,
    groupKills,
    spawnFailure: () => children[0]!.emit("error", new Error("spawn pi ENOENT")),
  };
}

const dirs: string[] = [];
let cwdForRun = "";
function dirCwd(): string {
  return cwdForRun;
}
function freshProject(): void {
  cwdForRun = mkdtempSync(join(tmpdir(), "navori-pi-lifecycle-"));
  dirs.push(cwdForRun);
  renderPiEngine(
    cwdForRun,
    NavoriConfigSchema.parse({
      name: "pi-lifecycle",
      preset: "custom",
      engines: ["pi"],
      branchBase: "main",
      qualityGate: { fast: "bun test", full: "bun test" },
    }),
  );
}
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const assistant = (text: string): string =>
  `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } })}\n`;

describe("Pi child bounded incremental stream and cancellation", () => {
  // Covers: R4
  it("accepts more than 256 KiB cumulative output across LF and CRLF records", async () => {
    freshProject();
    const rt = load();
    const pending = rt.run();
    const child = rt.children[0]!;
    for (let i = 0; i < 40; i++) {
      child.stdout.write(
        `${JSON.stringify({ type: "tool_result", text: "x".repeat(10_000) })}${i % 2 ? "\r\n" : "\n"}`,
      );
    }
    child.stdout.write(assistant("México 🌮"));
    child.stdout.write(JSON.stringify({ type: "agent_settled" })); // no trailing newline at EOF
    child.emit("close", 0);
    await expect(pending).resolves.toMatchObject({
      content: [{ text: "México 🌮" }],
      details: { truncated: false },
    });
    expect(rt.groupKills).toEqual([]);
  });

  // Covers: R4
  it("rejects aborted settlement, non-zero exit, malformed JSON and spawn failure", async () => {
    freshProject();
    for (const [output, code, message] of [
      ['{"type":"agent_settled","aborted":true}\n', 0, "aborted"],
      ['{"type":"agent_settled"}\n', 2, "exited 2"],
      ["{not json}\n", 0, "Invalid Pi child JSONL"],
    ] as const) {
      const rt = load();
      const pending = rt.run();
      rt.children[0]!.stdout.write(output);
      rt.children[0]!.emit("close", code);
      await expect(pending).rejects.toThrow(message);
    }
    const rt = load(null);
    const pending = rt.run();
    rt.spawnFailure();
    await expect(pending).rejects.toThrow("ENOENT");
  });

  // Covers: R4
  it("rejects a record over 8 MiB and kills the process group", async () => {
    freshProject();
    const rt = load();
    const pending = rt.run();
    const child = rt.children[0]!;
    child.stdout.write(Buffer.alloc(8 * 1024 * 1024, 0x78));
    expect(rt.groupKills).toEqual([]);
    child.stdout.write("x");
    expect(rt.groupKills).toEqual([[-GROUP, "SIGTERM"]]);
    child.emit("close", null);
    await expect(pending).rejects.toThrow("exceeded output limit");
  });

  // Covers: R19
  it("kills the group on abort and keeps SIGKILL escalation after the leader closes", async () => {
    vi.useFakeTimers();
    freshProject();
    const rt = load();
    const controller = new AbortController();
    const pending = rt.run(controller.signal);
    const assertion = expect(pending).rejects.toThrow("cancelled, timed out");
    controller.abort();
    controller.abort();
    expect(rt.groupKills).toEqual([[-GROUP, "SIGTERM"]]);
    rt.children[0]!.emit("close", null); // leader exits; a descendant survives
    await assertion;
    await vi.advanceTimersByTimeAsync(4_999);
    expect(rt.groupKills).toEqual([[-GROUP, "SIGTERM"]]);
    await vi.advanceTimersByTimeAsync(1);
    expect(rt.groupKills).toEqual([
      [-GROUP, "SIGTERM"],
      [-GROUP, "SIGKILL"],
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  // Covers: R19
  it("times out after ten minutes, escalates once and releases every timer", async () => {
    vi.useFakeTimers();
    freshProject();
    const rt = load();
    const pending = rt.run();
    const assertion = expect(pending).rejects.toThrow("cancelled, timed out");
    await vi.advanceTimersByTimeAsync(599_999);
    expect(rt.groupKills).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(rt.groupKills).toEqual([[-GROUP, "SIGTERM"]]);
    await vi.advanceTimersByTimeAsync(5_000);
    rt.children[0]!.emit("close", null);
    await assertion;
    expect(rt.groupKills.map(([, signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  // Covers: R19
  it("releases timers and abort listener on spawn failure without escalating", async () => {
    vi.useFakeTimers();
    freshProject();
    const rt = load(null);
    const controller = new AbortController();
    const pending = rt.run(controller.signal);
    const assertion = expect(pending).rejects.toThrow("ENOENT");
    rt.spawnFailure();
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
    controller.abort();
    expect(rt.children[0]!.kill).not.toHaveBeenCalled();
  });
});
