import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderClaudeEngine } from "../index.ts";
import type { NavoriConfig } from "../../../lib/config/config.ts";
import { removeManagedSection } from "../../../lib/render/marker.ts";

/**
 * A plugin sub-block whose target is absent has TWO causes, and the render used
 * to blame the wrong one (#676).
 *
 * Under `workspaceHarness: "minimal"` (spec 0018) a workspace has no
 * `.claude/agents/` BY DESIGN — the trim's own argument is that Claude Code
 * finds agents by walking up. The root render wrote the agent and injected the
 * sub-block into it, so nothing was dropped. Blaming `config.harness` there was
 * not a misleading hint, it was false: 13 lines per workspace on every render of
 * a real monorepo, all pointing at a config that is correct.
 */

const BASE = {
  name: "demo",
  engines: ["claude"],
  preset: "custom",
  version: "1.0.0",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
  plugins: { engram: { enabled: true } },
} as unknown as NavoriConfig;

let root: string;
let ws: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "navori-inject-root-"));
  ws = join(root, "apps", "backend");
  mkdirSync(ws, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Warnings that talk about a sub-block that could not be injected. */
function injectWarnings(warnings: string[]): string[] {
  return warnings.filter((w) => w.includes("no inyectado") || w.includes("not injected"));
}

describe("render — el aviso de sub-bloque no inyectado (#676)", () => {
  it("se calla en un workspace 'minimal': el agente vive en la raíz", () => {
    const r = renderClaudeEngine(ws, BASE, { repoRoot: root, harnessScope: "minimal" });
    // Precondición del caso: el recorte es real, no hay agentes en el workspace.
    expect(existsSync(join(ws, ".claude/agents/orchestrator.md"))).toBe(false);
    expect(injectWarnings(r.warnings)).toEqual([]);
  });

  it("sí avisa cuando el agente está deshabilitado en config.harness", () => {
    // El caso legítimo: aquí la contribución del plugin SÍ se pierde, y el
    // mensaje actual es correcto. Si esto dejara de avisar, el fix habría
    // cambiado un falso positivo por un falso negativo.
    const r = renderClaudeEngine(root, {
      ...BASE,
      harness: { orchestrator: false },
    } as unknown as NavoriConfig);
    const w = injectWarnings(r.warnings);
    expect(w.length).toBeGreaterThan(0);
    expect(w.join("\n")).toContain("orchestrator.md");
  });

  it("un render de raíz con todo habilitado no avisa nada", () => {
    // Anti-falso-verde por el otro lado: el silencio del primer caso tiene que
    // venir del scope, no de que este plugin nunca avise.
    const r = renderClaudeEngine(root, BASE);
    expect(injectWarnings(r.warnings)).toEqual([]);
    expect(existsSync(join(root, ".claude/agents/orchestrator.md"))).toBe(true);
  });
});

describe("render — un sub-bloque cuyo destino es una skill omitida (spec 0043 R13)", () => {
  const JSCPD = { ...BASE, plugins: { jscpd: { enabled: true } } } as unknown as NavoriConfig;
  const target = (): string => join(ws, ".claude/skills/review-diff/SKILL.md");
  const omitted = { omitted: new Set(["review-diff"]), prune: false };

  it("no avisa aunque el destino no esté en disco", () => {
    // Covers: R13
    // Sin el set de omitidas, ese destino ausente sí es un aviso legítimo (#676).
    const control = renderClaudeEngine(ws, JSCPD, { repoRoot: root });
    expect(control.warnings.some((w) => /no inyectado|not injected/.test(w))).toBe(false);
    rmSync(join(ws, ".claude"), { recursive: true });

    const r = renderClaudeEngine(ws, JSCPD, { repoRoot: root, workspaceSkills: omitted });
    expect(injectWarnings(r.warnings)).toEqual([]);
    expect(existsSync(target())).toBe(false);
  });

  it("no reescribe la copia en disco", () => {
    // Covers: R13
    renderClaudeEngine(ws, JSCPD, { repoRoot: root });
    // Quitar el sub-bloque: un render normal lo volvería a inyectar.
    const stripped = removeManagedSection(
      readFileSync(target(), "utf-8"),
      "jscpd-review-extension",
      "html",
    );
    expect(stripped).not.toBe(readFileSync(target(), "utf-8"));
    writeFileSync(target(), stripped);

    const r = renderClaudeEngine(ws, JSCPD, { repoRoot: root, workspaceSkills: omitted });

    expect(readFileSync(target(), "utf-8")).toBe(stripped);
    expect(r.written.some((w) => w.path.includes("review-diff"))).toBe(false);
  });
});
