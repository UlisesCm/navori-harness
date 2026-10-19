import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const direction = readFileSync(
  resolve(import.meta.dirname, "../../../../docs/DIRECTION.md"),
  "utf-8",
);

describe("docs/DIRECTION.md states the Claude-first criterion", () => {
  // Covers: R1, R11
  it("has the admission-by-surface section", () => {
    expect(direction).toContain("## Admission criterion by surface");
  });

  // Covers: R1, R11
  it("says 'native first' and links the typed matrix doc as the source", () => {
    const sectionStart = direction.indexOf("## Admission criterion by surface");
    expect(sectionStart).toBeGreaterThanOrEqual(0);
    const section = direction.slice(sectionStart);
    expect(section).toMatch(/Claude first, native first/);
    expect(section).toContain("native-overlap.md");
  });
});
