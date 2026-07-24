import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic on two axes (spec 0005 §6 safety): ~/.navori (backups) → throwaway
// home via the home.ts mock; the global render TARGET → a temp CLAUDE_CONFIG_DIR.
// Neither the real $HOME/.claude nor ~/.navori is ever touched.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("../../lib/home.ts", () => ({
  safeHomedir: () => home.dir,
  globalConfigDir: () => process.env.CLAUDE_CONFIG_DIR || join(home.dir, ".claude"),
}));

const { runGlobalRender } = await import("../global.ts");
const { GlobalConfigSchema } = await import("../../lib/global-config.ts");
const { GLOBAL_SKILLS_CATALOG, listGlobalSkillIds } = await import("../../lib/global-skills.ts");

let claudeDir: string;
const savedEnv = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "global-skills-home-"));
  claudeDir = mkdtempSync(join(tmpdir(), "global-skills-claude-"));
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
});
afterEach(() => {
  rmSync(home.dir, { recursive: true, force: true });
  rmSync(claudeDir, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedEnv;
});

const cfg = (over = {}) => GlobalConfigSchema.parse({ language: "es", permissions: true, ...over });
const skillsCfg = (ids: string[]) => cfg({ skills: Object.fromEntries(ids.map((id) => [id, { enabled: true }])) });
const skillPath = (id: string, rel = "SKILL.md") => join(claudeDir, "skills", id, rel);

describe("global render — catalog skills", () => {
  it("no skills enabled by default: nothing beyond the app-builder launcher lands in skills/", () => {
    runGlobalRender(cfg(), { dryRun: false });
    for (const id of listGlobalSkillIds()) {
      expect(existsSync(skillPath(id))).toBe(false);
    }
  });

  it("a selected core skill lands as skills/<id>/SKILL.md with intact frontmatter", () => {
    const { result } = runGlobalRender(skillsCfg(["pr-create"]), { dryRun: false });
    expect(existsSync(skillPath("pr-create"))).toBe(true);
    const md = readFileSync(skillPath("pr-create"), "utf-8");
    expect(md).toContain("name: pr-create");
    expect(md).toMatch(/^description:/m);
    expect(result.written.some((w) => w.path === "skills/pr-create/SKILL.md" && w.status === "created")).toBe(
      true,
    );
  });

  it("a selected promoted dir skill lands with its aux file(s)", () => {
    runGlobalRender(skillsCfg(["ship-docs"]), { dryRun: false });
    expect(existsSync(skillPath("ship-docs"))).toBe(true);
    expect(existsSync(skillPath("ship-docs", "references/ship-docs-playbook.md"))).toBe(true);
    const md = readFileSync(skillPath("ship-docs"), "utf-8");
    expect(md).toContain("name: ship-docs");
  });

  it("a promoted skill's frontmatter (name/description/metadata.author) stays intact", () => {
    runGlobalRender(skillsCfg(["work-unit-commits"]), { dryRun: false });
    const md = readFileSync(skillPath("work-unit-commits"), "utf-8");
    expect(md).toContain("name: work-unit-commits");
    expect(md).toContain("author: gentleman-programming");
  });

  it("dry-run writes nothing for a selected skill", () => {
    const { result } = runGlobalRender(skillsCfg(["pr-create"]), { dryRun: true });
    expect(existsSync(skillPath("pr-create"))).toBe(false);
    expect(result.written.some((w) => w.path === "skills/pr-create/SKILL.md")).toBe(true);
  });

  it("a second render of the same selection is a no-op (idempotent)", () => {
    const c = skillsCfg(["pr-create", "ship-docs"]);
    runGlobalRender(c, { dryRun: false });
    const second = runGlobalRender(c, { dryRun: false });
    expect(second.result.written.length).toBe(0);
  });

  it("hand-editing the rendered frontmatter is corrected back on next render (asset wins → updated)", () => {
    const c = skillsCfg(["work-unit-commits"]);
    runGlobalRender(c, { dryRun: false });
    const path = skillPath("work-unit-commits");
    const stale = readFileSync(path, "utf-8").replace(/^description: .*$/m, 'description: "stale description"');
    writeFileSync(path, stale);

    const { result } = runGlobalRender(c, { dryRun: false });

    expect(
      result.written.some((w) => w.path === "skills/work-unit-commits/SKILL.md" && w.status === "updated"),
    ).toBe(true);
    expect(readFileSync(path, "utf-8")).not.toContain("stale description");
  });

  it("an unknown skill id in config is silently skipped, not an error", () => {
    expect(() => runGlobalRender(cfg({ skills: { "not-a-real-skill": { enabled: true } } }), { dryRun: false }),
    ).not.toThrow();
  });

  it("disabling a previously-enabled skill leaves the old render on disk (no GC — documented, not a bug)", () => {
    const enabled = skillsCfg(["pr-create"]);
    runGlobalRender(enabled, { dryRun: false });
    expect(existsSync(skillPath("pr-create"))).toBe(true);
    const disabled = cfg({ skills: { "pr-create": { enabled: false } } });
    runGlobalRender(disabled, { dryRun: false });
    expect(existsSync(skillPath("pr-create"))).toBe(true); // orphaned, not removed
  });

  it("skills/ dir has EXACT membership: the app-builder launcher + every enabled catalog skill, nothing else", () => {
    const allIds = listGlobalSkillIds();
    runGlobalRender(skillsCfg(allIds), { dryRun: false });
    const entries = readdirSync(join(claudeDir, "skills")).sort();
    expect(entries).toEqual(["app-builder", ...allIds].sort());
  });
});

describe("global render — real skill-creator asset (folded block scalar regression)", () => {
  // SKILL-TEMPLATE.md (skill-creator's aux file) carries `description: >` — a
  // YAML folded block scalar. The old line-based frontmatter heuristic pushed
  // the bare `>` onto its own line and then dropped it on the next parse,
  // corrupting the template. Raw-line preservation must keep it verbatim AND
  // converge (second render a no-op).
  it("renders skill-creator twice: second render unchanged, `>` still on the description line", () => {
    const c = skillsCfg(["skill-creator"]);
    runGlobalRender(c, { dryRun: false });
    const second = runGlobalRender(c, { dryRun: false });
    expect(second.result.written.length).toBe(0);

    const template = readFileSync(skillPath("skill-creator", "assets/SKILL-TEMPLATE.md"), "utf-8");
    expect(template).toContain("description: >\n");
    expect(template).toContain("  {Brief description of what this skill enables}.");
    expect(template).toContain("metadata:\n  author: gentleman-programming");

    const md = readFileSync(skillPath("skill-creator"), "utf-8");
    expect(md).toContain("metadata:\n  author: gentleman-programming");
  });
});

describe("global render — repo-flavored template vars resolve at global scope", () => {
  it("no globally-rendered core skill leaves an unresolved {{...}} placeholder", () => {
    const coreSkillIds = GLOBAL_SKILLS_CATALOG.filter((e) => e.source === "core-skill").map((e) => e.id);
    runGlobalRender(skillsCfg(coreSkillIds), { dryRun: false });
    for (const id of coreSkillIds) {
      const md = readFileSync(skillPath(id), "utf-8");
      expect(md, `${id} must not contain a literal {{`).not.toContain("{{");
    }
  });

  it("no globally-rendered core skill leaks a '<not configured: ...>' fallback", () => {
    // interpolate() never leaves a literal {{...}} — a var missing from
    // GLOBAL_SKILL_TEMPLATE_DEFAULTS surfaces as placeholderFallback()'s
    // '<not configured: path>' instead. Guard the whole catalog so any future
    // skill introducing a new repo-coupled var fails here, not in ~/.claude.
    const coreSkillIds = GLOBAL_SKILLS_CATALOG.filter((e) => e.source === "core-skill").map((e) => e.id);
    runGlobalRender(skillsCfg(coreSkillIds), { dryRun: false });
    for (const id of coreSkillIds) {
      const md = readFileSync(skillPath(id), "utf-8");
      expect(md, `${id} must not contain a '<not configured:' fallback`).not.toContain("<not configured:");
    }
  });

  it("pr-create resolves prTarget/branchBase to neutral 'main' defaults", () => {
    runGlobalRender(skillsCfg(["pr-create"]), { dryRun: false });
    const md = readFileSync(skillPath("pr-create"), "utf-8");
    expect(md).toContain("gh pr create --base main");
  });

  it("verify-before-done resolves qualityGate.fast to a generic, repo-agnostic phrasing", () => {
    runGlobalRender(skillsCfg(["verify-before-done"]), { dryRun: false });
    const md = readFileSync(skillPath("verify-before-done"), "utf-8");
    expect(md).not.toContain("{{qualityGate.fast}}");
    expect(md.toLowerCase()).toContain("quality gate");
  });

  it("verify-before-done resolves project.criticalAreas to a repo-config pointer, not '<not configured: ...>'", () => {
    runGlobalRender(skillsCfg(["verify-before-done"]), { dryRun: false });
    const md = readFileSync(skillPath("verify-before-done"), "utf-8");
    expect(md).not.toContain("{{project.criticalAreas}}");
    expect(md).not.toContain("<not configured: project.criticalAreas>");
    expect(md).toContain("las áreas críticas declaradas en la config del repo");
  });

  it("review-diff resolves project.criticalAreas to a repo-config pointer, not '<not configured: ...>'", () => {
    runGlobalRender(skillsCfg(["review-diff"]), { dryRun: false });
    const md = readFileSync(skillPath("review-diff"), "utf-8");
    expect(md).not.toContain("{{project.criticalAreas}}");
    expect(md).not.toContain("<not configured: project.criticalAreas>");
    expect(md).toContain("las áreas críticas declaradas en la config del repo");
  });

  it("loop-back-debug resolves project.legacyPaths to a repo-config pointer, not '<not configured: ...>'", () => {
    runGlobalRender(skillsCfg(["loop-back-debug"]), { dryRun: false });
    const md = readFileSync(skillPath("loop-back-debug"), "utf-8");
    expect(md).not.toContain("{{project.legacyPaths}}");
    expect(md).not.toContain("<not configured: project.legacyPaths>");
    expect(md).toContain("las rutas legacy declaradas en la config del repo");
  });
});
