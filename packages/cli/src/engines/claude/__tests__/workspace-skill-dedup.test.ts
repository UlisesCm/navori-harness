import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NavoriConfig } from "../../../lib/config/config.ts";
import type { OverlapRow } from "../../shared/native-overlap.ts";

/**
 * Spec 0043 T2 — the shared pieces the workspace dedup is built on: the single
 * plan producer (`planClaudeSkills`) and the fresh-render oracle
 * (`composeFreshClaudeSkill`). Both must agree with what the engine writes.
 */

const NATIVE_SKILL = "locate-code";
const NATIVE_ROW: OverlapRow = {
  unit: { kind: "skill", id: NATIVE_SKILL },
  native: {
    capability: "fixture",
    url: "https://code.claude.com/docs/en/skills",
    verifiedAt: "2026-09-30",
  },
  verdict: "reemplazar-por-nativo",
  codexParity: { state: "igual", enforcing: false },
  engines: {
    claude: "native",
    codex: "emit",
    pi: "unsupported",
    "agents-md": "emit",
    cursor: "emit",
    copilot: "emit",
  },
  nativeEmission: { kind: "none", detail: "fixture" },
  note: "fixture",
};
const matrix = vi.hoisted(() => ({ rows: [] as OverlapRow[] }));
vi.mock(import("../../shared/native-overlap.ts"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    filterInventory: (inventory, engine) =>
      original.filterInventory(inventory, engine, matrix.rows),
  };
});

const { renderClaudeEngine, planClaudeSkills, composeFreshClaudeSkill } =
  await import("../index.ts");

const BASE = {
  name: "demo",
  engines: ["claude"],
  preset: "custom",
  version: "1.0.0",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
  qualityGate: { fast: "bun lint", full: "bun test" },
} as unknown as NavoriConfig;
const WITH_JSCPD = { ...BASE, plugins: { jscpd: { enabled: true } } } as unknown as NavoriConfig;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "navori-dedup-"));
  matrix.rows = [];
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("composeFreshClaudeSkill (spec 0043 T2)", () => {
  for (const [label, config, skillId] of [
    ["sin plugin que inyecte", BASE, "review-diff"],
    ["con un plugin que inyecta en la skill", WITH_JSCPD, "review-diff"],
  ] as const) {
    it(`da los mismos bytes que render en un directorio vacío, ${label}`, () => {
      // Covers: R2
      renderClaudeEngine(root, config);
      const planned = planClaudeSkills(root, config, { repoRoot: root });
      const skill = planned.skills.find((s) => s.id === skillId);
      expect(skill).toBeDefined();
      const onDisk = readFileSync(join(root, `.claude/skills/${skillId}/SKILL.md`), "utf-8");
      expect(composeFreshClaudeSkill(skill!, config, planned.plugins)).toBe(onDisk);
    });
  }

  it("el plugin que inyecta cambia los bytes: el caso con plugin no es el de sin plugin", () => {
    // Covers: R2
    const plain = planClaudeSkills(root, BASE, { repoRoot: root });
    const injected = planClaudeSkills(root, WITH_JSCPD, { repoRoot: root });
    const pick = (p: typeof plain) => p.skills.find((s) => s.id === "review-diff")!;
    expect(composeFreshClaudeSkill(pick(injected), WITH_JSCPD, injected.plugins)).not.toBe(
      composeFreshClaudeSkill(pick(plain), BASE, plain.plugins),
    );
  });
});

describe("planClaudeSkills (spec 0043 T2)", () => {
  it("excluye lo que retira la matriz nativa, igual que el plan del engine", () => {
    // Covers: R2
    expect(planClaudeSkills(root, BASE, { repoRoot: root }).skills.map((s) => s.id)).toContain(
      NATIVE_SKILL,
    );
    matrix.rows = [NATIVE_ROW];
    const ids = planClaudeSkills(root, BASE, { repoRoot: root }).skills.map((s) => s.id);
    expect(ids).not.toContain(NATIVE_SKILL);
    renderClaudeEngine(root, BASE);
    expect(existsSync(join(root, `.claude/skills/${NATIVE_SKILL}/SKILL.md`))).toBe(false);
    for (const id of ids) {
      expect(existsSync(join(root, `.claude/skills/${id}/SKILL.md`))).toBe(true);
    }
  });

  it("reporta presetLoaded=false cuando el preset declarado no carga, y no emite avisos", () => {
    // Covers: R2
    const broken = { ...BASE, preset: "no-such-preset" } as unknown as NavoriConfig;
    expect(planClaudeSkills(root, broken, { repoRoot: root }).presetLoaded).toBe(false);
    expect(planClaudeSkills(root, BASE, { repoRoot: root }).presetLoaded).toBe(true);
  });
});
