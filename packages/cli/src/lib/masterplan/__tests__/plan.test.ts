import { describe, expect, it } from "vitest";
import { checkPlan, parsePlan } from "../plan.ts";

const PLAN = `# Plan: Demo

## Objetivo

Un socio ficticio usa la app de punta a punta.

## Aceptación

- Entorno: qa — https://qa.example.test
- Rama de aceptación: qa
- Rama destino: dev
- WIP: 1

## Slices

| ID | Actor → resultado | Spec | Commit |
|---|---|---|---|
| S1 | Socio → se registra con su correo | specs/s1/spec.md | |
| S2 | Socio → ve su historial | | abc1234 |

## Decisiones

| ID | Decisión |
|---|---|
| D1 | Login solo por correo |
`;

describe("parsePlan", () => {
  it("reads acceptance, slices and decisions", () => {
    const plan = parsePlan(PLAN);
    expect(plan.acceptance).toEqual({
      env: "qa",
      url: "https://qa.example.test",
      branch: "qa",
      target: "dev",
      wip: 1,
    });
    expect(plan.slices).toEqual([
      {
        id: "S1",
        outcome: "Socio → se registra con su correo",
        spec: "specs/s1/spec.md",
        commit: "",
      },
      { id: "S2", outcome: "Socio → ve su historial", spec: "", commit: "abc1234" },
    ]);
    expect(plan.decisions).toEqual([{ id: "D1", text: "Login solo por correo" }]);
  });

  it("accepts English headings and keys", () => {
    const en = PLAN.replace("## Objetivo", "## Goal")
      .replace("## Aceptación", "## Acceptance")
      .replace("Entorno:", "Environment:")
      .replace("Rama de aceptación:", "Acceptance branch:")
      .replace("Rama destino:", "Target branch:")
      .replace("## Decisiones", "## Decisions");
    expect(parsePlan(en).acceptance.branch).toBe("qa");
    expect(checkPlan(en).filter((f) => f.severity === "error")).toEqual([]);
  });

  it("defaults the WIP limit to 1", () => {
    expect(parsePlan(PLAN.replace("- WIP: 1\n", "")).acceptance.wip).toBe(1);
  });
});

describe("checkPlan", () => {
  const errors = (text: string): string[] =>
    checkPlan(text)
      .filter((f) => f.severity === "error")
      .map((f) => f.message);

  it("passes a complete one-page plan", () => {
    expect(errors(PLAN)).toEqual([]);
  });

  it("flags a horizontal slice", () => {
    const text = PLAN.replace(
      "| S2 | Socio → ve su historial |",
      "| S3 | Todo el backend de pagos |",
    );
    expect(errors(text).join("\n")).toMatch(/S3.*horizontal/);
  });

  it("requires actor → outcome, unique S<n> ids and the acceptance keys", () => {
    const text = PLAN.replace("Socio → ve su historial", "historial")
      .replace("| S1 |", "| S2 |")
      .replace("- Rama destino: dev\n", "");
    const found = errors(text).join("\n");
    expect(found).toMatch(/S2.*actor → resultado/);
    expect(found).toMatch(/S2.*duplicad/);
    expect(found).toMatch(/Rama destino/);
  });

  it("requires the sections and a non-empty index", () => {
    const found = errors("# Plan\n\n## Slices\n\n| ID | Actor → resultado |\n|---|---|\n").join(
      "\n",
    );
    expect(found).toMatch(/Objetivo/);
    expect(found).toMatch(/Aceptación/);
    expect(found).toMatch(/índice vacío/);
  });

  it("caps the plan at one page", () => {
    expect(errors(`${PLAN}\n${"palabra ".repeat(1200)}`).join("\n")).toMatch(/una página/);
  });
});
