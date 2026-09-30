import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NavoriConfigInput } from "../../../lib/config/schema.ts";

/**
 * #1114: rendering over an existing agent/skill file that carries no navori
 * marker adopts it by name (frontmatter merged, body kept). The engine must say
 * so through `warnings` — once — naming the overwritten frontmatter keys and,
 * on apply, the backup that holds the original.
 */
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock(import("../../../lib/primitives/home.ts"), () => ({ safeHomedir: () => home.dir }));

const { writeConfig, readConfig } = await import("../../../lib/config/config.ts");
const { renderClaudeEngine } = await import("../../claude/index.ts");
const { renderCodexEngine } = await import("../../codex/index.ts");

/**
 * Per engine: the colliding core file, a second colliding file, and a
 * non-colliding user file. Codex agents render as `.codex/agents/*.toml` from a
 * body (no asset frontmatter), so only its skills go through the adopt-by-name
 * merge; the Codex orchestrator has no agent file at all.
 */
const ENGINES = [
  {
    id: "claude",
    render: renderClaudeEngine,
    target: ".claude/agents/orchestrator.md",
    second: ".claude/skills/verify-before-done/SKILL.md",
    mine: ".claude/agents/my-agent.md",
  },
  {
    id: "codex",
    render: renderCodexEngine,
    target: ".agents/skills/verify-before-done/SKILL.md",
    second: ".agents/skills/debug-failure/SKILL.md",
    mine: ".agents/skills/my-skill/SKILL.md",
  },
] as const;
const USER_AGENT = [
  "---",
  "description: MY custom orchestrator",
  "model: haiku",
  "color: red",
  "---",
  "USER BODY LINE 1",
  "USER BODY LINE 2",
  "",
].join("\n");

let cwd: string;
let engine: (typeof ENGINES)[number];

function setup(): void {
  home.dir = mkdtempSync(join(tmpdir(), "navori-home-"));
  cwd = mkdtempSync(join(tmpdir(), "navori-collision-"));
  const input: NavoriConfigInput = { name: "demo", preset: "custom", engines: [engine.id] };
  writeConfig(join(cwd, "navori.config.json"), input);
}

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home.dir, { recursive: true, force: true });
});

function put(rel: string, content: string): void {
  const abs = join(cwd, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf-8");
}

function render(dryRun: boolean) {
  return engine.render(cwd, readConfig(join(cwd, "navori.config.json")), { dryRun });
}

const collisionWarnings = (warnings: string[], rel: string): string[] =>
  warnings.filter(
    (w) =>
      w.includes(rel) && /existía sin marcador de navori|existed without a navori marker/.test(w),
  );

describe.each(ENGINES)("marker-less collision warning (#1114) — $id", (e) => {
  const ORCH = e.target;
  const SKILL = e.second;
  beforeEach(() => {
    engine = e;
    setup();
  });

  it("stays silent on a fresh repo", () => {
    const r = render(false);
    expect(collisionWarnings(r.warnings, ORCH)).toEqual([]);
    expect(collisionWarnings(r.warnings, SKILL)).toEqual([]);
  });

  it("dry run warns with the overwritten keys and no backup path", () => {
    put(ORCH, USER_AGENT);
    const r = render(true);
    const [w] = collisionWarnings(r.warnings, ORCH);
    expect(w).toBeDefined();
    expect(w).toContain("description");
    expect(w).not.toContain("model");
    expect(w).not.toMatch(/Respaldo|backed up/);
    expect(readFileSync(join(cwd, ORCH), "utf-8")).toBe(USER_AGENT);
  });

  it("apply warns, names the backup holding the original, and keeps foreign keys and body", () => {
    put(ORCH, USER_AGENT);
    put(SKILL, "USER SKILL\n");
    const r = render(false);
    const [w] = collisionWarnings(r.warnings, ORCH);
    expect(w).toContain("description");
    expect(r.backupPath).not.toBeNull();
    const backedUp = join(r.backupPath as string, ORCH);
    expect(w).toContain(backedUp);
    expect(readFileSync(backedUp, "utf-8")).toBe(USER_AGENT);
    expect(collisionWarnings(r.warnings, SKILL)).toHaveLength(1);

    const after = readFileSync(join(cwd, ORCH), "utf-8");
    expect(after).toContain("model: haiku");
    expect(after).toContain("color: red");
    expect(after).toContain("USER BODY LINE 1\nUSER BODY LINE 2\n");
    expect(after).not.toContain("MY custom orchestrator");
  });

  it("does not repeat on the second render", () => {
    put(ORCH, USER_AGENT);
    render(false);
    const r = render(false);
    expect(collisionWarnings(r.warnings, ORCH)).toEqual([]);
  });

  it("ignores non-colliding user agents", () => {
    put(e.mine, "---\ndescription: mine\n---\nbody\n");
    const r = render(false);
    expect(collisionWarnings(r.warnings, e.mine)).toEqual([]);
    expect(readFileSync(join(cwd, e.mine), "utf-8")).toBe("---\ndescription: mine\n---\nbody\n");
    expect(existsSync(join(cwd, ORCH))).toBe(true);
  });
});
