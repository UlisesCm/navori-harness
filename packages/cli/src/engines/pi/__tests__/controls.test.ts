import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PI_EXTENSION_SOURCE } from "../extension-source.ts";
import { PI_TRUST_SOURCE } from "../trust-source.ts";
import { serializePiAgent, serializePiManifest } from "../owned-file.ts";

type Role = "scout" | "implementer" | "reviewer";
type Tool = {
  execute: (
    id: string,
    params: { role: Role; task: string; feature?: string },
    signal: AbortSignal,
    update: () => void,
    ctx: { cwd: string },
  ) => Promise<unknown>;
};
type EventHandler = (
  event: Record<string, unknown>,
  ctx: { cwd: string },
) => Promise<unknown> | unknown;
type StubProcess = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  pid: number;
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(
  flags: { planTiers?: boolean; masterPlan?: boolean; scribeOwnsMarkdown?: boolean } = {},
): string {
  const cwd = mkdtempSync(join(tmpdir(), "navori-pi-controls-"));
  dirs.push(cwd);
  mkdirSync(join(cwd, ".pi/agents"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi/navori.json"),
    serializePiManifest({
      schemaVersion: 1,
      agents: ["scout", "implementer", "reviewer"],
      controls: {
        planTiers: flags.planTiers ?? false,
        masterPlan: flags.masterPlan ?? false,
        scribeOwnsMarkdown: flags.scribeOwnsMarkdown ?? false,
      },
    }),
  );
  for (const role of ["scout", "implementer", "reviewer"] as const) {
    writeFileSync(
      join(cwd, `.pi/agents/${role}.md`),
      serializePiAgent({
        name: role,
        description: role,
        instructions: `# ${role}`,
        tools: ["read"],
      }),
    );
  }
  return cwd;
}

function processStub(): StubProcess {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
    pid: 123,
  });
}

function loadRuntime(env: Record<string, string> = {}): {
  tool?: Tool;
  handlers: Map<string, EventHandler>;
  launches: Array<{ program: string; args: string[]; input: string; child: StubProcess }>;
  spawn: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
} {
  const handlers = new Map<string, EventHandler>();
  const launches: Array<{ program: string; args: string[]; input: string; child: StubProcess }> =
    [];
  let tool: Tool | undefined;
  const spawn = vi.fn((program: string, args: string[]) => {
    const child = processStub();
    const launch = { program, args, input: "", child };
    child.stdin.on("data", (chunk: Buffer) => {
      launch.input += chunk.toString();
    });
    launches.push(launch);
    return child;
  });
  const exec = vi.fn(async () => ({ code: 0, stdout: "Plan maestro — etapa activa", stderr: "" }));
  const schemaType = (): object => ({});
  const Type = Object.fromEntries(
    ["Object", "Union", "Literal", "String", "Optional"].map((name) => [name, schemaType]),
  );
  const exports: Record<string, unknown> = {};
  const compiled = stripTypeScriptTypes(PI_EXTENSION_SOURCE)
    .replace(/^import \{ (.+) \} from "(.+)";$/gm, 'const { $1 } = require("$2");')
    .replace("export default function", "exports.default = function");
  expect(PI_EXTENSION_SOURCE).toContain(PI_TRUST_SOURCE);
  runInNewContext(compiled, {
    exports,
    require: (id: string): unknown => {
      if (id === "node:child_process") return { spawn };
      if (id === "node:fs") return { readFileSync };
      if (id === "node:path") return { join };
      if (id === "@earendil-works/pi-ai") return { Type };
      if (id === "@earendil-works/pi-coding-agent")
        return { VERSION: "0.87.1", defineTool: (value: unknown): unknown => value };
      throw new Error(`Unexpected import: ${id}`);
    },
    process: {
      env,
      platform: "win32",
      versions: { node: "22.19.0" },
      stderr: { write: () => true },
    },
    Buffer,
    setTimeout,
    clearTimeout,
  });
  const factory = exports.default;
  if (typeof factory !== "function") throw new Error("Missing Pi extension factory");
  factory({
    on: (name: string, handler: EventHandler): (() => void) => {
      handlers.set(name, handler);
      return () => {};
    },
    registerTool: (value: Tool): void => {
      tool = value;
    },
    exec,
  });
  return { tool, handlers, launches, spawn, exec };
}

function invoke(tool: Tool, cwd: string, role: Role, feature?: string): Promise<unknown> {
  return tool.execute(
    "call-1",
    { role, task: "workplan: pi_engine\nImplement scoped task", feature },
    new AbortController().signal,
    () => {},
    { cwd, isProjectTrusted: () => true } as { cwd: string },
  );
}

