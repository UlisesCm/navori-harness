import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalConfig } from "../global-config.ts";
import { NavoriConfigSchema, type NavoriConfig } from "../schema.ts";

/**
 * Spec 0010 FC (#547) — the repo doctor's cross-scope checks.
 *
 * `scanGlobalScope` reaches into `~/.navori/global.json`, so this spec mocks
 * `safeHomedir` to a throwaway dir: without it the suite would read (and the
 * helpers could write into) the developer's REAL machine-global store, which
 * the isolation guard (#404/#424) rightly fails the run over. That mock is
 * file-scoped and hoisted — it cannot be narrowed to a describe — which is why
 * these specs live in their own file.
 */
const home = vi.hoisted(() => ({ dir: "", fail: false }));
vi.mock("../home.ts", () => ({
  safeHomedir: () => {
    if (home.fail) throw new Error("HOME env var is empty or not absolute");
    return home.dir;
  },
}));

const { defaultManagedSettingsPath, scanGlobalScope } = await import("../global-scope.ts");
const { defaultGlobalConfig, writeGlobalConfig } = await import("../global-config.ts");
const { readCliVersion } = await import("../bundled-assets.ts");
const { composeBaseline, generateHookScript } = await import(
  "../../engines/claude/global-render.ts"
);
const { PLUGIN_HOOK_SCRIPT_REL, PLUGIN_MANIFEST_REL, globalPluginDir } = await import(
  "../../engines/claude/global-plugin.ts"
);
const { tc } = await import("../i18n.ts");

let repo: string;
let claudeDir: string;
let policyPath: string;
const savedEnv = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "navori-gscope-home-"));
  home.fail = false;
  claudeDir = mkdtempSync(join(tmpdir(), "navori-gscope-claude-"));
  repo = mkdtempSync(join(tmpdir(), "navori-gscope-repo-"));
  // Always injected, never defaulted: the real path is `/Library/...` or
  // `/etc/...`, and a machine that happens to carry an org policy would
  // otherwise leak findings into every spec below.
  policyPath = join(mkdtempSync(join(tmpdir(), "navori-gscope-policy-")), "managed-settings.json");
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedEnv;
  for (const dir of [home.dir, claudeDir, repo, dirname(policyPath)]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function config(overrides: Partial<NavoriConfig> = {}): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "gscope",
    engines: ["claude"],
    preset: "custom",
    branchBase: "main",
    qualityGate: { fast: "pnpm test", full: "pnpm test" },
    ...overrides,
  });
}

/** Install the sentinel: `~/.navori/global.json`. */
function installGlobal(): GlobalConfig {
  const cfg = defaultGlobalConfig(readCliVersion());
  writeGlobalConfig(cfg);
  return cfg;
}

/** Install the plugin manifest (what makes Claude Code load the dir) + agents. */
function installPlugin(agentIds: string[] = []): void {
  const manifest = join(globalPluginDir(claudeDir), PLUGIN_MANIFEST_REL);
  mkdirSync(dirname(manifest), { recursive: true });
  writeFileSync(manifest, JSON.stringify({ name: "navori", version: "0.0.0" }));
  if (agentIds.length === 0) return;
  const agentsDir = join(globalPluginDir(claudeDir), "agents");
  mkdirSync(agentsDir, { recursive: true });
  for (const id of agentIds) writeFileSync(join(agentsDir, `${id}.md`), `# ${id}\n`);
}

/** Install a hook byte-identical to what the CLI would render right now. */
function installHook(cfg: GlobalConfig): void {
  const path = join(globalPluginDir(claudeDir), PLUGIN_HOOK_SCRIPT_REL);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, generateHookScript(composeBaseline(cfg)));
}

function writeSettings(dir: string, permissions: Record<string, string[]>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ permissions }, null, 2));
}

function writeRepoAgent(id: string, body: string): void {
  const dir = join(repo, ".claude", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), body);
}

function scan(overrides: Partial<NavoriConfig> = {}) {
  return scanGlobalScope(repo, config(overrides), { managedSettingsPath: policyPath });
}

