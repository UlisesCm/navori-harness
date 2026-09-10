import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanStaleHarness } from "../stale-harness.ts";
import type { NavoriConfig } from "../config.ts";

/**
 * Spec 0018 R6 — harness no render will ever refresh again.
 *
 * Regression case, real and current: this very repo carries
 * `packages/cli/.claude/context/`, frozen at 0.6.5 since 2026-09-02. It is not
 * a declared workspace, so the render loop never visits it, and nothing on disk
 * admits that its content is months old.
 */

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-stale-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

/** Write a managed file carrying `version`, so the scan can date the freeze. */
function managed(rel: string, version: string): void {
  const full = join(cwd, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(
    full,
    `<!-- navori:managed id="x" hash="abc" version="${version}" source="@navori/core" -->\n# x\n`,
  );
}

function config(over: Partial<NavoriConfig> = {}): NavoriConfig {
  return { name: "demo", engines: ["claude"], preset: "custom", ...over } as NavoriConfig;
}

describe("scanStaleHarness — lo que ningún render vuelve a tocar (spec 0018 R6)", () => {
  it("un repo sin harness anidado no reporta nada", () => {
    // Covers: R6
    managed(".claude/agents/reviewer.md", "0.8.2");
    expect(scanStaleHarness(cwd, config())).toEqual([]);
  });

  it("reporta un .claude/ en un subdirectorio no declarado, con su versión más vieja", () => {
    // Covers: R6
    // El caso de campo: `packages/cli/.claude/` en el propio repo de navori.
    managed(".claude/agents/reviewer.md", "0.8.2");
    managed("packages/cli/.claude/context/x.md", "0.6.5");
    managed("packages/cli/.claude/context/y.md", "0.7.1");

    const found = scanStaleHarness(cwd, config());
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      path: "packages/cli/.claude",
      reason: "undeclared-workspace",
      files: 2,
      // La MÁS VIEJA, que es el dato que dice hace cuánto quedó congelado.
      frozenAt: "0.6.5",
    });
  });

  it("el mismo directorio DECLARADO como workspace no se reporta", () => {
    // Covers: R6
    // Anti-falso-positivo: un workspace declarado sí lo visita el render, así
    // que su harness no está congelado — está al día por construcción.
    managed("packages/cli/.claude/context/x.md", "0.6.5");
    const declared = config({
      monorepo: { enabled: true, workspaces: [{ name: "cli", path: "packages/cli" }] },
    } as Partial<NavoriConfig>);
    expect(scanStaleHarness(cwd, declared)).toEqual([]);
  });

  it("reporta los scripts que el recorte por workspace dejó atrás", () => {
    // Covers: R6
    // navori deja de escribirlos pero no los borra: un script de plugin no
    // lleva marca de autoría, y navori nunca borra lo que no puede probar que
    // escribió. doctor es el único lugar donde el usuario se entera.
    mkdirSync(join(cwd, "apps/api/.claude/scripts"), { recursive: true });
    writeFileSync(join(cwd, "apps/api/.claude/scripts/tgrep-search.sh"), "#!/usr/bin/env bash\n");
    const minimal = config({
      monorepo: {
        enabled: true,
        workspaceHarness: "minimal",
        workspaces: [{ name: "api", path: "apps/api" }],
      },
    } as Partial<NavoriConfig>);

    const found = scanStaleHarness(cwd, minimal);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      path: "apps/api/.claude/scripts",
      reason: "trimmed-workspace",
      files: 1,
    });
  });

  it("bajo `full` esos scripts NO se reportan: el workspace sí los recibe", () => {
    // Covers: R6
    mkdirSync(join(cwd, "apps/api/.claude/scripts"), { recursive: true });
    writeFileSync(join(cwd, "apps/api/.claude/scripts/tgrep-search.sh"), "#!/usr/bin/env bash\n");
    const full = config({
      monorepo: {
        enabled: true,
        workspaceHarness: "full",
        workspaces: [{ name: "api", path: "apps/api" }],
      },
    } as Partial<NavoriConfig>);
    expect(scanStaleHarness(cwd, full)).toEqual([]);
  });

  it("no se mete en node_modules ni en .git", () => {
    // Covers: R6
    // Sin esto el scan recorrería árboles enormes en cada `doctor`.
    mkdirSync(join(cwd, "node_modules/algo/.claude"), { recursive: true });
    writeFileSync(join(cwd, "node_modules/algo/.claude/x.md"), "# ajeno\n");
    expect(scanStaleHarness(cwd, config())).toEqual([]);
  });

  it("un directorio vacío no cuenta como harness congelado", () => {
    // Covers: R6
    mkdirSync(join(cwd, "packages/cli/.claude"), { recursive: true });
    expect(scanStaleHarness(cwd, config())).toEqual([]);
  });
});
