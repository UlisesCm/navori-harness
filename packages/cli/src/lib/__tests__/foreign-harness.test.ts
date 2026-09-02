import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanForeignHarness } from "../foreign-harness.ts";
import { injectManagedSection } from "../marker.ts";
import { readCliVersion } from "../bundled-assets.ts";
import { NavoriConfigSchema, type NavoriConfig } from "../schema.ts";

/**
 * Spec 0014 (#555) — the harness that was already there when navori arrived.
 *
 * The defect is silence: two assets share a name, one wins by precedence, and
 * the other is inert with nothing to show for it. Verified on the author's
 * machine — `~/.claude/skills/verify-before-done.md` shadows navori's own skill
 * of that name, user-section included — which is the fixture below.
 *
 * The two things these specs defend, in order:
 *
 *  - **Only conflict is reported.** A foreign harness that steps on nothing is
 *    never mentioned. Without that filter doctor prints the same section in
 *    every repo forever, and the advisory becomes noise (R2).
 *  - **The winner is named right.** Precedence is NOT uniform: for agents the
 *    repo wins, for skills the personal copy does. A single rule would name the
 *    wrong winner half the time, and the reader acts on the name (R5).
 */

let cwd: string;
let claudeDir: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-foreign-repo-"));
  claudeDir = mkdtempSync(join(tmpdir(), "navori-foreign-home-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(claudeDir, { recursive: true, force: true });
});

/** A file exactly as navori renders it: managed marker, current version. */
function managed(body: string, id = "block"): string {
  return injectManagedSection("", id, `${body}\n`, {
    version: readCliVersion(),
    source: "@navori/core",
  }).output;
}

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

/** An agent navori manages in this repo. */
function navoriAgent(name: string): void {
  write(join(cwd, ".claude", "agents", `${name}.md`), managed(`# ${name}`, `${name}-base`));
}

/** A skill navori manages in this repo (directory layout, with SKILL.md). */
function navoriSkill(name: string): void {
  write(join(cwd, ".claude", "skills", name, "SKILL.md"), managed(`# ${name}`, name));
}

function personalAgent(name: string): void {
  write(join(claudeDir, "agents", `${name}.md`), `# my own ${name}\n`);
}

function personalSkill(name: string): void {
  write(join(claudeDir, "skills", `${name}.md`), `# my own ${name}\n`);
}

/** Somebody else's `@skills-dir` plugin, with one agent and one skill. */
function foreignPlugin(id: string, assets: { agent?: string; skill?: string }): void {
  write(join(claudeDir, "skills", id, ".claude-plugin", "plugin.json"), '{"name":"other"}\n');
  if (assets.agent) write(join(claudeDir, "skills", id, "agents", `${assets.agent}.md`), "# a\n");
  if (assets.skill) {
    write(join(claudeDir, "skills", id, "skills", assets.skill, "SKILL.md"), "# s\n");
  }
}

function config(over: Partial<NavoriConfig> = {}): NavoriConfig {
  return NavoriConfigSchema.parse({ name: "demo", engines: ["claude"], preset: "custom", ...over });
}

function scan(cfg: NavoriConfig = config()) {
  return scanForeignHarness(cwd, cfg, { claudeDir, globalLayerInstalled: false });
}

describe("only a real conflict is reported (R1, R2)", () => {
  it("says nothing about a foreign harness that steps on nothing", () => {
    navoriAgent("reviewer");
    navoriSkill("review-diff");
    // A whole personal harness, none of it sharing a name with navori's.
    personalAgent("my-refactorer");
    personalSkill("systematic-debug");
    foreignPlugin("acme", { agent: "acme-linter", skill: "acme-deploy" });

    const report = scan();
    expect(report?.conflicts).toEqual([]);
    expect(report?.permissions).toEqual([]);
  });

  it("says nothing in a healthy navori repo whose agents exist in two scopes", () => {
    // The anti-noise case #547 settled: navori's own global plugin ships the
    // same eight agents BY DESIGN. A same-named file is not the discriminant.
    navoriAgent("reviewer");
    navoriAgent("implementer");
    write(
      join(claudeDir, "skills", "navori", ".claude-plugin", "plugin.json"),
      '{"name":"navori"}\n',
    );
    write(join(claudeDir, "skills", "navori", "agents", "reviewer.md"), "# navori's own\n");
    write(join(claudeDir, "skills", "navori", "agents", "implementer.md"), "# navori's own\n");

    expect(scan()?.conflicts).toEqual([]);
  });

  it("returns null when the repo renders no Claude output", () => {
    navoriAgent("reviewer");
    personalAgent("reviewer");
    expect(scanForeignHarness(cwd, config({ engines: ["codex"] }), { claudeDir })).toBeNull();
  });
});

