import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { stripTypeScriptTypes } from "node:module";
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
    expect(() => check("0.87.1", "22.19.0")).not.toThrow();
    expect(() => check("0.87.0", "22.19.0")).toThrow(/requires.*0\.87\.1/);
    expect(() => check("0.87.1", "22.18.9")).toThrow(/requires Node\.js 22\.19\.0/);
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
    expect(() => assertSupportedPiRuntime("0.87.1", "22.19.0")).not.toThrow();
    expect(() => assertSupportedPiRuntime("v0.88.0", "24.0.0")).not.toThrow();
    expect(() => assertSupportedPiRuntime("1.0.0+build.1", "24.20.0")).not.toThrow();
  });

  // Covers: R10
  it("rejects old, malformed, or prerelease Pi versions with upgrade guidance", () => {
    for (const version of ["0.87.0", "0.87.1-beta", "unknown"]) {
      expect(() => assertSupportedPiRuntime(version, "22.19.0")).toThrow(
        /requires @earendil-works\/pi-coding-agent 0\.87\.1 or later.*upgrade Pi/,
      );
    }
  });

  // Covers: R10
  it("rejects old or malformed Node versions before checking Pi", () => {
    for (const version of ["22.18.9", "21.99.0", "unknown"]) {
      expect(() => assertSupportedPiRuntime("0.87.1", version)).toThrow(
        /requires Node\.js 22\.19\.0 or later/,
      );
    }
  });

  // Covers: R9, R10
  it("registers no tool or hook when the standalone extension sees an incompatible runtime", () => {
    const js = stripTypeScriptTypes(PI_EXTENSION_SOURCE)
      .replace(/^import \{ (.+) \} from "(.+)";$/gm, 'const { $1 } = require("$2");')
      .replace("export default function", "exports.default = function");
    for (const [piVersion, nodeVersion] of [
      ["0.87.0", "22.19.0"],
      ["invalid", "22.19.0"],
      ["0.87.1", "22.18.9"],
    ]) {
      const exports: { default?: (pi: { on: () => void; registerTool: () => void }) => void } = {};
      const diagnostics: string[] = [];
      const registrations: string[] = [];
      runInNewContext(js, {
        exports,
        require: (id: string): unknown => {
          if (id === "@earendil-works/pi-coding-agent") return { VERSION: piVersion };
          if (id === "@earendil-works/pi-ai") return { Type: {} };
          if (id === "node:child_process") return { spawn: () => undefined };
          if (id === "node:fs") return { readFileSync: () => undefined };
          if (id === "node:path") return { join: () => undefined };
          throw new Error(`Unexpected import ${id}`);
        },
        process: {
          versions: { node: nodeVersion },
          stderr: { write: (value: string) => diagnostics.push(value) },
        },
      });
      exports.default?.({
        on: () => {
          registrations.push("hook");
        },
        registerTool: () => {
          registrations.push("tool");
        },
      });
      expect(registrations).toEqual([]);
      expect(diagnostics.join("")).toMatch(
        /requires (?:Node\.js|@earendil-works\/pi-coding-agent)/,
      );
      expect(diagnostics.join("")).not.toMatch(/token|auth/i);
    }
  });
});
