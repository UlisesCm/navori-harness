import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfig } from "../../lib/config.ts";
import { runRender } from "../render.ts";

/**
 * Spec 0018 — a workspace only gets the harness the engine can actually reach.
 *
 * `render` used to write a full `.claude/` into every workspace. Measured on the
 * two field monorepos: 29 of 35 files per workspace are byte-identical to the
 * root's, and most sit in directories Claude Code never reads from a session
 * started at the repo root — which is 100% of the sessions on record.
 *
 * What it can and cannot reach, from the root:
 *   - `CLAUDE.md`        → yes, nested ones load on touching the directory
 *   - `.claude/skills/`  → yes, lazily, on first read/edit in the subdirectory
 *   - `.claude/agents/`  → NO: subagents are discovered walking UP from the cwd
 *   - `hooks/`+`scripts/`→ NO: hooks register as `$CLAUDE_PROJECT_DIR/…` (root)
 *   - `settings.json`    → NO: the precedence table has no nested level
 *   - `.mcp.json`        → NO: project-scoped, read at the root
 *   - `context/`         → NO: nothing references it
 *
 * The proof that closed the case is on disk, not in the docs: `managed-drift-watch`
 * writes a stamp on every PostToolUse, and both monorepos carry exactly ONE
 * stamp — the root's — after months of use.
 */

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-ws-harness-"));
  mkdirSync(join(cwd, "apps/backend"), { recursive: true });
  mkdirSync(join(cwd, "apps/storefront"), { recursive: true });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

/** A two-workspace monorepo. `harness` omitted → the schema default applies. */
function writeMonorepoConfig(harness?: "minimal" | "full"): void {
  writeConfig(join(cwd, "navori.config.json"), {
    name: "ws-harness-demo",
    engines: ["claude"],
    preset: "monorepo-turbopnpm",
    qualityGate: { fast: "pnpm -w lint", full: "pnpm -w test" },
    monorepo: {
      enabled: true,
      tool: "turbo",
      workspaces: [
        { name: "backend", path: "apps/backend" },
        { name: "storefront", path: "apps/storefront" },
      ],
      ...(harness === undefined ? {} : { workspaceHarness: harness }),
    },
  });
}

/** The six pieces `minimal` drops, as paths relative to a workspace. */
const UNREACHABLE = [
  ".claude/agents",
  ".claude/hooks",
  ".claude/scripts",
  ".claude/context",
  ".claude/settings.json",
  ".mcp.json",
] as const;

/** Whether the ROOT render produced this piece — the yardstick for the workspace. */
const rootHas = (piece: string): boolean => existsSync(join(cwd, piece));

