import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderNonClaudeEngines } from "../../../commands/render.ts";
import { NavoriConfigSchema } from "../../../lib/config/schema.ts";
import { renderPiEngine } from "../index.ts";

const dirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "navori-pi-context-"));
  dirs.push(dir);
  return dir;
}
function cfg(engines: string[]) {
  return NavoriConfigSchema.parse({
    name: "pi-context",
    preset: "custom",
    engines,
    branchBase: "main",
    qualityGate: { fast: "bun test", full: "bun test" },
  });
}
const BLOCK_OPEN = /<!-- navori:managed id="navori-agents"/g;
const read = (dir: string, rel: string): string => readFileSync(join(dir, rel), "utf-8");
const blockCount = (text: string): number => text.match(BLOCK_OPEN)?.length ?? 0;

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Pi-only bootstrap and multiengine ownership", () => {
  // Covers: R16
  it("emits natively discovered AGENTS.md and skills for a Pi-only project, without Claude files", () => {
    const dir = freshDir();
    const result = renderPiEngine(dir, cfg(["pi"]));
    expect(result.written.map((w) => w.path)).toContain("AGENTS.md");
    const agents = read(dir, "AGENTS.md");
    expect(blockCount(agents)).toBe(1);
    expect(agents).toContain("## Workflow");
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(dir, ".claude"))).toBe(false);
    expect(existsSync(join(dir, ".codex"))).toBe(false);
    // Covers: R16 (skills path validation: Pi discovers .agents/skills/<id>/SKILL.md)
    const skills = readdirSync(join(dir, ".agents/skills"));
    expect(skills.length).toBeGreaterThan(0);
    for (const id of skills)
      expect(existsSync(join(dir, ".agents/skills", id, "SKILL.md"))).toBe(true);
    // The emitted instructions never point at paths that do not exist for Pi.
    expect(agents).not.toContain(".claude/skills");
    expect(agents).not.toContain("CLAUDE.md");
  });

  // Covers: R16, R11
  it("keeps a single AGENTS.md writer through Pi -> Pi+Codex -> Pi", () => {
    const dir = freshDir();
    renderNonClaudeEngines(dir, cfg(["pi"]), ["pi"], false);
    expect(blockCount(read(dir, "AGENTS.md"))).toBe(1);

    const both = cfg(["pi", "codex"]);
    const multi = renderNonClaudeEngines(dir, both, ["pi", "codex"], false);
    const piSummary = multi.find((s) => s.engine === "pi")!;
    expect(piSummary.written.map((w) => w.path)).not.toContain("AGENTS.md");
    expect(piSummary.skipped.map((s) => s.path)).not.toContain("AGENTS.md");
    expect(multi.find((s) => s.engine === "codex")!.written.map((w) => w.path)).toContain(
      "AGENTS.md",
    );
    const shared = read(dir, "AGENTS.md");
    expect(blockCount(shared)).toBe(1);

    // Re-render is idempotent: neither engine rewrites AGENTS.md a second time.
    const again = renderNonClaudeEngines(dir, both, ["pi", "codex"], false);
    expect(again.flatMap((s) => s.written).map((w) => w.path)).not.toContain("AGENTS.md");
    expect(read(dir, "AGENTS.md")).toBe(shared);

    renderNonClaudeEngines(dir, cfg(["pi"]), ["pi"], false);
    expect(blockCount(read(dir, "AGENTS.md"))).toBe(1);
  });

  // Covers: R11
  it("preserves foreign AGENTS.md content across ownership transitions", () => {
    const dir = freshDir();
    const foreign = "# Team rules\n\nNever deploy on Fridays.\n";
    writeFileSync(join(dir, "AGENTS.md"), foreign);
    renderNonClaudeEngines(dir, cfg(["pi"]), ["pi"], false);
    let text = read(dir, "AGENTS.md");
    expect(text).toContain("Never deploy on Fridays.");
    expect(blockCount(text)).toBe(1);
    renderNonClaudeEngines(dir, cfg(["pi", "codex"]), ["pi", "codex"], false);
    renderNonClaudeEngines(dir, cfg(["pi"]), ["pi"], false);
    text = read(dir, "AGENTS.md");
    expect(text).toContain("Never deploy on Fridays.");
    expect(blockCount(text)).toBe(1);
  });

  // Covers: R11
  it("does not overwrite an edited managed block and reports the collision", () => {
    const dir = freshDir();
    renderPiEngine(dir, cfg(["pi"]));
    const edited = read(dir, "AGENTS.md").replace("## Workflow", "## Workflow (my edit)");
    writeFileSync(join(dir, "AGENTS.md"), edited);
    const result = renderPiEngine(dir, cfg(["pi"]));
    expect(read(dir, "AGENTS.md")).toBe(edited);
    expect(result.skipped.map((s) => s.path)).toContain("AGENTS.md");
  });

  // Covers: R11
  it("writes nothing to AGENTS.md when Pi is disabled", () => {
    const dir = freshDir();
    const result = renderNonClaudeEngines(dir, cfg(["claude"]), ["claude"], false);
    expect(result).toEqual([]);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
    // Disabling Pi after a render leaves the shared file and its content untouched.
    renderPiEngine(dir, cfg(["pi"]));
    const before = read(dir, "AGENTS.md");
    renderNonClaudeEngines(dir, cfg(["claude"]), ["claude"], false);
    expect(read(dir, "AGENTS.md")).toBe(before);
  });

  // Covers: R11, R16
  it("a partial Pi render under shared ownership does not become a second writer", () => {
    const dir = freshDir();
    const both = cfg(["pi", "codex"]);
    renderNonClaudeEngines(dir, both, ["codex"], false);
    const owned = read(dir, "AGENTS.md");
    // Only Pi is requested, but Codex is still configured and owns the file.
    const partial = renderNonClaudeEngines(dir, both, ["pi"], false);
    expect(partial.flatMap((s) => s.written).map((w) => w.path)).not.toContain("AGENTS.md");
    expect(read(dir, "AGENTS.md")).toBe(owned);
    expect(blockCount(owned)).toBe(1);
  });

  // Covers: R11
  it("dedups with agents-md and dry-run never writes", () => {
    const dir = freshDir();
    renderNonClaudeEngines(dir, cfg(["pi", "agents-md"]), ["pi", "agents-md"], false);
    expect(blockCount(read(dir, "AGENTS.md"))).toBe(1);
    const clean = freshDir();
    const dry = renderPiEngine(clean, cfg(["pi"]), { dryRun: true });
    expect(dry.written.map((w) => w.path)).toContain("AGENTS.md");
    expect(existsSync(join(clean, "AGENTS.md"))).toBe(false);
  });
});
