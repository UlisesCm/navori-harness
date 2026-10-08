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
  // Covers: R11
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

  // Covers: R11
  it("flags a requirement no task covers and warns about an unknown one", () => {
    expect(rules(valid, ["R1", "R2"])).toContain("requirement-uncovered");
    const unknown = check(valid, []);
    const finding = unknown.findings.find((f) => f.rule === "unknown-requirement");
    expect(finding?.severity).toBe("warning");
    expect(unknown.ok).toBe(true);
  });

  // Covers: R11
  it("warns, without failing, when requirements are unreadable", () => {
    const result = checkSpec(parseTasks(valid), DEFAULT_DELIVERIES, undefined);
    expect(result.ok).toBe(true);
    expect(result.findings.map((f) => f.rule)).toEqual(["requirements-unreadable"]);
  });

  // Covers: R12
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
    expect(check(text).findings.find((f) => f.rule === "task-without-effect")?.severity).toBe(
      "warning",
    );
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

describe("checkSpec — formato anterior", () => {
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
