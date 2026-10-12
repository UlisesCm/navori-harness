import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NavoriConfigSchema } from "../../../lib/config/schema.ts";
import { PI_EXTENSION_SOURCE } from "../extension-source.ts";
import { renderPiEngine } from "../index.ts";
import { PI_TRUST_SOURCE } from "../trust-source.ts";

interface StubChild extends EventEmitter {
  pid: number;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

interface PiTool {
  execute: (
    id: string,
    params: { role: "scout"; task: string },
    signal: AbortSignal,
    onUpdate: () => void,
    ctx: { cwd: string; isProjectTrusted?: () => boolean },
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(): string {
  const cwd = mkdtempSync(join(tmpdir(), "navori-pi-trust-"));
  dirs.push(cwd);
  const config = NavoriConfigSchema.parse({
    name: "pi-trust",
    preset: "custom",
    engines: ["pi"],
    branchBase: "main",
    qualityGate: { fast: "bun test", full: "bun test" },
  });
  renderPiEngine(cwd, config);
  return cwd;
}

function runtime(depth?: string): {
  tool: PiTool | undefined;
  calls: Array<{ program: string; args: string[]; child: StubChild }>;
  reads: string[];
} {
  const calls: Array<{ program: string; args: string[]; child: StubChild }> = [];
  const reads: string[] = [];
  let tool: PiTool | undefined;
  const spawn = (program: string, args: string[]): StubChild => {
    const child = Object.assign(new EventEmitter(), {
      pid: 100,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    calls.push({ program, args, child });
    return child;
  };
  const schemaType = (): object => ({});
  const Type = Object.fromEntries(
    ["Object", "Union", "Literal", "String", "Optional"].map((name) => [name, schemaType]),
  );
  const exports: Record<string, unknown> = {};
  const compiled = stripTypeScriptTypes(PI_EXTENSION_SOURCE)
    .replace(/^import \{ (.+) \} from "(.+)";$/gm, 'const { $1 } = require("$2");')
    .replace("export default function", "exports.default = function");
  const runtimeProcess = {
    env: depth ? { NAVORI_PI_CHILD_DEPTH: depth } : {},
    platform: "win32",
    versions: { node: "22.19.0" },
    stderr: { write: () => true },
  };
  runInNewContext(compiled, {
    exports,
    require: (id: string): unknown => {
      if (id === "node:child_process") return { spawn };
      if (id === "node:fs")
        return {
          readFileSync: (path: string, encoding: BufferEncoding): string => {
            reads.push(path);
            return readFileSync(path, encoding);
          },
        };
      if (id === "node:path") return { join };
      if (id === "@earendil-works/pi-ai") return { Type };
      if (id === "@earendil-works/pi-coding-agent")
        return { VERSION: "1.1.0", defineTool: (value: unknown): unknown => value };
      throw new Error(`Unexpected extension import: ${id}`);
    },
    process: runtimeProcess,
    Buffer,
    setTimeout,
    clearTimeout,
  });
  const factory = exports.default;
  if (typeof factory !== "function") throw new Error("Pi extension did not export a factory");
  factory({
    on: (): (() => void) => () => {},
    registerTool: (value: PiTool): void => {
      tool = value;
    },
  });
  return { tool, calls, reads };
}

function execute(
  tool: PiTool,
  cwd: string,
  ctx: { isProjectTrusted?: () => boolean; model?: { provider: string; id: string } },
): ReturnType<PiTool["execute"]> {
  return tool.execute(
    "trust-test",
    { role: "scout", task: "Inspect the project" },
    new AbortController().signal,
    () => {},
    { cwd, ...ctx },
  );
}

describe("Pi trusted-parent handoff", () => {
  // Covers: R7
  it("embeds the fail-closed guard in the extension before resource reads", () => {
    expect(PI_TRUST_SOURCE).toContain("ctx.isProjectTrusted?.() === true");
    expect(PI_EXTENSION_SOURCE).toContain("function assertTrustedPiParent");
    const executeStart = PI_EXTENSION_SOURCE.indexOf("async execute(");
    const guard = PI_EXTENSION_SOURCE.indexOf("assertTrustedPiParent(ctx)", executeStart);
    const role = PI_EXTENSION_SOURCE.indexOf("roleSpec(ctx.cwd", executeStart);
    expect(guard).toBeGreaterThan(executeStart);
    expect(role).toBeGreaterThan(guard);
  });

  // Covers: R7
  it("rejects untrusted, absent, and failing trust APIs before reads, gates, or child spawn", async () => {
    const cwd = project();
    const rt = runtime();
    expect(rt.tool).toBeDefined();
    for (const ctx of [
      { isProjectTrusted: (): boolean => false },
      {},
      {
        isProjectTrusted: (): boolean => {
          throw new Error("Pi trust API failed");
        },
      },
    ]) {
      await expect(execute(rt.tool!, cwd, ctx)).rejects.toThrow(
        "requires a trusted parent project",
      );
    }
    expect(rt.reads).toEqual([]);
    expect(rt.calls).toEqual([]);
  });

  // Covers: R7
  it("allows an ephemeral trusted parent to pass process-scoped --approve, never -e", async () => {
    const cwd = project();
    const rt = runtime();
    const pending = execute(rt.tool!, cwd, {
      isProjectTrusted: (): boolean => true,
      model: { provider: "openai-codex", id: "gpt-parent" },
    });
    await vi.waitFor(() => expect(rt.calls).toHaveLength(1));
    expect(rt.calls[0]!.program).toBe("pi");
    expect(rt.calls[0]!.args).toContain("--approve");
    expect(rt.calls[0]!.args).not.toContain("-e");
    rt.calls[0]!.child.stdout.write(
      `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } })}\n`,
    );
    rt.calls[0]!.child.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
    rt.calls[0]!.child.emit("close", 0);
    await expect(pending).resolves.toMatchObject({ content: [{ type: "text", text: "done" }] });
  });

  // Covers: R7
  it("does not expose a nested orchestration tool or write trust/auth state", () => {
    const rt = runtime("1");
    expect(rt.tool).toBeUndefined();
    expect(rt.reads).toEqual([]);
    expect(rt.calls).toEqual([]);
    expect(PI_EXTENSION_SOURCE).not.toContain("auth.json");
    expect(PI_EXTENSION_SOURCE).not.toContain("trust.json");
  });
});
