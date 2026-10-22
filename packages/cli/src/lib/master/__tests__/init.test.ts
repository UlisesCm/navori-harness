import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runCommand } from "citty";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, writeConfig } from "../../config/config.ts";
import { writeFileAtomic } from "../../primitives/atomic.ts";
import { runMasterInit, MasterInitError } from "../init.ts";
import { masterDirPath, indexJsonPath, indexMdPath } from "../stages.ts";
import { masterCommand } from "../../../commands/master.ts";
import * as renderer from "../../../commands/render.ts";
import * as claude from "../../../engines/claude/index.ts";
import { injectManagedSection, splitUserSection } from "../../render/marker.ts";
import type { MasterIndex } from "../schema.ts";
import { createGitHelper, createCommitHelper, createSeedConfigHelper } from "./test-utils.ts";

async function master(...argv: string[]): Promise<void> {
  await runCommand(masterCommand, { rawArgs: [...argv, "--cwd", cwd] });
}

// Covers: R3, R4, R5, R16

let cwd: string;
const SPECS_DIR = "specs";

let git: (args: string[]) => void;
let commit: (message: string) => void;
let seedConfig: (overrides?: Record<string, unknown>) => void;

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
  git = createGitHelper(cwd);
  commit = createCommitHelper(git);
  seedConfig = createSeedConfigHelper(cwd);
  git(["init", "-q"]);
  seedConfig();
  commit("initial");
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(cwd, { recursive: true, force: true });
});

/** Renderer result fixture with the same contract as the existing owner. */
function renderOutcome(ok: boolean, reason?: string): ReturnType<typeof renderer.runRender> {
  return {
    ok,
    ...(reason === undefined ? {} : { reason }),
    language: "es",
    filePath: join(cwd, "CLAUDE.md"),
    entries: [],
    written: false,
    languageFallbacks: [],
    updatesAvailable: [],
    downgrades: [],
    workspaces: [],
  };
}

/** Durable cut fixture: init finishes its writes while rendering produces no artifacts. */
function interruptedStage(workflow: "legacy" | "deliveries" = "legacy"): void {
  const render = vi.spyOn(renderer, "runRender").mockReturnValueOnce(renderOutcome(true));
  runMasterInit(cwd, "mvp", workflow);
  render.mockRestore();
}

/** Snapshot only durable files; derived INDEX.md and STATUS.md may be regenerated. */
function durableBytes(): string[] {
  return [indexJsonPath(cwd, SPECS_DIR), stagePaths("01-mvp").stateJson].map(
    (path: string): string => readFileSync(path, "utf8"),
  );
}

/** Assert configured-engine content, not just the existence of a generated file. */
function expectEngineOutput(engine: "claude" | "agents-md"): void {
  const file = engine === "claude" ? "CLAUDE.md" : "AGENTS.md";
  expect(readFileSync(join(cwd, file), "utf8")).toContain(
    engine === "claude" ? "navori:managed" : "master-plan",
  );
  if (engine === "claude")
    expect(readFileSync(join(cwd, ".claude/skills/master-plan/SKILL.md"), "utf8")).toContain(
      "navori master",
    );
  else expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(false);
}

