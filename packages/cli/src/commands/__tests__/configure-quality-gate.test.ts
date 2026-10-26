import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `navori configure quality-gate` — pressing Enter on the "fast" prompt must
 * accept the suggested command. clack 1.x returns "" on an empty submit unless
 * `defaultValue` is set, so the mock below emulates that contract: an empty
 * Enter resolves to the prompt's `defaultValue`, exactly like the real prompt.
 */
const clk = vi.hoisted(() => ({
  calls: [] as Array<{ placeholder?: string; defaultValue?: string }>,
  cancelMsg: [] as string[],
}));

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: (m: string) => clk.cancelMsg.push(m),
  isCancel: () => false,
  text: vi.fn(async (opts: { placeholder?: string; defaultValue?: string }) => {
    clk.calls.push(opts);
    return opts.defaultValue ?? "";
  }),
  log: { message: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

const { runCommand } = await import("citty");
const { configureCommand } = await import("../configure.ts");

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-qg-"));
  clk.calls.length = 0;
  clk.cancelMsg.length = 0;
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("configure quality-gate — Enter accepts the suggestion", () => {
  // Covers: R4
  it("the fast prompt carries the suggested command as defaultValue and persists it", async () => {
    writeFileSync(
      join(cwd, "navori.config.json"),
      JSON.stringify({ name: "demo", engines: ["claude"], preset: "custom" }),
      "utf-8",
    );

    await runCommand(configureCommand, { rawArgs: ["quality-gate", "--cwd", cwd] });

    expect(clk.calls[0]?.placeholder).toBe("pnpm tsc --noEmit");
    expect(clk.calls[0]?.defaultValue).toBe("pnpm tsc --noEmit");
    expect(clk.cancelMsg).toEqual([]);
    const saved = JSON.parse(readFileSync(join(cwd, "navori.config.json"), "utf-8")) as {
      qualityGate?: { fast: string; full: string };
    };
    expect(saved.qualityGate).toEqual({ fast: "pnpm tsc --noEmit", full: "pnpm tsc --noEmit" });
  });
});
