import { describe, expect, it } from "vitest";
import { acrossShells, HOOK_SHELLS, shellSensitive } from "./helpers/shells.ts";

describe("shell selection (spec 0055 D9)", () => {
  // Covers: R16
  it("shellSensitive demands a non-empty reason", () => {
    expect(() => shellSensitive("")).toThrow(/reason/);
    expect(() => shellSensitive("   ")).toThrow(/reason/);
    expect(shellSensitive("word-splitting of an unquoted $files")[0]).toBe("bash");
  });

  // Covers: R16
  it("a regular case runs under the default shells, a sensitive one under every available shell", () => {
    const regular: string[] = [];
    acrossShells((shell) => (regular.push(shell), 0));
    expect(regular).toEqual([...HOOK_SHELLS]);

    const sensitive: string[] = [];
    acrossShells((shell) => (sensitive.push(shell), 0), { sensitive: "demo" });
    expect(sensitive).toEqual([...shellSensitive("demo")]);
  });

  // Covers: R16
  it("an empty reason on acrossShells is rejected", () => {
    expect(() => acrossShells(() => 1, { sensitive: "" })).toThrow(/reason/);
  });
});
