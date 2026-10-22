import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

/** Runs the source CLI in a separate process so exit-code assertions reach the real entry point. */
function runCheckProcess(json: boolean): Run {
  const result = spawnSync(
    "bun",
    [
      fileURLToPath(new URL("../../index.ts", import.meta.url)),
      "spec",
      "check",
      "demo",
      "--cwd",
      cwd,
      ...(json ? ["--json"] : []),
    ],
    { encoding: "utf8", timeout: 30_000, env: { ...process.env, NO_COLOR: "1" } },
  );
  if (result.error) throw result.error;
  if (result.status === null) throw new Error(`CLI terminated with signal ${result.signal}`);
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status };
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
      "validation",
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
      validation: { scope: "structural", functionalDelivery: "unverified" },
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
    expect(result.stdout).toContain("structural only, functional delivery unverified");
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

function writeRequirements(feature: string, ids: string[]): void {
  writeFileSync(
    join(cwd, "specs", feature, "requirements.md"),
    ids.map((id) => `- **${id}** — x`).join("\n"),
  );
}

describe("navori spec check — strict requirements subprocess", () => {
  // Covers: R7, R8
  it.each([
    { scenario: "missing", rule: "requirements-unreadable", where: "requirements.md" },
    { scenario: "unreadable directory", rule: "requirements-unreadable", where: "requirements.md" },
    { scenario: "empty readable", rule: "unknown-requirement", where: "T1" },
    { scenario: "unknown R1", rule: "unknown-requirement", where: "T1" },
  ])(
    "fails for $scenario requirements in JSON and human output",
    ({ scenario, rule, where }: { scenario: string; rule: string; where: string }) => {
      writeTasks("demo", deliveries(1, 1));
      if (scenario === "unreadable directory")
        mkdirSync(join(cwd, "specs", "demo", "requirements.md"));
      else if (scenario === "empty readable") writeRequirements("demo", []);
      else if (scenario === "unknown R1") {
        writeRequirements("demo", ["R2"]);
        writeTasks("demo", `${deliveries(1, 1)}\n- [ ] **T2** (R2) — t · effect: behavior`);
      }

      const json = runCheckProcess(true);
      expect(json.exitCode).toBe(2);
      expect(JSON.parse(json.stdout)).toMatchObject({
        format: "deliveries",
        ok: false,
        findings: expect.arrayContaining([
          {
            rule,
            severity: "error",
            where,
            message: expect.any(String),
            ...(rule === "unknown-requirement" ? { line: 5 } : {}),
          },
        ]),
      });
      expect(json.stderr).toContain(`[${rule}]`);
      const human = runCheckProcess(false);
      expect(human.exitCode).toBe(2);
      expect(human.stdout).toBe(
        "demo: findings — 1 error(s), 0 warning(s); structural only, functional delivery unverified\n",
      );
      for (const result of [json, human]) {
        expect(result.stderr).toContain("ERROR:");
        expect(result.stderr).toContain("WHY:");
        expect(result.stderr).toContain("FIX:");
        expect(result.stderr).toContain(
          rule === "unknown-requirement"
            ? "T1 cites R1, which requirements.md does not declare"
            : "requirements.md could not be read; requirement coverage was not checked",
        );
        expect(result.stderr).not.toContain("WARN:");
      }
    },
  );

  // Covers: R9
  it.each(["missing", "unknown"])(
    "keeps legacy success with %s requirements",
    (scenario: string) => {
      writeTasks("demo", "- [ ] **T1** (R1) — t\n");
      if (scenario === "unknown") writeRequirements("demo", []);
      const json = runCheckProcess(true);
      expect(json.exitCode).toBe(0);
      const payload = JSON.parse(json.stdout) as {
        format: string;
        ok: boolean;
        findings: { rule: string; severity: string }[];
      };
      expect(payload).toMatchObject({ format: "legacy", ok: true });
      expect(payload.findings.length).toBeGreaterThan(0);
      expect(
        payload.findings.every((f) => f.rule === "legacy-format" && f.severity === "warning"),
      ).toBe(true);
      const human = runCheckProcess(false);
      expect(human.exitCode).toBe(0);
      expect(human.stdout).toContain("demo: ok — 0 error(s)");
      for (const result of [json, human]) {
        expect(result.stderr).toContain("WARN:  [legacy-format]");
        expect(result.stderr).not.toContain("ERROR:");
      }
    },
  );
});

