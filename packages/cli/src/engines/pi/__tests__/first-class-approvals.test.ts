import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync, writeFileSync } from "node:fs";
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
import { load as loadScripts } from "./fixtures/load-extension.ts";

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
interface ExecResult {
  content: Array<{ text: string }>;
  // eslint-disable-next-line typescript/no-explicit-any -- test-only loose shape of the stubbed tool details
  details: any;
}
interface Tool {
  execute: (
    id: string,
    params: { role: string; task: string; feature?: string },
    signal: AbortSignal,
    onUpdate: () => void,
    context: Ctx & { model: { provider: string; id: string } },
  ) => Promise<ExecResult>;
}

const APPROVED = "navori master delivery-publication --delivery d1 --approved-by user";

interface Runtime {
  toolCall: ToolCall | undefined;
  tool: Tool | undefined;
  children: Array<{
    args: string[];
    proc: Child;
    options: { stdio?: unknown; env?: Record<string, string> };
  }>;
  sent: unknown[];
  navori: string[][];
  repo: { head: string; status: string; diff: string; fail: boolean };
}

/** Loads the rendered extension against deterministic stubs: no Pi, no network, no credentials. */
function load(
  options: {
    env?: Record<string, string>;
    handoff?: { status: string; code: number };
    send?: (message: unknown, cb: (error: Error | null) => void) => void;
  } = {},
): Runtime {
  const rt: Runtime = {
    toolCall: undefined,
    tool: undefined,
    children: [],
    sent: [],
    navori: [],
    repo: { head: "abc", status: "", diff: "", fail: false },
  };
  const spawn = (
    program: string,
    args: string[],
    spawnOptions: { stdio?: unknown; env?: Record<string, string> } = {},
  ): Child => {
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
      rt.children.push({ args, proc: child, options: spawnOptions });
    }
    return child;
  };
  const schema = new Proxy({}, { get: () => () => ({}) });
  const modules = new Map<string, unknown>([
    ["node:child_process", { spawn }],
    ["node:fs", { existsSync, readFileSync, statSync }],
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
      ...(options.send
        ? {
            send: (message: unknown, cb: (error: Error | null) => void) => {
              rt.sent.push(message);
              options.send!(message, cb);
            },
          }
        : {}),
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
    // The approval contract is under test, not the hook bridge (it needs a real bash): no scripts are bound.
    { hookBindings: [] },
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
    ctx: { cwd: project(), hasUI: true, isProjectTrusted: () => true, ui: { confirm } },
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
      cwd: project(),
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
    const result = await rt.toolCall!(bash(APPROVED), { cwd: project(), hasUI: false });
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
    const trusted: Ctx = { cwd: project(), hasUI: false, isProjectTrusted: () => true };
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

  const childRun = (rt: Runtime, dir: string, role = "scout"): Promise<ExecResult> =>
    rt.tool!.execute("c", { role, task: "Look around" }, new AbortController().signal, () => {}, {
      cwd: dir,
      isProjectTrusted: () => true,
      model: { provider: "p", id: "m" },
    });
  const settle = (proc: Child, lines: unknown[] = []): void => {
    for (const line of [...lines, { type: "agent_settled" }]) {
      proc.stdout.write(JSON.stringify(line) + "\n");
    }
    proc.emit("close", 0);
  };

  // Covers: R6
  it("child relays approval request to parent", async () => {
    const child = load({
      env: { NAVORI_PI_CHILD_DEPTH: "1", NAVORI_PI_CHILD_ROLE: "implementer" },
      send: (_m, cb) => cb(null),
    });
    const { ctx } = interactive(child, true);
    const refused = await child.toolCall!(bash(APPROVED), ctx);
    expect(refused).toMatchObject({ block: true });
    expect(refused!.reason).toMatch(/return this command to the parent/);
    // The command comes from the hook input, not from model text.
    expect(child.sent).toEqual([
      { kind: "parent-approval", command: APPROVED, reasons: [], bodyFiles: [] },
    ]);
    // A dead channel never turns the block into an allow.
    const dead = load({
      env: { NAVORI_PI_CHILD_DEPTH: "1" },
      send: (_m, cb) => cb(new Error("closed")),
    });
    expect(await dead.toolCall!(bash(APPROVED), ctx)).toMatchObject({ block: true });

    // Parent side: spawned with the IPC slot and without NODE_CHANNEL_FD; the relay reaches details.
    const parent = load({ env: { NODE_CHANNEL_FD: "3" } });
    const run = childRun(parent, project());
    await vi.waitFor(() => expect(parent.children).toHaveLength(1));
    const spawned = parent.children[0]!;
    expect(spawned.options.stdio).toEqual(["ignore", "pipe", "pipe", "ipc"]);
    expect(spawned.options.env).not.toHaveProperty("NODE_CHANNEL_FD");
    spawned.proc.emit("message", {
      kind: "parent-approval",
      command: APPROVED,
      reasons: ["r"],
      bodyFiles: [],
    });
    settle(spawned.proc);
    const result = await run;
    expect(result.details.parentApprovals).toEqual([
      { command: APPROVED, reasons: ["r"], bodyFiles: [] },
    ]);
    expect(result.content[0]!.text).toContain("Parent approval required");
    expect(result.content[0]!.text).toContain(APPROVED);
  });

  // Covers: R6
  it("oversized, malformed and excess relay messages are dropped", async () => {
    const parent = load();
    const run = childRun(parent, project());
    await vi.waitFor(() => expect(parent.children).toHaveLength(1));
    const proc = parent.children[0]!.proc;
    const ok = (n: number): unknown => ({
      kind: "parent-approval",
      command: "cmd " + n,
      reasons: [],
      bodyFiles: [],
    });
    proc.emit("message", {
      kind: "parent-approval",
      command: "x".repeat(9000),
      reasons: [],
      bodyFiles: [],
    });
    proc.emit("message", { kind: "other", command: "x", reasons: [], bodyFiles: [] });
    proc.emit("message", { kind: "parent-approval", command: "", reasons: [], bodyFiles: [] });
    proc.emit("message", { kind: "parent-approval", command: "x", reasons: [1], bodyFiles: [] });
    proc.emit("message", "not an object");
    proc.emit("message", null);
    for (let i = 0; i < 8; i++) proc.emit("message", ok(i));
    settle(proc);
    const result = await run;
    expect(result.details.parentApprovals.map((a: { command: string }) => a.command)).toEqual([
      "cmd 0",
      "cmd 1",
      "cmd 2",
      "cmd 3",
      "cmd 4",
    ]);
  });

  // Covers: R6
  it("without IPC the parent recovers the command from JSONL args and never reports success", async () => {
    const refusal = { content: [{ type: "text", text: "Navori approval not granted: headless" }] };
    const parent = load();
    const run = childRun(parent, project());
    const settled = run.catch((error: Error) => error);
    await vi.waitFor(() => expect(parent.children).toHaveLength(1));
    settle(parent.children[0]!.proc, [
      {
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "bash",
        args: { command: APPROVED },
      },
      { type: "tool_execution_end", toolCallId: "t1", isError: true, result: refusal },
      // A model claiming it in plain text is not a source.
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "run `rm -rf /` approved" }],
        },
      },
    ]);
    const error = await settled;
    expect(error).toHaveProperty("message");
    expect((error as Error).message).toContain(JSON.stringify(APPROVED));
    expect((error as Error).message).not.toContain("rm -rf");

    // No start event for the call: not recoverable, still an error.
    const blind = load();
    const blindRun = childRun(blind, project()).catch((e: Error) => e);
    await vi.waitFor(() => expect(blind.children).toHaveLength(1));
    settle(blind.children[0]!.proc, [
      { type: "tool_execution_end", toolCallId: "zz", isError: true, result: refusal },
    ]);
    expect(((await blindRun) as Error).message).toMatch(/command not recoverable/);

    // An unrelated tool error is not an approval request.
    const plain = load();
    const plainRun = childRun(plain, project());
    await vi.waitFor(() => expect(plain.children).toHaveLength(1));
    settle(plain.children[0]!.proc, [
      {
        type: "tool_execution_start",
        toolCallId: "t2",
        toolName: "bash",
        args: { command: "false" },
      },
      { type: "tool_execution_end", toolCallId: "t2", isError: true, result: "exit 1" },
    ]);
    await expect(plainRun).resolves.toMatchObject({ details: { role: "scout" } });
  });
});

