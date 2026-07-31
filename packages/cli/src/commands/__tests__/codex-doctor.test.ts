import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { NavoriConfigSchema, type NavoriConfig } from "../../lib/schema.ts";
import { scanCodexHealth, buildEngineInventory } from "../doctor.ts";

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "navori-codex-doctor-"));
}

function gitInit(cwd: string): void {
  execFileSync("git", ["-C", cwd, "init", "-q"], { stdio: "ignore" });
}

function writeGuard(cwd: string): string {
  mkdirSync(join(cwd, ".codex/hooks"), { recursive: true });
  const hook = join(cwd, ".codex/hooks/guard-destructive.sh");
  writeFileSync(hook, "#!/bin/sh\n");
  chmodSync(hook, 0o755);
  return hook;
}

function config(overrides: Partial<NavoriConfig> = {}): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "cx",
    engines: ["codex"],
    preset: "custom",
    branchBase: "main",
    qualityGate: { fast: "pnpm test", full: "pnpm test" },
    plugins: { engram: { enabled: true } },
    ...overrides,
  });
}

describe("scanCodexHealth (Spec 0007 M5)", () => {
  it("returns null when codex is not a configured engine", () => {
    const cwd = tempRepo();
    expect(scanCodexHealth(cwd, config({ engines: ["claude"] }))).toBeNull();
  });

  it("returns null when codex is configured but nothing rendered yet", () => {
    const cwd = tempRepo();
    expect(scanCodexHealth(cwd, config())).toBeNull();
  });

  it("flags a hook without the executable bit and hints at hook-trust", () => {
    const cwd = tempRepo();
    mkdirSync(join(cwd, ".codex/hooks"), { recursive: true });
    const hook = join(cwd, ".codex/hooks/guard-destructive.sh");
    writeFileSync(hook, "#!/bin/sh\n");
    chmodSync(hook, 0o644); // no +x
    const health = scanCodexHealth(cwd, config());
    expect(health).not.toBeNull();
    expect(health?.hooksNotExecutable).toContain(".codex/hooks/guard-destructive.sh");
    expect(health?.hookTrustHint).toBe(true);
  });

  it("flags an unbalanced managed block in config.toml", () => {
    const cwd = tempRepo();
    mkdirSync(join(cwd, ".codex"), { recursive: true });
    writeFileSync(
      join(cwd, ".codex/config.toml"),
      '# navori:managed start id="codex-config-base"\nfoo = 1\n', // start without end
    );
    const health = scanCodexHealth(cwd, config());
    expect(health?.configMalformed).toBe(true);
  });

  it("passes a balanced config.toml", () => {
    const cwd = tempRepo();
    mkdirSync(join(cwd, ".codex"), { recursive: true });
    writeFileSync(
      join(cwd, ".codex/config.toml"),
      '# navori:managed start id="codex-config-base"\nfoo = 1\n# navori:managed end id="codex-config-base"\n',
    );
    const health = scanCodexHealth(cwd, config());
    expect(health?.configMalformed).toBe(false);
  });

  it("does not flag unversioned hooks outside a git work tree (no worktrees ⇒ no exposure)", () => {
    const cwd = tempRepo();
    writeGuard(cwd); // untracked, but the dir is not a git repo
    const health = scanCodexHealth(cwd, config());
    expect(health?.guardNotVersioned).toEqual([]);
  });

  it("flags a hook untracked by git (absent from a worktree checkout ⇒ guard off there)", () => {
    const cwd = tempRepo();
    gitInit(cwd);
    writeGuard(cwd); // git repo but never `git add`-ed
    const health = scanCodexHealth(cwd, config());
    expect(health?.guardNotVersioned).toContain(".codex/hooks/guard-destructive.sh");
  });

  it("passes when the hook is tracked by git (travels to every worktree/clone)", () => {
    const cwd = tempRepo();
    gitInit(cwd);
    writeGuard(cwd);
    execFileSync("git", ["-C", cwd, "add", ".codex/hooks/guard-destructive.sh"], {
      stdio: "ignore",
    });
    const health = scanCodexHealth(cwd, config());
    expect(health?.guardNotVersioned).toEqual([]);
  });
});

