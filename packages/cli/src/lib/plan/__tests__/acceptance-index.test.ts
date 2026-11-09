import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStateRoot } from "../../primitives/state-root.ts";
import { buildAcceptanceIndex, writeAcceptanceIndex } from "../acceptance-index.ts";
import type { Workplan } from "../schema.ts";
import { computeWorktreeTree, readHead, validateEvidence, type EvidenceLine } from "../evidence.ts";
const V1_DELIVERY_FIXTURE = join(
  import.meta.dirname,
  "../../masterplan/__tests__/fixtures/workplan-master-delivery.json",
);

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
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(cwd, { recursive: true, force: true });
});

// Covers: R6
describe("acceptance-index", () => {
  // Covers: R6, R7, R8 — spec 0063 T6: a v1 delivery workplan gets a plain line, never a binding.
  it("indexes a v1 delivery workplan as a plain four-column line without a delivery binding", () => {
    const dir = join(cwd, ".navori/state/handoffs");
    mkdirSync(dir, { recursive: true });
    const fixture = JSON.parse(readFileSync(V1_DELIVERY_FIXTURE, "utf8")) as Workplan;
    writeFileSync(join(dir, `workplan_${fixture.feature}.json`), JSON.stringify(fixture));
    const command = fixture.acceptance[0]!.command;
    expect(buildAcceptanceIndex([dir])).toBe(`${command}\t${fixture.feature}\tA1\t${dir}\n`);
  });

  it("lists one tab-separated line per criterion, JSON-escaped, cumplido included", () => {
    const dir = join(cwd, ".navori/state/handoffs");
    writePlan(dir, plan("one", { A1: "cumplido", A2: "pendiente" }, ["echo a", 'echo "b\\c"']));
    expect(buildAcceptanceIndex([dir])).toBe(
      `echo a\tone\tA1\t${dir}\necho \\"b\\\\c\\"\tone\tA2\t${dir}\n`,
    );
  });

  it("is rewritten whole at the neutral dir and keeps a fully cumplido workplan", () => {
    const root = resolveStateRoot({ cwd, feature: "two" });
    writePlan(root.path, plan("two", {}, ["bun check"]));
    writeAcceptanceIndex(root);
    const index = join(root.path, "acceptance-index");
    expect(readFileSync(index, "utf8")).toBe(`bun check\ttwo\tA1\t${root.path}\n`);
    writePlan(root.path, plan("two", { A1: "cumplido" }, ["bun check"]));
    writeAcceptanceIndex(root);
    expect(readFileSync(index, "utf8")).toBe(`bun check\ttwo\tA1\t${root.path}\n`);
  });

  it("compares structured expected values for cumplido criteria too", () => {
    const root = resolveStateRoot({ cwd, feature: "cmp" });
    const p = plan("cmp", { A1: "cumplido" }, ["echo ready"]);
    p.acceptance[0]!.expected = "contains: ready";
    writePlan(root.path, p);
    writeAcceptanceIndex(root);
    const rows = readFileSync(join(root.path, "acceptance-expected.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line: string): unknown => JSON.parse(line));
    expect(rows).toEqual([
      expect.objectContaining({
        command: "echo ready",
        feature: "cmp",
        id: "A1",
        dir: root.path,
        expected: "contains: ready",
        spec: expect.objectContaining({ kind: "contains" }),
      }),
    ]);
  });

  // A1/M2: the rerun after a change must not leave the previous green valid.
  describe("a cumplido criterion whose tree changed and whose rerun fails", () => {
    const COMMAND = "bun test x";
    const write = (lines: EvidenceLine[]): void => {
      const dir = join(cwd, ".navori/state/handoffs");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "workplan_demo.evidence.jsonl"),
        lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      );
    };
    const green = (): EvidenceLine => ({
      ts: "2026-09-30T10:00:00Z",
      feature: "demo",
      id: "A1",
      command: COMMAND,
      tree: cwd,
      cwd,
      head: readHead(cwd),
      worktreeTree: computeWorktreeTree(cwd) ?? "",
      fp: 2,
      dirty: false,
    });
    const verdict = (expected: string) =>
      validateEvidence({
        root: resolveStateRoot({ cwd, feature: "demo" }),
        feature: "demo",
        id: "A1",
        command: COMMAND,
        expected,
      });

    beforeEach(() => {
      execFileSync("git", ["config", "user.email", "t@t"], { cwd });
      execFileSync("git", ["config", "user.name", "t"], { cwd });
      writeFileSync(join(cwd, "a.txt"), "a\n");
      execFileSync("git", ["add", "-A"], { cwd });
      execFileSync("git", ["commit", "-qm", "init"], { cwd });
    });

    it("is stale when a failed rerun records nothing (the old green is bound to the old tree)", () => {
      write([green()]);
      expect(verdict("exit 0").ok).toBe(true);
      writeFileSync(join(cwd, "a.txt"), "changed\n");
      const result = verdict("exit 0");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.why).toContain("tree changed");
    });

    it("is failed when a structured-comparison failure line is recorded for the new tree", () => {
      const old = green();
      writeFileSync(join(cwd, "a.txt"), "changed\n");
      write([
        old,
        {
          ...green(),
          ts: "2026-09-30T11:00:00Z",
          exit: 1,
          expected: "contains: ready",
          outcome: "fail",
        },
      ]);
      const result = verdict("contains: ready");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.why).toBe("expected not met");
    });
  });

  it("ignores invalid or unreadable workplans instead of failing the write", () => {
    const dir = join(cwd, ".navori/state/handoffs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "workplan_bad.json"), "{not json");
    writePlan(dir, plan("ok", {}, ["x"]));
    expect(buildAcceptanceIndex([dir])).toBe(`x\tok\tA1\t${dir}\n`);
  });
});
