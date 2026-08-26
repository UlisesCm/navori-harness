import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getCoreRoot } from "../bundled-assets.ts";
import { isInvokable, listAgentAssets } from "./helpers/agent-assets.ts";

/**
 * #501 — an instruction the reader cannot execute is worse than no instruction:
 * it teaches that `CLAUDE.md` is optional, in a harness whose every mechanism
 * assumes it is not.
 *
 * Wiring an MCP tool takes three layers (`engines/claude/agent-mcp-tools.ts`):
 * the server in `.mcp.json`, the permission in `settings.json`, and the tool in
 * the agent's `tools:` allowlist. engram shipped the first and the prose, and
 * neither of the other two: no `settingsFragment`, so the permission survived
 * only in a gitignored `settings.local.json` that no fresh clone has — and its
 * only `injectInto` target was `leader.md`, the one agent that forbids its own
 * invocation. Result: ~2 KB of unconditional `mem_*` orders reaching seven
 * subagents that structurally could not obey them.
 *
 * This suite pins the CLASS, not that instance:
 *
 *   1. A plugin that registers an MCP server GRANTS its own tools in
 *      `settingsFragment`. Nothing else versions that permission.
 *   2. A plugin whose always-on managed block ORDERS its tools either puts them
 *      in the hands of a launchable agent, or states the availability condition
 *      in the block — the shape `structural-search`'s Rung -1 already uses.
 *   3. The CORE never orders a plugin's tool from an always-on surface. Core
 *      prose ships to every repo, plugin or no plugin; an on-demand skill may
 *      name one (`ticket-intake` does), because it is read only when invoked.
 */

const here = dirname(fileURLToPath(import.meta.url));
const PLUGINS_DIR = resolve(here, "..", "..", "..", "..", "plugins");
const CORE_ASSETS = resolve(getCoreRoot(), "core-assets");

/** The subset of a plugin manifest this suite reasons about. */
interface PluginManifest {
  readonly id: string;
  readonly mcpServer?: unknown;
  readonly settingsFragment?: { readonly permissions?: { readonly allow?: readonly string[] } };
  readonly invariants?: readonly string[];
  readonly managed?: ReadonlyArray<{ readonly file: string }>;
  readonly skills?: ReadonlyArray<{ readonly file: string; readonly injectInto?: string }>;
}

/** A manifest plus the prose of the always-on blocks it ships. */
interface PluginUnderAudit {
  readonly manifest: PluginManifest;
  /** Concatenated body of every `managed[]` block — what lands in CLAUDE.md. */
  readonly blockText: string;
}

/** Agents an `injectInto` target can name, restricted to the launchable ones. */
const INVOKABLE_AGENTS = new Set(
  listAgentAssets()
    .filter(isInvokable)
    .map((a) => a.id),
);