describe("the winner is named by asset type, not by one rule (R4, R5)", () => {
  it("gives an agent to the repo", () => {
    navoriAgent("reviewer");
    personalAgent("reviewer");

    const [conflict] = scan()?.conflicts ?? [];
    expect(conflict?.type).toBe("agent");
    expect(conflict?.scope).toBe("personal");
    expect(conflict?.winner).toBe("navori");
    expect(conflict?.navoriPath).toBe(join(".claude", "agents", "reviewer.md"));
    expect(conflict?.foreignPath).toBe(join(claudeDir, "agents", "reviewer.md"));
  });

  it("gives a skill to the personal copy — the case that motivated the spec", () => {
    // Both layouts at once, exactly as they sit on the author's machine: the
    // personal skill is a flat `.md`, navori's is a directory with SKILL.md.
    navoriSkill("verify-before-done");
    personalSkill("verify-before-done");

    const [conflict] = scan()?.conflicts ?? [];
    expect(conflict?.type).toBe("skill");
    expect(conflict?.winner).toBe("foreign");
    expect(conflict?.id).toBe("skill:personal:verify-before-done");
    // Nothing to adopt: navori reads outside the repo and never writes there.
    expect(conflict?.adoptable).toBe(false);
  });

  it("reports a plugin's agent this repo makes inert, and NEVER its skills", () => {
    navoriAgent("reviewer");
    navoriSkill("review-diff");
    foreignPlugin("acme", { agent: "reviewer", skill: "review-diff" });

    const conflicts = scan()?.conflicts ?? [];
    // The skill collides by name and is still absent: a plugin skill is invoked
    // `/acme:review-diff`, so by construction it collides with nothing (R5).
    expect(conflicts.map((c) => c.id)).toEqual(["agent:plugin:reviewer"]);
    expect(conflicts[0]?.winner).toBe("navori");
    expect(conflicts[0]?.pluginId).toBe("acme");
  });

  it("calls a same-scope skill collision undecided instead of inventing a winner", () => {
    // Two layouts of the same name inside the repo. Which one Claude Code loads
    // is not documented, and a guess here would be read as fact.
    navoriSkill("review-diff");
    write(join(cwd, ".claude", "skills", "review-diff.md"), "# mine\n");

    const [conflict] = scan()?.conflicts ?? [];
    expect(conflict?.id).toBe("skill:repo:review-diff");
    expect(conflict?.winner).toBe("undecided");
    // It lives in the repo, so this one navori CAN take over.
    expect(conflict?.adoptable).toBe(true);
  });
});

describe("the conflict id is stable and portable (R10)", () => {
  it("carries no absolute path and no ordering", () => {
    navoriAgent("reviewer");
    personalAgent("reviewer");
    navoriSkill("verify-before-done");
    personalSkill("verify-before-done");

    const ids = (scan()?.conflicts ?? []).map((c) => c.id);
    expect(ids).toEqual(["agent:personal:reviewer", "skill:personal:verify-before-done"]);
    for (const id of ids) expect(id).not.toContain("/");
  });
});

