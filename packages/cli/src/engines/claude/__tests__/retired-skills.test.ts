import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderClaudeEngine } from "../index.ts";
import { CORE_SKILLS, RETIRED_SKILLS, WORKFLOW_SKILLS } from "../../shared/harness-assets.ts";
import { readCliVersion } from "../../../lib/bundled-assets.ts";
import type { NavoriConfig } from "../../../lib/config.ts";

/**
 * A skill navori retires must leave the repos it was already rendered into
 * (#702).
 *
 * `render` only visits what it CURRENTLY renders, `--prune` covers outputs of
 * disabled engines, and `doctor` said nothing — so a retired skill stayed on
 * disk forever. And it is not an inert file: Claude Code discovers skills by
 * walking the directory, not by reading the index navori renders, so the agent
 * kept loading doctrine that had been withdrawn. Verified live with `pr-create`.
 */

const CONFIG = {
  name: "demo",
  engines: ["claude"],
  preset: "custom",
  version: "1.0.0",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
} as unknown as NavoriConfig;

const RETIRED = RETIRED_SKILLS[0] as string;

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-retired-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

/** Seed a skill at the directory path, with the marker navori stamps. */
function seedManaged(id: string, extra?: { sibling?: string }): string {
  const dir = join(cwd, ".claude/skills", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `<!-- navori:managed id="${id}" hash="deadbeef" version="${readCliVersion()}" source="@navori/core" -->\n` +
      `# ${id}\n` +
      `<!-- /navori:managed id="${id}" -->\n`,
    "utf-8",
  );
  if (extra?.sibling) writeFileSync(join(dir, extra.sibling), "del usuario\n", "utf-8");
  return dir;
}

describe("render — poda una skill retirada del catálogo (#702)", () => {
  it("borra el directorio entero cuando SKILL.md es su único hijo", () => {
    const dir = seedManaged(RETIRED);
    renderClaudeEngine(cwd, CONFIG);
    expect(existsSync(dir)).toBe(false);
  });

  it("también barre la forma FLAT heredada", () => {
    // Un repo onboardeado antes del cambio a directorio la tiene como `<id>.md`.
    const flat = join(cwd, ".claude/skills", `${RETIRED}.md`);
    mkdirSync(join(cwd, ".claude/skills"), { recursive: true });
    writeFileSync(
      flat,
      `<!-- navori:managed id="${RETIRED}" hash="deadbeef" version="${readCliVersion()}" source="@navori/core" -->\n# x\n<!-- /navori:managed id="${RETIRED}" -->\n`,
      "utf-8",
    );
    renderClaudeEngine(cwd, CONFIG);
    expect(existsSync(flat)).toBe(false);
  });

  it("respeta lo que el usuario dejó al lado: se va el SKILL.md, no el directorio", () => {
    const dir = seedManaged(RETIRED, { sibling: "notas.md" });
    renderClaudeEngine(cwd, CONFIG);
    expect(existsSync(join(dir, "SKILL.md"))).toBe(false);
    expect(readFileSync(join(dir, "notas.md"), "utf-8")).toBe("del usuario\n");
  });

  it("NO toca un SKILL.md sin marcador de navori", () => {
    // La regla que no se negocia: navori nunca borra lo que no puede probar que
    // escribió. Reclamar el id es suficiente para quedárselo.
    const dir = join(cwd, ".claude/skills", RETIRED);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "# la mía, escrita a mano\n", "utf-8");
    renderClaudeEngine(cwd, CONFIG);
    expect(readFileSync(join(dir, "SKILL.md"), "utf-8")).toBe("# la mía, escrita a mano\n");
  });

  it("NO la toca si el usuario reclamó el id como skill local", () => {
    const dir = seedManaged(RETIRED);
    renderClaudeEngine(cwd, {
      ...CONFIG,
      project: { localSkills: [RETIRED] },
    } as unknown as NavoriConfig);
    expect(existsSync(join(dir, "SKILL.md"))).toBe(true);
  });

  it("no borra nada cuando el repo nunca la tuvo", () => {
    const r = renderClaudeEngine(cwd, CONFIG);
    expect(r.written.some((w) => w.path.includes(RETIRED))).toBe(false);
  });
});

describe("RETIRED_SKILLS — el registro en sí", () => {
  it("no se solapa con lo que navori sí renderiza hoy", () => {
    // Un id en las dos listas sería un archivo que el render escribe y luego
    // borra en la misma pasada — o al revés, según el orden. La lista es
    // append-only, así que este es el único invariante que la sostiene.
    const active = new Set([...CORE_SKILLS, ...WORKFLOW_SKILLS]);
    const overlap = RETIRED_SKILLS.filter((id) => active.has(id));
    expect(overlap, `ids en RETIRED_SKILLS que el render sigue emitiendo: ${overlap}`).toEqual([]);
  });

  it("registra el retiro que motivó esto", () => {
    // Anti-falso-verde: con la lista vacía, toda la suite de arriba pasaría sin
    // ejercitar una sola línea del código nuevo.
    expect(RETIRED_SKILLS).toContain("pr-create");
  });
});
