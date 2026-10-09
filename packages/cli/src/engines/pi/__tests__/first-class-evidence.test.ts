import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { PI_EXTENSION_SOURCE } from "../extension-source.ts";
import { fingerprintTree, readEvidenceLog, validateEvidence } from "../../../lib/plan/evidence.ts";
import { resolveStateRoot } from "../../../lib/primitives/state-root.ts";

const PI_DIST = join(
  userInfo().homedir,
  ".pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-coding-agent/dist",
);
const COMMAND = "bun run --cwd packages/cli test first-class";
const DIR = ".navori/state/handoffs";
const BUILTIN = [{ name: "bash", sourceInfo: { path: "builtin:bash", source: "builtin" } }];

interface ResultEvent {
  type: "tool_result";
  toolName: string;
  toolCallId: string;
  parentToolCallId?: string;
  input: Record<string, unknown>;
  isError: boolean;
  structuredContent?: unknown;
}
type ResultHandler = (event: ResultEvent, ctx: unknown) => Promise<unknown>;

/** Loads the rendered extension with real fs/git/spawn and a stubbed Pi API. */
function load(
  tools: unknown[],
  env: Record<string, string> = {},
): { result: ResultHandler | undefined } {
  const modules = new Map<string, unknown>([
    ["node:child_process", { spawn }],
    ["node:fs", { appendFileSync, existsSync, lstatSync, readFileSync, readlinkSync }],
    ["node:path", { join }],
    ["@earendil-works/pi-ai", { Type: new Proxy({}, { get: () => () => ({}) }) }],
    [
      "@earendil-works/pi-coding-agent",
      { VERSION: "1.1.0", defineTool: (value: unknown) => value },
    ],
  ]);
  const exports: Record<string, unknown> = {};
  const compiled = stripTypeScriptTypes(PI_EXTENSION_SOURCE)
    .replace(/^import \{ (.+) \} from "(.+)";$/gm, 'const { $1 } = require("$2");')
    .replace("export default function", "exports.default = function");
  runInNewContext(compiled, {
    exports,
    require: (id: string): unknown => modules.get(id),
    process: {
      env: { ...process.env, NAVORI_PI_CHILD_DEPTH: "", NAVORI_PI_CHILD_ROLE: "", ...env },
      platform: process.platform,
      versions: { node: "22.19.0" },
      stderr: { write: () => true },
    },
    Buffer,
    setTimeout,
    clearTimeout,
  });
  const loaded: { result: ResultHandler | undefined } = { result: undefined };
  (exports.default as (pi: unknown) => void)({
    exec: async () => ({ code: 1, stdout: "" }),
    getAllTools: () => tools,
    on: (name: string, handler: ResultHandler) => {
      if (name === "tool_result") loaded.result = handler;
    },
    registerTool: () => {},
  });
  return loaded;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A git repo with one commit, one pending criterion and its acceptance-index. */
function project(): string {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "navori-pi-evidence-")));
  dirs.push(cwd);
  execFileSync("git", ["init", "-b", "main"], { cwd });
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"],
    { cwd },
  );
  writeFileSync(join(cwd, "a.txt"), "a\n");
  mkdirSync(join(cwd, DIR), { recursive: true });
  const escaped = JSON.stringify(COMMAND).slice(1, -1);
  writeFileSync(join(cwd, DIR, "acceptance-index"), `${escaped}\tdemo\tA1\t${join(cwd, DIR)}\n`);
  return cwd;
}

const ctx = (cwd: string): unknown => ({ cwd, sessionManager: { getSessionId: () => "sess-1" } });
const ok = (over: Partial<ResultEvent> = {}): ResultEvent => ({
  type: "tool_result",
  toolName: "bash",
  toolCallId: "call-1",
  input: { command: COMMAND },
  isError: false,
  structuredContent: { output: "", truncated: false, exit_code: 0, wall_time_seconds: 0.1 },
  ...over,
});
const lines = (cwd: string) => readEvidenceLog(join(cwd, DIR, "workplan_demo.evidence.jsonl"));

