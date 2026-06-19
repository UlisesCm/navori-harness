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

  it("does NOT inject quality-gate hook when config.qualityGate.fast is unset", () => {
    const s = buildClaudeSettings(MINIMAL_CONFIG, []);
    const hooks = s.hooks as Record<string, unknown>;
    expect(hooks.PreToolUse).toBeUndefined();
  });
});

describe("buildClaudeSettings — quality-gate hook", () => {
  it("injects PreToolUse Bash hook referencing the QG script when qualityGate.fast set", () => {
    const s = buildClaudeSettings(withQG(), []);
    const pre = (s.hooks as { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string; timeout?: number }> }> }).PreToolUse;
    expect(pre).toHaveLength(1);
    expect(pre[0].matcher).toBe("Bash");
    expect(pre[0].hooks[0].command).toContain("quality-gate-pre-commit.sh");
    expect(pre[0].hooks[0].timeout).toBe(180);
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
    expect(hooks.PreToolUse?.[0].matcher).toBe("Bash");
    expect(hooks.PreToolUse?.[0].hooks[0].command).toBe("bash check.sh");
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
    expect(pre).toHaveLength(1);
    expect(pre[0].hooks.map((h) => h.command)).toEqual(["a", "b"]);
  });
});
