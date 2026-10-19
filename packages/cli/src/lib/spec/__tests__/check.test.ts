import { describe, expect, it } from "vitest";
import { DEFAULT_DELIVERIES } from "../../config/schema.ts";
import { checkSpec, type FindingRule } from "../check.ts";
import { parseRequirementIds } from "../requirements.ts";
import { parseTasks } from "../tasks.ts";

const OK_A = "- **A1** [observable] — c `ls` → ok";
const behavior = (id: number, r = "R1"): string => `- [ ] **T${id}** (${r}) — t · effect: behavior`;

function check(text: string, requirements: readonly string[] | undefined = ["R1"]) {
  return checkSpec(parseTasks(text), DEFAULT_DELIVERIES, requirements);
}

function rules(text: string, requirements?: readonly string[] | undefined): FindingRule[] {
  return check(text, requirements).findings.map((f) => f.rule);
}

const master = (prTarget = "main") => ({
  deliveries: [{ id: "E1", prTarget, integrationTarget: "main" }],
  prTarget: "main",
});

const valid = ["## E1 — d", "### M1 — m", OK_A, behavior(1)].join("\n");

/** Six nonempty deliveries with 30 checked active tasks and declared acceptance. */
function completedSpec(): string {
  return Array.from({ length: 6 }, (_, i) =>
    [
      `## E${i + 1} — d`,
      "Estimated LOC: 300",
      `### M${i + 1} — m`,
      `- **A${i + 1}** [observable] — c \`ls\` → ok`,
      ...Array.from({ length: 5 }, (_, j) => behavior(i * 5 + j + 1).replace("[ ]", "[x]")),
    ].join("\n"),
  ).join("\n");
}

describe("parseRequirementIds", () => {
  // Covers: R11
  it("reads **R<n>** items and ignores fences and prose mentions", () => {
    const text = [
      "- **R1** — a",
      "- **R2** — b",
      "```",
      "- **R9** — fake",
      "```",
      "see **R7** here",
    ].join("\n");
    expect(parseRequirementIds(text)).toEqual(["R1", "R2"]);
  });
});

