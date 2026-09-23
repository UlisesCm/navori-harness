import { describe, it, expect } from "vitest";
import { deriveMcpTools, withAgentMcpTools, withoutAgentMcpTools } from "../agent-mcp-tools.ts";
import type { LoadedPlugin } from "../../../lib/config/plugins.ts";
import { splitFrontmatter, getFrontmatterField } from "../../../lib/render/frontmatter.ts";

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

  it("grants a curated list by name when the manifest names one, not the wildcard", () => {
    expect(deriveMcpTools(plugin("engram", true), ["mem_search", "mem_get_observation"])).toEqual([
      "mcp__engram__mem_search",
      "mcp__engram__mem_get_observation",
    ]);
  });

  it("falls back to the wildcard when the curated list is empty — omitted, not narrowed to nothing", () => {
    expect(deriveMcpTools(plugin("engram", true), [])).toEqual(["mcp__engram__*"]);
  });

  it("grants nothing for a plugin with no server even when a curated list is given", () => {
    expect(deriveMcpTools(plugin("jscpd", false), ["some_tool"])).toEqual([]);
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
    const target = ".claude/skills/locate-code/SKILL.md";
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

  it("appends a curated list by name instead of the wildcard when the manifest names one", () => {
    const out = withAgentMcpTools(agentFile("Read"), engram, AGENT, [
      "mem_search",
      "mem_get_observation",
    ]);
    expect(out).toContain("tools: Read, mcp__engram__mem_search, mcp__engram__mem_get_observation");
    expect(out).not.toContain("mcp__engram__*");
  });

  it("retires a leftover wildcard from an earlier render once the manifest narrows to a curated list", () => {
    const wide = withAgentMcpTools(agentFile("Read"), engram, AGENT); // pre-existing mcp__engram__*
    const narrowed = withAgentMcpTools(wide, engram, AGENT, ["mem_search", "mem_get_observation"]);
    expect(narrowed).toContain(
      "tools: Read, mcp__engram__mem_search, mcp__engram__mem_get_observation",
    );
    expect(narrowed).not.toContain("mcp__engram__*");
  });

  it("narrowing is idempotent once the wildcard is gone", () => {
    const once = withAgentMcpTools(agentFile("Read"), engram, AGENT, [
      "mem_search",
      "mem_get_observation",
    ]);
    expect(withAgentMcpTools(once, engram, AGENT, ["mem_search", "mem_get_observation"])).toBe(
      once,
    );
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
    const target = ".claude/skills/locate-code/SKILL.md";
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

  /**
   * The revoke side of the same supersede case `withAgentMcpTools` already
   * handles on grant: an agent still carrying `mcp__engram__*` from a render
   * that predates the manifest's `mcpTools` must not keep it as an orphan when
   * the plugin is disabled. `navori remove engram` calls this with the
   * manifest's CURRENT (narrow) `mcpTools` — the wildcard is nowhere in that
   * list by name, so without this the entry survives the revoke and a later
   * re-install inherits it instead of starting clean.
   */
  it("retires a leftover wildcard on revoke too, not just on grant", () => {
    const staleWildcard = agentFile("Read, Glob, mcp__engram__*");
    const revoked = withoutAgentMcpTools(staleWildcard, engram, AGENT, [
      "mem_search",
      "mem_get_observation",
    ]);
    expect(revoked).toBe(agentFile("Read, Glob"));
  });

  it("a wildcard-revoke call (no curated list) still leaves an unrelated stale wildcard alone if absent", () => {
    // Sanity companion: without a curated `mcpTools`, the supersede branch
    // never engages — the wildcard-only path above (line ~194) already covers
    // that a plain family revoke works; this just pins that passing `undefined`
    // does not accidentally widen what gets dropped.
    const content = agentFile("Read, Glob, mcp__engram__mem_search");
    expect(withoutAgentMcpTools(content, engram, AGENT)).toBe(content);
  });

  // search-v2.md §7 C01 — same grant/revoke machinery, exercised with the real
  // production ids: retiring the CodeGraph v2 grant must never touch Engram's
  // (or vice versa). This is the generic layer this suite already pins for
  // synthetic ids; here it pins it for the two ids that actually ship together.
  it("takes a curated list back out the same way it was granted, by name", () => {
    const grantedNarrow = withAgentMcpTools(agentFile("Read, Glob"), engram, AGENT, [
      "mem_search",
      "mem_get_observation",
    ]);
    const revoked = withoutAgentMcpTools(grantedNarrow, engram, AGENT, [
      "mem_search",
      "mem_get_observation",
    ]);
    expect(revoked).toBe(agentFile("Read, Glob"));
  });

  it("C01 — retiring the codegraph grant leaves engram's grant on the same agent untouched", () => {
    const codegraph = plugin("codegraph", true);
    const both = withAgentMcpTools(
      withAgentMcpTools(agentFile("Read"), engram, AGENT),
      codegraph,
      AGENT,
    );
    expect(agentTools(both)).toEqual(["Read", "mcp__engram__*", "mcp__codegraph__*"]);

    const codegraphOnlyOff = withoutAgentMcpTools(both, codegraph, AGENT);
    expect(agentTools(codegraphOnlyOff)).toEqual(["Read", "mcp__engram__*"]);
  });
});

/** Parses the `tools:` allowlist out of a rendered agent fixture's frontmatter. */
function agentTools(content: string): string[] {
  const { frontmatter } = splitFrontmatter(content);
  const raw = getFrontmatterField(frontmatter, "tools");
  return raw
    ? raw
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t !== "")
    : [];
}
