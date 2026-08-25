import { describe, it, expect } from "vitest";
import { deriveMcpTools, withAgentMcpTools } from "../agent-mcp-tools.ts";
import type { LoadedPlugin } from "../../../lib/plugins.ts";

/**
 * A plugin can only make an agent USE its MCP server if the agent's `tools:`
 * allowlist names it. These cover that third wiring layer — the one no field
 * in the manifest owned, which left researcher/explorer carrying CodeGraph
 * prose they could not act on.
 */

function plugin(id: string, withServer: boolean): LoadedPlugin {
  return {
    manifest: {
      id,
      invariants: [],
      ...(withServer ? { mcpServer: { command: id, args: [] } } : {}),
    },
  } as unknown as LoadedPlugin;
}

const AGENT = ".claude/agents/researcher.md";
const agentFile = (tools: string | null) =>
  [
    "---",
    "name: researcher",
    ...(tools === null ? [] : [`tools: ${tools}`]),
    "model: sonnet",
    "---",
    "",
    "# Researcher",
    "",
  ].join("\n");

describe("deriveMcpTools", () => {
  it("grants the whole server with a pattern, not one entry per tool", () => {
    expect(deriveMcpTools(plugin("codegraph", true))).toEqual(["mcp__codegraph__*"]);
  });

  it("grants nothing for a plugin that ships no server", () => {
    expect(deriveMcpTools(plugin("jscpd", false))).toEqual([]);
  });
});

describe("withAgentMcpTools", () => {
  const codegraph = plugin("codegraph", true);

  it("appends the server pattern to an agent's tools", () => {
    const out = withAgentMcpTools(agentFile("Read, Glob, Grep"), codegraph, AGENT);
    expect(out).toContain("tools: Read, Glob, Grep, mcp__codegraph__*");
  });

  it("leaves a skill target untouched — skills have no allowlist", () => {
    const content = agentFile("Read");
    const target = ".claude/skills/structural-search/SKILL.md";
    expect(withAgentMcpTools(content, codegraph, target)).toBe(content);
  });

  it("leaves a plugin without an MCP server untouched", () => {
    const content = agentFile("Read");
    expect(withAgentMcpTools(content, plugin("jscpd", false), AGENT)).toBe(content);
  });

  it("leaves an agent that declares no tools untouched — it inherits them all", () => {
    const content = agentFile(null);
    expect(withAgentMcpTools(content, codegraph, AGENT)).toBe(content);
  });

  it("is idempotent: a second render does not duplicate the entry", () => {
    const once = withAgentMcpTools(agentFile("Read"), codegraph, AGENT);
    expect(withAgentMcpTools(once, codegraph, AGENT)).toBe(once);
  });

  it("preserves the other frontmatter keys, their order and the body", () => {
    const out = withAgentMcpTools(agentFile("Read"), codegraph, AGENT);
    expect(out.split("\n").slice(0, 5)).toEqual([
      "---",
      "name: researcher",
      "tools: Read, mcp__codegraph__*",
      "model: sonnet",
      "---",
    ]);
    expect(out).toContain("# Researcher");
  });

  it("rewrites the frontmatter even when the body repeats it verbatim", () => {
    // A doc that quotes its own frontmatter would corrupt under a naive
    // whole-file replace; the splice is by offset for exactly this reason.
    const quoted = `${agentFile("Read")}\nExample:\n\`\`\`\nname: researcher\ntools: Read\nmodel: sonnet\n\`\`\`\n`;
    const out = withAgentMcpTools(quoted, codegraph, AGENT);
    expect(out.match(/mcp__codegraph__\*/g)).toHaveLength(1);
    // The quoted copy in the body keeps its original `tools: Read`.
    expect(out).toContain("```\nname: researcher\ntools: Read\nmodel: sonnet\n```");
  });
});
