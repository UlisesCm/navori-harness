import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";
import { planCommand } from "../plan.ts";
import { computeWorktreeTree, readHead } from "../../lib/plan/evidence.ts";

/** Lets a test edit the workplan "between phases" of `plan update`: runs right
 * after the real evidence validation, before the lock is taken (R11). */
const evidenceHook = vi.hoisted(() => ({ afterValidate: undefined as (() => void) | undefined }));
vi.mock("../../lib/plan/evidence.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/plan/evidence.ts")>();
  return {
    ...actual,
    validateEvidence: (...args: Parameters<typeof actual.validateEvidence>) => {
      const verdict = actual.validateEvidence(...args);
      evidenceHook.afterValidate?.();
      return verdict;
    },
  };
});

let cwd: string;
const dir = ".claude/progress";

beforeEach(() => {
  vi.stubEnv("CODEX_THREAD_ID", undefined);
  evidenceHook.afterValidate = undefined;
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "navori-plan-")));
  execFileSync("git", ["init", "-b", "main"], { cwd });
  process.exitCode = undefined;
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(cwd, { recursive: true, force: true });
  process.exitCode = undefined;
});

function writePlan(feature: string, plan: unknown): void {
  mkdirSync(join(cwd, dir), { recursive: true });
  writeFileSync(join(cwd, dir, `workplan_${feature}.json`), JSON.stringify(plan, null, 2));
}

const validPlan = {
  feature: "demo",
  level: 1,
  classification: { score: 2, level: 1, signals: [] },
  objective: "Ship the plan CLI.",
  acceptance: [
    { id: "A1", description: "commands work", command: "bun test plan.test.ts", expected: "pass" },
  ],
  outOfScope: [],
  files: [],
  progress: { A1: "pendiente" },
  decisions: [],
};

/** Covers: R1, R11, R12, R15 */
describe("navori plan classify", () => {
  it("computes a level from a comma-separated file list", async () => {
    const logs: string[] = [];
    const spy = vi_spyConsole(logs);
    await runCommand(planCommand, {
      rawArgs: [
        "classify",
        "demo",
        "--files",
        "src/a.ts,src/b.ts,src/c.ts",
        "--json",
        "--cwd",
        cwd,
      ],
    });
    spy.restore();
    const parsed = JSON.parse(logs.join(""));
    expect(parsed.level).toBeGreaterThanOrEqual(1);
    expect(typeof parsed.score).toBe("number");
  });

  // Covers: R6
  it("rejects an ancestor-symlinked command cwd before it selects another checkout", async () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), "navori-plan-other-")));
    execFileSync("git", ["init", "-b", "main"], { cwd: other });
    mkdirSync(join(other, "sub"));
    symlinkSync(other, join(cwd, "alias"));
    await expect(
      runCommand(planCommand, {
        rawArgs: ["classify", "demo", "--files", "src/a.ts", "--cwd", join(cwd, "alias", "sub")],
      }),
    ).rejects.toThrow("symlinked --cwd");
    rmSync(other, { recursive: true, force: true });
  });

  it("forces level 2 when a floor flag is declared", async () => {
    const logs: string[] = [];
    const spy = vi_spyConsole(logs);
    await runCommand(planCommand, {
      rawArgs: [
        "classify",
        "demo",
        "--files",
        "src/a.ts",
        "--data-schema-migration",
        "--json",
        "--cwd",
        cwd,
      ],
    });
    spy.restore();
    const parsed = JSON.parse(logs.join(""));
    expect(parsed.level).toBe(2);
  });

  /** Writes a workplan draft (pre-`classify`, no `level`/`classification`
   * required) with the given `files`/`signals` for the "no --files" fallback
   * tests below (#1067) — shared instead of repeated per test to avoid
   * duplicating the fixture (jscpd). */
  function writeDraft(files: string[], signals?: string[]): void {
    mkdirSync(join(cwd, dir), { recursive: true });
    writeFileSync(
      join(cwd, dir, "workplan_demo.json"),
      JSON.stringify({
        feature: "demo",
        objective: "Ship it",
        files: files.map((path) => ({ path, new: false })),
        ...(signals ? { classification: { signals } } : {}),
      }),
    );
  }

  /** Runs `classify demo --json [...extraArgs]` and returns the parsed
   * result — shared by the draft-fallback tests. */
  async function classifyDemoJson(extraArgs: string[]): Promise<{ level: number; score: number }> {
    const logs: string[] = [];
    const spy = vi_spyConsole(logs);
    await runCommand(planCommand, {
      rawArgs: ["classify", "demo", "--json", "--cwd", cwd, ...extraArgs],
    });
    spy.restore();
    return JSON.parse(logs.join(""));
  }

  // Covers: #1067
  it("falls back to the draft workplan's files when --files is omitted", async () => {
    writeDraft(["src/a.ts", "src/b.ts", "src/c.ts"]);
    const parsed = await classifyDemoJson([]);
    expect(parsed.level).toBeGreaterThanOrEqual(1);
    expect(typeof parsed.score).toBe("number");
  });

  // Covers: #1067
  it("prefers an explicit --files over the draft workplan", async () => {
    writeDraft(["src/a.ts", "src/b.ts", "src/c.ts"]);
    const parsed = await classifyDemoJson(["--files", "src/only.ts"]);
    expect(parsed.level).toBe(0);
  });

  // Covers: #1067
  it("reuses the draft workplan's declared signals when --files is omitted", async () => {
    writeDraft(["src/a.ts"], ["floor:data-schema-migration"]);
    const parsed = await classifyDemoJson([]);
    expect(parsed.level).toBe(2);
  });

  // Covers: R17
  it("classify sin archivos ni borrador falla con error de uso", async () => {
    const logs: string[] = [];
    const spy = vi_spyConsole(logs);
    await runCommand(planCommand, { rawArgs: ["classify", "demo", "--json", "--cwd", cwd] });
    const noDraftExit = process.exitCode;
    // A draft whose `files` is empty is the same silent-level-0 trap.
    writeDraft([]);
    process.exitCode = undefined;
    await runCommand(planCommand, { rawArgs: ["classify", "demo", "--json", "--cwd", cwd] });
    spy.restore();
    expect(noDraftExit).toBe(1);
    expect(process.exitCode).toBe(1);
    expect(logs.join("")).toBe("");
  });

  // Covers: #1067
  it("fails with a clear message when the draft workplan is not readable JSON", async () => {
    mkdirSync(join(cwd, dir), { recursive: true });
    writeFileSync(join(cwd, dir, "workplan_demo.json"), "{not json");
    const logs: string[] = [];
    const spy = vi_spyConsole(logs);
    await runCommand(planCommand, {
      rawArgs: ["classify", "demo", "--cwd", cwd],
    });
    spy.restore();
    expect(process.exitCode).toBe(1);
  });
});

