import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getCoreRoot } from "../lib/render/bundled-assets.ts";
import { conditionOrchestration } from "../lib/render/render-plan.ts";
import { NavoriConfigSchema, type NavoriConfig } from "../lib/config/schema.ts";

/**
 * Spec 0019 — the orchestration block was trimmed to the routing ladder so it
 * fits the startup channel, and every trimmed section moved to the asset that
 * owns its moment. Two risks, one suite:
 *
 *   1. SILENT LOSS. The overlap with `orchestrator.md` was PARTIAL: several clauses
 *      existed only in the block (worktree reclaim, squash-merge ancestry,
 *      load-bearing re-verification, the 2-cycle cap). A naive "delete the
 *      duplicate" would have dropped them — R7 pins each one at its new home.
 *
 *   2. RE-DUPLICATION. The trim's point is that doctrine lives ONCE. A future
 *      edit that pastes a ladder section back into `orchestrator.md` (or a depth
 *      section back into the block) recreates the drift this spec removed —
 *      R11 pins the split in both directions.
 *
 * Marks are short verbatim phrases, chosen to be stable identifiers of each
 * clause rather than full sentences: a reword that keeps the clause keeps the
 * mark; deleting the clause deletes the mark and fails here, loudly.
 */

const CORE_ASSETS = resolve(getCoreRoot(), "core-assets");
const read = (rel: string): string => readFileSync(resolve(CORE_ASSETS, rel), "utf-8");

const BLOCK = "managed/orquestacion.md";
const ORCHESTRATOR = "agents/orchestrator.md";

describe("el bloque conserva la regla operativa (R4)", () => {
  const block = read(BLOCK);

  // Covers: R4
  //
  // Las marcas cambiaron con la retirada de la escalera: el bloque ya no
  // enumera rutas (R1 inline / R2 delegar) porque su umbral estaba escrito en
  // siete sitios que no coincidían. Lo que se fija ahora es la regla única y,
  // sobre todo, la distinción que la vuelve usable — delegar es sobre ESCRIBIR,
  // no sobre responder. Sin esa fila, "todo pasa por el harness" se lee como
  // "delega hasta para contestar una pregunta" y se ignora entera.
  it.each([
    ["el rol y la prohibición de delegar orchestrator", "NEVER delegate that role"],
    ["la regla única", "Every change to source goes through"],
    ["la distinción escribir vs responder", "Delegation is about WRITING, not about answering"],
    ["la tabla señal→mecanismo (#379)", "### How much analysis does this task deserve"],
    [
      "el párrafo de la pasada arquitectónica (#379)",
      "**The architectural pass — design before you decompose.**",
    ],
    ["la mecánica de un solo turno", "ALL `Agent` calls in a SINGLE turn"],
    ["la salida declarada", "### When delegation is genuinely impossible"],
  ])("conserva %s", (_piece, mark) => {
    expect(block).toContain(mark);
  });
});

describe("la escalera retirada no vuelve sola", () => {
  const block = read(BLOCK);

  // La retirada es deliberada y tiene condiciones de regreso escritas en
  // `orchestrator.md`: el gate probado bajo una sola ruta, y "archivo fuente no
  // trivial" existiendo UNA vez como código compartido en vez de como prosa
  // repetida en cinco sitios. Hasta entonces, un umbral que reaparezca en el
  // bloque recrea exactamente la ambigüedad que se quitó — y lo haría en
  // silencio, porque nada más lo mira.
  it.each([
    ["la fila de ruta inline", "R1 · Inline"],
    ["la fila de delegación por conteo", "R2 · Delegate"],
    ["el umbral de lectura", "4-file rule"],
    ["el umbral de escritura", "2+ non-trivial files"],
  ])("%s no reaparece en el bloque", (_piece, mark) => {
    expect(block, `la escalera volvió al bloque: "${mark}"`).not.toContain(mark);
  });

  it("orchestrator.md explica por qué se retiró y qué hace falta para reponerla", () => {
    const orchestrator = read(ORCHESTRATOR);
    expect(orchestrator).toContain("seven places that did not agree");
    expect(orchestrator).toContain("shared classifier");
  });
});

