import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_DELIVERIES } from "../../config/schema.ts";
import { checkSpec } from "../check.ts";
import { classifySpec } from "../classify.ts";
import { parseRequirementIds } from "../requirements.ts";
import { parseTasks } from "../tasks.ts";

// packages/cli/src/lib/spec/__tests__ → repo root is six levels up.
const SPECS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
  "..",
  "specs",
);

const features = readdirSync(SPECS).filter((name) => existsSync(join(SPECS, name, "tasks.md")));

// Covers: R14
describe("todas las specs reales", () => {
  it("finds the repo's specs", () => {
    expect(features.length).toBeGreaterThan(10);
  });

  it.each(features)("%s: check and classify raise no error", (feature) => {
    const text = readFileSync(join(SPECS, feature, "tasks.md"), "utf8");
    const requirementsFile = join(SPECS, feature, "requirements.md");
    const requirements = existsSync(requirementsFile)
      ? parseRequirementIds(readFileSync(requirementsFile, "utf8"))
      : undefined;
    const parsed = parseTasks(text);
    const result = checkSpec(parsed, DEFAULT_DELIVERIES, requirements);
    expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(result.ok).toBe(true);
    expect(classifySpec(parsed, DEFAULT_DELIVERIES).error).toBeNull();
    if (parsed.format === "legacy") {
      const generic = text
        .split(/\r?\n/)
        .filter((l) => /^- \[[ xX]\] /.test(l) && !/^- \[[ xX]\] ~~T\d+~~/.test(l));
      // Fenced examples inside a legacy file may add generic matches the parser rightly skips.
      expect(parsed.legacyTaskCount).toBeLessThanOrEqual(generic.length);
    }
  });
});
