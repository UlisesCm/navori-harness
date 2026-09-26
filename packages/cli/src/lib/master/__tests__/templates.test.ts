// Covers: R12, R18, R21, R29, R30, R31, R42, R55, R59
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveTemplatePath,
  splitTemplateSections,
  templateHeaders,
  printTemplate,
  printIssueTemplate,
} from "../templates.ts";
import type { Part } from "../schema.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "navori-master-templates-"));
  mkdirSync(join(root, "core-assets", "master-plan", "en"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeTemplate(name: string, content: string, language: "es" | "en" = "es"): void {
  const dir =
    language === "es"
      ? join(root, "core-assets", "master-plan")
      : join(root, "core-assets", "master-plan", "en");
  writeFileSync(join(dir, `${name}.md`), content);
}

const PLAN_FIXTURE = [
  "## Metadatos",
  "",
  "Proyecto, etapa, fecha.",
  "",
  "## Resumen ejecutivo",
  "",
  "Un párrafo.",
  "",
  "## Estado actual vs. objetivo",
  "<!-- only-mode: en-curso -->",
  "",
  "Solo en modo en-curso.",
  "",
  "## Entrega en partes",
  "",
  "P<n> con objetivo.",
  "",
].join("\n");

describe("splitTemplateSections — parsing", () => {
  it("splits into headings with their body, no literal header list needed", () => {
    const sections = splitTemplateSections(PLAN_FIXTURE);
    expect(sections.map((s) => s.heading)).toEqual([
      "Metadatos",
      "Resumen ejecutivo",
      "Estado actual vs. objetivo",
      "Entrega en partes",
    ]);
  });

  it("reads the only-mode marker and strips it from the exposed body", () => {
    const sections = splitTemplateSections(PLAN_FIXTURE);
    const gated = sections.find((s) => s.heading === "Estado actual vs. objetivo")!;
    expect(gated.onlyMode).toBe("en-curso");
    expect(gated.body).not.toContain("only-mode");
    expect(gated.body).toContain("Solo en modo en-curso.");
  });

  it("leaves unconditional sections with onlyMode null", () => {
    const sections = splitTemplateSections(PLAN_FIXTURE);
    expect(sections.find((s) => s.heading === "Metadatos")!.onlyMode).toBeNull();
  });
});

describe("templateHeaders — mode filtering (R18)", () => {
  it("en-curso includes 'Estado actual vs. objetivo'", () => {
    writeTemplate("plan", PLAN_FIXTURE);
    const headers = templateHeaders("plan", "es", "en-curso", { root });
    expect(headers).toContain("Estado actual vs. objetivo");
  });

  it("template mode excludes it", () => {
    writeTemplate("plan", PLAN_FIXTURE);
    const headers = templateHeaders("plan", "es", "template", { root });
    expect(headers).not.toContain("Estado actual vs. objetivo");
    expect(headers).toEqual(["Metadatos", "Resumen ejecutivo", "Entrega en partes"]);
  });
});

describe("printTemplate — output filtered to mode", () => {
  it("template mode omits the gated section body too", () => {
    writeTemplate("plan", PLAN_FIXTURE);
    const printed = printTemplate("plan", "es", "template", { root });
    expect(printed).not.toContain("Estado actual vs. objetivo");
    expect(printed).toContain("## Metadatos");
  });
});

describe("templateHeaders — digest's eight sections (R12)", () => {
  it("reads all eight fixed sections from the file", () => {
    const digest = [
      "## Resumen por archivo",
      "x",
      "## Hechos",
      "x",
      "## Actores",
      "x",
      "## Capacidades",
      "x",
      "## Integraciones externas",
      "x",
      "## Entidades de datos",
      "x",
      "## Superficies",
      "x",
      "## Hallazgos",
      "x",
    ].join("\n");
    writeTemplate("digest", digest);
    expect(templateHeaders("digest", "es", null, { root })).toEqual([
      "Resumen por archivo",
      "Hechos",
      "Actores",
      "Capacidades",
      "Integraciones externas",
      "Entidades de datos",
      "Superficies",
      "Hallazgos",
    ]);
  });
});

describe("resolveTemplatePath — language fallback (matches resolveAssetPath's rule)", () => {
  it("serves the Spanish base directly when language is es", () => {
    writeTemplate("plan", PLAN_FIXTURE);
    const { path, fallback } = resolveTemplatePath("plan", "es", { root });
    expect(path).toBe(join(root, "core-assets", "master-plan", "plan.md"));
    expect(fallback).toBe(false);
  });

  it("serves the English sibling when it exists", () => {
    writeTemplate("plan", PLAN_FIXTURE);
    writeTemplate("plan", "## Metadata\n\nProject, stage.\n", "en");
    const { path, fallback } = resolveTemplatePath("plan", "en", { root });
    expect(path).toBe(join(root, "core-assets", "master-plan", "en", "plan.md"));
    expect(fallback).toBe(false);
  });

  it("falls back to the Spanish base when no English translation exists yet", () => {
    writeTemplate("plan", PLAN_FIXTURE);
    const { path, fallback } = resolveTemplatePath("plan", "en", { root });
    expect(path).toBe(join(root, "core-assets", "master-plan", "plan.md"));
    expect(fallback).toBe(true);
  });
});

describe("printIssueTemplate — filled from parts.json (R42)", () => {
  const part: Part = {
    id: "P3",
    title: "Cobros",
    objective: "Cobrar suscripciones",
    scope: ["Checkout", "Facturas"],
    outOfScope: ["Reembolsos"],
    dependsOn: ["P1"],
    seedRequirements: [],
    acceptance: [
      {
        id: "A1",
        description: "El checkout cobra",
        method: "test",
        test: { file: "specs/pagos/tests/checkout.test.ts", case: "cobra" },
        evidence: null,
      },
    ],
    inheritedFrom: null,
    state: "pendiente",
    reason: null,
    spec: null,
    issue: null,
  };

  it("fills objective, scope, out-of-scope, dependencies, acceptance and the MASTER.md path", () => {
    writeTemplate(
      "issue",
      [
        "# [{{stage}}] {{partId}} — {{title}}",
        "",
        "## Objetivo",
        "",
        "{{objective}}",
        "",
        "## Alcance",
        "",
        "{{scope}}",
        "",
        "## Fuera de alcance",
        "",
        "{{outOfScope}}",
        "",
        "## Dependencias",
        "",
        "{{dependsOn}}",
        "",
        "## Criterios de aceptación",
        "",
        "{{acceptance}}",
        "",
        "## Plan maestro",
        "",
        "{{masterPath}}",
        "",
      ].join("\n"),
    );
    const out = printIssueTemplate(part, "02-pagos", "specs", "es", { root });
    expect(out).toContain("[02-pagos] P3 — Cobros");
    expect(out).toContain("Cobrar suscripciones");
    expect(out).toContain("- Checkout");
    expect(out).toContain("- Reembolsos");
    expect(out).toContain("P1");
    expect(out).toContain("P3.A1 (test): El checkout cobra");
    expect(out).toContain("specs/_master/02-pagos/MASTER.md");
  });

  it("fills empty lists with the English 'None'/'No' markers for an 'en' stage, never mixing in Spanish (R42 i18n)", () => {
    writeTemplate(
      "issue",
      [
        "# [{{stage}}] {{partId}} — {{title}}",
        "",
        "## Objective",
        "",
        "{{objective}}",
        "",
        "## Scope",
        "",
        "{{scope}}",
        "",
        "## Out of scope",
        "",
        "{{outOfScope}}",
        "",
        "## Dependencies",
        "",
        "{{dependsOn}}",
        "",
        "## Acceptance criteria",
        "",
        "{{acceptance}}",
        "",
        "## Master plan",
        "",
        "{{masterPath}}",
        "",
      ].join("\n"),
      "en",
    );
    const emptyPart: Part = {
      id: "P1",
      title: "Empty",
      objective: "x",
      scope: [],
      outOfScope: [],
      dependsOn: [],
      seedRequirements: [],
      acceptance: [],
      inheritedFrom: null,
      state: "pendiente",
      reason: null,
      spec: null,
      issue: null,
    };
    const out = printIssueTemplate(emptyPart, "01-mvp", "specs", "en", { root });
    expect(out).toContain("None");
    expect(out).not.toContain("Ninguno");
    expect(out).not.toContain("Ninguna");
  });
});