describe("runMasterInit — recovery and preservation (0049 M1)", () => {
  // Covers: R1
  it.each(["claude", "agents-md"] as const)(
    "repairs persisted activation for %s",
    (engine: "claude" | "agents-md"): void => {
      seedConfig({ engines: [engine], harness: { masterPlan: true } });
      runMasterInit(cwd, "mvp");
      expectEngineOutput(engine);
    },
  );

  // Covers: R1, R2
  it.each(["claude", "agents-md"] as const)(
    "repairs a durable interrupted stage for %s",
    (engine: "claude" | "agents-md"): void => {
      seedConfig({ engines: [engine] });
      interruptedStage();
      const before = durableBytes();
      expect(readConfig(join(cwd, "navori.config.json")).harness?.masterPlan).toBe(true);
      expect(existsSync(join(cwd, engine === "claude" ? "CLAUDE.md" : "AGENTS.md"))).toBe(false);
      expect(runMasterInit(cwd, undefined).stage.dir).toBe("01-mvp");
      expect(durableBytes()).toEqual(before);
      expectEngineOutput(engine);
    },
  );

  // Covers: R1, R2
  it.each([
    ["legacy", "throw"],
    ["legacy", "ok:false"],
    ["deliveries", "throw"],
    ["deliveries", "ok:false"],
  ] as const)(
    "recovers %s after %s without rewriting durable state",
    (workflow: "legacy" | "deliveries", failure: "throw" | "ok:false"): void => {
      interruptedStage(workflow);
      const statePath = stagePaths("01-mvp").stateJson;
      const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
      const phase = workflow === "legacy" ? "transcribed" : "execution";
      writeFileSync(
        statePath,
        JSON.stringify({
          ...state,
          phase,
          mode: "template",
          history: [
            { phase: "context", at: "2026-01-01" },
            { phase, at: "2026-01-02" },
          ],
        }),
      );
      const before = durableBytes();
      const configPath = join(cwd, "navori.config.json");
      const config = readConfig(configPath);
      writeConfig(configPath, { ...config, harness: { ...config.harness, masterPlan: false } });
      const render = vi.spyOn(renderer, "runRender");
      if (failure === "throw")
        render.mockImplementationOnce((): never => {
          throw new Error("interrupted render");
        });
      else render.mockReturnValueOnce(renderOutcome(false, "interrupted render"));
      expect(() => runMasterInit(cwd, "mvp", workflow)).toThrow(
        failure === "throw" ? "interrupted render" : "render failed: interrupted render",
      );
      if (failure === "ok:false") {
        render.mockReturnValueOnce(renderOutcome(false, "interrupted render"));
        expect(() => runMasterInit(cwd, undefined)).toThrow(MasterInitError);
      }
      render.mockRestore();
      expect(durableBytes()).toEqual(before);
      expect(readConfig(join(cwd, "navori.config.json")).harness?.masterPlan).toBe(true);
      const result = runMasterInit(cwd, undefined);
      expect(result).toMatchObject({ stage: { dir: "01-mvp" }, phase, mode: "template" });
      expect(durableBytes()).toEqual(before);
      expectEngineOutput("claude");
    },
  );

  // Covers: R2
  it.each(["claude", "agents-md"] as const)(
    "preserves phase, history and user prose for %s",
    (engine: "claude" | "agents-md"): void => {
      seedConfig({ engines: [engine] });
      runMasterInit(cwd, "mvp");
      const statePath = stagePaths("01-mvp").stateJson;
      const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
      writeFileSync(
        statePath,
        JSON.stringify({
          ...state,
          phase: "transcribed",
          mode: "template",
          history: [
            { phase: "context", at: "2026-01-01" },
            { phase: "transcribed", at: "2026-01-02" },
          ],
        }),
      );
      const file = join(cwd, engine === "claude" ? "CLAUDE.md" : "AGENTS.md");
      const prose = "\nUser-owned instructions: preserve spacing.  \nSecond line.\n";
      const generated = readFileSync(file, "utf8");
      writeFileSync(
        file,
        engine === "claude"
          ? generated.replace("<!-- navori:user-end -->", `${prose}<!-- navori:user-end -->`)
          : generated + prose,
      );
      const before = durableBytes();
      const userBody = splitUserSection(readFileSync(file, "utf8")).userBody;
      for (let i = 0; i < 2; i++) {
        expect(runMasterInit(cwd, undefined)).toMatchObject({
          stage: { dir: "01-mvp" },
          phase: "transcribed",
          mode: "template",
        });
        expect(durableBytes()).toEqual(before);
        expect(readFileSync(file, "utf8")).toContain(prose);
        expect(splitUserSection(readFileSync(file, "utf8")).userBody).toBe(userBody);
      }
    },
  );

  // Covers: R2
  it.each(["newer-marker", "config-floor", "edited-block"] as const)(
    "preserves %s through repeated init",
    (guard: "newer-marker" | "config-floor" | "edited-block"): void => {
      seedConfig({
        engines: ["agents-md"],
        harness: { masterPlan: true },
        ...(guard === "config-floor" ? { harnessVersion: "999.0.0" } : {}),
      });
      const protectedBody = "Protected managed content, different from current output.";
      const block = injectManagedSection("", "navori-agents", protectedBody, {
        version: guard === "newer-marker" ? "999.0.0" : "0.1.0",
        source: "@navori/core",
      }).output;
      const original =
        guard === "edited-block"
          ? block.replace(protectedBody, "User edited managed content.")
          : block;
      writeFileSync(join(cwd, "AGENTS.md"), original);
      runMasterInit(cwd, "mvp");
      runMasterInit(cwd, undefined);
      expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toBe(original);
      if (guard === "config-floor")
        expect(readConfig(join(cwd, "navori.config.json")).harnessVersion).toBe("999.0.0");
    },
  );

  // Covers: R2
  it("clears the ambient floor after a real render throws", (): void => {
    seedConfig({ harnessVersion: "999.0.0" });
    const engine = vi.spyOn(claude, "prepareClaudeEngine").mockImplementationOnce((): never => {
      throw new Error("engine interrupted");
    });
    expect(() => runMasterInit(cwd, "mvp")).toThrow("engine interrupted");
    engine.mockRestore();
    const old = injectManagedSection("", "probe", "old", { version: "0.1.0" }).output;
    expect(injectManagedSection(old, "probe", "new", { version: "0.2.0" }).status).not.toBe(
      "downgrade-skipped",
    );
    const unrelated = mkdtempSync(join(tmpdir(), "navori-floor-probe-"));
    try {
      createSeedConfigHelper(unrelated)({ engines: ["agents-md"], harness: { masterPlan: true } });
      const agentsPath = join(unrelated, "AGENTS.md");
      writeFileSync(
        agentsPath,
        injectManagedSection("", "navori-agents", "old unrelated body", { version: "0.1.0" })
          .output,
      );
      expect(renderer.runRender(unrelated).ok).toBe(true);
      expect(readFileSync(agentsPath, "utf8")).toContain("master-plan");
      expect(readFileSync(agentsPath, "utf8")).not.toContain("old unrelated body");
    } finally {
      rmSync(unrelated, { recursive: true, force: true });
    }
    runMasterInit(cwd, undefined);
    expectEngineOutput("claude");
  });

  // Covers: R1, R2
  it("recovers a valid preset without pruning disabled outputs or user prose", (): void => {
    seedConfig({ engines: ["agents-md"], preset: "vite-react-ts", harness: { masterPlan: true } });
    const sentinel = "Disabled Claude output must survive.\n";
    writeFileSync(join(cwd, "CLAUDE.md"), sentinel);
    writeFileSync(join(cwd, "AGENTS.md"), "User-owned project guidance.\n");
    runMasterInit(cwd, "mvp");
    runMasterInit(cwd, undefined);
    const agents = readFileSync(join(cwd, "AGENTS.md"), "utf8");
    expect(agents).toContain("master-plan");
    expect(agents).toContain("React");
    expect(agents).toContain("User-owned project guidance.\n");
    expect(readFileSync(join(cwd, "CLAUDE.md"), "utf8")).toBe(sentinel);
  });

  // Covers: R2
  it.each([
    "registry",
    "legacy-json",
    "legacy-schema",
    "delivery-json",
    "delivery-schema",
    "workflow",
    "parts",
    "symlink",
  ] as const)("validates %s before rendering or writing", (invalid: string): void => {
    seedConfig({ harness: { masterPlan: true } });
    interruptedStage(
      invalid.startsWith("delivery") || invalid === "parts" ? "deliveries" : "legacy",
    );
    const statePath = stagePaths("01-mvp").stateJson;
    if (invalid === "registry") writeFileSync(indexJsonPath(cwd, SPECS_DIR), "{");
    if (invalid.endsWith("json")) writeFileSync(statePath, "{");
    if (invalid.endsWith("schema")) writeFileSync(statePath, '{"version":999}');
    if (invalid === "parts")
      writeFileSync(join(stagePaths("01-mvp").root, "parts.json"), '{"version":2}');
    if (invalid === "symlink") {
      rmSync(stagePaths("01-mvp").plansDir, { recursive: true });
      symlinkSync(tmpdir(), stagePaths("01-mvp").plansDir, "dir");
    }
    writeFileSync(join(cwd, "CLAUDE.md"), "Harness sentinel\n");
    const paths = [
      join(cwd, "navori.config.json"),
      indexJsonPath(cwd, SPECS_DIR),
      statePath,
      join(cwd, "CLAUDE.md"),
    ];
    const before = paths.map((path: string): string => readFileSync(path, "utf8"));
    const render = vi.spyOn(renderer, "runRender");
    expect(() =>
      runMasterInit(cwd, undefined, invalid === "workflow" ? "deliveries" : undefined),
    ).toThrow();
    expect(render).not.toHaveBeenCalled();
    expect(paths.map((path: string): string => readFileSync(path, "utf8"))).toEqual(before);
  });
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

  // Covers: R54
  it("writes STATUS.md, which INDEX.md already links to", () => {
    runMasterInit(cwd, "mvp");
    expect(existsSync(join(masterDirPath(cwd, SPECS_DIR), "01-mvp", "STATUS.md"))).toBe(true);
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

describe("runMasterInit — slug reuse (R22)", () => {
  // Covers: R22
  it("init con el slug de una etapa abandonada falla nombrando la etapa previa", () => {
    const masterDir = masterDirPath(cwd, SPECS_DIR);
    writeIndexRaw({
      version: 1,
      stages: [
        {
          number: 1,
          slug: "mvp",
          dir: "01-mvp",
          state: "abandonada",
          openedAt: "2026-01-01",
          closedAt: "2026-02-01",
          spec: null,
        },
      ],
    });
    mkdirSync(join(masterDir, "01-mvp"), { recursive: true });
    const before = readFileSync(indexJsonPath(cwd, SPECS_DIR), "utf8");

    expect(() => runMasterInit(cwd, "mvp")).toThrow(/slug "mvp" ya lo usó la etapa 01-mvp/);
    expect(readFileSync(indexJsonPath(cwd, SPECS_DIR), "utf8")).toBe(before);
    expect(runMasterInit(cwd, "otro").stage.dir).toBe("02-otro");
  });
});

describe("navori master init — context guidance", () => {
  it("prints the repo-relative raw/ path when the phase is context", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await master("init", "mvp");
    const out = write.mock.calls.map((c) => String(c[0])).join("");
    write.mockRestore();
    expect(out).toContain("specs/_master/01-mvp/context/raw/");
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

  it("registers desde-cero for the first stage", async () => {
    runMasterInit(cwd, "mvp");
    process.exitCode = undefined;
    await master("mode", "desde-cero");
    expect(process.exitCode).toBeFalsy();
    expect(stateOf("01-mvp").mode).toBe("desde-cero");
  });

  it("names all three modes in the invalid-mode error", async () => {
    runMasterInit(cwd, "mvp");
    process.exitCode = undefined;
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await master("mode", "not-a-mode");
    const out = write.mock.calls.map((c) => String(c[0])).join("");
    write.mockRestore();
    expect(out).toContain('"desde-cero"');
    process.exitCode = undefined;
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
