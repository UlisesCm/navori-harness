import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = resolve(import.meta.dirname, "..", "..");
const FORCE_COLOR_OFF = `FORCE_COLOR: ${JSON.stringify("0")}`;

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("test color environment (#782)", () => {
  it("uses NO_COLOR rather than FORCE_COLOR=0 to disable ANSI", () => {
    const offenders = testFiles(SOURCE).filter((file) =>
      readFileSync(file, "utf-8").includes(FORCE_COLOR_OFF),
    );
    expect(offenders).toEqual([]);
  });
});
