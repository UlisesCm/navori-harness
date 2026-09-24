import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getCoreRoot } from "../render/bundled-assets.ts";

/**
 * Shape contract for core skill assets. Skills don't carry the `tools` or
 * `model` frontmatter that agents do (skills are protocols, not agents).
 * Otherwise the contract matches agents: managed body / user-section
 * sentinel / non-empty parts.
 */

const SKILL_IDS = ["verify-before-done", "debug-failure", "plan-simple", "plan-advanced"] as const;

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
  // Both groups are mandatory in each pattern: either the match yields all of
  // them or there is no match at all, so an absent group IS a failed parse.
  const [, fmBlock, body] = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/) ?? [];
  if (fmBlock === undefined || body === undefined) throw new Error("frontmatter not found");
  const fm: Record<string, string> = {};
  for (const line of fmBlock.split("\n")) {
    const [, key, value] = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/) ?? [];
    if (key !== undefined && value !== undefined) fm[key] = value.trim();
  }
  return { frontmatter: fm, body };
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

/**
 * Spec 0032 lote 3 (#1011), T9 — `plan-simple`/`plan-advanced` carry the
 * level-1/level-2 procedure the `planificacion` context block only points
 * at (R22), plus the literal phrases `lote3_markdown.md` (sections A, B)
 * requires verbatim.
 *
 * Covers: R22, R10, R12, R13, R14, R36, R37
 */
describe("plan-simple / plan-advanced — literal content contract (T9)", () => {
  it("plan-simple's frontmatter description is the literal contract text", () => {
    expect(readSkill("plan-simple")).toContain(
      "description: Use when `navori plan classify` returns level 1 or the plan gate denies an " +
        "implementer dispatch — writes the level-1 workplan JSON, renders and checks it, and " +
        "keeps it current while the work runs. Not for level 2 (plan-advanced) or an accepted " +
        "spec (spec-bootstrap).",
    );
  });

  it("plan-simple names the workplan draft fields (R10, R13)", () => {
    const body = readSkill("plan-simple");
    expect(body).toContain(".claude/progress/workplan_<feature>.json");
    expect(body).toContain('"new": true');
  });

  it("plan-simple carries the literal encargo/update/hand-render phrases (R36, R37)", () => {
    const body = readSkill("plan-simple");
    expect(body).toContain(
      "Open every implementer encargo with `workplan: <feature>` and list the `A<n>` that sub-task covers.",
    );
    expect(body).toContain("When a sub-task closes, record it with `navori plan update`");
    expect(body).toContain(
      "Never write `workplan_<feature>.md` by hand — it is `navori plan render` output.",
    );
  });

  it("plan-advanced's frontmatter description is the literal contract text", () => {
    expect(readSkill("plan-advanced")).toContain(
      "description: Use when `navori plan classify` returns level 2 (score ≥ 8 or a floor) or " +
        "the plan gate escalates a feature after two rejections — runs the architect design, the " +
        "auditor challenge and the user's choice before the level-2 workplan. Not for level 1 " +
        "(plan-simple) or an accepted spec (spec-bootstrap).",
    );
  });

  it("plan-advanced carries the literal user-choice and knowledge-destination phrases (R23, R26)", () => {
    const body = readSkill("plan-advanced").replace(/\s+/g, " ");
    expect(body).toContain(
      "Present the surviving options to the user with the recommended one first and the " +
        "challenge findings beside each; the user picks.",
    );
    expect(body).toContain(
      "Knowledge destinations the architect proposes are proposals: write none without the " +
        "user's approval, and a Dominio entry only on explicit approval.",
    );
  });

  it("plan-advanced names the level-2 workplan's extra sections (R14)", () => {
    const body = readSkill("plan-advanced");
    expect(body).toContain("solution {path, verdict}");
    expect(body).toMatch(/phases/i);
    expect(body).toMatch(/risks? with (its |their )?rollback/i);
  });
});
