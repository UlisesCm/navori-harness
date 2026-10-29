import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NavoriConfigSchema } from "../../../lib/config/schema.ts";
import { PI_HOOK_BINDINGS } from "../hook-bindings.ts";
import { renderPiEngine } from "../index.ts";
import {
  PI_GATE_TIMEOUT_MS,
  PI_ROLE_NAMES,
  PI_ROLE_TIMEOUT_MS,
  PI_ROLE_TOOLS,
} from "../role-tools.ts";
import { load } from "./fixtures/load-extension.ts";
import { PINNED_PI_VERSION } from "./fixtures/pinned-pi-version.ts";
import { PI_EXTENSION_SOURCE } from "../extension-source.ts";

interface Ctx {
  cwd: string;
  hasUI?: boolean;
  ui?: { input: ReturnType<typeof vi.fn> };
  sessionManager: { getSessionId: () => string };
}
type Env = Record<string, string>;

const PARENT: Env = {};
const CHILD: Env = { NAVORI_PI_CHILD_DEPTH: "1", NAVORI_PI_CHILD_ROLE: "publisher" };

// Every call runs the real scripts under bash; a saturated machine needs room.
vi.setConfig({ testTimeout: 60_000 });

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A git repo rendered for Pi whose `qualityGate.fast` is `fast` (none when undefined). */
function piProject(fast: string | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), "navori-pi-gate-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q", dir]);
  renderPiEngine(
    dir,
    NavoriConfigSchema.parse({
      name: "pi-gate",
      preset: "custom",
      engines: ["pi"],
      branchBase: "main",
      ...(fast === undefined ? {} : { qualityGate: { fast, full: fast } }),
    }),
  );
  return dir;
}

const ctxFor = (cwd: string, hasUI = false, answer = true): Ctx => ({
  cwd,
  hasUI,
  ...(hasUI
    ? {
        ui: {
          input: vi.fn(async (_t: string, _p?: string) => (answer ? "yes, run it" : "")),
        },
      }
    : {}),
  sessionManager: { getSessionId: () => "sess-gate" },
});

/** The tool_call verdict of one bash command in the given thread. */
async function verdict(env: Env, cwd: string, command: string, ctx: Ctx): Promise<unknown> {
  return load({ env }).get("tool_call")!(
    { toolName: "bash", toolCallId: "call-gate", input: { command } },
    ctx,
  );
}

const reasonOf = (result: unknown): string => (result as { reason: string }).reason;
const isBlocked = (result: unknown): boolean =>
  (result as { block?: boolean } | undefined)?.block === true;

describe("Pi quality gate on commit and push", () => {
  // Covers: R4
  it("commit and push gated", async () => {
    const dir = piProject("touch .gate-ran");
    const ran = join(dir, ".gate-ran");
    for (const env of [PARENT, CHILD]) {
      for (const command of [
        "git commit -m x",
        "git push origin HEAD",
        "git add -A && git commit -m x && git push",
        "cd . && git -C . push",
      ]) {
        rmSync(ran, { force: true });
        const result = await verdict(env, dir, command, ctxFor(dir));
        expect(result, `${JSON.stringify(env)} ${command}`).toBeUndefined();
        expect(existsSync(ran), `gate ran for ${command}`).toBe(true);
      }
      // Anything that is neither a commit nor a push never pays for the gate.
      for (const command of ["git status", "git log --oneline -3", "echo git push"]) {
        rmSync(ran, { force: true });
        expect(await verdict(env, dir, command, ctxFor(dir))).toBeUndefined();
        expect(existsSync(ran), `gate must not run for ${command}`).toBe(false);
      }
    }
  });

  // Covers: R4
  it("a red gate blocks commit and push in the parent and in a child", async () => {
    const dir = piProject("echo gate-output-noise && false");
    for (const env of [PARENT, CHILD]) {
      for (const command of [
        "git commit -m x",
        "git push",
        "git push --force-with-lease origin x",
      ]) {
        const result = await verdict(env, dir, command, ctxFor(dir, true));
        expect(isBlocked(result), `${JSON.stringify(env)} ${command}`).toBe(true);
        expect(reasonOf(result)).toMatch(/quality-gate fast failed/);
      }
    }
  });

  // Covers: R4
  it("a gate that cannot run blocks: no runner, no way to ask in a child or without UI", async () => {
    const dir = piProject("navori-no-such-runner --check");
    for (const [env, ctx] of [
      [PARENT, ctxFor(dir)],
      [CHILD, ctxFor(dir, true)],
    ] as const) {
      for (const command of ["git commit -m x", "git push"]) {
        const result = await verdict(env, dir, command, ctx);
        expect(isBlocked(result), `${JSON.stringify(env)} ${command}`).toBe(true);
        expect(reasonOf(result)).toMatch(/not on PATH|BLOCKED/);
      }
    }
    // An interactive parent may decide: that is an ask, shown in the native dialog, and denial refuses.
    const denied = ctxFor(dir, true, false);
    const refusal = await verdict(PARENT, dir, "git push", denied);
    expect(denied.ui!.input).toHaveBeenCalledOnce();
    expect(denied.ui!.input.mock.calls[0]![0]).toContain("did not run");
    expect(isBlocked(refusal)).toBe(true);
    const approved = ctxFor(dir, true, true);
    expect(await verdict(PARENT, dir, "git push", approved)).toBeUndefined();
  });

  // Covers: R4
  it("the gate is an enforced binding only when qualityGate.fast exists", () => {
    const row = PI_HOOK_BINDINGS.find((binding) => binding.script === "quality-gate-pre-commit");
    expect(row).toMatchObject({
      on: "tool_call",
      tools: ["bash"],
      scope: "all",
      class: "enforced",
    });
    expect(row?.timeoutMs).toBe(PI_GATE_TIMEOUT_MS);
    const withGate = piProject("true");
    const without = piProject(undefined);
    const scripts = (dir: string): string[] =>
      (
        JSON.parse(readFileSync(join(dir, ".pi/navori.json"), "utf8")) as {
          hooks: Array<{ script: string }>;
        }
      ).hooks.map((hook) => hook.script);
    expect(scripts(withGate)).toContain("quality-gate-pre-commit");
    expect(scripts(without)).not.toContain("quality-gate-pre-commit");
    expect(existsSync(join(without, ".pi/navori/hooks/quality-gate-pre-commit.sh"))).toBe(false);
  });

  // Covers: R4
  it("the deadline of every role that may commit or push outlives the gate by ten minutes", () => {
    const bashRoles = PI_ROLE_NAMES.filter((role) => PI_ROLE_TOOLS[role].includes("bash"));
    expect(bashRoles.length).toBeGreaterThan(0);
    for (const role of bashRoles) {
      expect(PI_ROLE_TIMEOUT_MS[role]).toBeGreaterThanOrEqual(PI_GATE_TIMEOUT_MS + 600_000);
    }
  });
});

