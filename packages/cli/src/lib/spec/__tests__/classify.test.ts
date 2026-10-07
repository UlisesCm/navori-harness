import { describe, expect, it } from "vitest";
import { DEFAULT_DELIVERIES } from "../../config/schema.ts";
import { classifySpec, decideGate } from "../classify.ts";
import { decideGateFromDisk } from "../gate.ts";
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

describe("decideGate", () => {
  const two = (done: string) =>
    [
      "## E1 — d",
      "### M1 — a",
      "- **A1** — c `ls` → ok",
      `- [${done}] **T1** (R1) — t · effect: behavior`,
      "### M2 — b",
      "- **A2** — c `ls` → ok",
      "- [ ] **T2** (R1) — t · effect: behavior",
      "### M3 — c",
      "- **A3** — c `ls` → ok",
      "- [ ] **T3** (R1) — t · effect: behavior",
    ].join("\n");
  const gate = (text: string, milestone: string, over = {}) => {
    const parsed = parseTasks(text);
    return decideGate(parsed, classifySpec(parsed, { ...DEFAULT_DELIVERIES, ...over }), milestone);
  };

  // Covers: R25
  it("is scoped only with unchecked work in a later milestone of the unit", () => {
    expect(gate(two("x"), "M1")).toMatchObject({
      gateKind: "scoped",
      reason: "pending-later-work",
      closingMilestone: "M3",
    });
    expect(gate(two("x"), "M2").gateKind).toBe("scoped");
  });

  // Covers: R25
  it("is full for the closing milestone", () => {
    expect(gate(two("x"), "M3")).toMatchObject({ gateKind: "full", reason: "closing-milestone" });
  });

  // Covers: R25
  it("is full when every later task is already checked (fix on an open PR)", () => {
    const done = two("x").replace(/\[ \]/g, "[x]");
    expect(gate(done, "M1")).toMatchObject({ gateKind: "full", reason: "unit-complete" });
  });

  // Covers: R25
  it("is full for legacy format, unknown milestone and unreadable tasks", () => {
    expect(gate("- [ ] a\n- [ ] b", "M1").reason).toBe("legacy-format");
    expect(gate(two("x"), "M9")).toMatchObject({ gateKind: "full", reason: "unknown-milestone" });
    const missing = decideGateFromDisk("/nonexistent-navori-dir", "s", "M1");
    expect(missing).toMatchObject({ gateKind: "full", reason: "tasks-unreadable" });
  });

  // Covers: R25
  it("scopes the unit to the delivery in split and to the whole spec in single", () => {
    const text = (loc: number) =>
      [
        "## E1 — one",
        `Estimated LOC: ${loc}`,
        "### M1 — a",
        "- **A1** — c `ls` → ok",
        "- [x] **T1** (R1) — t · effect: behavior",
        "## E2 — two",
        "### M2 — b",
        "- **A2** — c `ls` → ok",
        "- [ ] **T2** (R1) — t · effect: behavior",
      ].join("\n");
    // Split (over the LOC threshold): M1 closes E1, so E2's pending work does not make it scoped.
    expect(gate(text(2000), "M1")).toMatchObject({ gateKind: "full", unit: "E1" });
    // Single: the unit is the whole spec, so M2's pending task keeps M1 scoped.
    expect(gate(text(10), "M1")).toMatchObject({ gateKind: "scoped", unit: "spec" });
  });
});
