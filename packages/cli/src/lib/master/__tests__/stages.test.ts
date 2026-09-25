import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readMasterIndex,
  MasterIndexError,
  nextStageNumber,
  isValidSlug,
  activeStage,
  renderIndexMd,
  contextForArchitects,
  masterDirPath,
} from "../stages.ts";
import type { MasterIndex, StageEntry } from "../schema.ts";

// Covers: R3, R5, R50, R52, R53, R54

let cwd: string;
const SPECS_DIR = "specs";

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-master-stages-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function writeIndex(index: MasterIndex): void {
  mkdirSync(masterDirPath(cwd, SPECS_DIR), { recursive: true });
  writeFileSync(
    join(masterDirPath(cwd, SPECS_DIR), "index.json"),
    `${JSON.stringify(index, null, 2)}\n`,
  );
}

function makeStageFolder(dir: string): void {
  mkdirSync(join(masterDirPath(cwd, SPECS_DIR), dir), { recursive: true });
}

function stage(overrides: Partial<StageEntry> = {}): StageEntry {
  return {
    number: 1,
    slug: "mvp",
    dir: "01-mvp",
    state: "activa",
    openedAt: "2026-09-25",
    closedAt: null,
    spec: null,
    ...overrides,
  };
}

describe("readMasterIndex — numbering and gaps", () => {
  it("numbers the first stage 01, the second 02", () => {
    const s1 = stage({
      number: 1,
      slug: "mvp",
      dir: "01-mvp",
      state: "cerrada",
      closedAt: "2026-10-01",
    });
    writeIndex({ version: 1, stages: [s1] });
    makeStageFolder("01-mvp");
    const index = readMasterIndex(cwd, SPECS_DIR);
    expect(nextStageNumber(index)).toBe(2);
  });

  it("numbers past a gap: entry 03 closed, folder 02 deleted, next is 04", () => {
    const stages = [
      stage({ number: 1, slug: "a", dir: "01-a", state: "cerrada", closedAt: "2026-09-01" }),
      stage({ number: 3, slug: "c", dir: "03-c", state: "cerrada", closedAt: "2026-09-10" }),
    ];
    writeIndex({ version: 1, stages });
    makeStageFolder("01-a");
    makeStageFolder("03-c");
    const index = readMasterIndex(cwd, SPECS_DIR);
    expect(nextStageNumber(index)).toBe(4);
  });
});

describe("isValidSlug", () => {
  it("accepts kebab-case slugs", () => {
    expect(isValidSlug("mvp")).toBe(true);
    expect(isValidSlug("mvp-pagos")).toBe(true);
  });

  it("rejects an invalid slug", () => {
    expect(isValidSlug("MVP")).toBe(false);
    expect(isValidSlug("mvp_pagos")).toBe(false);
    expect(isValidSlug("")).toBe(false);
    expect(isValidSlug("a".repeat(41))).toBe(false);
  });
});