/** Sets up a real git repo at `cwd` with a `main` base commit and, on top of
 * it, a second commit touching `files` — the shape `plan classify --diff`
 * needs, since it shells out to real `git diff --name-only`. */
function gitRepoWithDiff(files: string[]): void {
  const run = (...args: string[]): void => {
    execFileSync("git", args, { cwd });
  };
  run("init", "-q", "-b", "main");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "test");
  writeFileSync(join(cwd, "README.md"), "base\n");
  run("add", "README.md");
  run("commit", "-q", "-m", "base");
  run("checkout", "-q", "-b", "feature");
  for (const file of files) {
    mkdirSync(join(cwd, ...file.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(cwd, file), "content\n");
  }
  run("add", "-A");
  run("commit", "-q", "-m", "diff");
}

/** Covers: R21 */
describe("navori plan classify --diff", () => {
  it("classifies the real diff and exits 0 when it stays within the declared level", async () => {
    gitRepoWithDiff(["src/a.ts"]);
    writePlan("demo", {
      ...validPlan,
      level: 1,
      classification: { score: 2, level: 1, signals: [] },
    });
    const logs: string[] = [];
    const spy = vi_spyConsole(logs);
    await runCommand(planCommand, {
      rawArgs: ["classify", "demo", "--diff", "main", "--json", "--cwd", cwd],
    });
    spy.restore();
    const parsed = JSON.parse(logs.join(""));
    // The untracked workplan itself is part of the work tree's diff (R18).
    expect(parsed.files).toEqual([".claude/progress/workplan_demo.json", "src/a.ts"]);
    expect(parsed.declaredLevel).toBe(1);
    expect(parsed.exceedsDeclared).toBe(false);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("exits non-zero when the diff's level exceeds the declared level", async () => {
    gitRepoWithDiff(["src/a.ts"]);
    writePlan("demo", {
      ...validPlan,
      level: 1,
      // A declared floor (recovered via `declaredFlagsFromSignals`) forces
      // level 2 regardless of how small the diff is.
      classification: { score: 2, level: 1, signals: ["floor:data-schema-migration"] },
    });
    const logs: string[] = [];
    const spy = vi_spyConsole(logs);
    await runCommand(planCommand, {
      rawArgs: ["classify", "demo", "--diff", "main", "--json", "--cwd", cwd],
    });
    spy.restore();
    const parsed = JSON.parse(logs.join(""));
    expect(parsed.level).toBe(2);
    expect(parsed.exceedsDeclared).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  /** Runs `classify --diff` in text mode (no `--json`) against a "demo"
   * plan carrying the given signals, returning everything it printed. */
  async function classifyDiffText(signals: string[]): Promise<string> {
    gitRepoWithDiff(["src/a.ts"]);
    writePlan("demo", {
      ...validPlan,
      level: 1,
      classification: { score: 2, level: 1, signals },
    });
    const logs: string[] = [];
    const spy = vi_spyConsole(logs);
    await runCommand(planCommand, {
      rawArgs: ["classify", "demo", "--diff", "main", "--cwd", cwd],
    });
    spy.restore();
    return logs.join("");
  }

  it("names the exceedance explicitly in the text output, not just the exit code", async () => {
    const text = await classifyDiffText(["floor:data-schema-migration"]);
    expect(text).toContain("Exceeds declared level: yes");
    expect(text).toContain("level 2 > 1");
  });

  it("says the diff stayed within the declared level in the text output", async () => {
    const text = await classifyDiffText([]);
    expect(text).toContain("Exceeds declared level: no");
  });

  it("defaults the base to origin/main when --diff has no value", async () => {
    gitRepoWithDiff(["src/a.ts"]);
    execFileSync("git", ["branch", "origin/main", "main"], { cwd });
    writePlan("demo", validPlan);
    await runCommand(planCommand, {
      rawArgs: ["classify", "demo", "--diff", "--cwd", cwd],
    });
    // origin/main == main here, so the diff is empty and level stays declared.
    expect(process.exitCode ?? 0).toBe(0);
  });

  // Covers: R18
  it("classify --diff incluye un archivo sin commitear y otro sin seguimiento contra origin/prTarget", async () => {
    gitRepoWithDiff(["src/a.ts"]);
    // Only `origin/develop` exists: the default base must come from `prTarget`.
    execFileSync("git", ["branch", "origin/develop", "main"], { cwd });
    writeFileSync(
      join(cwd, "navori.config.json"),
      JSON.stringify({
        name: "demo",
        engines: ["claude"],
        preset: "custom",
        qualityGate: { full: "true", fast: "true" },
        branchBase: "main",
        prTarget: "develop",
      }),
    );
    writeFileSync(join(cwd, "README.md"), "edited, not committed\n");
    writeFileSync(join(cwd, "untracked.ts"), "export {};\n");
    writePlan("demo", validPlan);
    const logs: string[] = [];
    const spy = vi_spyConsole(logs);
    await runCommand(planCommand, {
      rawArgs: ["classify", "demo", "--diff", "--json", "--cwd", cwd],
    });
    spy.restore();
    const parsed = JSON.parse(logs.join(""));
    expect(parsed.base).toBe("origin/develop");
    expect(parsed.files).toEqual(expect.arrayContaining(["src/a.ts", "README.md", "untracked.ts"]));
  });

  it("fails when the feature has no workplan", async () => {
    gitRepoWithDiff(["src/a.ts"]);
    await runCommand(planCommand, {
      rawArgs: ["classify", "absent", "--diff", "main", "--cwd", cwd],
    });
    expect(process.exitCode).toBe(1);
  });
});

describe("navori plan render", () => {
  it("renders workplan_<feature>.md from the JSON source (R11)", async () => {
    writePlan("demo", validPlan);
    await runCommand(planCommand, { rawArgs: ["render", "demo", "--cwd", cwd] });
    const mdFile = join(cwd, dir, "workplan_demo.md");
    expect(existsSync(mdFile)).toBe(true);
    const first = readFileSync(mdFile, "utf8");
    await runCommand(planCommand, { rawArgs: ["render", "demo", "--cwd", cwd] });
    const second = readFileSync(mdFile, "utf8");
    expect(second).toBe(first);
  });

  // Covers: R6
  it("rejects a preexisting render temporary symlink without writing outside the checkout", async () => {
    writePlan("demo", validPlan);
    const external = mkdtempSync(join(tmpdir(), "navori-plan-external-"));
    const outside = join(external, "outside.md");
    writeFileSync(outside, "unchanged\n");
    symlinkSync(outside, join(cwd, dir, `.workplan_demo.md.tmp-${process.pid}`));
    await expect(
      runCommand(planCommand, { rawArgs: ["render", "demo", "--cwd", cwd] }),
    ).rejects.toThrow("escapes checkout");
    expect(readFileSync(outside, "utf8")).toBe("unchanged\n");
    rmSync(external, { recursive: true, force: true });
  });

  it("fails when the JSON does not match the schema", async () => {
    writePlan("broken", { feature: "broken" });
    await runCommand(planCommand, { rawArgs: ["render", "broken", "--cwd", cwd] });
    expect(process.exitCode).toBe(1);
  });
});

describe("navori plan update", () => {
  it("changes an A<n>'s progress and re-renders (R12)", async () => {
    writePlan("demo", validPlan);
    await runCommand(planCommand, {
      rawArgs: ["update", "demo", "--progress", "A1=cumplido", "--cwd", cwd],
    });
    const updated: typeof validPlan = JSON.parse(
      readFileSync(join(cwd, dir, "workplan_demo.json"), "utf8"),
    );
    expect(updated.progress.A1).toBe("cumplido");
    const md = readFileSync(join(cwd, dir, "workplan_demo.md"), "utf8");
    expect(md).toContain("**A1** (cumplido, sin evidencia: engine sin señal)");
  });

  // Covers: R6
  it("rejects a preexisting update temporary symlink without writing outside the checkout", async () => {
    writePlan("demo", validPlan);
    const external = mkdtempSync(join(tmpdir(), "navori-plan-external-"));
    const outside = join(external, "outside.json");
    writeFileSync(outside, "unchanged\n");
    symlinkSync(outside, join(cwd, dir, `.workplan_demo.json.tmp-${process.pid}`));
    await expect(
      runCommand(planCommand, {
        rawArgs: ["update", "demo", "--progress", "A1=cumplido", "--cwd", cwd],
      }),
    ).rejects.toThrow("escapes checkout");
    expect(readFileSync(outside, "utf8")).toBe("unchanged\n");
    rmSync(external, { recursive: true, force: true });
  });

  it("applies two --progress flags in a single call (repeated citty flag)", async () => {
    writePlan("demo", {
      ...validPlan,
      acceptance: [
        ...validPlan.acceptance,
        { id: "A2", description: "second gate", command: "bun test", expected: "pass" },
      ],
      progress: { A1: "pendiente", A2: "pendiente" },
    });
    await runCommand(planCommand, {
      rawArgs: [
        "update",
        "demo",
        "--progress",
        "A1=cumplido",
        "--progress",
        "A2=cumplido",
        "--cwd",
        cwd,
      ],
    });
    const updated: { progress: Record<string, string> } = JSON.parse(
      readFileSync(join(cwd, dir, "workplan_demo.json"), "utf8"),
    );
    expect(updated.progress.A1).toBe("cumplido");
    expect(updated.progress.A2).toBe("cumplido");
  });

  it("rejects a repeated --progress with one malformed entry, leaving the file unchanged", async () => {
    writePlan("demo", validPlan);
    const before = readFileSync(join(cwd, dir, "workplan_demo.json"), "utf8");
    const logs: string[] = [];
    const spy = vi_spyConsole(logs);
    await runCommand(planCommand, {
      rawArgs: ["update", "demo", "--progress", "A1=cumplido", "--progress", "bogus", "--cwd", cwd],
    });
    spy.restore();
    expect(process.exitCode).toBe(1);
    const after = readFileSync(join(cwd, dir, "workplan_demo.json"), "utf8");
    expect(after).toBe(before);
  });

  it("appends a decision", async () => {
    writePlan("demo", validPlan);
    await runCommand(planCommand, {
      rawArgs: [
        "update",
        "demo",
        "--decision",
        "Escalated to level 2",
        "--date",
        "2026-09-24",
        "--cwd",
        cwd,
      ],
    });
    const updated: { decisions: Array<{ text: string }> } = JSON.parse(
      readFileSync(join(cwd, dir, "workplan_demo.json"), "utf8"),
    );
    expect(updated.decisions).toHaveLength(1);
    expect(updated.decisions[0]?.text).toBe("Escalated to level 2");
  });
});

// Covers: R10, R11, R12, R16
describe("navori plan update — input, lock and config (M7)", () => {
  const jsonFile = (): string => join(cwd, dir, "workplan_demo.json");
  const bytes = (): string => readFileSync(jsonFile(), "utf8");
  const update = async (...flags: string[]): Promise<void> => {
    process.exitCode = undefined;
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await runCommand(planCommand, { rawArgs: ["update", "demo", ...flags, "--cwd", cwd] });
    } finally {
      spy.mockRestore();
    }
  };

  // Covers: R10
  it("update con estado inválido, id inexistente, fecha no ISO o progress con decision sale 1 sin cambiar bytes", async () => {
    writePlan("demo", validPlan);
    const before = bytes();
    const cases: string[][] = [
      ["--progress", "A1=hecho"],
      ["--progress", "A9=cumplido"],
      ["--progress", "A1=cumplido=x"],
      ["--decision", "x", "--date", "ayer"],
      ["--decision", "x", "--date", "2026-02-30"],
      ["--progress", "A1=cumplido", "--decision", "x", "--date", "2026-10-14"],
    ];
    for (const flags of cases) {
      await update(...flags);
      expect(process.exitCode, flags.join(" ")).toBe(1);
      expect(bytes()).toBe(before);
    }
  });

  // Covers: R11
  it("update con el lock tomado sale 1 sin escribir y dos updates seguidos conservan ambos", async () => {
    writePlan("demo", {
      ...validPlan,
      acceptance: [
        ...validPlan.acceptance,
        { id: "A2", description: "second", command: "bun test", expected: "pass" },
      ],
      progress: { A1: "pendiente", A2: "pendiente" },
    });
    const before = bytes();
    const lock = join(cwd, dir, ".plan-update.lock");
    writeFileSync(lock, "999999\n");
    await update("--progress", "A1=cumplido");
    expect(process.exitCode).toBe(1);
    expect(bytes()).toBe(before);
    rmSync(lock);

    await update("--progress", "A1=cumplido");
    await update("--progress", "A2=bloqueado");
    const written: { progress: Record<string, string> } = JSON.parse(bytes());
    expect(written.progress).toEqual({ A1: "cumplido", A2: "bloqueado" });
    expect(existsSync(lock)).toBe(false);
  }, 20_000);

  // Covers: R11
  it("update sale 1 sin escribir si el criterion cambia entre las dos fases", async () => {
    vi.stubEnv("CLAUDE_CODE_CHILD_SESSION", "1");
    writeFileSync(
      join(cwd, "navori.config.json"),
      JSON.stringify({ name: "ev", engines: ["claude"], preset: "custom" }),
    );
    writePlan("demo", validPlan);
    const command = validPlan.acceptance[0]?.command as string;
    writeFileSync(
      join(cwd, dir, "workplan_demo.evidence.jsonl"),
      `${JSON.stringify({
        ts: "2026-09-30T10:00:00Z",
        feature: "demo",
        id: "A1",
        command,
        tree: cwd,
        cwd,
        head: readHead(cwd),
        worktreeTree: computeWorktreeTree(cwd),
        dirty: true,
      })}\n`,
    );
    evidenceHook.afterValidate = () => {
      const edited = { ...validPlan, acceptance: [{ ...validPlan.acceptance[0], command: "x" }] };
      writeFileSync(jsonFile(), JSON.stringify(edited, null, 2));
    };
    await update("--progress", "A1=cumplido");
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(bytes()).progress.A1).toBe("pendiente");
  });

  // Covers: R12
  it("configuración ilegible rechaza cumplido sin evidencia en Claude, Pi y Codex", async () => {
    const sessions: Array<[string, string]> = [
      ["CLAUDE_CODE_CHILD_SESSION", "1"],
      ["PI_SESSION_ID", "pi-1"],
      ["CODEX_THREAD_ID", "thread-1"],
    ];
    for (const [name, value] of sessions) {
      for (const [other] of sessions) vi.stubEnv(other, undefined);
      vi.stubEnv(name, value);
      writePlan("demo", validPlan);
      const before = bytes();
      writeFileSync(join(cwd, "navori.config.json"), "{ not json");
      await update("--progress", "A1=cumplido");
      expect(process.exitCode, `${name} unreadable`).toBe(1);
      expect(bytes()).toBe(before);

      rmSync(join(cwd, "navori.config.json"));
      await update("--progress", "A1=cumplido");
      expect(process.exitCode ?? 0, `${name} absent`).toBe(0);
      expect(JSON.parse(bytes()).evidence.A1.kind).toBe("unevidenced");
    }
  });

  // Covers: R16
  it("update conserva campos no declarados en la raíz y dentro de un criterion", async () => {
    const { progress: _omit, ...withoutProgress } = validPlan;
    writePlan("demo", {
      ...withoutProgress,
      "x-note": { keep: ["me"] },
      acceptance: [{ ...validPlan.acceptance[0], "x-note": "inner" }],
    });
    await update("--progress", "A1=bloqueado");
    expect(process.exitCode ?? 0).toBe(0);
    const written = JSON.parse(bytes());
    expect(written["x-note"]).toEqual({ keep: ["me"] });
    expect(written.acceptance[0]["x-note"]).toBe("inner");
    expect(written.progress.A1).toBe("bloqueado");
  });
});

// Covers: R7, R8, R9, R10
describe("navori plan update — evidence gate", () => {
  const sentinel = () => join(cwd, "sentinel-ran");
  const command = () => `touch ${sentinel()}`;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.CLAUDE_CODE_CHILD_SESSION;
    writeFileSync(
      join(cwd, "navori.config.json"),
      JSON.stringify({ name: "ev", engines: ["claude"], preset: "custom" }),
    );
    writePlan("demo", {
      ...validPlan,
      acceptance: [{ ...validPlan.acceptance[0], command: command() }],
    });
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.CLAUDE_CODE_CHILD_SESSION;
    else process.env.CLAUDE_CODE_CHILD_SESSION = savedEnv;
  });

  function recordRun(overrides: Record<string, unknown> = {}): void {
    const line = {
      ts: "2026-09-30T10:00:00Z",
      feature: "demo",
      id: "A1",
      command: command(),
      tree: cwd,
      cwd,
      head: readHead(cwd),
      worktreeTree: computeWorktreeTree(cwd),
      dirty: true,
      ...overrides,
    };
    writeFileSync(join(cwd, dir, "workplan_demo.evidence.jsonl"), `${JSON.stringify(line)}\n`);
  }

  async function update(): Promise<{ stdout: string; stderr: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      err.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    const spy = vi_spyConsole(out);
    try {
      await runCommand(planCommand, {
        rawArgs: ["update", "demo", "--progress", "A1=cumplido", "--json", "--cwd", cwd],
      });
    } finally {
      spy.restore();
      process.stderr.write = origErr;
    }
    return { stdout: out.join(""), stderr: err.join("") };
  }

  const planBytes = () => readFileSync(join(cwd, dir, "workplan_demo.json"), "utf8");

  it("rejects with no recorded run: exit 1, JSON byte-identical, ERROR/WHY/FIX with the exact command", async () => {
    process.env.CLAUDE_CODE_CHILD_SESSION = "1";
    const before = planBytes();
    const { stdout, stderr } = await update();
    expect(process.exitCode).toBe(1);
    expect(planBytes()).toBe(before);
    expect(stderr).toContain("ERROR: A1 not marked cumplido");
    expect(stderr).toContain("WHY:   no run recorded");
    expect(stderr).toContain("FIX:");
    expect(stderr).toContain(command());
    expect(stderr).toContain("navori plan render demo");
    expect(JSON.parse(stdout)).toMatchObject({ updated: false, id: "A1" });
    expect(existsSync(sentinel())).toBe(false);
  });

  it("writes cumplido with the recorded evidence when the run is valid", async () => {
    process.env.CLAUDE_CODE_CHILD_SESSION = "1";
    recordRun();
    await update();
    expect(process.exitCode ?? 0).toBe(0);
    const written = JSON.parse(planBytes());
    expect(written.progress.A1).toBe("cumplido");
    expect(written.evidence.A1).toMatchObject({ kind: "recorded", command: command() });
    expect(readFileSync(join(cwd, dir, "workplan_demo.md"), "utf8")).toContain("cumplido ·");
    expect(existsSync(sentinel())).toBe(false);
  });

  it("rejects a moved HEAD, an edited command, a subdirectory run and a foreign worktree", async () => {
    process.env.CLAUDE_CODE_CHILD_SESSION = "1";
    const before = planBytes();
    const other = realpathSync(mkdtempSync(join(tmpdir(), "navori-plan-other-")));
    mkdirSync(join(cwd, "sub"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: other });
      const cases: Array<Record<string, unknown>> = [
        { head: "deadbeef" },
        { command: "something else" },
        { cwd: join(cwd, "sub") },
        { tree: other, cwd: other },
      ];
      for (const overrides of cases) {
        process.exitCode = undefined;
        recordRun(overrides);
        await update();
        expect(process.exitCode).toBe(1);
        expect(planBytes()).toBe(before);
      }
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
    expect(existsSync(sentinel())).toBe(false);
  });

  // Covers: R7
  it("never runs core.fsmonitor or a clean filter, accepted or rejected", async () => {
    process.env.CLAUDE_CODE_CHILD_SESSION = "1";
    writeFileSync(join(cwd, ".gitattributes"), "f.txt filter=x\n");
    writeFileSync(join(cwd, "f.txt"), "content\n");
    execFileSync("git", ["config", "core.fsmonitor", `touch ${join(cwd, "FSM_RAN")}; echo`], {
      cwd,
    });
    execFileSync("git", ["config", "filter.x.clean", `touch ${join(cwd, "FILTER_RAN")}; cat`], {
      cwd,
    });
    recordRun();
    await update();
    expect(process.exitCode ?? 0).toBe(0);
    process.exitCode = undefined;
    writeFileSync(join(cwd, "f.txt"), "edited\n");
    await update();
    expect(process.exitCode).toBe(1);
    expect(existsSync(join(cwd, "FSM_RAN"))).toBe(false);
    expect(existsSync(join(cwd, "FILTER_RAN"))).toBe(false);
  });

  it("accepts cumplido as unevidenced, with a WARNING, outside a Claude Code child session", async () => {
    delete process.env.CLAUDE_CODE_CHILD_SESSION;
    const { stderr } = await update();
    expect(process.exitCode ?? 0).toBe(0);
    expect(stderr).toContain("WARNING: A1 marked cumplido without evidence");
    expect(JSON.parse(planBytes()).evidence.A1).toEqual({
      kind: "unevidenced",
      reason: "engine-without-signal",
    });
  });

  it("does not require evidence when claude is not in config.engines", async () => {
    process.env.CLAUDE_CODE_CHILD_SESSION = "1";
    writeFileSync(
      join(cwd, "navori.config.json"),
      JSON.stringify({ name: "ev", engines: ["codex"], preset: "custom" }),
    );
    await update();
    expect(process.exitCode ?? 0).toBe(0);
    expect(JSON.parse(planBytes()).evidence.A1.kind).toBe("unevidenced");
  });
});

