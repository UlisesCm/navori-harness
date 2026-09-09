import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { NavoriConfigSchema, type NavoriConfig } from "../../../lib/schema.ts";
import { renderClaudeEngine } from "../index.ts";

/**
 * #623 — el hook `SessionStart` emitía por un conducto que no entrega lo que le
 * cabe.
 *
 * `additionalContext` NO se entrega entero: pasado un límite del host, Claude
 * Code le da al modelo un preview de los primeros ~2 KB y persiste el resto en
 * un archivo que el modelo nunca abre. Sin warning, y con exit 0 en los dos
 * casos — así que falla en silencio y se ve igual que un éxito.
 *
 * Medido en 40+ sesiones reales: el hook emitía 20–48 KB y el bloque
 * `Role: orchestrator` caía en el byte 4,511–33,129. No llegó a UNA sola
 * sesión. La escalera de ruteo que decide cuándo delegar no existía para el
 * agente, en ningún repo, desde que la spec 0015 la movió a este canal.
 *
 * Esta suite fija el CONTRATO, no aquel incidente:
 *
 *   1. Lo que el hook emite cabe en el presupuesto de entrega.
 *   2. Nada se cae en silencio: lo que no entra inline sale como puntero al
 *      archivo, que el agente sí puede leer.
 *   3. La doctrina va PRIMERO. Lo que el host corte tiene que ser lo
 *      reconstruible (`cat progress/current.md`), nunca lo que solo llega aquí.
 *
 * Un test y no una nota en el CLAUDE.md a propósito: el defecto sobrevivió a una
 * verificación humana que lo declaró inexistente, porque se grepeó el archivo
 * persistido — exactamente los bytes que NO llegan. Una regla que depende de que
 * alguien recuerde verificarla del lado correcto es una regla sin mecanismo.
 */

/** El presupuesto que declara el hook. Por debajo del truncado más chico
 *  observado en campo (10,441 bytes), que es un dato, no una estimación. */
const BUDGET = 8000;

/** Lo que el hook puede emitir en TOTAL. El presupuesto gobierna la olla de
 *  secciones bounded; los punteros que las reemplazan y la línea de rama se
 *  emiten SIEMPRE (nada desaparece en silencio — contrato 2), así que el total
 *  puede exceder la olla por ese margen fijo. 8,800 caracteres quedan ≥1,200
 *  bytes por debajo del corte observado incluso contando acentos UTF-8.
 *  Antes de la spec 0019 esta distinción no se veía: la olla nunca se llenaba,
 *  y el total quedaba bajo 8,000 por accidente, no por contrato. */
const DELIVERY_CEILING = BUDGET + 800;

function config(): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "budget-demo",
    engines: ["claude"],
    preset: "custom",
    branchBase: "main",
    qualityGate: { fast: "npm run lint", full: "npm test" },
  });
}

/** Repo renderizado con un `progress/current.md` del tamaño que tiene en campo.
 *  Se inicializa git porque la rama y los commits son parte de lo que el hook
 *  emite: sin repo, el test mediría un contexto más chico que el real. */
function renderedRepo(resumeBytes: number): string {
  const cwd = mkdtempSync(join(tmpdir(), "navori-budget-"));
  execFileSync("git", ["init", "-q", "."], { cwd, stdio: "ignore" });
  writeFileSync(join(cwd, "README.md"), "# budget demo\n");
  execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "inicial", "--allow-empty"],
    { cwd, stdio: "ignore" },
  );
  renderClaudeEngine(cwd, config());
  mkdirSync(join(cwd, "progress"), { recursive: true });
  writeFileSync(
    join(cwd, "progress", "current.md"),
    `# Sesión actual\n\n${"estado de la jornada anterior. ".repeat(Math.ceil(resumeBytes / 30))}`,
  );
  return cwd;
}

