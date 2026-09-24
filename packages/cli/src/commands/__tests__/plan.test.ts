import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";
import { planCommand } from "../plan.ts";

let cwd: string;
const dir = ".claude/progress";

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-plan-"));
  process.exitCode = undefined;
});

afterEach(() => {
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
    expect(parsed.files).toEqual(["src/a.ts"]);
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
    expect(md).toContain("**A1** (cumplido)");
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

  it("fails when the workplan file is missing", async () => {
    await runCommand(planCommand, { rawArgs: ["check", "absent", "--cwd", cwd] });
    expect(process.exitCode).toBe(1);
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
