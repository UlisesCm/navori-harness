// Covers: R8, R10, R11, R12, R14, R16, R21, R22, R23, R29, R30, R31, R32, R50, R52
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";
import { masterCommand } from "../../../commands/master.ts";
import { runMasterInit } from "../init.ts";
import { indexJsonPath, masterDirPath } from "../stages.ts";
import {
  buildCheckContext,
  checkClosedStage,
  checkHistoryChain,
  checkRawGitignore,
  checksForTransition,
  MasterCheckSetupError,
  runMasterAdvance,
  runMasterCheck,
  type CheckContext,
} from "../checks.ts";
import type { MasterIndex, MasterState, Part, StageEntry } from "../schema.ts";
import { createGitHelper, createCommitHelper, createSeedConfigHelper } from "./test-utils.ts";

let cwd: string;
let templatesRoot: string;
const SPECS_DIR = "specs";

let git: (args: string[]) => void;
let commit: (message: string) => void;
let seedConfig: (overrides?: Record<string, unknown>) => void;

const PLAN_TEMPLATE = [
  "## Metadatos",
  "",
  "placeholder",
  "",
  "## Estado actual vs. objetivo",
  "<!-- only-mode: en-curso -->",
  "",
  "placeholder",
  "",
  "## Entrega en partes",
  "",
  "placeholder",
  "",
].join("\n");

const MASTER_TEMPLATE = [
  "## Metadatos",
  "",
  "placeholder",
  "",
  "## Entrega en partes",
  "",
  "placeholder",
  "",
  "## Preguntas abiertas",
  "",
  "placeholder",
  "",
].join("\n");

const DIGEST_TEMPLATE = [
  "## Resumen por archivo",
  "x",
  "## Hechos",
  "x",
  "## Actores",
  "x",
  "## Capacidades",
  "x",
  "## Integraciones externas",
  "x",
  "## Entidades de datos",
  "x",
  "## Superficies",
  "x",
  "## Hallazgos",
  "x",
].join("\n");

const PLAN_TEMPLATE_EN = [
  "## Metadata",
  "",
  "placeholder",
  "",
  "## Current state vs. objective",
  "<!-- only-mode: en-curso -->",
  "",
  "placeholder",
  "",
  "## Delivery in parts",
  "",
  "placeholder",
  "",
].join("\n");

const MASTER_TEMPLATE_EN = [
  "## Metadata",
  "",
  "placeholder",
  "",
  "## Delivery in parts",
  "",
  "placeholder",
  "",
  "## Open questions",
  "",
  "placeholder",
  "",
].join("\n");

const DIGEST_TEMPLATE_EN = [
  "## Summary per file",
  "x",
  "## Facts",
  "x",
  "## Actors",
  "x",
  "## Capabilities",
  "x",
  "## External integrations",
  "x",
  "## Data entities",
  "x",
  "## Surfaces",
  "x",
  "## Findings",
  "x",
].join("\n");

function seedTemplates(): void {
  const dir = join(templatesRoot, "core-assets", "master-plan");
  const enDir = join(dir, "en");
  mkdirSync(enDir, { recursive: true });
  writeFileSync(join(dir, "plan.md"), PLAN_TEMPLATE);
  writeFileSync(join(dir, "master.md"), MASTER_TEMPLATE);
  writeFileSync(join(dir, "digest.md"), DIGEST_TEMPLATE);
  writeFileSync(join(enDir, "plan.md"), PLAN_TEMPLATE_EN);
  writeFileSync(join(enDir, "master.md"), MASTER_TEMPLATE_EN);
  writeFileSync(join(enDir, "digest.md"), DIGEST_TEMPLATE_EN);
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-master-checks-"));
  templatesRoot = mkdtempSync(join(tmpdir(), "navori-master-checks-templates-"));
  git = createGitHelper(cwd);
  commit = createCommitHelper(git);
  seedConfig = createSeedConfigHelper(cwd);
  seedTemplates();
  git(["init", "-q"]);
  seedConfig();
  commit("initial");
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(templatesRoot, { recursive: true, force: true });
});

function stage(overrides: Partial<StageEntry> = {}): StageEntry {
  return {
    number: 1,
    slug: "mvp",
    dir: "01-mvp",
    state: "activa",
    openedAt: "2026-01-01",
    closedAt: null,
    spec: null,
    ...overrides,
  };
}

