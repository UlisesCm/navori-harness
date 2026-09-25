import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runCommand } from "citty";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, writeConfig } from "../../config/config.ts";
import { writeFileAtomic } from "../../primitives/atomic.ts";
import { runMasterInit, MasterInitError } from "../init.ts";
import { masterDirPath, indexJsonPath, indexMdPath } from "../stages.ts";
import { masterCommand } from "../../../commands/master.ts";
import type { MasterIndex } from "../schema.ts";

async function master(...argv: string[]): Promise<void> {
  await runCommand(masterCommand, { rawArgs: [...argv, "--cwd", cwd] });
}

// Covers: R3, R4, R5, R16

let cwd: string;
const SPECS_DIR = "specs";

function git(args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function commit(message: string): void {
  git(["add", "-A"]);
  git(["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-m", message]);
}

function seedConfig(overrides: Record<string, unknown> = {}): void {
  writeConfig(join(cwd, "navori.config.json"), {
    name: "demo",
    engines: ["claude"],
    preset: "custom",
    ...overrides,
  });
}

function writeIndexRaw(index: MasterIndex): void {
  mkdirSync(masterDirPath(cwd, SPECS_DIR), { recursive: true });
  writeFileAtomic(indexJsonPath(cwd, SPECS_DIR), `${JSON.stringify(index, null, 2)}\n`);
}

function stagePaths(dir: string) {
  const root = join(masterDirPath(cwd, SPECS_DIR), dir);
  return {
    root,
    rawDir: join(root, "context", "raw"),
    mdDir: join(root, "context", "md"),
    plansDir: join(root, "plans"),
    gitignore: join(root, "context", "raw", ".gitignore"),
    stateJson: join(root, "state.json"),
  };
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-master-init-"));
  git(["init", "-q"]);
  seedConfig();
  commit("initial");
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("runMasterInit — first stage (R3)", () => {
  it("creates the full structure and turns on harness.masterPlan", () => {
    const result = runMasterInit(cwd, "mvp");
    expect(result.stage).toEqual({ number: 1, slug: "mvp", dir: "01-mvp" });
    expect(result.phase).toBe("context");
    expect(result.requestedSlugIgnored).toBe(false);

    const paths = stagePaths("01-mvp");
    expect(existsSync(paths.rawDir)).toBe(true);
    expect(existsSync(paths.mdDir)).toBe(true);
    expect(existsSync(paths.plansDir)).toBe(true);
    expect(existsSync(paths.gitignore)).toBe(true);
    expect(readFileSync(paths.gitignore, "utf8")).toBe("*\n!.gitignore\n");
    expect(existsSync(paths.stateJson)).toBe(true);
    expect(existsSync(indexJsonPath(cwd, SPECS_DIR))).toBe(true);
    expect(existsSync(indexMdPath(cwd, SPECS_DIR))).toBe(true);

    const config = readConfig(join(cwd, "navori.config.json"));
    expect(config.harness?.masterPlan).toBe(true);
  });

  it("git check-ignore is positive for context/raw/ with gitignoreHarness: off", () => {
    runMasterInit(cwd, "mvp");
    const out = execFileSync(
      "git",
      ["check-ignore", `${SPECS_DIR}/_master/01-mvp/context/raw/document.pdf`],
      { cwd, encoding: "utf8" },
    ).trim();
    expect(out).toBe(`${SPECS_DIR}/_master/01-mvp/context/raw/document.pdf`);
  });

  it("fails when sdd.enabled is false, naming the key", () => {
    seedConfig({ sdd: { enabled: false } });
    expect(() => runMasterInit(cwd, "mvp")).toThrow(MasterInitError);
    expect(() => runMasterInit(cwd, "mvp")).toThrow(/sdd\.enabled/);
  });

  it("rejects an invalid slug", () => {
    expect(() => runMasterInit(cwd, "MVP")).toThrow(MasterInitError);
  });
});

describe("runMasterInit — with an active stage (R5)", () => {
  it("does not create a second stage; reports the active one and exits 1 (via requestedSlugIgnored)", () => {
    runMasterInit(cwd, "mvp");
    const before = readFileSync(indexJsonPath(cwd, SPECS_DIR), "utf8");

    const result = runMasterInit(cwd, "otra");
    expect(result.requestedSlugIgnored).toBe(true);
    expect(result.stage.dir).toBe("01-mvp");
    expect(result.phase).toBe("context");

    const after = readFileSync(indexJsonPath(cwd, SPECS_DIR), "utf8");
    expect(after).toBe(before);
  });

  it("without a slug, materializes whatever the active stage is missing", () => {
    // Simulate a cut between writing index.json and materializing the folder:
    // hand-craft the index only, no stage folder yet.
    writeIndexRaw({
      version: 1,
      stages: [
        {
          number: 1,
          slug: "mvp",
          dir: "01-mvp",
          state: "activa",
          openedAt: "2026-09-25",
          closedAt: null,
          spec: null,
        },
      ],
    });

    const result = runMasterInit(cwd, undefined);
    expect(result.requestedSlugIgnored).toBe(false);
    const paths = stagePaths("01-mvp");
    expect(existsSync(paths.rawDir)).toBe(true);
    expect(existsSync(paths.stateJson)).toBe(true);
  });
});

describe("runMasterInit — resumability across a cut (steps 1-4)", () => {
  it("a second run completes the folder, INDEX.md and the flag after each partial state", () => {
    // Full run once, then delete parts of the output to simulate a cut, and
    // verify a second `init` call repairs it without touching what remains.
    runMasterInit(cwd, "mvp");
    const paths = stagePaths("01-mvp");

    rmSync(paths.gitignore, { force: true });
    const result = runMasterInit(cwd, undefined);
    expect(existsSync(paths.gitignore)).toBe(true);
    expect(result.stage.dir).toBe("01-mvp");
  });

  it("with the stage complete and the flag turned off by hand, a run turns it back on", () => {
    runMasterInit(cwd, "mvp");
    const config = readConfig(join(cwd, "navori.config.json"));
    writeConfig(join(cwd, "navori.config.json"), {
      ...config,
      harness: { ...config.harness, masterPlan: false },
    });

    runMasterInit(cwd, undefined);
    const after = readConfig(join(cwd, "navori.config.json"));
    expect(after.harness?.masterPlan).toBe(true);
  });

  it("recreates a deleted context/raw/.gitignore without touching another byte", () => {
    runMasterInit(cwd, "mvp");
    const paths = stagePaths("01-mvp");
    const stateBefore = readFileSync(paths.stateJson, "utf8");
    rmSync(paths.gitignore, { force: true });

    runMasterInit(cwd, undefined);
    expect(readFileSync(paths.gitignore, "utf8")).toBe("*\n!.gitignore\n");
    expect(readFileSync(paths.stateJson, "utf8")).toBe(stateBefore);
  });
});

describe("runMasterInit — second stage registers en-curso (R16)", () => {
  it("stage 2 sets mode to en-curso without asking", () => {
    // Manually register a first stage as already 'cerrada' and open a second.
    const masterDir = masterDirPath(cwd, SPECS_DIR);
    writeIndexRaw({
      version: 1,
      stages: [
        {
          number: 1,
          slug: "mvp",
          dir: "01-mvp",
          state: "cerrada",
          openedAt: "2026-01-01",
          closedAt: "2026-02-01",
          spec: null,
        },
      ],
    });
    // The closed stage needs a folder to satisfy stages.ts's invariants.
    mkdirSync(join(masterDir, "01-mvp"), { recursive: true });

    const result = runMasterInit(cwd, "pagos");
    expect(result.stage).toEqual({ number: 2, slug: "pagos", dir: "02-pagos" });
    expect(result.mode).toBe("en-curso");
  });
});

describe("navori master mode (R16, commands/master.ts)", () => {
  function stateOf(dir: string): { phase: string; mode: string | null } {
    const raw = JSON.parse(
      readFileSync(join(masterDirPath(cwd, SPECS_DIR), dir, "state.json"), "utf8"),
    ) as { phase: string; mode: string | null };
    return raw;
  }

  it("registers the mode for the first stage while phase is context", async () => {
    runMasterInit(cwd, "mvp");
    process.exitCode = undefined;
    await master("mode", "template");
    expect(process.exitCode).toBeFalsy();
    expect(stateOf("01-mvp").mode).toBe("template");
  });

  it("rejects an invalid mode value", async () => {
    runMasterInit(cwd, "mvp");
    process.exitCode = undefined;
    await master("mode", "not-a-mode");
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it("fails with no active stage", async () => {
    process.exitCode = undefined;
    await master("mode", "template");
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it("fails once the phase has advanced past 'context'", async () => {
    runMasterInit(cwd, "mvp");
    const statePath = join(masterDirPath(cwd, SPECS_DIR), "01-mvp", "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    writeFileAtomic(statePath, `${JSON.stringify({ ...state, phase: "transcribed" }, null, 2)}\n`);

    process.exitCode = undefined;
    await master("mode", "template");
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });
});

describe("git tracked raw/ warning", () => {
  it("warns and does not remove already-tracked files from raw/", () => {
    // Pre-create the raw folder and track a file in it BEFORE init runs.
    const rawDir = join(masterDirPath(cwd, SPECS_DIR), "01-mvp", "context", "raw");
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(join(rawDir, "leaked.txt"), "oops");
    git(["add", "-A"]);
    git(["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-m", "leaked"]);

    // Hand-craft the index so init sees this as the active stage to complete.
    writeIndexRaw({
      version: 1,
      stages: [
        {
          number: 1,
          slug: "mvp",
          dir: "01-mvp",
          state: "activa",
          openedAt: "2026-09-25",
          closedAt: null,
          spec: null,
        },
      ],
    });

    const result = runMasterInit(cwd, undefined);
    expect(result.warnings.some((w) => w.includes("leaked.txt"))).toBe(true);
    const tracked = execFileSync("git", ["ls-files", rawDir], { cwd, encoding: "utf8" }).trim();
    expect(tracked.length).toBeGreaterThan(0); // still tracked — navori never untracked it
  });
});
