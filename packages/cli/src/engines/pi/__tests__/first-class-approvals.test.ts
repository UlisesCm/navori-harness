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
  pid: number;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}
interface Block {
  block: boolean;
  reason: string;
}
interface Ctx {
  cwd: string;
  hasUI?: boolean;
  isProjectTrusted?: () => boolean;
  ui?: { confirm: (title: string, message: string) => Promise<boolean> };
}
type ToolCall = (
  event: { toolName: string; input: unknown },
  ctx: Ctx,
) => Promise<Block | undefined> | undefined;
interface Tool {
  execute: (
    id: string,
    params: { role: string; task: string; feature?: string },
    signal: AbortSignal,
    onUpdate: () => void,
    context: Ctx & { model: { provider: string; id: string } },
  ) => Promise<{ content: Array<{ text: string }> }>;
}

const APPROVED = "navori master delivery-publication --delivery d1 --approved-by user";

interface Runtime {
  toolCall: ToolCall | undefined;
  tool: Tool | undefined;
  children: Array<{ args: string[] }>;
  navori: string[][];
  repo: { head: string; status: string; diff: string; fail: boolean };
}

/** Loads the rendered extension against deterministic stubs: no Pi, no network, no credentials. */
function load(
  options: { env?: Record<string, string>; handoff?: { status: string; code: number } } = {},
): Runtime {
  const rt: Runtime = {
    toolCall: undefined,
    tool: undefined,
    children: [],
    navori: [],
    repo: { head: "abc", status: "", diff: "", fail: false },
  };
  const spawn = (program: string, args: string[]): Child => {
    const child = Object.assign(new EventEmitter(), {
      pid: 321,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    if (program === "navori") {
      rt.navori.push(args);
      const handoff = options.handoff ?? { status: "ok", code: 0 };
      child.stdout.write(JSON.stringify({ status: handoff.status, feature: args[2] }));
      setImmediate(() => child.emit("close", handoff.code));
    } else {
      rt.children.push({ args });
    }
    return child;
  };
  const schema = new Proxy({}, { get: () => () => ({}) });
  const modules = new Map<string, unknown>([
    ["node:child_process", { spawn }],
    ["node:fs", { readFileSync }],
    ["node:path", { join }],
    ["@earendil-works/pi-ai", { Type: schema }],
    [
      "@earendil-works/pi-coding-agent",
      { VERSION: "1.1.0", defineTool: (value: unknown) => value },
    ],
  ]);
  const exports: Record<string, unknown> = {};
  const importLine = /^import \{ (.+) \} from "(.+)";$/gm;
  const compiled = stripTypeScriptTypes(PI_EXTENSION_SOURCE)
    .replace(importLine, 'const { $1 } = require("$2");')
    .replace("export default function", "exports.default = function");
  runInNewContext(compiled, {
    exports,
    require: (id: string): unknown => modules.get(id),
    process: {
      env: { ...options.env },
      platform: "win32",
      versions: { node: "22.19.0" },
      stderr: { write: () => true },
    },
    Buffer,
    setTimeout,
    clearTimeout,
  });
  const exec = async (
    _command: string,
    args: string[],
  ): Promise<{ code: number; stdout: string }> => {
    if (rt.repo.fail) return { code: 128, stdout: "" };
    const stdout =
      args[0] === "rev-parse" ? rt.repo.head : args[0] === "status" ? rt.repo.status : rt.repo.diff;
    return { code: 0, stdout };
  };
  (exports.default as (pi: unknown) => void)({
    exec,
    on: (name: string, handler: ToolCall) => {
      if (name === "tool_call") rt.toolCall = handler;
    },
    registerTool: (value: Tool) => {
      rt.tool = value;
    },
  });
  return rt;
}

const dirs: string[] = [];
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "navori-pi-approvals-"));
  dirs.push(dir);
  renderPiEngine(
    dir,
    NavoriConfigSchema.parse({
      name: "pi-approvals",
      preset: "custom",
      engines: ["pi"],
      branchBase: "main",
      qualityGate: { fast: "bun test", full: "bun test" },
      harness: { scribeOwnsMarkdown: true },
    }),
  );
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Interactive parent whose dialog answers with `answer`, optionally mutating the repo while it is open. */
function interactive(
  rt: Runtime,
  answer: boolean,
  whileOpen?: () => void,
): { ctx: Ctx; confirm: ReturnType<typeof vi.fn> } {
  const confirm = vi.fn(async (_title: string, _message: string) => {
    whileOpen?.();
    return answer;
  });
  void rt;
  return {
    ctx: { cwd: "/p", hasUI: true, isProjectTrusted: () => true, ui: { confirm } },
    confirm,
  };
}

const bash = (command: string): { toolName: string; input: unknown } => ({
  toolName: "bash",
  input: { command },
});

