import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
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

const { runGlobalRender, repoBlocksInGlobal } = await import("../global.ts");
const { GlobalConfigSchema } = await import("../../lib/global-config.ts");
const { listGlobalSkillIds } = await import("../../lib/global-skills.ts");

let claudeDir: string;
const savedEnv = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "global-render-home-"));
  claudeDir = mkdtempSync(join(tmpdir(), "global-render-claude-"));
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
});
afterEach(() => {
  rmSync(home.dir, { recursive: true, force: true });
  rmSync(claudeDir, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedEnv;
});

const cfg = (over = {}) => GlobalConfigSchema.parse({ language: "es", permissions: true, ...over });

describe("global render — scope filter", () => {
  it("emits only global/both identity blocks; repo blocks are absent", () => {
    const { target, result } = runGlobalRender(cfg(), { dryRun: false });
    expect(target.baseDir).toBe(claudeDir);
    const md = readFileSync(join(claudeDir, "CLAUDE.md"), "utf-8");
    // both-scope identity blocks land
    expect(md).toContain('id="idioma-rol"');
    expect(md).toContain('id="formato-respuesta"');
    // repo-scope process blocks never land in the persona target
    expect(md).not.toContain('id="orquestacion"');
    expect(md).not.toContain('id="sdd"');
    expect(md).not.toContain('id="arranque-sesion"');
    // computed repo identity blocks (skills/agents/context) absent too
    expect(md).not.toContain('id="skills-index"');
    expect(md).not.toContain('id="agentes-disponibles"');
    expect(result.written.some((w) => w.path === "CLAUDE.md")).toBe(true);
  });

  it("writes NO agents, hooks, scripts or progress (flat, identity-only)", () => {
    runGlobalRender(cfg(), { dryRun: false });
    const entries = readdirSync(claudeDir);
    expect(entries).not.toContain("agents");
    expect(entries).not.toContain("hooks");
    expect(entries).not.toContain("scripts");
    expect(entries).not.toContain("progress");
  });

  it("skills/ carries EXACTLY the bootstrap feature launcher when no catalog skill is enabled", () => {
    runGlobalRender(cfg(), { dryRun: false });
    // app-builder (kind: bootstrap) gets a launcher and is the ONLY entry when
    // the config's skills selection is empty (the default) — an in-repo
    // feature regressing to bootstrap, or any new unconditional writer into
    // skills/, must trip this. No phases/ dir either (those only exist after a
    // repo render — spec 0005 bootstrap discovery).
    expect(readdirSync(join(claudeDir, "skills"))).toEqual(["app-builder"]);
    expect(existsSync(join(claudeDir, "skills/app-builder/SKILL.md"))).toBe(true);
    expect(existsSync(join(claudeDir, "skills/app-builder/phases"))).toBe(false);
  });

  it("skills/ carries EXACTLY the launcher + every enabled catalog skill (exact membership, not contains)", () => {
    const catalogIds = listGlobalSkillIds();
    const c = cfg({ skills: Object.fromEntries(catalogIds.map((id) => [id, { enabled: true }])) });
    runGlobalRender(c, { dryRun: false });
    expect(readdirSync(join(claudeDir, "skills")).sort()).toEqual(["app-builder", ...catalogIds].sort());
    expect(existsSync(join(claudeDir, "skills/app-builder/SKILL.md"))).toBe(true);
    expect(existsSync(join(claudeDir, "skills/work-unit-commits/SKILL.md"))).toBe(true);
  });

  it("writes permissions-only settings.json (no guard/quality-gate hooks)", () => {
    runGlobalRender(cfg(), { dryRun: false });
    const settingsPath = join(claudeDir, "settings.json");
    expect(existsSync(settingsPath)).toBe(true);
    const s = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(Array.isArray(s.permissions.allow)).toBe(true);
    expect(s.permissions.allow.length).toBeGreaterThan(0);
    // no hooks at global scope: the guard/quality-gate scripts are never rendered
    expect(Object.keys(s.hooks ?? {}).length).toBe(0);
    expect(JSON.stringify(s)).not.toContain("guard-destructive");
  });

  it("permissions:false skips settings.json entirely", () => {
    runGlobalRender(cfg({ permissions: false }), { dryRun: false });
    expect(existsSync(join(claudeDir, "settings.json"))).toBe(false);
    expect(existsSync(join(claudeDir, "CLAUDE.md"))).toBe(true);
  });

  it("preview (dryRun) writes nothing to disk", () => {
    runGlobalRender(cfg(), { dryRun: true });
    expect(existsSync(join(claudeDir, "CLAUDE.md"))).toBe(false);
  });
});

describe("global render — settings.json coexist merge (FIX 2)", () => {
  it("preserves a user's hand-added permissions.allow when merging into a non-navori settings.json", () => {
    // A hand-written, non-navori-owned settings.json (no $navori.managed) already
    // exists at the global target. Once navori adopts it the coexist MERGE path
    // runs — the user's own permissions.allow entry must survive.
    const userSettings = { permissions: { allow: ["Bash(my-custom-tool:*)"] } };
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify(userSettings, null, 2) + "\n");

    runGlobalRender(cfg(), { dryRun: false });

    const s = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf-8"));
    expect(s.permissions.allow).toContain("Bash(my-custom-tool:*)");
    // navori never takes ownership on the coexist path (file stays hybrid).
    expect(s.$navori?.managed).not.toBe(true);
  });
});

