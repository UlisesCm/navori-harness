import { describe, expect, it } from "vitest";
import { extname, join, dirname, resolve } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
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

function walkMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMarkdown(full));
    else if (extname(entry.name) === ".md" || extname(entry.name) === ".mdx") out.push(full);
  }
  return out;
}

// R2/R4: a rule that assigns a failure's origin by its position in the diff
// alone. None of these forms may survive in any renderable asset.
const FORBIDDEN_PATTERNS: RegExp[] = [
  /predates you/i,
  /outside[\s\S]{0,80}(diff|list)[\s\S]{0,80}pre-existing/i,
  /diff file\s*(→|->)\s*introduced/i,
];

describe("failure attribution", () => {
  // Covers: R1, R2, R3, R4
  it("no renderable asset assigns a failure's origin by diff location alone", () => {
    const files = walkMarkdown(core);
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(text)) offenders.push(`${file}: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // Covers: R1, R2, R3
  it("verify-before-done defines the three states and the demonstration method", () => {
    const verify = read("skills/verify-before-done.md");
    expect(verify).toMatch(/introduced \(demonstrated\)/i);
    expect(verify).toMatch(/pre-existing \(demonstrated\)/i);
    expect(verify).toMatch(/origin not determined/i);
    // R3: same command, run over the comparable base AND the change, no `git stash`.
    expect(verify).toMatch(/git stash/i);
    expect(verify.toLowerCase()).toContain("same command");
  });

  // Covers: R2
  it("verify-before-done says location alone only orients, never proves origin", () => {
    const verify = read("skills/verify-before-done.md");
    const index = verify.indexOf("Failure attribution");
    expect(index).toBeGreaterThan(-1);
    const section = verify.slice(index);
    expect(section).toMatch(/location/i);
    expect(section.toLowerCase()).toMatch(/never proves?|does not prove|only orients/);
  });

  // Covers: R4
  it("implementer, reviewer and review-diff cite the states without redefining them", () => {
    for (const path of ["agents/implementer.md", "agents/reviewer.md", "skills/review-diff.md"]) {
      const text = read(path);
      expect(text.toLowerCase()).toContain("failure attribution");
      expect(text).not.toMatch(/predates you/i);
    }
  });
});
