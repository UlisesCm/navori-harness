import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getCoreRoot } from "../../lib/render/bundled-assets.ts";
import {
  getFrontmatterField,
  splitFrontmatter,
  splitToolList,
} from "../../lib/render/frontmatter.ts";
import { loadPlugin, type PluginManifest } from "../../lib/config/plugins.ts";
import { shellSingleQuote } from "../../lib/primitives/shell-escape.ts";
import { ROSTER_AGENTS } from "./roster.ts";

/** Plugin that owns the MCP grants this policy enforces (always-on, not removable). */
const ENGRAM_ID = "engram";
/** Server-wide wildcard token; the shell policy treats it as "every engram tool". */
const WILDCARD = "*";
const AGENT_TARGET = /^\.claude\/agents\/([^/]+)\.md$/;

/**
 * The `tools:` entries a plugin grants to one `injectInto` target: the curated
 * `skills[].mcpTools` (each prefixed `mcp__<id>__`), or the whole-server wildcard
 * when the manifest declares none. Shared by the Claude `tools:` rewrite and the
 * Codex engram-write-guard so both read ONE definition of the grant.
 */
export function deriveMcpToolEntries(
  manifest: Pick<PluginManifest, "id" | "mcpServer">,
  mcpTools?: readonly string[],
): string[] {
  if (!manifest.mcpServer) return [];
  if (mcpTools && mcpTools.length > 0) return mcpTools.map((t) => `mcp__${manifest.id}__${t}`);
  return [`mcp__${manifest.id}__*`];
}

/** Bare tool names (`mem_search`) from `mcp__engram__` entries; `*` for the wildcard. */
function bareNames(entries: readonly string[]): string[] {
  const prefix = `mcp__${ENGRAM_ID}__`;
  return entries.filter((e) => e.startsWith(prefix)).map((e) => e.slice(prefix.length));
}

/** Entries declared in a core agent's own `tools:` frontmatter. */
function coreAgentEntries(agentId: string): string[] {
  const file = resolve(getCoreRoot(), "core-assets/agents", `${agentId}.md`);
  const { frontmatter } = splitFrontmatter(readFileSync(file, "utf-8"));
  const declared = getFrontmatterField(frontmatter, "tools");
  return declared === null ? [] : splitToolList(declared).filter((t) => t !== "");
}

/**
 * Engram tools each roster role is granted on Claude, as bare names (`*` = all):
 * the core agent's own `tools:` union the plugin's `skills[].mcpTools` whose
 * `injectInto` targets that agent. Same sources Claude renders into `tools:`.
 */
export function engramGrantsByRole(
  manifest: PluginManifest = loadPlugin(ENGRAM_ID).manifest,
): Record<string, string[]> {
  const grants: Record<string, string[]> = {};
  for (const agent of ROSTER_AGENTS) {
    const names = new Set(bareNames(coreAgentEntries(agent.id)));
    for (const skill of manifest.skills ?? []) {
      if (AGENT_TARGET.exec(skill.injectInto ?? "")?.[1] !== agent.id) continue;
      for (const n of bareNames(deriveMcpToolEntries(manifest, skill.mcpTools))) names.add(n);
    }
    grants[agent.id] = [...names].sort();
  }
  return grants;
}

/**
 * Grant for `default`/unknown subagent roles: the tools EVERY subagent that has
 * engram access shares (their intersection) — the read tools, derived not
 * written. Deliberate hardening vs Claude's general-purpose, which inherits all.
 */
export function engramFallbackGrant(grants: Record<string, string[]>): string[] {
  const subagents = Object.entries(grants)
    .filter(([id, names]) => id !== "orchestrator" && names.length > 0)
    .map(([, names]) => names);
  const [first, ...rest] = subagents;
  if (!first) return [];
  return first.filter((n) => rest.every((names) => names.includes(n) || names.includes(WILDCARD)));
}

function printTools(names: readonly string[]): string {
  return names.length === 0 ? ":" : `printf '%s\\n' ${names.map(shellSingleQuote).join(" ")}`;
}

/**
 * Compile the per-role engram allowlist into the shell `case` body that
 * `engram-write-guard.sh` interpolates (`{{engramPolicy}}`). `$1` is the role;
 * the arm prints the bare tool names it may call, one per line. A role with no
 * grant prints nothing (everything denied); the `*` arm covers `default` and
 * unknown roles with {@link engramFallbackGrant}.
 */
export function buildEngramPolicyShell(manifest?: PluginManifest): string {
  const grants = engramGrantsByRole(manifest);
  const arms = ROSTER_AGENTS.map(
    (agent) => `    ${agent.id}) ${printTools(grants[agent.id] ?? [])} ;;`,
  );
  return [
    '  case "$1" in',
    ...arms,
    `    *) ${printTools(engramFallbackGrant(grants))} ;;`,
    "  esac",
  ].join("\n");
}
