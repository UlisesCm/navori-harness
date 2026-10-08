import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../../../../..");
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), "utf8");

const RESEARCH = "docs/research/distribucion-entregas-agentes.md";
const EVIDENCE = "docs/research/distribucion-entregas-agentes-evidencia.md";

describe("docs of spec 0044", () => {
  // Covers: R1
  it("unidad de PR", () => {
    const direction = read("docs/DIRECTION.md");
    expect(direction).toContain("## Unidad de PR y de verificación");
    expect(direction).toContain("la entrega funcional");
    expect(direction).toContain("el milestone");
    expect(direction).toContain("sdd.deliveries");
    expect(direction).toContain("una vez por PR");
    expect(direction).toContain("distribucion-entregas-agentes.md");
  });

  // Covers: R24
  it("tabla de calibración", () => {
    const research = read(RESEARCH);
    expect(research).toContain("## Línea base 0039/0041");
    expect(research).toContain("## Tabla de calibración");
    expect(research).toContain("| Spec | Entregas | PRs | LOC | Observación |");
    expect(research).toMatch(/\|\s*0039\s*\/\s*0041\s*\|/);
    expect(research).toMatch(/\|\s*0044\s*\|[^\n]*pendiente tras el merge/);
    expect(existsSync(resolve(REPO_ROOT, EVIDENCE))).toBe(true);
    expect(research).toContain("distribucion-entregas-agentes-evidencia.md");
  });
});
