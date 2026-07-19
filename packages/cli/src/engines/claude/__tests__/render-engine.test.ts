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
    auditor: false,
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
  it("creates CLAUDE.md, .claude/settings.json, 8 agents, 2 skills, qg hook", () => {
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
      ".claude/agents/auditor.md",
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

  it("writes CLAUDE.md last so a mid-loop crash leaves it intact (#71 item 10)", () => {
    const r = renderClaudeEngine(cwd, CONFIG_FULL);
    // The write loop is atomic per-file but not transactional; CLAUDE.md is the
    // file the user reads, so it must be the final write of the batch.
    expect(r.written.length).toBeGreaterThan(1);
    expect(r.written.at(-1)?.path).toBe("CLAUDE.md");
    // ...and every .claude/ file is written before it.
    const claudeMdIdx = r.written.findIndex((w) => w.path === "CLAUDE.md");
    const lastDotClaudeIdx = r.written.map((w) => w.path).reduce((acc, p, i) => (p.startsWith(".claude/") ? i : acc), -1);
    expect(lastDotClaudeIdx).toBeLessThan(claudeMdIdx);
  });

  it("settings.json carries the $navori marker and the qg hook", () => {
    renderClaudeEngine(cwd, CONFIG_FULL);
    const settings = JSON.parse(readFileSync(join(cwd, ".claude/settings.json"), "utf-8"));
    expect(settings.$navori.managed).toBe(true);
    const pre = settings.hooks.PreToolUse as Array<{ matcher: string; hooks: Array<{ command: string }> }>;
    const guard = pre.find((b) => b.hooks.some((h) => h.command.includes("guard-destructive.sh")));
    expect(guard?.matcher).toBe("Bash");
    const qg = pre.find((b) => b.hooks.some((h) => h.command.includes("quality-gate-pre-commit.sh")));
    expect(qg?.matcher).toBe("Bash");
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

describe("renderClaudeEngine — settings.json coexist injection (DT-2 / #69)", () => {
  it("injects navori's defensive layers into a non-owned settings.json, preserving user keys", () => {
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(
      join(cwd, ".claude/settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }, null, 2),
      "utf-8",
    );

    const r = renderClaudeEngine(cwd, CONFIG_FULL);
    const settings = JSON.parse(readFileSync(join(cwd, ".claude/settings.json"), "utf-8"));

    // The user's own permission is preserved.
    expect(settings.permissions.allow).toContain("Bash(ls)");
    // The guard hook is now actually registered (was written-but-dead before).
    const commands = (settings.hooks.PreToolUse as Array<{ hooks: Array<{ command: string }> }>)
      .flatMap((e) => e.hooks)
      .map((h) => h.command);
    expect(commands).toContain("bash .claude/hooks/guard-destructive.sh");
    // deny/ask defensive rules injected.
    expect(settings.permissions.deny).toContain("Bash(rm -rf /)");
    // navori tracks what it injected but does NOT claim ownership.
    expect(settings.$navori.managed).toBeUndefined();
    expect(settings.$navori.managedHooks.length).toBeGreaterThan(0);
    // It is reported as written (updated), not skipped.
    expect(r.skipped.some((s) => s.path === ".claude/settings.json")).toBe(false);
    expect(r.written.some((w) => w.path === ".claude/settings.json")).toBe(true);
  });

  it("is idempotent — a second render of the injected file is a no-op", () => {
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(
      join(cwd, ".claude/settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }, null, 2),
      "utf-8",
    );
    renderClaudeEngine(cwd, CONFIG_FULL);
    const afterFirst = readFileSync(join(cwd, ".claude/settings.json"), "utf-8");
    const r2 = renderClaudeEngine(cwd, CONFIG_FULL);
    expect(readFileSync(join(cwd, ".claude/settings.json"), "utf-8")).toBe(afterFirst);
    expect(r2.written.some((w) => w.path === ".claude/settings.json")).toBe(false);
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
    //   1 CLAUDE.md + 1 settings.json + 8 agents + 3 core skills + 3 workflow
    //   skills (ticket-intake, pr-create, spec-bootstrap) + 1 guard hook +
    //   1 qg hook + 2 progress files + 1 engram-leader-extension sub-block = 21.
    //   The SDD managed block renders into CLAUDE.md (already counted as 1 file).
    expect(first.inspected).toBe(21);
    // Written counts files actually emitted. engram-leader-extension is a
    // sub-block injected into leader.md, not a separate file, so written = 20.
    expect(first.written.length).toBe(20);

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
    // Dry-run still reports the would-write set: the full 20 files
    // (19 + auditor agent).
    expect(r.written).toHaveLength(20);
    expect(r.written.every((w) => w.status === "created")).toBe(true);
    expect(existsSync(join(cwd, ".claude/agents/leader.md"))).toBe(false);
    expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(false);
  });
});

describe("renderClaudeEngine — prTarget in the commit-pr-pilot agent", () => {
  const pilotPath = () => join(cwd, ".claude/agents/commit-pr-pilot.md");

  it("falls back to branchBase for --base when prTarget is unset", () => {
    renderClaudeEngine(cwd, CONFIG_FULL); // branchBase "main", no prTarget
    const agent = readFileSync(pilotPath(), "utf-8");
    expect(agent).toContain("--base main");
    expect(agent).not.toContain("{{prTarget}}");
  });

  it("uses the explicit prTarget for --base", () => {
    const cfg = { ...CONFIG_FULL, prTarget: "develop" } as unknown as NavoriConfig;
    renderClaudeEngine(cwd, cfg);
    const agent = readFileSync(pilotPath(), "utf-8");
    expect(agent).toContain("--base develop");
    expect(agent).not.toContain("--base main");
  });
});

describe("renderClaudeEngine — language-aware baseline (tipado-fuerte)", () => {
  const claudeMd = () => readFileSync(join(cwd, "CLAUDE.md"), "utf-8");
  const withLang = (codeLanguage: string) =>
    ({ ...CONFIG_FULL, project: { codeLanguage } }) as unknown as NavoriConfig;

  it("renders tipado-fuerte for a TS repo", () => {
    renderClaudeEngine(cwd, withLang("ts"));
    expect(claudeMd()).toContain("Tipado fuerte");
  });

  it("suppresses tipado-fuerte for a Python repo", () => {
    renderClaudeEngine(cwd, withLang("python"));
    const md = claudeMd();
    expect(md).not.toContain("Tipado fuerte");
    expect(md).not.toContain('id="tipado-fuerte"');
  });

  it("renders tipado-fuerte when codeLanguage is absent (back-compat)", () => {
    renderClaudeEngine(cwd, CONFIG_FULL); // no project.codeLanguage
    expect(claudeMd()).toContain("Tipado fuerte");
  });
});

describe("renderClaudeEngine — SDD managed block + scaffolder", () => {
  const claudeMd = () => readFileSync(join(cwd, "CLAUDE.md"), "utf-8");

  it("renders the SDD block by default (sdd absent → enabled defaults true)", () => {
    renderClaudeEngine(cwd, CONFIG_FULL); // no sdd section
    const md = claudeMd();
    expect(md).toContain('id="sdd"');
    expect(md).toContain("Spec Driven Development (SDD)");
    expect(md).toContain("EARS");
    expect(md).toContain("Covers: R");
  });

  it("suppresses the SDD block when sdd.enabled is false", () => {
    const cfg = { ...CONFIG_FULL, sdd: { enabled: false } } as unknown as NavoriConfig;
    renderClaudeEngine(cwd, cfg);
    const md = claudeMd();
    expect(md).not.toContain('id="sdd"');
    expect(md).not.toContain("Spec Driven Development (SDD)");
  });

  it("interpolates specsDir — defaults to 'specs'", () => {
    renderClaudeEngine(cwd, CONFIG_FULL);
    expect(claudeMd()).toContain("specs/<feature>/");
  });

  it("interpolates a custom specsDir", () => {
    const cfg = { ...CONFIG_FULL, sdd: { enabled: true, specsDir: "docs/specs" } } as unknown as NavoriConfig;
    renderClaudeEngine(cwd, cfg);
    expect(claudeMd()).toContain("docs/specs/<feature>/");
  });

  it("writes the spec-bootstrap scaffolder skill", () => {
    renderClaudeEngine(cwd, CONFIG_FULL);
    expect(existsSync(join(cwd, ".claude/skills/spec-bootstrap.md"))).toBe(true);
  });
});

describe("renderClaudeEngine — canonical block order", () => {
  const blockIds = (md: string): string[] =>
    [...md.matchAll(/<!-- navori:managed id="([^"]+)"/g)].map((m) => m[1]!);

  /** Splice a managed block out and re-append it at the end — reproduces the
   * pre-fix state where injectManagedSection appended a new block last. */
  const moveBlockToEnd = (md: string, id: string): string => {
    const open = md.match(new RegExp(`<!-- navori:managed id="${id}"[^>]*-->`))!;
    const close = `<!-- /navori:managed id="${id}" -->`;
    const start = open.index!;
    const end = md.indexOf(close, start) + close.length;
    const block = md.slice(start, end);
    const rest = (md.slice(0, start) + md.slice(end)).replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
    return `${rest.trimEnd()}\n\n${block}\n`;
  };

  it("puts the orchestrator block first on a fresh render", () => {
    renderClaudeEngine(cwd, CONFIG_FULL);
    expect(blockIds(readFileSync(join(cwd, "CLAUDE.md"), "utf-8"))[0]).toBe("orquestacion");
  });

  it("restores a hand-moved orchestrator block to the front on re-render", () => {
    renderClaudeEngine(cwd, CONFIG_FULL);
    const path = join(cwd, "CLAUDE.md");
    const disordered = moveBlockToEnd(readFileSync(path, "utf-8"), "orquestacion");
    expect(blockIds(disordered)[0]).not.toBe("orquestacion"); // sanity: now last
    writeFileSync(path, disordered);

    renderClaudeEngine(cwd, CONFIG_FULL);
    expect(blockIds(readFileSync(path, "utf-8"))[0]).toBe("orquestacion");
  });

  it("is idempotent — an already-ordered file re-renders unchanged", () => {
    renderClaudeEngine(cwd, CONFIG_FULL);
    const path = join(cwd, "CLAUDE.md");
    const first = readFileSync(path, "utf-8");
    const r = renderClaudeEngine(cwd, CONFIG_FULL);
    expect(r.written.some((w) => w.path === "CLAUDE.md")).toBe(false); // no rewrite
    expect(readFileSync(path, "utf-8")).toBe(first);
  });
});