function stagePath(dir = "01-mvp"): string {
  return join(masterDirPath(cwd, SPECS_DIR), dir);
}

function baseState(overrides: Partial<MasterState> = {}): MasterState {
  return {
    version: 1,
    phase: "context",
    mode: "template",
    signal: {
      commits: 1,
      firstCommit: "2026-01-01",
      filesChangedSinceFirst: 0,
      framework: null,
      libraries: [],
      suggested: "template",
    },
    outcome: null,
    history: [{ phase: "context", at: "2026-01-01" }],
    ...overrides,
  };
}

/** Builds a `CheckContext` directly (no full `init`/`advance` walk) so each
 * table row can be tested against a minimal, targeted fixture. */
function makeCtx(overrides: Partial<CheckContext> = {}): CheckContext {
  const activeStage = overrides.stage ?? stage();
  mkdirSync(stagePath(activeStage.dir), { recursive: true });
  return {
    cwd,
    specsDir: SPECS_DIR,
    language: "es",
    index: { version: 1, stages: [activeStage] },
    stage: activeStage,
    stagePath: stagePath(activeStage.dir),
    state: baseState(),
    templatesRoot,
    ...overrides,
  };
}

function write(ctx: CheckContext, relPath: string, content: string): void {
  const path = join(ctx.stagePath, relPath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

/** A minimal, valid `parts.json` with a single manual-criterion P1 — the
 * shared fixture every `checkMasterDocument` test seeds (both the Spanish and
 * the English marker suites). */
function writeSinglePart(ctx: CheckContext): void {
  writeFileSync(
    join(ctx.stagePath, "parts.json"),
    JSON.stringify({
      version: 1,
      parts: [
        {
          id: "P1",
          title: "x",
          objective: "x",
          scope: [],
          outOfScope: [],
          dependsOn: [],
          seedRequirements: [],
          acceptance: [
            {
              id: "A1",
              description: "x",
              method: "manual",
              manual: { check: "x", how: "x" },
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
}

describe("checkRawGitignore — every phase (R4)", () => {
  it("fails when context/raw/.gitignore is missing", () => {
    const ctx = makeCtx();
    expect(checkRawGitignore(ctx).length).toBeGreaterThan(0);
  });

  it("passes when it exists", () => {
    const ctx = makeCtx();
    write(ctx, "context/raw/.gitignore", "*\n!.gitignore\n");
    expect(checkRawGitignore(ctx)).toEqual([]);
  });
});

describe("checkHistoryChain — consecutive phases only", () => {
  it("fails on an empty history", () => {
    const ctx = makeCtx({ state: baseState({ history: [] }) });
    expect(checkHistoryChain(ctx).length).toBeGreaterThan(0);
  });

  it("fails when a phase is skipped", () => {
    const ctx = makeCtx({
      state: baseState({
        history: [
          { phase: "context", at: "2026-01-01" },
          { phase: "mapped", at: "2026-01-02" },
        ],
      }),
    });
    expect(checkHistoryChain(ctx).length).toBeGreaterThan(0);
  });

  it("passes on a consecutive chain", () => {
    const ctx = makeCtx({
      state: baseState({
        history: [
          { phase: "context", at: "2026-01-01" },
          { phase: "transcribed", at: "2026-01-02" },
        ],
      }),
    });
    expect(checkHistoryChain(ctx)).toEqual([]);
  });
});

describe("checksForTransition('transcribed') — R9-R11", () => {
  function seedRawAndIntake(ctx: CheckContext, intake: string): void {
    write(ctx, "context/raw/doc.pdf", "raw");
    write(
      ctx,
      "context/md/doc.md",
      "> Fuente: context/raw/doc.pdf · Método: markitdown 0.1.2\n\ncontent\n",
    );
    write(ctx, "context/INTAKE.md", intake);
  }

  const VALID_INTAKE = [
    "| Archivo | Método | Resultado |",
    "|---|---|---|",
    "| doc.pdf | markitdown | context/md/doc.md |",
  ].join("\n");

  it("fails without a mode", () => {
    const ctx = makeCtx({ state: baseState({ mode: null }) });
    seedRawAndIntake(ctx, VALID_INTAKE);
    expect(checksForTransition(ctx, "transcribed").length).toBeGreaterThan(0);
  });

  it("fails when raw/ has no file besides .gitignore", () => {
    const ctx = makeCtx();
    write(ctx, "context/INTAKE.md", "| Archivo | Método | Resultado |\n|---|---|---|\n");
    expect(checksForTransition(ctx, "transcribed").length).toBeGreaterThan(0);
  });

  it("fails when a markitdown row's header has no version", () => {
    const ctx = makeCtx();
    write(ctx, "context/raw/doc.pdf", "raw");
    write(
      ctx,
      "context/md/doc.md",
      "> Fuente: context/raw/doc.pdf · Método: markitdown\n\ncontent\n",
    );
    write(ctx, "context/INTAKE.md", VALID_INTAKE);
    expect(checksForTransition(ctx, "transcribed").length).toBeGreaterThan(0);
  });

  it("fails when a non-converted row has no cause", () => {
    const ctx = makeCtx();
    write(ctx, "context/raw/doc.pdf", "raw");
    write(
      ctx,
      "context/INTAKE.md",
      ["| Archivo | Método | Resultado |", "|---|---|---|", "| doc.pdf | ninguno |  |"].join("\n"),
    );
    expect(checksForTransition(ctx, "transcribed").length).toBeGreaterThan(0);
  });

  it("passes a valid fixture", () => {
    const ctx = makeCtx();
    seedRawAndIntake(ctx, VALID_INTAKE);
    expect(checksForTransition(ctx, "transcribed")).toEqual([]);
  });
});

describe("checksForTransition('mapped') — R12-R14, R19", () => {
  function seedDigestAndCodebase(ctx: CheckContext, digestBody: string): void {
    write(ctx, "context/md/doc.md", "content");
    write(ctx, "context/DIGEST.md", digestBody);
    write(
      ctx,
      "context/CODEBASE.md",
      ["## Stack", "x", "## Estructura", "x", "## Convenciones", "x", "## Specs", "x"].join("\n"),
    );
  }

  const VALID_DIGEST = [
    "## Resumen por archivo",
    "- doc.md: resumen",
    "## Hechos",
    "- hecho citando context/md/doc.md",
    "## Actores",
    "Ninguno",
    "## Capacidades",
    "Ninguno",
    "## Integraciones externas",
    "Ninguno",
    "## Entidades de datos",
    "Ninguno",
    "## Superficies",
    "Ninguno",
    "## Hallazgos",
    "Ninguno",
  ].join("\n");

  it("fails when a counting bullet cites no context/md/ file", () => {
    const ctx = makeCtx();
    const invalid = VALID_DIGEST.replace("- hecho citando context/md/doc.md", "- hecho sin cita");
    seedDigestAndCodebase(ctx, invalid);
    expect(checksForTransition(ctx, "mapped").length).toBeGreaterThan(0);
  });

  it("fails when CODEBASE.md is missing a section", () => {
    const ctx = makeCtx();
    write(ctx, "context/DIGEST.md", VALID_DIGEST);
    write(ctx, "context/CODEBASE.md", ["## Stack", "x"].join("\n"));
    expect(checksForTransition(ctx, "mapped").length).toBeGreaterThan(0);
  });

  it("passes a valid fixture", () => {
    const ctx = makeCtx();
    seedDigestAndCodebase(ctx, VALID_DIGEST);
    expect(checksForTransition(ctx, "mapped")).toEqual([]);
  });
});

describe("checksForTransition('planned') — R21-R23", () => {
  function planContent(
    overrides: Partial<Record<"metadatos" | "entrega" | "extra", string>> = {},
  ): string {
    return [
      "## Metadatos",
      "",
      overrides.metadatos ?? "Proyecto demo.",
      "",
      "## Entrega en partes",
      "",
      overrides.entrega ?? "P1 con objetivo.",
      "",
      overrides.extra ?? "",
    ].join("\n");
  }

  function seedThreePlans(content: string): void {
    for (const name of ["plan1.md", "plan2.md", "plan3.md"]) {
      write(makeCtxCache, `plans/${name}`, content);
    }
  }

  // `template` mode never asks for "Estado actual vs. objetivo" (R18).
  let makeCtxCache: CheckContext;

  it("fails when a plan is missing a required header", () => {
    makeCtxCache = makeCtx();
    seedThreePlans(["## Metadatos", "", "x", ""].join("\n"));
    expect(checksForTransition(makeCtxCache, "planned").length).toBeGreaterThan(0);
  });

  it("fails when an RN- line cites neither context/md/ nor [SUPUESTO]", () => {
    makeCtxCache = makeCtx();
    seedThreePlans(planContent({ extra: "RN-1: la tarifa es fija." }));
    expect(checksForTransition(makeCtxCache, "planned").length).toBeGreaterThan(0);
  });

  it("passes an RN- line with [SUPUESTO]", () => {
    makeCtxCache = makeCtx();
    seedThreePlans(planContent({ extra: "RN-1: la tarifa es fija. [SUPUESTO]" }));
    expect(checksForTransition(makeCtxCache, "planned")).toEqual([]);
  });

  it("fails when a URL has no 'consultado AAAA-MM-DD' nor [SIN VERIFICAR]", () => {
    makeCtxCache = makeCtx();
    seedThreePlans(planContent({ extra: "Ver https://example.com/docs." }));
    expect(checksForTransition(makeCtxCache, "planned").length).toBeGreaterThan(0);
  });

  it("passes a URL marked [SIN VERIFICAR]", () => {
    makeCtxCache = makeCtx();
    seedThreePlans(planContent({ extra: "Ver https://example.com/docs. [SIN VERIFICAR]" }));
    expect(checksForTransition(makeCtxCache, "planned")).toEqual([]);
  });

  it("template mode does not require 'Estado actual vs. objetivo'", () => {
    makeCtxCache = makeCtx({ state: baseState({ mode: "template" }) });
    seedThreePlans(planContent());
    expect(checksForTransition(makeCtxCache, "planned")).toEqual([]);
  });

  it("en-curso mode requires 'Estado actual vs. objetivo'", () => {
    makeCtxCache = makeCtx({ state: baseState({ mode: "en-curso" }) });
    seedThreePlans(planContent());
    const failures = checksForTransition(makeCtxCache, "planned");
    expect(failures.some((f) => f.includes("Estado actual vs. objetivo"))).toBe(true);
  });

  it("passes a valid fixture in en-curso mode with the section present", () => {
    makeCtxCache = makeCtx({ state: baseState({ mode: "en-curso" }) });
    const content = [
      "## Metadatos",
      "",
      "Proyecto demo.",
      "",
      "## Estado actual vs. objetivo",
      "",
      "Estado hoy.",
      "",
      "## Entrega en partes",
      "",
      "P1 con objetivo.",
      "",
    ].join("\n");
    seedThreePlans(content);
    expect(checksForTransition(makeCtxCache, "planned")).toEqual([]);
  });
});

describe("checksForTransition('questioned') — R29, R52", () => {
  it("passes with 'Sin decisiones' in the first stage", () => {
    const ctx = makeCtx();
    write(ctx, "DECISIONS.md", "Sin decisiones");
    expect(checksForTransition(ctx, "questioned")).toEqual([]);
  });

  it("fails a D<n> block missing a field", () => {
    const ctx = makeCtx();
    write(ctx, "DECISIONS.md", "## D1\n\n- Pregunta: x\n- Elegida: y\n- Fecha: 2026-01-01\n");
    expect(checksForTransition(ctx, "questioned").length).toBeGreaterThan(0);
  });

  it("passes a well-formed D1", () => {
    const ctx = makeCtx();
    write(
      ctx,
      "DECISIONS.md",
      "## D1\n\n- Pregunta: x\n- Elegida: y\n- Descartadas: z\n- Fecha: 2026-01-01\n",
    );
    expect(checksForTransition(ctx, "questioned")).toEqual([]);
  });

  it("stage >= 2 requires a D<n> per deferred part of the last closed stage", () => {
    const closed = stage({
      number: 1,
      slug: "mvp",
      dir: "01-mvp",
      state: "cerrada",
      closedAt: "2026-01-01",
    });
    const active = stage({ number: 2, slug: "pagos", dir: "02-pagos", state: "activa" });
    mkdirSync(stagePath("01-mvp"), { recursive: true });
    const part: Part = {
      id: "P1",
      title: "Diferida",
      objective: "x",
      scope: [],
      outOfScope: [],
      dependsOn: [],
      seedRequirements: [],
      acceptance: [
        {
          id: "A1",
          description: "x",
          method: "manual",
          manual: { check: "x", how: "x" },
          evidence: null,
        },
      ],
      inheritedFrom: null,
      state: "diferida",
      reason: "sin tiempo",
      spec: null,
      issue: null,
    };
    writeFileSync(
      join(stagePath("01-mvp"), "parts.json"),
      JSON.stringify({ version: 1, parts: [part] }),
    );
    const ctx = makeCtx({
      stage: active,
      index: { version: 1, stages: [closed, active] },
    });
    write(ctx, "DECISIONS.md", "Sin decisiones");
    const failures = checksForTransition(ctx, "questioned");
    expect(failures.some((f) => f.includes("01-mvp/P1"))).toBe(true);
  });
});

describe("checksForTransition('mastered'/'executing') — R30-R33, R59", () => {
  function masterContent(
    overrides: Partial<Record<"metadatos" | "entrega" | "preguntas", string>> = {},
  ): string {
    return [
      "## Metadatos",
      "",
      overrides.metadatos ?? "Proyecto demo.\n\nOrigen: plan1 §1",
      "",
      "## Entrega en partes",
      "",
      overrides.entrega ?? "P1 con objetivo.\n\nOrigen: plan1 §15",
      "",
      "## Preguntas abiertas",
      "",
      overrides.preguntas ?? "Ninguna",
      "",
    ].join("\n");
  }

  const seedParts = writeSinglePart;

  it("fails a section missing 'Origen:'", () => {
    const ctx = makeCtx();
    seedParts(ctx);
    write(ctx, "MASTER.md", masterContent({ metadatos: "Proyecto demo, sin origen." }));
    expect(checksForTransition(ctx, "mastered").length).toBeGreaterThan(0);
  });

  it("fails with an unresolved [SUPUESTO]", () => {
    const ctx = makeCtx();
    seedParts(ctx);
    write(ctx, "MASTER.md", masterContent({ entrega: "P1 [SUPUESTO]\n\nOrigen: plan1 §15" }));
    expect(checksForTransition(ctx, "mastered").length).toBeGreaterThan(0);
  });

  it("fails when 'Preguntas abiertas' is not 'Ninguna' (R32)", () => {
    const ctx = makeCtx();
    seedParts(ctx);
    write(ctx, "MASTER.md", masterContent({ preguntas: "Falta decidir X" }));
    expect(checksForTransition(ctx, "mastered").length).toBeGreaterThan(0);
  });

  it("fails without parts.json", () => {
    const ctx = makeCtx();
    write(ctx, "MASTER.md", masterContent());
    expect(checksForTransition(ctx, "mastered").length).toBeGreaterThan(0);
  });

  it("fails citing a D<n> that does not exist", () => {
    const ctx = makeCtx();
    seedParts(ctx);
    write(ctx, "DECISIONS.md", "Sin decisiones");
    write(ctx, "MASTER.md", masterContent({ metadatos: "Origen: D3" }));
    expect(checksForTransition(ctx, "mastered").some((f) => f.includes("D3"))).toBe(true);
  });

  it("passes citing 'Origen: 01-mvp/D3' against that stage's DECISIONS.md", () => {
    mkdirSync(stagePath("01-mvp"), { recursive: true });
    writeFileSync(
      join(stagePath("01-mvp"), "DECISIONS.md"),
      "## D3\n\n- Pregunta: x\n- Elegida: y\n- Descartadas: z\n- Fecha: 2026-01-01\n",
    );
    const closed = stage({
      number: 1,
      slug: "mvp",
      dir: "01-mvp",
      state: "cerrada",
      closedAt: "2026-01-01",
    });
    const active = stage({ number: 2, slug: "pagos", dir: "02-pagos", state: "activa" });
    const ctx = makeCtx({ stage: active, index: { version: 1, stages: [closed, active] } });
    seedParts(ctx);
    write(ctx, "DECISIONS.md", "Sin decisiones");
    write(ctx, "MASTER.md", masterContent({ metadatos: "Origen: 01-mvp/D3" }));
    expect(checksForTransition(ctx, "mastered")).toEqual([]);
  });

  it("passes a valid fixture, and 'executing' runs the same checks", () => {
    const ctx = makeCtx();
    seedParts(ctx);
    write(ctx, "MASTER.md", masterContent());
    expect(checksForTransition(ctx, "mastered")).toEqual([]);
    expect(checksForTransition(ctx, "executing")).toEqual([]);
  });
});

describe("runMasterAdvance — never skips, never leaves executing (R8)", () => {
  async function master(...argv: string[]): Promise<void> {
    await runCommand(masterCommand, { rawArgs: [...argv, "--cwd", cwd] });
  }

  it("fails to advance past executing, without writing", async () => {
    await master("init", "mvp");
    const stagePathAbs = stagePath();
    const raw: MasterIndex = JSON.parse(readFileSync(indexJsonPath(cwd, SPECS_DIR), "utf8"));
    const activeEntry = raw.stages[0]!;
    writeFileSync(
      join(stagePathAbs, "state.json"),
      JSON.stringify(
        baseState({ phase: "executing", history: [{ phase: "executing", at: "2026-01-01" }] }),
      ),
    );
    const before = readFileSync(join(stagePathAbs, "state.json"), "utf8");
    const result = runMasterAdvance(cwd, { templatesRoot });
    expect(result.advanced).toBe(false);
    expect(result.to).toBeNull();
    expect(readFileSync(join(stagePathAbs, "state.json"), "utf8")).toBe(before);
    expect(activeEntry.state).toBe("activa");
  });

  it("does not write when the transition's checks fail", () => {
    runMasterInit(cwd, "mvp");
    const stagePathAbs = stagePath();
    const before = readFileSync(join(stagePathAbs, "state.json"), "utf8");
    const result = runMasterAdvance(cwd, { templatesRoot });
    expect(result.advanced).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(readFileSync(join(stagePathAbs, "state.json"), "utf8")).toBe(before);
  });

  it("advances exactly one phase (context -> transcribed) when the checks pass", () => {
    runMasterInit(cwd, "mvp");
    const stagePathAbs = stagePath();
    const stateBeforeMode: MasterState = JSON.parse(
      readFileSync(join(stagePathAbs, "state.json"), "utf8"),
    );
    writeFileSync(
      join(stagePathAbs, "state.json"),
      JSON.stringify({ ...stateBeforeMode, mode: "template" }),
    );
    writeFileSync(join(stagePathAbs, "context", "raw", "doc.pdf"), "raw");
    writeFileSync(
      join(stagePathAbs, "context", "md", "doc.md"),
      "> Fuente: context/raw/doc.pdf · Método: markitdown 0.1.2\n\ncontent\n",
    );
    writeFileSync(
      join(stagePathAbs, "context", "INTAKE.md"),
      [
        "| Archivo | Método | Resultado |",
        "|---|---|---|",
        "| doc.pdf | markitdown | context/md/doc.md |",
      ].join("\n"),
    );
    const result = runMasterAdvance(cwd, { templatesRoot });
    expect(result.advanced).toBe(true);
    expect(result.from).toBe("context");
    expect(result.to).toBe("transcribed");
    const state: MasterState = JSON.parse(readFileSync(join(stagePathAbs, "state.json"), "utf8"));
    expect(state.phase).toBe("transcribed");
    expect(state.history.map((h) => h.phase)).toEqual(["context", "transcribed"]);
  });
});

describe("runMasterCheck — read-only preview", () => {
  it("throws MasterCheckSetupError with no active stage", () => {
    expect(() => runMasterCheck(cwd, { templatesRoot })).toThrow(MasterCheckSetupError);
  });

  it("reports the failing checks without writing anything", () => {
    runMasterInit(cwd, "mvp");
    const stagePathAbs = stagePath();
    const before = readFileSync(join(stagePathAbs, "state.json"), "utf8");
    const result = runMasterCheck(cwd, { templatesRoot });
    expect(result.phase).toBe("context");
    expect(result.nextPhase).toBe("transcribed");
    expect(result.failures.length).toBeGreaterThan(0);
    expect(readFileSync(join(stagePathAbs, "state.json"), "utf8")).toBe(before);
  });
});

describe("buildCheckContext — a folder-less active stage is a failure, not a gap", () => {
  it("throws instead of treating a missing folder as healthy (Lote A review note)", () => {
    mkdirSync(masterDirPath(cwd, SPECS_DIR), { recursive: true });
    writeFileSync(indexJsonPath(cwd, SPECS_DIR), JSON.stringify({ version: 1, stages: [stage()] }));
    // No folder created for 01-mvp on purpose (init cut mid-way).
    expect(() => buildCheckContext(cwd)).toThrow(MasterCheckSetupError);
    expect(() => runMasterAdvance(cwd, { templatesRoot })).toThrow(MasterCheckSetupError);
    expect(() => runMasterCheck(cwd, { templatesRoot })).toThrow(MasterCheckSetupError);
  });
});

describe("checkClosedStage — R50, hash integrity with CRLF normalization", () => {
  function sha256(content: string): string {
    return createHash("sha256").update(content.replace(/\r\n/g, "\n"), "utf8").digest("hex");
  }

  /** `integridadHeading` defaults to the Spanish marker; the `en` tests below
   * pass "Integrity" to prove `checkClosedStage` resolves it per language
   * instead of a hardcoded "Integridad" (Lote B review). */
  function seedClosedStage(masterContent: string, integridadHeading = "Integridad"): void {
    const dir = stagePath("01-mvp");
    mkdirSync(join(dir, "context", "raw"), { recursive: true });
    writeFileSync(join(dir, "context", "raw", ".gitignore"), "*\n!.gitignore\n");
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify(
        baseState({ phase: "closed", history: [{ phase: "closed", at: "2026-01-01" }] }),
      ),
    );
    writeFileSync(join(dir, "MASTER.md"), masterContent);
    const hash = sha256(masterContent);
    writeFileSync(
      join(dir, "CLOSURE.md"),
      [
        `## ${integridadHeading}`,
        "",
        "| Archivo | Hash |",
        "|---|---|",
        `| MASTER.md | ${hash} |`,
        "",
      ].join("\n"),
    );
  }

  /** A closed stage with no rows under its "Integridad" section at all — the
   * bypass the review flagged: this must FAIL, never pass silently. */
  function seedClosedStageWithoutIntegrityTable(): void {
    const dir = stagePath("01-mvp");
    mkdirSync(join(dir, "context", "raw"), { recursive: true });
    writeFileSync(join(dir, "context", "raw", ".gitignore"), "*\n!.gitignore\n");
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify(
        baseState({ phase: "closed", history: [{ phase: "closed", at: "2026-01-01" }] }),
      ),
    );
    writeFileSync(join(dir, "MASTER.md"), "# MASTER\n\ncontent\n");
    writeFileSync(join(dir, "CLOSURE.md"), "# CLOSURE\n\nSin tabla de integridad.\n");
  }

  it("passes when the file matches its recorded hash (es)", () => {
    seedClosedStage("# MASTER\n\ncontent\n");
    expect(checkClosedStage(cwd, SPECS_DIR, "01-mvp", "es")).toEqual([]);
  });

  it("passes when the file matches its recorded hash, with the English 'Integrity' heading", () => {
    seedClosedStage("# MASTER\n\ncontent\n", "Integrity");
    expect(checkClosedStage(cwd, SPECS_DIR, "01-mvp", "en")).toEqual([]);
  });

  it("fails an 'en' repo whose CLOSURE.md kept the Spanish 'Integridad' heading", () => {
    seedClosedStage("# MASTER\n\ncontent\n", "Integridad");
    const failures = checkClosedStage(cwd, SPECS_DIR, "01-mvp", "en");
    expect(failures.some((f) => f.includes("Integrity"))).toBe(true);
  });

  it("fails when the file was hand-edited after closing", () => {
    seedClosedStage("# MASTER\n\ncontent\n");
    writeFileSync(join(stagePath("01-mvp"), "MASTER.md"), "# MASTER\n\nedited\n");
    expect(checkClosedStage(cwd, SPECS_DIR, "01-mvp", "es").length).toBeGreaterThan(0);
  });

  it("passes when only line endings changed to CRLF (normalized hash)", () => {
    seedClosedStage("# MASTER\n\ncontent\n");
    writeFileSync(join(stagePath("01-mvp"), "MASTER.md"), "# MASTER\r\n\r\ncontent\r\n");
    expect(checkClosedStage(cwd, SPECS_DIR, "01-mvp", "es")).toEqual([]);
  });

  it("still fails a real edit disguised with CRLF line endings", () => {
    seedClosedStage("# MASTER\n\ncontent\n");
    writeFileSync(join(stagePath("01-mvp"), "MASTER.md"), "# MASTER\r\n\r\nedited\r\n");
    expect(checkClosedStage(cwd, SPECS_DIR, "01-mvp", "es").length).toBeGreaterThan(0);
  });

  it("fails when raw/.gitignore was removed from a closed stage", () => {
    seedClosedStage("# MASTER\n\ncontent\n");
    rmSync(join(stagePath("01-mvp"), "context", "raw", ".gitignore"));
    const failures = checkClosedStage(cwd, SPECS_DIR, "01-mvp", "es");
    expect(failures.some((f) => f.includes("git checkout"))).toBe(true);
  });

  it("fails a closed stage whose CLOSURE.md has no Integridad table at all (bypass closed, R50)", () => {
    seedClosedStageWithoutIntegrityTable();
    const failures = checkClosedStage(cwd, SPECS_DIR, "01-mvp", "es");
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.some((f) => f.includes("Integridad"))).toBe(true);
  });
});

describe("mode fails after 'context' (R16)", () => {
  it("cannot set mode once past the context phase", async () => {
    await runCommand(masterCommand, { rawArgs: ["init", "mvp", "--cwd", cwd] });
    const stagePathAbs = stagePath();
    writeFileSync(
      join(stagePathAbs, "state.json"),
      JSON.stringify(
        baseState({
          phase: "transcribed",
          history: [
            { phase: "context", at: "2026-01-01" },
            { phase: "transcribed", at: "2026-01-02" },
          ],
        }),
      ),
    );
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    const originalWrite = process.stderr.write.bind(process.stderr);
    let stderrOutput = "";
    process.stderr.write = ((chunk: string) => {
      stderrOutput += chunk;
      return true;
    }) as typeof process.stderr.write;
    try {
      await runCommand(masterCommand, { rawArgs: ["mode", "en-curso", "--cwd", cwd] });
      expect(process.exitCode).toBe(1);
      expect(stderrOutput).toContain("context");
    } finally {
      process.stderr.write = originalWrite;
      process.exitCode = originalExitCode;
    }
    const state: MasterState = JSON.parse(readFileSync(join(stagePathAbs, "state.json"), "utf8"));
    expect(state.mode).toBe("template");
  });
});

describe("markers resolve by repo language (coordinator decision, not a discrepancy anymore)", () => {
  function masterContentEn(
    overrides: Partial<Record<"metadatos" | "entrega" | "preguntas", string>> = {},
  ): string {
    return [
      "## Metadata",
      "",
      overrides.metadatos ?? "Demo project.\n\nSource: plan1 §1",
      "",
      "## Delivery in parts",
      "",
      overrides.entrega ?? "P1 with objective.\n\nSource: plan1 §15",
      "",
      "## Open questions",
      "",
      overrides.preguntas ?? "None",
      "",
    ].join("\n");
  }

  const seedPartsEn = writeSinglePart;

  it("accepts English markers ('Source:'/'None') in an English-language stage", () => {
    const ctx = makeCtx({ language: "en" });
    seedPartsEn(ctx);
    write(ctx, "MASTER.md", masterContentEn());
    expect(checksForTransition(ctx, "mastered")).toEqual([]);
  });

  it("rejects the Spanish marker 'Origen:' in an English-language stage", () => {
    const ctx = makeCtx({ language: "en" });
    seedPartsEn(ctx);
    write(ctx, "MASTER.md", masterContentEn({ metadatos: "Demo project.\n\nOrigen: plan1 §1" }));
    const failures = checksForTransition(ctx, "mastered");
    expect(failures.some((f) => f.includes("Source:"))).toBe(true);
  });

  it("rejects the English 'None' marker in a Spanish-language stage (fails R32 in es)", () => {
    const ctx = makeCtx({ language: "es" });
    writeSinglePart(ctx);
    write(
      ctx,
      "MASTER.md",
      [
        "## Metadatos",
        "",
        "Proyecto demo.\n\nOrigen: plan1 §1",
        "",
        "## Entrega en partes",
        "",
        "P1 con objetivo.\n\nOrigen: plan1 §15",
        "",
        "## Preguntas abiertas",
        "",
        "None",
        "",
      ].join("\n"),
    );
    const failures = checksForTransition(ctx, "mastered");
    expect(failures.some((f) => f.includes("Ninguna"))).toBe(true);
  });

  it("English 'Sin decisiones'-equivalent ('No decisions') is accepted for an English stage", () => {
    const ctx = makeCtx({ language: "en" });
    write(ctx, "DECISIONS.md", "No decisions");
    expect(checksForTransition(ctx, "questioned")).toEqual([]);
  });

  it("the Spanish 'Sin decisiones' literal is NOT accepted for an English stage", () => {
    const ctx = makeCtx({ language: "en" });
    write(ctx, "DECISIONS.md", "Sin decisiones");
    expect(checksForTransition(ctx, "questioned").length).toBeGreaterThan(0);
  });
});