describe("scanGlobalScope (Spec 0010 FC, #547)", () => {
  it("returns null when no global harness is installed (zero footprint)", () => {
    // The plugin dir alone is not the sentinel: `~/.navori/global.json` is.
    installPlugin(["implementer"]);
    expect(scan()).toBeNull();
  });

  it("returns null for a repo that renders no Claude output, and when HOME is unusable", () => {
    installGlobal();
    expect(scan({ engines: ["codex"] })).toBeNull();
    home.fail = true;
    expect(scan()).toBeNull(); // a HomeError must never take doctor down
  });

  it("flags a repo agent with no managed marker as shadowing the plugin's copy", () => {
    installGlobal();
    installPlugin(["implementer"]);
    writeRepoAgent("implementer", "# my own implementer\n\nDo it my way.\n");

    expect(scan()?.shadowedAgents).toEqual([
      {
        id: "implementer",
        globalPath: join(globalPluginDir(claudeDir), "agents", "implementer.md"),
        repoPath: join(".claude", "agents", "implementer.md"),
      },
    ]);
    // The notice has to name the precedence resolution, not just the collision.
    for (const lang of ["es", "en"] as const) {
      const row = tc(lang).doctor.globalScopeShadowedAgent("implementer", ".claude/x.md");
      expect(row).toMatch(lang === "es" ? /a favor del repo/ : /in the repo's favour/);
    }
  });

  it("stays silent when navori itself rendered the repo agent (the deferral is by design)", () => {
    installGlobal();
    installPlugin(["implementer", "reviewer"]);
    // A healthy navori repo carries all eight agents in BOTH scopes; warning
    // about that would be noise on every single repo.
    for (const id of ["implementer", "reviewer"]) {
      writeRepoAgent(
        id,
        `<!-- navori:managed id="${id}-base" hash="deadbeefdeadbeef" version="0.0.0" -->\nbody\n<!-- /navori:managed id="${id}-base" -->\n`,
      );
    }
    expect(scan()?.shadowedAgents).toEqual([]);
  });

  it("flags a rule the global settings allow and this repo denies", () => {
    installGlobal();
    writeSettings(claudeDir, { allow: ["Bash(rm -rf:*)", "Read(//tmp/**)"] });
    writeSettings(join(repo, ".claude"), { deny: ["Bash(rm -rf:*)", "Bash(curl:*)"] });

    expect(scan()?.permissionConflicts).toEqual(["Bash(rm -rf:*)"]);
  });

  it("reports no permission rows when a settings.json cannot be read", () => {
    installGlobal();
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "settings.json"), "{ not json");
    writeSettings(join(repo, ".claude"), { deny: ["Bash(rm -rf:*)"] });

    // `scanCorruptedSettings` / `navori global doctor` own that report; a check
    // that cannot parse a file has nothing to say about its contents.
    expect(scan()?.permissionConflicts).toEqual([]);
  });

  it("stays completely quiet when both scopes are healthy", () => {
    const cfg = installGlobal();
    installPlugin(["implementer"]);
    installHook(cfg);

    expect(scan()).toEqual({
      shadowedAgents: [],
      permissionConflicts: [],
      hookDrift: { kind: "ok" },
      managedPolicy: [],
    });
  });

  it("reports an unmigrated install instead of a raw 'absent' when the plugin is missing", () => {
    installGlobal(); // `~/.navori/global.json` but no plugin: the F1-not-migrated case
    // The old hook lives OUTSIDE the plugin and is still registered in the
    // global settings, so "absent" would describe the user's machine wrongly.
    expect(scan()?.hookDrift).toEqual({ kind: "plugin-missing" });

    for (const lang of ["es", "en"] as const) {
      expect(tc(lang).doctor.globalScopeHookLegacyInstall).toContain("navori global doctor");
    }
  });

  it("reports the global hook's drift kind, and 'not-evaluable' over a broken baseline", () => {
    const cfg = installGlobal();
    installPlugin();
    expect(scan()?.hookDrift).toEqual({ kind: "absent" });

    installHook(cfg);
    writeFileSync(join(globalPluginDir(claudeDir), PLUGIN_HOOK_SCRIPT_REL), "#!/bin/sh\nexit 0\n");
    expect(scan()?.hookDrift).toEqual({ kind: "unmarked" });

    // An unknown block makes `composeBaseline` throw. Degrade, never crash.
    writeGlobalConfig({ ...cfg, blocks: { include: ["no-such-block"] } });
    expect(scan()?.hookDrift).toEqual({ kind: "not-evaluable" });
  });

  it("flags the managed-settings keys that can leave the global layer inert", () => {
    installGlobal();
    mkdirSync(dirname(policyPath), { recursive: true });
    writeFileSync(policyPath, JSON.stringify({ strictPluginOnlyCustomization: true }));

    expect(scan()?.managedPolicy).toEqual([
      { key: "strictPluginOnlyCustomization", path: policyPath },
    ]);

    // Claude Code also merges every *.json from the sibling drop-in dir.
    const dropIn = join(dirname(policyPath), "managed-settings.d");
    mkdirSync(dropIn, { recursive: true });
    const org = join(dropIn, "10-org.json");
    writeFileSync(org, JSON.stringify({ allowManagedPermissionRulesOnly: true }));

    expect(scan()?.managedPolicy).toEqual([
      { key: "strictPluginOnlyCustomization", path: policyPath },
      { key: "allowManagedPermissionRulesOnly", path: org },
    ]);
  });

  it("flags a marketplace allowlist that never opts the skills-dir scan back in", () => {
    installGlobal();
    mkdirSync(dirname(policyPath), { recursive: true });
    // "by default any allowlist blocks it": an org allowlisting marketplaces for
    // reasons that have nothing to do with navori turns the `~/.claude/skills/`
    // scan off, and that is the highest-probability real case.
    writeFileSync(
      policyPath,
      JSON.stringify({ strictKnownMarketplaces: [{ source: "github", repo: "acme/plugins" }] }),
    );
    expect(scan()?.managedPolicy).toEqual([{ key: "strictKnownMarketplaces", path: policyPath }]);

    // With the sentinel the scan is opted back IN, so there is nothing to say.
    writeFileSync(
      policyPath,
      JSON.stringify({
        strictKnownMarketplaces: [
          { source: "github", repo: "acme/plugins" },
          { source: "skills-dir" },
        ],
      }),
    );
    expect(scan()?.managedPolicy).toEqual([]);

    // A bare "skills-dir" string is NOT the sentinel: Claude Code compares
    // `entry.source === "skills-dir"` over objects, so this allowlist blocks
    // the scan and reading it as an opt-in would silence the row.
    writeFileSync(policyPath, JSON.stringify({ strictKnownMarketplaces: ["skills-dir"] }));
    expect(scan()?.managedPolicy).toEqual([{ key: "strictKnownMarketplaces", path: policyPath }]);

    // An empty allowlist is a legitimate lockdown ("no marketplace at all") and
    // blocks it too: `[]` is truthy and `[].some(...)` is false.
    writeFileSync(policyPath, JSON.stringify({ strictKnownMarketplaces: [] }));
    expect(scan()?.managedPolicy).toEqual([{ key: "strictKnownMarketplaces", path: policyPath }]);
  });

  it("flags a marketplace blocklist carrying the skills-dir sentinel", () => {
    installGlobal();
    mkdirSync(dirname(policyPath), { recursive: true });
    writeFileSync(policyPath, JSON.stringify({ blockedMarketplaces: [{ source: "skills-dir" }] }));
    expect(scan()?.managedPolicy).toEqual([{ key: "blockedMarketplaces", path: policyPath }]);

    // The scenario the notice has to be actionable for, in both languages: these
    // two keys ARE the documented mechanism, so the text asserts the block.
    for (const lang of ["es", "en"] as const) {
      const d = tc(lang).doctor;
      expect(d.globalScopeStrictKnownMarketplaces(policyPath)).toContain('{"source":"skills-dir"}');
      expect(d.globalScopeBlockedMarketplaces(policyPath)).toContain('{"source":"skills-dir"}');
    }
  });

  it("decides on the merged policy document, not file by file", () => {
    installGlobal();
    mkdirSync(dirname(policyPath), { recursive: true });
    const dropIn = join(dirname(policyPath), "managed-settings.d");
    mkdirSync(dropIn, { recursive: true });
    const org = join(dropIn, "50-navori.json");

    // Claude Code merges two arrays as a union, so a drop-in that adds the
    // sentinel opts the scan back IN: the plugin loads and asserting a block
    // here would ask the admin to add what is already there.
    writeFileSync(
      policyPath,
      JSON.stringify({ strictKnownMarketplaces: [{ source: "github", repo: "acme/plugins" }] }),
    );
    writeFileSync(org, JSON.stringify({ strictKnownMarketplaces: [{ source: "skills-dir" }] }));
    expect(scan()?.managedPolicy).toEqual([]);

    // The inverse: the key arrives only from the drop-in, and the row names it.
    writeFileSync(policyPath, JSON.stringify({}));
    writeFileSync(
      org,
      JSON.stringify({ strictKnownMarketplaces: [{ source: "github", repo: "acme/plugins" }] }),
    );
    expect(scan()?.managedPolicy).toEqual([{ key: "strictKnownMarketplaces", path: org }]);

    // A scalar takes the last writer, so a drop-in that turns the key off
    // silences it; judging per file would still have reported the main file.
    writeFileSync(policyPath, JSON.stringify({ strictPluginOnlyCustomization: true }));
    writeFileSync(org, JSON.stringify({ strictPluginOnlyCustomization: false }));
    expect(scan()?.managedPolicy).toEqual([]);

    // Attribution survives the merge: the blocklist row names the file that
    // carries the sentinel, not the last one that re-declared the key.
    writeFileSync(policyPath, JSON.stringify({ blockedMarketplaces: [{ source: "skills-dir" }] }));
    writeFileSync(
      org,
      JSON.stringify({ blockedMarketplaces: [{ source: "github", repo: "acme/plugins" }] }),
    );
    expect(scan()?.managedPolicy).toEqual([{ key: "blockedMarketplaces", path: policyPath }]);

    // Claude Code skips dot-prefixed drop-ins, so a hidden file contributes
    // nothing to the merged document.
    writeFileSync(policyPath, JSON.stringify({}));
    writeFileSync(org, JSON.stringify({}));
    writeFileSync(
      join(dropIn, ".hidden.json"),
      JSON.stringify({ blockedMarketplaces: [{ source: "skills-dir" }] }),
    );
    expect(scan()?.managedPolicy).toEqual([]);
  });

  it("ignores a policy that restricts nothing, or that does not parse", () => {
    installGlobal();
    mkdirSync(dirname(policyPath), { recursive: true });
    writeFileSync(
      policyPath,
      JSON.stringify({
        // `strictPluginOnlyCustomization` is per surface: "mcp" does not touch
        // the `~/.claude/skills/` scan, so warning here would be a false alarm.
        strictPluginOnlyCustomization: ["mcp"],
        allowManagedPermissionRulesOnly: false,
        blockedMarketplaces: [{ source: "github", repo: "acme/plugins" }],
      }),
    );
    expect(scan()?.managedPolicy).toEqual([]);

    // The same key naming the surface that IS cut does fire.
    writeFileSync(policyPath, JSON.stringify({ strictPluginOnlyCustomization: ["skills"] }));
    expect(scan()?.managedPolicy).toEqual([
      { key: "strictPluginOnlyCustomization", path: policyPath },
    ]);

    writeFileSync(policyPath, "{ not json");
    expect(scan()?.managedPolicy).toEqual([]);
  });

  it("resolves the platform policy path per Claude Code's documented locations", () => {
    expect(defaultManagedSettingsPath("darwin")).toBe(
      "/Library/Application Support/ClaudeCode/managed-settings.json",
    );
    expect(defaultManagedSettingsPath("linux")).toBe("/etc/claude-code/managed-settings.json");
    expect(defaultManagedSettingsPath("win32")).toBe(
      "C:\\Program Files\\ClaudeCode\\managed-settings.json",
    );
  });
});
