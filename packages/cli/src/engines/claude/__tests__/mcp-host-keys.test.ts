import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { NavoriConfigSchema, type NavoriConfig } from "../../../lib/config/schema.ts";
import type { LoadedPlugin } from "../../../lib/config/plugins.ts";
import { readCliVersion } from "../../../lib/render/bundled-assets.ts";
import { planMcpRegistration } from "../index.ts";

/**
 * #1448 — a host adds its own switches inside a navori server entry of `.mcp.json` (pi writes
 * `directTools: true`). Render keeps them and only sets the keys it generates; before, it replaced
 * the entry wholesale, deleting them on every render and leaving the mirror "stale" in that host.
 */

function config(): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "mcp-demo",
    engines: ["claude"],
    preset: "custom",
    branchBase: "main",
    qualityGate: { fast: "pnpm tsc", full: "pnpm test" },
  });
}

function plugin(mcpServer: NonNullable<LoadedPlugin["manifest"]["mcpServer"]>): LoadedPlugin {
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

/** Plans `.mcp.json` over `onDisk`; the file's text, unchanged when the plan is a no-op. */
function render(onDisk: unknown, server: Parameters<typeof plugin>[0]): string {
  const cwd = mkdtempSync(join(tmpdir(), "navori-mcp-host-keys-"));
  const text = `${JSON.stringify(onDisk, null, 2)}\n`;
  writeFileSync(join(cwd, ".mcp.json"), text);
  const plan = planMcpRegistration(cwd, [plugin(server)], [], config(), false);
  if (plan.kind === "noop") return text;
  if (plan.kind !== "write") throw new Error(`unexpected plan '${plan.kind}'`);
  return plan.content;
}

describe("#1448 — host keys inside a navori MCP entry", () => {
  it("keeps a host switch in place and leaves an up-to-date file untouched", () => {
    // As render left it (stamped as navori's), then the host added its switch.
    const onDisk = {
      $navori: { managed: true, version: readCliVersion() },
      mcpServers: { demo: { command: "demo", args: ["serve"], directTools: true } },
    };
    const out = render(onDisk, { command: "demo", args: ["serve"] });
    expect(out).toBe(`${JSON.stringify(onDisk, null, 2)}\n`);
  });

  it("refreshes navori's keys around the host's, in their positions", () => {
    const out = JSON.parse(
      render(
        {
          mcpServers: {
            demo: { command: "old", directTools: true, args: ["old"], env: { A: "1" } },
          },
        },
        { command: "demo", args: ["serve"], alwaysLoad: true },
      ),
    );
    // `env` is navori's and gone from the manifest; `alwaysLoad` is new, so it goes last.
    expect(out.mcpServers.demo).toEqual({
      command: "demo",
      directTools: true,
      args: ["serve"],
      alwaysLoad: true,
    });
    expect(Object.keys(out.mcpServers.demo)).toEqual([
      "command",
      "directTools",
      "args",
      "alwaysLoad",
    ]);
  });

  it("drops alwaysLoad when the manifest stops declaring it", () => {
    const out = JSON.parse(
      render(
        {
          mcpServers: { demo: { command: "demo", args: [], alwaysLoad: true, directTools: true } },
        },
        { command: "demo", args: [] },
      ),
    );
    expect(out.mcpServers.demo).toEqual({ command: "demo", args: [], directTools: true });
  });

  it("replaces an entry that is not an object", () => {
    const out = JSON.parse(
      render({ mcpServers: { demo: "broken" } }, { command: "demo", args: [] }),
    );
    expect(out.mcpServers.demo).toEqual({ command: "demo", args: [] });
  });
});
