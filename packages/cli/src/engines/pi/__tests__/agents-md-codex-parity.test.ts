import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NavoriConfigSchema } from "../../../lib/config/schema.ts";
import { renderCodexEngine } from "../../codex/index.ts";
import { renderPiEngine } from "../index.ts";

/**
 * #1512: without Codex, Pi writes the AGENTS.md and `.agents/skills` doctrine Codex wrote
 * for it (orchestration, agent catalog, plan tiers), in Pi's vocabulary, plus the project
 * rules risk routing reads. Codex-only lines stay out.
 */
const dirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "navori-pi-agents-md-"));
  dirs.push(dir);
  return dir;
}
function cfg(engines: string[]) {
  return NavoriConfigSchema.parse({
    name: "pi-agents-md",
    preset: "custom",
    engines,
    branchBase: "main",
    qualityGate: { fast: "bun test", full: "bun test" },
    harness: { planTiers: true, scribeOwnsMarkdown: true },
    project: { criticalAreas: ["billing writes", "edits to CLAUDE.md"] },
  });
}
const read = (dir: string, rel: string): string => readFileSync(join(dir, rel), "utf-8");

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Pi writes the Codex AGENTS.md doctrine when Codex is off (#1512)", () => {
  it("carries orchestration, the agent catalog and the critical areas in Pi's vocabulary", () => {
    const dir = freshDir();
    renderPiEngine(dir, cfg(["claude", "pi"]));
    const agents = read(dir, "AGENTS.md");

    expect(agents).toContain("## Role: orchestrator (route by risk)");
    expect(agents).toContain("`navori_subagent(role: orchestrator)`");
    expect(agents).toContain("`navori_subagent` calls");
    expect(agents).toContain("## Planning tiers");
    expect(agents).toContain("- `implementer` — ");
    expect(agents).toContain("- `scribe` — ");
    expect(agents).toContain("billing writes");
    // The user's own config text is not run through the Pi adapter, including where it is
    // interpolated into navori's prose (the risk-routing line), not only the appended block.
    expect(agents).toContain("(`billing writes, edits to CLAUDE.md`)");
    expect(agents).not.toContain("edits to AGENTS.md");
    expect(agents).not.toContain("## Available skills");
  });

  it("drops every Codex-only line and every Claude path Pi cannot read", () => {
    const dir = freshDir();
    renderPiEngine(dir, cfg(["claude", "pi"]));
    const agents = read(dir, "AGENTS.md");

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
  });
});
