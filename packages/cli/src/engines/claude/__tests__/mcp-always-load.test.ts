import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { NavoriConfigSchema, type NavoriConfig } from "../../../lib/config/schema.ts";
import type { LoadedPlugin } from "../../../lib/config/plugins.ts";
import { planMcpRegistration } from "../index.ts";

/**
 * Covers: R13 (spec 0017) — `mcpServer.alwaysLoad` reaches the rendered
 * `.mcp.json`.
 *
 * Driven by a SYNTHETIC plugin rather than a bundled one on purpose: no manifest
 * navori ships declares `alwaysLoad` today, so a test written against the plugin
 * catalogue would assert nothing the day that stays true — and the emitting
 * branch (`if (server.alwaysLoad) entry.alwaysLoad = true`) would be code no
 * suite reaches. The field is part of the plugin CONTRACT, not of any one
 * plugin, and this is the level that contract lives at.
 *
 * The negative half (an undeclared `alwaysLoad` must not grow the key) rides on
 * a real manifest in `ola3-fixes.test.ts`, where engram supplies it.
 */

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "navori-mcp-always-load-"));
}

function config(): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "mcp-demo",
    engines: ["claude"],
    preset: "custom",
    branchBase: "main",
    qualityGate: { fast: "pnpm tsc", full: "pnpm test" },
  });
}

/** A plugin that declares nothing but the MCP server under test. */
function pluginWithServer(mcpServer: NonNullable<LoadedPlugin["manifest"]["mcpServer"]>) {
  return {
    manifest: {
      id: "demo",
      name: "Demo",
      description: "Synthetic plugin — MCP registration only.",
      version: "0.0.1",
      managed: [],
      invariants: [],
      mcpServer,
    },
    packageRoot: "/nonexistent",
    managedAssets: [],
    scriptAssets: [],
    skillAssets: [],
  } satisfies LoadedPlugin;
}

/** The `mcpServers` map the plan would write, parsed back out. */
function registeredServers(plugin: LoadedPlugin): Record<string, Record<string, unknown>> {
  const plan = planMcpRegistration(tempRepo(), [plugin], [], config(), false);
  if (plan.kind !== "write") throw new Error(`expected a write, got '${plan.kind}'`);
  return JSON.parse(plan.content).mcpServers;
}

describe("R13 — mcpServer.alwaysLoad in the rendered registry", () => {
  it("carries alwaysLoad: true through to the emitted entry", () => {
    const servers = registeredServers(
      pluginWithServer({ command: "demo", args: ["serve"], alwaysLoad: true }),
    );
    expect(servers.demo).toEqual({ command: "demo", args: ["serve"], alwaysLoad: true });
  });

  it("writes no key at all for alwaysLoad: false — the absent key already means it", () => {
    const servers = registeredServers(
      pluginWithServer({ command: "demo", args: ["serve"], alwaysLoad: false }),
    );
    expect(servers.demo).toBeDefined();
    expect("alwaysLoad" in (servers.demo ?? {})).toBe(false);
  });
});