// Covers: R7
describe("navori plan render — acceptance index bootstrap on Pi", () => {
  const sentinel = () => join(cwd, "sentinel-ran");
  const command = () => `touch ${sentinel()}`;
  const indexPath = () => join(cwd, ".navori/state/handoffs/acceptance-index");
  let savedPi: string | undefined;
  let savedClaude: string | undefined;

  beforeEach(() => {
    savedPi = process.env.PI_SESSION_ID;
    savedClaude = process.env.CLAUDE_CODE_CHILD_SESSION;
    // Note: CLAUDE_CODE_CHILD_SESSION=1 in a Pi-only repo fails open (no claude engine), so it is cleared here.
    delete process.env.CLAUDE_CODE_CHILD_SESSION;
    process.env.PI_SESSION_ID = "sess-1";
    writeFileSync(
      join(cwd, "navori.config.json"),
      JSON.stringify({ name: "pi", engines: ["pi"], preset: "custom" }),
    );
    writePlan("demo", {
      ...validPlan,
      acceptance: [{ ...validPlan.acceptance[0], command: command() }],
    });
  });

  afterEach(() => {
    if (savedPi === undefined) delete process.env.PI_SESSION_ID;
    else process.env.PI_SESSION_ID = savedPi;
    if (savedClaude === undefined) delete process.env.CLAUDE_CODE_CHILD_SESSION;
    else process.env.CLAUDE_CODE_CHILD_SESSION = savedClaude;
  });

  it("render writes the index, so a recorded run lets cumplido pass", async () => {
    const stderr: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      // Without the index the rejection names the bootstrap fix.
      await runCommand(planCommand, {
        rawArgs: ["update", "demo", "--progress", "A1=cumplido", "--cwd", cwd],
      });
      expect(process.exitCode).toBe(1);
      expect(stderr.join("")).toContain("navori plan render demo");

      process.exitCode = undefined;
      expect(existsSync(indexPath())).toBe(false);
      await runCommand(planCommand, { rawArgs: ["render", "demo", "--cwd", cwd] });
      expect(readFileSync(indexPath(), "utf8")).toContain(`\tdemo\tA1\t`);

      writeFileSync(
        join(cwd, dir, "workplan_demo.evidence.jsonl"),
        `${JSON.stringify({
          ts: "2026-09-30T10:00:00Z",
          feature: "demo",
          id: "A1",
          command: command(),
          tree: cwd,
          cwd,
          head: readHead(cwd),
          worktreeTree: computeWorktreeTree(cwd),
          dirty: true,
        })}\n`,
      );
      await runCommand(planCommand, {
        rawArgs: ["update", "demo", "--progress", "A1=cumplido", "--cwd", cwd],
      });
    } finally {
      process.stderr.write = origErr;
    }
    expect(process.exitCode ?? 0).toBe(0);
    expect(JSON.parse(readFileSync(join(cwd, dir, "workplan_demo.json"), "utf8")).progress.A1).toBe(
      "cumplido",
    );
  });
});

