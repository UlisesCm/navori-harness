import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderAgentsMdEngine } from "../index.ts";
import type { NavoriConfig } from "../../../lib/config.ts";

function baseConfig(over: Partial<NavoriConfig> = {}): NavoriConfig {
  return {
    name: "agtest",
    engines: ["claude", "agents-md"],
    preset: "custom",
    language: "es",
    ...over,
  } as NavoriConfig;
}

describe("renderAgentsMdEngine", () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });
  function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), "navori-agentsmd-"));
    dirs.push(d);
    return d;
  }

  it("creates AGENTS.md with the core rule blocks, skills and workflow", () => {
    const cwd = tmp();
    const r = renderAgentsMdEngine(cwd, baseConfig());

    expect(r.written).toEqual([{ path: "AGENTS.md", status: "created" }]);
    const md = readFileSync(join(cwd, "AGENTS.md"), "utf-8");
    expect(md).toContain("# AGENTS.md");
    expect(md).toContain("## Idioma y rol"); // a core rule block
    expect(md).toContain("## Skills disponibles");
    expect(md).toContain("verify-before-done");
    expect(md).toContain("## Flujo de trabajo");
    // managed marker + a user-section the user owns
    expect(md).toContain('navori:managed id="navori-agents"');
    expect(md).toContain("navori:user-section");
  });

  it("does NOT leak Claude-only plugin blocks (engram) into AGENTS.md", () => {
    const cwd = tmp();
    renderAgentsMdEngine(
      cwd,
      baseConfig({ plugins: { engram: { enabled: true } } } as Partial<NavoriConfig>),
    );
    const md = readFileSync(join(cwd, "AGENTS.md"), "utf-8");
    // engram is Claude-specific infra; its protocol block must not appear.
    expect(md).not.toContain("mem_save");
    expect(md).not.toContain("engram-protocol");
  });

  it("does NOT leak the Claude-only orchestration block into AGENTS.md", () => {
    const cwd = tmp();
    renderAgentsMdEngine(cwd, baseConfig());
    const md = readFileSync(join(cwd, "AGENTS.md"), "utf-8");
    // Subagent orchestration is a Claude Code capability; the role block drops.
    expect(md).not.toContain("## Rol: orquestador");
    expect(md).not.toContain("vía la tool `Agent`");
    // ...but the engine-agnostic workflow guidance still ships.
    expect(md).toContain("## Flujo de trabajo");
  });

  it("includes the preset stack block + its skills", () => {
    const cwd = tmp();
    renderAgentsMdEngine(cwd, baseConfig({ preset: "nextjs" }));
    const md = readFileSync(join(cwd, "AGENTS.md"), "utf-8");
    expect(md).toContain("## Stack"); // preset stack managed block
    expect(md).toContain("nextjs-app-router"); // preset skill listed
  });

  it("is idempotent: a second render reports unchanged and rewrites nothing", () => {
    const cwd = tmp();
    renderAgentsMdEngine(cwd, baseConfig());
    const first = readFileSync(join(cwd, "AGENTS.md"), "utf-8");
    const second = renderAgentsMdEngine(cwd, baseConfig());
    expect(second.written).toEqual([]);
    expect(readFileSync(join(cwd, "AGENTS.md"), "utf-8")).toBe(first);
  });

  it("preserves the user-section across re-renders", () => {
    const cwd = tmp();
    renderAgentsMdEngine(cwd, baseConfig());
    const path = join(cwd, "AGENTS.md");
    const edited = readFileSync(path, "utf-8").replace(
      "<!-- Agrega acá lo específico de tu repo; navori no toca esta sección. -->",
      "- Mi regla propia del repo.",
    );
    writeFileSync(path, edited, "utf-8");

    // A config change forces the managed block to update.
    renderAgentsMdEngine(cwd, baseConfig({ preset: "nextjs" }));
    const after = readFileSync(path, "utf-8");
    expect(after).toContain("- Mi regla propia del repo."); // user edit survived
    expect(after).toContain("## Stack"); // managed block updated
  });

  it("dryRun computes the plan but writes nothing", () => {
    const cwd = tmp();
    const r = renderAgentsMdEngine(cwd, baseConfig(), { dryRun: true });
    expect(r.written).toEqual([{ path: "AGENTS.md", status: "created" }]);
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
  });

  it("skips (never overwrites) a hand-edited managed block", () => {
    const cwd = tmp();
    renderAgentsMdEngine(cwd, baseConfig());
    const path = join(cwd, "AGENTS.md");
    // Edit INSIDE the managed block without touching the marker hash.
    const tampered = readFileSync(path, "utf-8").replace("## Idioma y rol", "## EDITADO A MANO");
    writeFileSync(path, tampered, "utf-8");

    const r = renderAgentsMdEngine(cwd, baseConfig({ preset: "nextjs" }));
    expect(r.skipped).toEqual([{ path: "AGENTS.md", reason: "managed block edited by hand" }]);
    expect(readFileSync(path, "utf-8")).toContain("## EDITADO A MANO"); // untouched
  });
});
