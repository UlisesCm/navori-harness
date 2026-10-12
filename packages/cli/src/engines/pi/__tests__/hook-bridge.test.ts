import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NavoriConfigSchema } from "../../../lib/config/schema.ts";
import { PI_EXTENSION_SOURCE } from "../extension-source.ts";
import type { PiHookBinding } from "../hook-bindings.ts";
import { renderPiEngine } from "../index.ts";
import { serializePiManifest, type PiManifestHook } from "../owned-file.ts";

type Handler = (event: Record<string, unknown>, ctx: unknown) => Promise<unknown> | unknown;
type Shell = () => { shell: string; args: string[] };
interface Ctx {
  cwd: string;
  hasUI?: boolean;
  ui?: { confirm: ReturnType<typeof vi.fn> };
  sessionManager: { getSessionId: () => string };
}

const BASH: Shell = () => ({ shell: "/bin/bash", args: ["-c"] });
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Loads the rendered extension with Pi stubbed and real node:* modules (the scripts really run). */
function load(
  options: { shell?: Shell; env?: Record<string, string>; version?: string } = {},
): Map<string, Handler> {
  const nodeRequire = createRequire(import.meta.url);
  const handlers = new Map<string, Handler>();
  const modules: Record<string, unknown> = {
    "@earendil-works/pi-ai": { Type: new Proxy({}, { get: () => () => ({}) }) },
    "@earendil-works/pi-coding-agent": {
      VERSION: options.version ?? "1.1.0",
      defineTool: (value: unknown) => value,
      getShellConfig: options.shell ?? BASH,
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
      env: { ...process.env, NAVORI_PI_CHILD_DEPTH: "", NAVORI_PI_CHILD_ROLE: "", ...options.env },
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
    on: (name: string, handler: Handler) => {
      // The first handler of an event is the bridge's: the later ones are context helpers.
      if (!handlers.has(name)) handlers.set(name, handler);
    },
    registerTool: () => {},
  });
  return handlers;
}

type Spec = Partial<PiManifestHook> & { script: string; body: string };

/** A project with a v2 manifest and the given hook scripts under `.pi/navori/hooks/`. */
function project(specs: Spec[]): string {
  const cwd = mkdtempSync(join(tmpdir(), "navori-pi-bridge-"));
  dirs.push(cwd);
  mkdirSync(join(cwd, ".pi/navori/hooks"), { recursive: true });
  const hooks: PiManifestHook[] = specs.map(({ body, ...spec }) => {
    writeFileSync(join(cwd, `.pi/navori/hooks/${spec.script}.sh`), body);
    return {
      path: `.pi/navori/hooks/${spec.script}.sh`,
      on: "tool_call",
      tools: ["bash"],
      scope: "all",
      class: "enforced",
      interactive: false,
      timeoutMs: 10_000,
      ...spec,
    };
  });
  writeFileSync(
    join(cwd, ".pi/navori.json"),
    serializePiManifest({
      schemaVersion: 2,
      agents: [],
      hooks,
      ownedPaths: [],
      permissionRules: { ask: [], deny: [] },
    }),
  );
  return cwd;
}

const ctxFor = (cwd: string, hasUI = false, answer = true): Ctx => ({
  cwd,
  hasUI,
  ...(hasUI ? { ui: { confirm: vi.fn(async () => answer) } } : {}),
  sessionManager: { getSessionId: () => "sess-1" },
});
const bash = (command: string): Record<string, unknown> => ({
  toolName: "bash",
  toolCallId: "call-1",
  input: { command },
});
const reasonOf = (result: unknown): string => (result as { reason: string }).reason;

/** Decide one bash call against a single enforced script. */
async function decide(
  body: string,
  spec: Partial<PiManifestHook> = {},
  options: Parameters<typeof load>[0] = {},
  ctx?: (cwd: string) => Ctx,
): Promise<unknown> {
  const cwd = project([{ script: "probe", body, ...spec }]);
  return load(options).get("tool_call")!(bash("git status"), (ctx ?? ctxFor)(cwd));
}

