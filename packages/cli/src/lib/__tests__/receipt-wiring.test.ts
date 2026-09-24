import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const core = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "core",
  "core-assets",
);
const read = (path: string): string => readFileSync(resolve(core, path), "utf8");

describe("receipt wiring", () => {
  // Covers: R6, R7, R8, R9
  it("assets invoke navori receipt with --json, gate on status ok and carry no receipt shell", () => {
    const reviewer = read("agents/reviewer.md");
    const pilot = read("agents/publisher.md");
    for (const asset of [reviewer, pilot]) {
      expect(asset).toContain("navori receipt");
      expect(asset).toContain("--feature <feature>");
      expect(asset).toContain("--target {{prTarget}}");
      expect(asset).toContain("--dir .claude/progress");
      expect(asset).toContain("--json");
      expect(asset).toContain('"status":"ok"');
    }
    expect(reviewer).not.toContain("git hash-object -w");
    expect(pilot).not.toContain("while IFS= read -r line");
    const settings = JSON.parse(read("settings/settings-base.json")) as {
      permissions: { allow: string[] };
    };
    expect(settings.permissions.allow).toContain("Bash(navori receipt:*)");
  });

  // Covers: R9
  it("verify-before-done PR row requires receipt check ok", () => {
    const verify = read("skills/verify-before-done.md");
    const row = verify.split("\n").find((line) => line.startsWith("| PR creatable")) ?? "";
    expect(row).toContain("navori receipt check");
    expect(row).toContain('"status":"ok"');
  });

  // Covers: R6, R8
  it("publisher requires fresh:true or runs the gate itself, and never reads a consumed receipt", () => {
    const publisher = read("agents/publisher.md");
    expect(publisher).toContain('"fresh":true');
    expect(publisher).not.toContain("--include-consumed");
    expect(publisher).not.toMatch(/re-run .*by hand whenever the diff changed/i);
  });

  // Covers: R6, R8
  it("cierre-sesion checks the receipt with --include-consumed instead of citing the cycle", () => {
    const cierre = read("managed/cierre-sesion.md");
    expect(cierre).toContain("--include-consumed");
    expect(cierre).not.toMatch(/cite this cycle's green run/i);
  });

  // Covers: R8
  it("reviewer and implementer don't gate the vigencia of existing evidence on 'this turn'", () => {
    const reviewer = read("agents/reviewer.md");
    const implementer = read("agents/implementer.md");
    // "this turn" still governs PRODUCING evidence (run the gate now); it must
    // not be the criterion for whether existing evidence is still valid to
    // CONSUME — that's R5's identity (base + gate command + inputs), owned by
    // verify-before-done and cited here, not restated as "this turn".
    expect(reviewer).not.toMatch(/fresh[\s\S]{0,30}this turn/i);
    expect(implementer).not.toMatch(/fresh[\s\S]{0,30}this turn/i);
  });
});
