import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NavoriConfigSchema } from "../../../lib/config/schema.ts";
import { renderAgentsMdEngine } from "../../agents-md/index.ts";
import { renderCodexEngine } from "../../codex/index.ts";
import { renderPiEngine } from "../index.ts";

/**
 * #1512 + spec 0064: without Codex, Pi writes the AGENTS.md and `.agents/skills` doctrine Codex
 * wrote for it, in Pi's vocabulary, plus the project rules risk routing reads. The orchestrator
 * layer (orchestration, plan tiers, session start, agent catalog) moves to the parent-only
 * `.pi/navori/orchestrator.md`. Codex-only lines stay out of both.
 */
const dirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "navori-pi-agents-md-"));
  dirs.push(dir);
  return dir;
}
function cfg(engines: string[], harness: Record<string, boolean> = {}) {
  return NavoriConfigSchema.parse({
    name: "pi-agents-md",
    preset: "custom",
    engines,
    branchBase: "main",
    qualityGate: { fast: "bun test", full: "bun test" },
    harness: { planTiers: true, scribeOwnsMarkdown: true, ...harness },
    project: { criticalAreas: ["billing writes", "edits to CLAUDE.md"] },
  });
}
const read = (dir: string, rel: string): string => readFileSync(join(dir, rel), "utf-8");

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Pi writes the Codex AGENTS.md doctrine when Codex is off (#1512)", () => {
  it("splits the orchestrator layer into the parent-only file and keeps the project context", () => {
    const dir = freshDir();
    renderPiEngine(dir, cfg(["claude", "pi"]));
    const agents = read(dir, "AGENTS.md");
    const orchestrator = read(dir, ".pi/navori/orchestrator.md");

    for (const layer of [
      "## Role: orchestrator (route by risk)",
      "## Planning tiers",
      "`navori_subagent(role: orchestrator)`",
      "- `implementer` — ",
      "- `scribe` — ",
    ]) {
      expect(agents, layer).not.toContain(layer);
      expect(orchestrator, layer).toContain(layer);
    }
    expect(orchestrator).toContain("`navori_subagent` calls");
    expect(orchestrator).toContain("(`billing writes, edits to CLAUDE.md`)");
    expect(orchestrator).not.toContain("edits to AGENTS.md");
    // The project context and the workflow stay in AGENTS.md, with the user's config text verbatim.
    expect(agents).toContain("billing writes");
    expect(agents).toContain("## Workflow");
    expect(agents).not.toContain("## Available skills");
    const manifest = JSON.parse(read(dir, ".pi/navori.json")) as { ownedPaths: string[] };
    expect(manifest.ownedPaths).toContain(".pi/navori/orchestrator.md");
  });

  it("moves the master-plan block to the parent-only file when masterPlan is on", () => {
    const dir = freshDir();
    renderPiEngine(dir, cfg(["claude", "pi"], { masterPlan: true }));

    expect(read(dir, ".pi/navori/orchestrator.md")).toContain("## Master plan");
    expect(read(dir, "AGENTS.md")).not.toContain("## Master plan");
  });

  it("drops every Codex-only line and every Claude path Pi cannot read", () => {
    const dir = freshDir();
    renderPiEngine(dir, cfg(["claude", "pi"]));
    const agents = `${read(dir, "AGENTS.md")}\n${read(dir, ".pi/navori/orchestrator.md")}`;

    for (const codexOnly of [
      "spawn_agent",
      "send_input",
      ".codex/",
      "Codex execution checkpoints",
      "dispatch_<feature>.json",
      "Codex: the plan-gate denies",
      "Codex 0.162.1 only",
    ])
      expect(agents, codexOnly).not.toContain(codexOnly);
    for (const claudeOnly of [
      "SendMessage",
      "Claude serializes",
      ".claude/agents/orchestrator.md",
      ".claude/skills/",
    ])
      expect(agents, claudeOnly).not.toContain(claudeOnly);
  });

  it("renders .agents/skills with Pi's skill command and no Claude-only tools", () => {
    const dir = freshDir();
    renderPiEngine(dir, cfg(["claude", "pi"]));

    expect(read(dir, ".agents/skills/spec-bootstrap/SKILL.md")).toContain(
      "`/skill:spec-bootstrap`",
    );
    const masterPlan = read(dir, ".agents/skills/master-plan/SKILL.md");
    expect(masterPlan).toContain("`/skill:master-plan`");
    expect(masterPlan).not.toContain("AskUserQuestion");
    expect(read(dir, ".agents/skills/context-intake/SKILL.md")).toContain("`/skill:master-plan`");
    expect(read(dir, ".agents/skills/verify-before-done/SKILL.md")).not.toContain("Monitor");
  });

  it("keeps Codex the only AGENTS.md writer when it is enabled", () => {
    const dir = freshDir();
    const config = cfg(["claude", "codex", "pi"]);
    renderCodexEngine(dir, config);
    const before = read(dir, "AGENTS.md");
    const result = renderPiEngine(dir, config);

    expect(result.written.map((w) => w.path)).not.toContain("AGENTS.md");
    expect(read(dir, "AGENTS.md")).toBe(before);
    expect(before).toContain("spawn_agent");
    // Codex owns the layer: Pi writes no orchestrator file and does not list it as owned.
    expect(existsSync(join(dir, ".pi/navori/orchestrator.md"))).toBe(false);
    const manifest = JSON.parse(read(dir, ".pi/navori.json")) as { ownedPaths: string[] };
    expect(manifest.ownedPaths).not.toContain(".pi/navori/orchestrator.md");
  });

  it("retires Pi's own orchestrator file when Codex takes over AGENTS.md, and keeps a foreign one", () => {
    const dir = freshDir();
    renderPiEngine(dir, cfg(["claude", "pi"]));
    const file = join(dir, ".pi/navori/orchestrator.md");
    expect(existsSync(file)).toBe(true);
    renderPiEngine(dir, cfg(["claude", "codex", "pi"]));
    expect(existsSync(file)).toBe(false);

    const foreign = freshDir();
    mkdirSync(join(foreign, ".pi/navori"), { recursive: true });
    writeFileSync(join(foreign, ".pi/navori/orchestrator.md"), "mine\n");
    renderPiEngine(foreign, cfg(["claude", "codex", "pi"]));
    expect(readFileSync(join(foreign, ".pi/navori/orchestrator.md"), "utf-8")).toBe("mine\n");
  });

  it("writes the parent-only orchestrator file with agents-md and no codex, never into AGENTS.md", () => {
    const dir = freshDir();
    const config = cfg(["claude", "pi", "agents-md"]);
    renderAgentsMdEngine(dir, config);
    renderPiEngine(dir, config);

    expect(read(dir, ".pi/navori/orchestrator.md")).toContain(
      "## Role: orchestrator (route by risk)",
    );
    const manifest = JSON.parse(read(dir, ".pi/navori.json")) as { ownedPaths: string[] };
    expect(manifest.ownedPaths).toContain(".pi/navori/orchestrator.md");
    expect(read(dir, "AGENTS.md")).not.toContain("Role: orchestrator");
  });

  it("writes no orchestrator file when codex joins agents-md, retiring Pi's own, keeping a foreign one", () => {
    const dir = freshDir();
    renderPiEngine(dir, cfg(["claude", "pi", "agents-md"]));
    const file = join(dir, ".pi/navori/orchestrator.md");
    expect(existsSync(file)).toBe(true);
    renderPiEngine(dir, cfg(["claude", "codex", "pi", "agents-md"]));
    expect(existsSync(file)).toBe(false);

    const foreign = freshDir();
    mkdirSync(join(foreign, ".pi/navori"), { recursive: true });
    writeFileSync(join(foreign, ".pi/navori/orchestrator.md"), "mine\n");
    renderPiEngine(foreign, cfg(["claude", "codex", "pi", "agents-md"]));
    expect(readFileSync(join(foreign, ".pi/navori/orchestrator.md"), "utf-8")).toBe("mine\n");
  });
});
