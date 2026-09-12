import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderClaudeEngine } from "../index.ts";
import type { NavoriConfig } from "../../../lib/config.ts";

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
    expect(existsSync(join(ws, ".claude/agents/leader.md"))).toBe(false);
    expect(injectWarnings(r.warnings)).toEqual([]);
  });

  it("sí avisa cuando el agente está deshabilitado en config.harness", () => {
    // El caso legítimo: aquí la contribución del plugin SÍ se pierde, y el
    // mensaje actual es correcto. Si esto dejara de avisar, el fix habría
    // cambiado un falso positivo por un falso negativo.
    const r = renderClaudeEngine(root, {
      ...BASE,
      harness: { leader: false },
    } as unknown as NavoriConfig);
    const w = injectWarnings(r.warnings);
    expect(w.length).toBeGreaterThan(0);
    expect(w.join("\n")).toContain("leader.md");
  });

  it("un render de raíz con todo habilitado no avisa nada", () => {
    // Anti-falso-verde por el otro lado: el silencio del primer caso tiene que
    // venir del scope, no de que este plugin nunca avise.
    const r = renderClaudeEngine(root, BASE);
    expect(injectWarnings(r.warnings)).toEqual([]);
    expect(existsSync(join(root, ".claude/agents/leader.md"))).toBe(true);
  });
});
