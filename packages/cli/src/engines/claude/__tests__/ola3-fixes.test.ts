import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { NavoriConfigSchema, type NavoriConfig } from "../../../lib/schema.ts";
import { renderClaudeEngine } from "../index.ts";

/**
 * Ola 3 fixes for the Claude engine:
 *   - #212: `manifest.mcpServer` materializes into `.mcp.json` (parity with the
 *           Codex `config.toml` registration), so the `mcp__<id>__*` permission
 *           and the protocol's MCP tools point at a server that actually exists.
 *   - #215: a plugin sub-block whose version drifted shows up in
 *           `updatesAvailable`, so `navori update` reports it.
 */

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "navori-ola3-"));
}

function config(plugins: NavoriConfig["plugins"]): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "ola3-demo",
    engines: ["claude"],
    preset: "custom",
    branchBase: "main",
    qualityGate: { fast: "pnpm tsc", full: "pnpm test" },
    plugins,
  });
}

describe("#212 — .mcp.json materialization for Claude", () => {
  it("registers an enabled plugin's mcpServer under the mcpServers key", () => {
    const cwd = tempRepo();
    renderClaudeEngine(cwd, config({ codegraph: { enabled: true } }));

    const mcpPath = join(cwd, ".mcp.json");
    expect(existsSync(mcpPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(mcpPath, "utf-8"));
    expect(parsed.mcpServers.codegraph).toEqual({
      command: "codegraph",
      args: ["serve", "--mcp"],
    });
    // stdio is the default → no `type` field emitted.
    expect(parsed.mcpServers.codegraph.type).toBeUndefined();
  });

  it("does not create .mcp.json when no enabled plugin declares a server", () => {
    const cwd = tempRepo();
    renderClaudeEngine(cwd, config({}));
    expect(existsSync(join(cwd, ".mcp.json"))).toBe(false);
  });

  it("removes a disabled plugin's server entry but keeps the user's own servers", () => {
    const cwd = tempRepo();
    // Seed a .mcp.json that mixes navori's server with a user-owned one.
    writeFileSync(
      join(cwd, ".mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            codegraph: { command: "codegraph", args: ["serve", "--mcp"] },
            "my-server": { command: "my-bin", args: [] },
          },
        },
        null,
        2,
      ) + "\n",
    );

    // Disable codegraph (what `navori remove` does before dropping the key).
    renderClaudeEngine(cwd, config({ codegraph: { enabled: false } }));

    const parsed = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf-8"));
    expect(parsed.mcpServers.codegraph).toBeUndefined();
    expect(parsed.mcpServers["my-server"]).toEqual({ command: "my-bin", args: [] });
  });
});

describe("#215 — plugin sub-block version drift surfaces in updatesAvailable", () => {
  it("reports a leader.md sub-block whose stamped version is older than this CLI's", () => {
    const cwd = tempRepo();
    // First render stamps the engram sub-block in leader.md at the current version.
    const first = renderClaudeEngine(cwd, config({ engram: { enabled: true } }));
    expect(first.updatesAvailable.some((u) => u.id === "engram-leader-extension")).toBe(false);

    const leaderPath = join(cwd, ".claude/agents/leader.md");
    const leader = readFileSync(leaderPath, "utf-8");
    expect(leader).toContain('id="engram-leader-extension"');

    // Simulate a repo rendered by an OLDER navori: rewind the sub-block's stamped
    // version to a clearly-older one, leaving the content intact.
    const drifted = leader.replace(
      /(id="engram-leader-extension"[^>]*version=")[^"]+(")/,
      "$10.0.1$2",
    );
    expect(drifted).not.toBe(leader);
    writeFileSync(leaderPath, drifted);

    const second = renderClaudeEngine(cwd, config({ engram: { enabled: true } }));
    const drift = second.updatesAvailable.find((u) => u.id === "engram-leader-extension");
    expect(drift).toBeDefined();
    expect(drift!.fromVersion).toBe("0.0.1");
    expect(drift!.source).toContain("engram");
  });
});
