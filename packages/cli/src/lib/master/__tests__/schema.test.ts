import { describe, it, expect } from "vitest";
import { MasterIndexSchema, MasterStateSchema, PartsSchema } from "../schema.ts";

// Covers: R6, R16, R48, R54, R59
describe("MasterStateSchema — phases (R6)", () => {
  it("accepts every declared phase, including 'closed' replacing 'done'", () => {
    const phases = [
      "context",
      "transcribed",
      "mapped",
      "planned",
      "questioned",
      "mastered",
      "executing",
      "closed",
    ];
    for (const phase of phases) {
      const parsed = MasterStateSchema.safeParse({
        version: 1,
        phase,
        mode: null,
        signal: {
          commits: null,
          firstCommit: null,
          filesChangedSinceFirst: null,
          framework: null,
          libraries: [],
          suggested: "template",
        },
        history: [],
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("rejects an invalid phase", () => {
    const parsed = MasterStateSchema.safeParse({
      version: 1,
      phase: "done",
      mode: null,
      signal: {
        commits: null,
        firstCommit: null,
        filesChangedSinceFirst: null,
        framework: null,
        libraries: [],
        suggested: "template",
      },
      history: [],
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts mode: null before the user has chosen it (R16)", () => {
    const parsed = MasterStateSchema.safeParse({
      version: 1,
      phase: "context",
      mode: null,
      signal: {
        commits: null,
        firstCommit: null,
        filesChangedSinceFirst: null,
        framework: null,
        libraries: [],
        suggested: "template",
      },
      history: [],
    });
    expect(parsed.success).toBe(true);
  });

  it("fails with a message naming the version this navori supports on an unknown version", () => {
    const parsed = MasterStateSchema.safeParse({
      version: 2,
      phase: "context",
      mode: null,
      signal: {
        commits: null,
        firstCommit: null,
        filesChangedSinceFirst: null,
        framework: null,
        libraries: [],
        suggested: "template",
      },
      history: [],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.message.includes("version 1"))).toBe(true);
    }
  });
});

describe("MasterIndexSchema — stage states (R54)", () => {
  const baseStage = (overrides: Record<string, unknown> = {}) => ({
    number: 1,
    slug: "mvp",
    dir: "01-mvp",
    state: "activa",
    openedAt: "2026-09-25",
    closedAt: null,
    spec: null,
    ...overrides,
  });

  it("accepts all four stage states with their required date shape", () => {
    const cases = [
      baseStage({ state: "activa", closedAt: null }),
      baseStage({ state: "cerrada", closedAt: "2026-10-01" }),
      baseStage({ state: "convertida", closedAt: "2026-10-01", spec: "specs/0040-x" }),
      baseStage({ state: "abandonada", closedAt: "2026-10-01" }),
    ];
    for (const stage of cases) {
      const parsed = MasterIndexSchema.safeParse({ version: 1, stages: [stage] });
      expect(parsed.success, JSON.stringify(stage)).toBe(true);
    }
  });

  it("rejects two stages marked 'activa'", () => {
    const parsed = MasterIndexSchema.safeParse({
      version: 1,
      stages: [
        baseStage({ number: 1, slug: "mvp", dir: "01-mvp" }),
        baseStage({ number: 2, slug: "pagos", dir: "02-pagos" }),
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("fails with a message naming the version this navori supports on an unknown index version", () => {
    const parsed = MasterIndexSchema.safeParse({ version: 99, stages: [] });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.message.includes("version 1"))).toBe(true);
    }
  });
});

describe("PartsSchema — ids, dependsOn and reason (R48, R59)", () => {
  const criterion = (overrides: Record<string, unknown> = {}) => ({
    id: "A1",
    description: "does the thing",
    method: "test",
    test: { file: "src/x.test.ts", case: "does the thing" },
    ...overrides,
  });

  const part = (overrides: Record<string, unknown> = {}) => ({
    id: "P1",
    title: "Parte 1",
    objective: "objective",
    dependsOn: [],
    acceptance: [criterion()],
    ...overrides,
  });

  it("accepts consecutive, unique part ids", () => {
    const parsed = PartsSchema.safeParse({
      version: 1,
      parts: [part({ id: "P1" }), part({ id: "P2" })],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects duplicated or skipped part ids", () => {
    const duplicated = PartsSchema.safeParse({
      version: 1,
      parts: [part({ id: "P1" }), part({ id: "P1" })],
    });
    expect(duplicated.success).toBe(false);

    const skipped = PartsSchema.safeParse({
      version: 1,
      parts: [part({ id: "P1" }), part({ id: "P3" })],
    });
    expect(skipped.success).toBe(false);
  });

  it("rejects a cycle in dependsOn", () => {
    const parsed = PartsSchema.safeParse({
      version: 1,
      parts: [part({ id: "P1", dependsOn: ["P2"] }), part({ id: "P2", dependsOn: ["P1"] })],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects dependsOn pointing to a part that does not exist", () => {
    const parsed = PartsSchema.safeParse({
      version: 1,
      parts: [part({ id: "P1", dependsOn: ["P9"] })],
    });
    expect(parsed.success).toBe(false);
  });

  it("requires a reason for a 'diferida' part and rejects a reason otherwise", () => {
    const withoutReason = PartsSchema.safeParse({
      version: 1,
      parts: [part({ id: "P1", state: "diferida" })],
    });
    expect(withoutReason.success).toBe(false);

    const withReason = PartsSchema.safeParse({
      version: 1,
      parts: [part({ id: "P1", state: "diferida", reason: "moved to next stage" })],
    });
    expect(withReason.success).toBe(true);

    const stray = PartsSchema.safeParse({
      version: 1,
      parts: [part({ id: "P1", state: "pendiente", reason: "not allowed here" })],
    });
    expect(stray.success).toBe(false);
  });

  it("rejects a criterion with no method and one whose detail doesn't match its method", () => {
    const noMethod = PartsSchema.safeParse({
      version: 1,
      parts: [part({ acceptance: [{ id: "A1", description: "x" }] })],
    });
    expect(noMethod.success).toBe(false);

    const mismatched = PartsSchema.safeParse({
      version: 1,
      parts: [
        part({
          acceptance: [
            {
              id: "A1",
              description: "x",
              method: "comando",
              test: { file: "x.ts", case: "x" },
            },
          ],
        }),
      ],
    });
    expect(mismatched.success).toBe(false);
  });

  it("rejects an 'approval' evidence on a non-manual criterion", () => {
    const parsed = PartsSchema.safeParse({
      version: 1,
      parts: [
        part({
          acceptance: [
            criterion({
              evidence: { kind: "approval", approvedBy: "user", date: "2026-09-25" },
            }),
          ],
        }),
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects duplicate acceptance ids within a part", () => {
    const parsed = PartsSchema.safeParse({
      version: 1,
      parts: [part({ acceptance: [criterion({ id: "A1" }), criterion({ id: "A1" })] })],
    });
    expect(parsed.success).toBe(false);
  });

  it("fails with a message naming the version this navori supports on an unknown parts version", () => {
    const parsed = PartsSchema.safeParse({ version: 2, parts: [] });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.message.includes("version 1"))).toBe(true);
    }
  });
});
