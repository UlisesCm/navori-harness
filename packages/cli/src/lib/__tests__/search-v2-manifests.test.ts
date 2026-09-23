import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getCoreRoot } from "../render/bundled-assets.ts";
import { loadEnabledPlugins, loadPlugin, PluginManifestSchema } from "../config/plugins.ts";
import { PresetDefinitionSchema } from "../config/presets.ts";
import { NavoriConfigSchema } from "../config/schema.ts";

/**
 * Search v2 P1 — plugin/contract tests for the two new opt-in providers
 * (`codegraph`, `tgrep`). See search-v2.md §7 P1 for the table these map to
 * (M01-M06). Behavior/render wiring (routing text, agent injection, MCP
 * registration in a rendered repo) is P2 scope and lives in
 * search-v2-render.test.ts / search-v2-policy.test.ts, not here.
 */

const codegraph = loadPlugin("codegraph");
const tgrep = loadPlugin("tgrep");

describe("M01 — codegraph/tgrep manifests validate and their assets exist on disk", () => {
  it("both manifests parse against PluginManifestSchema", () => {
    expect(PluginManifestSchema.safeParse(codegraph.manifest).success).toBe(true);
    expect(PluginManifestSchema.safeParse(tgrep.manifest).success).toBe(true);
  });

  it("every managed[].file and skills[].file resolves inside its packageRoot", () => {
    for (const plugin of [codegraph, tgrep]) {
      for (const asset of plugin.managedAssets) {
        expect(existsSync(asset.absPath)).toBe(true);
        expect(asset.absPath.startsWith(plugin.packageRoot)).toBe(true);
      }
      for (const asset of plugin.skillAssets) {
        expect(existsSync(asset.absPath)).toBe(true);
        expect(asset.absPath.startsWith(plugin.packageRoot)).toBe(true);
      }
    }
  });
});

describe("M02 — CodeGraph mcpServer/settingsFragment contract (search-v2.md §3.2)", () => {
  it("args, env and alwaysLoad match the v2 contract", () => {
    expect(codegraph.manifest.mcpServer?.args).toEqual(["serve", "--mcp"]);
    expect(codegraph.manifest.mcpServer?.env).toEqual({
      CODEGRAPH_MCP_TOOLS: "explore",
      CODEGRAPH_EXPLORE_DEDUP: "0",
    });
    expect(codegraph.manifest.mcpServer?.alwaysLoad).toBe(true);
  });

  it("grants exactly the explore tool, nothing broader", () => {
    expect(codegraph.manifest.settingsFragment).toEqual({
      permissions: { allow: ["mcp__codegraph__codegraph_explore"] },
    });
  });

  it("has no hooks, scripts or postInstall (setup/indexing stays explicit — D10/D15)", () => {
    expect(codegraph.manifest.hooks).toBeUndefined();
    expect(codegraph.manifest.scripts).toBeUndefined();
    expect(codegraph.manifest.externalTool?.postInstall).toBeUndefined();
  });
});

describe("M03 — tgrep contract (search-v2.md §3.3)", () => {
  it("has no MCP, hooks, scripts, skills or postInstall", () => {
    expect(tgrep.manifest.mcpServer).toBeUndefined();
    expect(tgrep.manifest.hooks).toBeUndefined();
    expect(tgrep.manifest.scripts).toBeUndefined();
    expect(tgrep.manifest.skills).toBeUndefined();
    expect(tgrep.manifest.externalTool?.postInstall).toBeUndefined();
  });

  it("grants exactly search/status/--version, never a bare wildcard (D08)", () => {
    expect(tgrep.manifest.settingsFragment).toEqual({
      permissions: {
        allow: ["Bash(tgrep search *)", "Bash(tgrep status:*)", "Bash(tgrep --version)"],
      },
    });
  });
});