describe("render por workspace — `minimal` escribe solo lo alcanzable (spec 0018)", () => {
  it("bajo el default, el workspace recibe CLAUDE.md y skills, y nada más", () => {
    // Covers: R2
    writeMonorepoConfig(); // sin declarar nada: el default del schema es `minimal`
    expect(runRender(cwd).ok).toBe(true);

    for (const ws of ["apps/backend", "apps/storefront"]) {
      expect(existsSync(join(cwd, ws, "CLAUDE.md")), `${ws}/CLAUDE.md`).toBe(true);
      expect(existsSync(join(cwd, ws, ".claude/skills")), `${ws}/.claude/skills`).toBe(true);
      for (const piece of UNREACHABLE) {
        expect(existsSync(join(cwd, ws, piece)), `${ws}/${piece} no debería existir`).toBe(false);
      }
    }
    // Anti-vacuidad: si la raíz tampoco tuviera estas piezas, el bloque de
    // arriba pasaría sin probar nada. Este fixture no habilita plugins con
    // scripts, así que `scripts/` se comprueba donde sí existe.
    expect(rootHas(".claude/agents")).toBe(true);
    expect(rootHas(".claude/hooks")).toBe(true);
    expect(rootHas(".claude/context")).toBe(true);
    expect(rootHas(".claude/settings.json")).toBe(true);
  });

  it("la RAÍZ conserva las seis piezas: el recorte es solo del workspace", () => {
    // Covers: R2
    // El fallo que este caso ataja es el peor posible de esta spec: recortar la
    // raíz deja el repo entero sin agentes, hooks ni settings.
    writeMonorepoConfig();
    expect(runRender(cwd).ok).toBe(true);

    expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(true);
    for (const piece of [
      ".claude/agents",
      ".claude/hooks",
      ".claude/context",
      ".claude/settings.json",
    ]) {
      expect(rootHas(piece), `la raíz perdió ${piece}`).toBe(true);
    }
  });

  it("bajo `full` el workspace recibe todo, como antes", () => {
    // Covers: R3
    // La salida para quien sí hace `cd apps/api && claude`: ahí esos archivos SÍ
    // se activan, y navori tiene más usuarios que el parque medido.
    writeMonorepoConfig("full");
    expect(runRender(cwd).ok).toBe(true);

    for (const ws of ["apps/backend", "apps/storefront"]) {
      expect(existsSync(join(cwd, ws, "CLAUDE.md"))).toBe(true);
      expect(existsSync(join(cwd, ws, ".claude/skills"))).toBe(true);
      // Cada pieza que la raíz tiene, el workspace la tiene también bajo `full`.
      for (const piece of UNREACHABLE) {
        if (!rootHas(piece)) continue;
        expect(existsSync(join(cwd, ws, piece)), `${ws}/${piece} falta bajo full`).toBe(true);
      }
    }
  });

  it("migrar de `full` a `minimal` borra lo de navori y CONSERVA lo ajeno", () => {
    // Covers: R4, R5
    // El caso de campo: un repo ya renderizado por un navori anterior tiene los
    // archivos en disco y, donde el harness se versiona, commiteados.
    writeMonorepoConfig("full");
    expect(runRender(cwd).ok).toBe(true);
    const ws = join(cwd, "apps/backend");
    expect(existsSync(join(ws, ".claude/agents/reviewer.md"))).toBe(true);

    // Un archivo que el usuario puso ahí a mano, sin marca de navori.
    writeFileSync(join(ws, ".claude/agents/mio.md"), "# mi agente propio\n");

    writeMonorepoConfig("minimal");
    const result = runRender(cwd);
    expect(result.ok).toBe(true);

    const backend = result.workspaces.find((w) => w.workspaceName === "backend");
    expect(backend).toBeDefined();
    // Lo de navori se fue…
    expect(existsSync(join(ws, ".claude/agents/reviewer.md"))).toBe(false);
    expect(backend?.trimmed.some((r) => r.endsWith("reviewer.md"))).toBe(true);
    // …y lo del usuario sobrevive Y se reporta, que es la única señal de que
    // algo en esos directorios no era de navori.
    expect(existsSync(join(ws, ".claude/agents/mio.md"))).toBe(true);
    expect(backend?.trimmedKept.some((k) => k.path.endsWith("mio.md"))).toBe(true);
  });

  it("`full` no borra nada: el recorte es solo de `minimal`", () => {
    // Covers: R4
    writeMonorepoConfig("full");
    expect(runRender(cwd).ok).toBe(true);
    const second = runRender(cwd);
    for (const ws of second.workspaces) {
      expect(ws.trimmed, `${ws.workspaceName} borró bajo full`).toEqual([]);
    }
    expect(existsSync(join(cwd, "apps/backend/.claude/agents"))).toBe(true);
  });

  it("el CLAUDE.md del workspace dice que hereda de la raíz — solo bajo `minimal`", () => {
    // Covers: R7
    // Sin esta cláusula, quien abra `apps/backend/` ve un `.claude/` con solo
    // `skills/`, lo lee como harness a medio instalar, y copia los archivos de
    // la raíz de vuelta — recreando justo lo que el recorte quitó.
    writeMonorepoConfig();
    expect(runRender(cwd).ok).toBe(true);
    const ws = readFileSync(join(cwd, "apps/backend/CLAUDE.md"), "utf-8");
    expect(ws).toMatch(/agentes, los hooks y los permisos son los de la raíz/i);
    expect(ws).toMatch(/no falta nada/i);

    // La raíz nunca la lleva: ahí no se hereda nada.
    expect(readFileSync(join(cwd, "CLAUDE.md"), "utf-8")).not.toMatch(/no falta nada/i);
  });

  it("bajo `full` el workspace NO lleva la cláusula: no hereda, tiene lo suyo", () => {
    // Covers: R7
    writeMonorepoConfig("full");
    expect(runRender(cwd).ok).toBe(true);
    const ws = readFileSync(join(cwd, "apps/backend/CLAUDE.md"), "utf-8");
    expect(ws).not.toMatch(/no falta nada/i);
  });

  it("es idempotente: un segundo render bajo `minimal` no reporta cambios", () => {
    // Covers: R2
    writeMonorepoConfig();
    expect(runRender(cwd).ok).toBe(true);
    const second = runRender(cwd);
    expect(second.ok).toBe(true);
    for (const ws of second.workspaces) {
      expect(ws.written, `${ws.workspaceName} reescribió en el segundo render`).toBe(false);
      expect(ws.trimmed, `${ws.workspaceName} volvió a borrar`).toEqual([]);
    }
  });
});
