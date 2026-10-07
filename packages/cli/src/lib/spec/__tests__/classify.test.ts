import { describe, expect, it } from "vitest";
import { DEFAULT_DELIVERIES } from "../../config/schema.ts";
import { classifySpec } from "../classify.ts";
import { parseTasks } from "../tasks.ts";

/** A tasks.md with `deliveries` deliveries, `tasks` tasks and `loc` LOC in the first. */
function spec(deliveries: number, tasks: number, loc: number | undefined): string {
  const out: string[] = [];
  let task = 0;
  for (let d = 1; d <= deliveries; d += 1) {
    out.push(`## E${d} — d${d}`);
    if (loc !== undefined && d === 1) out.push(`Estimated LOC: ${loc}`);
    out.push(`### M${d} — m${d}`, `- **A${d}** — c \`ls\` → ok`);
    const share = Math.floor(tasks / deliveries) + (d <= tasks % deliveries ? 1 : 0);
    for (let i = 0; i < share; i += 1) {
      task += 1;
      out.push(`- [ ] **T${task}** (R1) — t · effect: behavior`);
    }
  }
  return out.join("\n");
}

const classify = (text: string, over = {}) =>
  classifySpec(parseTasks(text), { ...DEFAULT_DELIVERIES, ...over });

// Covers: R5, R6
describe("classifySpec — bordes 12/13, 1500/1501, 1 y 2 entregas, tope", () => {
  it("is split only past 12 tasks (strict), with two deliveries", () => {
    expect(classify(spec(2, 12, undefined)).shape).toBe("single");
    const over = classify(spec(2, 13, undefined));
    expect(over.shape).toBe("split");
    expect(over.prCount).toBe(2);
    expect(over.signals.exceedsTasks).toBe(true);
  });

  it("is split only past 1500 LOC (strict)", () => {
    expect(classify(spec(2, 2, 1500)).shape).toBe("single");
    const over = classify(spec(2, 2, 1501));
    expect(over.shape).toBe("split");
    expect(over.signals.exceedsLoc).toBe(true);
  });

  it("never splits a single delivery, however large", () => {
    const one = classify(spec(1, 50, 9000));
    expect(one.shape).toBe("single");
    expect(one.prCount).toBe(1);
    expect(one.warnings.map((w) => w.rule)).not.toContain("merged-deliveries");
  });

  it("warns that two deliveries under both thresholds merge into one PR", () => {
    const merged = classify(spec(2, 4, 100));
    expect(merged.shape).toBe("single");
    expect(merged.prCount).toBe(1);
    expect(merged.warnings.map((w) => w.rule)).toContain("merged-deliveries");
  });

  it("honors configured thresholds", () => {
    expect(classify(spec(2, 4, undefined), { splitMinTasks: 3 }).shape).toBe("split");
  });

  it("counts an undeclared LOC as 0 and warns per delivery", () => {
    const result = classify(spec(2, 13, undefined));
    expect(result.signals).toMatchObject({ estimatedLoc: 0, locDeclared: false });
    expect(result.warnings.filter((w) => w.rule === "loc-undeclared")).toHaveLength(2);
  });

  it("marks the closing milestone of each PR unit", () => {
    const split = classify(spec(2, 13, undefined));
    expect(split.deliveries.map((d) => d.milestones.map((m) => m.closesUnit))).toEqual([
      [true],
      [true],
    ]);
    const merged = classify(spec(2, 4, 100));
    expect(merged.deliveries.map((d) => d.milestones.map((m) => m.closesUnit))).toEqual([
      [false],
      [true],
    ]);
  });

  it("treats the previous format as one single delivery with a warning", () => {
    const legacy = classify(Array.from({ length: 20 }, (_, i) => `- [ ] task ${i}`).join("\n"));
    expect(legacy).toMatchObject({ format: "legacy", shape: "single", prCount: 1 });
    expect(legacy.signals).toMatchObject({ tasks: 20, deliveries: 1 });
    expect(legacy.warnings.map((w) => w.rule)).toEqual(["legacy-format", "single-over-threshold"]);
    expect(legacy.error).toBeNull();
  });
});

// Covers: R7
describe("classifySpec — maxPrsPerSpec cap", () => {
  it("accepts maxPrsPerSpec deliveries and errors on one more", () => {
    expect(classify(spec(4, 13, undefined)).error).toBeNull();
    const result = classify(spec(5, 13, undefined));
    expect(result.error?.rule).toBe("too-many-deliveries");
    expect(result.error?.what).toContain("5 deliveries");
    expect(result.error?.fix).toContain("split the spec");
  });
});
