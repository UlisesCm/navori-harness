import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assert, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavoriConfigSchema, type NavoriConfig } from "../../lib/config/schema.ts";
import { minCodexVersion, resolveCodexHooks } from "../../engines/codex/hook-registrations.ts";
import { codexHookHash, codexHookKey } from "../../lib/codex/trust.ts";
import { tc } from "../../lib/i18n.ts";

// `scanCodexHealth` now reads `~/.codex/config.toml` (spec 0035 D10/T10) —
// `safeHomedir` is mocked so every test in this file writes/reads a
// throwaway fake home, never the developer's real `~/.codex` (critical-area
// invariant: this test file must never touch it).
const codexHome = vi.hoisted(() => ({ dir: "" }));
vi.mock(import("../../lib/primitives/home.ts"), () => ({ safeHomedir: () => codexHome.dir }));

const { isCodexVersionTooOld, scanCodexHealth, buildEngineInventory, computeHealthVerdict } =
  await import("../doctor.ts");

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
  beforeEach(() => {
    codexHome.dir = mkdtempSync(join(tmpdir(), "navori-codex-doctor-home-"));
  });
  afterEach(() => {
    rmSync(codexHome.dir, { recursive: true, force: true });
  });

  it("compares Codex versions numerically instead of treating 0.154 as older than 0.145", () => {
    expect(isCodexVersionTooOld("0.144.9")).toBe(true);
    expect(isCodexVersionTooOld("0.145.0")).toBe(false);
    expect(isCodexVersionTooOld("0.154.0")).toBe(false);
  });

  // Covers: R18
  it("derives the minimum Codex version from the registrations", () => {
    // 0.145.0 is `audit-mode-close`'s minVersion (spec 0035 D1) — the max
    // across every registered row today, computed from the table rather than
    // hardcoded, so a future row raising the floor updates both this and
    // `isCodexVersionTooOld` automatically.
    expect(minCodexVersion()).toBe("0.145.0");
    expect(isCodexVersionTooOld("0.144.9")).toBe(true);
    expect(isCodexVersionTooOld("0.145.0")).toBe(false);
  });

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
  });

  // Covers: R16
  it("untrusted project is an error that says AGENTS.md does not load", () => {
    const cwd = tempRepo();
    writeGuard(cwd);
    // No ~/.codex/config.toml at all → the project is Untrusted.
    const health = scanCodexHealth(cwd, config());
    expect(health?.trust.projectTrusted).toBe(false);
    expect(health?.trust.hooks.every((h) => h.status === "Untrusted")).toBe(true);
    // Isolated from unrelated `missingInvariants` noise (plugins: {}) so this
    // pins the codex-trust contribution to `ok` specifically.
    expect(computeHealthVerdict(cwd, config({ plugins: {} })).ok).toBe(false);
    expect(tc("es").doctor.codexProjectUntrusted).toContain("AGENTS.md");
  });

  // Covers: R16, R17
  it("trusted project with unapproved hooks is a warning with the count, and does not flip ok", () => {
    const cwd = tempRepo();
    writeGuard(cwd);
    mkdirSync(join(codexHome.dir, ".codex"), { recursive: true });
    writeFileSync(
      join(codexHome.dir, ".codex/config.toml"),
      `[projects."${cwd}"]\ntrust_level = "trusted"\n`,
    );
    const health = scanCodexHealth(cwd, config());
    expect(health?.trust.projectTrusted).toBe(true);
    const unapproved = health?.trust.hooks.filter((h) => h.status !== "Trusted").length ?? 0;
    expect(unapproved).toBeGreaterThan(0);
    expect(computeHealthVerdict(cwd, config({ plugins: {} })).ok).toBe(true);
  });

  // Covers: R16 — cross-check that `readCodexTrustState` (via scanCodexHealth)
  // reports Trusted when the SAME hash Codex itself would compute is stored,
  // using the shared golden-hash builders (codexHookKey/codexHookHash).
  it("reports a hook Trusted when its real Codex hash is on file", () => {
    const cwd = tempRepo();
    writeGuard(cwd);
    const hooks = resolveCodexHooks(config());
    const guardHook = hooks.find((h) => h.script === "guard-destructive");
    assert.isDefined(guardHook);
    const command = `bash "$(git rev-parse --show-toplevel)/.codex/hooks/guard-destructive.sh"`;
    const hash = codexHookHash(guardHook, command);
    const key = codexHookKey(join(cwd, ".codex/config.toml"), "PreToolUse", 0, 0);
    mkdirSync(join(codexHome.dir, ".codex"), { recursive: true });
    writeFileSync(
      join(codexHome.dir, ".codex/config.toml"),
      `[projects."${cwd}"]\ntrust_level = "trusted"\n\n[hooks.state."${key}"]\ntrusted_hash = "${hash}"\n`,
    );
    const health = scanCodexHealth(cwd, config());
    expect(health?.trust.hooks.find((h) => h.script === "guard-destructive")?.status).toBe(
      "Trusted",
    );
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
  it("lists agents/skills/hooks per disk engine; claude includes orchestrator, codex omits it", () => {
    const cwd = tempRepo();
    const inv = buildEngineInventory(config({ engines: ["claude", "codex"] }), cwd);
    expect(Object.keys(inv).sort()).toEqual(["claude", "codex"]);
    const { claude, codex } = inv;
    assert.isDefined(claude);
    assert.isDefined(codex);
    expect(claude.agents).toContain("orchestrator");
    expect(codex.agents).not.toContain("orchestrator");
    // Skills remain shared; the two master-plan hook assets are Claude-only.
    expect(codex.skills).toEqual(claude.skills);
    expect(claude.hooks.filter((hook) => !hook.startsWith("master-"))).toEqual(codex.hooks);
    expect(claude.hooks).toContain("master-plan-context");
    expect(claude.hooks).toContain("master-accept-confirm");
    expect(codex.hooks).not.toContain("master-plan-context");
    expect(codex.hooks).not.toContain("master-accept-confirm");
    expect(claude.hooks).toContain("guard-destructive");
  });

  it("reports dormant Claude hooks with masterPlan off and the same assets with it on", () => {
    const cwd = tempRepo();
    for (const masterPlan of [false, true]) {
      const { claude, codex } = buildEngineInventory(
        NavoriConfigSchema.parse({
          ...config({ engines: ["claude", "codex"] }),
          harness: { masterPlan },
        }),
        cwd,
      );
      assert.isDefined(claude);
      assert.isDefined(codex);
      expect(claude.hooks).toContain("master-plan-context");
      expect(claude.hooks).toContain("master-accept-confirm");
      expect(codex.hooks).not.toContain("master-plan-context");
      expect(codex.hooks).not.toContain("master-accept-confirm");
    }
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
    const { claude } = buildEngineInventory(config({ engines: ["claude"], plugins: {} }), cwd);
    assert.isDefined(claude);
    expect(claude.scripts).toEqual([]);
  });

  it("folds an enabled plugin's skill into the inventory (engram → orchestrator extension)", () => {
    const cwd = tempRepo();
    // The `config()` helper enables engram, whose skill asset is
    // engram-orchestrator-extension (spec 0026 T13).
    const { claude, codex } = buildEngineInventory(config({ engines: ["claude", "codex"] }), cwd);
    assert.isDefined(claude);
    assert.isDefined(codex);
    expect(claude.skills).toContain("engram-orchestrator-extension");
    expect(codex.skills).toContain("engram-orchestrator-extension");
  });

  it("folds a plugin's scripts and hooks into the inventory (jscpd)", () => {
    const cwd = tempRepo();
    const { claude } = buildEngineInventory(
      config({ engines: ["claude"], plugins: { jscpd: { enabled: true } } }),
      cwd,
    );
    assert.isDefined(claude);
    expect(claude.scripts).toContain("check-jscpd.sh");
    expect(claude.hooks).toContain("PreToolUse:Bash");
  });

  // #235: render materializes a tree per monorepo workspace, and a workspace may
  // override the preset (→ different extras), so a root-only inventory validated
  // a subset. The inventory is the UNION across root + workspaces.
  it("unions in a workspace's preset extras (workspace preset: nestjs)", () => {
    const cwd = tempRepo();
    mkdirSync(join(cwd, "apps/api"), { recursive: true });
    const { claude } = buildEngineInventory(
      config({
        engines: ["claude"],
        preset: "custom",
        monorepo: {
          enabled: true,
          workspaces: [{ name: "api", path: "apps/api", preset: "nestjs" }],
          workspaceHarness: "minimal",
        },
      }),
      cwd,
    );
    assert.isDefined(claude);
    // nestjs preset ships these skills; they belong only to the workspace, yet
    // the root inventory now surfaces them (union).
    expect(claude.skills).toContain("nestjs-modules");
  });

  it("skips an orphaned (missing) workspace dir without crashing", () => {
    const cwd = tempRepo();
    const { claude } = buildEngineInventory(
      config({
        engines: ["claude"],
        monorepo: {
          enabled: true,
          workspaces: [{ name: "gone", path: "apps/gone", preset: "nestjs" }],
          workspaceHarness: "minimal",
        },
      }),
      cwd,
    );
    assert.isDefined(claude);
    // The workspace dir doesn't exist → its extras must NOT be counted.
    expect(claude.skills).not.toContain("nestjs-modules");
  });
});