describe("checkSpec — una regla por caso", () => {
  // Covers: R10, R11
  it("accepts a well-formed spec", () => {
    const result = check(valid);
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  // Covers: R11
  it("flags a delivery without milestone", () => {
    expect(rules(["## E1 — d", "### M1 — m", OK_A, behavior(1), "## E2 — e"].join("\n"))).toContain(
      "delivery-without-milestone",
    );
  });

  // Covers: R11
  it("flags a milestone without acceptance criterion", () => {
    const result = check(["## E1 — d", "### M1 — m", behavior(1)].join("\n"));
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.rule)).toContain("milestone-without-acceptance");
  });

  // Covers: R11
  it("flags a criterion without command or expected output", () => {
    const text = ["## E1 — d", "### M1 — m", "- **A1** — nothing here", behavior(1)].join("\n");
    expect(rules(text)).toContain("acceptance-malformed");
  });

  // Covers: R11
  it("flags an orphan task, a duplicated task and a duplicated id", () => {
    expect(rules(["- [ ] **T1** (R1) — t · effect: behavior", valid].join("\n"))).toContain(
      "task-outside-milestone",
    );
    expect(rules([valid, behavior(1)].join("\n"))).toContain("task-duplicated");
    const dup = ["## E1 — d", "### M1 — m", OK_A, behavior(1), "### M1 — again", OK_A].join("\n");
    expect(rules(dup)).toContain("duplicate-id");
  });

  // Covers: R8, R11
  it("fails for a declared requirement no task covers", () => {
    const result = check(valid, ["R1", "R2"]);
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      {
        rule: "requirement-uncovered",
        severity: "error",
        where: "R2",
        message: expect.any(String),
      },
    ]);
  });

  // Covers: R8
  it.each([{ ids: [] }, { ids: ["R2"] }])(
    "fails for an unknown requirement with declared ids $ids",
    ({ ids }: { ids: string[] }) => {
      const result = check(valid, ids);
      expect(result.ok).toBe(false);
      expect(result.findings).toContainEqual({
        rule: "unknown-requirement",
        severity: "error",
        where: "T1",
        message: "T1 cites R1, which requirements.md does not declare",
        line: 4,
      });
      expect(result.findings.map((f) => f.rule)).not.toContain("requirements-unreadable");
    },
  );

  // Covers: R7
  it("fails when requirements are absent or unreadable", () => {
    const result = checkSpec(parseTasks(valid), DEFAULT_DELIVERIES, undefined);
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      {
        rule: "requirements-unreadable",
        severity: "error",
        where: "requirements.md",
        message: "requirements.md could not be read; requirement coverage was not checked",
      },
    ]);
  });

  // Covers: R10
  it("checks command shape without executing or proving its meaning", () => {
    const result = check(
      valid.replace("`ls` → ok", "`navori-command-that-does-not-exist` → proof"),
    );
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  // Covers: R10, R12
  it("flags a non-vertical delivery: error in split, warning in single", () => {
    const docs = (e: number, t: number): string =>
      [
        `## E${e} — d`,
        `### M${e} — m`,
        `- **A${e}** — c \`ls\` → ok`,
        `- [ ] **T${t}** (R1) — t · effect: docs`,
      ].join("\n");
    const single = check([docs(1, 1), docs(2, 2)].join("\n"));
    const warning = single.findings.find((f) => f.rule === "delivery-not-vertical");
    expect(single.classification.shape).toBe("single");
    expect(warning?.severity).toBe("warning");
    expect(single.ok).toBe(true);

    const many = Array.from({ length: 13 }, (_, i) => behavior(i + 10)).join("\n");
    const split = check(
      [docs(1, 1), valid.replace("E1", "E2").replace("M1", "M2"), many].join("\n"),
    );
    expect(split.classification.shape).toBe("split");
    expect(split.findings.find((f) => f.rule === "delivery-not-vertical")?.severity).toBe("error");
  });

  // Covers: R12
  it("accepts a docs-only delivery that has an [observable] criterion", () => {
    const text = ["## E1 — d", "### M1 — m", OK_A, "- [ ] **T1** (R1) — t · effect: docs"].join(
      "\n",
    );
    expect(rules(text)).not.toContain("delivery-not-vertical");
  });

  // Covers: R12
  it("warns about a task without a valid effect", () => {
    const text = ["## E1 — d", "### M1 — m", OK_A, "- [ ] **T1** (R1) — t"].join("\n");
    const result = check(text);
    expect(result.ok).toBe(true);
    expect(result.findings.find((f) => f.rule === "task-without-effect")?.severity).toBe("warning");
  });

  // Covers: R13
  it("requires a foundation to be first and to name a consumer", () => {
    const foundation = (e: number, consumes: boolean): string =>
      [
        `## E${e} — f (foundation)`,
        `### M${e} — m`,
        `- **A${e}** — c \`ls\` → ok`,
        ...(consumes ? [`- **Consumes:** E${e} thing → contract`] : []),
        behavior(e * 10),
      ].join("\n");
    const second = check([valid, foundation(2, true)].join("\n"));
    expect(second.findings.map((f) => f.rule)).toContain("foundation-not-first");
    const bare = check(foundation(1, false));
    expect(bare.findings.map((f) => f.rule)).toContain("foundation-without-consumer");
    expect(check(foundation(1, true)).findings.map((f) => f.rule)).not.toContain(
      "foundation-without-consumer",
    );
  });

  // Covers: R11, R12, R13
  it("ignores rule violations that live inside a fence", () => {
    const text = [valid, "```", "## E9 — fake", "- [ ] **T1** (R1) — dup", "```"].join("\n");
    expect(check(text).findings).toEqual([]);
  });

  // Covers: R7
  it("reports too-many-deliveries as an error", () => {
    const text = Array.from({ length: 5 }, (_, i) =>
      [
        `## E${i + 1} — d`,
        `### M${i + 1} — m`,
        `- **A${i + 1}** — c \`ls\` → ok`,
        behavior(i + 1),
      ].join("\n"),
    ).join("\n");
    expect(rules(text)).toContain("too-many-deliveries");
  });
});

