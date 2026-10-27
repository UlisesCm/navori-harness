import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { EventEmitter } from "node:events";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { PassThrough } from "node:stream";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PINNED_PI_VERSION } from "./fixtures/pinned-pi-version.ts";
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
    "node:fs": { existsSync, readFileSync, statSync },
    "node:path": { join },
    "@earendil-works/pi-ai": {
      Type: Object.fromEntries(
        ["Object", "Union", "Literal", "String", "Optional"].map((name) => [name, () => ({})]),
      ),
    },
    "@earendil-works/pi-coding-agent": {
      VERSION: PINNED_PI_VERSION,
      defineTool: (value: unknown) => value,
    },
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
      await expect(pending).resolves.toMatchObject({
        isError: true,
        content: [{ text: expect.stringContaining(message) }],
        details: { outcome: "failed", agentId: "pi-scout-c" },
      });
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
    await expect(pending).resolves.toMatchObject({
      isError: true,
      details: { outcome: "failed", failure: expect.stringContaining("exceeded output limit") },
    });
  });

  // Covers: R19
  it("kills the group on abort and keeps SIGKILL escalation after the leader closes", async () => {
    vi.useFakeTimers();
    freshProject();
    const rt = load();
    const controller = new AbortController();
    const pending = rt.run(controller.signal);
    const assertion = expect(pending).resolves.toMatchObject({
      isError: true,
      details: { outcome: "failed", failure: expect.stringContaining("cancelled, timed out") },
    });
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
    const assertion = expect(pending).resolves.toMatchObject({
      isError: true,
      details: { outcome: "failed", failure: expect.stringContaining("cancelled, timed out") },
    });
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

type LifecycleHandler = (
  event: Record<string, unknown>,
  ctx: unknown,
) => Promise<unknown> | unknown;

/** Loads the rendered extension with Pi stubbed and REAL node:* modules, so the shared scripts really run. */
function loadReal(env: Record<string, string> = {}): Map<string, LifecycleHandler> {
  const nodeRequire = createRequire(import.meta.url);
  const handlers = new Map<string, LifecycleHandler>();
  const modules: Record<string, unknown> = {
    "@earendil-works/pi-ai": { Type: new Proxy({}, { get: () => () => ({}) }) },
    "@earendil-works/pi-coding-agent": {
      VERSION: PINNED_PI_VERSION,
      defineTool: (value: unknown) => value,
      getShellConfig: () => ({ shell: "/bin/bash", args: ["-c"] }),
    },
  };
  const exports: { default?: (pi: unknown) => void } = {};
  const source = stripTypeScriptTypes(PI_EXTENSION_SOURCE)
    .replace(/^import \{ (.+) \} from "(.+)";$/gm, 'const { $1 } = require("$2");')
    .replace("export default function", "exports.default = function");
  runInNewContext(source, {
    exports,
    require: (id: string): unknown => modules[id] ?? nodeRequire(id),
    process: {
      env: { ...process.env, NAVORI_PI_CHILD_DEPTH: "", NAVORI_PI_CHILD_ROLE: "", ...env },
      platform: process.platform,
      versions: { node: "22.19.0" },
      stderr: { write: () => true },
      kill: process.kill.bind(process),
    },
    Buffer,
    AbortController,
    setTimeout,
    clearTimeout,
  });
  exports.default?.({
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    on: (name: string, handler: LifecycleHandler) => {
      // The first handler of an event is the lifecycle one: the later ones are context helpers.
      if (!handlers.has(name)) handlers.set(name, handler);
    },
    registerTool: () => {},
    getActiveTools: () => [],
  });
  return handlers;
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: "pipe" });

/** A rendered Pi project that is also a committed git repo with an origin, so worktrees can have upstreams. */
function gitProject(verifyOnStop = false): { cwd: string; origin: string } {
  const cwd = mkdtempSync(join(tmpdir(), "navori-pi-lifecycle-git-"));
  const origin = mkdtempSync(join(tmpdir(), "navori-pi-lifecycle-origin-"));
  dirs.push(cwd, origin);
  git(origin, "init", "--bare", "-b", "main");
  git(cwd, "init", "-b", "main");
  renderPiEngine(
    cwd,
    NavoriConfigSchema.parse({
      name: "pi-lifecycle",
      preset: "custom",
      engines: ["pi"],
      branchBase: "main",
      qualityGate: { fast: "bun test", full: "bun test" },
      ...(verifyOnStop ? { hooks: { verifyOnStop: true } } : {}),
    }),
  );
  writeFileSync(join(cwd, ".gitignore"), ".claude/worktrees/\n.navori/state/\n");
  writeFileSync(join(cwd, "tracked.txt"), "one\n");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "init");
  git(cwd, "remote", "add", "origin", origin);
  git(cwd, "push", "-u", "origin", "main");
  return { cwd, origin };
}

/** A worktree under `.claude/worktrees/<name>` on its own branch; `push` gives it a clean upstream. */
function addWorktree(cwd: string, name: string, push: boolean): string {
  const wt = join(cwd, ".claude/worktrees", name);
  git(cwd, "worktree", "add", "-b", name, wt);
  if (push) git(wt, "push", "-u", "origin", name);
  else {
    writeFileSync(join(wt, `${name}.txt`), "unpublished\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-m", `${name} work`);
  }
  return wt;
}

/**
 * A bin dir with a `gh` that reports every given branch as a merged PR and a `navori` that records the
 * audit metadata writer's arguments and stdin to `recorded` (the real writer needs a started audit log).
 */
