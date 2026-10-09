import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readConfig } from "../lib/config/config.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const gate = readConfig(resolve(REPO_ROOT, "navori.config.json")).qualityGate;

/** Ordered `bun run <script>` / `bun <script>` names of an `&&` chain. */
function steps(command: string | undefined): string[] {
  return (command ?? "")
    .split("&&")
    .map((s) => s.trim())
    .filter((s) => !s.startsWith("cd "))
    .map((s) => /^bun (?:run )?(\S+)/.exec(s)?.[1] ?? s);
}

const CHEAP = [
  "format:check",
  "lint",
  "typecheck",
  "check:dup",
  "check:ast",
  "check:links",
  "check:render",
  "check:assets",
  "check:doc-budgets",
  "check:blame-ignore",
  "check:size",
];

describe("this repo's quality gate (R23, R25)", () => {
  // Covers: R23
  it("orden y conjunto", () => {
    // Same set as before the reorder, cheap to expensive, coverage last.
    expect(steps(gate?.full)).toEqual([...CHEAP, "test:coverage"]);
    // The package.json `check` script mirrors `full`.
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(steps(pkg.scripts.check)).toEqual(steps(gate?.full));
    expect(steps(gate?.fast)).toEqual(["check:fast"]);
    expect(pkg.scripts.typecheck).toBeTruthy();
    // Covers: R25
    // `scoped` is the static checks of `full` in order: no test step of any kind.
    expect(steps(gate?.scoped)).toEqual(["check:scoped"]);
    expect(steps(pkg.scripts["check:scoped"])).toEqual(CHEAP);
    expect(steps(gate?.full).slice(0, CHEAP.length)).toEqual(steps(pkg.scripts["check:scoped"]));
    expect(pkg.scripts["check:scoped"]).not.toMatch(/test|vitest/);
  });
});
