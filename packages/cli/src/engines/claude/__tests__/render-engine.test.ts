import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderClaudeEngine } from "../index.ts";
import type { NavoriConfig } from "../../../lib/config.ts";

const CONFIG_FULL = {
  name: "demo",
  engines: ["claude"],
  preset: "custom",
  version: "1.0.0",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
  qualityGate: { fast: "pnpm typecheck", full: "pnpm test" },
  models: { leader: "opus", implementer: "sonnet" },
  plugins: { engram: { enabled: true } },
} as unknown as NavoriConfig;

const CONFIG_NO_QG = {
  ...CONFIG_FULL,
  qualityGate: undefined,
} as unknown as NavoriConfig;

const CONFIG_HARNESS_FILTERED = {
  ...CONFIG_FULL,
  harness: {
    leader: true,
    implementer: true,
    reviewer: true,
    researcher: false,
    ticketAudit: false,
    commitPrPilot: false,
    explorer: false,
  },
} as unknown as NavoriConfig;

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-engine-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("renderClaudeEngine — first render with full config", () => {
  it("creates CLAUDE.md, .claude/settings.json, 7 agents, 2 skills, qg hook", () => {
    const r = renderClaudeEngine(cwd, CONFIG_FULL);

    expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/settings.json"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/agents/leader.md"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/agents/explorer.md"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/skills/verify-before-done.md"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/skills/loop-back-debug.md"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/hooks/quality-gate-pre-commit.sh"))).toBe(true);

    const agentPaths = r.written.filter((w) => w.path.startsWith(".claude/agents/"));
    expect(agentPaths.map((w) => w.path).sort()).toEqual([
      ".claude/agents/commit-pr-pilot.md",
      ".claude/agents/explorer.md",
      ".claude/agents/implementer.md",
      ".claude/agents/leader.md",
      ".claude/agents/researcher.md",
      ".claude/agents/reviewer.md",
      ".claude/agents/ticket-audit.md",
    ]);
    const claudeMd = r.written.find((w) => w.path === "CLAUDE.md");
    expect(claudeMd?.status).toBe("created");
    const settings = r.written.find((w) => w.path === ".claude/settings.json");
    expect(settings?.status).toBe("created");
  });

  it("settings.json carries the $navori marker and the qg hook", () => {
    renderClaudeEngine(cwd, CONFIG_FULL);
    const settings = JSON.parse(readFileSync(join(cwd, ".claude/settings.json"), "utf-8"));
    expect(settings.$navori.managed).toBe(true);
    expect(settings.hooks.PreToolUse[0].matcher).toBe("Bash");
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("quality-gate-pre-commit.sh");
  });

  it("agent frontmatter interpolates models.X when set, drops it when not", () => {
    renderClaudeEngine(cwd, CONFIG_FULL);
    const leader = readFileSync(join(cwd, ".claude/agents/leader.md"), "utf-8");
    expect(leader).toMatch(/^---[\s\S]+model: opus[\s\S]+?---/);
    // reviewer has no model in CONFIG_FULL — model: line dropped
    const reviewer = readFileSync(join(cwd, ".claude/agents/reviewer.md"), "utf-8");
    expect(reviewer.split("\n---")[0]).not.toMatch(/^model:/m);
  });

  it("hook script gets +x mode and embeds qualityGate.fast", () => {
    renderClaudeEngine(cwd, CONFIG_FULL);
    const hook = readFileSync(join(cwd, ".claude/hooks/quality-gate-pre-commit.sh"), "utf-8");
    expect(hook).toContain("pnpm typecheck");
    expect(hook).toContain('# navori:managed start id="qg-pre-commit-base"');
  });
});

describe("renderClaudeEngine — config gates", () => {
  it("omits qg hook when qualityGate.fast is unset and surfaces a warning", () => {
    const r = renderClaudeEngine(cwd, CONFIG_NO_QG);
    expect(existsSync(join(cwd, ".claude/hooks/quality-gate-pre-commit.sh"))).toBe(false);
    expect(r.warnings.some((w) => w.includes("quality-gate hook skipped"))).toBe(true);
  });

  it("renders only agents enabled in config.harness", () => {
    const r = renderClaudeEngine(cwd, CONFIG_HARNESS_FILTERED);
    const agents = r.written.filter((w) => w.path.startsWith(".claude/agents/"));
    expect(agents.map((a) => a.path)).toEqual([
      ".claude/agents/leader.md",
      ".claude/agents/implementer.md",
      ".claude/agents/reviewer.md",
    ]);
    expect(existsSync(join(cwd, ".claude/agents/researcher.md"))).toBe(false);
  });
});

describe("renderClaudeEngine — idempotency", () => {
  it("second render reports no writes", () => {
    renderClaudeEngine(cwd, CONFIG_FULL);
    const second = renderClaudeEngine(cwd, CONFIG_FULL);
    expect(second.written).toHaveLength(0);
    expect(second.backupPath).toBeNull();
  });
});

