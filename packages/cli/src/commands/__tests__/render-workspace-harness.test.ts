import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfig, readConfig } from "../../lib/config/config.ts";
import { planClaudeSkills } from "../../engines/claude/index.ts";
import { countPendingRenderChanges, renderCommand, runRender } from "../render.ts";

const logged = vi.hoisted(() => ({ messages: [] as string[] }));
vi.mock("@clack/prompts", () => ({
  intro: () => undefined,
  outro: () => undefined,
  cancel: () => undefined,
  log: {
    message: (m: string) => void logged.messages.push(m),
    info: (m: string) => void logged.messages.push(m),
    warn: (m: string) => void logged.messages.push(m),
    error: () => undefined,
    success: () => undefined,
    step: () => undefined,
  },
}));

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
  it("respeta monorepo.enabled=false y no toca workspaces declarados", () => {
    writeConfig(join(cwd, "navori.config.json"), {
      name: "disabled-workspaces",
      engines: ["claude"],
      preset: "monorepo-turbopnpm",
      monorepo: {
        enabled: false,
        tool: "turbo",
        workspaces: [{ name: "backend", path: "apps/backend" }],
      },
    });

    const result = runRender(cwd);
    expect(result.ok).toBe(true);
    expect(result.workspaces).toEqual([]);
    expect(existsSync(join(cwd, "apps/backend/CLAUDE.md"))).toBe(false);
    expect(readFileSync(join(cwd, "CLAUDE.md"), "utf-8")).not.toContain('id="contexto-monorepo"');
  });

  it("bajo el default, el workspace recibe CLAUDE.md y nada más cuando todo es igual al de la raíz", () => {
    // Covers: R2
    writeMonorepoConfig(); // sin declarar nada: el default del schema es `minimal`
    expect(runRender(cwd).ok).toBe(true);

    for (const ws of ["apps/backend", "apps/storefront"]) {
      expect(existsSync(join(cwd, ws, "CLAUDE.md")), `${ws}/CLAUDE.md`).toBe(true);
      // Spec 0043: este fixture hereda preset y `qualityGate` de la raíz, así que
      // cada skill del workspace es idéntica a la de la raíz y ya no se duplica.
      expect(existsSync(join(cwd, ws, ".claude/skills")), `${ws}/.claude/skills`).toBe(false);
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

// ---------------------------------------------------------------------------
// Spec 0043 — `minimal` stops duplicating what the root already has.
// ---------------------------------------------------------------------------

/** Skill directory names under a `.claude/skills`, sorted; empty when absent. */
function skillIds(dir: string): string[] {
  const skills = join(dir, ".claude/skills");
  return existsSync(skills) ? readdirSync(skills).sort() : [];
}

const SKILL = (ws: string, id: string): string => join(cwd, ws, ".claude/skills", id, "SKILL.md");

/**
 * Field-shaped monorepo: two workspaces with their own presets, one of them with
 * its own `qualityGate`, under a root with a third preset.
 */
function writeMoonarConfig(harness: "minimal" | "full" | "root" = "minimal"): void {
  writeConfig(join(cwd, "navori.config.json"), {
    name: "moonar-demo",
    engines: ["claude"],
    preset: "monorepo-turbopnpm",
    qualityGate: { fast: "pnpm -w lint", full: "pnpm -w test" },
    monorepo: {
      enabled: true,
      tool: "turbo",
      workspaces: [
        { name: "backend", path: "apps/backend", preset: "medusa" },
        {
          name: "storefront",
          path: "apps/storefront",
          preset: "nextjs",
          qualityGate: { fast: "pnpm lint", full: "pnpm test" },
        },
      ],
      workspaceHarness: harness,
    },
  });
}

describe("render por workspace — `minimal` no duplica lo de la raíz (spec 0043)", () => {
  it("bajo `minimal` el workspace no lleva las idénticas a la raíz y sí las de su preset y librerías", () => {
    // Covers: R2
    writeMoonarConfig();
    expect(runRender(cwd).ok).toBe(true);

    const rootIds = skillIds(cwd);
    // El workspace de `backend` hereda el gate de la raíz: solo conserva lo de su preset.
    const backend = skillIds(join(cwd, "apps/backend"));
    expect(backend).toEqual(expect.arrayContaining(["medusa-modules", "medusa-api-routes"]));
    for (const id of backend) {
      expect(rootIds, `${id} está duplicada de la raíz`).not.toContain(id);
    }
    // `storefront` tiene su propio gate: las skills que lo interpolan difieren de la raíz.
    const storefront = skillIds(join(cwd, "apps/storefront"));
    expect(storefront).toEqual(
      expect.arrayContaining(["nextjs-app-router", "verify-before-done", "review-diff"]),
    );
    expect(storefront).not.toContain("locate-code");
  });

  it("la raíz conserva exactamente su set", () => {
    // Covers: R2
    writeMoonarConfig();
    expect(runRender(cwd).ok).toBe(true);
    const planned = planClaudeSkills(cwd, readConfig(join(cwd, "navori.config.json")), {
      repoRoot: cwd,
    }).skills.map((s) => s.id);
    expect(skillIds(cwd)).toEqual([...planned].sort());
  });

  it("fixture moonar: omite, conserva y reporta lo esperado", () => {
    // Covers: R2, R3
    // Un repo renderizado por un navori anterior: todo duplicado, bajo `full`.
    writeMoonarConfig("full");
    expect(runRender(cwd).ok).toBe(true);
    // Copia de un asset viejo: sin el mapa `metadata:` que el asset ganó después.
    const old = readFileSync(SKILL("apps/backend", "locate-code"), "utf-8");
    const stripped = old.replace(/^metadata:\n(?: {2}.*\n)+/m, "");
    expect(stripped).not.toBe(old);
    writeFileSync(SKILL("apps/backend", "locate-code"), stripped);
    // Copia con texto del usuario, y copia sin marca de navori.
    writeFileSync(
      SKILL("apps/backend", "debug-failure"),
      `${readFileSync(SKILL("apps/backend", "debug-failure"), "utf-8")}\nMi nota propia.\n`,
    );
    writeFileSync(SKILL("apps/backend", "plan-simple"), "---\nname: plan-simple\n---\nmía\n");

    writeMoonarConfig("minimal");
    const result = runRender(cwd, { dryRun: false });
    expect(result.ok).toBe(true);
    const backend = result.workspaces.find((w) => w.workspaceName === "backend")!;

    // Se quitó la prístina (incluida la del asset viejo)…
    expect(existsSync(SKILL("apps/backend", "locate-code"))).toBe(false);
    expect(existsSync(SKILL("apps/backend", "review-diff"))).toBe(false);
    // …y se conservaron y reportaron las que no son de navori sola.
    const kept = Object.fromEntries(backend.trimmedKept.map((k) => [k.path, k.reason]));
    expect(kept[".claude/skills/debug-failure/SKILL.md"]).toBe("modified");
    expect(kept[".claude/skills/plan-simple/SKILL.md"]).toBe("foreign");
    expect(existsSync(SKILL("apps/backend", "debug-failure"))).toBe(true);
    expect(existsSync(SKILL("apps/backend", "plan-simple"))).toBe(true);
    // Lo propio de su preset sigue ahí.
    expect(existsSync(SKILL("apps/backend", "medusa-modules"))).toBe(true);
    // `storefront` interpola su gate: la copia difiere de la raíz y se conserva.
    expect(existsSync(SKILL("apps/storefront", "verify-before-done"))).toBe(true);
    expect(existsSync(SKILL("apps/storefront", "locate-code"))).toBe(false);
  });

  it("`render --workspace` sin raíz renderizada no omite nada", () => {
    // Covers: R3
    writeMoonarConfig();
    const result = runRender(cwd, { dryRun: false, workspaceFilter: "backend" });
    expect(result.ok).toBe(true);
    // La raíz nunca se renderizó: no hay quien provea las genéricas, así que el
    // workspace las conserva todas.
    expect(existsSync(join(cwd, ".claude"))).toBe(false);
    expect(skillIds(join(cwd, "apps/backend"))).toEqual(
      expect.arrayContaining(["locate-code", "review-diff", "medusa-modules"]),
    );
  });

  it("el preview imprime la línea de conteo y no borra", async () => {
    // Covers: R3
    writeMoonarConfig("full");
    expect(runRender(cwd).ok).toBe(true);
    writeMoonarConfig("minimal");
    logged.messages.length = 0;

    await renderCommand.run?.({
      rawArgs: [],
      cmd: renderCommand,
      args: { _: [], cwd } as never,
    });

    expect(existsSync(SKILL("apps/backend", "locate-code"))).toBe(true);
    expect(logged.messages.join("\n")).toMatch(
      /backend: \d+ skill\(s\) duplicadas de la raíz quitadas, 0 conservadas/,
    );
  });

  it("segundo render: cero cambios", () => {
    // Covers: R2, R9
    writeMoonarConfig("full");
    expect(runRender(cwd).ok).toBe(true);
    writeMoonarConfig("minimal");
    const applied = runRender(cwd, { dryRun: false });
    expect(countPendingRenderChanges(applied)).toBeGreaterThan(0);
    const second = runRender(cwd, { dryRun: false });
    expect(countPendingRenderChanges(second)).toBe(0);
    expect(countPendingRenderChanges(runRender(cwd, { dryRun: true }))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Spec 0043 — `root`: the workspace keeps only its context file, the root
// writes what the workspaces hand up.
// ---------------------------------------------------------------------------

const WS_BACKEND = "apps/backend";
const WS_STOREFRONT = "apps/storefront";
const rootSkillDir = (id: string): string => join(cwd, ".claude/skills", id);

/** Two workspaces that each declare `vitest`; the gate decides whether their bytes agree. */
function writeVitestConfig(gates: { a: string; b: string }, harness: "root" | "minimal" = "root") {
  writeConfig(join(cwd, "navori.config.json"), {
    name: "vitest-demo",
    engines: ["claude"],
    preset: "monorepo-turbopnpm",
    qualityGate: { fast: "pnpm -w lint", full: "pnpm -w test" },
    monorepo: {
      enabled: true,
      tool: "turbo",
      workspaces: [
        {
          name: "backend",
          path: WS_BACKEND,
          libraries: ["vitest"],
          qualityGate: { fast: gates.a, full: "pnpm test" },
        },
        {
          name: "storefront",
          path: WS_STOREFRONT,
          libraries: ["vitest"],
          qualityGate: { fast: gates.b, full: "pnpm test" },
        },
      ],
      workspaceHarness: harness,
    },
  });
}

describe("render por workspace — `root` (spec 0043)", () => {
  it("`full` → `root`: el workspace queda sin `.claude/`, lo ajeno se conserva y se reporta, y la raíz gana lo subido", () => {
    // Covers: R4, R5, R7
    writeMoonarConfig("full");
    expect(runRender(cwd).ok).toBe(true);
    expect(existsSync(rootSkillDir("nextjs-app-router"))).toBe(false);
    // Un archivo del usuario en un workspace, no en el otro.
    writeFileSync(join(cwd, WS_BACKEND, ".claude/agents/mio.md"), "# mi agente\n");

    writeMoonarConfig("root");
    const result = runRender(cwd, { dryRun: false });
    expect(result.ok).toBe(true);

    // `storefront` no tenía nada propio: ni `.claude/` queda.
    expect(existsSync(join(cwd, WS_STOREFRONT, ".claude"))).toBe(false);
    // `backend` conserva lo suyo — y solo eso — y lo dice.
    const left = readdirSync(join(cwd, WS_BACKEND, ".claude"), { recursive: true });
    expect(left.map(String).filter((f) => f.endsWith(".md") || f.endsWith(".json"))).toEqual([
      join("agents", "mio.md"),
    ]);
    const backend = result.workspaces.find((w) => w.workspaceName === "backend")!;
    expect(backend.trimmedKept.some((k) => k.path.endsWith("mio.md"))).toBe(true);
    // La raíz ganó lo que los workspaces subieron.
    expect(existsSync(join(rootSkillDir("nextjs-app-router"), "SKILL.md"))).toBe(true);
    expect(existsSync(join(rootSkillDir("medusa-modules"), "SKILL.md"))).toBe(true);
    expect(existsSync(join(cwd, WS_STOREFRONT, "CLAUDE.md"))).toBe(true);
  });

  it("`render --workspace` bajo `root` con una raíz sin lo subido conserva las skills del workspace", () => {
    // Covers: R4, R9
    writeMoonarConfig("root");
    // Sin raíz renderizada: no hay quien provea nada, el workspace conserva todo.
    expect(runRender(cwd, { dryRun: false, workspaceFilter: "backend" }).ok).toBe(true);
    expect(skillIds(join(cwd, WS_BACKEND))).toEqual(
      expect.arrayContaining(["locate-code", "review-diff", "medusa-modules"]),
    );
    // Con una raíz que ya tiene lo genérico pero no lo subido: se va lo genérico,
    // se queda lo que la raíz todavía no tiene.
    expect(runRender(cwd, { dryRun: false, workspaceFilter: "storefront" }).ok).toBe(true);
    writeMoonarConfig("minimal");
    expect(runRender(cwd, { dryRun: false }).ok).toBe(true);
    writeMoonarConfig("root");
    rmSync(rootSkillDir("medusa-modules"), { recursive: true, force: true });
    const filtered = runRender(cwd, { dryRun: false, workspaceFilter: "backend" });
    expect(filtered.ok).toBe(true);
    expect(skillIds(join(cwd, WS_BACKEND))).toContain("medusa-modules");
    expect(skillIds(join(cwd, WS_BACKEND))).not.toContain("locate-code");
  });

  it("`root` → `minimal` devuelve las skills al workspace y poda lo subido en la raíz", () => {
    // Covers: R7, R9
    writeMoonarConfig("root");
    expect(runRender(cwd, { dryRun: false }).ok).toBe(true);
    expect(existsSync(rootSkillDir("medusa-modules"))).toBe(true);
    expect(skillIds(join(cwd, WS_BACKEND))).toEqual([]);

    writeMoonarConfig("minimal");
    expect(runRender(cwd, { dryRun: false }).ok).toBe(true);

    expect(existsSync(SKILL(WS_BACKEND, "medusa-modules"))).toBe(true);
    expect(existsSync(rootSkillDir("medusa-modules"))).toBe(false);
    expect(existsSync(rootSkillDir("nextjs-app-router"))).toBe(false);
    expect(countPendingRenderChanges(runRender(cwd, { dryRun: true }))).toBe(0);
  });

  it("un conflicto que desaparece renombra `slug-id` al id original sin dejar restos", () => {
    // Covers: R6
    writeVitestConfig({ a: "pnpm a-lint", b: "pnpm b-lint" });
    expect(runRender(cwd, { dryRun: false }).ok).toBe(true);
    expect(existsSync(rootSkillDir("vitest"))).toBe(false);
    expect(existsSync(join(rootSkillDir("backend-vitest"), "SKILL.md"))).toBe(true);
    expect(existsSync(join(rootSkillDir("storefront-vitest"), "SKILL.md"))).toBe(true);

    // Los gates coinciden: los bytes también, y queda una sola con el id original.
    writeVitestConfig({ a: "pnpm lint", b: "pnpm lint" });
    expect(runRender(cwd, { dryRun: false }).ok).toBe(true);

    expect(existsSync(join(rootSkillDir("vitest"), "SKILL.md"))).toBe(true);
    expect(existsSync(rootSkillDir("backend-vitest"))).toBe(false);
    expect(existsSync(rootSkillDir("storefront-vitest"))).toBe(false);
    expect(existsSync(join(cwd, WS_BACKEND, ".claude"))).toBe(false);
    expect(countPendingRenderChanges(runRender(cwd, { dryRun: true }))).toBe(0);
  });

  it("fixture moonar bajo `root`: suben `medusa-*` y `nextjs-*` y ninguna variante core", () => {
    // Covers: R5
    writeMoonarConfig("root");
    expect(runRender(cwd, { dryRun: false }).ok).toBe(true);

    const rootIds = skillIds(cwd);
    expect(rootIds).toEqual(
      expect.arrayContaining([
        "medusa-modules",
        "medusa-api-routes",
        "nextjs-app-router",
        "nextjs-data-fetching",
        "new-resource",
      ]),
    );
    // Ninguna variante por workspace de una core: `storefront` tiene otro gate y aun así gana la raíz.
    expect(
      rootIds.filter((id) => /-(verify-before-done|review-diff|locate-code)$/.test(id)),
    ).toEqual([]);
    expect(readFileSync(join(rootSkillDir("verify-before-done"), "SKILL.md"), "utf-8")).toContain(
      "pnpm -w",
    );
    for (const ws of [WS_BACKEND, WS_STOREFRONT]) {
      expect(readdirSync(join(cwd, ws))).toEqual(["CLAUDE.md"]);
    }
    expect(readFileSync(join(cwd, "CLAUDE.md"), "utf-8")).toContain("`medusa-modules`");
  });

  it("segundo render bajo `root`: cero cambios", () => {
    // Covers: R9
    writeMoonarConfig("root");
    expect(runRender(cwd, { dryRun: false }).ok).toBe(true);
    expect(countPendingRenderChanges(runRender(cwd, { dryRun: false }))).toBe(0);
    expect(countPendingRenderChanges(runRender(cwd, { dryRun: true }))).toBe(0);
  });

  it("un destino de la raíz que no es de navori bloquea la subida y el workspace conserva su copia", () => {
    // Covers: R6
    writeMoonarConfig("root");
    mkdirSync(rootSkillDir("nextjs-app-router"), { recursive: true });
    writeFileSync(join(rootSkillDir("nextjs-app-router"), "SKILL.md"), "# mía\n");

    const result = runRender(cwd, { dryRun: false });
    expect(result.ok).toBe(true);

    expect(readFileSync(join(rootSkillDir("nextjs-app-router"), "SKILL.md"), "utf-8")).toBe(
      "# mía\n",
    );
    expect(existsSync(SKILL(WS_STOREFRONT, "nextjs-app-router"))).toBe(true);
    const storefront = result.workspaces.find((w) => w.workspaceName === "storefront")!;
    expect(storefront.engineResult?.warnings.join("\n")).toContain("nextjs-app-router");
  });
});