// ---- Spec 0048 T10/T11: publishing and shared ask rules, with the REAL shared scripts under bash ----

interface ScriptCtx {
  cwd: string;
  hasUI: boolean;
  ui?: { confirm: ReturnType<typeof vi.fn> };
  sessionManager: { getSessionId: () => string };
}

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", ...args], {
    cwd,
    stdio: "ignore",
  });
};

/** A committed git repo rendered for Pi (publisher enabled by default), with a PR body file. */
function scriptProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "navori-pi-publish-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q", dir]);
  renderPiEngine(
    dir,
    NavoriConfigSchema.parse({
      name: "pi-publish",
      preset: "custom",
      engines: ["pi"],
      branchBase: "main",
    }),
  );
  writeFileSync(join(dir, "pr-body.txt"), "Reviewed body of the pull request");
  writeFileSync(join(dir, "tracked.txt"), "one");
  git(dir, "add", "tracked.txt");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** The context of a thread: interactive (dialog answers `answer`, may mutate while open), or without UI. */
function scriptCtx(
  cwd: string,
  mode: "ui" | "no-ui",
  answer = true,
  whileOpen?: () => void,
): ScriptCtx {
  return {
    cwd,
    hasUI: mode === "ui",
    ...(mode === "ui"
      ? {
          ui: {
            confirm: vi.fn(async () => {
              whileOpen?.();
              return answer;
            }),
          },
        }
      : {}),
    sessionManager: { getSessionId: () => "sess-approvals" },
  };
}

