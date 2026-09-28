import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assert, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavoriConfigSchema, type NavoriConfig } from "../../lib/config/schema.ts";
import {
  codexHookCommand,
  minCodexVersion,
  resolveCodexHooks,
} from "../../engines/codex/hook-registrations.ts";
import { buildCodexConfigToml } from "../../engines/codex/build-config-toml.ts";
import { codexHookHash, codexHookKey } from "../../lib/codex/trust.ts";
import { tc } from "../../lib/i18n.ts";

// `scanCodexHealth` now reads `~/.codex/config.toml` (spec 0035 D10/T10) —
// `safeHomedir` is mocked so every test in this file writes/reads a
// throwaway fake home, never the developer's real `~/.codex` (critical-area
// invariant: this test file must never touch it).
const codexHome = vi.hoisted(() => ({ dir: "" }));
vi.mock(import("../../lib/primitives/home.ts"), () => ({
  safeHomedir: () => codexHome.dir,
}));

const {
  isCodexVersionTooOld,
  scanCodexHealth,
  buildEngineInventory,
  buildEngineEvidence,
  buildDoctorProvenance,
  inspectPathCli,
  computeHealthVerdict,
  scanOperationalTools,
  probeFailureReason,
} = await import("../doctor.ts");

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

describe("operational tool diagnostics (Spec 0037 T13)", () => {
  const originalPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = originalPath;
  });

  // Covers: R3, R16, R19
  it("does not promote status output into search results, MCP calls, or Engram memory access", () => {
    const cwd = tempRepo();
    const bin = join(cwd, "bin");
    mkdirSync(bin);
    for (const [name, output] of [
      ["tgrep", `Index status for ${cwd}\n  Updated:    2h ago\n  Server:     not running\n`],
      [
        "codegraph",
        '{"version":"1.6.0","index":{"builtWithVersion":"1.5.0","reindexRecommended":true}}',
      ],
      ["engram", ""],
    ] as const) {
      const path = join(bin, name);
      writeFileSync(path, `#!/bin/sh\nprintf '%b' ${JSON.stringify(output)}\n`);
      chmodSync(path, 0o755);
    }
    mkdirSync(join(cwd, ".codegraph"));
    process.env.PATH = bin;
    const report = scanOperationalTools(
      cwd,
      config({
        plugins: {
          tgrep: { enabled: true },
          codegraph: { enabled: true },
          engram: { enabled: true },
        },
      }),
    );
    expect(report.tgrep?.index).toEqual({ status: "verified", state: "stale" });
    expect(report.tgrep?.staleIndex?.age).toBe("2h");
    expect(report.codegraph?.index).toEqual({
      status: "verified",
      state: "version-drift",
    });
    expect(report.codegraph?.indexDrift?.currentVersion).toBe("1.6.0");
    expect(report.tgrep?.result).toEqual({
      status: "unverified",
      reason: "no-result-query",
    });
    expect(report.codegraph?.mcp).toEqual({
      status: "unverified",
      reason: "no-mcp-query",
    });
    expect(report.engram?.read).toEqual({
      status: "unverified",
      reason: "no-read-query",
    });
    expect(report.engram?.write).toEqual({
      status: "unverified",
      reason: "runtime-identity-unavailable",
    });
  });

  // Covers: R3, R16, R19
  it("reports missing binaries without invoking tools or fabricating a runtime session", () => {
    const cwd = tempRepo();
    process.env.PATH = join(cwd, "empty-bin");
    const report = scanOperationalTools(
      cwd,
      config({
        plugins: {
          tgrep: { enabled: true },
          codegraph: { enabled: true },
          engram: { enabled: true },
        },
      }),
    );
    expect(report.tgrep?.cli).toEqual({
      status: "unverified",
      reason: "binary-missing",
    });
    expect(report.codegraph?.cli).toEqual({
      status: "unverified",
      reason: "binary-missing",
    });
    expect(report.engram?.cli).toEqual({
      status: "unverified",
      reason: "binary-missing",
    });
    expect(report.engram?.write.status).toBe("unverified");
  });

  // Covers: R3, R16
  it("classifies a failed read-only status probe without claiming a clean index", () => {
    const cwd = tempRepo();
    const bin = join(cwd, "bin");
    mkdirSync(bin);
    const path = join(bin, "tgrep");
    writeFileSync(path, "#!/bin/sh\necho UNABLE_TO_VERIFY_LEAF_SIGNATURE >&2\nexit 1\n");
    chmodSync(path, 0o755);
    process.env.PATH = bin;
    const report = scanOperationalTools(cwd, config({ plugins: { tgrep: { enabled: true } } }));
    expect(report.tgrep?.cli).toEqual({ status: "unverified", reason: "ca-or-tls-error" });
    expect(report.tgrep?.index).toEqual({ status: "unverified", reason: "ca-or-tls-error" });
    expect(report.tgrep?.result.status).toBe("unverified");
  });

  // Covers: R3
  it.each([
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ca-or-tls-error"],
    ["SQLITE_CANTOPEN", "permission-denied"],
    ["ETIMEDOUT", "timeout"],
    ["ENETUNREACH", "network-unreachable"],
    ["invalid session", "invalid-session"],
  ])("classifies %s as %s without claiming a clean check", (code, reason) => {
    expect(probeFailureReason({ code })).toBe(reason);
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
    // Same skills + hooks set for both (parity).
    expect(codex.skills).toEqual(claude.skills);
    expect(codex.hooks).toEqual(claude.hooks);
    expect(claude.hooks).toContain("guard-destructive");
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

describe("doctor evidence (Spec 0037 V01-V03)", () => {
  beforeEach(() => {
    codexHome.dir = mkdtempSync(join(tmpdir(), "navori-codex-evidence-home-"));
  });
  afterEach(() => {
    rmSync(codexHome.dir, { recursive: true, force: true });
  });

  // Covers: R1
  it("identifies different entrypoint content even when the declared release is unchanged", () => {
    const cwd = mkdtempSync(join(tmpdir(), "navori doctor spaced path "));
    const one = join(cwd, "first.js");
    const two = join(cwd, "second.js");
    const link = join(cwd, "linked cli.js");
    writeFileSync(one, "first build");
    writeFileSync(two, "second build");
    symlinkSync(one, link);
    const first = buildDoctorProvenance(cwd, one);
    const second = buildDoctorProvenance(cwd, two);
    const viaLink = buildDoctorProvenance(cwd, link);
    expect(first.cliVersion).toBe(second.cliVersion);
    expect(first.entrypointSha256).not.toBe(second.entrypointSha256);
    expect(first.resolvedCli).toBe(realpathSync(one));
    expect(viaLink.invokedCli).toBe(link);
    expect(viaLink.resolvedCli).toBe(realpathSync(one));
    expect(viaLink.entrypointSha256).toBe(first.entrypointSha256);
    expect(first.checkoutSha).toBeNull();
    expect(first.checkoutReason).toBeDefined();
    const inaccessible = buildDoctorProvenance(cwd, join(cwd, "not-installed.js"));
    expect(inaccessible.entrypointSha256).toBeNull();
    expect(inaccessible.entrypointReason).toBeDefined();
  });

  // Covers: R1, R3
  it("separates PATH permission, certificate, timeout, network and absent binary causes", () => {
    const cwd = mkdtempSync(join(tmpdir(), "navori doctor cli failures "));
    const binary = join(cwd, "codex");
    const script = (body: string): void => {
      writeFileSync(binary, `#!/bin/sh\n${body}\n`);
      chmodSync(binary, 0o755);
    };
    script('echo "certificate verify failed" >&2; exit 1');
    expect(inspectPathCli("codex", cwd)).toMatchObject({
      status: "unverified",
      version: null,
      reason: "version probe certificate failure",
    });
    script('echo "ENETUNREACH" >&2; exit 1');
    expect(inspectPathCli("codex", cwd)).toMatchObject({
      status: "unverified",
      version: null,
      reason: "version probe network failure",
    });
    script("sleep 1");
    expect(inspectPathCli("codex", cwd, 20)).toMatchObject({
      status: "unverified",
      version: null,
      reason: "version probe timeout",
    });
    chmodSync(binary, 0o600);
    expect(inspectPathCli("codex", cwd)).toMatchObject({
      status: "unverified",
      version: null,
      reason: "permission denied",
    });
    expect(inspectPathCli("codex", join(cwd, "missing-dependency"))).toMatchObject({
      status: "missing",
      version: null,
      reason: "binary absent from PATH",
    });
  });

  // Covers: R2, R3
  it("keeps declaration, materialization, registration, trust and execution separate", () => {
    const cwd = tempRepo();
    mkdirSync(join(cwd, ".codex"), { recursive: true });
    writeFileSync(
      join(cwd, ".codex/config.toml"),
      buildCodexConfigToml(config({ plugins: {} }), []).body,
    );
    const rows = buildEngineEvidence(config({ plugins: {} }), cwd);
    const guard = rows.find(
      (row) => row.engine === "codex" && row.kind === "hook" && row.id === "guard-destructive",
    );
    assert.isDefined(guard);
    expect(guard.declared.status).toBe("verified");
    expect(guard.materialized.status).toBe("missing");
    expect(guard.registered.status).toBe("verified");
    expect(guard.trust.status).toBe("unverified");
    expect(guard.execution.status).toBe("not-run");
    expect(JSON.parse(JSON.stringify(rows))).toEqual(rows);
  });

  // Covers: R2, R3
  it("does not hide a missing workspace asset behind the root inventory", () => {
    const cwd = tempRepo();
    mkdirSync(join(cwd, ".codex/hooks"), { recursive: true });
    writeFileSync(join(cwd, ".codex/hooks/guard-destructive.sh"), "#!/bin/sh\n");
    mkdirSync(join(cwd, "apps/api"), { recursive: true });
    const cfg = config({
      plugins: {},
      monorepo: {
        enabled: true,
        workspaces: [{ name: "api", path: "apps/api", preset: "custom" }],
        workspaceHarness: "full",
      },
    });
    const guards = buildEngineEvidence(cfg, cwd).filter(
      (row) => row.kind === "hook" && row.id === "guard-destructive",
    );
    expect(guards.map((row) => [row.location, row.materialized.status])).toEqual([
      [".", "verified"],
      ["apps/api", "missing"],
    ]);
  });

  // Covers: R2, R3
  it("marks a malformed registration as unverified rather than clean", () => {
    const cwd = tempRepo();
    mkdirSync(join(cwd, ".codex"), { recursive: true });
    writeFileSync(join(cwd, ".codex/config.toml"), "[[hooks.PreToolUse]\n");
    const guard = buildEngineEvidence(config({ plugins: {} }), cwd).find(
      (row) => row.engine === "codex" && row.kind === "hook" && row.id === "guard-destructive",
    );
    assert.isDefined(guard);
    expect(guard.registered.status).toBe("unverified");
    expect(guard.registered.reason).toBeDefined();
    expect(guard.trust.status).toBe("unverified");
    expect(guard.execution.status).toBe("not-run");
  });

  // Covers: R2
  it("does not verify a guard command moved to a wrong event or matcher", () => {
    const cwd = tempRepo();
    mkdirSync(join(cwd, ".codex"), { recursive: true });
    const cfg = config({ plugins: {} });
    const guard = resolveCodexHooks(cfg).find((hook) => hook.script === "guard-destructive");
    assert.isDefined(guard);
    const command = codexHookCommand(guard);
    const wrongEvent = `[[hooks.PostToolUse]]\nmatcher = "^Bash$"\n[[hooks.PostToolUse.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(command)}\ntimeout = ${guard.timeout}\nstatusMessage = ${JSON.stringify(guard.statusMessage)}\n`;
    const path = join(cwd, ".codex/config.toml");
    writeFileSync(path, wrongEvent);
    const findGuard = () =>
      buildEngineEvidence(cfg, cwd).find(
        (row) => row.id === "guard-destructive" && row.engine === "codex",
      );
    expect(findGuard()?.registered.status).toBe("missing");
    writeFileSync(
      path,
      wrongEvent.replaceAll("PostToolUse", "PreToolUse").replace("^Bash$", "^Other$"),
    );
    expect(findGuard()?.registered.status).toBe("missing");
    const correctEvent = wrongEvent.replaceAll("PostToolUse", "PreToolUse");
    writeFileSync(
      path,
      correctEvent.replace(`timeout = ${guard.timeout}`, `timeout = ${guard.timeout + 1}`),
    );
    expect(findGuard()?.registered.status).toBe("missing");
    writeFileSync(
      path,
      `${correctEvent}[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "echo duplicate"\ntimeout = 10\n`,
    );
    expect(findGuard()?.registered.status).toBe("missing");
  });

  // Covers: R2, R3
  it("exposes each enabled plugin hook absent from Codex materialization", () => {
    const cwd = tempRepo();
    const cfg = config({
      plugins: { semgrep: { enabled: true }, jscpd: { enabled: true } },
    });
    mkdirSync(join(cwd, ".codex"), { recursive: true });
    writeFileSync(join(cwd, ".codex/config.toml"), buildCodexConfigToml(cfg, []).body);
    const rows = buildEngineEvidence(cfg, cwd);
    for (const plugin of ["semgrep", "jscpd"]) {
      const hook = rows.find(
        (row) => row.engine === "codex" && row.id === `${plugin}:PreToolUse:Bash`,
      );
      assert.isDefined(hook);
      expect(hook.declared.status).toBe("verified");
      expect(hook.materialized.status).toBe("missing");
      expect(hook.registered.status).toBe("missing");
      expect(hook.execution.status).toBe("not-run");
    }
  });
});
