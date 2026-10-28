import type { LoadedPlugin } from "../../lib/config/plugins.ts";
import { coreAgentEntries, deriveMcpToolEntries } from "../shared/engram-grant-policy.ts";
import type { KnowledgeServerSpec } from "./knowledge-client.ts";
import { PI_ROLE_NAMES, PI_ROLE_TOOLS, type PiRoleName } from "./role-tools.ts";

/**
 * Pi children keep `--no-mcp`, so they reach codegraph and engram only through navori-owned
 * extension tools backed by a private stdio MCP server (`knowledge-client.ts`). This module is the
 * CLOSED, read-only table those tools come from, and the per-role grant derivation.
 */

/** Prefix that keeps the tools from colliding with the user's own `gentle-engram` `mem_*` tools. */
export const PI_KNOWLEDGE_PREFIX = "navori_";

/**
 * The only MCP tools a Pi child can ever reach, per plugin id. `mem_save` and every other writer
 * are deliberately absent: the grant is the intersection of what Claude grants with this table.
 */
export const PI_KNOWLEDGE_READONLY: Readonly<Record<string, readonly string[]>> = {
  codegraph: ["codegraph_explore"],
  engram: ["mem_search", "mem_get_observation"],
};

/** Pi tool name of an MCP tool (`mem_search` -> `navori_mem_search`). */
export function piKnowledgeToolName(mcpTool: string): string {
  return `${PI_KNOWLEDGE_PREFIX}${mcpTool}`;
}

/** Every Pi knowledge tool name, in table order. */
export const PI_KNOWLEDGE_TOOL_NAMES: readonly string[] = Object.values(PI_KNOWLEDGE_READONLY)
  .flat()
  .map(piKnowledgeToolName);

/** Pi tool -> `[server id, MCP tool]`, rendered into the extension. */
export const PI_KNOWLEDGE_TOOL_TARGETS: Readonly<Record<string, readonly [string, string]>> =
  Object.fromEntries(
    Object.entries(PI_KNOWLEDGE_READONLY).flatMap(([server, tools]) =>
      tools.map((tool): [string, readonly [string, string]] => [
        piKnowledgeToolName(tool),
        [server, tool],
      ]),
    ),
  );

/**
 * Fixed spawn specs, rendered into the extension. No model text ever reaches argv: it travels only
 * inside JSON-RPC arguments. `{cwd}` is the child's working directory. codegraph runs `--no-watch`
 * so up to three children plus the parent never auto-sync one SQLite index concurrently; the cost
 * is an index that is stale relative to the child's own edits.
 */
export const PI_KNOWLEDGE_SERVERS: Readonly<Record<string, KnowledgeServerSpec>> = {
  codegraph: {
    command: "codegraph",
    args: ["serve", "--mcp", "--no-watch", "-p", "{cwd}"],
    env: {
      CODEGRAPH_MCP_TOOLS: PI_KNOWLEDGE_READONLY.codegraph!.map((tool) =>
        tool.replace(/^codegraph_/, ""),
      ).join(","),
      CODEGRAPH_EXPLORE_DEDUP: "0",
    },
    tools: PI_KNOWLEDGE_READONLY.codegraph!,
    timeoutMs: 60_000,
  },
  engram: {
    command: "engram",
    args: ["mcp", `--tools=${PI_KNOWLEDGE_READONLY.engram!.join(",")}`],
    env: {},
    tools: PI_KNOWLEDGE_READONLY.engram!,
    timeoutMs: 15_000,
  },
};

/** Per-role Pi knowledge tool names (empty for a role with none). */
export type PiKnowledgeGrants = Readonly<Partial<Record<PiRoleName, readonly string[]>>>;

const AGENT_TARGET = /^\.claude\/agents\/([^/]+)\.md$/;

/** Bare MCP tool names a `tools:`-style entry list grants for one plugin (`*` = the whole server). */
function grantedNames(pluginId: string, entries: readonly string[]): string[] {
  const prefix = `mcp__${pluginId}__`;
  const table = PI_KNOWLEDGE_READONLY[pluginId] ?? [];
  const names = entries
    .filter((entry) => entry.startsWith(prefix))
    .map((e) => e.slice(prefix.length));
  return names.includes("*") ? [...table] : names;
}

/**
 * Which knowledge tools each Pi role gets, from the SAME sources Claude uses for `tools:`: the core
 * agent's own `mcp__<id>__*` frontmatter entries plus the enabled plugin's `skills[].mcpTools`
 * (wildcard when none) for the skills injecting into that role, intersected with the closed
 * read-only table. A plugin that is not enabled grants nothing, whatever the frontmatter says.
 */
export function piKnowledgeGrants(plugins: readonly LoadedPlugin[]): PiKnowledgeGrants {
  const grants: Partial<Record<PiRoleName, string[]>> = {};
  for (const role of PI_ROLE_NAMES) {
    const names: string[] = [];
    for (const plugin of plugins) {
      const table = PI_KNOWLEDGE_READONLY[plugin.manifest.id];
      if (!table || !plugin.manifest.mcpServer) continue;
      const entries = [...coreAgentEntries(role)];
      for (const skill of plugin.manifest.skills ?? []) {
        if (AGENT_TARGET.exec(skill.injectInto ?? "")?.[1] !== role) continue;
        entries.push(...deriveMcpToolEntries(plugin.manifest, skill.mcpTools));
      }
      for (const tool of grantedNames(plugin.manifest.id, entries)) {
        if (table.includes(tool)) names.push(piKnowledgeToolName(tool));
      }
    }
    // Table order, no duplicates: the rendered tool list stays deterministic.
    const ordered = PI_KNOWLEDGE_TOOL_NAMES.filter((name) => names.includes(name));
    if (ordered.length) grants[role] = ordered;
  }
  return grants;
}

/** The `--tools` / role-file list of a role: its base tools plus its knowledge grants. */
export function piRoleTools(role: PiRoleName, grants: PiKnowledgeGrants): readonly string[] {
  return [...PI_ROLE_TOOLS[role], ...(grants[role] ?? [])];
}