describe("readMasterIndex — filesystem invariants", () => {
  it("fails when two stages are activa", () => {
    // This can only happen via a hand-edited index.json (schema forbids it
    // via `.parse`, but the raw JSON itself models the on-disk failure mode).
    mkdirSync(masterDirPath(cwd, SPECS_DIR), { recursive: true });
    writeFileSync(
      join(masterDirPath(cwd, SPECS_DIR), "index.json"),
      JSON.stringify({
        version: 1,
        stages: [
          stage({ number: 1, slug: "a", dir: "01-a", state: "activa" }),
          stage({ number: 2, slug: "b", dir: "02-b", state: "activa" }),
        ],
      }),
    );
    makeStageFolder("01-a");
    makeStageFolder("02-b");
    expect(() => readMasterIndex(cwd, SPECS_DIR)).toThrow(MasterIndexError);
  });

  it("fails when a folder has no entry in index.json", () => {
    writeIndex({ version: 1, stages: [stage({ state: "activa" })] });
    makeStageFolder("01-mvp");
    makeStageFolder("02-orphan"); // no entry
    expect(() => readMasterIndex(cwd, SPECS_DIR)).toThrow(MasterIndexError);
  });

  it("fails when a closed entry has no folder", () => {
    writeIndex({
      version: 1,
      stages: [stage({ state: "cerrada", closedAt: "2026-10-01" })],
    });
    // No folder created for 01-mvp.
    expect(() => readMasterIndex(cwd, SPECS_DIR)).toThrow(MasterIndexError);
  });

  it("fails when dir does not match number/slug", () => {
    mkdirSync(masterDirPath(cwd, SPECS_DIR), { recursive: true });
    writeFileSync(
      join(masterDirPath(cwd, SPECS_DIR), "index.json"),
      JSON.stringify({ version: 1, stages: [stage({ number: 1, slug: "mvp", dir: "01-other" })] }),
    );
    makeStageFolder("01-other");
    expect(() => readMasterIndex(cwd, SPECS_DIR)).toThrow(MasterIndexError);
  });

  it("does NOT fail when the active entry has no folder yet (init cut between steps)", () => {
    writeIndex({ version: 1, stages: [stage({ state: "activa" })] });
    // No folder created for 01-mvp on purpose.
    expect(() => readMasterIndex(cwd, SPECS_DIR)).not.toThrow();
  });

  it("returns null when index.json does not exist", () => {
    expect(readMasterIndex(cwd, SPECS_DIR)).toBeNull();
  });
});

describe("renderIndexMd — deterministic output (R54)", () => {
  it("is byte-identical across two runs on the same input", () => {
    const index: MasterIndex = {
      version: 1,
      stages: [stage({ state: "activa" })],
    };
    const first = renderIndexMd(index, SPECS_DIR);
    const second = renderIndexMd(index, SPECS_DIR);
    expect(first).toBe(second);
    expect(first.split("\n")[0]).toBe("Etapa activa: specs/_master/01-mvp/STATUS.md");
  });

  it("first line says 'ninguna' with no active stage", () => {
    const index: MasterIndex = { version: 1, stages: [] };
    expect(renderIndexMd(index, SPECS_DIR).split("\n")[0]).toBe("Etapa activa: ninguna");
  });
});

describe("activeStage", () => {
  it("resolves the active stage from the index", () => {
    const index: MasterIndex = { version: 1, stages: [stage({ state: "activa" })] };
    expect(activeStage(index)?.dir).toBe("01-mvp");
  });

  it("returns null with no index or no active stage", () => {
    expect(activeStage(null)).toBeNull();
    expect(activeStage({ version: 1, stages: [] })).toBeNull();
  });
});

describe("contextForArchitects — R52 fixture", () => {
  it("returns null for stage 1 (nothing to read yet)", () => {
    const index: MasterIndex = { version: 1, stages: [stage({ state: "activa" })] };
    expect(contextForArchitects(index)).toBeNull();
  });

  it("computes full vs reference-only reading lists over four stages", () => {
    const index: MasterIndex = {
      version: 1,
      stages: [
        stage({ number: 1, slug: "a", dir: "01-a", state: "cerrada", closedAt: "2026-01-01" }),
        stage({ number: 2, slug: "b", dir: "02-b", state: "cerrada", closedAt: "2026-02-01" }),
        stage({ number: 3, slug: "c", dir: "03-c", state: "abandonada", closedAt: "2026-03-01" }),
        stage({ number: 4, slug: "d", dir: "04-d", state: "activa", closedAt: null }),
      ],
    };
    const ctx = contextForArchitects(index);
    expect(ctx).not.toBeNull();
    expect(ctx!.full).toEqual([
      "02-b/MASTER.md",
      "02-b/DECISIONS.md",
      "02-b/CLOSURE.md",
      "03-c/DECISIONS.md",
      "03-c/CLOSURE.md",
    ]);
    expect(ctx!.referenceOnly).toEqual(["01-a/CLOSURE.md", "INDEX.md"]);
  });
});