describe("navori plan check", () => {
  it("exits 0 on a valid workplan (R15)", async () => {
    writePlan("demo", validPlan);
    await runCommand(planCommand, { rawArgs: ["check", "demo", "--cwd", cwd] });
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("exits non-zero and names the failure on an invalid workplan (R15)", async () => {
    writePlan("broken", { ...validPlan, progress: { A1: "pendiente", A9: "cumplido" } });
    const logs: string[] = [];
    const spy = vi_spyConsole(logs);
    await runCommand(planCommand, { rawArgs: ["check", "broken", "--json", "--cwd", cwd] });
    spy.restore();
    expect(process.exitCode).toBe(2);
    const parsed = JSON.parse(logs.join(""));
    expect(parsed.findings.some((f: { rule: string }) => f.rule === "progress-unknown-id")).toBe(
      true,
    );
  });

  // Covers: R15
  it("check con JSON ilegible sale 2 con hallazgo schema y sin traza", async () => {
    mkdirSync(join(cwd, dir), { recursive: true });
    writeFileSync(join(cwd, dir, "workplan_garbled.json"), "{ not json");
    const logs: string[] = [];
    const spy = vi_spyConsole(logs);
    let thrown: unknown;
    try {
      await runCommand(planCommand, { rawArgs: ["check", "garbled", "--json", "--cwd", cwd] });
    } catch (error) {
      thrown = error;
    }
    spy.restore();
    expect(thrown).toBeUndefined();
    expect(process.exitCode).toBe(2);
    const parsed = JSON.parse(logs.join(""));
    expect(parsed.ok).toBe(false);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0].rule).toBe("schema");
    expect(logs.join("")).not.toContain("    at ");
  });

  it("fails when the workplan file is missing", async () => {
    await runCommand(planCommand, { rawArgs: ["check", "absent", "--cwd", cwd] });
    expect(process.exitCode).toBe(1);
  });
});

