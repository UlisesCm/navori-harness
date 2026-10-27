import { describe, expect, it } from "vitest";
import { defineCommand, runCommand } from "citty";

/**
 * Spec 0061 R4 — citty 0.2 swapped its mri-style parser for `node:util.parseArgs`
 * (`strict: false`). Each behavior below differs from, or must stay equal to, 0.1.6, and the
 * repo's commands read declared string flags and `init --no-render` through it.
 */

/** Runs a fixture command and returns the parsed args it received. */
async function parse(rawArgs: string[]): Promise<Record<string, unknown>> {
  let seen: Record<string, unknown> = {};
  const cmd = defineCommand({
    args: {
      cwd: { type: "string" },
      ack: { type: "string" },
      render: { type: "boolean", default: true },
    },
    run({ args }) {
      seen = { ...args };
    },
  });
  await runCommand(cmd, { rawArgs });
  return seen;
}

describe("citty 0.2 parsing", () => {
  // Covers: R4
  it("parses declared, undeclared, repeated and negated flags as citty 0.2 defines", async () => {
    // Declared string: `=` and space forms agree; a bare flag is "".
    expect((await parse(["--cwd=x"])).cwd).toBe("x");
    expect((await parse(["--cwd", "x"])).cwd).toBe("x");
    expect((await parse(["--cwd"])).cwd).toBe("");

    // Undeclared flag with a space-separated value: boolean plus a positional (0.1: the value).
    const spaced = await parse(["--foo", "bar"]);
    expect(spaced.foo).toBe(true);
    expect(spaced._).toEqual(["bar"]);

    // Undeclared numeric value stays a string (0.1: the number 1).
    expect((await parse(["--limit=1"])).limit).toBe("1");

    // Repeated declared string flag: last wins (0.1: an array).
    expect((await parse(["--ack", "a", "--ack", "b"])).ack).toBe("b");

    // `--no-<x>` negates a declared boolean that defaults to true.
    expect((await parse([])).render).toBe(true);
    expect((await parse(["--no-render"])).render).toBe(false);
  });
});
