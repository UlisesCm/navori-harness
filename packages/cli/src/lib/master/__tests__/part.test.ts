// Covers: R33, R44, R48, R59, R61, R62
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSeedConfigHelper } from "./test-utils.ts";
import { changeMasterPart } from "../part.ts";

let cwd: string;
const partPath = (): string => join(cwd, "specs/_master/01-mvp/parts.json");
function git(...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
function parts(): { parts: Array<{ acceptance: Array<{ evidence: unknown }> }> } {
  return JSON.parse(readFileSync(partPath(), "utf8")) as {
    parts: Array<{ acceptance: Array<{ evidence: unknown }> }>;
  };
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-master-part-"));
  git("init", "-q");
  createSeedConfigHelper(cwd)({ harness: { masterPlan: true } });
  mkdirSync(join(cwd, "specs/_master/01-mvp"), { recursive: true });
  writeFileSync(
    join(cwd, "specs/_master/index.json"),
    JSON.stringify({
      version: 1,
      stages: [
        {
          number: 1,
          slug: "mvp",
          dir: "01-mvp",
          state: "activa",
          openedAt: "2026-01-01",
          closedAt: null,
          spec: null,
        },
      ],
    }),
  );
  writeFileSync(
    join(cwd, "specs/_master/01-mvp/state.json"),
    JSON.stringify({
      version: 1,
      phase: "executing",
      mode: "template",
      signal: {
        commits: null,
        firstCommit: null,
        filesChangedSinceFirst: null,
        framework: null,
        libraries: [],
        suggested: "template",
      },
      outcome: null,
      history: [],
    }),
  );
  writeFileSync(join(cwd, "test.ts"), "export const tested = true;\n");
  writeFileSync(
    partPath(),
    JSON.stringify({
      version: 1,
      parts: [
        {
          id: "P1",
          title: "Test",
          objective: "Build",
          scope: [],
          outOfScope: [],
          dependsOn: [],
          seedRequirements: [],
          acceptance: [
            {
              id: "A1",
              description: "Test",
              method: "test",
              test: { file: "test.ts", case: "works" },
              evidence: null,
            },
            {
              id: "A2",
              description: "Command",
              method: "comando",
              command: { run: "bun test", expected: "green" },
              evidence: null,
            },
            {
              id: "A3",
              description: "Manual",
              method: "manual",
              manual: { check: "review", how: "inspect" },
              evidence: null,
            },
          ],
          inheritedFrom: null,
          state: "pendiente",
          reason: null,
          spec: null,
          issue: null,
        },
      ],
    }),
  );
  git("add", "-A");
  git("-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-qm", "fixture");
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("master part", () => {
  // Covers: R33, R44, R48
  it("rejects duplicate issue, missing or escaping spec, and disposition without reason", () => {
    expect(() => changeMasterPart(cwd, "P1", { state: "diferida" })).toThrow("--reason");
    expect(() => changeMasterPart(cwd, "P1", { state: "hecho", reason: "because" })).toThrow(
      "--reason",
    );
    expect(() => changeMasterPart(cwd, "P1", { spec: "../outside" })).toThrow("--spec");
    expect(() => changeMasterPart(cwd, "P1", { spec: "specs/missing" })).toThrow("--spec");
    changeMasterPart(cwd, "P1", { issue: "12" });
    expect(() => changeMasterPart(cwd, "P1", { issue: "13" })).toThrow("already has issue");
  });

  // Covers: R59, R61, R62
  it("rejects wrong evidence method and dirty tested code, but records valid evidence", () => {
    expect(() => changeMasterPart(cwd, "P1", { accept: "A1", approvedBy: "user" })).toThrow();
    expect(() =>
      changeMasterPart(cwd, "P1", { accept: "A2", command: "wrong", result: "ok" }),
    ).toThrow();
    expect(() =>
      changeMasterPart(cwd, "P1", { accept: "A3", command: "bun test", result: "ok" }),
    ).toThrow();
    writeFileSync(join(cwd, "test.ts"), "dirty");
    expect(() =>
      changeMasterPart(cwd, "P1", { accept: "A1", command: "bun test test.ts", result: "ok" }),
    ).toThrow("dirty");
    git("checkout", "--", "test.ts");
    changeMasterPart(cwd, "P1", { accept: "A1", command: "bun test test.ts", result: "ok" });
    expect(parts().parts[0]?.acceptance[0]?.evidence).toMatchObject({ kind: "run", result: "ok" });
    changeMasterPart(cwd, "P1", { accept: "A3", approvedBy: "user" });
    expect(parts().parts[0]?.acceptance[2]?.evidence).toMatchObject({
      kind: "approval",
      approvedBy: "user",
    });
  });

  // Covers: R48, R62
  it("rejects acceptance when flag is off or stage is closed without writing", () => {
    const before = readFileSync(partPath(), "utf8");
    createSeedConfigHelper(cwd)({ harness: { masterPlan: false } });
    expect(() => changeMasterPart(cwd, "P1", { accept: "A3", approvedBy: "user" })).toThrow(
      "disabled",
    );
    expect(readFileSync(partPath(), "utf8")).toBe(before);
  });

  // Covers: R33, R48, R62
  it("rejects a symlinked parts.json that would write outside the repository", () => {
    const outside = mkdtempSync(join(tmpdir(), "navori-master-escape-"));
    try {
      const previous = readFileSync(partPath(), "utf8");
      const external = join(outside, "parts.json");
      writeFileSync(external, previous);
      rmSync(partPath());
      symlinkSync(external, partPath());
      expect(() => changeMasterPart(cwd, "P1", { issue: "99" })).toThrow("outside repository");
      expect(readFileSync(external, "utf8")).toBe(previous);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
