import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderCodexEngine } from "../index.ts";
import { readCliVersion } from "../../../lib/render/bundled-assets.ts";
import { injectManagedSection } from "../../../lib/render/marker.ts";
import type { NavoriConfig } from "../../../lib/config/config.ts";

/**
 * spec 0026 T10 (R39, R41) — Codex's own version of the "conservarlo y
 * reportar el motivo" the Claude engine's §8.7b–d give retired skills, hooks
 * and agents. Codex's orphan scan (`engines/shared/execute-plan.ts`'s
 * `collectOrphans`, shared by every prose engine, exercised here through
 * Codex) already REFUSED to delete a foreign or newer file before this batch
 * — `isRemovableNavoriFile` protected it — but said nothing about why. This
 * file pins: never deletes a user-owned or newer-navori file (unchanged
 * behavior), AND now reports it in `result.warnings`, across the three
 * `OrphanScan` shapes Codex actually uses (`file` for agents/hooks,
 * `skill-dir` for skills, `skill-nested-file` for the openai.yaml sidecar).
 */

const CONFIG = {
  name: "codex-demo",
  engines: ["codex"],
  preset: "custom",
  version: "1.0.0",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
  qualityGate: { fast: "pnpm test", full: "pnpm test" },
} as unknown as NavoriConfig;

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-codex-orphans-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function foreignContent(): string {
  return "# escrito a mano por el usuario\n";
}

function navoriContent(id: string, version: string): string {
  return injectManagedSection("", id, "cuerpo\n", {
    version,
    source: "@navori/core",
  }).output;
}

describe("collectOrphans (shared) via Codex — shape 'file': .codex/agents (R39, R41)", () => {
  // Covers: R39, R41
  it("nunca borra un .toml ajeno (sin marcador de navori), y lo reporta", () => {
    mkdirSync(join(cwd, ".codex/agents"), { recursive: true });
    const path = join(cwd, ".codex/agents", "no-lo-conozco.toml");
    writeFileSync(path, foreignContent(), "utf-8");

    const result = renderCodexEngine(cwd, CONFIG);

    expect(existsSync(path)).toBe(true);
    expect(
      result.warnings.some((w) => w.includes("no-lo-conozco.toml") && w.includes("navori")),
    ).toBe(true);
  });

  // Covers: R39, R41
  it("nunca borra un .toml escrito por un navori MÁS NUEVO, y lo reporta", () => {
    mkdirSync(join(cwd, ".codex/agents"), { recursive: true });
    const path = join(cwd, ".codex/agents", "del-futuro.toml");
    writeFileSync(path, navoriContent("del-futuro", "99.0.0"), "utf-8");

    const result = renderCodexEngine(cwd, CONFIG);

    expect(existsSync(path)).toBe(true);
    expect(result.warnings.some((w) => w.includes("del-futuro.toml"))).toBe(true);
  });

  // Covers: R39
  it("SÍ borra un .toml propio de navori que ya no está en el plan (comportamiento previo, sin reporte)", () => {
    mkdirSync(join(cwd, ".codex/agents"), { recursive: true });
    const path = join(cwd, ".codex/agents", "ya-no-existe.toml");
    writeFileSync(path, navoriContent("ya-no-existe", readCliVersion()), "utf-8");

    const result = renderCodexEngine(cwd, CONFIG);

    expect(existsSync(path)).toBe(false);
    expect(result.warnings.some((w) => w.includes("ya-no-existe"))).toBe(false);
  });
});

describe("collectOrphans (shared) via Codex — shape 'skill-dir': .agents/skills (R39, R41)", () => {
  // Covers: R39, R41
  it("nunca borra un SKILL.md ajeno, y lo reporta", () => {
    const dir = join(cwd, ".agents/skills", "mia");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "SKILL.md");
    writeFileSync(path, foreignContent(), "utf-8");

    const result = renderCodexEngine(cwd, CONFIG);

    expect(existsSync(path)).toBe(true);
    expect(result.warnings.some((w) => w.includes(".agents/skills/mia/SKILL.md"))).toBe(true);
  });

  // Covers: R39, R41
  it("respeta lo que el usuario dejó al lado: borra SKILL.md, conserva el directorio, y NO reporta un directorio que ya no está vacío", () => {
    const dir = join(cwd, ".agents/skills", "ya-no-existe-skill");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), navoriContent("ya-no-existe-skill", readCliVersion()));
    writeFileSync(join(dir, "notas.md"), "del usuario\n", "utf-8");

    const result = renderCodexEngine(cwd, CONFIG);

    expect(existsSync(join(dir, "SKILL.md"))).toBe(false);
    expect(existsSync(join(dir, "notas.md"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("ya-no-existe-skill"))).toBe(false);
  });
});

describe("collectOrphans (shared) via Codex — shape 'skill-nested-file': agents/openai.yaml (R39, R41)", () => {
  // Covers: R39, R41
  it("nunca borra un agents/openai.yaml ajeno bajo una skill que sí existe, y lo reporta", () => {
    const result0 = renderCodexEngine(cwd, CONFIG);
    // Cualquier skill real, sin `disable-model-invocation`, deja su sidecar
    // fuera del set deseado — cualquier archivo ahí es huérfano por definición.
    const anySkillDir = result0.written
      .map((w) => w.path)
      .find((p) => p.endsWith("/SKILL.md") && p.includes(".agents/skills/"));
    expect(anySkillDir).toBeDefined();
    const skillDir = join(cwd, anySkillDir!.slice(0, -"/SKILL.md".length));
    const sidecarDir = join(skillDir, "agents");
    mkdirSync(sidecarDir, { recursive: true });
    const path = join(sidecarDir, "openai.yaml");
    writeFileSync(path, foreignContent(), "utf-8");

    const result = renderCodexEngine(cwd, CONFIG);

    expect(existsSync(path)).toBe(true);
    expect(result.warnings.some((w) => w.includes("openai.yaml"))).toBe(true);
  });
});
