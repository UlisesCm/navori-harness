import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfigOrExit } from "../cli-config.ts";

/**
 * readConfigOrExit (#70): render/sync/update/configure used the bare readConfig,
 * so an invalid config surfaced a raw stack trace instead of the clean message
 * doctor shows. This wrapper prints a legible error and exits 1.
 */

function tmp(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "navori-cliconfig-"));
  writeFileSync(join(dir, "navori.config.json"), content);
  return join(dir, "navori.config.json");
}

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("readConfigOrExit", () => {
  it("returns the parsed config for a valid file", () => {
    const path = tmp(JSON.stringify({ name: "demo", engines: ["claude"], preset: "custom" }));
    dirs.push(path.replace(/\/navori\.config\.json$/, ""));
    const config = readConfigOrExit(path);
    expect(config.name).toBe("demo");
  });

  it("prints a clean message and exits 1 on an invalid config (no raw stack)", () => {
    const path = tmp('{ "name": 123 }'); // name must be a string
    dirs.push(path.replace(/\/navori\.config\.json$/, ""));
    const exit = vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("__exit__");
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => readConfigOrExit(path)).toThrow("__exit__");
    expect(exit).toHaveBeenCalledWith(1);
    // at least one issue line was printed (path: message), not a stack trace
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes(":"))).toBe(true);
  });

  it("exits 1 when the file does not exist", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("__exit__");
    }) as never);
    expect(() => readConfigOrExit("/nonexistent/navori.config.json")).toThrow("__exit__");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