describe("spec 0019 — cada sección retirada vive en orchestrator.md (R7)", () => {
  const orchestrator = read(ORCHESTRATOR);

  // Covers: R7
  // Las cuatro primeras existían SOLO en el bloque (verificado por conteo al
  // escribir la spec): retirarlas sin injertarlas era pérdida, no mudanza.
  it.each([
    ["reclamo de worktree", "git worktree remove"],
    ["ancestría tras squash-merge", "squash merge leaves no ancestry"],
    ["re-verificación de load-bearing claims", "load-bearing claims"],
    ["cap de 2 ciclos CHANGES_REQUESTED", "2 `CHANGES_REQUESTED` cycles"],
    ["frugal delegation", "## Frugal delegation"],
    ["second opinion multi-provider", "a review from a **different provider**"],
  ])("%s está injertado", (_clause, mark) => {
    expect(orchestrator).toContain(mark);
  });
});

describe("spec 0019 — la profundidad es alcanzable y no se duplica (R9, R11)", () => {
  const block = read(BLOCK);
  const orchestrator = read(ORCHESTRATOR);

  it("el bloque nombra con ruta literal dónde vive la profundidad", () => {
    // Covers: R9
    expect(block).toContain(".claude/agents/orchestrator.md");
    expect(block).toContain(".claude/skills/resolve-ticket/SKILL.md");
    expect(block).toContain(".claude/skills/solution-design/SKILL.md");
  });

  it("la escalera no se repite en orchestrator.md", () => {
    // Covers: R11
    for (const mark of [
      "Delegation is about WRITING, not about answering",
      "### How much analysis does this task deserve",
      "### When delegation is genuinely impossible",
    ]) {
      expect(
        orchestrator,
        `la marca del núcleo "${mark}" reapareció en orchestrator.md`,
      ).not.toContain(mark);
    }
  });

  it("la profundidad no se repite en el bloque", () => {
    // Covers: R11
    for (const mark of [
      "## Frugal delegation",
      "git worktree remove",
      "squash merge leaves no ancestry",
      "a review from a **different provider**",
    ]) {
      expect(block, `la sección retirada "${mark}" volvió al bloque`).not.toContain(mark);
    }
  });
});

/**
 * Spec 0026 T20 (R49, R50) — the architectural pass names its proposer
 * conditionally on `harness.architect`, independently of the challenger
 * (`harness.auditor`, spec 0019/0026's existing branch), and the verdict is
 * always the orchestrator's regardless of either.
 */
describe("architectural pass with and without architect (spec 0026 T20, R49/R50)", () => {
  const rawBlock = read(BLOCK);

  function config(overrides: { architect?: boolean; auditor?: boolean }): NavoriConfig {
    return NavoriConfigSchema.parse({
      name: "doctrina-demo",
      engines: ["claude"],
      preset: "custom",
      harness: overrides,
    });
  }

  // Covers: R49
  it("proposes via `architect` when harness.architect is enabled", () => {
    const resolved = conditionOrchestration(rawBlock, config({ architect: true, auditor: true }));
    expect(resolved).toContain("`architect` applies `solution-design` and writes");
    expect(resolved).not.toContain("`solution-design` skill, applied by you");
    // The challenge and the verdict stay as documented regardless of the proposer.
    expect(resolved).toMatch(/an `auditor`, not a new agent/);
    expect(resolved).toContain("READY / CONCERNS / BLOCKED — always yours");
  });

  // Covers: R50
  it("IF harness.architect is false, keeps the spec 0012 flow (you apply the skill)", () => {
    const resolved = conditionOrchestration(rawBlock, config({ architect: false, auditor: true }));
    expect(resolved).toContain("`solution-design` skill, applied by you");
    expect(resolved).not.toContain("`architect` applies `solution-design`");
    // R50 keeps the challenge in `auditor` — unaffected by the proposer switch.
    expect(resolved).toMatch(/an `auditor`, not a new agent/);
  });

  it("the verdict is always the orchestrator's, independent of both switches", () => {
    for (const architect of [true, false]) {
      for (const auditor of [true, false]) {
        const resolved = conditionOrchestration(rawBlock, config({ architect, auditor }));
        expect(resolved).toContain("READY / CONCERNS / BLOCKED — always yours");
      }
    }
  });
});

describe("spec 0019 — la detección del cross-review no se auto-cumple", () => {
  it("orchestrator.md no nombra el id del sub-bloque que navori le inyecta", () => {
    // Covers: R7
    // La doctrina enseñaba a detectar la opción con
    // `grep -n codex-cross-review .claude/agents/orchestrator.md`. Al mudar ese
    // párrafo DENTRO de orchestrator.md, el grep pasaría a acertar siempre: el
    // agente concluiría que hay cross-review en un repo que solo renderiza
    // Claude. `render-engine.test.ts` usa el mismo token como prueba de que el
    // sub-bloque está ausente, así que la prosa no puede contenerlo.
    expect(read(ORCHESTRATOR)).not.toContain("codex-cross-review");
  });
});
