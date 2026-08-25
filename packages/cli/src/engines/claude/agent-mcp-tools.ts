import { splitFrontmatter, getFrontmatterField } from "../../lib/frontmatter.ts";
import type { LoadedPlugin } from "../../lib/plugins.ts";

/**
 * Give an agent the MCP tools that a plugin's own prose tells it to use.
 *
 * Wiring an MCP tool for a subagent takes THREE layers, and the plugin schema
 * only ever owned the first two:
 *
 *   1. the server registered in `.mcp.json`      <- `plugin.mcpServer` (#212)
 *   2. the permission granted in settings.json   <- `plugin.settingsFragment`
 *   3. the tool listed in the agent's `tools:`   <- nobody
 *
 * That third one decides whether the agent HAS the tool at all: `tools:` is an
 * allowlist covering MCP servers too, so an agent declaring it without any
 * `mcp__` entry can never call them — however correctly the server is
 * registered and the permission granted. A `permissions.allow` only silences
 * the prompt for a tool the agent already holds; it never grants one.
 *
 * The gap was not theoretical. `codegraph` injects CodeGraph instructions into
 * `researcher.md` and `explorer.md`, both of which declare
 * `tools: Read, Glob, Grep, Bash, Write` — so every one of those agents booted
 * carrying prose it was structurally unable to act on.
 *
 * Derived rather than configured, deliberately: a new manifest field would be
 * one more thing to remember, and forgetting is exactly how this broke. The
 * plugin already declares the server, and that is the whole input needed.
 */

/** Inject targets whose `tools:` gates MCP access. Skills have no allowlist. */
const AGENTS_DIR = ".claude/agents/";

/** The `tools:` entry that grants a plugin's whole MCP server to an agent. */
export function deriveMcpTools(plugin: LoadedPlugin): string[] {
  if (!plugin.manifest.mcpServer) return [];
  // A server-level pattern, not one entry per tool: `tools:` accepts
  // `mcp__<server>__*`, and enumerating instead would mean picking a list.
  // `invariants` is the wrong list to pick — those are load-bearing SUBSTRINGS
  // the render must preserve (doctor.ts), which merely happen to look like tool
  // names today; deriving from them both admits non-tool strings and comes up
  // short, as engram shows: its prose calls `mem_search`, which is not among
  // them. `.mcp.json` registers each server under the plugin id.
  return [`mcp__${plugin.manifest.id}__*`];
}

/**
 * Add a plugin's MCP tools to the `tools:` frontmatter of an agent it injects
 * into. Returns `content` untouched when there is nothing to grant.
 *
 * Only the `tools:` line is rewritten — every other key, its order and the
 * file's line endings survive, so this never shows up as incidental drift in a
 * render diff.
 */
export function withAgentMcpTools(content: string, plugin: LoadedPlugin, target: string): string {
  if (!target.startsWith(AGENTS_DIR)) return content;

  const tools = deriveMcpTools(plugin);
  if (tools.length === 0) return content;

  const { frontmatter } = splitFrontmatter(content);
  if (frontmatter === "") return content;

  const declared = getFrontmatterField(frontmatter, "tools");
  // No `tools:` at all means the agent inherits every tool, MCP included —
  // already able to call them, so there is nothing to widen.
  if (declared === null) return content;

  const have = declared
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  const missing = tools.filter((t) => !have.includes(t));
  if (missing.length === 0) return content;

  const updated = frontmatter.replace(
    /^tools:[ \t]*[^\r\n]*/m,
    `tools: ${[...have, ...missing].join(", ")}`,
  );

  // Splice by offset instead of a whole-file replace: the frontmatter text
  // could otherwise match again inside the body and corrupt it.
  const at = content.indexOf(frontmatter);
  return content.slice(0, at) + updated + content.slice(at + frontmatter.length);
}