function runHook(cwd: string): string {
  const out = execFileSync("bash", [join(cwd, ".claude/hooks/session-start-context.sh")], {
    cwd,
    input: "{}",
    encoding: "utf-8",
    timeout: 20_000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (!out.trim()) return "";
  return (
    (JSON.parse(out) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput
      ?.additionalContext ?? ""
  );
}

describe("#623 — el contexto de arranque cabe en lo que el host entrega", () => {
  it("no rebasa el presupuesto ni con un resume del tamaño que tiene en campo", () => {
    // 4,596 bytes es el tamaño real de `progress/current.md` en navori-harness
    // el día que se encontró el defecto. Antes de #623 este caso emitía ~24 KB.
    const ctx = runHook(renderedRepo(4600));
    expect(ctx.length).toBeGreaterThan(0);
    expect(ctx.length).toBeLessThanOrEqual(DELIVERY_CEILING);
  });

  it("sigue cabiendo cuando el resume crece sin control", () => {
    // Un `progress/current.md` de 60 KB: el modo en que esto se rompió la
    // primera vez fue creciendo, no de golpe.
    const ctx = runHook(renderedRepo(60_000));
    expect(ctx.length).toBeLessThanOrEqual(DELIVERY_CEILING);
  });

  it("emite la doctrina ANTES que el estado volátil", () => {
    const ctx = runHook(renderedRepo(4600));
    const doctrine = ctx.indexOf("navori:managed id=");
    const branch = ctx.indexOf("Branch:");
    expect(doctrine).toBeGreaterThanOrEqual(0);
    expect(branch).toBeGreaterThanOrEqual(0);
    expect(doctrine).toBeLessThan(branch);
  });

  it("cada bloque de contexto llega inline o como puntero — ninguno desaparece", () => {
    const cwd = renderedRepo(4600);
    const ctx = runHook(cwd);
    const blocks = readdirSync(join(cwd, ".claude/context")).filter((f) => f.endsWith(".md"));
    expect(blocks.length).toBeGreaterThan(0);

    for (const file of blocks) {
      // `10-orquestacion.md` carries its delivery order in the name (spec 0019);
      // the managed id inside the file stays unprefixed.
      const id = file.replace(/^\d+-/, "").replace(/\.md$/, "");
      const inline = ctx.includes(`navori:managed id="${id}"`);
      const pointed = ctx.includes(`.claude/context/${file}`);
      expect(inline || pointed, `'${file}' no llegó ni inline ni como puntero`).toBe(true);
    }
  });

  it("el puntero nombra el archivo y pide leerlo — no es un aviso decorativo", () => {
    const cwd = renderedRepo(4600);
    const ctx = runHook(cwd);
    // El bloque de orquestación (12 KB) no cabe inline por diseño hasta que
    // encoja; lo que NO puede pasar es que se pierda sin dejar cómo llegar a él.
    const orchestration = readdirSync(join(cwd, ".claude/context")).find((f) =>
      readFileSync(join(cwd, ".claude/context", f), "utf-8").includes("Role: orchestrator"),
    );
    expect(orchestration).toBeDefined();
    const orchestrationId = orchestration!.replace(/^\d+-/, "").replace(/\.md$/, "");
    if (!ctx.includes(`navori:managed id="${orchestrationId}"`)) {
      const pointer = ctx.split("\n").find((l) => l.includes(orchestration!));
      expect(pointer).toBeDefined();
      expect(pointer).toMatch(/Read|Léelo|LÉELO/);
    }
  });
});

describe("spec 0019 — la escalera llega, no solo cabe", () => {
  /** Techo del bloque renderizado (R3). Deja sitio para el catálogo de agentes
   *  detrás (~1,1 KB) dentro del BUDGET; la fuente mide menos — los
   *  placeholders expanden, así que el techo se afirma sobre lo renderizado. */
  const CEILING = 6500;

  it("el bloque de orquestación renderizado cabe bajo su techo", () => {
    // Covers: R3, R6
    const cwd = renderedRepo(4600);
    const dir = join(cwd, ".claude/context");
    const file = readdirSync(dir).find((f) => f.endsWith("-orquestacion.md"));
    expect(file, "el render ya no emite el bloque de orquestación").toBeDefined();
    const size = readFileSync(join(dir, file!), "utf-8").length;
    expect(
      size,
      `el bloque renderizado mide ${size} caracteres y el techo es ${CEILING}: ` +
        "por encima vuelve a degradar a puntero en el arranque (la regresión de #623). " +
        "Recorta el asset o muda la sección nueva a su dueño (leader.md / la skill del momento).",
    ).toBeLessThanOrEqual(CEILING);
  });

  it("los nombres de archivo llevan el orden de entrega: la escalera primero", () => {
    // Covers: R1
    // El hook lee el directorio con un glob alfabético; sin prefijo, la
    // orquestación quedaba SIEMPRE al final por empezar con "o" — y con el
    // canal sobre-suscrito, siempre en puntero.
    const cwd = renderedRepo(4600);
    const blocks = readdirSync(join(cwd, ".claude/context"))
      .filter((f) => f.endsWith(".md"))
      .sort();
    expect(blocks[0]).toBe("10-orquestacion.md");
    expect(blocks).toContain("20-agentes-disponibles.md");
  });

  it("re-renderizar retira el nombre viejo: nunca dos copias del mismo bloque", () => {
    // Covers: R2, R10
    const cwd = renderedRepo(4600);
    const dir = join(cwd, ".claude/context");
    // Simula un repo renderizado por un navori pre-0019: el mismo bloque, bajo
    // el nombre sin prefijo.
    const prefixed = readFileSync(join(dir, "10-orquestacion.md"), "utf-8");
    writeFileSync(join(dir, "orquestacion.md"), prefixed);
    renderClaudeEngine(cwd, config());
    const files = readdirSync(dir).filter((f) => f.endsWith("orquestacion.md"));
    expect(files, "el gemelo sin prefijo debe retirarse en el mismo apply").toEqual([
      "10-orquestacion.md",
    ]);
    // El id managed no cambia con el prefijo (R10): doctor/sync siguen viéndolo.
    expect(prefixed).toContain('navori:managed id="orquestacion"');
  });

  it("la escalera y el catálogo llegan como cuerpo; el cierre degrada a puntero", () => {
    // Covers: R5
    // Caber y llegar son cosas distintas: #623 se declaró inexistente por
    // confundirlas. Esto corre el hook de verdad y mira qué salió.
    const ctx = runHook(renderedRepo(5000));
    expect(ctx, "la escalera de ruteo no llegó como cuerpo").toContain(
      'navori:managed id="orquestacion"',
    );
    expect(ctx, "el catálogo de agentes no llegó como cuerpo").toContain(
      'navori:managed id="agentes-disponibles"',
    );
    // El primero en degradar es el cierre: sus ceremonias aplican horas después
    // del arranque y un puntero leído a tiempo las cubre.
    expect(ctx).not.toContain('navori:managed id="cierre-sesion"');
    expect(ctx, "cierre-sesion degradó pero sin puntero — se perdió").toContain(
      "40-cierre-sesion.md",
    );
  });
});
