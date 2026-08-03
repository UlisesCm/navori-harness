import { describe, it, expect } from "vitest";
import { buildGitignoreBody, CUBO_A_ENTRIES } from "../gitignore-harness.ts";

/**
 * Spec gitignore-harness T2 — pure derivation of the `.gitignore` block body.
 * Covers Cubo A (machine-local, always on when mode ≠ off) and Cubo B (harness
 * outputs, only in `full`, derived from `config.engines`).
 */
describe("buildGitignoreBody", () => {
  // Covers: R8
  it("returns null in mode 'off'", () => {
    expect(buildGitignoreBody({ gitignoreHarness: "off", engines: ["claude"] })).toBeNull();
  });

  // Covers: R8
  it("returns null when gitignoreHarness is absent (defaults to off)", () => {
    expect(buildGitignoreBody({ gitignoreHarness: undefined, engines: ["claude"] })).toBeNull();
  });

  // Covers: R3
  it("mode 'local' contains exactly Cubo A and none of Cubo B", () => {
    const body = buildGitignoreBody({ gitignoreHarness: "local", engines: ["claude", "codex"] });
    const lines = body?.split("\n") ?? [];
    expect(lines).toEqual([...CUBO_A_ENTRIES]);
    expect(body).not.toContain(".claude/\n");
    expect(body).not.toContain("CLAUDE.md");
    expect(body).not.toContain(".codex/");
    expect(body).not.toContain("AGENTS.md");
  });

  // Covers: R4
  it("mode 'full' with engines:['claude'] includes .claude/, CLAUDE.md and .mcp.json but not codex outputs", () => {
    const body = buildGitignoreBody({ gitignoreHarness: "full", engines: ["claude"] });
    const lines = body?.split("\n") ?? [];
    expect(lines).toContain(".claude/");
    expect(lines).toContain("CLAUDE.md");
    // .mcp.json is a Claude-engine output that isn't in ENGINE_OUTPUTS.
    expect(lines).toContain(".mcp.json");
    expect(lines).not.toContain(".codex/");
    expect(lines).not.toContain("AGENTS.md");
    // Cubo A is always present.
    for (const entry of CUBO_A_ENTRIES) expect(lines).toContain(entry);
  });

  // Covers: R4
  it("never emits navori.config.json — it stays the versioned source of truth", () => {
    const body = buildGitignoreBody({ gitignoreHarness: "full", engines: ["claude", "codex"] });
    const lines = body?.split("\n") ?? [];
    expect(lines).not.toContain("navori.config.json");
  });

  // Covers: R4
  it("mode 'full' with engines:['claude','codex'] additionally includes .codex/ and AGENTS.md", () => {
    const body = buildGitignoreBody({ gitignoreHarness: "full", engines: ["claude", "codex"] });
    const lines = body?.split("\n") ?? [];
    expect(lines).toContain(".claude/");
    expect(lines).toContain("CLAUDE.md");
    expect(lines).toContain(".codex/");
    expect(lines).toContain("AGENTS.md");
  });

  // Covers: R4
  it("dedupes AGENTS.md when both codex and agents-md are configured", () => {
    const body = buildGitignoreBody({
      gitignoreHarness: "full",
      engines: ["codex", "agents-md"],
    });
    const lines = body?.split("\n") ?? [];
    expect(lines.filter((l) => l === "AGENTS.md")).toHaveLength(1);
  });

  // Covers: R3, R4, R8
  it("never emits the bare root progress/ (only .claude/progress/)", () => {
    for (const mode of ["local", "full"] as const) {
      const body = buildGitignoreBody({ gitignoreHarness: mode, engines: ["claude", "codex"] });
      const lines = body?.split("\n") ?? [];
      expect(lines).toContain(".claude/progress/");
      expect(lines).not.toContain("progress/");
    }
  });

  // Covers: R4
  it("is deterministic across runs (stable order)", () => {
    const a = buildGitignoreBody({ gitignoreHarness: "full", engines: ["codex", "claude"] });
    const b = buildGitignoreBody({ gitignoreHarness: "full", engines: ["codex", "claude"] });
    expect(a).toBe(b);
  });
});