describe("Pi first-class approvals", () => {
  // Covers: R5
  it("interactive parent approval is observable and bound to the operation", async () => {
    const rt = load();
    const { ctx, confirm } = interactive(rt, true);
    ctx.cwd = project();
    await expect(rt.toolCall!(bash(APPROVED), ctx)).resolves.toBeUndefined();
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]![1]).toContain(APPROVED);
    // Consent is spent by that call: the same command asks again, another command is not covered.
    await rt.toolCall!(bash(APPROVED), ctx);
    expect(confirm).toHaveBeenCalledTimes(2);
    await expect(rt.toolCall!(bash("git status"), ctx)).resolves.toBeUndefined();
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  // Covers: R5
  it("deny and cancel do not authorize", async () => {
    const rt = load();
    const denied = interactive(rt, false);
    const result = await rt.toolCall!(bash(APPROVED), denied.ctx);
    expect(result).toMatchObject({ block: true });
    expect(result!.reason).toMatch(/denied or cancelled/);
    const failing: Ctx = {
      cwd: "/p",
      hasUI: true,
      ui: { confirm: () => Promise.reject(new Error("dialog closed")) },
    };
    expect(await rt.toolCall!(bash(APPROVED), failing)).toMatchObject({ block: true });
  });

  // Covers: R5
  it("object or state changed between prompt and use does not authorize", async () => {
    const rt = load();
    const moved = interactive(rt, true, () => {
      rt.repo.head = "def";
    });
    const result = await rt.toolCall!(bash(APPROVED), moved.ctx);
    expect(result).toMatchObject({ block: true });
    expect(result!.reason).toMatch(/state changed between the confirmation and its use/);

    const edited = interactive(rt, true, () => {
      rt.repo.diff = "changed";
    });
    expect(await rt.toolCall!(bash(APPROVED), edited.ctx)).toMatchObject({ block: true });

    // A state that cannot be snapshotted cannot be bound, so it cannot be approved.
    rt.repo.fail = true;
    const unbound = interactive(rt, true);
    expect(await rt.toolCall!(bash(APPROVED), unbound.ctx)).toMatchObject({ block: true });
    expect(unbound.confirm).not.toHaveBeenCalled();
  });

  // Covers: R5
  it("no UI is not authorized and says how to resume", async () => {
    const rt = load();
    const result = await rt.toolCall!(bash(APPROVED), { cwd: "/p", hasUI: false });
    expect(result).toMatchObject({ block: true });
    expect(result!.reason).toMatch(/no interactive UI.*interactive Pi session/);
    // Investigation is not blocked indiscriminately.
    await expect(
      rt.toolCall!(bash("git log"), { cwd: project(), hasUI: false }),
    ).resolves.toBeUndefined();
  });

  // Covers: R5
  it("headless child rejects approval-requiring operations back to the parent", async () => {
    const rt = load({ env: { NAVORI_PI_CHILD_DEPTH: "1", NAVORI_PI_CHILD_ROLE: "implementer" } });
    // Even a child that somehow saw a UI cannot approve: there is no forwarded consent.
    const { ctx, confirm } = interactive(rt, true);
    const result = await rt.toolCall!(bash(APPROVED), ctx);
    expect(result).toMatchObject({ block: true });
    expect(result!.reason).toMatch(/children cannot approve.*return this command to the parent/);
    expect(confirm).not.toHaveBeenCalled();
    expect(rt.tool).toBeUndefined();
  });

  // Covers: R5
  it("trust is not approval", async () => {
    const rt = load();
    // A trusted project without UI, and a trusted project whose user says no, never satisfy an approval.
    const trusted: Ctx = { cwd: "/p", hasUI: false, isProjectTrusted: () => true };
    expect(await rt.toolCall!(bash(APPROVED), trusted)).toMatchObject({ block: true });
    const refused = interactive(rt, false);
    expect(await rt.toolCall!(bash(APPROVED), refused.ctx)).toMatchObject({ block: true });
    expect(refused.confirm).toHaveBeenCalledOnce();
    // Children are launched with --approve (resource trust) and still cannot approve operations.
    const dir = project();
    const parent = load();
    const run = parent.tool!.execute(
      "c",
      { role: "scout", task: "Look around" },
      new AbortController().signal,
      () => {},
      { cwd: dir, isProjectTrusted: () => true, model: { provider: "p", id: "m" } },
    );
    await vi.waitFor(() => expect(parent.children).toHaveLength(1));
    expect(parent.children[0]!.args).toContain("--approve");
    run.catch(() => {});
  });

  // Covers: R6
  it("invalid or missing handoff and failed preflight block the consumer", async () => {
    const dir = project();
    const dispatch = (rt: Runtime, role: string, feature?: string): Promise<unknown> =>
      rt.tool!.execute(
        "c",
        { role, task: "Review it", feature },
        new AbortController().signal,
        () => {},
        { cwd: dir, isProjectTrusted: () => true, model: { provider: "p", id: "m" } },
      );

    const missing = load();
    await expect(dispatch(missing, "reviewer")).rejects.toThrow(/explicit Navori feature slug/);
    await expect(dispatch(missing, "scribe", "../x")).rejects.toThrow(
      /explicit Navori feature slug/,
    );

    for (const handoff of [
      { status: "invalid", code: 0 },
      { status: "ok", code: 2 },
    ]) {
      const rt = load({ handoff });
      await expect(dispatch(rt, "reviewer", "pi_first")).rejects.toThrow(
        /handoff check did not pass; reviewer blocked/,
      );
      await expect(dispatch(rt, "scribe", "pi_first")).rejects.toThrow(
        /handoff check did not pass; scribe blocked/,
      );
      expect(rt.children).toEqual([]);
    }
    const preflight = load();
    const pending = dispatch(preflight, "reviewer", "pi_first");
    await vi.waitFor(() => expect(preflight.children).toHaveLength(1));
    expect(preflight.navori[0]).toEqual(
      expect.arrayContaining(["handoff", "check", "pi_first", "--for", "orchestrator"]),
    );
    pending.catch(() => {});
  });
});