describe("Pi control mappings", () => {
  // Covers: R3
  it("gates implementer dispatch with exact Codex payload and fails closed on deny", async () => {
    const cwd = fixture({ planTiers: true });
    const runtime = loadRuntime();
    const pending = invoke(runtime.tool!, cwd, "implementer");
    expect(runtime.launches).toHaveLength(1);
    expect(runtime.launches[0]).toMatchObject({ program: "navori", args: ["plan", "gate"] });
    expect(JSON.parse(runtime.launches[0]!.input)).toEqual({
      cwd,
      tool_input: {
        agent_type: "implementer",
        message: "workplan: pi_engine\nImplement scoped task",
      },
    });
    runtime.launches[0]!.child.emit("close", 2);
    await expect(pending).rejects.toThrow("plan gate blocked");
    expect(runtime.launches).toHaveLength(1);
  });

  // Covers: R3
  it("allows an approved implementer only after gate success and skips the gate when disabled", async () => {
    const cwd = fixture({ planTiers: true });
    const runtime = loadRuntime();
    const pending = invoke(runtime.tool!, cwd, "implementer");
    runtime.launches[0]!.child.emit("close", 0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runtime.launches.map((launch) => launch.program)).toEqual(["navori", "pi"]);
    runtime.launches[1]!.child.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
    runtime.launches[1]!.child.emit("close", 0);
    await expect(pending).resolves.toMatchObject({ details: { role: "implementer" } });

    const disabled = fixture();
    const direct = loadRuntime();
    const directPending = invoke(direct.tool!, disabled, "implementer");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(direct.launches.map((launch) => launch.program)).toEqual(["pi"]);
    direct.launches[0]!.child.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
    direct.launches[0]!.child.emit("close", 0);
    await expect(directPending).resolves.toMatchObject({ details: { role: "implementer" } });
  });

  // Covers: R3
  it("skips disabled plan gate and blocks a reviewer without explicit feature or valid handoff", async () => {
    const cwd = fixture();
    const runtime = loadRuntime();
    await expect(invoke(runtime.tool!, cwd, "reviewer")).rejects.toThrow(
      "explicit Navori feature slug",
    );
    const pending = invoke(runtime.tool!, cwd, "reviewer", "pi_engine");
    expect(runtime.launches[0]).toMatchObject({
      program: "navori",
      args: [
        "handoff",
        "check",
        "pi_engine",
        "--for",
        "orchestrator",
        "--cwd",
        cwd,
        "--dir",
        ".navori/state/handoffs",
        "--json",
      ],
    });
    runtime.launches[0]!.child.stdout.write('{"status":"findings","feature":"pi_engine"}');
    runtime.launches[0]!.child.emit("close", 2);
    await expect(pending).rejects.toThrow("handoff check did not pass");
    expect(runtime.launches).toHaveLength(1);
  });

  // Covers: R3
  it("fails closed on malformed handoff JSON and permits a valid explicit-feature reviewer", async () => {
    const cwd = fixture();
    const runtime = loadRuntime();
    const malformed = invoke(runtime.tool!, cwd, "reviewer", "pi_engine");
    runtime.launches[0]!.child.stdout.write("not-json");
    runtime.launches[0]!.child.emit("close", 0);
    await expect(malformed).rejects.toThrow("Invalid Navori handoff check JSON");
    const allowed = invoke(runtime.tool!, cwd, "reviewer", "pi_engine");
    runtime.launches[1]!.child.stdout.write(JSON.stringify({ status: "ok", feature: "pi_engine" }));
    runtime.launches[1]!.child.emit("close", 0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runtime.launches[2]!.program).toBe("pi");
    runtime.launches[2]!.child.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
    runtime.launches[2]!.child.emit("close", 0);
    await expect(allowed).resolves.toMatchObject({ details: { role: "reviewer" } });
  });

  // Covers: R3
  it("injects master-plan context only when configured and blocks direct Markdown writes in implementer child", async () => {
    const cwd = fixture({ masterPlan: true, scribeOwnsMarkdown: true });
    const parent = loadRuntime();
    const before = parent.handlers.get("before_agent_start")!;
    expect(await before({ systemPrompt: "Original" }, { cwd })).toEqual({
      systemPrompt: "Original\n\nPlan maestro — etapa activa",
    });
    const child = loadRuntime({ NAVORI_PI_CHILD_DEPTH: "1", NAVORI_PI_CHILD_ROLE: "implementer" });
    expect(child.tool).toBeUndefined();
    const call = child.handlers.get("tool_call")!;
    expect(
      await call({ toolName: "write", input: { path: "specs/task.md" } }, { cwd }),
    ).toMatchObject({ block: true });
    expect(
      await call({ toolName: "edit", input: { path: "src/code.ts" } }, { cwd }),
    ).toBeUndefined();
    expect(
      await call({ toolName: "bash", input: { command: "cat > task.md" } }, { cwd }),
    ).toBeUndefined();
  });
});