describe("renderClaudeEngine — settings.json adoption guard (DT-2)", () => {
  it("skips a pre-existing settings.json that lacks the $navori marker", () => {
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(
      join(cwd, ".claude/settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }, null, 2),
      "utf-8",
    );

    const r = renderClaudeEngine(cwd, CONFIG_FULL);
    const settingsRaw = readFileSync(join(cwd, ".claude/settings.json"), "utf-8");
    // The user file is intact
    expect(settingsRaw).toContain("Bash(ls)");
    expect(settingsRaw).not.toContain("$navori");
    // The skipped list mentions it
    expect(r.skipped.some((s) => s.path === ".claude/settings.json")).toBe(true);
  });
});

describe("renderClaudeEngine — progress bootstrap (E2)", () => {
  it("creates progress/current.md and progress/history.md on first render", () => {
    renderClaudeEngine(cwd, CONFIG_FULL);
    expect(existsSync(join(cwd, "progress/current.md"))).toBe(true);
    expect(existsSync(join(cwd, "progress/history.md"))).toBe(true);
    expect(readFileSync(join(cwd, "progress/current.md"), "utf-8")).toMatch(/Estado.*idle/);
  });

  it("never overwrites a pre-existing progress file (user-owned live state)", () => {
    mkdirSync(join(cwd, "progress"), { recursive: true });
    writeFileSync(join(cwd, "progress/current.md"), "# MY CUSTOM CURRENT\n", "utf-8");
    renderClaudeEngine(cwd, CONFIG_FULL);
    expect(readFileSync(join(cwd, "progress/current.md"), "utf-8")).toBe("# MY CUSTOM CURRENT\n");
  });

  it("respects custom progress paths from config.progress", () => {
    const customConfig = {
      ...CONFIG_FULL,
      progress: {
        dir: "progress",
        currentFile: "now.md",
        historyFile: "log.md",
        checkpointsDir: "progress/checkpoints",
        archiveAfterDays: 30,
      },
    } as unknown as NavoriConfig;
    renderClaudeEngine(cwd, customConfig);
    expect(existsSync(join(cwd, "progress/now.md"))).toBe(true);
    expect(existsSync(join(cwd, "progress/log.md"))).toBe(true);
    expect(existsSync(join(cwd, "progress/current.md"))).toBe(false);
  });
});

describe("renderClaudeEngine — plugin scripts + hooks (F1)", () => {
  it("copies jscpd script with interpolation, +x, and hook in settings", () => {
    const cfg = {
      ...CONFIG_FULL,
      plugins: { jscpd: { enabled: true } },
    } as unknown as NavoriConfig;
    renderClaudeEngine(cwd, cfg);

    const scriptPath = join(cwd, ".claude/scripts/check-jscpd.sh");
    expect(existsSync(scriptPath)).toBe(true);
    const script = readFileSync(scriptPath, "utf-8");
    // {{branchBase}} → "main" interpolated
    expect(script).toContain("git rev-parse --verify main");
    expect(script).not.toContain("{{branchBase}}");

    const settings = JSON.parse(readFileSync(join(cwd, ".claude/settings.json"), "utf-8"));
    const pre = settings.hooks.PreToolUse;
    const jscpdHook = pre.flatMap((entry: { hooks: Array<{ command: string }> }) => entry.hooks)
      .find((h: { command: string }) => h.command.includes("check-jscpd.sh"));
    expect(jscpdHook?.command).toContain(".claude/scripts/check-jscpd.sh");
  });

  it("renders both jscpd and semgrep scripts when both plugins enabled", () => {
    const cfg = {
      ...CONFIG_FULL,
      plugins: { jscpd: { enabled: true }, semgrep: { enabled: true } },
    } as unknown as NavoriConfig;
    renderClaudeEngine(cwd, cfg);

    expect(existsSync(join(cwd, ".claude/scripts/check-jscpd.sh"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/scripts/check-semgrep.sh"))).toBe(true);
  });

  it("does NOT render plugin scripts when plugin is disabled", () => {
    renderClaudeEngine(cwd, CONFIG_FULL); // no jscpd / semgrep in CONFIG_FULL.plugins
    expect(existsSync(join(cwd, ".claude/scripts/check-jscpd.sh"))).toBe(false);
    expect(existsSync(join(cwd, ".claude/scripts/check-semgrep.sh"))).toBe(false);
  });

  it("is idempotent: second render of the same plugin script reports unchanged", () => {
    const cfg = {
      ...CONFIG_FULL,
      plugins: { jscpd: { enabled: true } },
    } as unknown as NavoriConfig;
    renderClaudeEngine(cwd, cfg);
    const second = renderClaudeEngine(cwd, cfg);
    const jscpdWrite = second.written.find((w) => w.path.endsWith("check-jscpd.sh"));
    expect(jscpdWrite).toBeUndefined();
  });
});

describe("renderClaudeEngine — inspected counter + unchanged surface (P0-fix U1+U2)", () => {
  it("reports inspected count on first render and on second", () => {
    const first = renderClaudeEngine(cwd, CONFIG_FULL);
    // Inspected counts every managed asset processed:
    //   1 CLAUDE.md + 1 settings.json + 7 agents + 2 skills + 1 qg hook +
    //   2 progress files + 1 engram-leader-extension sub-block = 15.
    expect(first.inspected).toBe(15);
    // Written counts files actually emitted. engram-leader-extension is a
    // sub-block injected into leader.md, not a separate file, so written = 14.
    expect(first.written.length).toBe(14);

    const second = renderClaudeEngine(cwd, CONFIG_FULL);
    expect(second.written.length).toBe(0);
    // All inspected files were already up to date this second time around.
    expect(second.inspected).toBe(first.inspected);
  });
});

describe("renderClaudeEngine — injectInto warns when target absent (P0-fix U4)", () => {
  it("emits a warning instead of silently dropping the sub-block", () => {
    const cfg = {
      ...CONFIG_FULL,
      plugins: { engram: { enabled: true } },
      harness: {
        leader: false, // target disabled
        implementer: true,
        reviewer: true,
        researcher: false,
        ticketAudit: false,
        commitPrPilot: false,
        explorer: false,
      },
    } as unknown as NavoriConfig;
    const r = renderClaudeEngine(cwd, cfg);
    expect(
      r.warnings.some((w) =>
        /engram-leader-extension.*\.claude\/agents\/leader\.md/.test(w),
      ),
    ).toBe(true);
  });
});

describe("renderClaudeEngine — plugin settingsFragment + injectInto (F2)", () => {
  it("gh plugin merges its allow permissions into settings.json", () => {
    const cfg = {
      ...CONFIG_FULL,
      plugins: { gh: { enabled: true } },
    } as unknown as NavoriConfig;
    renderClaudeEngine(cwd, cfg);

    const settings = JSON.parse(readFileSync(join(cwd, ".claude/settings.json"), "utf-8"));
    const allow: string[] = settings.permissions.allow;
    expect(allow).toContain("Bash(gh pr create*)");
    expect(allow).toContain("Bash(gh issue view*)");
    // Base permissions still present (deep-merge concat)
    expect(allow).toContain("Bash(git status*)");
  });

  it("engram plugin injects a managed sub-block into leader.md", () => {
    const cfg = {
      ...CONFIG_FULL,
      plugins: { engram: { enabled: true } },
    } as unknown as NavoriConfig;
    renderClaudeEngine(cwd, cfg);

    const leader = readFileSync(join(cwd, ".claude/agents/leader.md"), "utf-8");
    expect(leader).toContain('<!-- navori:managed id="engram-leader-extension"');
    expect(leader).toContain("source=\"@navori/plugin-engram\"");
    expect(leader).toContain("mem_search");
    // Base block is still there
    expect(leader).toContain('<!-- navori:managed id="leader-base"');
  });

  it("removes nothing when injectInto target is missing (agent disabled in harness)", () => {
    const cfg = {
      ...CONFIG_FULL,
      plugins: { engram: { enabled: true } },
      harness: {
        leader: false,
        implementer: true,
        reviewer: true,
        researcher: false,
        ticketAudit: false,
        commitPrPilot: false,
        explorer: false,
      },
    } as unknown as NavoriConfig;
    renderClaudeEngine(cwd, cfg);

    expect(existsSync(join(cwd, ".claude/agents/leader.md"))).toBe(false);
    // No crash; settings still rendered
    expect(existsSync(join(cwd, ".claude/settings.json"))).toBe(true);
  });

  it("is idempotent: second render of plugin sub-block reports unchanged", () => {
    const cfg = {
      ...CONFIG_FULL,
      plugins: { engram: { enabled: true } },
    } as unknown as NavoriConfig;
    renderClaudeEngine(cwd, cfg);
    const second = renderClaudeEngine(cwd, cfg);
    const leaderWrite = second.written.find((w) => w.path === ".claude/agents/leader.md");
    expect(leaderWrite).toBeUndefined();
  });
});

describe("renderClaudeEngine — dry-run", () => {
  it("reports the plan without writing anything", () => {
    const r = renderClaudeEngine(cwd, CONFIG_FULL, { dryRun: true });
    // Dry-run still reports the would-write set: the full 14 files.
    expect(r.written).toHaveLength(14);
    expect(r.written.every((w) => w.status === "created")).toBe(true);
    expect(existsSync(join(cwd, ".claude/agents/leader.md"))).toBe(false);
    expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(false);
  });
});
