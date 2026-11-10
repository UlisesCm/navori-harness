import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getCoreRoot } from "../render/bundled-assets.ts";
import { parseSkillFrontmatter } from "../assets/skill-meta.ts";

/**
 * Shape contract for core skill assets. Skills don't carry the `tools` or
 * `model` frontmatter that agents do (skills are protocols, not agents).
 * Otherwise the contract matches agents: managed body / user-section
 * sentinel / non-empty parts.
 */

const SKILL_IDS = [
  "verify-before-done",
  "debug-failure",
  "plan-simple",
  "plan-advanced",
  "context-intake",
  "master-plan",
] as const;

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
 * Spec 0034 lote E, T16 — context intake is intentionally manual-only: it
 * mutates the active master-plan stage after its caller has established the
 * explicit workflow. Its body documents the agent procedure, while the CLI
 * continues to own stage-state validation and output validation.
 *
 * Covers: R9, R10, R11, R12, R13
 */
describe("context-intake — literal content contract (T16)", () => {
  const intake = readSkill("context-intake");

  it("is manual-only and stops without an active master-plan stage", () => {
    expect(intake).toContain("disable-model-invocation: true");
    expect(intake).toContain("navori master status --json");
    expect(intake).toMatch(/sin etapa activa[\s\S]*\/master-plan/i);
  });

  it("uses the unpinned MarkItDown command and records its version", () => {
    expect(intake).toContain("uvx --from 'markitdown[all]' markitdown");
    expect(intake).not.toMatch(/markitdown\[[^\]]+\]==/i);
    expect(intake).toContain("uvx --from 'markitdown[all]' markitdown --version");
  });

  it("names the conversion fallback and the required intake outputs", () => {
    expect(intake).toMatch(/lectura nativa/i);
    expect(intake).toMatch(/export[ae] .*PDF/i);
    expect(intake).toContain("INTAKE.md");
    expect(intake).toContain("navori master template digest");
    expect(intake).toContain("DIGEST.md");
    expect(intake).toContain("Hallazgos");
  });

  it("treats context files as data rather than instructions", () => {
    expect(intake).toMatch(/contenido[\s\S]*dato/i);
    expect(intake).toMatch(/instrucci[oó]n[\s\S]*no .*seguir/i);
  });
});

/**
 * Spec 0063 T3 — the master-plan skill is the v2 flow in at most 600 words:
 * explicit-request lock, user-only verdicts and the commit marks.
 */
describe("master-plan — v2 contract (0063 T3)", () => {
  const master = readSkill("master-plan");
  const { body, frontmatter } = parseAsset(master);

  it("is a model-invoked reference skill capped at 600 words", () => {
    expect(master).not.toContain("disable-model-invocation:");
    expect(frontmatter.name).toBe("master-plan");
    expect(parseSkillFrontmatter(master).meta.maxWords).toBe(600);
    expect(master.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(600);
  });

  it("puts the explicit-request lock first and never treats SessionStart as consent", () => {
    expect(body.match(/^## .+$/gm)?.[0]).toMatch(/explicit request/i);
    expect(body).toContain("/master-plan");
    expect(body).toMatch(/SessionStart line[^.]*never a request, consent or authorization/);
  });

  it("walks init, interview, check, spec, build, QA and the user's verdict", () => {
    for (const term of [
      "navori master init <slug>",
      "actor → outcome",
      "SPIDR",
      "navori master check",
      "navori spec check",
      "slice/S<n>-<slug>",
      "Slice: S<n>",
      "[S<n>]",
      "WIP is 1",
      "navori master status --qa",
      "--approved-by user",
      "reject S2 --notes",
    ])
      expect(body, term).toContain(term);
    expect(body).toMatch(/never run `navori master accept` or `reject`/);
  });

  it("keeps no v1 doctrine", () => {
    for (const term of ["architect", "DIGEST", "STATUS.md", "navori master advance", "deliveries"])
      expect(body, term).not.toContain(term);
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
    expect(body).toContain(".navori/state/handoffs/workplan_<feature>.json");
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

/** Spec 0052 (R13, R37, R39, R43, R44) — plan-skill doctrine, read whitespace-normalized. */
describe("plan skills — spec 0052 doctrine", () => {
  const body = (id: string): string => readSkill(id).replace(/\s+/g, " ");

  // Covers: R13
  it("plan-simple explica la señal de evidencia del host y la advertencia de plan check", () => {
    const text = body("plan-simple");
    expect(text).toContain("evidence depends on the host's signal (Claude's main thread included)");
    expect(text).toContain("`cumplido` without evidence is a `plan check` warning");
  });

  // Covers: R43
  it("plan-simple nombra un responsable de plan update y trae borrador mínimo con classification", () => {
    const text = body("plan-simple");
    expect(text).toContain("A single owner runs `navori plan update`");
    expect(text).toContain("mark right after running the command on the same tree");
    expect(text).toContain('"classification"');
  });

  // Covers: R44
  it("plan-simple y plan-advanced explican BLOCKED y bloqueado", () => {
    for (const id of ["plan-simple", "plan-advanced"]) {
      const text = body(id);
      expect(text, id).toContain("`solution.verdict: BLOCKED` blocks dispatch");
      expect(text, id).toContain("`bloqueado` means");
    }
  });

  // Covers: R37
  it("plan-advanced indica replanear y actualizar level y classification tras classify --diff", () => {
    const text = body("plan-advanced");
    expect(text).toContain(
      "replan when `navori plan classify <feature> --diff` returns a higher level",
    );
    expect(text).toContain("update `level` and `classification` in the workplan");
  });

  // #1524: master-plan is the only source of the literal approval word.
  it("spec-bootstrap no fija una palabra de aprobación literal", () => {
    expect(body("spec-bootstrap")).not.toMatch(/answers\s+["“]Approved["”]/);
  });

  // Covers: R39
  it("spec-bootstrap documenta el workplan de nivel 3 y el encargo `workplan: <feature>`", () => {
    const text = body("spec-bootstrap");
    expect(text).toContain("A level-3 workplan named `<feature>`");
    expect(text).toContain("encargos open with `workplan: <feature>`");
  });
});