describe("buildEngineInventory (Spec 0007 M8)", () => {
  it("lists agents/skills/hooks per disk engine; claude includes leader, codex omits it", () => {
    const cwd = tempRepo();
    const inv = buildEngineInventory(config({ engines: ["claude", "codex"] }), cwd);
    expect(Object.keys(inv).sort()).toEqual(["claude", "codex"]);
    expect(inv.claude.agents).toContain("leader");
    expect(inv.codex.agents).not.toContain("leader");
    // Same skills + hooks set for both (parity).
    expect(inv.codex.skills).toEqual(inv.claude.skills);
    expect(inv.codex.hooks).toEqual(inv.claude.hooks);
    expect(inv.claude.hooks).toContain("guard-destructive");
  });

  it("omits prose engines", () => {
    const cwd = tempRepo();
    const inv = buildEngineInventory(config({ engines: ["codex", "agents-md"] }), cwd);
    expect(Object.keys(inv)).toEqual(["codex"]);
  });

  // #233: the parity inventory came only from resolveHarnessPlan, which knows
  // core + preset assets but NOT what plugins contribute — so a CI asserting
  // parity validated a subset of what render (which materializes plugin
  // skills/scripts/hooks) produces.
  it("exposes a scripts field, empty for a core-only (no-plugin) config", () => {
    const cwd = tempRepo();
    const inv = buildEngineInventory(config({ engines: ["claude"], plugins: {} }), cwd);
    expect(inv.claude!.scripts).toEqual([]);
  });

  it("folds an enabled plugin's skill into the inventory (engram → leader extension)", () => {
    const cwd = tempRepo();
    // The `config()` helper enables engram, whose skill asset is engram-leader-extension.
    const inv = buildEngineInventory(config({ engines: ["claude", "codex"] }), cwd);
    expect(inv.claude!.skills).toContain("engram-leader-extension");
    expect(inv.codex!.skills).toContain("engram-leader-extension");
  });

  it("folds a plugin's scripts and hooks into the inventory (jscpd)", () => {
    const cwd = tempRepo();
    const inv = buildEngineInventory(
      config({ engines: ["claude"], plugins: { jscpd: { enabled: true } } }),
      cwd,
    );
    expect(inv.claude!.scripts).toContain("check-jscpd.sh");
    expect(inv.claude!.hooks).toContain("PreToolUse:Bash");
  });

  // #235: render materializes a tree per monorepo workspace, and a workspace may
  // override the preset (→ different extras), so a root-only inventory validated
  // a subset. The inventory is the UNION across root + workspaces.
  it("unions in a workspace's preset extras (workspace preset: nestjs)", () => {
    const cwd = tempRepo();
    mkdirSync(join(cwd, "apps/api"), { recursive: true });
    const inv = buildEngineInventory(
      config({
        engines: ["claude"],
        preset: "custom",
        monorepo: {
          enabled: true,
          workspaces: [{ name: "api", path: "apps/api", preset: "nestjs" }],
        },
      }),
      cwd,
    );
    // nestjs preset ships these skills; they belong only to the workspace, yet
    // the root inventory now surfaces them (union).
    expect(inv.claude!.skills).toContain("nestjs-modules");
  });

  it("skips an orphaned (missing) workspace dir without crashing", () => {
    const cwd = tempRepo();
    const inv = buildEngineInventory(
      config({
        engines: ["claude"],
        monorepo: {
          enabled: true,
          workspaces: [{ name: "gone", path: "apps/gone", preset: "nestjs" }],
        },
      }),
      cwd,
    );
    // The workspace dir doesn't exist → its extras must NOT be counted.
    expect(inv.claude!.skills).not.toContain("nestjs-modules");
  });
});
