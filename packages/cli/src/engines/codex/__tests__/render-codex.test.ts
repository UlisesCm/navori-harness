import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { NavoriConfigSchema, type NavoriConfig } from "../../../lib/schema.ts";
import { renderCodexEngine } from "../index.ts";

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "navori-codex-"));
}

function config(overrides: Partial<NavoriConfig> = {}): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "codex-demo",
    engines: ["codex"],
    preset: "custom",
    branchBase: "main",
    qualityGate: { fast: "pnpm test", full: "pnpm test" },
    plugins: { engram: { enabled: true } },
    models: { implementer: "sonnet", reviewer: "haiku" },
    effort: { implementer: "high", reviewer: "medium" },
    ...overrides,
  });
}

describe("renderCodexEngine", () => {
  it("creates a full Codex harness using the v0.145 project paths", () => {
    const cwd = tempRepo();
    const result = renderCodexEngine(cwd, config());

    expect(result.written.length).toBeGreaterThan(10);
    const agentsMd = readFileSync(join(cwd, "AGENTS.md"), "utf-8");
    expect(agentsMd).toContain("orquest");
    expect(agentsMd).toContain("## Agentes disponibles");
    expect(agentsMd).toContain("`spawn_agent`");
    expect(agentsMd).not.toContain("CLAUDE.md");
    expect(agentsMd).not.toContain(".claude/agents");
    expect(existsSync(join(cwd, ".agents/skills/verify-before-done/SKILL.md"))).toBe(true);
    expect(existsSync(join(cwd, ".agents/skills/structural-search/SKILL.md"))).toBe(true);
    expect(existsSync(join(cwd, ".codex/agents/implementer.toml"))).toBe(true);
    expect(existsSync(join(cwd, ".codex/hooks/guard-destructive.sh"))).toBe(true);

    const toml = readFileSync(join(cwd, ".codex/config.toml"), "utf-8");
    expect(toml).not.toContain("[agents.");
    expect(toml).not.toContain("config_file");
    expect(readFileSync(join(cwd, ".codex/agents/implementer.toml"), "utf-8")).toContain(
      'name = "implementer"',
    );
    expect(toml).toContain('[mcp_servers."engram"]');
    expect(toml).toContain('args = ["mcp", "--tools=agent"]');
    expect(toml).toContain("[[hooks.PreToolUse]]");
    expect(agentsMd).toContain("topic_key");

    const implementer = readFileSync(join(cwd, ".codex/agents/implementer.toml"), "utf-8");
    expect(implementer).toContain('model = "gpt-5.6-terra"');
    expect(implementer).toContain('model_reasoning_effort = "high"');
    expect(implementer).toContain("AGENTS.md");
    expect(implementer).not.toContain("CLAUDE.md");
    expect(implementer).not.toContain(".claude/progress");
    expect(existsSync(join(cwd, ".codex/agents/leader.toml"))).toBe(false);
    expect(readFileSync(join(cwd, ".codex/agents/reviewer.toml"), "utf-8")).toContain(
      'sandbox_mode = "read-only"',
    );
  });

  it("models.codexMap overrides the built-in tier→model map, tier by tier (M3)", () => {
    const cwd = tempRepo();
    // implementer=sonnet, reviewer=haiku (from config()); override only sonnet.
    renderCodexEngine(
      cwd,
      config({
        models: { implementer: "sonnet", reviewer: "haiku", codexMap: { sonnet: "gpt-6-custom" } },
      }),
    );
    const implementer = readFileSync(join(cwd, ".codex/agents/implementer.toml"), "utf-8");
    expect(implementer).toContain('model = "gpt-6-custom"');
    // haiku has no override → falls back to the built-in default.
    const reviewer = readFileSync(join(cwd, ".codex/agents/reviewer.toml"), "utf-8");
    expect(reviewer).toContain('model = "gpt-5.6-luna"');
  });

  it("is byte-idempotent and preserves user-owned config/guidance", () => {
    const cwd = tempRepo();
    renderCodexEngine(cwd, config());
    const agentsPath = join(cwd, "AGENTS.md");
    const configPath = join(cwd, ".codex/config.toml");
    writeFileSync(agentsPath, `${readFileSync(agentsPath, "utf-8")}\n## Mi dominio\nNo borrar.\n`);
    writeFileSync(
      configPath,
      `${readFileSync(configPath, "utf-8")}\nmodel = "custom-user-model"\n`,
    );

    const beforeAgents = readFileSync(agentsPath, "utf-8");
    const beforeConfig = readFileSync(configPath, "utf-8");
    const result = renderCodexEngine(cwd, config());

    expect(result.written).toEqual([]);
    expect(readFileSync(agentsPath, "utf-8")).toBe(beforeAgents);
    expect(readFileSync(configPath, "utf-8")).toBe(beforeConfig);
  });

  it("dry-run reports files without writing them", () => {
    const cwd = tempRepo();
    const result = renderCodexEngine(cwd, config(), { dryRun: true });
    expect(result.written.some(({ path }) => path === "AGENTS.md")).toBe(true);
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(cwd, ".codex"))).toBe(false);
  });

  it("reconciles disabled managed agents, skills, and hooks without deleting user or newer files", () => {
    const cwd = tempRepo();
    renderCodexEngine(
      cwd,
      config({
        project: { libraries: ["zod-validation"] },
      }),
    );

    const userAgent = join(cwd, ".codex/agents/my-agent.toml");
    writeFileSync(userAgent, 'name = "my-agent"\n');
    const newerReviewer = join(cwd, ".codex/agents/reviewer.toml");
    writeFileSync(
      newerReviewer,
      readFileSync(newerReviewer, "utf-8").replace(/version="[^"]+"/, 'version="99.0.0"'),
    );
    const userSkillDir = join(cwd, ".agents/skills/my-skill");
    mkdirSync(userSkillDir, { recursive: true });
    writeFileSync(join(userSkillDir, "SKILL.md"), "# My skill\n");

    const reduced = config({
      harness: { implementer: false, reviewer: false },
      qualityGate: undefined,
      project: { libraries: [] },
    });
    const preview = renderCodexEngine(cwd, reduced, { dryRun: true });

    expect(
      preview.written.some(
        ({ path, status }) =>
          path === ".codex/agents/implementer.toml" && status === "removed-condition-false",
      ),
    ).toBe(true);
    expect(existsSync(join(cwd, ".codex/agents/implementer.toml"))).toBe(true);

    renderCodexEngine(cwd, reduced);

    expect(existsSync(join(cwd, ".codex/agents/implementer.toml"))).toBe(false);
    expect(existsSync(join(cwd, ".agents/skills/zod-validation"))).toBe(false);
    expect(existsSync(join(cwd, ".codex/hooks/quality-gate-pre-commit.sh"))).toBe(false);
    expect(existsSync(newerReviewer)).toBe(true);
    expect(existsSync(userAgent)).toBe(true);
    expect(existsSync(join(userSkillDir, "SKILL.md"))).toBe(true);
  });
});