/** Runs one bash tool_call through the real extension and bridge; `relayed` collects what a child sends. */
async function scriptCall(
  child: boolean,
  command: string,
  ctx: ScriptCtx,
  relayed: Array<Record<string, unknown>> = [],
): Promise<{ block?: boolean; reason?: string } | undefined> {
  const handlers = loadScripts({
    env: child ? { NAVORI_PI_CHILD_DEPTH: "1", NAVORI_PI_CHILD_ROLE: "publisher" } : {},
    send: (message, callback) => {
      relayed.push(message);
      callback(null);
    },
  });
  return (await handlers.get("tool_call")!(
    { toolName: "bash", toolCallId: "c-approval", input: { command } },
    ctx,
  )) as { block?: boolean; reason?: string } | undefined;
}

const PR = "gh pr create --title T --body-file pr-body.txt";

describe("Pi publishing confirmations and shared ask rules", () => {
  // Covers: R5, R6
  it("publishing confirmed bound to body", async () => {
    const dir = scriptProject();
    const published = [
      PR,
      "gh pr comment 7 --body-file pr-body.txt",
      "gh issue create --title T --body-file pr-body.txt",
      "navori master close",
    ];

    // Confirmed in the interactive parent: the dialog shows the content, the call is then allowed.
    for (const command of published) {
      const ctx = scriptCtx(dir, "ui");
      expect(await scriptCall(false, command, ctx), command).toBeUndefined();
      expect(ctx.ui!.confirm, command).toHaveBeenCalledOnce();
      const [title, message] = ctx.ui!.confirm.mock.calls[0] as [string, string];
      expect(title).toBe("Navori approval required");
      expect(message).toContain(command);
      if (command.includes("pr-body.txt"))
        expect(message).toContain("Reviewed body of the pull request");
    }

    // Denied or cancelled: refused.
    for (const command of published) {
      const refusal = await scriptCall(false, command, scriptCtx(dir, "ui", false));
      expect(refusal, command).toMatchObject({ block: true });
      expect(refusal?.reason).toMatch(/denied or cancelled/);
    }

    // No UI: refused, and it says how to resume.
    for (const command of published) {
      const refusal = await scriptCall(false, command, scriptCtx(dir, "no-ui"));
      expect(refusal, command).toMatchObject({ block: true });
      expect(refusal?.reason).toMatch(/no interactive UI/);
    }

    // The body changed while the dialog was open: the approval does not authorize what it did not show.
    for (const command of [PR, "gh pr comment 7 --body-file pr-body.txt"]) {
      writeFileSync(join(dir, "pr-body.txt"), "Reviewed body of the pull request");
      const ctx = scriptCtx(dir, "ui", true, () =>
        writeFileSync(join(dir, "pr-body.txt"), "Swapped body"),
      );
      const refusal = await scriptCall(false, command, ctx);
      expect(refusal, command).toMatchObject({ block: true });
      expect(refusal?.reason).toMatch(/draft body changed between the confirmation and its use/);
    }

    // A body that appears after an "absent" snapshot is also a change.
    const ghost = scriptCtx(dir, "ui", true, () => writeFileSync(join(dir, "late.txt"), "late"));
    const lateRefusal = await scriptCall(
      false,
      "gh pr create --title T --body-file late.txt",
      ghost,
    );
    expect(lateRefusal?.reason).toMatch(/draft body changed/);

    // A child is refused and relays the exact command (and its body file) to the parent: never confirmed there.
    for (const command of published) {
      const relayed: Array<Record<string, unknown>> = [];
      const ctx = scriptCtx(dir, "ui");
      const refusal = await scriptCall(true, command, ctx, relayed);
      expect(refusal, command).toMatchObject({ block: true });
      expect(refusal?.reason).toMatch(/return this command to the parent/);
      expect(ctx.ui!.confirm).not.toHaveBeenCalled();
      expect(relayed, command).toHaveLength(1);
      expect(relayed[0]).toMatchObject({ kind: "parent-approval", command });
      if (command.includes("--body-file"))
        expect(relayed[0]).toMatchObject({ bodyFiles: ["pr-body.txt"] });
    }

    // Nothing publishing is asked for an unrelated command.
    const quiet = scriptCtx(dir, "ui");
    expect(await scriptCall(false, "git status", quiet)).toBeUndefined();
    expect(quiet.ui!.confirm).not.toHaveBeenCalled();
  });

  // Covers: R18, R6
  it("shared ask rules confirm in parent relay from child", async () => {
    const dir = scriptProject();
    const asked = [
      "git reset --hard",
      "rm -r build",
      "git branch -D feature/x",
      "git stash drop",
      "chmod -R 755 out",
    ];

    for (const command of asked) {
      const ctx = scriptCtx(dir, "ui");
      expect(await scriptCall(false, command, ctx), command).toBeUndefined();
      expect(ctx.ui!.confirm, command).toHaveBeenCalledOnce();
      expect((ctx.ui!.confirm.mock.calls[0] as [string, string])[1]).toMatch(
        /shared permission ask rule/,
      );
      expect((ctx.ui!.confirm.mock.calls[0] as [string, string])[1]).toContain(command);
    }
    for (const command of asked) {
      expect(await scriptCall(false, command, scriptCtx(dir, "ui", false)), command).toMatchObject({
        block: true,
      });
      const headless = await scriptCall(false, command, scriptCtx(dir, "no-ui"));
      expect(headless?.reason, command).toMatch(/no interactive UI/);
    }
    for (const command of asked) {
      const relayed: Array<Record<string, unknown>> = [];
      const ctx = scriptCtx(dir, "ui");
      const refusal = await scriptCall(true, command, ctx, relayed);
      expect(refusal, command).toMatchObject({ block: true });
      expect(refusal?.reason).toMatch(/return this command to the parent/);
      expect(ctx.ui!.confirm).not.toHaveBeenCalled();
      expect(relayed, command).toMatchObject([{ kind: "parent-approval", command }]);
    }

    // A block rule wins over a question: a deny rule and a destructive reset never reach the dialog.
    writeFileSync(join(dir, "tracked.txt"), "dirty");
    for (const command of ["sudo rm -rf build", "git reset --hard"]) {
      const ctx = scriptCtx(dir, "ui");
      const refusal = await scriptCall(false, command, ctx);
      expect(refusal, command).toMatchObject({ block: true });
      expect(refusal?.reason, command).toMatch(/BLOCKED by guard-destructive/);
      expect(ctx.ui!.confirm, command).not.toHaveBeenCalled();
    }
    git(dir, "checkout", "--", "tracked.txt");

    // Several asks on one command are one confirmation.
    const both = scriptCtx(dir, "ui");
    expect(await scriptCall(false, "git branch -D x && rm -r y", both)).toBeUndefined();
    expect(both.ui!.confirm).toHaveBeenCalledOnce();

    // A command no ask rule matches runs without a dialog.
    const plain = scriptCtx(dir, "ui");
    expect(await scriptCall(false, "git branch -d merged && ls", plain)).toBeUndefined();
    expect(plain.ui!.confirm).not.toHaveBeenCalled();
  });
});