describe("permission contradictions and the gitignored signal (R3, R6)", () => {
  function repoSettings(deny: string[]): void {
    write(
      join(cwd, ".claude", "settings.json"),
      `${JSON.stringify({ permissions: { deny } }, null, 2)}\n`,
    );
  }

  it("names the foreign file that allows what navori denies", () => {
    repoSettings(["Bash(rm -rf:*)"]);
    write(
      join(cwd, ".claude", "settings.local.json"),
      `${JSON.stringify({ permissions: { allow: ["Bash(rm -rf:*)", "Bash(ls:*)"] } }, null, 2)}\n`,
    );

    expect(scan()?.permissions).toEqual([
      { rule: "Bash(rm -rf:*)", path: join(".claude", "settings.local.json") },
    ]);
  });

  it("reads the personal settings too, and stays quiet on a deny nobody contradicts", () => {
    repoSettings(["Bash(rm -rf:*)"]);
    write(
      join(claudeDir, "settings.json"),
      `${JSON.stringify({ permissions: { allow: ["Bash(rm -rf:*)"] } }, null, 2)}\n`,
    );
    expect(scan()?.permissions).toEqual([
      { rule: "Bash(rm -rf:*)", path: join(claudeDir, "settings.json") },
    ]);

    // …and a deny that nothing allows produces no row at all.
    rmSync(join(claudeDir, "settings.json"));
    expect(scan()?.permissions).toEqual([]);
  });

  it("leaves the personal settings to #547 when navori's global layer is installed", () => {
    // `scanGlobalScope` already compares that exact pair. One rule printed in
    // two sections teaches the reader that the sections overlap.
    repoSettings(["Bash(rm -rf:*)"]);
    write(
      join(claudeDir, "settings.json"),
      `${JSON.stringify({ permissions: { allow: ["Bash(rm -rf:*)"] } }, null, 2)}\n`,
    );
    const report = scanForeignHarness(cwd, config(), { claudeDir, globalLayerInstalled: true });
    expect(report?.permissions).toEqual([]);
  });

  it("marks a foreign repo asset that git ignores", () => {
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd, stdio: "ignore" });
    navoriSkill("review-diff");
    write(join(cwd, ".claude", "skills", "review-diff.md"), "# mine\n");
    write(join(cwd, ".gitignore"), ".claude/skills/review-diff.md\n");

    expect(scan()?.conflicts[0]?.gitignored).toBe(true);
  });

  it("does not mark one that git tracks", () => {
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd, stdio: "ignore" });
    navoriSkill("review-diff");
    write(join(cwd, ".claude", "skills", "review-diff.md"), "# mine\n");

    expect(scan()?.conflicts[0]?.gitignored).toBeUndefined();
  });
});

describe("silencing a conflict without deleting anything (R8, R9)", () => {
  const withAcknowledged = (ids: string[]): NavoriConfig =>
    config({ project: { foreignHarness: { acknowledged: ids } } } as Partial<NavoriConfig>);

  it("drops a conflict the repo declared as assumed", () => {
    navoriSkill("verify-before-done");
    personalSkill("verify-before-done");
    navoriAgent("reviewer");
    personalAgent("reviewer");

    const report = scan(withAcknowledged(["skill:personal:verify-before-done"]));
    // Silenced, and ONLY that one: an acknowledgement is per conflict.
    expect(report?.conflicts.map((c) => c.id)).toEqual(["agent:personal:reviewer"]);
    expect(report?.staleAcknowledged).toEqual([]);
  });

  it("reports an acknowledgement that no longer matches anything", () => {
    navoriSkill("verify-before-done");
    personalSkill("verify-before-done");

    const report = scan(
      withAcknowledged(["skill:personal:verify-before-done", "agent:personal:reviewer"]),
    );
    // The resolved one is dead weight and says so, so the list can only shrink.
    expect(report?.staleAcknowledged).toEqual(["agent:personal:reviewer"]);
    expect(report?.conflicts).toEqual([]);
  });
});

describe("an unreadable environment is not doctor's to crash on (R17)", () => {
  it("returns empty rather than throwing when the personal scope does not exist", () => {
    navoriAgent("reviewer");
    rmSync(claudeDir, { recursive: true, force: true });
    expect(scan()?.conflicts).toEqual([]);
  });
});
