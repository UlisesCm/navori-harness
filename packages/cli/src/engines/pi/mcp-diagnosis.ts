import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { NavoriConfig } from "../../lib/config/config.ts";
import { loadEnabledPlugins } from "../../lib/config/plugins.ts";

/** How a plugin's MCP server resolves in Pi's native MCP config. */
export type McpServerState = "global" | "project-only" | "disabled" | "missing";

/**
 * Spec 0048 D14, single source for render AND the Pi extension (serialized into it, so it must stay
 * closure-free: no outer identifier may be referenced). Given plugin ids and the parsed global/project
 * `mcp.json` documents (`undefined` = absent or unreadable), classifies each id. `-` and `_` are
 * equivalent in a server name. Reads ONLY server names, `enabled` and whether an entry defines a
 * transport; no other value (env, headers, tokens) is copied. `project-only` means the server is
 * enabled solely through the project file, so it is effective only if the project is trusted.
 */
export function mcpServerStates(
  ids: readonly string[],
  globalDoc: unknown,
  projectDoc: unknown,
): McpServerState[] {
  const norm = (name: string): string => name.replaceAll("-", "_");
  const read = (doc: unknown): Map<string, { enabled: boolean; replaces: boolean }> => {
    const out = new Map<string, { enabled: boolean; replaces: boolean }>();
    const block =
      typeof doc === "object" && doc !== null && !Array.isArray(doc)
        ? (doc as Record<string, unknown>).mcpServers
        : undefined;
    if (typeof block !== "object" || block === null || Array.isArray(block)) return out;
    for (const [name, raw] of Object.entries(block)) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
      out.set(norm(name), {
        enabled: (raw as Record<string, unknown>).enabled !== false,
        replaces: ["command", "url", "type"].some((key) => key in raw),
      });
    }
    return out;
  };
  const global = read(globalDoc);
  const project = read(projectDoc);
  return ids.map((id): McpServerState => {
    const g = global.get(norm(id));
    const p = project.get(norm(id));
    // The project entry replaces the global one unless it only toggles `enabled`.
    const effective = p === undefined ? g : p.replaces ? p : g && { ...g, enabled: p.enabled };
    if (g?.enabled === true && effective?.enabled) return "global";
    if (effective?.enabled) return "project-only";
    return effective === undefined ? "missing" : "disabled";
  });
}

/** `"unreadable"` means a parse error; the caller reports a fixed message, never the parser's text. */
function readDoc(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch {
    // Never surface the parse error: it can quote file content.
    return "unreadable";
  }
}

/**
 * Spec 0048 R13 / D14: advisory, read-only check that every enabled plugin declaring an MCP
 * server has a matching enabled server in Pi's native MCP config. Reads
 * `${PI_CODING_AGENT_DIR:-~/.pi/agent}/mcp.json` and `<cwd>/.pi/mcp.json`; never writes either.
 * "Configured" is not "connected": `--no-mcp` and replaced MCP extensions are not detected.
 */
export function mcpServerDiagnostics(cwd: string, config: NavoriConfig): string[] {
  const plugins = loadEnabledPlugins(config.plugins).loaded.filter((p) => p.manifest.mcpServer);
  if (plugins.length === 0) return [];
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const out: string[] = [];
  const docs = [join(agentDir, "mcp.json"), join(cwd, ".pi", "mcp.json")].map((path) => {
    const doc = readDoc(path);
    if (doc !== "unreadable") return doc;
    out.push(`Could not read ${path}; check its JSON.`);
    return undefined;
  });
  const ids = plugins.map((p) => p.manifest.id);
  const states = mcpServerStates(ids, docs[0], docs[1]);
  ids.forEach((id, index) => {
    const state = states[index];
    if (state === "global") return;
    if (state === "project-only") {
      out.push(
        `Pi MCP server ${id} (plugin ${id}) is configured only in .pi/mcp.json: it takes effect only if you trust the project (/trust).`,
      );
      return;
    }
    out.push(
      `Pi MCP server ${id} (plugin ${id}) ${state === "missing" ? "is not configured" : "is disabled"} in Pi's MCP config. ` +
        `Register it with: pi mcp add ${id} [-l] -- <command> <args...> (add --env KEY=<value> if it needs credentials). ` +
        "Navori does not write Pi MCP config.",
    );
  });
  return out;
}

/** Ids a Pi extension must check at runtime, rendered into it by `renderPiExtensionSource`. */
export function mcpPluginIds(config: NavoriConfig): string[] {
  return loadEnabledPlugins(config.plugins)
    .loaded.filter((p) => p.manifest.mcpServer)
    .map((p) => p.manifest.id);
}
