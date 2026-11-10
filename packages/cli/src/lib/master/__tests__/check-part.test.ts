// Covers: R35, R60
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PartsSchema } from "../schema.ts";
import { validateOnePagePartSpec, validatePartSpec } from "../check-part.ts";

const cwd = process.cwd();
const parts = PartsSchema.parse({
  version: 1,
  parts: [
    {
      id: "P1",
      title: "One",
      objective: "Ship",
      acceptance: [
        {
          id: "A1",
          description: "Works",
          method: "test",
          test: { file: "a.test.ts", case: "works" },
        },
      ],
    },
  ],
}).parts;
const task =
  "- [ ] **T1** (R1) — Work.\n  - **Archivos:** src/a.ts\n  - **Interfaces:** Foo\n  - **Patrón:** package.json\n  - **Lectura:** design.md\n  - **Librerías:** lib@1.2.0\n  - **Done:** comando `bun test`, esperado exit 0, caso test `works`, P1.A1\n  - **Fuera de alcance:** deploy\n";
const taskEn = task
  .replace("**Archivos:**", "**Files:**")
  .replace("**Patrón:**", "**Pattern:**")
  .replace("**Lectura:**", "**Reading:**")
  .replace("**Librerías:**", "**Libraries:**")
  .replace("**Fuera de alcance:**", "**Out of scope:**");
const requirement = "- **R1** — Do this. Covers P1.A1.\n";
const LABEL = /^ {2}- \*\*([^:*]+):\*\*/gm;

function validate(
  tasks = task,
  requirements = requirement,
  design = "interface Foo {}",
  language?: "es" | "en",
) {
  return validatePartSpec(cwd, parts[0]!, parts, tasks, design, requirements, language);
}

describe("part spec rigor", () => {
  // Covers: R35
  it.each(["Archivos", "Interfaces", "Patrón", "Lectura", "Librerías", "Done", "Fuera de alcance"])(
    "rejects missing %s",
    (field) => {
      const withoutField = task
        .split("\n")
        .filter((line) => !line.trimStart().startsWith(`- **${field}:**`))
        .join("\n");
      expect(validate(withoutField)).toContain(`T1: missing ${field}`);
    },
  );

  // Covers: R35
  it("rejects floating library versions and unknown interfaces", () => {
    expect(validate(task.replace("lib@1.2.0", "lib@^1.2.0"))).toContain(
      "T1: library needs exact version: lib@^1.2.0",
    );
    expect(validate(task, requirement, "interface Bar {}")).toContain(
      "T1: interface Foo not in design.md",
    );
  });

  // Covers: R35
  it("rejects malformed task entries even when another task is complete", () => {
    expect(validate(`${task}\n- [ ] Implement feature\n  - **Done:** test\n`)).toContain(
      "P1: task 2 needs a **T<n>** heading",
    );
    expect(validate(`${task}\n- [ ]\n`)).toContain("P1: task 2 needs a **T<n>** heading");
  });

  // Covers: R35
  it("rejects Done without a named test case", () => {
    expect(validate(task.replace("caso test `works`", "test"))).toContain(
      "T1: Done needs command, expected result, named test cases and acceptance ID",
    );
    expect(validate(task.replace("caso test `works`", "caso test P1.A1"))).toContain(
      "T1: Done needs command, expected result, named test cases and acceptance ID",
    );
  });

  // Covers: R60
  it("rejects both unmapped and nonexistent criteria", () => {
    expect(validate(task, "- **R1** — No mapping.")).toContain(
      "criterion P1.A1 is not cited by any R<n>",
    );
    expect(validate(task, "- **R1** — P1.A1 and P1.A9.")).toContain(
      "requirements.md cites nonexistent criterion P1.A9",
    );
  });

  // Covers: R35, R60
  it("accepts a complete task and a wrapped requirement mapping", () => {
    expect(validate(task, "- **R1** — Do this.\n  Covers P1.A1.")).toEqual([]);
  });

  // Covers: R3
  it("accepts English labels in an English repo", () => {
    expect(validate(taskEn, requirement, "interface Foo {}", "en")).toEqual([]);
  });

  // Covers: R3
  it("accepts Spanish labels in an English repo", () => {
    expect(validate(task, requirement, "interface Foo {}", "en")).toEqual([]);
  });

  // Covers: R3
  it("names a missing field with the English label in an English repo", () => {
    const withoutField = taskEn
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("- **Out of scope:**"))
      .join("\n");
    expect(validate(withoutField, requirement, "interface Foo {}", "en")).toContain(
      "T1: missing Out of scope",
    );
  });

  // Covers: R3
  it.each([
    ["es", task, "tasks.md"],
    ["en", taskEn, "en/tasks.md"],
  ] as const)("every %s label appears in its tasks template", (_lang, source, rel) => {
    const template = readFileSync(
      new URL(`../../../../../core/core-assets/master-plan/${rel}`, import.meta.url),
      "utf8",
    );
    const labels = [...source.matchAll(LABEL)].map((m) => m[1]);
    expect(labels).toHaveLength(7);
    for (const label of labels) expect(template).toContain(`- **${label}:**`);
  });

  describe("skipCompletedTasks", () => {
    // A task done months ago whose pattern file was later deleted and whose prose no longer
    // matches the field grammar (issue #1470).
    const stale = task
      .replace("- [ ] **T1**", "- [x] **T1**")
      .replace("**Patrón:** package.json", "**Patrón:** deleted/cd.yml (job release)")
      .replace("**Librerías:** lib@1.2.0", "**Librerías:** ninguna nueva.");
    const open = task.replace("**T1**", "**T2**").replace("lib@1.2.0", "lib@latest");

    it("still reports stale fields of a completed task by default", () => {
      expect(validate(stale)).toEqual(
        expect.arrayContaining([
          "T1: pattern file does not exist: deleted/cd.yml (job release)",
          "T1: library needs exact version: ninguna nueva.",
        ]),
      );
    });

    it("skips completed tasks and keeps checking open tasks and traceability", () => {
      const failures = validatePartSpec(
        cwd,
        parts[0]!,
        parts,
        `${stale}${open}`,
        "interface Foo {}",
        "- **R1** — Do this.\n",
        "es",
        { skipCompletedTasks: true },
      );
      expect(failures).toEqual([
        "T2: library needs exact version: lib@latest",
        "criterion P1.A1 is not cited by any R<n>",
      ]);
    });
  });
});

