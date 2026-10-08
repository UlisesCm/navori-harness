import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../../../../..");
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), "utf8");

describe("prTarget of this repo (spec 0044)", () => {
  // Covers: R20
  it("reviewer y publisher apuntan a main", () => {
    const config = JSON.parse(read("navori.config.json")) as { prTarget?: string };
    expect(config.prTarget).toBe("main");

    const rendered = [
      ".claude/agents/reviewer.md",
      ".claude/agents/publisher.md",
      ".codex/agents/reviewer.toml",
      ".codex/agents/publisher.toml",
    ];
    for (const rel of rendered) {
      expect(existsSync(resolve(REPO_ROOT, rel)), rel).toBe(true);
      const text = read(rel);
      expect(text, rel).toContain("origin/main");
      expect(text, rel).not.toContain("origin/dev");
    }
  });
});
