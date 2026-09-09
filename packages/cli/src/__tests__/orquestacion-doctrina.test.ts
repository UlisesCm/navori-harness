import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getCoreRoot } from "../lib/bundled-assets.ts";

/**
 * Spec 0019 — the orchestration block was trimmed to the routing ladder so it
 * fits the startup channel, and every trimmed section moved to the asset that
 * owns its moment. Two risks, one suite:
 *
 *   1. SILENT LOSS. The overlap with `leader.md` was PARTIAL: several clauses
 *      existed only in the block (worktree reclaim, squash-merge ancestry,
 *      load-bearing re-verification, the 2-cycle cap). A naive "delete the
 *      duplicate" would have dropped them — R7 pins each one at its new home.
 *
 *   2. RE-DUPLICATION. The trim's point is that doctrine lives ONCE. A future
 *      edit that pastes a ladder section back into `leader.md` (or a depth
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
const LEADER = "agents/leader.md";

describe("spec 0019 — el bloque conserva la escalera (R4)", () => {
  const block = read(BLOCK);

  // Covers: R4
  it.each([
    ["el rol y la prohibición de delegar leader", "NEVER delegate it"],
    ["la tabla de rutas", "R2-fan · Analytical fan-out"],
    ["la tabla señal→mecanismo (#379)", "### How much analysis does this task deserve"],
    ["el párrafo R2-architectural (#379)", "**R2-architectural — design before you decompose.**"],
    ["los umbrales de escalamiento", "4-file rule"],
    ["la mecánica de un solo turno", "ALL `Agent` calls in a SINGLE turn"],
  ])("conserva %s", (_piece, mark) => {
    expect(block).toContain(mark);
  });
});

describe("spec 0019 — cada sección retirada vive en leader.md (R7)", () => {
  const leader = read(LEADER);

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
    expect(leader).toContain(mark);
  });
});

describe("spec 0019 — la profundidad es alcanzable y no se duplica (R9, R11)", () => {
  const block = read(BLOCK);
  const leader = read(LEADER);

  it("el bloque nombra con ruta literal dónde vive la profundidad", () => {
    // Covers: R9
    expect(block).toContain(".claude/agents/leader.md");
    expect(block).toContain(".claude/skills/ticket-intake/SKILL.md");
    expect(block).toContain(".claude/skills/solution-design/SKILL.md");
  });

  it("la escalera no se repite en leader.md", () => {
    // Covers: R11
    for (const mark of [
      "R2-fan · Analytical fan-out",
      "### How much analysis does this task deserve",
      "4-file rule",
    ]) {
      expect(leader, `la marca del núcleo "${mark}" reapareció en leader.md`).not.toContain(mark);
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

describe("spec 0019 — la detección del cross-review no se auto-cumple", () => {
  it("leader.md no nombra el id del sub-bloque que navori le inyecta", () => {
    // Covers: R7
    // La doctrina enseñaba a detectar la opción con
    // `grep -n codex-cross-review .claude/agents/leader.md`. Al mudar ese
    // párrafo DENTRO de leader.md, el grep pasaría a acertar siempre: el
    // agente concluiría que hay cross-review en un repo que solo renderiza
    // Claude. `render-engine.test.ts` usa el mismo token como prueba de que el
    // sub-bloque está ausente, así que la prosa no puede contenerlo.
    expect(read(LEADER)).not.toContain("codex-cross-review");
  });
});