function readPlugins(): PluginUnderAudit[] {
  const out: PluginUnderAudit[] = [];
  for (const dir of readdirSync(PLUGINS_DIR)) {
    const manifestPath = resolve(PLUGINS_DIR, dir, "plugin.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as PluginManifest;
    const blockText = (manifest.managed ?? [])
      .map((block) => readFileSync(resolve(PLUGINS_DIR, dir, block.file), "utf-8"))
      .join("\n");
    out.push({ manifest, blockText });
  }
  return out;
}

/**
 * The plugin's own tool names, taken from `invariants` — the tokens doctor
 * already treats as load-bearing. Filtered to identifier shape, because that
 * list also carries prose invariants (`"do not approve"` for jscpd), and those
 * are not tools.
 */
function toolTokens(manifest: PluginManifest): string[] {
  return (manifest.invariants ?? []).filter((token) =>
    /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(token),
  );
}

/** Agents this plugin injects prose into, filtered to the launchable ones. */
function injectedInvokableAgents(manifest: PluginManifest): string[] {
  return (manifest.skills ?? [])
    .map((skill) => skill.injectInto ?? "")
    .map((target) => target.match(/^\.claude\/agents\/(.+)\.md$/)?.[1] ?? "")
    .filter((id) => INVOKABLE_AGENTS.has(id));
}

/**
 * Every way a plugin's MCP wiring can promise a capability it does not deliver.
 * Pure over its input so the positive control below can drive it with a
 * synthetic manifest — a check that only ever sees healthy data is a check
 * nobody has watched fail.
 */
function auditMcpWiring(plugin: PluginUnderAudit): string[] {
  const { manifest, blockText } = plugin;
  if (manifest.mcpServer === undefined) return [];

  const server = `mcp__${manifest.id}__`;
  const violations: string[] = [];

  if (!(manifest.settingsFragment?.permissions?.allow ?? []).includes(`${server}*`)) {
    violations.push(
      `${manifest.id} registers an MCP server without a settingsFragment granting \`${server}*\`. ` +
        "Without it the permission exists only in the gitignored settings.local.json of whoever " +
        "wired it by hand, and a freshly onboarded repo has no such net.",
    );
  }

  const ordered = toolTokens(manifest).filter((token) => blockText.includes(token));
  const targets = (manifest.skills ?? []).map((skill) => skill.injectInto).filter(Boolean);
  if (
    ordered.length > 0 &&
    injectedInvokableAgents(manifest).length === 0 &&
    !blockText.includes(server)
  ) {
    violations.push(
      `${manifest.id}'s always-on block orders ${ordered.join(", ")}, but the tools reach no ` +
        `launchable agent (injectInto: ${targets.length === 0 ? "none" : targets.join(", ")}) and ` +
        "the block states no availability condition. Either inject into an agent that benefits, " +
        `or say who the block is addressed to by naming \`${server}*\` in it.`,
    );
  }
  return violations;
}

const PLUGINS = readPlugins();
const MCP_PLUGINS = PLUGINS.filter((p) => p.manifest.mcpServer !== undefined);

describe("MCP wiring — instruction and capability ship together (#501)", () => {
  it("finds the MCP plugins and their tool tokens (a mute audit is not a pass)", () => {
    // Anti-vacuity on both inputs: an empty plugin scan, or a `toolTokens` that
    // stopped recognizing identifiers, would make every case below pass on air.
    expect(MCP_PLUGINS.map((p) => p.manifest.id).sort()).toEqual(["codegraph", "engram"]);
    expect(INVOKABLE_AGENTS.has("researcher")).toBe(true);
    expect(INVOKABLE_AGENTS.has("leader")).toBe(false);

    const engram = MCP_PLUGINS.find((p) => p.manifest.id === "engram");
    expect(toolTokens(engram?.manifest ?? { id: "engram" })).toContain("mem_save");
    expect(engram?.blockText).toContain("mem_save");
  });

  for (const plugin of MCP_PLUGINS) {
    it(`${plugin.manifest.id} delivers every capability its prose orders`, () => {
      expect(auditMcpWiring(plugin)).toEqual([]);
    });
  }
});

describe("the audit reports both halves of the gap (#501)", () => {
  const bare: PluginUnderAudit = {
    manifest: {
      id: "demo",
      mcpServer: { command: "demo" },
      invariants: ["demo_search", "not a tool"],
      skills: [{ file: "skills/x.md", injectInto: ".claude/agents/leader.md" }],
    },
    blockText: "Call `demo_search` before searching code.",
  };

  it("flags a server with no settingsFragment and prose with no reachable agent", () => {
    const found = auditMcpWiring(bare);
    expect(found).toHaveLength(2);
    expect(found[0]).toContain("settingsFragment");
    expect(found[1]).toContain("demo_search");
  });

  it("clears once the permission is granted and the block states its condition", () => {
    expect(
      auditMcpWiring({
        manifest: {
          ...bare.manifest,
          settingsFragment: { permissions: { allow: ["mcp__demo__*"] } },
        },
        blockText: `${bare.blockText} Applies to whoever holds \`mcp__demo__*\`.`,
      }),
    ).toEqual([]);
  });

  it("clears just as well when the tools reach a launchable agent instead", () => {
    expect(
      auditMcpWiring({
        manifest: {
          ...bare.manifest,
          settingsFragment: { permissions: { allow: ["mcp__demo__*"] } },
          skills: [{ file: "skills/x.md", injectInto: ".claude/agents/researcher.md" }],
        },
        blockText: bare.blockText,
      }),
    ).toEqual([]);
  });
});

describe("the core never orders a capability only a plugin can grant (#501)", () => {
  /** Always-on core surfaces: a managed block, and every agent's own protocol. */
  function alwaysOnCoreSurfaces(): Array<{ label: string; text: string }> {
    const managedDir = resolve(CORE_ASSETS, "managed");
    const managed = readdirSync(managedDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({ label: `managed/${f}`, text: readFileSync(resolve(managedDir, f), "utf-8") }));
    const agents = listAgentAssets().map((a) => ({ label: `agents/${a.id}.md`, text: a.content }));
    return [...managed, ...agents];
  }

  const ALL_PLUGIN_TOOLS = PLUGINS.flatMap((p) => toolTokens(p.manifest));

  it("knows which tokens to look for", () => {
    expect(ALL_PLUGIN_TOOLS).toEqual(expect.arrayContaining(["mem_save", "codegraph_explore"]));
    expect(alwaysOnCoreSurfaces().length).toBeGreaterThan(10);
  });

  it("no managed block or agent names a plugin's MCP tool", () => {
    const offenders = alwaysOnCoreSurfaces().flatMap(({ label, text }) =>
      ALL_PLUGIN_TOOLS.filter((token) => text.includes(token)).map((token) => `${label}: ${token}`),
    );
    expect(
      offenders,
      "a core surface ships to every repo, with or without that plugin. Move the order into " +
        "the plugin's own block (it renders only when enabled), or make it an on-demand skill.",
    ).toEqual([]);
  });
});
