import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanTriggerlessLocalSkills } from "../skill-triggers.ts";

/**
 * #736 — a project-local skill whose `description` declares no activation
 * trigger is installed, indexed and counted, but the host has nothing to route
 * on, so it hardly ever fires.
 *
 * The criterion is `hasTrigger` (spec 0003 §3.2.2), the same one
 * `skill-caps.test.ts` enforces on every bundled asset. Measured over the real
 * corpus it flags 0 of the 75 assets navori ships and exactly 1 of this repo's
 * 16 installed skills — `playwright-cli`, the case the issue is about.
 *
 * Scope is the hard part and gets its own cases below: only skills declared in
 * `project.localSkills`, and never one navori rendered — those are not the
 * reader's to fix.
 */

let cwd: string;
let skills: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-trigger-"));
  skills = join(cwd, ".claude", "skills");
  mkdirSync(skills, { recursive: true });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

/** Write `<id>/SKILL.md` with the given description (omit for no description). */
const writeSkill = (id: string, description?: string, extra = ""): void => {
  mkdirSync(join(skills, id), { recursive: true });
  const front = [
    "---",
    `name: ${id}`,
    ...(description ? [`description: ${description}`] : []),
    "---",
  ];
  writeFileSync(join(skills, id, "SKILL.md"), `${front.join("\n")}\n\n${extra}# ${id}\n`);
};

describe("scanTriggerlessLocalSkills — la skill local que nunca se dispara (#736)", () => {
  it("reporta una skill local cuya description solo dice qué hace", () => {
    // La description real de `playwright-cli`, el caso que motivó el check.
    writeSkill(
      "playwright-cli",
      "Automate browser interactions, test web pages and work with Playwright tests.",
    );
    expect(scanTriggerlessLocalSkills(cwd, ["playwright-cli"])).toEqual([
      { id: "playwright-cli", path: ".claude/skills/playwright-cli/SKILL.md" },
    ]);
  });

  it("NO reporta una skill local con cláusula 'Use when'", () => {
    writeSkill(
      "rest-nexus",
      "Use when adding an endpoint to the Nexus REST layer — controller, DTO and guard.",
    );
    expect(scanTriggerlessLocalSkills(cwd, ["rest-nexus"])).toEqual([]);
  });

  it("NO reporta una skill local con la condición escrita en español", () => {
    // navori renderiza en es y en en, y una skill project-local la escribe el
    // usuario en SU idioma: acotar el criterio a /^use when/i convertiría cada
    // skill bien escrita en español en un falso positivo.
    writeSkill(
      "mongoose-bonum",
      "Usar cuando toques un modelo de Mongoose — índices, lean y populate.",
    );
    expect(scanTriggerlessLocalSkills(cwd, ["mongoose-bonum"])).toEqual([]);
  });

  it("NO reporta una skill renderizada por navori aunque no traiga cláusula: no es del usuario", () => {
    // Doble límite de alcance. El id ni siquiera está declarado en localSkills,
    // que es lo que define 'project-local' en este repo.
    writeSkill("review-diff", "A code-review checklist across stack-agnostic dimensions.");
    expect(scanTriggerlessLocalSkills(cwd, [])).toEqual([]);
  });

  it("NO reporta un id declarado en localSkills cuyo archivo lleva marca managed", () => {
    // El caso de la library skill reclamada (`preset-extras.test.ts`): el id está
    // en localSkills pero el frontmatter lo escribió navori, así que arreglarlo
    // no le toca al lector.
    writeSkill(
      "zod-validation",
      "A Zod schema per resource, plus a generic validate middleware.",
      '<!-- navori:managed id="zod" -->\n',
    );
    expect(scanTriggerlessLocalSkills(cwd, ["zod-validation"])).toEqual([]);
  });

  it("reporta una skill local sin description ninguna", () => {
    writeSkill("sin-descripcion");
    expect(scanTriggerlessLocalSkills(cwd, ["sin-descripcion"]).map((s) => s.id)).toEqual([
      "sin-descripcion",
    ]);
  });

  it("NO reporta un id declarado sin archivo en disco: eso lo cubre missingLocalSkills", () => {
    expect(scanTriggerlessLocalSkills(cwd, ["fantasma"])).toEqual([]);
  });

  it("devuelve vacío cuando el repo no declara skills project-local", () => {
    writeSkill("suelta", "Does things.");
    expect(scanTriggerlessLocalSkills(cwd, [])).toEqual([]);
  });

  it("no rompe cuando el repo no tiene .claude/skills", () => {
    const vacio = mkdtempSync(join(tmpdir(), "navori-trigger-vacio-"));
    expect(scanTriggerlessLocalSkills(vacio, ["playwright-cli"])).toEqual([]);
    rmSync(vacio, { recursive: true, force: true });
  });

  it("ordena por id y no repite un id declarado dos veces", () => {
    writeSkill("zeta", "Does zeta things.");
    writeSkill("alfa", "Does alfa things.");
    expect(scanTriggerlessLocalSkills(cwd, ["zeta", "alfa", "zeta"]).map((s) => s.id)).toEqual([
      "alfa",
      "zeta",
    ]);
  });
});
