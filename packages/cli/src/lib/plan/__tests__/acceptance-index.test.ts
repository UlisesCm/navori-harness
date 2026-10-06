import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStateRoot } from "../../primitives/state-root.ts";
import { buildAcceptanceIndex, writeAcceptanceIndex } from "../acceptance-index.ts";
import type { Workplan } from "../schema.ts";
import * as delivery from "../../master/delivery.ts";

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
  // Covers: R6, R7, R8
  it("captures qualified delivery authority before the hook runs, not during acceptance", () => {
    const dir = join(cwd, ".navori/state/handoffs");
    const slice = plan("delivery-demo-p1", {}, ["bun check"]);
    const digest = "a".repeat(64);
    slice.source = {
      kind: "master-delivery",
      stageSlug: "demo",
      deliveryId: "E1",
      partId: "P1",
      baselineIdentity: digest,
      queueIdentity: digest,
      contractDigest: digest,
      sourceDigest: digest,
      designDigest: digest,
      masterDigest: digest,
      criterionMap: { A1: "P1.A1" },
    };
    const binding = {
      policy: "deliveries-content-v1" as const,
      authorityGeneration: 1,
      stagePath: "specs/_master/01-demo",
      sourceIdentity: digest,
      baselineIdentity: digest,
      queueIdentity: digest,
      qualifiedId: "P1.A1",
      criterionIdentity: digest,
    };
    const bind = vi.fn(() => binding);
    const capture = vi.spyOn(delivery, "deliveryCriterionCapture").mockReturnValue(bind);
    writePlan(dir, slice);
    expect(buildAcceptanceIndex([dir])).toBe(
      `bun check\t${slice.feature}\tA1\t${dir}\t${JSON.stringify(binding)}\t${binding.stagePath}\n`,
    );
    expect(capture).toHaveBeenCalledWith(cwd, slice.source);
    expect(bind).toHaveBeenCalledWith("A1", "bun check");
    capture.mockImplementation(() => {
      throw new Error("stale current authority");
    });
    expect(buildAcceptanceIndex([dir])).toBe("");
    expect(readFileSync(join(dir, `workplan_${slice.feature}.json`), "utf8")).toBe(
      JSON.stringify(slice),
    );
  });
  // Covers: R6, R7, R8
  it("projects a delivery slice once per plan, however many criteria it binds", () => {
    const dir = join(cwd, ".navori/state/handoffs");
    const slice = plan("delivery-demo-p1", { A3: "cumplido" }, ["a", "b", "c"]);
    const digest = "a".repeat(64);
    slice.source = {
      kind: "master-delivery",
      stageSlug: "demo",
      deliveryId: "E1",
      partId: "P1",
      baselineIdentity: digest,
      queueIdentity: digest,
      contractDigest: digest,
      sourceDigest: digest,
      designDigest: digest,
      masterDigest: digest,
      criterionMap: { A1: "P1.A1", A2: "P1.A2", A3: "P1.A3" },
    };
    const binding = {
      policy: "deliveries-content-v1" as const,
      authorityGeneration: 1,
      stagePath: "specs/_master/01-demo",
      sourceIdentity: digest,
      baselineIdentity: digest,
      queueIdentity: digest,
      qualifiedId: "P1.A1",
      criterionIdentity: digest,
    };
    const bind = vi.fn(() => binding);
    const capture = vi.spyOn(delivery, "deliveryCriterionCapture").mockReturnValue(bind);
    writePlan(dir, slice);
    expect(buildAcceptanceIndex([dir]).split("\n").filter(Boolean)).toHaveLength(2);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(bind).toHaveBeenCalledTimes(2);
  });

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
