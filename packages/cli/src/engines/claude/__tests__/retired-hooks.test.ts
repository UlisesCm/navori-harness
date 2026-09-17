import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renderClaudeEngine } from "../index.ts";
import { RETIRED_HOOKS } from "../../shared/harness-assets.ts";
import { getCoreRoot, readCliVersion } from "../../../lib/bundled-assets.ts";
import type { NavoriConfig } from "../../../lib/config.ts";

/**
 * A hook navori retires must leave the repos it was already rendered into
 * (#774), on the same terms `retired-skills.test.ts` pins for skills.
 *
 * The park was 22 repos when `precompact-session-summary` was withdrawn, and
 * nothing in the product could have removed it from any of them: `render` only
 * visits what it CURRENTLY renders, and `--prune` answers a different question
 * (outputs of a DISABLED engine). A leftover hook script is quieter than a
 * leftover skill — an unregistered script is never invoked — but it still
 * carries a managed marker that `doctor` and the drift watcher have to account
 * for, and a reader who finds it on disk cannot tell a retirement from a broken
 * registration.
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

const RETIRED = RETIRED_HOOKS[0]!.id;

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-retired-hook-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

/** The path a previous navori rendered the hook to. */
function hookPath(id: string): string {
  return join(cwd, ".claude/hooks", `${id}.sh`);
}

/** Seed the hook with the managed marker navori stamps (`<id>-base`). */
function seedManaged(id: string, version = readCliVersion()): string {
  const path = hookPath(id);
  mkdirSync(join(cwd, ".claude/hooks"), { recursive: true });
  writeFileSync(
    path,
    `# navori:managed start id="${id}-base" hash="deadbeef" version="${version}" source="@navori/core"\n` +
      `#!/usr/bin/env bash\nexit 0\n` +
      `# navori:managed end id="${id}-base"\n`,
    "utf-8",
  );
  return path;
}

describe("render — poda un hook retirado (#774)", () => {
  it("borra el script que navori escribió", () => {
    const path = seedManaged(RETIRED);
    renderClaudeEngine(cwd, CONFIG);
    expect(existsSync(path)).toBe(false);
  });

  it("lo reporta como escritura del render, no como poda opcional", () => {
    // El borrado sale del `render` de siempre, sin `--prune`: ese flag responde
    // otra pregunta (salidas de un engine deshabilitado) y este archivo
    // pertenece a un engine bien vivo. Si dependiera del flag se quedaría en
    // disco en los 22 repos del parque.
    seedManaged(RETIRED);
    const r = renderClaudeEngine(cwd, CONFIG);
    expect(r.written.some((w) => w.path.includes(RETIRED))).toBe(true);
  });

  it("NO toca un script sin el marcador de navori", () => {
    // La regla que no se negocia: navori nunca borra lo que no puede probar que
    // escribió. Reclamar la ruta es suficiente para quedársela.
    const path = hookPath(RETIRED);
    mkdirSync(join(cwd, ".claude/hooks"), { recursive: true });
    writeFileSync(path, "#!/usr/bin/env bash\n# el mío, escrito a mano\n", "utf-8");
    renderClaudeEngine(cwd, CONFIG);
    expect(readFileSync(path, "utf-8")).toContain("escrito a mano");
  });

  // Covers: R39, R41
  it("un hook ajeno se conserva y se reporta con su motivo", () => {
    const path = hookPath(RETIRED);
    mkdirSync(join(cwd, ".claude/hooks"), { recursive: true });
    writeFileSync(path, "#!/usr/bin/env bash\n# el mío, escrito a mano\n", "utf-8");
    const r = renderClaudeEngine(cwd, CONFIG);
    expect(r.warnings.some((w) => w.includes("foreign") && w.includes(RETIRED))).toBe(true);
  });

  it("NO borra el que escribió un navori más nuevo (anti-rollback)", () => {
    const path = seedManaged(RETIRED, "99.0.0");
    renderClaudeEngine(cwd, CONFIG);
    expect(existsSync(path)).toBe(true);
  });

  // Covers: R39, R41
  it("un hook de un navori más nuevo se conserva y se reporta con su motivo", () => {
    seedManaged(RETIRED, "99.0.0");
    const r = renderClaudeEngine(cwd, CONFIG);
    expect(r.warnings.some((w) => w.includes("newer") && w.includes(RETIRED))).toBe(true);
  });

  it("no reporta nada cuando el repo nunca lo tuvo", () => {
    const r = renderClaudeEngine(cwd, CONFIG);
    expect(r.written.some((w) => w.path.includes(RETIRED))).toBe(false);
  });
});

describe("RETIRED_HOOKS — el registro en sí", () => {
  it("no se solapa con los assets que navori sigue enviando", () => {
    // Un id retirado que todavía tuviera asset sería un archivo que el render
    // escribe y luego borra en la misma pasada. La lista es append-only, así que
    // este es el único invariante que la sostiene — y se comprueba contra el
    // árbol de assets, no contra una segunda lista que podría derivar.
    const shipped = new Set(
      readdirSync(resolve(getCoreRoot(), "core-assets", "hooks"))
        .filter((f) => f.endsWith(".sh"))
        .map((f) => f.slice(0, -".sh".length)),
    );
    const overlap = RETIRED_HOOKS.filter((retired) => shipped.has(retired.id));
    expect(
      overlap,
      `ids en RETIRED_HOOKS cuyo asset navori sigue enviando: ${overlap.map((r) => r.id)}`,
    ).toEqual([]);
  });

  it("registra el retiro que motivó esto", () => {
    // Anti-falso-verde: con la lista vacía, toda la suite de arriba pasaría sin
    // ejercitar una sola línea del código nuevo.
    expect(RETIRED_HOOKS.map((r) => r.id)).toContain("precompact-session-summary");
  });

  // Covers: R38
  it("carga el marcador `<id>-base` real, compartido por los dos adapters", () => {
    const retired = RETIRED_HOOKS.find((r) => r.id === "precompact-session-summary");
    expect(retired?.markerIdByAdapter.claude).toBe("precompact-session-summary-base");
    expect(retired?.markerIdByAdapter.codex).toBe("precompact-session-summary-base");
  });
});