// Covers: R7
describe.skipIf(!existsSync(PI_DIST))("Pi 1.1.0 terminal success contract (probe)", () => {
  // Covers: R7
  it("bash reports its exit code in structuredContent and a non-zero exit as isError", async () => {
    const { createBashToolDefinition } = (await import(
      pathToFileURL(join(PI_DIST, "core/tools/bash.js")).href
    )) as {
      createBashToolDefinition: (cwd: string) => {
        execute: (
          ...args: unknown[]
        ) => Promise<{ isError?: boolean; structuredContent?: { exit_code: number } }>;
      };
    };
    const cwd = realpathSync(tmpdir());
    const bash = createBashToolDefinition(cwd);
    const callCtx = {
      cwd,
      sessionManager: { getSessionId: () => "s", getSessionFile: () => undefined },
    };
    const pass = await bash.execute("1", { command: "true" }, undefined, undefined, callCtx);
    expect(pass.isError).toBeFalsy();
    expect(pass.structuredContent?.exit_code).toBe(0);
    const fail = await bash.execute("2", { command: "exit 3" }, undefined, undefined, callCtx);
    expect(fail.isError).toBe(true);
    expect(fail.structuredContent?.exit_code).toBe(3);
  });

  // Covers: R7
  it("bash rejects on abort and on timeout, never returning an exit_code result", async () => {
    const { createBashToolDefinition } = (await import(
      pathToFileURL(join(PI_DIST, "core/tools/bash.js")).href
    )) as {
      createBashToolDefinition: (cwd: string) => {
        execute: (...args: unknown[]) => Promise<unknown>;
      };
    };
    const cwd = realpathSync(tmpdir());
    const bash = createBashToolDefinition(cwd);
    const callCtx = {
      cwd,
      sessionManager: { getSessionId: () => "s", getSessionFile: () => undefined },
    };
    const controller = new AbortController();
    const aborted = bash.execute(
      "3",
      { command: "sleep 5" },
      controller.signal,
      undefined,
      callCtx,
    );
    setTimeout(() => controller.abort(), 200);
    await expect(aborted).rejects.toThrow(/aborted/);
    await expect(
      bash.execute("4", { command: "sleep 5", timeout: 0.2 }, undefined, undefined, callCtx),
    ).rejects.toThrow(/timed out/);
  });

  // Covers: R7
  it("builtin tools carry builtin: source info and nested calls carry parentToolCallId", () => {
    const loader = readFileSync(join(PI_DIST, "core/agent-session.js"), "utf8");
    expect(loader).toContain(
      'createSyntheticSourceInfo(`${BUILTIN_PATH_PREFIX}${name}`, { source: "builtin" })',
    );
    const types = readFileSync(join(PI_DIST, "core/extensions/types.d.ts"), "utf8");
    expect(types).toMatch(
      /interface ToolResultEventBase[\s\S]*parentToolCallId\?: string;[\s\S]*structuredContent\?: JsonValue;/,
    );
    expect(readFileSync(join(PI_DIST, "core/tools/bash.d.ts"), "utf8")).toContain(
      "exit_code: Type.TNumber",
    );
  });
});

// Covers: R7
describe("fingerprint parity with lib/plan/evidence.ts", () => {
  // Covers: R7
  it("the extension port yields the same tree as fingerprintTree on a mixed fixture repo", async () => {
    const cwd = project();
    const git = (...args: string[]): void => {
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
    };
    writeFileSync(join(cwd, "tracked.txt"), "one\n");
    writeFileSync(join(cwd, "gone.txt"), "bye\n");
    writeFileSync(join(cwd, "run.sh"), "#!/bin/sh\n");
    chmodSync(join(cwd, "run.sh"), 0o755);
    symlinkSync("tracked.txt", join(cwd, "link"));
    git("add", "-A");
    git("commit", "-m", "base");
    writeFileSync(join(cwd, "tracked.txt"), "two\n");
    rmSync(join(cwd, "gone.txt"));
    writeFileSync(join(cwd, "untracked.txt"), "new\n");
    mkdirSync(join(cwd, "sub"));
    writeFileSync(join(cwd, "sub/deep file.txt"), "d\n");
    symlinkSync("untracked.txt", join(cwd, "link2"));
    chmodSync(join(cwd, "untracked.txt"), 0o755);

    await load(BUILTIN).result?.(ok(), ctx(cwd));
    const recorded = lines(cwd)[0] as { worktreeTree?: string } | undefined;
    const expected = fingerprintTree(cwd);
    expect(expected.ok).toBe(true);
    expect(recorded?.worktreeTree).toBeTruthy();
    expect(recorded?.worktreeTree).toBe(expected.ok ? expected.tree : undefined);
  });
});

