// Covers: R35, R60
import { describe, expect, it } from "vitest";
import { PartsSchema } from "../schema.ts";
import { validatePartSpec } from "../check-part.ts";

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
const requirement = "- **R1** — Do this. Covers P1.A1.\n";

function validate(tasks = task, requirements = requirement, design = "interface Foo {}") {
  return validatePartSpec(cwd, parts[0]!, parts, tasks, design, requirements);
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
});
