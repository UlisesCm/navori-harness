import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import * as nodeFs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PI_EXTENSION_SOURCE } from "../extension-source.ts";
import { PI_TRUST_SOURCE } from "../trust-source.ts";
import { serializePiAgent, serializePiManifest } from "../owned-file.ts";
import { NavoriConfigSchema } from "../../../lib/config/schema.ts";
import { renderPiEngine } from "../index.ts";
import { PI_HOOK_BINDINGS } from "../hook-bindings.ts";
import { load as loadWithScripts } from "./fixtures/load-extension.ts";

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
  pid?: number;
};
type SpawnOptions = { cwd: string; stdio: string[] };
type Launch = {
  program: string;
  args: string[];
  input: string;
  child: StubProcess;
  options: SpawnOptions;
};

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Creates a control fixture with the real ownership hook whenever its policy is enabled. */
function fixture(
  flags: { planTiers?: boolean; masterPlan?: boolean; scribeOwnsMarkdown?: boolean } = {},
): string {
  const cwd = mkdtempSync(join(tmpdir(), "navori-pi-controls-"));
  dirs.push(cwd);
  mkdirSync(join(cwd, ".pi/agents"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi/navori.json"),
    serializePiManifest({
      schemaVersion: 2,
      agents: ["scout", "implementer", "reviewer"],
      controls: {
        planTiers: flags.planTiers ?? false,
        masterPlan: flags.masterPlan ?? false,
        scribeOwnsMarkdown: flags.scribeOwnsMarkdown ?? false,
      },
      hooks: [],
      ownedPaths: [],
      permissionRules: { ask: [], deny: [] },
    }),
  );
  if (flags.scribeOwnsMarkdown) {
    renderPiEngine(
      cwd,
      NavoriConfigSchema.parse({
        name: "pi-controls",
        preset: "custom",
        engines: ["pi"],
        harness: flags,
      }),
      {
        hookBindings: PI_HOOK_BINDINGS.filter(
          (binding) => binding.script === "implementer-no-markdown",
        ),
      },
    );
  }
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
  launches: Launch[];
  spawn: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
} {
  const handlers = new Map<string, EventHandler>();
  const launches: Launch[] = [];
  let tool: Tool | undefined;
  const spawn = vi.fn((program: string, args: string[], options: SpawnOptions): StubProcess => {
    const child = processStub();
    const launch = { program, args, input: "", child, options };
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
      // spawnSync is real: the doctrine lane asks git about sibling worktrees (#1330), and on Linux
      // (no /var symlink in the tmp path) the "../elsewhere" case reaches it.
      if (id === "node:child_process") return { spawn, spawnSync };
      // The edit/write lane (spec 0048 T5) resolves real paths, so fs and path are the real ones.
      if (id === "node:fs") return nodeFs;
      if (id === "node:path") return nodePath;
      if (id === "@earendil-works/pi-ai") return { Type };
      if (id === "@earendil-works/pi-coding-agent")
        return { VERSION: "1.1.0", defineTool: (value: unknown): unknown => value };
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

const PARENT_MODEL = { provider: "openai-codex", id: "gpt-parent" };

function invoke(
  tool: Tool,
  cwd: string,
  role: Role,
  feature?: string,
  signal: AbortSignal = new AbortController().signal,
  task: string = "workplan: pi_engine\nImplement scoped task",
): Promise<unknown> {
  return tool.execute("call-1", { role, task, feature }, signal, () => {}, {
    cwd,
    isProjectTrusted: () => true,
    model: PARENT_MODEL,
  } as { cwd: string });
}

const workplanReason = (slug: string = "demo"): string =>
  `[navori] BLOCKED by plan-gate: feature "${slug}" already has a workplan — open with \`workplan: ${slug}\`, not nivel-0.\n`;

describe("Pi control mappings", () => {
  // Covers: R4
  it.each(["ENOENT", "EACCES"])(
    "classifies a pre-spawn %s without exposing OS details",
    async (code: string) => {
      const runtime = loadRuntime();
      const pending = invoke(runtime.tool!, fixture({ planTiers: true }), "implementer", "demo");
      const child = runtime.launches[0]!.child;
      delete child.pid;
      child.emit("error", Object.assign(new Error("/private/path synthetic-secret"), { code }));
      child.emit("close", -2);
      const message = await pending.then(
        (): string => "unexpected success",
        (error: Error): string => error.message,
      );
      expect(message).toBe(
        code === "ENOENT"
          ? "Navori executable not found on PATH; plan gate unavailable; subagent blocked"
          : "Navori plan gate unavailable; subagent blocked",
      );
      expect(runtime.launches).toHaveLength(1);
      expect(child.kill).not.toHaveBeenCalled();
    },
  );

  it.each(["demo", undefined, "other"])(
    "shows only a bound workplan identifier (%s)",
    async (feature: string | undefined) => {
      const cwd = fixture({ planTiers: true });
      const runtime = loadRuntime();
      const controller = new AbortController();
      const remove = vi.spyOn(controller.signal, "removeEventListener");
      const task = "nivel-0: README.md demo";
      const pending = invoke(runtime.tool!, cwd, "implementer", feature, controller.signal, task);
      const launch = runtime.launches[0]!;
      expect(launch.options).toEqual({ cwd, stdio: ["pipe", "pipe", "pipe"] });
      expect(JSON.parse(launch.input).tool_input.message).toBe(task);
      const bytes = Buffer.from(workplanReason());
      const split = bytes.indexOf(Buffer.from("—")) + 1;
      launch.child.stderr.write(bytes.subarray(0, split));
      launch.child.stderr.write(bytes.subarray(split));
      launch.child.emit("close", 2);
      await expect(pending).rejects.toThrow(
        `workplan: ${feature === "demo" ? "demo" : "<feature>"}`,
      );
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(runtime.launches.map((entry: Launch): string => entry.program)).toEqual(["navori"]);
    },
  );

  it.each([
    "",
    "[navori] BLOCKED by plan-gate: configuration changed during validation\n",
    "[navori] BLOCKED by plan-gate: invalid config: /private/path token=synthetic-secret person@example.test\n",
    workplanReason() + "extra",
    "\u001b[31m" + workplanReason(),
    "\u001b]0;private\u0007" + workplanReason(),
    workplanReason().replaceAll("\n", "\r\n"),
    workplanReason() + "\0",
    workplanReason().replace("workplan: demo", "workplan: other"),
    workplanReason("x".repeat(129)),
    workplanReason() + "\n",
    "x".repeat(65_536),
  ])("uses a safe denial fallback for unrecognized stderr %#", async (stderr: string) => {
    const cwd = fixture({ planTiers: true });
    const runtime = loadRuntime();
    const pending = invoke(runtime.tool!, cwd, "implementer", "demo");
    runtime.launches[0]!.child.stderr.write(stderr);
    runtime.launches[0]!.child.emit("close", 2);
    const message = await pending.then(
      (): string => "unexpected success",
      (error: Error): string => error.message,
    );
    expect(message).toContain("denial reason is unavailable or not safe to display");
    expect(message.length).toBeLessThanOrEqual(2000);
    expect(message).not.toMatch(/synthetic-secret|person@|private|extra|workplan: demo/);
    expect(runtime.launches.map((entry: Launch): string => entry.program)).toEqual(["navori"]);
  });

  it.each([1, 3, null, "error", "throw"])(
    "treats %s as operational, never as a denial",
    async (code: number | null | string) => {
      const cwd = fixture({ planTiers: true });
      const runtime = loadRuntime();
      if (code === "throw") {
        runtime.spawn.mockImplementationOnce((): never => {
          throw new Error("synthetic-secret");
        });
      }
      const pending = invoke(runtime.tool!, cwd, "implementer", "demo");
      if (code !== "throw") {
        const child = runtime.launches[0]!.child;
        child.stderr.write(workplanReason());
        if (code === "error")
          child.emit("error", Object.assign(new Error("synthetic-secret"), { code: "ENOENT" }));
        child.emit("close", typeof code === "number" ? code : null);
      }
      await expect(pending).rejects.toThrow("Navori plan gate unavailable; subagent blocked");
      expect(runtime.launches.every((entry: Launch): boolean => entry.program === "navori")).toBe(
        true,
      );
    },
  );

  it("never uses stdout as a denial diagnostic", async () => {
    const runtime = loadRuntime();
    const pending = invoke(runtime.tool!, fixture({ planTiers: true }), "implementer", "demo");
    runtime.launches[0]!.child.stdout.write(workplanReason());
    runtime.launches[0]!.child.emit("close", 2);
    await expect(pending).rejects.toThrow("denial reason is unavailable");
    expect(runtime.launches).toHaveLength(1);
  });

  it.each(["stdout", "stderr", "combined"] as const)(
    "blocks oversized %s before a late successful close",
    async (stream: "stdout" | "stderr" | "combined") => {
      vi.useFakeTimers();
      const runtime = loadRuntime();
      const pending = invoke(runtime.tool!, fixture({ planTiers: true }), "implementer", "demo");
      const rejected = expect(pending).rejects.toThrow("plan gate unavailable");
      const child = runtime.launches[0]!.child;
      if (stream === "combined") {
        child.stdout.write(Buffer.alloc(32_768));
        child.stderr.write(Buffer.alloc(32_769));
      } else child[stream].write(Buffer.alloc(65_537));
      child.stderr.write(workplanReason());
      child.emit("close", 0);
      await rejected;
      expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
      expect(vi.getTimerCount()).toBe(0);
      expect(runtime.launches).toHaveLength(1);
    },
  );

  it.each(["prior-abort", "abort", "timeout", "early-close"])(
    "cleans up %s without launching Pi",
    async (mode: string) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      if (mode === "prior-abort") controller.abort();
      const runtime = loadRuntime();
      const pending = invoke(
        runtime.tool!,
        fixture({ planTiers: true }),
        "implementer",
        "demo",
        controller.signal,
      );
      const rejected = expect(pending).rejects.toThrow("plan gate unavailable");
      const child = runtime.launches[0]!.child;
      child.stdin.emit("error", new Error("synthetic EPIPE"));
      if (mode === "timeout") await vi.advanceTimersByTimeAsync(10_000);
      else controller.abort();
      expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
      if (mode === "early-close") child.emit("close", 0);
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
      expect(child.kill.mock.calls).toEqual(
        mode === "early-close" ? [["SIGTERM"]] : [["SIGTERM"], ["SIGKILL"]],
      );
      child.emit("error", new Error("late error"));
      child.emit("close", 0);
      expect(vi.getTimerCount()).toBe(0);
      expect(runtime.launches).toHaveLength(1);
    },
  );

  it.each(["error", "timeout"])("preserves handoff fail-closed on %s", async (mode: string) => {
    vi.useFakeTimers();
    const runtime = loadRuntime();
    const pending = invoke(runtime.tool!, fixture(), "reviewer", "demo");
    const rejected = expect(pending).rejects.toThrow("handoff check unavailable");
    const launch = runtime.launches[0]!;
    expect(launch.options.stdio).toEqual(["pipe", "pipe", "ignore"]);
    if (mode === "error") {
      delete launch.child.pid;
      launch.child.emit("error", new Error("synthetic-secret"));
    } else await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    expect(runtime.launches).toHaveLength(1);
  });

  it("accepts the exact combined capture budget without treating denial as operational", async () => {
    const runtime = loadRuntime();
    const pending = invoke(runtime.tool!, fixture({ planTiers: true }), "implementer", "demo");
    const child = runtime.launches[0]!.child;
    child.stdout.write(Buffer.alloc(32_768));
    child.stderr.write(Buffer.alloc(32_768));
    child.emit("close", 2);
    await expect(pending).rejects.toThrow("denial reason is unavailable");
    expect(child.kill).not.toHaveBeenCalled();
    expect(runtime.launches).toHaveLength(1);
  });

  it("preserves split UTF-8 handoff JSON and keeps stderr capture disabled", async () => {
    const runtime = loadRuntime();
    const pending = invoke(runtime.tool!, fixture(), "reviewer", "demo");
    const launch = runtime.launches[0]!;
    expect(launch.options.stdio).toEqual(["pipe", "pipe", "ignore"]);
    const json = Buffer.from(JSON.stringify({ status: "ok", feature: "demo", detail: "—" }));
    const split = json.indexOf(Buffer.from("—")) + 1;
    launch.child.stdout.write(json.subarray(0, split));
    launch.child.stdout.write(json.subarray(split));
    launch.child.emit("close", 0);
    await new Promise<void>((resolve): void => {
      setImmediate(resolve);
    });
    expect(runtime.launches.map((entry: Launch): string => entry.program)).toEqual([
      "navori",
      "pi",
    ]);
    runtime.launches[1]!.child.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
    runtime.launches[1]!.child.emit("close", 0);
    await expect(pending).resolves.toMatchObject({ details: { role: "reviewer" } });
  });

  it("releases the active slot after repeated denials", async () => {
    const runtime = loadRuntime();
    const cwd = fixture({ planTiers: true });
    for (let index = 0; index < 5; index++) {
      const pending = invoke(runtime.tool!, cwd, "implementer", "demo");
      runtime.launches[index]!.child.emit("close", 2);
      await expect(pending).rejects.toThrow("plan gate blocked");
    }
    expect(runtime.launches.map((entry: Launch): string => entry.program)).toEqual(
      Array<string>(5).fill("navori"),
    );
  });

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
    const pending = invoke(runtime.tool!, cwd, "implementer", "pi_engine");
    runtime.launches[0]!.child.emit("close", 0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runtime.launches.map((launch) => launch.program)).toEqual(["navori", "pi"]);
    runtime.launches[1]!.child.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
    runtime.launches[1]!.child.emit("close", 0);
    await expect(pending).resolves.toMatchObject({ details: { role: "implementer" } });

    const disabled = fixture();
    const direct = loadRuntime();
    const directPending = invoke(direct.tool!, disabled, "implementer", "pi_engine");
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
    // Additive (spec 0047 D6): a prompt section, never a full systemPrompt replacement.
    const event = { systemPrompt: "Original", systemPromptOptions: { sections: { keep: "x" } } };
    expect(await before(event, { cwd })).toBeUndefined();
    expect(event.systemPromptOptions.sections).toEqual({
      keep: "x",
      "navori-master-plan": "Plan maestro — etapa activa",
    });
    const child = loadWithScripts({
      env: { NAVORI_PI_CHILD_DEPTH: "1", NAVORI_PI_CHILD_ROLE: "implementer" },
    });
    expect(
      loadRuntime({ NAVORI_PI_CHILD_DEPTH: "1", NAVORI_PI_CHILD_ROLE: "implementer" }).tool,
    ).toBeUndefined();
    const call = child.get("tool_call")!;
    expect(
      await call({ toolName: "write", input: { path: "specs/task.md" } }, { cwd }),
    ).toMatchObject({ block: true });
    expect(
      await call({ toolName: "edit", input: { path: "src/code.ts" } }, { cwd }),
    ).toBeUndefined();
    expect(
      await call({ toolName: "bash", input: { command: "cat > task.md" } }, { cwd }),
    ).toMatchObject({
      block: true,
      reason: expect.stringContaining("implementer-no-markdown"),
    });
  });

  // Covers: R49
  it("Pi deja al implementer escribir doctrina de IA y bloquea el resto del Markdown", async () => {
    const cwd = fixture({ scribeOwnsMarkdown: true });
    const child = loadWithScripts({
      env: { NAVORI_PI_CHILD_DEPTH: "1", NAVORI_PI_CHILD_ROLE: "implementer" },
    });
    const call = child.get("tool_call")!;
    for (const path of [
      "packages/core/core-assets/agents/implementer.md",
      ".claude/skills/x/SKILL.md",
      ".codex/orchestrator.md",
      ".agents/skills/x/SKILL.md",
      // `.pi/navori/` is in the list too, but Pi's managed lane refuses it first (D4); not asserted here.
      join(cwd, ".claude/agents/a.md"),
    ]) {
      expect(await call({ toolName: "write", input: { path } }, { cwd }), path).toBeUndefined();
    }
    for (const path of [
      "progress/current.md",
      "specs/x/tasks.md",
      "docs/a.md",
      "README.md",
      ".navori/state/handoffs/x.md",
      ".claude/skills/../../progress/current.md",
      join(cwd, "../elsewhere/.claude/agents/a.md"),
    ]) {
      expect(await call({ toolName: "edit", input: { path } }, { cwd }), path).toMatchObject({
        block: true,
        reason: expect.stringContaining(".claude/agents/"),
      });
    }
  });
});
