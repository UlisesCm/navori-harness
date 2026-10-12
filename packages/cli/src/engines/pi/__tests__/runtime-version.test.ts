import { createRequire, stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { PI_EXTENSION_SOURCE } from "../extension-source.ts";
import {
  assertSupportedPiRuntime,
  renderPiRuntimeVersionSource,
  serializeAnonymousFunction,
} from "../runtime-version.ts";

describe("Pi runtime version floor", () => {
  it("embeds a self-contained check with a stable binding and version diagnostics", () => {
    const check: unknown = runInNewContext(
      stripTypeScriptTypes(renderPiRuntimeVersionSource()) + "\nassertSupportedPiRuntime;",
    );
    if (typeof check !== "function") throw new Error("Missing standalone runtime check");
    expect(() => check("1.1.0", "22.19.0")).not.toThrow();
    expect(() => check("1.0.9", "22.19.0")).toThrow(/requires.*1\.1\.0/);
    expect(() => check("1.1.0", "22.18.9")).toThrow(/requires Node\.js 22\.19\.0/);
  });

  it("serializes independently of the function identifier", () => {
    expect(renderPiRuntimeVersionSource()).not.toMatch(/function\s+[\w$]+\s*\(\s*minPiVersion/);
    const renamed = (name: string): string =>
      `function ${name}(a,b){return function(c){return a+b+c}}`;
    const strip = (name: string): string =>
      serializeAnonymousFunction(
        runInNewContext(`(${renamed(name)})`) as (...args: never[]) => unknown,
      );
    expect(strip("JT")).toBe(strip("YT"));
    expect(strip("$a_1")).toBe(strip("JT"));
    const check: unknown = runInNewContext(`(${strip("JT")})(1,2)(3)`);
    expect(check).toBe(6);
    expect(() => serializeAnonymousFunction(() => 1)).toThrow(/plain function/);
  });

  // Covers: R10
  it("accepts the pinned Pi and Node baselines and later stable versions", () => {
    expect(() => assertSupportedPiRuntime("1.1.0", "22.19.0")).not.toThrow();
    expect(() => assertSupportedPiRuntime("v1.2.0", "24.0.0")).not.toThrow();
    expect(() => assertSupportedPiRuntime("1.1.0+build.1", "24.20.0")).not.toThrow();
  });

  // Covers: R10
  it("rejects old, malformed, or prerelease Pi versions with upgrade guidance", () => {
    for (const version of ["1.0.9", "1.1.0-beta", "unknown"]) {
      expect(() => assertSupportedPiRuntime(version, "22.19.0")).toThrow(
        /requires @earendil-works\/pi-coding-agent 1\.1\.0 or later.*upgrade Pi/,
      );
    }
  });

  // Covers: R10
  it("rejects old or malformed Node versions before checking Pi", () => {
    for (const version of ["22.18.9", "21.99.0", "unknown"]) {
      expect(() => assertSupportedPiRuntime("1.1.0", version)).toThrow(
        /requires Node\.js 22\.19\.0 or later/,
      );
    }
  });

  // Covers: R15
  it("registers nothing when the standalone extension sees an incompatible Node", () => {
    const rt = load("1.1.0", "22.18.9");
    expect(rt.registrations).toEqual([]);
    expect(rt.diagnostics.join("")).toMatch(/requires Node\.js 22\.19\.0/);
    expect(rt.diagnostics.join("")).not.toMatch(/token|auth/i);
  });

  // Covers: R15
  it("unverified version blocks writes keeps reads", async () => {
    // Below the floor, a prerelease (even of a newer version) and an unparseable version are all unverified.
    for (const version of ["0.87.1", "1.0.9", "1.1.0-rc.1", "1.2.0-beta.3", "invalid"]) {
      const rt = load(version);
      // Only the write block: one tool_call handler and no navori_subagent.
      expect(rt.registrations).toEqual(["on:tool_call"]);
      const ctx = rt.ctx();
      for (const toolName of ["bash", "edit", "write", "powershell"]) {
        const result = await rt.call("tool_call", { toolName, input: {} }, ctx);
        expect(result).toMatchObject({ block: true });
        expect((result as { reason: string }).reason).toMatch(
          new RegExp(`does not verify Pi ${version.replace(/[.+]/g, "\\$&")}`),
        );
        expect((result as { reason: string }).reason).toMatch(/upgrade Pi/);
      }
      for (const toolName of ["read", "grep", "find", "ls", "mcp__engram__mem_search"]) {
        expect(await rt.call("tool_call", { toolName, input: {} }, ctx)).toBeUndefined();
      }
      // A single notice for the whole session, however many calls are blocked.
      expect(ctx.notify).toHaveBeenCalledTimes(1);
      expect(ctx.notify.mock.calls[0]![0]).toMatch(/blocked and reads stay available/);
    }
  });

  // Covers: R15
  it("a verified version keeps the full extension and still refuses powershell", async () => {
    const rt = load("1.1.0");
    expect(rt.registrations).toContain("tool:navori_subagent");
    expect(rt.registrations.filter((name) => name === "on:tool_call")).toHaveLength(1);
    const result = await rt.call("tool_call", { toolName: "powershell", input: {} }, rt.ctx());
    expect(result).toMatchObject({ block: true });
    expect((result as { reason: string }).reason).toMatch(/Git for Windows/);
  });

  // Covers: R15
  it("deactivates powershell at session start with one notice", async () => {
    for (const env of [
      {} as Record<string, string>,
      { NAVORI_PI_CHILD_DEPTH: "1", NAVORI_PI_CHILD_ROLE: "scout" },
    ]) {
      const rt = load("1.1.0", "22.19.0", env);
      rt.setActive(["read", "powershell", "edit"]);
      const ctx = rt.ctx();
      await rt.callAll("session_start", { type: "session_start", reason: "startup" }, ctx);
      expect(rt.setActiveTools).toHaveBeenCalledWith(["read", "edit"]);
      expect(ctx.notify).toHaveBeenCalledTimes(1);
      expect(ctx.notify.mock.calls[0]![0]).toMatch(/powershell.*Git for Windows/);
      // Already off: nothing to change and nothing to say.
      rt.setActive(["read", "bash"]);
      await rt.callAll("session_start", { type: "session_start", reason: "reload" }, ctx);
      expect(rt.setActiveTools).toHaveBeenCalledTimes(1);
      expect(ctx.notify).toHaveBeenCalledTimes(1);
    }
  });
});

interface Loaded {
  registrations: string[];
  diagnostics: string[];
  setActiveTools: ReturnType<typeof vi.fn>;
  setActive: (names: string[]) => void;
  ctx: () => {
    cwd: string;
    ui: { notify: ReturnType<typeof vi.fn> };
    notify: ReturnType<typeof vi.fn>;
  };
  call: (name: string, event: Record<string, unknown>, ctx: unknown) => Promise<unknown>;
  callAll: (name: string, event: Record<string, unknown>, ctx: unknown) => Promise<void>;
}

/** Loads the rendered extension against Pi stubs; real node:* modules, no Pi, no network. */
function load(
  piVersion: string,
  nodeVersion = "22.19.0",
  env: Record<string, string> = {},
): Loaded {
  const nodeRequire = createRequire(import.meta.url);
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const registrations: string[] = [];
  const diagnostics: string[] = [];
  let active: string[] = [];
  const setActiveTools = vi.fn((names: string[]) => {
    active = names;
  });
  const modules: Record<string, unknown> = {
    "@earendil-works/pi-ai": { Type: new Proxy({}, { get: () => () => ({}) }) },
    "@earendil-works/pi-coding-agent": {
      VERSION: piVersion,
      defineTool: (value: unknown) => value,
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
      env: { NAVORI_PI_CHILD_DEPTH: "", NAVORI_PI_CHILD_ROLE: "", ...env },
      platform: process.platform,
      versions: { node: nodeVersion },
      stderr: { write: (value: string) => diagnostics.push(value) },
    },
    Buffer,
    setTimeout,
    clearTimeout,
  });
  exports.default?.({
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    getActiveTools: () => active,
    setActiveTools,
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      registrations.push(`on:${name}`);
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool: (tool: { name: string }) => {
      registrations.push(`tool:${tool.name}`);
    },
  });
  return {
    registrations,
    diagnostics,
    setActiveTools,
    setActive: (names) => {
      active = names;
    },
    ctx: () => {
      const notify = vi.fn();
      return { cwd: "/nonexistent", ui: { notify }, notify };
    },
    call: async (name, event, ctx) => handlers.get(name)?.[0]?.(event, ctx),
    callAll: async (name, event, ctx) => {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    },
  };
}
