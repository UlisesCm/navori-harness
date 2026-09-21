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
 * The gap was not theoretical. A plugin that injects its MCP prose into
 * `researcher.md` and `explorer.md` — both of which declare
 * `tools: Read, Glob, Grep, Bash, Write` — had every one of those agents boot
 * carrying instructions it was structurally unable to act on.
 *
 * Derived rather than configured BY DEFAULT: a manifest that says nothing
 * keeps getting the whole-server wildcard, so most plugins never touch this.
 * But "derived, never configured" turned out to prove too much — the wildcard
 * is not a capability decision, it's the ABSENCE of one, and engram is the
 * case that makes the gap concrete: `mem_save` sits behind the same wildcard
 * as `mem_search`, so any agent the plugin's prose reaches can write, no
 * matter what that prose says about who should. The prose ("save only what
 * outlives this task") is advisory; `tools:` is the only enforceable layer,
 * which is exactly this module's own thesis one layer up. `skills[].mcpTools`
 * closes that gap: a manifest can now name the exact tools a given
 * `injectInto` target gets, and everything without an opinion keeps the old
 * wildcard behavior untouched.
 */

/** Inject targets whose `tools:` gates MCP access. Skills have no allowlist. */
const AGENTS_DIR = ".claude/agents/";

/**
 * The `tools:` entries a plugin grants to one `injectInto` target: either the
 * curated list in `skills[].mcpTools` (each name prefixed `mcp__<id>__`), or
 * the whole-server wildcard when the manifest declares none.
 */
export function deriveMcpTools(plugin: LoadedPlugin, mcpTools?: string[]): string[] {
  if (!plugin.manifest.mcpServer) return [];
  if (mcpTools && mcpTools.length > 0) {
    return mcpTools.map((tool) => `mcp__${plugin.manifest.id}__${tool}`);
  }
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
 *
 * When `mcpTools` narrows the grant, a leftover `mcp__<id>__*` from an earlier
 * render (before the manifest declared `mcpTools`, or before this target did)
 * is retired in the same pass — it is the widened grant this narrower one
 * supersedes, not a manual addition, so leaving it would grant everything the
 * narrow list exists to withhold.
 */
export function withAgentMcpTools(
  content: string,
  plugin: LoadedPlugin,
  target: string,
  mcpTools?: string[],
): string {
  return rewriteAgentTools(content, plugin, target, mcpTools, (have, tools) => {
    const supersededWildcard =
      mcpTools && mcpTools.length > 0 ? `mcp__${plugin.manifest.id}__*` : null;
    const kept = supersededWildcard ? have.filter((t) => t !== supersededWildcard) : have;
    const missing = tools.filter((t) => !kept.includes(t));
    return missing.length === 0 && kept.length === have.length ? null : [...kept, ...missing];
  });
}

/**
 * The inverse: drop a plugin's MCP tools from the `tools:` frontmatter of an
 * agent it no longer injects into. Returns `content` untouched when the grant
 * isn't there.
 *
 * Without this the widening was one-way. `removeSubBlock` strips a disabled
 * plugin's prose from the agent, but the `tools:` entry the SAME render added
 * stayed — so `navori remove <plugin>` left every agent declaring an allowlist
 * entry for a server nothing registers any more, and a later re-install
 * inherited it instead of starting clean.
 *
 * Same supersede case as the grant side, mirrored: a `mcp__<id>__*` left over
 * from a render that predates the manifest's `mcpTools` (or predates it on
 * THIS target) is not a hand grant either, so a revoke has to take it with the
 * curated list — otherwise disabling the plugin leaves that wildcard orphaned
 * on the agent, and a later re-install inherits it instead of starting clean.
 */
export function withoutAgentMcpTools(
  content: string,
  plugin: LoadedPlugin,
  target: string,
  mcpTools?: string[],
): string {
  return rewriteAgentTools(content, plugin, target, mcpTools, (have, tools) => {
    const supersededWildcard =
      mcpTools && mcpTools.length > 0 ? `mcp__${plugin.manifest.id}__*` : null;
    const drop = supersededWildcard ? [...tools, supersededWildcard] : tools;
    const kept = have.filter((t) => !drop.includes(t));
    return kept.length === have.length ? null : kept;
  });
}

/**
 * Shared body of the two rewrites above: resolve the agent's declared `tools:`,
 * hand it to `next`, and splice the result back. `next` returns null when there
 * is nothing to change.
 */
function rewriteAgentTools(
  content: string,
  plugin: LoadedPlugin,
  target: string,
  mcpTools: string[] | undefined,
  next: (have: string[], tools: string[]) => string[] | null,
): string {
  if (!target.startsWith(AGENTS_DIR)) return content;

  const tools = deriveMcpTools(plugin, mcpTools);
  if (tools.length === 0) return content;

  const { frontmatter } = splitFrontmatter(content);
  if (frontmatter === "") return content;

  const declared = getFrontmatterField(frontmatter, "tools");
  // No `tools:` at all means the agent inherits every tool, MCP included —
  // already able to call them, so there is nothing to widen, and nothing a
  // narrowing could take away either.
  if (declared === null) return content;

  const have = declared
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  const result = next(have, tools);
  if (result === null) return content;

  const updated = frontmatter.replace(/^tools:[ \t]*[^\r\n]*/m, `tools: ${result.join(", ")}`);

  // Splice by offset instead of a whole-file replace: the frontmatter text
  // could otherwise match again inside the body and corrupt it.
  const at = content.indexOf(frontmatter);
  return content.slice(0, at) + updated + content.slice(at + frontmatter.length);
}
