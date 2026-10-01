// Covers: R47, R49, R50, R57, R58, R63, A1, A2 (master_plan_ux)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSeedConfigHelper, seedUxSources, validUxJson, validUxMd } from "./test-utils.ts";
import { runMasterClose } from "../close.ts";
import { checkClosedStage } from "../checks.ts";
import { readConfig } from "../../config/config.ts";
import { runRender } from "../../../commands/render.ts";
import { changeMasterPart } from "../part.ts";
import { runMasterAdvance, runMasterCheck } from "../checks.ts";
import { readMasterStatus, renderStatusMd, writeMasterStatus } from "../status.ts";
import { masterCommand } from "../../../commands/master.ts";
import { runCommand } from "citty";

vi.mock("../../../commands/render.ts", () => ({ runRender: vi.fn(() => ({ ok: true })) }));

let cwd: string;
const root = (): string => join(cwd, "specs", "_master");
const stage = (): string => join(root(), "01-mvp");
const read = (name: string): string => readFileSync(join(stage(), name), "utf8");
const part = (state: "hecho" | "parcial" | "diferida") => ({
  id: "P1",
  title: "Build",
  objective: "Build",
  scope: [],
  outOfScope: [],
  dependsOn: [],
  seedRequirements: [],
  inheritedFrom: null,
  state,
  reason: state === "diferida" ? "next stage" : null,
  spec: null,
  issue: 42,
  acceptance: [
    {
      id: "A1",
      description: "Review",
      method: "manual",
      manual: { check: "review", how: "inspect" },
      evidence:
        state === "hecho" ? { kind: "approval", approvedBy: "user", date: "2026-01-02" } : null,
    },
  ],
});

function seed(phase: string, state: "hecho" | "parcial" | "diferida" = "hecho", ux?: string): void {
  createSeedConfigHelper(cwd)({ harness: { masterPlan: true }, language: "es" });
  mkdirSync(join(stage(), "context", "raw"), { recursive: true });
  writeFileSync(join(stage(), "context", "raw", ".gitignore"), "*\n");
  writeFileSync(
    join(root(), "index.json"),
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
    join(stage(), "state.json"),
    JSON.stringify({
      version: 1,
      phase,
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
      history: [{ phase, at: "2026-01-01" }],
      ...(ux ? { ux } : {}),
    }),
  );
  writeFileSync(join(stage(), "parts.json"), JSON.stringify({ version: 1, parts: [part(state)] }));
  writeFileSync(join(stage(), "MASTER.md"), "# Master\n\n## Entrega en partes\n\nPending\n");
  writeFileSync(join(stage(), "DECISIONS.md"), "## D1\n\nChoice\n");
}

function freshFixture(): void {
  cwd = mkdtempSync(join(tmpdir(), "navori-master-close-"));
  execFileSync("git", ["init", "-q"], { cwd });
}

function listStageFiles(dir: string = stage(), prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const name = `${prefix}${entry.name}`;
      return entry.isDirectory() ? listStageFiles(join(dir, entry.name), `${name}/`) : [name];
    })
    .sort();
}

async function invoke(args: string[]): Promise<{ exitCode: number | undefined; error: string }> {
  const previous = process.exitCode;
  const originalWrite = process.stderr.write.bind(process.stderr);
  let error = "";
  process.exitCode = undefined;
  process.stderr.write = ((chunk: string) => {
    error += chunk;
    return true;
  }) as typeof process.stderr.write;
  try {
    await runCommand(masterCommand, { rawArgs: [...args, "--cwd", cwd] });
    return { exitCode: process.exitCode, error };
  } catch (cause) {
    return { exitCode: 1, error: `${error}${String(cause)}` };
  } finally {
    process.stderr.write = originalWrite;
    process.exitCode = previous;
  }
}