describe("global render — idempotency (FIX 3)", () => {
  it("a second --apply render writes nothing (all unchanged)", () => {
    runGlobalRender(cfg(), { dryRun: false });
    const second = runGlobalRender(cfg(), { dryRun: false });
    expect(second.result.written.length).toBe(0);
  });

  it("stays idempotent with a global-allowed plugin (engram) enabled", () => {
    const c = cfg({ plugins: { engram: { enabled: true } } });
    runGlobalRender(c, { dryRun: false });
    // engram's identity block landed in the persona CLAUDE.md…
    const md = readFileSync(join(claudeDir, "CLAUDE.md"), "utf-8");
    expect(md).toContain('id="engram-protocol"');
    // …and the second pass is a no-op.
    const second = runGlobalRender(c, { dryRun: false });
    expect(second.result.written.length).toBe(0);
  });
});

describe("global doctor — repoBlocksInGlobal (FIX 5)", () => {
  it("flags a repo-scoped block rendered into the global target", () => {
    const { target } = runGlobalRender(cfg(), { dryRun: false });
    // simulate a scope violation: a repo-only (scope:repo) block in ~/.claude.
    appendFileSync(
      join(claudeDir, "CLAUDE.md"),
      '\n<!-- navori:managed id="orquestacion" hash="deadbeef" source="@navori/core" -->\nx\n<!-- /navori:managed id="orquestacion" -->\n',
    );
    expect(repoBlocksInGlobal(target.claudeMd)).toContain("orquestacion");
  });

  it("is clean for a well-formed global render (no repo blocks leaked)", () => {
    const { target } = runGlobalRender(cfg(), { dryRun: false });
    expect(repoBlocksInGlobal(target.claudeMd)).toEqual([]);
  });
});

describe("global render — coexist adoption", () => {
  it("preserves a hand-written ~/.claude/CLAUDE.md and backs it up before writing", () => {
    const handWritten = "# My own orchestration protocol\n\nAlways do FOO before BAR.\n";
    writeFileSync(join(claudeDir, "CLAUDE.md"), handWritten);

    const { result } = runGlobalRender(cfg(), { dryRun: false });

    const md = readFileSync(join(claudeDir, "CLAUDE.md"), "utf-8");
    // user content outside markers is preserved verbatim
    expect(md).toContain("Always do FOO before BAR.");
    // navori identity is now injected around it
    expect(md).toContain('id="idioma-rol"');
    // a backup was taken before the write
    expect(result.backupPath).toBeTruthy();
    const backupRoot = join(home.dir, ".navori", "backups");
    expect(existsSync(backupRoot)).toBe(true);
    const backups = readdirSync(backupRoot);
    expect(backups.length).toBeGreaterThan(0);
  });
});
