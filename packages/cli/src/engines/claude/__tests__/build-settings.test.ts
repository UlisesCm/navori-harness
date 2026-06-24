import { describe, it, expect } from "vitest";
import { buildClaudeSettings } from "../build-settings.ts";
import type { NavoriConfig } from "../../../lib/config.ts";
import type { LoadedPlugin } from "../../../lib/plugins.ts";

const MINIMAL_CONFIG = {
  name: "test",
  engines: ["claude"],
  preset: "custom",
  version: "1.0.0",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
} as unknown as NavoriConfig;

function withQG(): NavoriConfig {
  return {
    ...MINIMAL_CONFIG,
    qualityGate: { fast: "pnpm typecheck", full: "pnpm test" },
  } as NavoriConfig;
}

function makePlugin(overrides: Partial<LoadedPlugin["manifest"]>): LoadedPlugin {
  return {
    manifest: {
      id: overrides.id ?? "p",
      name: overrides.name ?? "P",
      description: "...",
      version: "0.0.1",
      managed: [],
      ...overrides,
    } as LoadedPlugin["manifest"],
    packageRoot: "/tmp/fake",
    managedAssets: [],
    scriptAssets: [],
    skillAssets: [],
  };
}

describe("buildClaudeSettings — base shape", () => {
  it("includes the $navori ownership marker with resolved coreVersion", () => {
    const s = buildClaudeSettings(MINIMAL_CONFIG, []);
    const navori = s.$navori as { managed: boolean; version: string };
    expect(navori.managed).toBe(true);
    expect(navori.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("ships base permissions.allow entries (read-only git checks)", () => {
    const s = buildClaudeSettings(MINIMAL_CONFIG, []);
    const allow = (s.permissions as { allow: string[] }).allow;
    expect(allow).toContain("Bash(git status*)");
    expect(allow).toContain("Bash(git diff*)");
  });

  it("ships read-only allow entries so trivial reads don't prompt (native tools + file inspection)", () => {
    const s = buildClaudeSettings(MINIMAL_CONFIG, []);
    const allow = (s.permissions as { allow: string[] }).allow;
    // Native read-only tools — cannot write or execute.
    expect(allow).toContain("Read");
    expect(allow).toContain("Glob");
    expect(allow).toContain("Grep");
    // File inspection without any destructive flag.
    expect(allow).toContain("Bash(cat:*)");
    expect(allow).toContain("Bash(ls:*)");
    // Search / text inspection — read-only, no in-place write mode.
    expect(allow).toContain("Bash(grep:*)");
    expect(allow).toContain("Bash(rg:*)");
    expect(allow).toContain("Bash(jq:*)");
    expect(allow).toContain("Bash(diff:*)");
    // Read-only git introspection.
    expect(allow).toContain("Bash(git blame*)");
    expect(allow).toContain("Bash(git config --get*)");
    expect(allow).toContain("Bash(git remote -v*)");
    // Destructive ops stay OUT of allow (they live in ask/deny).
    expect(allow).not.toContain("Bash(rm:*)");
    // Commands that LOOK read-only but can write/execute are deliberately
    // kept out: find (-delete/-exec), env/xargs (command runners), sed (-i),
    // awk (system()/print > file). Prefix patterns can't exclude those flags.
    for (const danger of ["find", "env", "xargs", "sed", "awk"]) {
      expect(allow.some((r) => r.startsWith(`Bash(${danger}`))).toBe(false);
    }
    // git subcommands that mutate refs/config must not slip in via a bare prefix.
    expect(allow).not.toContain("Bash(git tag*)");
    expect(allow).not.toContain("Bash(git config*)");
    expect(allow).not.toContain("Bash(git remote*)");
  });

  it("ships permissions.deny for catastrophic, no-legit-use commands (hard block)", () => {
    const s = buildClaudeSettings(MINIMAL_CONFIG, []);
    const deny = (s.permissions as { deny: string[] }).deny;
    expect(deny).toContain("Bash(rm -rf /*)");
    expect(deny).toContain("Bash(sudo rm *)");
    expect(deny).toContain("Bash(mkfs*)");
  });

  it("ships permissions.ask for destructive-but-sometimes-legit commands (human confirm)", () => {
    const s = buildClaudeSettings(MINIMAL_CONFIG, []);
    const ask = (s.permissions as { ask: string[] }).ask;
    expect(ask).toContain("Bash(rm -rf *)");
    expect(ask).toContain("Bash(git push --force*)");
    expect(ask).toContain("Bash(git reset --hard*)");
  });

  it("always injects the defensive guard PreToolUse(Bash) hook, regardless of config", () => {
    const s = buildClaudeSettings(MINIMAL_CONFIG, []);
    const pre = (s.hooks as { PreToolUse: Array<{ matcher?: string; hooks: Array<{ command: string }> }> }).PreToolUse;
    const guard = pre.find((b) => b.hooks.some((h) => h.command.includes("guard-destructive.sh")));
    expect(guard).toBeDefined();
    expect(guard?.matcher).toBe("Bash");
  });

  it("does NOT inject quality-gate hook when config.qualityGate.fast is unset", () => {
    const s = buildClaudeSettings(MINIMAL_CONFIG, []);
    const pre = (s.hooks as { PreToolUse?: Array<{ hooks: Array<{ command: string }> }> }).PreToolUse ?? [];
    const qg = pre.find((b) => b.hooks.some((h) => h.command.includes("quality-gate-pre-commit.sh")));
    expect(qg).toBeUndefined();
  });
});

describe("buildClaudeSettings — quality-gate hook", () => {
  it("injects PreToolUse Bash hook referencing the QG script when qualityGate.fast set", () => {
    const s = buildClaudeSettings(withQG(), []);
    const pre = (s.hooks as { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string; timeout?: number }> }> }).PreToolUse;
    const qg = pre.find((b) => b.hooks.some((h) => h.command.includes("quality-gate-pre-commit.sh")));
    expect(qg).toBeDefined();
    expect(qg?.matcher).toBe("Bash");
    const qgHook = qg?.hooks.find((h) => h.command.includes("quality-gate-pre-commit.sh"));
    expect(qgHook?.timeout).toBe(180);
  });
});

describe("buildClaudeSettings — plugin merging", () => {
  it("merges plugin.settingsFragment with permissions concatenation + dedupe", () => {
    const plugin = makePlugin({
      id: "extra",
      settingsFragment: {
        permissions: { allow: ["Bash(pnpm test)", "Bash(git status*)"] },
      },
    });
    const s = buildClaudeSettings(MINIMAL_CONFIG, [plugin]);
    const allow = (s.permissions as { allow: string[] }).allow;
    expect(allow).toContain("Bash(pnpm test)");
    // dedupe: existing `Bash(git status*)` must not be duplicated
    expect(allow.filter((v) => v === "Bash(git status*)").length).toBe(1);
  });

  it("translates plugin.hooks[] from flat shape to Claude Code nested shape", () => {
    const plugin = makePlugin({
      id: "h",
      hooks: [
        { event: "PreToolUse", matcher: "Bash", command: "bash check.sh", timeout: 60 },
        { event: "PostToolUse", command: "echo done" },
      ],
    });
    const s = buildClaudeSettings(MINIMAL_CONFIG, [plugin]);
    const hooks = s.hooks as {
      PreToolUse?: Array<{ matcher?: string; hooks: Array<{ command: string }> }>;
      PostToolUse?: Array<{ matcher?: string; hooks: Array<{ command: string }> }>;
    };
    // The always-on guard occupies a PreToolUse bucket; find the plugin's.
    const pluginPre = hooks.PreToolUse?.find((b) => b.hooks.some((h) => h.command === "bash check.sh"));
    expect(pluginPre?.matcher).toBe("Bash");
    expect(pluginPre?.hooks[0].command).toBe("bash check.sh");
    expect(hooks.PostToolUse?.[0].matcher).toBeUndefined();
    expect(hooks.PostToolUse?.[0].hooks[0].command).toBe("echo done");
  });

  it("groups multiple plugin hooks on the same event+matcher under one bucket", () => {
    const plugin = makePlugin({
      id: "m",
      hooks: [
        { event: "PreToolUse", matcher: "Bash", command: "a" },
        { event: "PreToolUse", matcher: "Bash", command: "b" },
      ],
    });
    const s = buildClaudeSettings(MINIMAL_CONFIG, [plugin]);
    const pre = (s.hooks as { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> }).PreToolUse;
    // The plugin's two same-event+matcher hooks collapse into one bucket
    // (a separate bucket from the always-on guard hook).
    const pluginBucket = pre.find((b) => b.hooks.some((h) => h.command === "a"));
    expect(pluginBucket?.hooks.map((h) => h.command)).toEqual(["a", "b"]);
  });
});