// Covers: R4, R11
describe("navori spec check", () => {
  it("exits 0 with the stable JSON contract when the spec is sound", async () => {
    writeTasks("demo", deliveries(2, 3));
    writeRequirements("demo", ["R1"]);
    const result = await run("check", "demo", "--json");
    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual([
      "formatVersion",
      "feature",
      "format",
      "ok",
      "validation",
      "findings",
      "classification",
    ]);
    expect(json).toMatchObject({
      formatVersion: 1,
      feature: "demo",
      ok: true,
      validation: { scope: "structural", functionalDelivery: "unverified" },
      findings: [],
    });
  });

  // #1312: a declared consumer and passing helper tests cannot attest a runtime flow.
  it("keeps a foundation with contracts and tests functionally unverified", async () => {
    writeTasks(
      "demo",
      [
        "## E1 — Contract (foundation)",
        "Estimated LOC: 1800",
        "### M1 — Contract and tests",
        "- **Consumes:** helper → shared contract",
        "- **A1** [observable] — helpers `node --test contract.test.mjs` → tests pass",
        "- [x] **T1** (R1) — contract · effect: behavior",
        "## E2 — Integrate later",
        "### M2 — Runtime",
        "- **A2** [observable] — command `node entry.mjs` → result",
        "- [ ] **T2** (R1) — integration · effect: behavior",
      ].join("\n"),
    );
    writeRequirements("demo", ["R1"]);
    writeFileSync(join(cwd, "contract.mjs"), "export const contract = () => 'ready';\n");
    writeFileSync(
      join(cwd, "contract.test.mjs"),
      "import assert from 'node:assert/strict'; import {contract} from './contract.mjs'; assert.equal(contract(), 'ready');\n",
    );
    const helperTests = spawnSync("node", ["--test", "contract.test.mjs"], {
      cwd,
      encoding: "utf8",
    });
    expect(helperTests.status).toBe(0);
    const missingAcceptance = spawnSync("node", ["entry.mjs"], { cwd, encoding: "utf8" });
    expect(missingAcceptance.status).not.toBe(0);
    expect(missingAcceptance.stderr).toContain("MODULE_NOT_FOUND");
    for (const command of ["classify", "check"]) {
      const result = await run(command, "demo", "--json");
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        validation: { scope: "structural", functionalDelivery: "unverified" },
      });
    }

    // A real entry point supplies observable evidence separately; it cannot upgrade a structural check.
    writeFileSync(
      join(cwd, "entry.mjs"),
      "import {contract} from './contract.mjs'; process.stdout.write(contract() + '\\n');\n",
    );
    const acceptance = spawnSync("node", ["entry.mjs"], { cwd, encoding: "utf8" });
    expect(acceptance.status).toBe(0);
    expect(acceptance.stdout).toBe("ready\n");
    expect(JSON.parse((await run("check", "demo", "--json")).stdout)).toMatchObject({
      ok: true,
      validation: { scope: "structural", functionalDelivery: "unverified" },
    });
  });

  it("exits 2 with ERROR/WHY/FIX when a finding is an error", async () => {
    writeTasks("demo", deliveries(2, 3));
    writeRequirements("demo", ["R1", "R2"]);
    const result = await run("check", "demo", "--json");
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      findings: [{ rule: "requirement-uncovered", severity: "error", where: "R2" }],
    });
    expect(result.stderr).toContain("ERROR:");
    expect(result.stderr).toContain("WHY:");
    expect(result.stderr).toContain("FIX:");
  });

  it("exits 0 with warnings only for the previous format", async () => {
    writeTasks("demo", "- [ ] one\n");
    const result = await run("check", "demo");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("WARN:");
  });

  it("exits 1 when the tasks file is missing", async () => {
    const result = await run("check", "nope");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("ERROR: cannot read");
  });
});
