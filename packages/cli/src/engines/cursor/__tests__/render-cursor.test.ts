import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderCursorEngine } from "../index.ts";
import type { NavoriConfig } from "../../../lib/config.ts";

function baseConfig(over: Partial<NavoriConfig> = {}): NavoriConfig {
  return {
    name: "curtest",
    engines: ["claude", "cursor"],
    preset: "custom",
    language: "es",
    ...over,
  } as NavoriConfig;
}

const MDC = ".cursor/rules/navori.mdc";

describe("renderCursorEngine", () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });
  function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), "navori-cursor-"));
    dirs.push(d);
    return d;
  }

  it("creates .cursor/rules/navori.mdc with frontmatter, core blocks, skills and workflow", () => {
    const cwd = tmp();
    const r = renderCursorEngine(cwd, baseConfig());

    expect(r.written).toEqual([{ path: MDC, status: "created" }]);
    const md = readFileSync(join(cwd, MDC), "utf-8");
    // MDC frontmatter (always-applied project rule)
    expect(md).toMatch(/^---\n/);
    expect(md).toContain("alwaysApply: true");
    // harness prose
    expect(md).toContain("## Idioma y rol");
    expect(md).toContain("## Skills disponibles");
    expect(md).toContain("verify-before-done");
    expect(md).toContain("## Flujo de trabajo");
    // managed marker + user-section
    expect(md).toContain('navori:managed id="navori-cursor"');
    expect(md).toContain("navori:user-section");
  });

  it("drops Claude-only orchestration and plugin blocks", () => {
    const cwd = tmp();
    renderCursorEngine(
      cwd,
      baseConfig({ plugins: { engram: { enabled: true } } } as Partial<NavoriConfig>),
    );
    const md = readFileSync(join(cwd, MDC), "utf-8");
    expect(md).not.toContain("## Rol: orquestador");
    expect(md).not.toContain("mem_save");
  });

  it("surfaces the parity gap via warnings[]", () => {
    const cwd = tmp();
    const r = renderCursorEngine(cwd, baseConfig());
    expect(r.warnings.some((w) => w.includes("orquestación"))).toBe(true);
  });

  it("is idempotent: a second render reports unchanged and rewrites nothing", () => {
    const cwd = tmp();
    renderCursorEngine(cwd, baseConfig());
    const first = readFileSync(join(cwd, MDC), "utf-8");
    const second = renderCursorEngine(cwd, baseConfig());
    expect(second.written).toEqual([]);
    expect(readFileSync(join(cwd, MDC), "utf-8")).toBe(first);
  });

  it("preserves the frontmatter and user-section across re-renders", () => {
    const cwd = tmp();
    renderCursorEngine(cwd, baseConfig());
    const path = join(cwd, MDC);
    const edited = readFileSync(path, "utf-8").replace(
      "<!-- Agrega aquí lo específico de tu repo; navori no toca esta sección. -->",
      "- Mi regla propia del repo.",
    );
    writeFileSync(path, edited, "utf-8");

    renderCursorEngine(cwd, baseConfig({ preset: "nextjs" }));
    const after = readFileSync(path, "utf-8");
    expect(after).toContain("alwaysApply: true"); // frontmatter preserved
    expect(after).toContain("- Mi regla propia del repo."); // user edit survived
    expect(after).toContain("## Stack"); // managed block updated
  });

  it("dryRun computes the plan but writes nothing", () => {
    const cwd = tmp();
    const r = renderCursorEngine(cwd, baseConfig(), { dryRun: true });
    expect(r.written).toEqual([{ path: MDC, status: "created" }]);
    expect(existsSync(join(cwd, MDC))).toBe(false);
  });

  it("skips (never overwrites) a hand-edited managed block", () => {
    const cwd = tmp();
    renderCursorEngine(cwd, baseConfig());
    const path = join(cwd, MDC);
    const tampered = readFileSync(path, "utf-8").replace("## Idioma y rol", "## EDITADO A MANO");
    writeFileSync(path, tampered, "utf-8");

    const r = renderCursorEngine(cwd, baseConfig({ preset: "nextjs" }));
    expect(r.skipped).toEqual([{ path: MDC, reason: "managed block edited by hand" }]);
    expect(readFileSync(path, "utf-8")).toContain("## EDITADO A MANO");
  });
});