beforeEach(() => {
  freshFixture();
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("master close", () => {
  // Covers: R47
  it("lists a partial part and writes nothing when delivery is blocked", () => {
    seed("executing", "parcial");
    const before = read("state.json");
    expect(() => runMasterClose(cwd)).toThrow(/P1/);
    expect(read("state.json")).toBe(before);
    expect(readdirSync(stage())).not.toContain("CLOSURE.md");
  });

  // Covers: R49, R50, R63
  it("closes deterministically, preserves integrity across CRLF and detects edits", () => {
    seed("executing", "diferida");
    runMasterClose(cwd);
    const closure = read("CLOSURE.md");
    expect(closure).toContain("P1.A1 | manual | no verificado");
    expect(closure).toContain("## Integridad");
    expect(closure).toContain("Decisiones: 1");
    expect(JSON.parse(read("state.json")).phase).toBe("closed");
    expect(JSON.parse(readFileSync(join(root(), "index.json"), "utf8")).stages[0].state).toBe(
      "cerrada",
    );
    expect(readConfig(join(cwd, "navori.config.json")).harness?.masterPlan).toBe(false);
    expect(checkClosedStage(cwd, "specs", "01-mvp", "es")).toEqual([]);
    writeFileSync(join(stage(), "MASTER.md"), read("MASTER.md").replace(/\n/g, "\r\n"));
    expect(checkClosedStage(cwd, "specs", "01-mvp", "es")).toEqual([]);
    writeFileSync(join(stage(), "MASTER.md"), `${read("MASTER.md")}edited`);
    expect(checkClosedStage(cwd, "specs", "01-mvp", "es").join("\n")).toContain(
      "MASTER.md no coincide",
    );
    const frozen = read("CLOSURE.md");
    expect(runMasterClose(cwd).stage).toBeNull();
    expect(read("CLOSURE.md")).toBe(frozen);
  });

  // Covers: R49
  it("renders byte-identical closures from two independent copies of the same input", () => {
    seed("executing", "hecho");
    runMasterClose(cwd);
    const first = read("CLOSURE.md");
    const firstCwd = cwd;
    freshFixture();
    try {
      seed("executing", "hecho");
      runMasterClose(cwd);
      expect(read("CLOSURE.md")).toBe(first);
    } finally {
      rmSync(firstCwd, { recursive: true, force: true });
    }
  });

  // Covers: R49
  it.each([1, 2, 3, 4, 5, 6])("resumes after step %i", (cut) => {
    seed("executing");
    expect(() =>
      runMasterClose(cwd, {
        afterStep: (step) => {
          if (step === cut) throw new Error("cut");
        },
      }),
    ).toThrow("cut");
    const closureBefore = cut >= 3 ? read("CLOSURE.md") : null;
    runMasterClose(cwd);
    if (closureBefore) expect(read("CLOSURE.md")).toBe(closureBefore);
    expect(checkClosedStage(cwd, "specs", "01-mvp", "es")).toEqual([]);
    expect(readConfig(join(cwd, "navori.config.json")).harness?.masterPlan).toBe(false);
  });

  // Covers: R49
  it("repairs only step six when the index has no active stage", () => {
    seed("executing");
    expect(() =>
      runMasterClose(cwd, {
        afterStep: (step) => {
          if (step === 5) throw new Error("cut");
        },
      }),
    ).toThrow("cut");
    const closure = read("CLOSURE.md");
    const index = readFileSync(join(root(), "index.json"), "utf8");
    expect(runMasterClose(cwd)).toEqual({ stage: null, outcome: null, reconciled: true });
    expect(read("CLOSURE.md")).toBe(closure);
    expect(readFileSync(join(root(), "index.json"), "utf8")).toBe(index);
    expect(readConfig(join(cwd, "navori.config.json")).harness?.masterPlan).toBe(false);
  });

  // Covers: R49
  it("keeps the recovery signal if render fails after registry closure", () => {
    seed("executing");
    vi.mocked(runRender).mockImplementationOnce(
      () => ({ ok: false, reason: "render failed" }) as ReturnType<typeof runRender>,
    );
    expect(() => runMasterClose(cwd)).toThrow("render failed");
    expect(readConfig(join(cwd, "navori.config.json")).harness?.masterPlan).toBe(true);
    expect(runMasterClose(cwd).reconciled).toBe(true);
    expect(readConfig(join(cwd, "navori.config.json")).harness?.masterPlan).toBe(false);
  });

  // Covers: R50, R63
  it("renders run evidence, commit age and orphan marks; detects post-close evidence edits", () => {
    seed("executing");
    execFileSync("git", ["add", "-A"], { cwd });
    execFileSync(
      "git",
      ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-qm", "seed"],
      { cwd },
    );
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    const parts = JSON.parse(read("parts.json")) as { parts: Array<{ acceptance: unknown[] }> };
    parts.parts[0]!.acceptance = [
      {
        id: "A1",
        description: "Run",
        method: "test",
        test: { file: "test.ts", case: "works" },
        evidence: {
          kind: "run",
          command: "bun test",
          result: "passed",
          commit,
          date: "2026-01-02",
        },
      },
      {
        id: "A2",
        description: "Old run",
        method: "comando",
        command: { run: "bun build", expected: "ok" },
        evidence: {
          kind: "run",
          command: "bun build",
          result: "ok",
          commit: "0000000000000000000000000000000000000000",
          date: "2026-01-03",
        },
      },
    ];
    writeFileSync(join(stage(), "parts.json"), JSON.stringify(parts));
    runMasterClose(cwd);
    const closure = read("CLOSURE.md");
    expect(closure).toContain(`bun test; passed; ${commit.slice(0, 8)} · commitsBehind=0`);
    expect(closure).toContain("bun build; ok; 00000000 · orphan");
    expect(closure).toContain("| P1.A1 | test |");
    expect(closure).toContain("| P1.A2 | comando |");
    expect(checkClosedStage(cwd, "specs", "01-mvp", "es")).toEqual([]);
    writeFileSync(join(stage(), "parts.json"), read("parts.json").replace("passed", "failed"));
    expect(checkClosedStage(cwd, "specs", "01-mvp", "es").join("\n")).toContain(
      "parts.json no coincide",
    );
  });

  // Covers: R50
  it("rejects every mutator on a closed stage, including explicit --stage", async () => {
    seed("executing");
    runMasterClose(cwd);
    const state = read("state.json");
    const parts = read("parts.json");
    const closure = read("CLOSURE.md");
    expect(() => changeMasterPart(cwd, "P1", { state: "hecho" })).toThrow(
      /disabled|no active|closed/,
    );
    expect(() => runMasterAdvance(cwd)).toThrow(/no hay etapa activa/);
    expect((await invoke(["mode", "en-curso"])).error).toContain("no active stage");
    for (const command of [
      ["part", "P1", "--state", "hecho", "--stage", "01-mvp"],
      ["advance", "--stage", "01-mvp"],
      ["mode", "en-curso", "--stage", "01-mvp"],
      ["close", "--stage", "01-mvp"],
    ]) {
      const result = await invoke(command);
      expect(result.exitCode).toBe(1);
    }
    expect((await invoke(["check", "--stage", "01-mvp"])).exitCode).not.toBe(1);
    expect(read("state.json")).toBe(state);
    expect(read("parts.json")).toBe(parts);
    expect(read("CLOSURE.md")).toBe(closure);
  });

  // Covers: R57
  it("converts only before mastered and into a free spec path", () => {
    seed("mapped");
    mkdirSync(join(cwd, "specs", "occupied"));
    writeFileSync(join(cwd, "specs", "occupied", "x"), "x");
    expect(() => runMasterClose(cwd, { convert: "specs/occupied", reason: "focused" })).toThrow(
      /ruta libre/,
    );
    runMasterClose(cwd, { convert: "specs/new-spec", reason: "focused" });
    expect(read("CLOSURE.md")).toContain("specs/new-spec");
    expect(JSON.parse(readFileSync(join(root(), "index.json"), "utf8")).stages[0].state).toBe(
      "convertida",
    );
    expect(checkClosedStage(cwd, "specs", "01-mvp", "es").join("\n")).toContain(
      "spec aún no creada",
    );
    mkdirSync(join(cwd, "specs", "new-spec"));
    expect(checkClosedStage(cwd, "specs", "01-mvp", "es")).toEqual([]);
  });

  // Covers: R49, R57
  it("resumes a converted stage without repeating its options", () => {
    seed("mapped");
    expect(() =>
      runMasterClose(cwd, {
        convert: "specs/new-spec",
        reason: "focused",
        afterStep: (step) => {
          if (step === 3) throw new Error("cut");
        },
      }),
    ).toThrow("cut");
    const closure = read("CLOSURE.md");
    runMasterClose(cwd);
    expect(read("CLOSURE.md")).toBe(closure);
    expect(JSON.parse(readFileSync(join(root(), "index.json"), "utf8")).stages[0].state).toBe(
      "convertida",
    );
    expect(checkClosedStage(cwd, "specs", "01-mvp", "es").join("\n")).toContain(
      "spec aún no creada",
    );
  });

  // Covers: R58
  it("rejects invalid abandonments and keeps all stage files", () => {
    seed("planned");
    expect(() => runMasterClose(cwd, { abandon: true })).toThrow(/reason/);
    expect(() => runMasterClose(cwd, { abandon: true, convert: "specs/new", reason: "x" })).toThrow(
      /excluyentes/,
    );
    writeMasterStatus(cwd);
    const before = listStageFiles();
    runMasterClose(cwd, { abandon: true, reason: "stop" });
    const closure = read("CLOSURE.md");
    expect(closure).toContain("Fase: planned");
    expect(listStageFiles()).toEqual([...before, "CLOSURE.md"].sort());
    expect(JSON.parse(readFileSync(join(root(), "index.json"), "utf8")).stages[0].state).toBe(
      "abandonada",
    );
    const firstCwd = cwd;
    freshFixture();
    try {
      seed("planned");
      writeMasterStatus(cwd);
      const secondBefore = listStageFiles();
      runMasterClose(cwd, { abandon: true, reason: "stop" });
      expect(listStageFiles()).toEqual([...secondBefore, "CLOSURE.md"].sort());
      expect(read("CLOSURE.md")).toBe(closure);
    } finally {
      rmSync(firstCwd, { recursive: true, force: true });
    }
  });

  // Covers: R57, R58
  it("rejects both early exits in mastered without writes", () => {
    seed("mastered");
    const before = read("state.json");
    expect(() => runMasterClose(cwd, { convert: "specs/new", reason: "focus" })).toThrow(
      /navori master close/,
    );
    expect(() => runMasterClose(cwd, { abandon: true, reason: "stop" })).toThrow(
      /navori master close/,
    );
    expect(read("state.json")).toBe(before);
  });
});

describe("navori master ux", () => {
  it("records the choice in phase ux and regenerates STATUS.md in the same operation", async () => {
    seed("ux");
    const result = await invoke(["ux", "none"]);
    expect(result.exitCode).toBeUndefined();
    expect(JSON.parse(read("state.json")).ux).toBe("none");
    expect(read("STATUS.md")).toBe(renderStatusMd(readMasterStatus(cwd)));
    expect(read("STATUS.md")).toContain("UX: none");
    expect(runMasterCheck(cwd).failures).not.toContain("01-mvp/STATUS.md differs from its render");
  });

  it("re-choosing in phase ux overwrites the decision", async () => {
    seed("ux", "hecho", "none");
    await invoke(["ux", "md"]);
    expect(JSON.parse(read("state.json")).ux).toBe("md");
  });

  it("rejects outside phase ux (including executing) without writing", async () => {
    for (const phase of ["mastered", "executing"]) {
      seed(phase);
      const before = read("state.json");
      const result = await invoke(["ux", "md"]);
      expect(result.exitCode).toBe(1);
      expect(result.error).toContain("phase 'ux'");
      expect(read("state.json")).toBe(before);
      expect(existsSync(join(stage(), "STATUS.md"))).toBe(false);
    }
  });

  it("rejects invalid values and --stage", async () => {
    seed("ux");
    expect((await invoke(["ux", "json"])).exitCode).toBe(1);
    const staged = await invoke(["ux", "md", "--stage", "01-mvp"]);
    expect(staged.exitCode).toBe(1);
    expect(staged.error).toContain("solo lectura");
    expect(JSON.parse(read("state.json")).ux).toBeUndefined();
  });
});

describe("status and close — the UX gate cannot be skipped (B1)", () => {
  it("blocks delivery from mastered and ux without a decision, and closable reflects it", () => {
    for (const phase of ["mastered", "ux"]) {
      seed(phase);
      const status = readMasterStatus(cwd);
      expect(status.closable).toBe(false);
      expect(status.blockers.join("\n")).toContain("navori master ux");
      const before = read("state.json");
      expect(() => runMasterClose(cwd)).toThrow(/navori master ux/);
      expect(read("state.json")).toBe(before);
    }
  });

  // Covers: R53
  it("rejects delivery from an early phase or with no parts, matching closable", () => {
    seed("context");
    expect(readMasterStatus(cwd).closable).toBe(false);
    expect(() => runMasterClose(cwd)).toThrow("no se puede entregar en fase context");
    seed("executing");
    writeFileSync(join(stage(), "parts.json"), JSON.stringify({ version: 1, parts: [] }));
    expect(readMasterStatus(cwd).closable).toBe(false);
    expect(() => runMasterClose(cwd)).toThrow("sin partes");
  });

  it("blocks delivery from ux when artifacts contradict the decision", () => {
    seed("ux", "hecho", "md");
    expect(() => runMasterClose(cwd)).toThrow(/falta UX\.md/);
    writeFileSync(join(stage(), "UX.md"), "# UX\n");
    writeFileSync(join(stage(), "ux.json"), "{}");
    expect(() => runMasterClose(cwd)).toThrow(/existe ux\.json/);
  });

  it("delivers from mastered once a decision is recorded", () => {
    seed("mastered", "hecho", "none");
    expect(runMasterClose(cwd).outcome).toBe("entregada");
  });

  it("delivers from ux with a consistent decision and hashes UX.md/ux.json only when present", () => {
    seed("ux", "hecho", "md-json");
    writeFileSync(join(stage(), "UX.md"), validUxMd("es"));
    writeFileSync(join(stage(), "ux.json"), JSON.stringify(validUxJson("01-mvp")));
    seedUxSources(stage());
    expect(runMasterClose(cwd).outcome).toBe("entregada");
    const closure = read("CLOSURE.md");
    expect(closure).toContain("| UX.md |");
    expect(closure).toContain("| ux.json |");
  });

  it("omits UX rows from the integrity table when the choice is none", () => {
    seed("ux", "hecho", "none");
    runMasterClose(cwd);
    expect(read("CLOSURE.md")).not.toContain("UX.md");
  });

  it("a legacy executing stage with no decision closes unchanged", () => {
    seed("executing");
    expect(readMasterStatus(cwd).closable).toBe(true);
    expect(runMasterClose(cwd).outcome).toBe("entregada");
  });

  it("a legacy executing stage with inconsistent UX files is blocked by presence only", () => {
    seed("executing");
    writeFileSync(join(stage(), "ux.json"), "{}");
    expect(() => runMasterClose(cwd)).toThrow(/ux\.json existe sin UX\.md/);
  });
});

describe("STATUS.md compat", () => {
  it("renders no UX line for a legacy stage and exposes ux in --json-shaped status only when set", () => {
    seed("executing");
    const legacy = readMasterStatus(cwd);
    expect("ux" in legacy).toBe(false);
    expect(renderStatusMd(legacy)).not.toContain("UX:");
    seed("ux", "hecho", "md-json");
    const status = readMasterStatus(cwd);
    expect(status.ux).toBe("md-json");
    expect(status.nextPhase).toBe("executing");
    expect(renderStatusMd(status)).toContain("UX: md-json");
  });

  it("mastered's next phase is ux", () => {
    seed("mastered");
    expect(readMasterStatus(cwd).nextPhase).toBe("ux");
  });
});