function fakeBin(branches: string[], recorded: string): string {
  const bin = mkdtempSync(join(tmpdir(), "navori-pi-lifecycle-bin-"));
  dirs.push(bin);
  const lines = branches.map((branch, i) => `${branch} ${i + 1}`).join("\n");
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash\ncat <<'EOF'\n${lines}\nEOF\n`);
  writeFileSync(
    join(bin, "navori"),
    `#!/usr/bin/env bash\necho "$*" >> '${recorded}'\ncat >> '${recorded}'\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "navori"), 0o755);
  return bin;
}

const lifecycleCtx = (
  cwd: string,
): { cwd: string; sessionManager: { getSessionId: () => string } } => ({
  cwd,
  sessionManager: { getSessionId: () => "sess-1" },
});

describe("Pi session close and settle reminder", () => {
  // Covers: R10
  it("shutdown reclaims safe worktrees only", async () => {
    const { cwd } = gitProject();
    const safe = addWorktree(cwd, "safe", true);
    const unpublished = addWorktree(cwd, "unpublished", false);
    const ignored = addWorktree(cwd, "ignored", true);
    mkdirSync(join(ignored, ".navori/state/handoffs"), { recursive: true });
    writeFileSync(join(ignored, ".navori/state/handoffs/impl_x.json"), "{}\n");
    const auditsRoot = mkdtempSync(join(tmpdir(), "navori-pi-lifecycle-audits-"));
    dirs.push(auditsRoot);
    const log = join(auditsRoot, basename(cwd), "session-sess-1.log");
    mkdirSync(join(auditsRoot, basename(cwd)), { recursive: true });
    writeFileSync(log, "");
    const recorded = join(auditsRoot, "recorded.txt");
    writeFileSync(recorded, "");
    const env = {
      PATH: `${fakeBin(["safe", "unpublished", "ignored"], recorded)}:${process.env.PATH ?? ""}`,
      NAVORI_AUDITS_ROOT: auditsRoot,
    };

    // A child, and the sessions that do not end (reload, resume, fork), change nothing.
    // (A child registers no lifecycle handler at all; the handlers also guard on the child env themselves.)
    await loadReal({ ...env, NAVORI_PI_CHILD_DEPTH: "1" }).get("session_shutdown")?.(
      { type: "session_shutdown", reason: "quit" },
      lifecycleCtx(cwd),
    );
    for (const reason of ["reload", "resume", "fork"]) {
      await loadReal(env).get("session_shutdown")!(
        { type: "session_shutdown", reason },
        lifecycleCtx(cwd),
      );
    }
    expect([safe, unpublished, ignored].every((dir) => existsSync(dir))).toBe(true);
    expect(readFileSync(recorded, "utf8")).toBe("");

    // The parent's quit reclaims only the clean, pushed, merged worktree and seals the audit log.
    await loadReal(env).get("session_shutdown")!(
      { type: "session_shutdown", reason: "quit" },
      lifecycleCtx(cwd),
    );
    expect(existsSync(safe)).toBe(false);
    expect(existsSync(unpublished)).toBe(true);
    expect(existsSync(join(ignored, ".navori/state/handoffs/impl_x.json"))).toBe(true);
    const sealed = readFileSync(recorded, "utf8");
    expect(sealed).toContain("--host pi");
    expect(sealed).toContain('"event":"session-end"');
    expect(sealed).toContain('"reason":"prompt_input_exit"');
  });

  // Covers: R10
  it("shutdown is silent when there is nothing to do or a script fails", async () => {
    const { cwd } = gitProject();
    // No `.claude/worktrees` and no audit log: nothing to reclaim or seal, no throw.
    await expect(
      loadReal().get("session_shutdown")!(
        { type: "session_shutdown", reason: "new" },
        lifecycleCtx(cwd),
      ),
    ).resolves.toBeUndefined();
    // A broken script and an unreadable manifest are swallowed too.
    writeFileSync(join(cwd, ".pi/navori/hooks/audit-mode-close.sh"), "exit 1\n");
    await expect(
      loadReal().get("session_shutdown")!(
        { type: "session_shutdown", reason: "quit" },
        lifecycleCtx(cwd),
      ),
    ).resolves.toBeUndefined();
    rmSync(join(cwd, ".pi/navori.json"));
    await expect(
      loadReal().get("session_shutdown")!(
        { type: "session_shutdown", reason: "quit" },
        lifecycleCtx(cwd),
      ),
    ).resolves.toBeUndefined();
  });

  // Covers: R11
  it("settle reminder with uncommitted changes", async () => {
    const { cwd } = gitProject(true);
    const existing = { type: "custom", customType: "other", data: 1 };
    const settle = (env: Record<string, string> = {}): Promise<unknown> =>
      Promise.resolve(
        loadReal(env).get("agent_before_settle")?.(
          {
            type: "agent_before_settle",
            outcome: "completed",
            entries: [existing],
            continue: false,
            context: {},
          },
          lifecycleCtx(cwd),
        ),
      );

    // A clean tree adds nothing.
    expect(await settle()).toBeUndefined();

    // Uncommitted tracked changes add ONE visible message, keep earlier entries and never set `continue`.
    writeFileSync(join(cwd, "tracked.txt"), "two\n");
    const result = (await settle()) as {
      entries: Array<Record<string, unknown>>;
      continue?: boolean;
    };
    expect(result.continue).toBeUndefined();
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toEqual(existing);
    expect(result.entries[1]).toMatchObject({
      type: "custom_message",
      display: true,
      content: expect.stringContaining("cambios sin commitear"),
    });

    // A child never reminds; a failing script or an unreadable manifest is silent.
    expect(await settle({ NAVORI_PI_CHILD_DEPTH: "1" })).toBeUndefined();
    writeFileSync(join(cwd, ".pi/navori/hooks/stop-verify-reminder.sh"), "exit 1\n");
    expect(await settle()).toBeUndefined();
    rmSync(join(cwd, ".pi/navori.json"));
    expect(await settle()).toBeUndefined();
  });
});
