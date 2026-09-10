import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listKnownPluginIds } from "../../../lib/plugins.ts";
import { NavoriConfigSchema, type NavoriConfig } from "../../../lib/schema.ts";
import { renderClaudeEngine } from "../index.ts";

/**
 * Spec 0020 (R4) — el `CLAUDE.md` renderizado tiene un presupuesto, y el
 * presupuesto es del host, no una preferencia de este repo.
 *
 * La doc de Claude Code lo dice de frente, en "Manage Claude's memory":
 *
 *   "Target under 200 lines per CLAUDE.md file. Longer files consume more
 *    context and reduce adherence."
 *
 * O sea que un `CLAUDE.md` largo no solo cuesta tokens: **baja la obediencia a
 * lo que está escrito en él**. Un harness cuya doctrina vive ahí paga el peor
 * intercambio posible — más prosa, menos cumplimiento. El día que se midió,
 * este repo rendereaba 278 líneas.
 *
 * Lo que fija esta suite es el CONTRATO, no aquella medición:
 *
 *   1. Lo que navori ENVÍA cabe bajo el umbral del host.
 *   2. Cuando no cabe, el fallo dice dónde cortar — sin eso, el siguiente que
 *      lo rompa solo sabe que rompió algo.
 *
 * Se mide sobre el render y no sobre los assets sueltos porque el archivo que
 * el modelo lee es el renderizado: los placeholders expanden, los plugins
 * agregan bloques y el orden lo pone el motor. Un asset chico puede rendear
 * grande.
 *
 * Se mide con TODOS los plugins conocidos habilitados a propósito: es la
 * superficie más pesada que navori puede producir, así que si cabe ahí cabe en
 * cualquier configuración real. La sección del usuario queda fuera de la cuenta
 * porque no es de navori — el presupuesto que este test defiende es el de lo
 * que el paquete envía.
 */

/** El umbral que declara la doc del host ("Target under 200 lines per
 *  CLAUDE.md file"). Es un dato de la plataforma, no una meta interna: subirlo
 *  no compra adherencia, la gasta. */
const LINE_BUDGET = 200;

function config(): NavoriConfig {
  const plugins = Object.fromEntries(listKnownPluginIds().map((id) => [id, { enabled: true }]));
  return NavoriConfigSchema.parse({
    name: "budget-demo",
    engines: ["claude"],
    preset: "custom",
    branchBase: "main",
    qualityGate: { fast: "npm run lint", full: "npm test" },
    plugins,
  });
}

/** El `CLAUDE.md` tal como lo recibe un repo recién renderizado. */
function renderedClaudeMd(): string {
  const cwd = mkdtempSync(join(tmpdir(), "navori-mdbudget-"));
  try {
    renderClaudeEngine(cwd, config());
    return readFileSync(join(cwd, "CLAUDE.md"), "utf-8");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** Cuenta líneas como `wc -l`: el salto final no abre una línea nueva. */
function countLines(text: string): number {
  const raw = text.split("\n");
  if (raw.at(-1) === "") raw.pop();
  return raw.length;
}

/** Peso en líneas de cada bloque managed, marcadores incluidos — que es lo que
 *  cuesta el bloque en el archivo real. */
function blockSizes(md: string): Array<{ id: string; lines: number }> {
  const sizes: Array<{ id: string; lines: number }> = [];
  let open: { id: string; start: number } | null = null;
  md.split("\n").forEach((line, index) => {
    const start = /<!-- navori:managed id="([^"]+)"/.exec(line);
    if (start?.[1]) {
      open = { id: start[1], start: index };
      return;
    }
    const end = /<!-- \/navori:managed id="([^"]+)"/.exec(line);
    if (end && open) {
      sizes.push({ id: open.id, lines: index - open.start + 1 });
      open = null;
    }
  });
  return sizes.sort((a, b) => b.lines - a.lines);
}

/** El mensaje que ve quien rompa el presupuesto. Nombra el exceso y los tres
 *  bloques más pesados: sin eso el fallo dice "creció" y no "cortá aquí". */
function overBudgetMessage(md: string, budget: number): string {
  const total = countLines(md);
  const heaviest = blockSizes(md)
    .slice(0, 3)
    .map((b) => `${b.id} (${b.lines})`)
    .join(", ");
  return (
    `el CLAUDE.md renderizado mide ${total} líneas y el presupuesto del host es ${budget}: ` +
    `sobran ${total - budget}. Los tres bloques más pesados son ${heaviest}. ` +
    "Mové la profundidad (tablas largas, justificaciones, mediciones) a la skill que ya " +
    "cubre el tema y dejá en el bloque la regla accionable más el puntero: el cuerpo de una " +
    "skill solo carga cuando se usa, así que ahí no cuesta contexto."
  );
}

describe("spec 0020 — el CLAUDE.md renderizado cabe en el presupuesto del host", () => {
  it("el render cabe en el presupuesto de adherencia", () => {
    // Covers: R4
    const md = renderedClaudeMd();
    expect(countLines(md), overBudgetMessage(md, LINE_BUDGET)).toBeLessThan(LINE_BUDGET);
  });

  it("nombra los bloques más pesados al fallar", () => {
    // Covers: R4
    // El diagnóstico es la mitad útil del presupuesto: un fallo que solo dice
    // "creció" deja al siguiente buscando a ciegas en doce bloques. Se ejercita
    // con un presupuesto imposible para que el mensaje se pruebe siempre, no
    // solo el día que el render se pase.
    const md = renderedClaudeMd();
    const message = overBudgetMessage(md, 10);
    const heaviest = blockSizes(md);
    expect(heaviest.length).toBeGreaterThanOrEqual(3);

    expect(message).toContain(`sobran ${countLines(md) - 10}`);
    for (const block of heaviest.slice(0, 3)) {
      expect(message, `el fallo no nombra '${block.id}', uno de los tres más pesados`).toContain(
        `${block.id} (${block.lines})`,
      );
    }
    // El cuarto no: nombrar todo es no nombrar ninguno.
    const fourth = heaviest[3];
    if (fourth) expect(message).not.toContain(`${fourth.id} (`);
  });
});
