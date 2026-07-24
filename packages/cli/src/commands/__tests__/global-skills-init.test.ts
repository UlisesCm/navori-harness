import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same @clack/prompts mock pattern as src/__tests__/interactive-flows.test.ts:
// queueAnswers() feeds select/confirm/multiselect answers in call order.
const clk = vi.hoisted(() => ({ queue: [] as unknown[], CANCEL: Symbol("clack-cancel") }));

vi.mock("@clack/prompts", () => {
  const dequeue = async () => clk.queue.shift();
  return {
    select: vi.fn(dequeue),
    confirm: vi.fn(dequeue),
    text: vi.fn(dequeue),
    multiselect: vi.fn(dequeue),
    isCancel: (v: unknown) => v === clk.CANCEL,
    note: vi.fn(),
    intro: vi.fn(),
    outro: vi.fn(),
    cancel: vi.fn(),
    log: { message: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn(), error: vi.fn(), step: vi.fn() },
  };
});

const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("../../lib/home.ts", () => ({
  safeHomedir: () => home.dir,
  globalConfigDir: () => process.env.CLAUDE_CONFIG_DIR || join(home.dir, ".claude"),
}));

// Auto-install pass must never touch a real installer in these tests.
vi.mock("../../lib/install-tool.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/install-tool.ts")>();
  return {
    ...actual,
    installExternalTool: vi.fn(async (tool: { name: string }) => ({
      tool: tool.name,
      status: "already-present" as const,
    })),
  };
});

import * as p from "@clack/prompts";
const { initSubCommand } = await import("../global.ts");
const { GlobalConfigSchema, readGlobalConfig, writeGlobalConfig, globalConfigPath } = await import(
  "../../lib/global-config.ts"
);
const { listGlobalSkillIds } = await import("../../lib/global-skills.ts");

const CANCEL = clk.CANCEL;
function queueAnswers(...answers: unknown[]): void {
  clk.queue.length = 0;
  clk.queue.push(...answers);
}

let claudeDir: string;
const savedEnv = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
  vi.clearAllMocks();
  clk.queue.length = 0;
  home.dir = mkdtempSync(join(tmpdir(), "global-skills-init-home-"));
  claudeDir = mkdtempSync(join(tmpdir(), "global-skills-init-claude-"));
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
});
afterEach(() => {
  rmSync(home.dir, { recursive: true, force: true });
  rmSync(claudeDir, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedEnv;
});

const runInit = (args: Record<string, unknown>) =>
  (initSubCommand as { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }).run({ args });

describe("global init — skills multiselect (interactive)", () => {
  it("offers every catalog skill as an option, label = id, hint = a non-empty description", async () => {
    // lang=es, plugins=[] (no global plugins configured in this fixture env),
    // skills=[] (decline all), permissions=true.
    queueAnswers("es", [], [], true);
    await runInit({ apply: false, recommended: false, yes: false, install: false });

    const call = vi.mocked(p.multiselect).mock.calls.find(
      (c) => (c[0] as { message: string }).message.toLowerCase().includes("skill"),
    );
    expect(call).toBeDefined();
    const options = call![0].options as Array<{ value: string; label: string; hint?: string }>;
    const ids = listGlobalSkillIds();
    expect(options.map((o) => o.value).sort()).toEqual([...ids].sort());
    for (const opt of options) {
      expect(opt.label).toBe(opt.value); // label = the skill id
      expect(opt.hint, opt.value).toBeTruthy(); // non-empty description hint
      expect(opt.hint!.length).toBeLessThanOrEqual(91);
    }
  });

  it("a non-recommended run with an empty skills selection installs none", async () => {
    queueAnswers("es", [], [], true);
    await runInit({ apply: true, recommended: false, yes: false, install: false });
    const config = readGlobalConfig();
    expect(config).not.toBeNull();
    for (const [, entry] of Object.entries(config!.skills)) {
      expect(entry.enabled).toBe(false);
    }
    expect(existsSync(join(claudeDir, "skills", "verify-before-done"))).toBe(false);
  });

  it("a non-recommended run selecting two skills enables exactly those two", async () => {
    queueAnswers("es", [], ["pr-create", "ship-docs"], true);
    await runInit({ apply: true, recommended: false, yes: false, install: false });
    const config = readGlobalConfig();
    expect(config?.skills["pr-create"]?.enabled).toBe(true);
    expect(config?.skills["ship-docs"]?.enabled).toBe(true);
    expect(config?.skills["loop-back-debug"]?.enabled).toBe(false);
    expect(existsSync(join(claudeDir, "skills", "pr-create", "SKILL.md"))).toBe(true);
    expect(existsSync(join(claudeDir, "skills", "loop-back-debug"))).toBe(false);
  });

  it("cancelling the skills prompt aborts like the other prompts", async () => {
    queueAnswers("es", [], CANCEL);
    await runInit({ apply: true, recommended: false, yes: false, install: false });
    expect(existsSync(globalConfigPath())).toBe(false);
  });
});

describe("global init — --recommended enables the full skills catalog", () => {
  it("first-time recommended run enables every catalog skill", async () => {
    await runInit({ apply: true, recommended: true, yes: false, install: false });
    const config = readGlobalConfig();
    const ids = listGlobalSkillIds();
    for (const id of ids) {
      expect(config?.skills[id]?.enabled, id).toBe(true);
    }
    for (const id of ids) {
      expect(existsSync(join(claudeDir, "skills", id, "SKILL.md")), id).toBe(true);
    }
  });
});

describe("global init — unknown skill id handling (mirrors plugins: strip on re-init)", () => {
  it("a stale/unknown skill id from a prior config is dropped on the next --recommended apply", async () => {
    writeGlobalConfig(
      GlobalConfigSchema.parse({
        language: "es",
        skills: { "not-a-real-skill": { enabled: true }, "pr-create": { enabled: true } },
      }),
    );
    await runInit({ apply: true, recommended: true, yes: false, install: false });
    const raw = JSON.parse(readFileSync(globalConfigPath(), "utf-8")) as { skills: Record<string, unknown> };
    expect(raw.skills["not-a-real-skill"]).toBeUndefined();
    expect(raw.skills["pr-create"]).toBeDefined();
  });
});
