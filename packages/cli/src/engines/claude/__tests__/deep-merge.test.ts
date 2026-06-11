import { describe, it, expect } from "vitest";
import { deepMerge } from "../deep-merge.ts";

describe("deepMerge", () => {
  it("override wins for primitives", () => {
    expect(deepMerge({ a: 1, b: 2 }, { b: 3 })).toEqual({ a: 1, b: 3 });
  });

  it("merges nested objects recursively", () => {
    const base = { a: { x: 1, y: 2 } };
    const ovr = { a: { y: 99, z: 3 } };
    expect(deepMerge(base, ovr)).toEqual({ a: { x: 1, y: 99, z: 3 } });
  });

  it("concatenates arrays AND dedupes by structural equality", () => {
    const base = { allow: ["Bash(git status*)", "Bash(git diff*)"] };
    const ovr = { allow: ["Bash(git diff*)", "Bash(pnpm test)"] };
    expect(deepMerge(base, ovr)).toEqual({
      allow: ["Bash(git status*)", "Bash(git diff*)", "Bash(pnpm test)"],
    });
  });

  it("dedupes complex array items (objects) by JSON equivalence", () => {
    const base = {
      hooks: { PreToolUse: [{ matcher: "Bash", command: "x" }] },
    };
    const ovr = {
      hooks: { PreToolUse: [{ matcher: "Bash", command: "x" }, { matcher: "Bash", command: "y" }] },
    };
    const merged = deepMerge(base, ovr) as {
      hooks: { PreToolUse: Array<{ matcher: string; command: string }> };
    };
    expect(merged.hooks.PreToolUse).toHaveLength(2);
    expect(merged.hooks.PreToolUse.map((h) => h.command)).toEqual(["x", "y"]);
  });

  it("does not mutate the inputs", () => {
    const base = { a: { x: 1 }, list: [1, 2] };
    const ovr = { a: { y: 2 }, list: [3] };
    deepMerge(base, ovr);
    expect(base).toEqual({ a: { x: 1 }, list: [1, 2] });
    expect(ovr).toEqual({ a: { y: 2 }, list: [3] });
  });
});