describe("checkSpec — completed over-budget declarations", () => {
  const completed = completedSpec();

  // Covers: R7
  it("accepts six completed deliveries with 30 tasks and exposes the classification warning", () => {
    const result = check(completed);
    const warning = result.classification.warnings.find((w) => w.rule === "completed-over-budget");
    expect(result.ok).toBe(true);
    expect(result.classification).toMatchObject({
      shape: "split",
      prCount: 6,
      signals: { tasks: 30, deliveries: 6, milestones: 6 },
      thresholds: { maxPrsPerSpec: 4 },
      error: null,
    });
    expect(warning).toBeDefined();
    expect(result.findings).toEqual([{ ...warning, severity: "warning" }]);
  });

  // Covers: R7
  it("fails again as soon as T30 is reopened", () => {
    const result = check(completed.replace("[x] **T30**", "[ ] **T30**"));
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => [f.rule, f.severity])).toEqual([
      ["too-many-deliveries", "error"],
    ]);
  });

  // Covers: R7, R8, R11, R12, R13
  it.each([
    {
      name: "duplicate milestone",
      text: completed.replace("### M6", "### M5"),
      rule: "duplicate-id",
    },
    {
      name: "duplicate task",
      text: completed.replace("**T30**", "**T29**"),
      rule: "task-duplicated",
    },
    {
      name: "missing acceptance",
      text: completed.replace(OK_A, ""),
      rule: "milestone-without-acceptance",
    },
    {
      name: "malformed acceptance",
      text: completed.replace("`ls` → ok", "no command"),
      rule: "acceptance-malformed",
    },
    {
      name: "unknown requirement",
      text: completed.replace("(R1)", "(R2)"),
      rule: "unknown-requirement",
    },
    {
      name: "non-vertical delivery",
      text: completed
        .replaceAll(" [observable]", "")
        .replaceAll("effect: behavior", "effect: docs"),
      rule: "delivery-not-vertical",
    },
    {
      name: "misplaced foundation",
      text: completed.replace("## E6 — d", "## E6 — d (foundation)"),
      rule: "foundation-not-first",
    },
    {
      name: "foundation without consumer",
      text: completed.replace("## E1 — d", "## E1 — d (foundation)"),
      rule: "foundation-without-consumer",
    },
  ])("continues structural validation for $name", ({ text, rule }) => {
    const result = check(text);
    expect(result.classification.error).toBeNull();
    expect(result.classification.warnings.map((w) => w.rule)).toContain("completed-over-budget");
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => [f.rule, f.severity])).toContainEqual([rule, "error"]);
  });

  // Covers: R7, R8, R22
  it("still checks requirement coverage, unreadable requirements and master mappings", () => {
    expect(check(completed, ["R1", "R2"]).findings.map((f) => f.rule)).toContain(
      "requirement-uncovered",
    );
    const unreadable = checkSpec(parseTasks(completed), DEFAULT_DELIVERIES, undefined);
    expect(unreadable.ok).toBe(false);
    expect(unreadable.findings.map((f) => f.rule)).toContain("requirements-unreadable");
    const unmapped = checkSpec(parseTasks(completed), DEFAULT_DELIVERIES, ["R1"], master());
    expect(unmapped.ok).toBe(false);
    expect(unmapped.findings.map((f) => f.rule)).toContain("master-delivery-unmapped");
  });
});

describe("checkSpec — formato anterior", () => {
  // Covers: R9
  it.each([{ ids: undefined }, { ids: [] }])(
    "ignores absent or unknown requirements $ids in legacy",
    ({ ids }: { ids: string[] | undefined }) => {
      const result = checkSpec(parseTasks("- [ ] **T1** (R1) — t"), DEFAULT_DELIVERIES, ids);
      expect(result.format).toBe("legacy");
      expect(result.ok).toBe(true);
      expect(result.findings.length).toBeGreaterThan(0);
      expect(
        result.findings.every((f) => f.rule === "legacy-format" && f.severity === "warning"),
      ).toBe(true);
    },
  );

  // Covers: R14
  it("reports only legacy-format warnings, never an error", () => {
    const result = check(
      ["- [ ] **T1** (R1) — a", "- [ ] **T1** — dup", "- [ ] ~~T3~~ retired"].join("\n"),
      ["R1", "R2"],
    );
    expect(result.format).toBe("legacy");
    expect(result.ok).toBe(true);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings.every((f) => f.severity === "warning")).toBe(true);
    expect(result.findings[0]?.rule).toBe("legacy-format");
  });
});

describe("master-plan mapping", () => {
  // Covers: R22
  it("flags an E<n> that parts.json does not declare for the part", () => {
    const text = valid.replace("## E1", "## E2");
    const result = checkSpec(parseTasks(text), DEFAULT_DELIVERIES, ["R1"], master());
    expect(result.findings.map((f) => [f.rule, f.severity])).toContainEqual([
      "master-delivery-unmapped",
      "error",
    ]);
    expect(result.ok).toBe(false);
  });

  // Covers: R22
  it("warns when the delivery target differs from prTarget, and stays silent otherwise", () => {
    const mismatch = checkSpec(parseTasks(valid), DEFAULT_DELIVERIES, ["R1"], master("dev"));
    expect(mismatch.ok).toBe(true);
    expect(mismatch.findings.map((f) => [f.rule, f.severity])).toEqual([
      ["master-target-mismatch", "warning"],
    ]);
    expect(checkSpec(parseTasks(valid), DEFAULT_DELIVERIES, ["R1"], master()).findings).toEqual([]);
  });

  // Covers: R22
  it("leaves specs outside master-plan unchanged", () => {
    expect(rules(valid)).toEqual([]);
    expect(checkSpec(parseTasks(valid), DEFAULT_DELIVERIES, ["R1"], null).findings).toEqual([]);
  });
});
