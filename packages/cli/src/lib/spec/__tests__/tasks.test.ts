import { describe, expect, it } from "vitest";
import { allTasks, parseTasks } from "../tasks.ts";

const NEW_FORMAT = `# Title

## E1 — First delivery (foundation)
Estimated LOC: 1,300

### M1 — Parser
- **A1** [observable] — classifies the spec with \`split\` inside the text ·
  \`bun cli spec classify x --json\`
  → JSON with \`"shape":"split"\` and thresholds
- **A2** — plain criterion · \`bun test\` -> exit 0
- **Consumes:** classify -> the parser
  contract
- [ ] **T1** (R4, R10) — parser · effect: behavior · test: \`a.test.ts\`::"blocks"
- [x] **T2** (R5) — second
  continuation line with effect: docs
  and test: \`b.test.ts\`::"name" · trailing
- [ ] ~~T3~~ **WITHDRAWN**

### M2 — Second
- **A3** [observable] — c · \`ls\` → ok

## E2: Second delivery
### M3 — Third
- [ ] **T4** (R6) — x · effect: tests
`;

// Covers: R4, R10
describe("tasks parser — blocks, fences and legacy format", () => {
  it("parses deliveries, LOC, milestones, criteria, consumers and tasks", () => {
    const parsed = parseTasks(NEW_FORMAT);
    expect(parsed.format).toBe("deliveries");
    expect(parsed.deliveries.map((d) => d.id)).toEqual(["E1", "E2"]);
    const [e1, e2] = parsed.deliveries;
    expect(e1?.title).toBe("First delivery");
    expect(e1?.foundation).toBe(true);
    expect(e1?.estimatedLoc).toBe(1300);
    expect(e2?.estimatedLoc).toBeUndefined();
    expect(e2?.title).toBe("Second delivery");
    expect(e1?.milestones.map((m) => m.id)).toEqual(["M1", "M2"]);
    expect(e2?.milestones.map((m) => m.id)).toEqual(["M3"]);
  });

  it("takes the command from the line that opens with a backtick span and the expected after the last arrow", () => {
    const m1 = parseTasks(NEW_FORMAT).deliveries[0]?.milestones[0];
    const [a1, a2] = m1?.criteria ?? [];
    expect(a1).toMatchObject({
      id: "A1",
      observable: true,
      command: "bun cli spec classify x --json",
      expected: 'JSON with `"shape":"split"` and thresholds',
    });
    expect(a1?.description).toBe("classifies the spec with `split` inside the text");
    expect(a2).toMatchObject({ observable: false, command: "bun test", expected: "exit 0" });
  });

  it("falls back to the first span, supports longer delimiters and an empty expected", () => {
    const parsed = parseTasks(
      "## E1 — t\n### M1 — m\n- **A1** — d ``echo `x` ``\n- **A2** — no command\n",
    );
    const [a1, a2] = parsed.deliveries[0]?.milestones[0]?.criteria ?? [];
    expect(a1?.command).toBe("echo `x`");
    expect(a1?.expected).toBe("");
    expect(a2).toMatchObject({ command: "", expected: "" });
  });

  it("reads Consumes lines and tasks with attributes anywhere in the block", () => {
    const m1 = parseTasks(NEW_FORMAT).deliveries[0]?.milestones[0];
    expect(m1?.consumers).toEqual([{ text: "classify -> the parser contract", line: 11 }]);
    const [t1, t2] = m1?.tasks ?? [];
    expect(t1).toMatchObject({
      id: "T1",
      done: false,
      requirements: ["R4", "R10"],
      effect: "behavior",
      test: '`a.test.ts`::"blocks"',
    });
    expect(t2).toMatchObject({ id: "T2", done: true, requirements: ["R5"], effect: "docs" });
    expect(t2?.test).toBe('`b.test.ts`::"name"');
  });

  it("keeps retired tasks out of the task list", () => {
    const parsed = parseTasks(NEW_FORMAT);
    expect(parsed.deliveries[0]?.milestones[0]?.retired).toEqual(["T3"]);
    expect(allTasks(parsed).map((t) => t.id)).toEqual(["T1", "T2", "T4"]);
  });

  it("ignores everything inside ``` and ~~~ fences, closed only by the same char and length", () => {
    const text = [
      "## E1 — real",
      "### M1 — real",
      "````markdown",
      "## E9 — fake",
      "```",
      "- [ ] **T9** (R1) — inside the longer fence",
      "````",
      "~~~",
      "- [ ] **T8** (R1) — inside tilde fence",
      "```",
      "- [ ] **T7** (R1) — a backtick fence does not close a tilde fence",
      "~~~~",
      "- [ ] **T1** (R1) — real · effect: behavior",
      "",
    ].join("\n");
    const parsed = parseTasks(text);
    expect(parsed.deliveries.map((d) => d.id)).toEqual(["E1"]);
    expect(allTasks(parsed).map((t) => t.id)).toEqual(["T1"]);
  });

  it("collects tasks and criteria outside a milestone and unidentified checkboxes", () => {
    const parsed = parseTasks(
      "- [ ] **T0** (R1) — before\n## E1 — d\n- **A1** — c `x` → y\n- [ ] **T1** (R1) — z\n- [ ] no id\n",
    );
    expect(parsed.orphanTasks.map((t) => t.id)).toEqual(["T0", "T1"]);
    expect(parsed.orphanCriteria.map((c) => c.id)).toEqual(["A1"]);
    expect(parsed.malformed).toEqual([{ line: 5, text: "no id" }]);
  });

  it("detects the legacy format and counts generic checkboxes without retired tasks", () => {
    const parsed = parseTasks(
      [
        "# Tasks",
        "- [x] **A1** (R2) — audit style",
        "- [ ] **T1** — plain",
        "- [ ] ~~T2~~ **WITHDRAWN**",
        "```",
        "## E1 — in a fence is not a delivery",
        "- [ ] fenced",
        "```",
        "",
      ].join("\n"),
    );
    expect(parsed.format).toBe("legacy");
    expect(parsed.deliveries).toEqual([]);
    expect(parsed.legacyTaskCount).toBe(2);
  });
});
