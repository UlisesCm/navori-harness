// Covers: R55
import { describe, expect, it } from "vitest";
import { evaluateFit } from "../fit.ts";

const headings = [
  "Actores",
  "Capacidades",
  "Integraciones externas",
  "Entidades de datos",
  "Superficies",
];
const limits = [3, 8, 1, 5, 1];
function digest(counts: number[], decisions = 2): string {
  return (
    headings
      .map(
        (heading, index) =>
          `## ${heading}\n${Array.from({ length: counts[index] ?? 0 }, (_, number) => `- item ${number}`).join("\n")}`,
      )
      .join("\n") +
    `\n## Hallazgos\n${Array.from({ length: decisions }, () => "- [DECISIÓN] open").join("\n")}`
  );
}

describe("D9 fit", () => {
  // Covers: R55
  it("passes all V1–V7 at their thresholds and exposes J1–J3 as judgment", () => {
    const result = evaluateFit(digest(limits), "## Stack\nBun and TypeScript");
    expect(result.verifiable.map((criterion) => criterion.id)).toEqual([
      "V1",
      "V2",
      "V3",
      "V4",
      "V5",
      "V6",
      "V7",
    ]);
    expect(result.allVerifiablePass).toBe(true);
    expect(result.judgment).toEqual(["J1", "J2", "J3"]);
  });

  // Covers: R55
  it.each([0, 1, 2, 3, 4])("fails count criterion above threshold for source %i", (index) => {
    const counts = [...limits];
    counts[index]! += 1;
    expect(
      evaluateFit(digest(counts), "## Stack\nBun").verifiable.filter(
        (criterion) => !criterion.pass,
      ),
    ).toHaveLength(1);
  });

  // Covers: R55
  it("passes V6 with a defined stack and fails only V6 when stack is open", () => {
    const passing = evaluateFit(digest(limits), "## Stack\nBun and TypeScript");
    const failing = evaluateFit(digest(limits), "## Stack\nDecisión abierta: framework");
    expect(passing.verifiable.find((criterion) => criterion.id === "V6")).toMatchObject({
      value: true,
      threshold: true,
      pass: true,
    });
    expect(
      failing.verifiable.filter((criterion) => !criterion.pass).map((criterion) => criterion.id),
    ).toEqual(["V6"]);
  });

  // Covers: R55
  it("passes V7 at two open business questions and fails only V7 at three", () => {
    const passing = evaluateFit(digest(limits, 2), "## Stack\nBun");
    const failing = evaluateFit(digest(limits, 3), "## Stack\nBun");
    expect(passing.verifiable.find((criterion) => criterion.id === "V7")).toMatchObject({
      value: 2,
      threshold: 2,
      pass: true,
    });
    expect(
      failing.verifiable.filter((criterion) => !criterion.pass).map((criterion) => criterion.id),
    ).toEqual(["V7"]);
  });

  // Covers: R55
  it("requires exactly one surface and preserves numeric JSON values for missing sections", () => {
    const result = evaluateFit(digest([3, 8, 1, 5, 0]), "## Stack\nBun");
    expect(result.verifiable.find((criterion) => criterion.id === "V5")).toMatchObject({
      value: 0,
      threshold: 1,
      pass: false,
    });
    expect(JSON.parse(JSON.stringify(result))).toMatchObject({
      allVerifiablePass: false,
      judgment: ["J1", "J2", "J3"],
    });
  });
});
