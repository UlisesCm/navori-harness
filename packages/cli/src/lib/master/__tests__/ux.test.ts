// Covers: A1, A2 (master_plan_ux F1/F2)
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkUxArtifacts, checkUxDecision, type UxContext } from "../ux.ts";

let cwd: string;
const stage = (): string => join(cwd, "01-mvp");

const ctxFor = (ux?: "none" | "md" | "md-json"): UxContext => ({
  stagePath: stage(),
  stage: { dir: "01-mvp" },
  state: { ux },
});

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-master-ux-"));
  mkdirSync(stage(), { recursive: true });
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("checkUxDecision", () => {
  it("fails naming the command when no decision is recorded, passes otherwise", () => {
    expect(checkUxDecision(ctxFor()).join("\n")).toContain("navori master ux");
    expect(checkUxDecision(ctxFor("none"))).toEqual([]);
  });
});

describe("checkUxArtifacts", () => {
  it("none + UX.md or ux.json fails; none alone passes", () => {
    expect(checkUxArtifacts(ctxFor("none"))).toEqual([]);
    writeFileSync(join(stage(), "UX.md"), "# UX\n");
    expect(checkUxArtifacts(ctxFor("none")).length).toBe(1);
    rmSync(join(stage(), "UX.md"));
    writeFileSync(join(stage(), "ux.json"), "{}");
    expect(checkUxArtifacts(ctxFor("none")).length).toBe(1);
  });

  it("md requires UX.md, passes without ux.json and fails with a stray ux.json", () => {
    expect(checkUxArtifacts(ctxFor("md")).length).toBe(1);
    writeFileSync(join(stage(), "UX.md"), "# UX\n");
    expect(checkUxArtifacts(ctxFor("md"))).toEqual([]);
    writeFileSync(join(stage(), "ux.json"), "{}");
    expect(checkUxArtifacts(ctxFor("md")).join("\n")).toContain("existe ux.json");
  });

  it("md-json requires UX.md and ux.json", () => {
    writeFileSync(join(stage(), "UX.md"), "# UX\n");
    expect(checkUxArtifacts(ctxFor("md-json")).length).toBe(1);
    writeFileSync(join(stage(), "ux.json"), "{}");
    expect(checkUxArtifacts(ctxFor("md-json"))).toEqual([]);
  });

  it("legacy (no decision) only rejects ux.json without UX.md", () => {
    expect(checkUxArtifacts(ctxFor())).toEqual([]);
    writeFileSync(join(stage(), "UX.md"), "# UX\n");
    expect(checkUxArtifacts(ctxFor())).toEqual([]);
    rmSync(join(stage(), "UX.md"));
    writeFileSync(join(stage(), "ux.json"), "{}");
    expect(checkUxArtifacts(ctxFor()).length).toBe(1);
  });
});
