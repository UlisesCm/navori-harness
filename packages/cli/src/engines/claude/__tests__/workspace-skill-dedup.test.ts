import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// ---------------------------------------------------------------------------
// Lote 3 — a workspace stops writing what the root has; what it already has on
// disk goes only through the pristine criterion.
// ---------------------------------------------------------------------------

describe("renderClaudeEngine con `workspaceSkills` (spec 0043 T4)", () => {
  let ws: string;
  const skillFile = (id: string): string => join(ws, `.claude/skills/${id}/SKILL.md`);
  const omit = (...ids: string[]) => ({ omitted: new Set(ids), prune: true });

  beforeEach(() => {
    ws = join(root, "apps/api");
    mkdirSync(ws, { recursive: true });
  });

  it("una librería implícita del preset, omitida y con texto del usuario, sobrevive a §8.7", () => {
    // Covers: R3
    // `fastapi-python` trae `fastapi` implícita: no está en `project.libraries`, así
    // que solo la salva el plan SIN filtrar (#1094). Con el filtrado, §8.7 la
    // borraría con su criterio débil, que solo mira el marcador.
    const config = { ...BASE, preset: "fastapi-python" } as unknown as NavoriConfig;
    renderClaudeEngine(ws, config, { repoRoot: root });
    expect(existsSync(skillFile("fastapi"))).toBe(true);
    writeFileSync(skillFile("fastapi"), `${readFileSync(skillFile("fastapi"), "utf-8")}\nMía.\n`);

    const r = renderClaudeEngine(ws, config, { repoRoot: root, workspaceSkills: omit("fastapi") });

    expect(existsSync(skillFile("fastapi"))).toBe(true);
    expect(r.trimmedKept).toEqual([
      { path: ".claude/skills/fastapi/SKILL.md", reason: "modified" },
    ]);
  });

  it("una copia prístina se quita con `removed-trimmed`; una sin marcador o de un navori más nuevo se conserva", () => {
    // Covers: R3
    renderClaudeEngine(ws, BASE, { repoRoot: root });
    writeFileSync(skillFile("debug-failure"), "# mía, sin marcador\n");
    const scoped = readFileSync(skillFile("scoped-gate"), "utf-8");
    writeFileSync(skillFile("scoped-gate"), scoped.replace(/version="[^"]+"/, 'version="99.0.0"'));

    const r = renderClaudeEngine(ws, BASE, {
      repoRoot: root,
      workspaceSkills: omit("locate-code", "debug-failure", "scoped-gate"),
    });

    expect(existsSync(join(ws, ".claude/skills/locate-code"))).toBe(false);
    expect(r.written).toContainEqual({
      path: ".claude/skills/locate-code",
      status: "removed-trimmed",
    });
    expect(existsSync(skillFile("debug-failure"))).toBe(true);
    expect(existsSync(skillFile("scoped-gate"))).toBe(true);
    expect(r.trimmedKept).toEqual(
      expect.arrayContaining([
        { path: ".claude/skills/debug-failure/SKILL.md", reason: "foreign" },
        { path: ".claude/skills/scoped-gate/SKILL.md", reason: "newer" },
      ]),
    );
  });

  it("con `prune: false` no borra nada y no recrea lo omitido", () => {
    // Covers: R9
    renderClaudeEngine(ws, BASE, { repoRoot: root });
    rmSync(join(ws, ".claude/skills/review-diff"), { recursive: true });

    const r = renderClaudeEngine(ws, BASE, {
      repoRoot: root,
      workspaceSkills: { omitted: new Set(["locate-code", "review-diff"]), prune: false },
    });

    expect(existsSync(skillFile("locate-code"))).toBe(true);
    expect(existsSync(skillFile("review-diff"))).toBe(false);
    expect(r.written.filter((w) => w.status === "removed-trimmed")).toEqual([]);
  });

  it("sin índice de skills en el workspace (#1273) y sin warnings por las omitidas", () => {
    // Covers: R13
    const r = renderClaudeEngine(ws, BASE, {
      repoRoot: root,
      workspaceSkills: omit("locate-code"),
    });
    const index = readFileSync(join(ws, "CLAUDE.md"), "utf-8");
    expect(index).not.toContain('id="skills-index"');
    expect(r.warnings).toEqual(
      expect.not.arrayContaining([expect.stringContaining("locate-code")]),
    );
  });
});