/** Covers: R9 */
describe("navori plan escalation-reset", () => {
  const level2 = {
    ...validPlan,
    level: 2,
    classification: { score: 8, level: 2, signals: [] },
    solution: { path: ".claude/progress/solution_demo.md", verdict: "READY" },
    phases: [{ name: "phase 1", acceptance: ["A1"] }],
    risks: [{ risk: "regression", rollback: "revert the commit" }],
  };
  const logFile = (): string => join(cwd, dir, "workplan_demo.gate.jsonl");
  const rejections = (n: number): void => {
    mkdirSync(join(cwd, dir), { recursive: true });
    const lines = Array.from({ length: n }, (_, i) =>
      JSON.stringify({
        ts: new Date().toISOString(),
        reviewHash: `h${i}`,
        verdict: "CHANGES_REQUESTED",
      }),
    );
    writeFileSync(logFile(), lines.map((l) => `${l}\n`).join(""));
  };
  const reset = async (...flags: string[]): Promise<void> => {
    process.exitCode = undefined;
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await runCommand(planCommand, {
        rawArgs: ["escalation-reset", "demo", "--cwd", cwd, ...flags],
      });
    } finally {
      spy.mockRestore();
    }
  };
  const lineCount = (): number => readFileSync(logFile(), "utf8").trim().split("\n").length;

  // Covers: R9
  it("escalation-reset rechaza sin usuario, razón vacía, nivel 1 o un rechazo y escribe una sola línea reset", async () => {
    writePlan("demo", level2);
    rejections(2);
    const before = readFileSync(logFile(), "utf8");

    for (const flags of [
      ["--reason", "again"],
      ["--approved-by", "agent", "--reason", "again"],
      ["--approved-by", "user"],
      ["--approved-by", "user", "--reason", "   "],
    ]) {
      await reset(...flags);
      expect(process.exitCode).toBe(1);
      expect(readFileSync(logFile(), "utf8")).toBe(before);
    }

    // Level 1: the way out is the design, not the reset.
    writePlan("demo", validPlan);
    await reset("--approved-by", "user", "--reason", "again");
    expect(process.exitCode).toBe(1);
    expect(readFileSync(logFile(), "utf8")).toBe(before);

    // One rejection only.
    writePlan("demo", level2);
    rejections(1);
    const one = readFileSync(logFile(), "utf8");
    await reset("--approved-by", "user", "--reason", "again");
    expect(process.exitCode).toBe(1);
    expect(readFileSync(logFile(), "utf8")).toBe(one);

    rejections(2);
    await reset("--approved-by", "user", "--reason", "client asked for another round");
    expect(process.exitCode).toBeUndefined();
    expect(lineCount()).toBe(3);
    const last = JSON.parse(readFileSync(logFile(), "utf8").trim().split("\n")[2] ?? "");
    expect(last).toMatchObject({
      kind: "reset",
      approvedBy: "user",
      reason: "client asked for another round",
      rejectionsBefore: 2,
    });
    expect(typeof last.ts).toBe("string");

    // After the reset the count is back to zero: a second reset is refused.
    await reset("--approved-by", "user", "--reason", "again");
    expect(process.exitCode).toBe(1);
    expect(lineCount()).toBe(3);
  });

  it("escalation-reset sin workplan sale 1 sin escribir", async () => {
    await reset("--approved-by", "user", "--reason", "again");
    expect(process.exitCode).toBe(1);
    expect(existsSync(logFile())).toBe(false);
  });
});

/** Captures `process.stdout.write` calls into `sink`, restoring the original
 * on `.restore()`. `plan`'s commands write JSON/text directly to stdout
 * (receipt.ts's pattern), so a `console.log` spy would miss them. */
function vi_spyConsole(sink: string[]): { restore: () => void } {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    sink.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  return {
    restore: () => {
      process.stdout.write = original;
    },
  };
}
