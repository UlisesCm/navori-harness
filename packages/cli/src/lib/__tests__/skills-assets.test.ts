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
 * Spec 0034 lote E, T18 — the model-invoked master-plan skill guards entry,
 * resumes the CLI-owned state machine, and leaves irreversible decisions to
 * the user. Literal checks protect the prose contracts that code cannot type.
 *
 * Covers: R1, R2, R7, R13, R16, R17, R18, R19, R20, R25, R26, R27, R28,
 * R33, R34, R40, R42, R44, R45, R46, R47, R48, R51, R52, R53, R55, R56,
 * R57, R58, R59, R60, R61, R62
 */
describe("master-plan — workflow contract (T18)", () => {
  const master = readSkill("master-plan");
  const { body, frontmatter } = parseAsset(master);

  it("is a model-invoked reference skill with an explicit word budget", () => {
    expect(master).not.toContain("disable-model-invocation:");
    expect(master).toContain("type: reference");
    expect(master).toMatch(/^  # .+\n  maxWords: \d+$/m);
    expect(parseSkillFrontmatter(master).meta.maxWords).toBeGreaterThan(500);
    expect(frontmatter.name).toBe("master-plan");
  });

  it("puts the explicit-request lock first and does not treat SessionStart as consent", () => {
    const headings = body.match(/^## .+$/gm) ?? [];
    expect(headings[0]).toMatch(/candado|pedido expl[ií]cito/i);
    expect(body).toContain("/master-plan");
    expect(body).toMatch(/s[ií], contin[uú]a/i);
    expect(body).toContain("SessionStart");
    expect(body).toMatch(
      /SessionStart[^\n]*(?:no|nunca)[^\n]*(?:pedido|consentimiento|autorizaci[oó]n)/i,
    );
  });

  it("checks prerequisites and announces the complete first-run workflow before init", () => {
    expect(body).toContain("navori.config.json");
    expect(body).toContain("navori doctor");
    const notice = body.indexOf("## Aviso de inicio");
    expect(notice).toBeGreaterThan(0);
    expect(notice).toBeLessThan(body.indexOf("navori master init"));
    const announcement = body.slice(notice, body.indexOf("navori master init"));
    for (const term of [
      "harness.masterPlan",
      "carpeta",
      "contexto",
      "convertir",
      "código",
      "architect",
      "preguntas",
      "MASTER.md",
      "STATUS.md",
      "tokens",
      "AskUserQuestion",
    ])
      expect(announcement).toContain(term);
    expect(announcement).toMatch(/slug/i);
    expect(announcement).toMatch(/etapa nueva/i);
    expect(announcement).toMatch(/última cerrada/i);
    expect(announcement).toContain("nextPhase");
  });

  it("routes active, new, and blocked stages without reopening an active one", () => {
    expect(body).toContain("navori master status --json");
    expect(body).toMatch(/fase actual/i);
    expect(body).toMatch(/etapa activa/i);
    expect(body).toMatch(/etapa nueva/i);
    expect(body).toMatch(/plan maestro nuevo[\s\S]*sin (?:ejecutar|llamar) `?navori master init/i);
    expect(body).toContain("navori master mode");
    expect(body).toMatch(/template[\s\S]*en-curso/i);
  });

  // Covers: R51
  it("opens both the first and later stages after confirmation, asking mode only for the first", () => {
    const startup = body.slice(
      body.indexOf("## Aviso de inicio"),
      body.indexOf("## Procedimiento por fase"),
    );
    expect(startup).toMatch(
      /despu[eé]s de confirmar[^.]*navori master init <slug>[^.]*primera[^.]*(?:posterior|siguiente)/i,
    );
    expect(startup).toMatch(/primera[^\n]*pregunta[^\n]*modo `template` o `en-curso`/i);
    expect(startup).toMatch(/etapas posteriores[^\n]*`en-curso` sin preguntar/i);
  });

  it("enforces per-phase checks, delegated plans, deferred scope, and evidence-based synthesis", () => {
    expect(body).toContain("navori master check");
    expect(body).toContain("navori master advance");
    expect(body).toContain("context-intake");
    expect(body).toContain("context/CODEBASE.md");
    expect(body).toContain("DIGEST.md");
    expect(body).toContain("plans/plan1.md");
    expect(body).toContain("plans/plan2.md");
    expect(body).toContain("plans/plan3.md");
    expect(body).toMatch(/mismo turno/i);
    expect(body).toContain("contextForArchitects");
    expect(body).toContain("D<n>");
    expect(body).toContain("[SUPUESTO]");
    expect(body).toContain("[SIN VERIFICAR]");
    expect(body).toContain("DECISIONS.md");
    expect(body).toContain("AskUserQuestion");
    expect(body).toContain("navori master check --fit");
    expect(body).toMatch(/J1.J3/);
    expect(body).toContain("Cambiar a spec");
    expect(body).toContain("Seguir con el plan maestro");
  });

  it("requires rigorous plans and maps each part criterion into its spec", () => {
    expect(body).toMatch(/checklist de rigor/i);
    expect(body).toMatch(/adjetiv[oa]s? sin medida/i);
    expect(body).toMatch(/criterios de aceptaci[oó]n observables/i);
    expect(body).toContain("Spec de una parte");
    expect(body).toContain("spec-bootstrap");
    expect(body).toContain("P<n>.A<m>");
    expect(body).toMatch(/R<n>/);
    expect(body).toContain("navori master check --part");
  });

  it("creates only confirmed GitHub issues and records acceptance evidence", () => {
    expect(body).toMatch(/solo GitHub/i);
    expect(body).toContain("gh issue list --search");
    expect(body).toContain("gh issue create");
    expect(body).toContain("gh auth login");
    expect(body).toMatch(/issue[^\n]*etapa/i);
    expect(body).toContain("--accept");
    expect(body).toContain("--approved-by");
    expect(body).toMatch(/manual[\s\S]*AskUserQuestion[\s\S]*Aprobado/i);
    expect(body).toMatch(/hu[eé]rfanos|atrasados/i);
  });

  it("asks for delivery, resolves unfinished parts, then closes, converts, or abandons", () => {
    expect(body).toMatch(/parte por parte/i);
    expect(body).toMatch(/hecho[\s\S]*descartada[\s\S]*diferida/i);
    expect(body).toMatch(/confirmar la entrega/i);
    expect(body).toContain("navori master close");
    expect(body).toContain("close --convert");
    expect(body.indexOf("close --convert")).toBeLessThan(body.lastIndexOf("spec-bootstrap"));
    expect(body).toContain("DIGEST.md");
    expect(body).toContain("CODEBASE.md");
    expect(body).toContain("context/md/");
    expect(body).toContain("close --abandon");
    expect(body).toMatch(/AskUserQuestion[\s\S]*close --abandon/);
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
