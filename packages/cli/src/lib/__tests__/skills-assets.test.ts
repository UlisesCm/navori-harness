import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getCoreRoot } from "../bundled-assets.ts";

/**
 * Shape contract for core skill assets. Skills don't carry the `tools` or
 * `model` frontmatter that agents do (skills are protocols, not agents).
 * Otherwise the contract matches agents: managed body / user-section
 * sentinel / non-empty parts.
 */

const SKILL_IDS = ["verify-before-done", "loop-back-debug"] as const;

const SENTINEL = "<!-- navori:user-section -->";

interface ParsedAsset {
  frontmatter: Record<string, string>;
  body: string;
}

function readSkill(id: string): string {
  const path = resolve(getCoreRoot(), "core-assets", "skills", `${id}.md`);
  expect(existsSync(path), `skill asset missing: ${path}`).toBe(true);
  return readFileSync(path, "utf-8");
}

function parseAsset(raw: string): ParsedAsset {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error("frontmatter not found");
  const fm: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return { frontmatter: fm, body: m[2] };
}

describe("core skill assets — shape contract", () => {
  for (const id of SKILL_IDS) {
    describe(id, () => {
      const raw = readSkill(id);
      const parsed = parseAsset(raw);

      it("has frontmatter with name + description", () => {
        expect(parsed.frontmatter.name).toBe(id);
        expect(parsed.frontmatter.description?.length ?? 0).toBeGreaterThan(40);
      });

      it("contains the user-section sentinel exactly once", () => {
        const count = (
          raw.match(new RegExp(SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []
        ).length;
        expect(count).toBe(1);
      });

      it("has non-empty managed body before the sentinel", () => {
        const idx = parsed.body.indexOf(SENTINEL);
        expect(idx).toBeGreaterThan(0);
        const managed = parsed.body.slice(0, idx).trim();
        expect(managed.length).toBeGreaterThan(200);
        expect(managed.startsWith("#")).toBe(true);
      });

      it("has non-empty user-section template after the sentinel", () => {
        const idx = parsed.body.indexOf(SENTINEL);
        const userTpl = parsed.body.slice(idx + SENTINEL.length).trim();
        expect(userTpl.length).toBeGreaterThan(40);
        expect(userTpl).toMatch(/<!--\s*user:/);
      });
    });
  }
});

describe("core skill assets — interpolation placeholders", () => {
  it("verify-before-done references qualityGate", () => {
    expect(readSkill("verify-before-done")).toContain("{{qualityGate.");
  });

  it("verify-before-done references branchBase (PR pre-flight)", () => {
    expect(readSkill("verify-before-done")).toContain("{{branchBase}}");
  });
});
