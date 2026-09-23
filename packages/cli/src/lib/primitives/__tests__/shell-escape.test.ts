import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { shellSingleQuote } from "../shell-escape.ts";
import { acrossShells } from "./helpers/shells.ts";

describe("shellSingleQuote", () => {
  it("wraps a plain value in single quotes", () => {
    expect(shellSingleQuote("main")).toBe("'main'");
  });

  it("escapes an embedded single quote as '\\''", () => {
    expect(shellSingleQuote("a'b")).toBe("'a'\\''b'");
  });

  it("leaves shell metacharacters inert (they stay literal inside the quotes)", () => {
    expect(shellSingleQuote("$(rm -rf /)")).toBe("'$(rm -rf /)'");
    expect(shellSingleQuote("a|b;c&d")).toBe("'a|b;c&d'");
  });

  it("handles the empty string", () => {
    expect(shellSingleQuote("")).toBe("''");
  });

  // End-to-end proof: a hostile value assigned through the quoted token must be
  // read by a real shell as ONE literal string, never executed. We assign
  // `v=<quoted>` and echo it; the output must equal the original input exactly.
  it("neutralizes an injection payload when a real shell evaluates the assignment", () => {
    const payloads = [
      "main'; touch /tmp/navori_probe; :'",
      "x`touch /tmp/navori_probe`y",
      "$(touch /tmp/navori_probe)",
      "a && touch /tmp/navori_probe",
    ];
    for (const payload of payloads) {
      const script = `v=${shellSingleQuote(payload)}\nprintf '%s' "$v"`;
      // The quoting must hold under every shell a host may run (#391).
      const out = acrossShells((shell) =>
        execFileSync(shell, ["-c", script], { encoding: "utf-8" }),
      );
      expect(out).toBe(payload);
    }
  });
});
