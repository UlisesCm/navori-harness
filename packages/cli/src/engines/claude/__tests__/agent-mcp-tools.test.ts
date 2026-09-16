import { describe, it, expect } from "vitest";
import { deriveMcpTools, withAgentMcpTools, withoutAgentMcpTools } from "../agent-mcp-tools.ts";
import type { LoadedPlugin } from "../../../lib/plugins.ts";

/**
 * A plugin can only make an agent USE its MCP server if the agent's `tools:`
 * allowlist names it. These cover that third wiring layer — the one no field in
 * the manifest owned, which left researcher/explorer carrying MCP prose they
 * could not act on.
 *
 * And its inverse: the grant has to come back off when the prose goes away, or
 * `navori remove <plugin>` leaves every agent declaring an allowlist entry for
 * a server nothing registers, which a later re-install then inherits.
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
    expect(deriveMcpTools(plugin("engram", true))).toEqual(["mcp__engram__*"]);
  });

  it("grants nothing for a plugin that ships no server", () => {
    expect(deriveMcpTools(plugin("jscpd", false))).toEqual([]);
  });
});

describe("withAgentMcpTools", () => {
  const engram = plugin("engram", true);

  it("appends the server pattern to an agent's tools", () => {
    const out = withAgentMcpTools(agentFile("Read, Glob, Grep"), engram, AGENT);
    expect(out).toContain("tools: Read, Glob, Grep, mcp__engram__*");
  });

  it("leaves a skill target untouched — skills have no allowlist", () => {
    const content = agentFile("Read");
    const target = ".claude/skills/structural-search/SKILL.md";
    expect(withAgentMcpTools(content, engram, target)).toBe(content);
  });

  it("leaves a plugin without an MCP server untouched", () => {
    const content = agentFile("Read");
    expect(withAgentMcpTools(content, plugin("jscpd", false), AGENT)).toBe(content);
  });

  it("leaves an agent that declares no tools untouched — it inherits them all", () => {
    const content = agentFile(null);
    expect(withAgentMcpTools(content, engram, AGENT)).toBe(content);
  });

  it("is idempotent: a second render does not duplicate the entry", () => {
    const once = withAgentMcpTools(agentFile("Read"), engram, AGENT);
    expect(withAgentMcpTools(once, engram, AGENT)).toBe(once);
  });

  it("preserves the other frontmatter keys, their order and the body", () => {
    const out = withAgentMcpTools(agentFile("Read"), engram, AGENT);
    expect(out.split("\n").slice(0, 5)).toEqual([
      "---",
      "name: researcher",
      "tools: Read, mcp__engram__*",
      "model: sonnet",
      "---",
    ]);
    expect(out).toContain("# Researcher");
  });

  it("rewrites the frontmatter even when the body repeats it verbatim", () => {
    // A doc that quotes its own frontmatter would corrupt under a naive
    // whole-file replace; the splice is by offset for exactly this reason.
    const quoted = `${agentFile("Read")}\nExample:\n\`\`\`\nname: researcher\ntools: Read\nmodel: sonnet\n\`\`\`\n`;
    const out = withAgentMcpTools(quoted, engram, AGENT);
    expect(out.match(/mcp__engram__\*/g)).toHaveLength(1);
    // The quoted copy in the body keeps its original `tools: Read`.
    expect(out).toContain("```\nname: researcher\ntools: Read\nmodel: sonnet\n```");
  });
});

describe("withoutAgentMcpTools", () => {
  const engram = plugin("engram", true);
  const granted = withAgentMcpTools(agentFile("Read, Glob"), engram, AGENT);

  it("takes the server pattern back out, leaving the rest of the allowlist", () => {
    expect(granted).toContain("tools: Read, Glob, mcp__engram__*");
    expect(withoutAgentMcpTools(granted, engram, AGENT)).toContain("tools: Read, Glob");
    expect(withoutAgentMcpTools(granted, engram, AGENT)).not.toContain("mcp__engram__*");
  });

  it("round-trips: grant then revoke gives back the original file byte for byte", () => {
    const original = agentFile("Read, Glob");
    expect(withoutAgentMcpTools(granted, engram, AGENT)).toBe(original);
  });

  it("never touches another plugin's grant", () => {
    const other = plugin("other", true);
    expect(withoutAgentMcpTools(granted, other, AGENT)).toBe(granted);
  });

  it("is a no-op when the grant was never there", () => {
    const content = agentFile("Read");
    expect(withoutAgentMcpTools(content, engram, AGENT)).toBe(content);
  });

  it("leaves a skill target untouched — skills have no allowlist to narrow", () => {
    const target = ".claude/skills/structural-search/SKILL.md";
    expect(withoutAgentMcpTools(granted, engram, target)).toBe(granted);
  });

  it("leaves an agent that declares no tools untouched — nothing to take away", () => {
    const content = agentFile(null);
    expect(withoutAgentMcpTools(content, engram, AGENT)).toBe(content);
  });

  /**
   * The match is EXACT-ENTRY, never by prefix, and this is the case that says so.
   *
   * `deriveMcpTools` yields the family pattern `mcp__engram__*`, and a revoke
   * written as "drop every entry under this server" reads as a natural
   * simplification — it passes every case above. It is also wrong on the two
   * real agents that matter: `explorer.md` and `researcher.md` hold
   * `mcp__engram__mem_search` and `mcp__engram__mem_get_observation` BY NAME,
   * deliberately, so that no injection can widen them to the writable family
   * (#761). A prefix revoke would take those two with it and silently leave the
   * repo's only read-only memory roles unable to read memory at all.
   */
  const BY_NAME = "mcp__engram__mem_search, mcp__engram__mem_get_observation";

  it("keeps by-name tools of the SAME server when only the family is revoked", () => {
    const both = agentFile(`Read, ${BY_NAME}, mcp__engram__*`);
    const out = withoutAgentMcpTools(both, engram, AGENT);
    expect(out).toContain(`tools: Read, ${BY_NAME}`);
    expect(out).not.toContain("mcp__engram__*");
  });

  it("is a no-op on an agent that holds only by-name tools of that server", () => {
    // The shape `explorer.md` and `researcher.md` actually ship.
    const readOnly = agentFile(`Read, Glob, Grep, Bash, Write, ${BY_NAME}`);
    expect(withoutAgentMcpTools(readOnly, engram, AGENT)).toBe(readOnly);
  });
});
