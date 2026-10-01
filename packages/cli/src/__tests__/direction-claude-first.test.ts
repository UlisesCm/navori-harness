import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const direction = readFileSync(
  resolve(import.meta.dirname, "../../../../docs/DIRECTION.md"),
  "utf-8",
);

describe("docs/DIRECTION.md states the Claude-first criterion", () => {
  // Covers: R1
  it("has the admission-by-surface section", () => {
    expect(direction).toContain("Criterio de admisión por superficie");
  });

  // Covers: R1, R2
  it("says 'nativo primero' and links the typed matrix doc as the source", () => {
    const section = direction.slice(direction.indexOf("Criterio de admisión por superficie"));
    expect(section).toMatch(/Claude primero, nativo primero/);
    expect(section).toContain("native-overlap.md");
  });
});
