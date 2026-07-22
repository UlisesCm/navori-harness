import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderCopilotEngine } from "../index.ts";
import type { NavoriConfig } from "../../../lib/config.ts";

function baseConfig(over: Partial<NavoriConfig> = {}): NavoriConfig {
  return {
    name: "coptest",
    engines: ["claude", "copilot"],
    preset: "custom",
    language: "es",
    ...over,
  } as NavoriConfig;
}

const FILE = ".github/copilot-instructions.md";

describe("renderCopilotEngine", () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });
  function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), "navori-copilot-"));
    dirs.push(d);
    return d;
  }

  it("creates .github/copilot-instructions.md with core blocks, skills and workflow", () => {
    const cwd = tmp();
    const r = renderCopilotEngine(cwd, baseConfig());

    expect(r.written).toEqual([{ path: FILE, status: "created" }]);
    const md = readFileSync(join(cwd, FILE), "utf-8");
    expect(md).toContain("# Copilot instructions");
    expect(md).toContain("## Idioma y rol");
    expect(md).toContain("## Skills disponibles");
    expect(md).toContain("verify-before-done");
    expect(md).toContain("## Flujo de trabajo");
    expect(md).toContain('navori:managed id="navori-copilot"');
    expect(md).toContain("navori:user-section");
  });

  it("drops Claude-only orchestration and plugin blocks", () => {
    const cwd = tmp();
    renderCopilotEngine(
      cwd,
      baseConfig({ plugins: { engram: { enabled: true } } } as Partial<NavoriConfig>),
    );
    const md = readFileSync(join(cwd, FILE), "utf-8");
    expect(md).not.toContain("## Rol: orquestador");
    expect(md).not.toContain("mem_save");
  });

  it("includes the preset stack block + its skills", () => {
    const cwd = tmp();
    renderCopilotEngine(cwd, baseConfig({ preset: "nextjs" }));
    const md = readFileSync(join(cwd, FILE), "utf-8");
    expect(md).toContain("## Stack");
    expect(md).toContain("nextjs-app-router");
  });

  it("is idempotent: a second render reports unchanged and rewrites nothing", () => {
    const cwd = tmp();
    renderCopilotEngine(cwd, baseConfig());
    const first = readFileSync(join(cwd, FILE), "utf-8");
    const second = renderCopilotEngine(cwd, baseConfig());
    expect(second.written).toEqual([]);
    expect(readFileSync(join(cwd, FILE), "utf-8")).toBe(first);
  });

  it("preserves the user-section across re-renders", () => {
    const cwd = tmp();
    renderCopilotEngine(cwd, baseConfig());
    const path = join(cwd, FILE);
    const edited = readFileSync(path, "utf-8").replace(
      "<!-- Agrega aquí lo específico de tu repo; navori no toca esta sección. -->",
      "- Mi regla propia del repo.",
    );
    writeFileSync(path, edited, "utf-8");

    renderCopilotEngine(cwd, baseConfig({ preset: "nextjs" }));
    const after = readFileSync(path, "utf-8");
    expect(after).toContain("- Mi regla propia del repo.");
    expect(after).toContain("## Stack");
  });

  it("dryRun computes the plan but writes nothing", () => {
    const cwd = tmp();
    const r = renderCopilotEngine(cwd, baseConfig(), { dryRun: true });
    expect(r.written).toEqual([{ path: FILE, status: "created" }]);
    expect(existsSync(join(cwd, FILE))).toBe(false);
  });
});
