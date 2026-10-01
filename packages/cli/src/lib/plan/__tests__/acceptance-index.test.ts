import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStateRoot } from "../../primitives/state-root.ts";
import { buildAcceptanceIndex, writeAcceptanceIndex } from "../acceptance-index.ts";
import type { Workplan } from "../schema.ts";

let cwd: string;

function plan(feature: string, progress: Workplan["progress"], commands: string[]): Workplan {
  return {
    feature,
    level: 1,
    classification: { score: 1, level: 1, signals: [] },
    objective: "o",
    acceptance: commands.map((command, n) => ({
      id: `A${n + 1}`,
      description: "d",
      command,
      expected: "exit 0",
    })),
    outOfScope: [],
    files: [],
    progress,
    decisions: [],
  };
}

function writePlan(dir: string, p: Workplan): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `workplan_${p.feature}.json`), JSON.stringify(p));
}

beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "navori-acc-index-")));
  execFileSync("git", ["init", "-q"], { cwd });
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

// Covers: R6
describe("acceptance-index", () => {
  it("lists one tab-separated line per pending criterion, JSON-escaped, skipping cumplido", () => {
    const dir = join(cwd, ".navori/state/handoffs");
    writePlan(dir, plan("one", { A1: "cumplido", A2: "pendiente" }, ["echo a", 'echo "b\\c"']));
    expect(buildAcceptanceIndex([dir])).toBe(`echo \\"b\\\\c\\"\tone\tA2\t${dir}\n`);
  });

  it("is rewritten whole (a fully cumplido workplan disappears) at the neutral dir", () => {
    const root = resolveStateRoot({ cwd, feature: "two" });
    writePlan(root.path, plan("two", {}, ["bun check"]));
    writeAcceptanceIndex(root);
    const index = join(root.path, "acceptance-index");
    expect(readFileSync(index, "utf8")).toBe(`bun check\ttwo\tA1\t${root.path}\n`);
    writePlan(root.path, plan("two", { A1: "cumplido" }, ["bun check"]));
    writeAcceptanceIndex(root);
    expect(readFileSync(index, "utf8")).toBe("");
  });

  it("ignores invalid or unreadable workplans instead of failing the write", () => {
    const dir = join(cwd, ".navori/state/handoffs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "workplan_bad.json"), "{not json");
    writePlan(dir, plan("ok", {}, ["x"]));
    expect(buildAcceptanceIndex([dir])).toBe(`x\tok\tA1\t${dir}\n`);
  });
});
