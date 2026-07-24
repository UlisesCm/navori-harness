import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic on two axes (spec 0005 §6 safety): ~/.navori (global config + backups)
// → throwaway home via the home.ts mock; the render TARGET → a temp
// CLAUDE_CONFIG_DIR. Neither the real $HOME/.claude nor ~/.navori is touched.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("../../lib/home.ts", () => ({
  safeHomedir: () => home.dir,
  globalConfigDir: () => process.env.CLAUDE_CONFIG_DIR || join(home.dir, ".claude"),
}));

// Case (c): the install pass must never execute a real installer. Mock the whole
// install seam so `global init` runs a FAILED install and we assert it stays
// non-fatal (config + CLAUDE.md still written).
vi.mock("../../lib/install-tool.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/install-tool.ts")>();
  return {
    ...actual,
    installExternalTool: vi.fn(async (tool: { name: string }) => ({
      tool: tool.name,
      status: "failed" as const,
      command: "curl … | bash",
      error: "boom",
    })),
  };
});

// Case (e): force every external binary "missing" so the doctor/status scan is
// deterministic regardless of the CI machine's PATH.
vi.mock("../../lib/which.ts", () => ({ hasBinary: () => false }));

const { initSubCommand, statusSubCommand, globalMissingExternalTools } = await import("../global.ts");
const { installExternalTool } = await import("../../lib/install-tool.ts");
const { GlobalConfigSchema, writeGlobalConfig } = await import("../../lib/global-config.ts");

let claudeDir: string;
const savedEnv = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "global-install-home-"));
  claudeDir = mkdtempSync(join(tmpdir(), "global-install-claude-"));
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  vi.mocked(installExternalTool).mockClear();
});
afterEach(() => {
  rmSync(home.dir, { recursive: true, force: true });
  rmSync(claudeDir, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedEnv;
});

const cfg = (over = {}) => GlobalConfigSchema.parse({ language: "es", permissions: true, ...over });

describe("global init — auto-install pass (case c: non-fatal)", () => {
  it("a failed install does NOT prevent the harness from being configured", async () => {
    const runFn = (initSubCommand as { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }).run;
    // --recommended + --apply → headless auto-install (assumeYes, no prompts).
    await runFn({ args: { apply: true, recommended: true, yes: false, install: true } });

    // The install pass ran (engram is a global-scoped plugin with an externalTool)…
    expect(installExternalTool).toHaveBeenCalled();
    // …and it FAILED, yet the config + rendered CLAUDE.md were still written.
    expect(existsSync(join(home.dir, ".navori", "global.json"))).toBe(true);
    expect(existsSync(join(claudeDir, "CLAUDE.md"))).toBe(true);
  });

  it("--no-install skips the pass entirely", async () => {
    const runFn = (initSubCommand as { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }).run;
    await runFn({ args: { apply: true, recommended: true, yes: false, install: false } });
    expect(installExternalTool).not.toHaveBeenCalled();
    expect(existsSync(join(home.dir, ".navori", "global.json"))).toBe(true);
  });
});

describe("global doctor/status — missing external tool report (case e)", () => {
  it("globalMissingExternalTools flags engram when its binary is absent", () => {
    const missing = globalMissingExternalTools(cfg({ plugins: { engram: { enabled: true } } }));
    expect(missing.some((t) => t.pluginId === "engram")).toBe(true);
  });

  it("global status JSON reports the missing-tool count", () => {
    writeGlobalConfig(cfg({ plugins: { engram: { enabled: true } } }));
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => void logs.push(String(m)));
    try {
      (statusSubCommand as { run: (ctx: { args: Record<string, unknown> }) => void }).run({ args: { json: true } });
    } finally {
      spy.mockRestore();
    }
    const parsed = JSON.parse(logs[0] ?? "");
    expect(parsed.configured).toBe(true);
    expect(parsed.missingExternalTools).toBeGreaterThan(0);
  });
});