describe("M04 — CodeGraph's five skill entries (search-v2.md §3.2, spec 0026 T12/T19)", () => {
  const skills = codegraph.manifest.skills ?? [];
  const coreAgentsDir = resolve(getCoreRoot(), "core-assets/agents");
  const knownAgentFiles = new Set(readdirSync(coreAgentsDir));

  // Spec 0026 T12 (R17): the roster shrank from 8 to 6 and the ticket-audit
  // encargo folded into auditor, which already has its own entry — so the
  // injection count dropped from 5 to 4 (orchestrator, implementer, reviewer,
  // auditor). `scout` gets the tool by exact name in its own frontmatter, not
  // by injection (unchanged from researcher/explorer's prior treatment).
  // Spec 0026 T19 (R47) adds `architect` — it needs "what already exists"
  // before proposing, same rationale as `auditor` — bringing the count to 5.
  it("declares exactly 5 entries, each with a distinct injectInto target", () => {
    expect(skills).toHaveLength(5);
    const targets = skills.map((s) => s.injectInto);
    expect(new Set(targets).size).toBe(5);
  });

  it("all 5 entries share the same source file", () => {
    for (const skill of skills) {
      expect(skill.file).toBe("skills/codegraph-access-v2.md");
    }
  });

  it("no entry targets commit-pr-pilot or an agent absent from core-assets/agents", () => {
    for (const skill of skills) {
      expect(skill.injectInto).not.toBe(".claude/agents/commit-pr-pilot.md");
      const match = /^\.claude\/agents\/([a-z-]+\.md)$/.exec(skill.injectInto ?? "");
      expect(match, `unexpected injectInto shape: ${skill.injectInto}`).not.toBeNull();
      const agentFile = match?.[1] ?? "";
      expect(knownAgentFiles.has(agentFile)).toBe(true);
    }
  });

  it("does not target scout — it receives the tool by exact name, not by family (#575/#761, spec 0026 T12)", () => {
    // withAgentMcpTools widens ANY injectInto target to the wildcard family
    // mcp__codegraph__*. scout is the read-only-by-contract role pinned in
    // mcp-capability-wiring.test.ts to receive MCP tools by exact name in its
    // own `tools:` frontmatter, never via injection-driven family grants —
    // see the NO_FAMILY case there.
    const targets = skills.map((s) => s.injectInto);
    expect(targets).not.toContain(".claude/agents/scout.md");
  });
});

describe("M05 — package.json files[] ships only the created manifest/assets", () => {
  it("codegraph package.json declares plugin.json, managed and skills", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(codegraph.packageRoot, "package.json"), "utf-8"),
    ) as { files: string[] };
    expect(pkg.files.sort()).toEqual(["managed", "plugin.json", "skills"]);
  });

  it("tgrep package.json declares plugin.json and managed only (no skills dir)", () => {
    const pkg = JSON.parse(readFileSync(resolve(tgrep.packageRoot, "package.json"), "utf-8")) as {
      files: string[];
    };
    expect(pkg.files.sort()).toEqual(["managed", "plugin.json"]);
    expect(existsSync(resolve(tgrep.packageRoot, "skills"))).toBe(false);
  });
});

describe("M06 — no preset or default config enables codegraph/tgrep", () => {
  it("PresetDefinitionSchema has no plugins field at all — a preset structurally cannot activate one", () => {
    expect(Object.keys(PresetDefinitionSchema.shape)).not.toContain("plugins");
  });

  it("every bundled preset manifest is free of the v2 plugin ids", () => {
    const presetsDir = resolve(getCoreRoot(), "core-assets/presets");
    const presetFiles = readdirSync(presetsDir).filter((f) => f.endsWith(".json"));
    expect(presetFiles.length).toBeGreaterThan(0);
    for (const file of presetFiles) {
      const raw = readFileSync(resolve(presetsDir, file), "utf-8");
      expect(raw).not.toContain("codegraph");
      expect(raw).not.toContain("tgrep");
    }
  });

  it("a config that omits plugins entirely resolves to nothing enabled (schema default)", () => {
    const config = NavoriConfigSchema.parse({
      name: "fx",
      engines: ["claude"],
      preset: "custom",
      branchBase: "main",
      qualityGate: { fast: "pnpm test", full: "pnpm test" },
    });
    expect(config.plugins).toBeUndefined();
    const { loaded, missing } = loadEnabledPlugins(config.plugins);
    expect(loaded).toHaveLength(0);
    expect(missing).toHaveLength(0);
  });
});
