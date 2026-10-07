import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";
import { specCommand } from "../spec.ts";

let cwd: string;

beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "navori-spec-")));
  process.exitCode = undefined;
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  process.exitCode = undefined;
});

function writeTasks(feature: string, text: string, specsDir = "specs"): void {
  mkdirSync(join(cwd, specsDir, feature), { recursive: true });
  writeFileSync(join(cwd, specsDir, feature, "tasks.md"), text);
}

function deliveries(count: number, tasksEach: number): string {
  const out: string[] = [];
  let task = 0;
  for (let d = 1; d <= count; d += 1) {
    out.push(`## E${d} — d${d}`, `Estimated LOC: 100`, `### M${d} — m${d}`);
    out.push(`- **A${d}** — c \`ls\` → ok`);
    for (let i = 0; i < tasksEach; i += 1) {
      task += 1;
      out.push(`- [ ] **T${task}** (R1) — t · effect: behavior`);
    }
  }
  return out.join("\n");
}

interface Run {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function run(...argv: string[]): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await runCommand(specCommand, { rawArgs: [...argv, "--cwd", cwd] });
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
  return { stdout, stderr, exitCode: Number(process.exitCode ?? 0) };
}

// Covers: R4, R8
describe("navori spec classify", () => {
  it("emits the stable JSON contract with effective thresholds", async () => {
    writeTasks("demo", deliveries(2, 7));
    const result = await run("classify", "demo", "--json");
    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual([
      "formatVersion",
      "feature",
      "tasksPath",
      "format",
      "shape",
      "prCount",
      "signals",
      "thresholds",
      "deliveries",
      "warnings",
      "error",
    ]);
    expect(json).toMatchObject({
      formatVersion: 1,
      feature: "demo",
      tasksPath: "specs/demo/tasks.md",
      format: "deliveries",
      shape: "split",
      prCount: 2,
      thresholds: {
        splitMinTasks: 12,
        splitMinLoc: 1500,
        maxPrsPerSpec: 4,
        comparison: "strict-greater",
      },
      error: null,
    });
    expect(Object.keys((json.signals as object) ?? {})).toEqual([
      "tasks",
      "deliveries",
      "milestones",
      "estimatedLoc",
      "locDeclared",
      "exceedsTasks",
      "exceedsLoc",
    ]);
  });

  it("prints a one-line summary without --json and warns on stderr", async () => {
    writeTasks("demo", deliveries(2, 2));
    const result = await run("classify", "demo");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("demo: single (1 PR)");
    expect(result.stderr).toContain("WARN:");
  });

  it("uses sdd.deliveries and sdd.specsDir from the config", async () => {
    writeFileSync(
      join(cwd, "navori.config.json"),
      JSON.stringify({
        name: "demo",
        engines: ["claude"],
        preset: "custom",
        sdd: { specsDir: "docs/specs", deliveries: { splitMinTasks: 3, maxPrsPerSpec: 2 } },
      }),
    );
    writeTasks("demo", deliveries(2, 2), "docs/specs");
    const json = JSON.parse((await run("classify", "demo", "--json")).stdout) as {
      shape: string;
      thresholds: { splitMinTasks: number; maxPrsPerSpec: number };
    };
    expect(json.shape).toBe("split");
    expect(json.thresholds).toMatchObject({ splitMinTasks: 3, maxPrsPerSpec: 2 });
  });
});

// Covers: R7, R9
describe("navori spec classify — failures", () => {
  it("R7: too many deliveries exits 1 with ERROR / WHY / FIX", async () => {
    writeTasks("demo", deliveries(5, 3));
    const result = await run("classify", "demo", "--json");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^ERROR: .*\nWHY: {3}.*\nFIX: {3}/);
    const json = JSON.parse(result.stdout) as { error: { what: string; why: string; fix: string } };
    expect(json.error.what).toContain("5 deliveries");
    expect(json.error.fix).toContain("split the spec");
  });

  it("R9: a missing tasks.md exits 1 and names the expected path", async () => {
    mkdirSync(join(cwd, "specs", "demo"), { recursive: true });
    const result = await run("classify", "demo");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("ERROR: cannot read specs/demo/tasks.md");
    expect(result.stderr).toContain("WHY:");
    expect(result.stderr).toContain("FIX:");
  });

  it.each(["../escape", "/etc", "a/b", ".."])("rejects the spec name %j", async (name) => {
    const result = await run("classify", name);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("ERROR: cannot resolve spec");
  });

  it("R3: an invalid sdd.deliveries exits 1 naming the field", async () => {
    writeFileSync(
      join(cwd, "navori.config.json"),
      JSON.stringify({
        name: "demo",
        engines: ["claude"],
        preset: "custom",
        sdd: { deliveries: { maxPrsPerSpec: 1 } },
      }),
    );
    writeTasks("demo", deliveries(2, 2));
    const result = await run("classify", "demo");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("sdd.deliveries.maxPrsPerSpec");
  });

  it("R14: a previous-format tasks.md classifies as single and exits 0", async () => {
    writeTasks("demo", "- [ ] one\n- [x] two\n");
    const result = await run("classify", "demo", "--json");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ format: "legacy", shape: "single" });
  });
});
