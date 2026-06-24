import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getCoreRoot } from "../bundled-assets.ts";

/**
 * Sanity checks for the 7 agent assets shipped with @navori/core.
 * These don't validate semantic content (that's a human review concern);
 * they validate the shape contract the engine adapter (E1) will rely on:
 *
 *   - YAML frontmatter with `name`, `description`, `tools`, `model`.
 *   - A `<!-- navori:user-section -->` sentinel separating managed body
 *     from user-section template.
 *   - Non-empty content on both sides of the sentinel.
 *
 * If you add a new agent role, add it to AGENT_IDS below.
 */

const AGENT_IDS = [
  "leader",
  "implementer",
  "reviewer",
  "researcher",
  "ticket-audit",
  "commit-pr-pilot",
  "explorer",
] as const;

const SENTINEL = "<!-- navori:user-section -->";

interface ParsedAsset {
  frontmatter: Record<string, string>;
  body: string;
}

function readAgent(id: string): string {
  const path = resolve(getCoreRoot(), "core-assets", "agents", `${id}.md`);
  expect(existsSync(path), `agent asset missing: ${path}`).toBe(true);
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

describe("core agent assets — shape contract", () => {
  for (const id of AGENT_IDS) {
    describe(id, () => {
      const raw = readAgent(id);
      const parsed = parseAsset(raw);

      it("has frontmatter with name, description, tools, model", () => {
        expect(parsed.frontmatter.name).toBe(id);
        expect(parsed.frontmatter.description?.length ?? 0).toBeGreaterThan(20);
        expect(parsed.frontmatter.tools?.length ?? 0).toBeGreaterThan(0);
        // `model:` must be present; value is a placeholder like `{{models.X}}`
        expect(parsed.frontmatter.model?.length ?? 0).toBeGreaterThan(0);
      });

      it("`model:` references a `models.X` interpolation key", () => {
        expect(parsed.frontmatter.model).toMatch(/\{\{\s*models\.[a-zA-Z]+\s*\}\}/);
      });

      it("contains the user-section sentinel exactly once", () => {
        const count = (raw.match(new RegExp(SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
        expect(count).toBe(1);
      });

      it("has non-empty managed body before the sentinel", () => {
        const idx = parsed.body.indexOf(SENTINEL);
        expect(idx).toBeGreaterThan(0);
        const managed = parsed.body.slice(0, idx).trim();
        expect(managed.length).toBeGreaterThan(200);
        // Body must start with a heading (the agent's title).
        expect(managed.startsWith("#")).toBe(true);
      });

      it("has non-empty user-section template after the sentinel", () => {
        const idx = parsed.body.indexOf(SENTINEL);
        const userTpl = parsed.body.slice(idx + SENTINEL.length).trim();
        expect(userTpl.length).toBeGreaterThan(40);
        // Must contain a placeholder comment for the user to fill in.
        expect(userTpl).toMatch(/<!--\s*user:/);
      });
    });
  }
});

describe("core agent assets — interpolation placeholders", () => {
  it("at least one agent references qualityGate (proves wiring path exists)", () => {
    const anyRefs = AGENT_IDS.some((id) =>
      readAgent(id).includes("{{qualityGate."),
    );
    expect(anyRefs).toBe(true);
  });

  it("at least one agent references branchBase", () => {
    const anyRefs = AGENT_IDS.some((id) => readAgent(id).includes("{{branchBase}}"));
    expect(anyRefs).toBe(true);
  });

  it("commit-pr-pilot opens PRs against prTarget (gh pr create --base)", () => {
    expect(readAgent("commit-pr-pilot")).toContain("--base {{prTarget}}");
  });

  it("at least one agent references project.criticalAreas", () => {
    const anyRefs = AGENT_IDS.some((id) =>
      readAgent(id).includes("{{project.criticalAreas}}"),
    );
    expect(anyRefs).toBe(true);
  });
});