describe("hook bridge verdict contract", () => {
  // Covers: R15
  it("verdict contract fails closed", async () => {
    // Allowed: exit 0 without JSON, and an explicit allow.
    expect(await decide("exit 0\n")).toBeUndefined();
    expect(
      await decide(
        `printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'\n`,
      ),
    ).toBeUndefined();
    // exit 2 blocks with the script's own stderr as the reason.
    const blocked = await decide("echo 'BLOCKED by probe: nope' >&2\nexit 2\n");
    expect(blocked).toMatchObject({ block: true });
    expect(reasonOf(blocked)).toContain("BLOCKED by probe: nope");
    // JSON deny blocks with its reason.
    const denied = await decide(
      `printf '%s\\n' '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"no route"}}'\n`,
    );
    expect(denied).toMatchObject({ block: true });
    expect(reasonOf(denied)).toBe("no route");
  });

  // Covers: R15
  it("noisy stdout does not block and cannot hide a verdict", async () => {
    // The gate prints its whole run on stdout and exits 0: that is noise, not a verdict.
    expect(await decide("echo 'running tests...'\necho 'all green'\nexit 0\n")).toBeUndefined();
    // Brace-looking noise that is not a verdict object is still noise.
    expect(await decide(`echo '{ not json'\necho '{"unrelated":1}'\nexit 0\n`)).toBeUndefined();
    // More than 64 KiB of noise neither hangs nor blocks.
    expect(await decide("head -c 300000 /dev/zero | tr '\\0' x\necho\nexit 0\n")).toBeUndefined();
    // A verdict after noise is still read (last JSON line), and exit 2 wins over any stdout.
    const asked = await decide(
      `echo 'noise'\nprintf '%s\\n' '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"after noise"}}'\n`,
    );
    expect(reasonOf(asked)).toBe("after noise");
    expect(
      reasonOf(await decide(`echo '{"systemMessage":"hi"}'\necho 'real reason' >&2\nexit 2\n`)),
    ).toBe("real reason");
  });

  // Covers: R15
  it("unknown JSON, exit 1, signal, timeout and a missing script block an enforced control", async () => {
    const unknown = await decide(
      `printf '%s\\n' '{"hookSpecificOutput":{"permissionDecision":"maybe"}}'\n`,
    );
    expect(unknown).toMatchObject({ block: true });
    expect(reasonOf(unknown)).toMatch(/unknown decision/);
    for (const control of [
      `{"hookSpecificOutput":{"permissionDecision":"allow","updatedInput":{"command":"x"}}}`,
      `{"continue":false}`,
      `{"hookSpecificOutput":"surprise"}`,
    ]) {
      const result = await decide(`printf '%s\\n' '${control}'\n`);
      expect(result).toMatchObject({ block: true });
      expect(reasonOf(result)).toMatch(/cannot honor/);
    }
    const exit1 = await decide("echo 'boom' >&2\nexit 1\n");
    expect(exit1).toMatchObject({ block: true });
    expect(reasonOf(exit1)).toMatch(/could not evaluate.*exited with 1.*boom/);
    expect(reasonOf(await decide("exit 127\n"))).toMatch(/exited with 127/);
    expect(reasonOf(await decide("kill -9 $$\n"))).toMatch(/killed by SIGKILL/);
    const slow = await decide("sleep 30\n", { timeoutMs: 300 });
    expect(slow).toMatchObject({ block: true });
    expect(reasonOf(slow)).toMatch(/timed out after 300 ms/);
    // A hook entry whose script file is gone cannot be evaluated either.
    const cwd = project([{ script: "probe", body: "exit 0\n" }]);
    rmSync(join(cwd, ".pi/navori/hooks/probe.sh"));
    expect(await load().get("tool_call")!(bash("ls"), ctxFor(cwd))).toMatchObject({ block: true });
  });

  // Covers: R15
  it("a missing bash, or the sh fallback, blocks every enforced script with the action", async () => {
    const missing: Shell = () => {
      throw new Error("No bash shell found");
    };
    for (const shell of [
      missing,
      () => ({ shell: "sh", args: ["-c"] }),
      (() => undefined) as never,
    ]) {
      const result = await decide("exit 0\n", {}, { shell });
      expect(result).toMatchObject({ block: true });
      expect(reasonOf(result)).toMatch(/Git for Windows/);
    }
    // The legacy WSL launcher is not a bash Navori can hand a script path to.
    const wsl = await decide(
      "exit 0\n",
      {},
      {
        shell: () => ({ shell: "C:\\Windows\\System32\\bash.exe", args: ["-s"] }),
      },
    );
    expect(wsl).toMatchObject({ block: true });
    // Advisory scripts are skipped, never blocked, when bash is missing.
    const cwd = project([{ script: "probe", body: "exit 0\n", class: "advisory" }]);
    expect(
      await load({ shell: missing }).get("tool_call")!(bash("ls"), ctxFor(cwd)),
    ).toBeUndefined();
    // Reads and other tools never need bash.
    expect(
      await load({ shell: missing }).get("tool_call")!(
        { toolName: "read", toolCallId: "c", input: { path: "a" } },
        ctxFor(cwd),
      ),
    ).toBeUndefined();
  });

  // Covers: R15
  it("an unreadable or incompatible manifest blocks guarded tools and spares reads", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "navori-pi-bridge-none-"));
    dirs.push(cwd);
    const tool_call = load().get("tool_call")!;
    for (const toolName of ["bash", "edit", "write"]) {
      const result = await tool_call({ toolName, toolCallId: "c", input: {} }, ctxFor(cwd));
      expect(result).toMatchObject({ block: true });
      expect(reasonOf(result)).toMatch(/navori render --apply/);
    }
    // A v1 manifest (an older render) is "cannot evaluate" for a v2 extension.
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi/navori.json"),
      serializePiManifest({ schemaVersion: 1, agents: [] }),
    );
    expect(await tool_call(bash("ls"), ctxFor(cwd))).toMatchObject({ block: true });
    // A binding with a path outside Navori's hook directory is malformed, never executed.
    const evil = project([{ script: "probe", body: "exit 0\n" }]);
    const manifest = readFileSync(join(evil, ".pi/navori.json"), "utf8").replace(
      ".pi/navori/hooks/probe.sh",
      "../../evil.sh",
    );
    writeFileSync(join(evil, ".pi/navori.json"), manifest);
    expect(await tool_call(bash("ls"), ctxFor(evil))).toMatchObject({ block: true });
  });

  // Covers: R15
  it("advisory failures stay silent and advisory warnings are bounded", async () => {
    const cwd = (body: string, spec: Partial<PiManifestHook> = {}): string =>
      project([
        { script: "probe", body, on: "tool_result", class: "advisory", timeoutMs: 10_000, ...spec },
      ]);
    const result = async (dir: string, shell: Shell = BASH): Promise<unknown> =>
      load({ shell }).get("tool_result")!(
        {
          toolName: "bash",
          toolCallId: "call-1",
          input: { command: "ls" },
          content: [{ type: "text", text: "out" }],
          structuredContent: { exit_code: 0 },
          isError: false,
        },
        ctxFor(dir),
      );
    const texts = (value: unknown): string[] =>
      (value as { content: Array<{ text: string }> }).content.map((part) => part.text);
    // exit 2 (the drift channel): stderr becomes one extra block, the original result and structure stay.
    const warned = await result(cwd("echo 'drift in CLAUDE.md' >&2\nexit 2\n"));
    expect(texts(warned)).toEqual(["out", "drift in CLAUDE.md"]);
    expect((warned as { structuredContent: unknown }).structuredContent).toEqual({ exit_code: 0 });
    // JSON context is a warning too.
    expect(
      texts(
        await result(
          cwd(`printf '%s\\n' '{"hookSpecificOutput":{"additionalContext":"heads up"}}'\n`),
        ),
      ),
    ).toEqual(["out", "heads up"]);
    // Oversized advisory text is cut to about 1 KiB, keeping head and tail.
    const long = texts(await result(cwd("head -c 5000 /dev/zero | tr '\\0' y >&2\nexit 2\n")))[1]!;
    expect(long.length).toBeLessThan(1_200);
    expect(long).toContain("[truncated]");
    // Every failure mode is silent: the result goes through untouched.
    for (const body of [
      "exit 1\n",
      "exit 127\n",
      "kill -9 $$\n",
      `printf '%s\\n' '{"hookSpecificOutput":{"permissionDecision":"deny"}}'\n`,
      `printf '%s\\n' '{"hookSpecificOutput":{"permissionDecision":"maybe"}}'\n`,
      `printf '%s\\n' '{"continue":false}'\n`,
      "echo noise\nexit 0\n",
    ]) {
      expect(await result(cwd(body))).toBeUndefined();
    }
    expect(await result(cwd("sleep 30\n", { timeoutMs: 300 }))).toBeUndefined();
    expect(
      await result(cwd("exit 2\n"), () => {
        throw new Error("no bash");
      }),
    ).toBeUndefined();
    // An unreadable manifest is silent for advisory trouble (the tool_call lane is the one that blocks).
    const bare = mkdtempSync(join(tmpdir(), "navori-pi-bridge-none-"));
    dirs.push(bare);
    expect(await result(bare)).toBeUndefined();
  });

  // Covers: R15
  it("keeps stderr head and tail in diagnostics", async () => {
    const result = await decide(
      "printf 'HEAD-%s' \"$(head -c 6000 /dev/zero | tr '\\0' a)\" >&2\nprintf 'TAIL-%s' \"$(head -c 3000 /dev/zero | tr '\\0' b)\" >&2\nexit 2\n",
    );
    const reason = reasonOf(result);
    expect(reason.startsWith("HEAD-aaaa")).toBe(true);
    expect(reason.endsWith("bbbb")).toBe(true);
    expect(reason).toContain("[truncated]");
    expect(reason.length).toBeLessThan(5_000);
  });

  // Covers: R2, R15
  it("sends a Claude-shaped payload and identifies the copy by its path", async () => {
    const cwd = project([
      {
        script: "probe",
        body:
          `cat > "$PWD/payload.json"\n` +
          `printf '%s' "$0" > "$PWD/self.txt"\n` +
          `printf '%s' "\${NODE_CHANNEL_FD:-unset}" > "$PWD/channel.txt"\n`,
      },
    ]);
    const tool_call = load({ env: { NODE_CHANNEL_FD: "3" } }).get("tool_call")!;
    expect(await tool_call(bash("git status"), ctxFor(cwd, true))).toBeUndefined();
    const payload = JSON.parse(readFileSync(join(cwd, "payload.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git status" },
      cwd,
      session_id: "sess-1",
      permission_mode: "default",
    });
    expect(payload).not.toHaveProperty("agent_id");
    expect(readFileSync(join(cwd, "self.txt"), "utf8")).toBe(
      join(cwd, ".pi/navori/hooks/probe.sh"),
    );
    // Pi's IPC descriptor never reaches the scripts (spec 0048 D6).
    expect(readFileSync(join(cwd, "channel.txt"), "utf8")).toBe("unset");
    // No UI -> nobody to ask; a child never asks either.
    await load().get("tool_call")!(bash("ls"), ctxFor(cwd, false));
    expect(JSON.parse(readFileSync(join(cwd, "payload.json"), "utf8"))).toMatchObject({
      permission_mode: "dontAsk",
    });
    await load({ env: { NAVORI_PI_CHILD_DEPTH: "1", NAVORI_PI_CHILD_ROLE: "reviewer" } }).get(
      "tool_call",
    )!(bash("ls"), ctxFor(cwd, true));
    expect(JSON.parse(readFileSync(join(cwd, "payload.json"), "utf8"))).toMatchObject({
      permission_mode: "dontAsk",
      agent_id: "pi-reviewer",
      agent_type: "reviewer",
    });
    // edit/write calls carry the Claude `file_path` and the Claude tool name.
    await load().get("tool_call")!(
      { toolName: "write", toolCallId: "w1", input: { path: "@src/a.ts", content: "x" } },
      ctxFor(cwd),
    );
    expect(existsSync(join(cwd, "payload.json"))).toBe(true);
  });

  // Covers: R15
  it("runs matching scripts concurrently, scoped by thread and tool", async () => {
    // Each script only succeeds when the other one is running at the same time.
    const wait = (me: string, other: string): string =>
      `touch "$PWD/${me}.started"\nfor i in $(seq 1 100); do [ -e "$PWD/${other}.started" ] && exit 0; sleep 0.05; done\nexit 2\n`;
    const cwd = project([
      { script: "one", body: wait("one", "two") },
      { script: "two", body: wait("two", "one") },
    ]);
    expect(await load().get("tool_call")!(bash("ls"), ctxFor(cwd))).toBeUndefined();
    // The first block wins and kills the rest: no waiting for a slow sibling.
    const killed = project([
      { script: "fast", body: "echo stop >&2\nexit 2\n" },
      { script: "slow", body: `echo $$ > "$PWD/slow.pid"\nsleep 30\n`, timeoutMs: 60_000 },
    ]);
    const started = Date.now();
    const result = await load().get("tool_call")!(bash("ls"), ctxFor(killed));
    expect(reasonOf(result)).toBe("stop");
    expect(Date.now() - started).toBeLessThan(8_000);
    // Scope and tool filters: a parent-only script never runs in a child, a bash script never runs for edit.
    const scoped = project([
      { script: "parent-only", scope: "parent", body: `touch "$PWD/parent.ran"\n` },
      { script: "child-only", scope: "child", body: `touch "$PWD/child.ran"\n` },
    ]);
    await load({ env: { NAVORI_PI_CHILD_DEPTH: "1", NAVORI_PI_CHILD_ROLE: "scout" } }).get(
      "tool_call",
    )!(bash("ls"), ctxFor(scoped));
    expect(existsSync(join(scoped, "child.ran"))).toBe(true);
    expect(existsSync(join(scoped, "parent.ran"))).toBe(false);
    await load().get("tool_call")!(
      { toolName: "edit", toolCallId: "e", input: { path: "a" } },
      ctxFor(scoped),
    );
    expect(existsSync(join(scoped, "parent.ran"))).toBe(false);
  });

  // Covers: R5, R15
  it("resolves an ask with one confirmation showing every reason, and refuses without a user", async () => {
    const ask = (reason: string): string =>
      `printf '%s\\n' '{"hookSpecificOutput":{"permissionDecision":"ask","permissionDecisionReason":"${reason}"}}'\n`;
    const cwd = project([
      { script: "one", body: ask("first reason"), interactive: true },
      { script: "two", body: ask("second reason"), interactive: true },
    ]);
    const approved = ctxFor(cwd, true, true);
    expect(await load().get("tool_call")!(bash("git reset --hard"), approved)).toBeUndefined();
    expect(approved.ui!.confirm).toHaveBeenCalledOnce();
    const message = String(approved.ui!.confirm.mock.calls[0]![1]);
    expect(message).toContain("first reason");
    expect(message).toContain("second reason");
    expect(message).toContain("git reset --hard");
    const denied = await load().get("tool_call")!(
      bash("git reset --hard"),
      ctxFor(cwd, true, false),
    );
    expect(reasonOf(denied)).toMatch(/denied or cancelled/);
    const headless = await load().get("tool_call")!(bash("git reset --hard"), ctxFor(cwd, false));
    expect(reasonOf(headless)).toMatch(/no interactive UI/);
    const child = await load({
      env: { NAVORI_PI_CHILD_DEPTH: "1", NAVORI_PI_CHILD_ROLE: "scout" },
    }).get("tool_call")!(bash("git reset --hard"), ctxFor(cwd, true));
    expect(reasonOf(child)).toMatch(/children cannot approve/);
  });

  // Covers: R2, R15, R16
  it("runs the shared guard copy rendered for Pi through the bridge", async () => {
    const dir = mkdtempSync(join(tmpdir(), "navori-pi-bridge-real-"));
    dirs.push(dir);
    const binding: PiHookBinding = {
      script: "guard-destructive",
      on: "tool_call",
      tools: ["bash"],
      scope: "all",
      class: "enforced",
      interactive: true,
      timeoutMs: 30_000,
    };
    renderPiEngine(
      dir,
      NavoriConfigSchema.parse({
        name: "pi-bridge-real",
        preset: "custom",
        engines: ["pi"],
        branchBase: "main",
        qualityGate: { fast: "bun test", full: "bun test" },
      }),
      { hookBindings: [binding] },
    );
    const script = readFileSync(join(dir, ".pi/navori/hooks/guard-destructive.sh"), "utf8");
    expect(script).toContain('*"/.pi/navori/"*) nv_engine=pi ;;');
    const tool_call = load().get("tool_call")!;
    const blocked = await tool_call(bash("rm -rf /"), ctxFor(dir));
    expect(blocked).toMatchObject({ block: true });
    expect(reasonOf(blocked)).toContain("BLOCKED by guard-destructive");
    // The same copy lets a benign command through, from the parent and from a child.
    expect(await tool_call(bash("git status"), ctxFor(dir))).toBeUndefined();
    const child = load({
      env: { NAVORI_PI_CHILD_DEPTH: "1", NAVORI_PI_CHILD_ROLE: "implementer" },
    });
    expect(await child.get("tool_call")!(bash("git status"), ctxFor(dir))).toBeUndefined();
    expect(await child.get("tool_call")!(bash("rm -rf /"), ctxFor(dir))).toMatchObject({
      block: true,
    });
  });
});
