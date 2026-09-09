import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderClaudeEngine } from "../index.ts";
import type { NavoriConfig } from "../../../lib/config.ts";

/**
 * Covers: R11 — the tgrep plugin's doctrine, as it lands in a rendered repo
 * (spec 0017).
 *
 * The wrapper is only the default if the four places that decide HOW to search
 * say so: the CLAUDE.md protocol, the executor rung of `structural-search`, and
 * the two agent pairs (search: researcher/explorer, code: implementer/reviewer).
 * Mechanism without doctrine is the failure this spec was written against — a
 * perfectly wired tool nobody calls — so the wiring is pinned here per surface.
 */

const CONFIG = {
  name: "demo",
  engines: ["claude"],
  preset: "custom",
  version: "1.0.0",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
  plugins: { tgrep: { enabled: true } },
} as unknown as NavoriConfig;

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-tgrep-render-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function read(rel: string): string {
  return readFileSync(join(cwd, rel), "utf-8");
}

describe("render — tgrep plugin doctrine (spec 0017)", () => {
  it("writes both scripts into .claude/scripts/", () => {
    renderClaudeEngine(cwd, CONFIG);
    expect(existsSync(join(cwd, ".claude/scripts/tgrep-search.sh"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/scripts/tgrep-session.sh"))).toBe(true);
  });

  it("adds the protocol block to CLAUDE.md, with the canonical invocation", () => {
    renderClaudeEngine(cwd, CONFIG);
    const claudeMd = read("CLAUDE.md");
    expect(claudeMd).toContain("tgrep-protocol");
    expect(claudeMd).toContain(".claude/scripts/tgrep-search.sh");
  });

  // The routing table is the point of the codegraph↔tgrep synergy: two layers
  // that answer different questions, not two tools competing for the same call.
  it("routes between the graph and the wrapper instead of letting them compete", () => {
    renderClaudeEngine(cwd, CONFIG);
    const claudeMd = read("CLAUDE.md");
    expect(claudeMd).toContain("codegraph_explore");
  });

  it("injects the executor rung into the structural-search skill", () => {
    renderClaudeEngine(cwd, CONFIG);
    const skill = read(".claude/skills/structural-search/SKILL.md");
    expect(skill).toContain("tgrep-search.sh");
  });

  it("injects into all four agents that search or edit code", () => {
    renderClaudeEngine(cwd, CONFIG);
    for (const agent of ["researcher", "explorer", "implementer", "reviewer"]) {
      expect(read(`.claude/agents/${agent}.md`), `${agent} lost its injection`).toContain(
        "tgrep-search.sh",
      );
    }
  });
});
