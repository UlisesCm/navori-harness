import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { NavoriConfigSchema, type NavoriConfig } from "../../lib/config/schema.ts";
import { scanMcpCoherence, isStrictModeFailure } from "../doctor.ts";

/**
 * doctor's `.mcp.json`-vs-manifest coherence check (#977, plan 0.3/0.4). Unlike
 * `missingExternalTools` (a per-machine fact, warn-only forever), this is a
 * per-repo fact — the committed `.mcp.json` disagreeing with what an enabled
 * plugin's manifest declares — so it feeds `--strict`'s exit code.
 */

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "navori-mcp-coherence-"));
}

function config(overrides: Partial<NavoriConfig> = {}): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "cl",
    engines: ["claude"],
    preset: "custom",
    branchBase: "main",
    ...overrides,
  });
}

function writeMcpJson(cwd: string, content: string): void {
  writeFileSync(join(cwd, ".mcp.json"), content);
}

describe("scanMcpCoherence (#977)", () => {
  it("stays clean when .mcp.json's entry matches the manifest's command", () => {
    const cwd = tempRepo();
    writeMcpJson(
      cwd,
      JSON.stringify({
        mcpServers: { engram: { command: "engram", args: ["mcp"] } },
      }),
    );
    const cfg = config({ plugins: { engram: { enabled: true } } });
    expect(scanMcpCoherence(cwd, cfg)).toEqual([]);
  });

  it("flags a plugin missing its entry in an existing .mcp.json", () => {
    const cwd = tempRepo();
    writeMcpJson(cwd, JSON.stringify({ mcpServers: {} }));
    const cfg = config({ plugins: { engram: { enabled: true } } });
    expect(scanMcpCoherence(cwd, cfg)).toEqual([{ pluginId: "engram", kind: "missing-entry" }]);
  });

  it("flags a command mismatch, naming both the expected and actual command", () => {
    const cwd = tempRepo();
    writeMcpJson(
      cwd,
      JSON.stringify({
        mcpServers: { engram: { command: "not-engram", args: [] } },
      }),
    );
    const cfg = config({ plugins: { engram: { enabled: true } } });
    expect(scanMcpCoherence(cwd, cfg)).toEqual([
      { pluginId: "engram", kind: "command-mismatch", expected: "engram", actual: "not-engram" },
    ]);
  });

  it("flags every enabled MCP plugin when .mcp.json doesn't parse", () => {
    const cwd = tempRepo();
    writeMcpJson(cwd, "{ not valid json");
    const cfg = config({ plugins: { engram: { enabled: true } } });
    const issues = scanMcpCoherence(cwd, cfg);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ pluginId: "engram", kind: "unparseable" });
  });

  it("flags every enabled MCP plugin when .mcp.json's top level isn't an object", () => {
    const cwd = tempRepo();
    writeMcpJson(cwd, JSON.stringify(["not", "an", "object"]));
    const cfg = config({ plugins: { engram: { enabled: true } } });
    expect(scanMcpCoherence(cwd, cfg)).toEqual([{ pluginId: "engram", kind: "missing-entry" }]);
  });

  it("stays silent when .mcp.json doesn't exist yet — nothing rendered to compare", () => {
    const cwd = tempRepo();
    const cfg = config({ plugins: { engram: { enabled: true } } });
    expect(scanMcpCoherence(cwd, cfg)).toEqual([]);
  });

  it("ignores a disabled plugin even with an incoherent .mcp.json", () => {
    const cwd = tempRepo();
    writeMcpJson(cwd, JSON.stringify({ mcpServers: {} }));
    const cfg = config({ plugins: { engram: { enabled: false } } });
    expect(scanMcpCoherence(cwd, cfg)).toEqual([]);
  });

  it("skips the check entirely when Claude isn't a configured engine", () => {
    const cwd = tempRepo();
    writeMcpJson(cwd, JSON.stringify({ mcpServers: {} }));
    // agents-md never writes .mcp.json, so an absent/mismatched entry there
    // is not this repo's incoherence to report.
    const cfg = config({ engines: ["agents-md"], plugins: { engram: { enabled: true } } });
    expect(scanMcpCoherence(cwd, cfg)).toEqual([]);
  });

  it("stays silent for a repo with no MCP-declaring plugin enabled at all", () => {
    const cwd = tempRepo();
    writeMcpJson(cwd, JSON.stringify({ mcpServers: {} }));
    expect(scanMcpCoherence(cwd, config())).toEqual([]);
  });
});

describe("isStrictModeFailure (#977 — the --strict exit-code contract)", () => {
  it("does not fail on a missing external-tool binary alone — that's per-machine, not per-repo", () => {
    // missingExternalTools never reaches this predicate at all: doctor.ts only
    // ever passes it `drifts` and `mcpCoherenceIssues`. Pinned here so nobody
    // widens the predicate's signature to include it later without noticing.
    expect(isStrictModeFailure(true, [], [])).toBe(false);
  });

  it("fails when mcpCoherenceIssues is non-empty and --strict is set", () => {
    expect(isStrictModeFailure(true, [], [{ pluginId: "engram", kind: "missing-entry" }])).toBe(
      true,
    );
  });

  it("fails when drifts is non-empty and --strict is set", () => {
    expect(isStrictModeFailure(true, [{}], [])).toBe(true);
  });

  it("never fails when --strict is not set, regardless of findings", () => {
    expect(isStrictModeFailure(false, [{}], [{ pluginId: "x", kind: "missing-entry" }])).toBe(
      false,
    );
  });
});
