import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { NavoriConfigSchema, type NavoriConfig } from "../../../lib/schema.ts";
import { renderClaudeEngine } from "../../claude/index.ts";
import { renderCodexEngine } from "../index.ts";

/**
 * Spec 0009 — the `codegraph` plugin registers an MCP server + external tool +
 * a managed protocol block + a skill sub-block injected into `structural-search`.
 * The skill→skill injectInto must land on BOTH engines (the Codex parity fix:
 * before this, Codex only handled skill→agent injectInto).
 */
function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "navori-cg-"));
}
function config(engines: string[]): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "cg-demo",
    engines,
    preset: "custom",
    branchBase: "main",
    qualityGate: { fast: "pnpm tsc", full: "pnpm test" },
    plugins: { codegraph: { enabled: true } },
  });
}

describe("codegraph plugin — Claude render", () => {
  it("wires the MCP permission, the protocol block and the structural-search sub-block", () => {
    const cwd = tempRepo();
    renderClaudeEngine(cwd, config(["claude"]));

    const settings = JSON.parse(readFileSync(join(cwd, ".claude/settings.json"), "utf-8"));
    expect(settings.permissions.allow).toContain("mcp__codegraph__*");

    // The managed protocol block renders into the always-on CLAUDE.md.
    expect(readFileSync(join(cwd, "CLAUDE.md"), "utf-8")).toContain("CodeGraph");

    // The skill sub-block is injected into the structural-search skill.
    const skill = readFileSync(join(cwd, ".claude/skills/structural-search/SKILL.md"), "utf-8");
    expect(skill).toContain('id="codegraph-search-extension"');
    expect(skill).toContain("Rung -1");
  });
});

describe("codegraph plugin — Codex render (skill→skill injectInto parity)", () => {
  it("wires the MCP server in config.toml and injects the sub-block into the Codex skill", () => {
    const cwd = tempRepo();
    renderCodexEngine(cwd, config(["codex"]));

    const toml = readFileSync(join(cwd, ".codex/config.toml"), "utf-8");
    expect(toml).toContain('[mcp_servers."codegraph"]');

    expect(readFileSync(join(cwd, "AGENTS.md"), "utf-8")).toContain("CodeGraph");

    // The parity fix: the sub-block lands on `.agents/skills/<id>/SKILL.md`,
    // adapted to Codex (no `.claude/` paths leak into the injected content).
    const skill = readFileSync(join(cwd, ".agents/skills/structural-search/SKILL.md"), "utf-8");
    expect(skill).toContain('id="codegraph-search-extension"');
    expect(skill).toContain("Rung -1");
  });

  // #211: disabling codegraph (what `navori remove` does in phase 1, BEFORE it
  // drops the config key) must strip the injected sub-block from the Codex skill.
  // Without the disabled-plugin reconciliation the sub-block orphans forever.
  it("strips the injected sub-block when the plugin is disabled", () => {
    const cwd = tempRepo();
    const skillPath = join(cwd, ".agents/skills/structural-search/SKILL.md");

    renderCodexEngine(cwd, config(["codex"]));
    expect(readFileSync(skillPath, "utf-8")).toContain('id="codegraph-search-extension"');

    // Mirror `navori remove` phase 1: the entry stays declared as disabled.
    const disabled = NavoriConfigSchema.parse({
      name: "cg-demo",
      engines: ["codex"],
      preset: "custom",
      branchBase: "main",
      qualityGate: { fast: "pnpm tsc", full: "pnpm test" },
      plugins: { codegraph: { enabled: false } },
    });
    renderCodexEngine(cwd, disabled);

    const skill = readFileSync(skillPath, "utf-8");
    expect(skill).not.toContain('id="codegraph-search-extension"');
    expect(skill).not.toContain("Rung -1");
    // The host skill itself survives — only the plugin's sub-block is removed.
    expect(skill).toContain("structural");
  });
});