// Covers: R7
describe("parent and child evidence", () => {
  // Covers: R7
  it("records a verified exact run in the parent, accepted by the shared validateEvidence", async () => {
    const cwd = project();
    const { result } = load(BUILTIN);
    expect(await result?.(ok(), ctx(cwd))).toBeUndefined();
    expect(lines(cwd)).toHaveLength(1);
    expect(lines(cwd)[0]).toMatchObject({
      feature: "demo",
      id: "A1",
      command: COMMAND,
      tree: cwd,
      cwd,
      sessionId: "sess-1",
    });
    expect(lines(cwd)[0]?.agentId).toBeUndefined();
    const root = resolveStateRoot({ cwd, feature: "demo" });
    expect(validateEvidence({ root, feature: "demo", id: "A1", command: COMMAND })).toMatchObject({
      ok: true,
    });
  });

  // Covers: R7
  it("records in a child and for a nested call, not suppressed by the parent-only guard", async () => {
    const cwd = project();
    const child = load(BUILTIN, {
      NAVORI_PI_CHILD_DEPTH: "1",
      NAVORI_PI_CHILD_ROLE: "implementer",
    });
    expect(child.result).toBeTypeOf("function");
    await child.result?.(ok({ toolCallId: "top" }), ctx(cwd));
    await child.result?.(ok({ toolCallId: "top/1", parentToolCallId: "top" }), ctx(cwd));
    const recorded = lines(cwd);
    expect(recorded).toHaveLength(2);
    expect(recorded.every((line) => line.agentId === "pi-implementer")).toBe(true);
    const root = resolveStateRoot({ cwd, feature: "demo" });
    expect(validateEvidence({ root, feature: "demo", id: "A1", command: COMMAND })).toMatchObject({
      ok: true,
    });
  });

  // Covers: R7
  it("dedupes a repeated event for the same call", async () => {
    const cwd = project();
    const { result } = load(BUILTIN);
    await Promise.all([result?.(ok(), ctx(cwd)), result?.(ok(), ctx(cwd))]);
    await result?.(ok(), ctx(cwd));
    expect(lines(cwd)).toHaveLength(1);
  });

  // Covers: R7
  it("records nothing unless success is established by the built-in bash contract", async () => {
    const cwd = project();
    const strict = load(BUILTIN);
    const cases: Array<[string, ResultEvent, unknown[]?]> = [
      ["isError alone without exit_code", ok({ structuredContent: undefined })],
      ["isError with exit 0", ok({ isError: true })],
      ["non-zero exit", ok({ structuredContent: { exit_code: 1 }, isError: true })],
      ["non-zero exit not flagged", ok({ structuredContent: { exit_code: 1 } })],
      ["text claiming success", ok({ structuredContent: undefined, input: { command: COMMAND } })],
      ["a different command", ok({ input: { command: `${COMMAND} --other` } })],
      ["another tool", ok({ toolName: "write" })],
      [
        "replaced bash tool",
        ok(),
        [{ name: "bash", sourceInfo: { path: "/x/ext.ts", source: "extension" } }],
      ],
      ["no tool registry entry", ok(), []],
    ];
    for (const [label, event, tools] of cases) {
      const { result } = tools ? load(tools) : strict;
      await result?.({ ...event, toolCallId: label }, ctx(cwd));
      expect(lines(cwd), label).toHaveLength(0);
    }
  });

  // Covers: R7
  it("never writes outside the criterion's state dir and leaves a symlinked log alone", async () => {
    const cwd = project();
    const target = join(cwd, "elsewhere.jsonl");
    writeFileSync(target, "");
    execFileSync("ln", ["-s", target, join(cwd, DIR, "workplan_demo.evidence.jsonl")]);
    await load(BUILTIN).result?.(ok(), ctx(cwd));
    expect(readFileSync(target, "utf8")).toBe("");
  });
});
