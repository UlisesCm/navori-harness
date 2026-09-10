import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scanFlatSkills } from "../flat-skills.ts";

/**
 * #626 — a `.md` loose in a skills root is not a skill.
 *
 * Claude Code's "Choose where skills load" table lists five locations and every
 * one is `<skill-name>/SKILL.md`. The flat shape belongs to `.claude/commands/`,
 * a different feature. Comparable projects agree: gentle-ai's registry scans
 * `<root>/<skill>/SKILL.md` ("the Agent Skills layout"), and obra/superpowers —
 * a library of nothing but skills — ships zero loose `.md` in its skills root.
 *
 * What makes this worth a check rather than a doc line: the failure is SILENT.
 * Four skills sat in `~/.claude/skills/` in the flat shape for ~3 months and
 * nothing ever said a word.
 *
 * `~/.claude/skills` is mocked away in every case here. The scan reads it for
 * real, and the suite must never depend on — or report — what the developer
 * running it happens to have on their machine (#404/#424).
 */

vi.mock("../home.ts", () => ({ safeHomedir: () => "" }));

let cwd: string;
let skills: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-flat-"));
  skills = join(cwd, ".claude", "skills");
  mkdirSync(skills, { recursive: true });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const write = (rel: string, body = "# skill\n"): void => {
  const full = join(skills, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body);
};

describe("scanFlatSkills — el .md suelto que nunca carga (#626)", () => {
  it("no reporta nada cuando todas las skills están en forma de directorio", () => {
    write("brainstorming/SKILL.md");
    write("review-diff/SKILL.md");
    expect(scanFlatSkills(cwd)).toEqual([]);
  });

  it("reporta un .md suelto y dice a dónde moverlo", () => {
    write("systematic-debug.md");
    const found = scanFlatSkills(cwd);
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual({
      path: ".claude/skills/systematic-debug.md",
      id: "systematic-debug",
      suggested: ".claude/skills/systematic-debug/SKILL.md",
    });
  });

  it("NO reporta un .md dentro de una skill: es material de apoyo", () => {
    // obra/superpowers los usa (`brainstorming/visual-companion.md`), los
    // referencia desde su SKILL.md, y son perfectamente válidos. Reportarlos
    // convertiría el check en ruido sobre una biblioteca bien construida.
    write("brainstorming/SKILL.md");
    write("brainstorming/visual-companion.md");
    write("brainstorming/spec-reviewer-prompt.md");
    expect(scanFlatSkills(cwd)).toEqual([]);
  });

  it("NO reporta README.md en la raíz: documenta la carpeta, no es una skill fallida", () => {
    write("README.md");
    expect(scanFlatSkills(cwd)).toEqual([]);
  });

  it("reporta el suelto y calla sobre el directorio, en el mismo repo", () => {
    write("bien/SKILL.md");
    write("mal.md");
    expect(scanFlatSkills(cwd).map((f) => f.id)).toEqual(["mal"]);
  });

  it("no rompe cuando el repo no tiene .claude/skills", () => {
    const vacio = mkdtempSync(join(tmpdir(), "navori-flat-vacio-"));
    expect(scanFlatSkills(vacio)).toEqual([]);
    rmSync(vacio, { recursive: true, force: true });
  });

  it("ignora lo que no es .md", () => {
    write("notas.txt", "no soy una skill");
    expect(scanFlatSkills(cwd)).toEqual([]);
  });
});