describe("one-page spec.md part check", () => {
  const manual = { method: "manual", manual: { check: "c", how: "h" } } as const;
  const twoParts = PartsSchema.parse({
    version: 1,
    parts: [
      {
        id: "P1",
        title: "One",
        objective: "Ship",
        acceptance: [
          { id: "A1", description: "Manual", ...manual },
          {
            id: "A2",
            description: "Cmd",
            method: "comando",
            command: { run: "true", expected: "exit 0" },
          },
        ],
      },
      {
        id: "P2",
        title: "Two",
        objective: "Ship",
        acceptance: [{ id: "A1", description: "Manual", ...manual }],
      },
    ],
  }).parts;
  const base = readFileSync(new URL("./fixtures/jey-02-mvp-s01-spec.md", import.meta.url), "utf8");
  const noCitations = base.replace(/\bA[12]\b/g, "uno");
  const check = (text: string): string[] => validateOnePagePartSpec(twoParts[0]!, twoParts, text);
  const blocking = (text: string): string[] => check(text).filter((f) => !f.startsWith("warning:"));

  // Covers: R35
  it("accepts the real jey spec citing bare A1 and A2", () => {
    expect(blocking(base)).toEqual([]);
  });

  // Covers: R35
  it("accepts qualified citations", () => {
    expect(blocking(`${noCitations}\nCubre P1.A1 y P1.A2.\n`)).toEqual([]);
  });

  // Covers: R35
  it("rejects an uncited own criterion", () => {
    expect(blocking(`${noCitations}\nSolo A1.\n`)).toEqual([
      "criterion P1.A2 is not cited in spec.md",
    ]);
  });

  // Covers: R35
  it("does not count another part's qualified citation as a bare one", () => {
    expect(blocking(`${noCitations}\nA2. P2.A1.\n`)).toEqual([
      "criterion P1.A1 is not cited in spec.md",
    ]);
    expect(check(`${noCitations}\nA1 A2 P2.A1\n`)).toContain(
      "warning: spec.md cites criterion from another part P2.A1",
    );
  });

  // Covers: R35
  it("rejects a nonexistent qualified criterion", () => {
    expect(blocking(`${base}\nP1.A9\n`)).toContain("spec.md cites nonexistent criterion P1.A9");
  });

  // Covers: R35
  it("only warns about a bare unknown A9", () => {
    const failures = check(`${base}\nA9\n`);
    expect(failures.filter((f) => !f.startsWith("warning:"))).toEqual([]);
    expect(failures.some((f) => f.startsWith("warning:") && f.includes("A9"))).toBe(true);
  });

  // Covers: R35
  it("blocks on a one-page structural error", () => {
    const broken = base.replace(/^## Fuera de alcance[\s\S]*$/m, "");
    expect(blocking(broken).some((f) => f.startsWith("spec.md: [missing-section]"))).toBe(true);
  });
});