describe("Pi implementer dispatch plan gate payload", () => {
  /** Dispatches an implementer with `navori plan gate` scripted to deny; returns the stdin it received. */
  async function gatePayload(sessionId: string | undefined): Promise<Record<string, unknown>> {
    const cwd = mkdtempSync(join(tmpdir(), "navori-pi-gate-payload-"));
    dirs.push(cwd);
    execFileSync("git", ["init", "-q", cwd]);
    renderPiEngine(
      cwd,
      NavoriConfigSchema.parse({
        name: "pi-gate-payload",
        preset: "custom",
        engines: ["pi"],
        harness: { planTiers: true },
      }),
    );
    let stdin = "";
    const spawn = (program: string): EventEmitter => {
      const child = Object.assign(new EventEmitter(), {
        pid: 7,
        stdin: {
          end: (chunk?: string): void => {
            stdin += chunk ?? "";
          },
          write: (chunk: string): void => {
            stdin += chunk;
          },
          on: (): void => {},
        },
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(),
      });
      if (program === "navori") setImmediate(() => child.emit("close", 2));
      return child;
    };
    const nodeRequire = createRequire(import.meta.url);
    const stubs: Record<string, unknown> = {
      "node:child_process": { spawn },
      "@earendil-works/pi-ai": { Type: new Proxy({}, { get: () => () => ({}) }) },
      "@earendil-works/pi-coding-agent": {
        VERSION: PINNED_PI_VERSION,
        defineTool: <T>(v: T): T => v,
      },
    };
    const sandbox = {
      exports: {} as { default?: (pi: unknown) => void },
      require: (id: string): unknown => stubs[id] ?? nodeRequire(id),
      process: {
        env: {},
        platform: process.platform,
        versions: { node: "22.19.0" },
        stderr: { write: () => true },
        getBuiltinModule: process.getBuiltinModule.bind(process),
      },
      Buffer,
      AbortController,
      setTimeout,
      clearTimeout,
    };
    const code = stripTypeScriptTypes(PI_EXTENSION_SOURCE);
    runInNewContext(
      code
        .replace(/^import \{ (.+) \} from "(.+)";$/gm, 'const { $1 } = require("$2");')
        .replace("export default function", "exports.default = function"),
      sandbox,
    );
    let tool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
    sandbox.exports.default?.({
      on: () => () => {},
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      registerTool: (value: typeof tool) => {
        tool = value;
      },
    });
    await tool!
      .execute(
        "call",
        { role: "implementer", task: "Do the scoped task", feature: "demo" },
        new AbortController().signal,
        () => {},
        {
          cwd,
          isProjectTrusted: () => true,
          model: { provider: "p", id: "m" },
          ...(sessionId === undefined ? {} : { sessionManager: { getSessionId: () => sessionId } }),
        },
      )
      .catch(() => undefined);
    return JSON.parse(stdin) as Record<string, unknown>;
  }

  it("sends the sanitized Pi session id as session_id", async () => {
    const payload = await gatePayload("sess/gate 1");
    expect(payload.session_id).toBe("sessgate1");
    expect(payload.tool_input).toMatchObject({ agent_type: "implementer" });
  });

  it("omits session_id when the session id is unavailable", async () => {
    const payload = await gatePayload(undefined);
    expect("session_id" in payload).toBe(false);
  });
});
