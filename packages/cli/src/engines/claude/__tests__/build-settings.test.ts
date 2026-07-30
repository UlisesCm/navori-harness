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
    expect(allow).toContain("Bash(sg:*)");
    expect(allow).toContain("Bash(ast-grep:*)");
    expect(allow).toContain("Bash(jq:*)");
    expect(allow).toContain("Bash(diff:*)");
    // Read-only git introspection.
    expect(allow).toContain("Bash(git blame*)");
    expect(allow).toContain("Bash(git config --get*)");
    expect(allow).toContain("Bash(git remote -v*)");
    // Destructive ops stay OUT of allow (they live in ask/deny).
    expect(allow).not.toContain("Bash(rm:*)");
    // Commands that LOOK read-only but can EXECUTE arbitrary code via a
    // smuggled flag stay out — permission patterns match by prefix and can't
    // exclude an inner flag:
    //   find (-delete/-exec), env/xargs (command runners), sed (-i),
    //   awk (system()/print > file), rg (--pre/--pre-glob run a command).
    for (const danger of ["find", "env", "xargs", "sed", "awk", "rg"]) {
      expect(allow.some((r) => r.startsWith(`Bash(${danger}`))).toBe(false);
    }
    // Tools that can WRITE an arbitrary file via argv stay out:
    //   sort -o <file>, uniq <in> <out>.
    expect(allow.some((r) => r.startsWith("Bash(sort"))).toBe(false);
    expect(allow.some((r) => r.startsWith("Bash(uniq"))).toBe(false);
    // git subcommands that reach the network (SSRF) or run a remote helper
    // stay out: ls-remote (--upload-pack RCE + arbitrary URL), remote show.
    expect(allow).not.toContain("Bash(git ls-remote*)");
    expect(allow).not.toContain("Bash(git remote show*)");
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
    const pre = (
      s.hooks as { PreToolUse: Array<{ matcher?: string; hooks: Array<{ command: string }> }> }
    ).PreToolUse;
    const guard = pre.find((b) => b.hooks.some((h) => h.command.includes("guard-destructive.sh")));
    expect(guard).toBeDefined();
    expect(guard?.matcher).toBe("Bash");
  });

  it("does NOT inject quality-gate hook when config.qualityGate.fast is unset", () => {
    const s = buildClaudeSettings(MINIMAL_CONFIG, []);
    const pre =
      (s.hooks as { PreToolUse?: Array<{ hooks: Array<{ command: string }> }> }).PreToolUse ?? [];
    const qg = pre.find((b) =>
      b.hooks.some((h) => h.command.includes("quality-gate-pre-commit.sh")),
    );
    expect(qg).toBeUndefined();
  });

  it("always registers the SessionStart context hook (startup|resume|compact)", () => {
    const s = buildClaudeSettings(MINIMAL_CONFIG, []);
    const ss = (
      s.hooks as {
        SessionStart?: Array<{ matcher?: string; hooks: Array<{ command: string }> }>;
      }
    ).SessionStart;
    const bucket = ss?.find((b) =>
      b.hooks.some((h) => h.command.includes("session-start-context.sh")),
    );
    expect(bucket).toBeDefined();
    expect(bucket?.matcher).toBe("startup|resume|compact");
    expect(bucket?.hooks[0].command).toContain("$CLAUDE_PROJECT_DIR");
  });

  it("always registers the SubagentStop handoff-validator hook", () => {
    const s = buildClaudeSettings(MINIMAL_CONFIG, []);
    const ss = (
      s.hooks as { SubagentStop?: Array<{ matcher?: string; hooks: Array<{ command: string }> }> }
    ).SubagentStop;
    const bucket = ss?.find((b) =>
      b.hooks.some((h) => h.command.includes("subagent-stop-handoff.sh")),
    );
    expect(bucket).toBeDefined();
    // No matcher — the validator runs for every subagent, agent-type agnostic.
    expect(bucket?.matcher).toBeUndefined();
    expect(bucket?.hooks[0].command).toContain("$CLAUDE_PROJECT_DIR");
  });

  it("always registers the PreCompact session-summary hook (manual|auto)", () => {
    const s = buildClaudeSettings(MINIMAL_CONFIG, []);
    const pc = (
      s.hooks as { PreCompact?: Array<{ matcher?: string; hooks: Array<{ command: string }> }> }
    ).PreCompact;
    const bucket = pc?.find((b) =>
      b.hooks.some((h) => h.command.includes("precompact-session-summary.sh")),
    );
    expect(bucket).toBeDefined();
    expect(bucket?.matcher).toBe("manual|auto");
  });

  it("does NOT register the Stop hook unless config.hooks.verifyOnStop is set", () => {
    const s = buildClaudeSettings(MINIMAL_CONFIG, []);
    expect((s.hooks as { Stop?: unknown }).Stop).toBeUndefined();
  });

  it("registers the Stop verify-before-done hook when config.hooks.verifyOnStop is true", () => {
    const cfg = { ...MINIMAL_CONFIG, hooks: { verifyOnStop: true } } as unknown as NavoriConfig;
    const stop = (
      buildClaudeSettings(cfg, []).hooks as {
        Stop?: Array<{ matcher?: string; hooks: Array<{ command: string }> }>;
      }
    ).Stop;
    const bucket = stop?.find((b) =>
      b.hooks.some((h) => h.command.includes("stop-verify-reminder.sh")),
    );
    expect(bucket).toBeDefined();
    expect(bucket?.hooks[0].command).toContain("$CLAUDE_PROJECT_DIR");
  });
});

describe("buildClaudeSettings — quality-gate hook", () => {
  it("injects PreToolUse Bash hook referencing the QG script when qualityGate.fast set", () => {
    const s = buildClaudeSettings(withQG(), []);
    const pre = (
      s.hooks as {
        PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string; timeout?: number }> }>;
      }
    ).PreToolUse;
    const qg = pre.find((b) =>
      b.hooks.some((h) => h.command.includes("quality-gate-pre-commit.sh")),
    );
    expect(qg).toBeDefined();
    expect(qg?.matcher).toBe("Bash");
    const qgHook = qg?.hooks.find((h) => h.command.includes("quality-gate-pre-commit.sh"));
    expect(qgHook?.timeout).toBe(180);
  });
});

describe("buildClaudeSettings — hook matcher coalescing (no double PreToolUse[Bash])", () => {
  type Bucket = { matcher?: string; hooks: Array<{ command: string }> };
  const preOf = (s: Record<string, unknown>) => (s.hooks as { PreToolUse: Bucket[] }).PreToolUse;

  it("collapses guard + quality-gate into a single Bash matcher bucket", () => {
    const pre = preOf(buildClaudeSettings(withQG(), []));
    const bashBuckets = pre.filter((b) => b.matcher === "Bash");
    expect(bashBuckets).toHaveLength(1);
    const cmds = bashBuckets[0].hooks.map((h) => h.command);
    expect(cmds.some((c) => c.includes("guard-destructive.sh"))).toBe(true);
    expect(cmds.some((c) => c.includes("quality-gate-pre-commit.sh"))).toBe(true);
  });

  it("folds a plugin's PreToolUse[Bash] hook into the same bucket", () => {
    const plugin = makePlugin({
      id: "gate",
      hooks: [{ event: "PreToolUse", matcher: "Bash", command: "bash .claude/scripts/check.sh" }],
    });
    const pre = preOf(buildClaudeSettings(withQG(), [plugin]));
    const bashBuckets = pre.filter((b) => b.matcher === "Bash");
    expect(bashBuckets).toHaveLength(1);
    expect(bashBuckets[0].hooks).toHaveLength(3); // guard + qg + plugin
  });

  it("keeps distinct matchers in separate buckets", () => {
    const plugin = makePlugin({
      id: "post",
      hooks: [{ event: "PreToolUse", matcher: "Write", command: "bash .claude/scripts/w.sh" }],
    });
    const pre = preOf(buildClaudeSettings(withQG(), [plugin]));
    expect(pre.filter((b) => b.matcher === "Bash")).toHaveLength(1);
    expect(pre.filter((b) => b.matcher === "Write")).toHaveLength(1);
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
    // The always-on guard and the plugin's Bash hook now share a single
    // Bash bucket (coalesced), so assert on membership, not position.
    const bashBucket = hooks.PreToolUse?.find((b) => b.matcher === "Bash");
    expect(bashBucket?.hooks.some((h) => h.command === "bash check.sh")).toBe(true);
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
    const pre = (
      s.hooks as { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> }
    ).PreToolUse;
    // Both same-event+matcher hooks land in the single Bash bucket (now shared
    // with the always-on guard via coalescing) — one bucket, both commands.
    const bashBuckets = pre.filter((b) => b.matcher === "Bash");
    expect(bashBuckets).toHaveLength(1);
    const cmds = bashBuckets[0].hooks.map((h) => h.command);
    expect(cmds).toContain("a");
    expect(cmds).toContain("b");
  });
});

describe("buildClaudeSettings — effortLevel from leader tier", () => {
  it("writes effortLevel from config.effort.leader", () => {
    const cfg = { ...MINIMAL_CONFIG, effort: { leader: "xhigh" } } as unknown as NavoriConfig;
    expect(buildClaudeSettings(cfg, []).effortLevel).toBe("xhigh");
  });

  it("omits effortLevel when no leader effort is set", () => {
    expect(buildClaudeSettings(MINIMAL_CONFIG, []).effortLevel).toBeUndefined();
  });

  it("skips effortLevel when leader effort is max (not accepted in settings.json)", () => {
    const cfg = { ...MINIMAL_CONFIG, effort: { leader: "max" } } as unknown as NavoriConfig;
    expect(buildClaudeSettings(cfg, []).effortLevel).toBeUndefined();
  });
});

describe("buildClaudeSettings — preset-aware allow (M4+A1)", () => {
  const allowOf = (config: NavoriConfig): string[] =>
    (buildClaudeSettings(config, []).permissions as { allow: string[] }).allow;

  it("pre-approves git write commands so add/commit stop prompting", () => {
    const allow = allowOf(MINIMAL_CONFIG);
    expect(allow).toContain("Bash(git add:*)");
    expect(allow).toContain("Bash(git commit:*)");
  });

  it("derives allow rules from the quality gate + package manager", () => {
    const config = {
      ...MINIMAL_CONFIG,
      qualityGate: {
        fast: "pnpm run typecheck",
        full: "pnpm run typecheck && pnpm run lint && pnpm run test",
      },
      packageManager: "pnpm",
    } as unknown as NavoriConfig;
    const allow = allowOf(config);
    // the exact commands the gate runs
    expect(allow).toContain("Bash(pnpm run typecheck:*)");
    expect(allow).toContain("Bash(pnpm run lint:*)");
    expect(allow).toContain("Bash(pnpm run test:*)");
    // the dev-loop scripts the gate doesn't list (build was the explicit pain)
    expect(allow).toContain("Bash(pnpm run build:*)");
  });

  it("falls back to the qualityGate runner when packageManager is absent (pre-field configs)", () => {
    const config = {
      ...MINIMAL_CONFIG,
      qualityGate: { fast: "pnpm run typecheck", full: "pnpm run test" },
    } as unknown as NavoriConfig;
    expect(allowOf(config)).toContain("Bash(pnpm run build:*)");
  });

  it("emits no <pm> run rules for a non-JS gate (python/ruff)", () => {
    const config = {
      ...MINIMAL_CONFIG,
      qualityGate: { fast: "ruff check .", full: "ruff check . && pytest" },
    } as unknown as NavoriConfig;
    const allow = allowOf(config);
    expect(allow).toContain("Bash(ruff check .:*)");
    expect(allow).toContain("Bash(pytest:*)");
    expect(allow.some((r) => r.includes(" run "))).toBe(false);
  });

  it("adds no derived <pm> run rules when there is no quality gate", () => {
    expect(allowOf(MINIMAL_CONFIG).some((r) => r.includes(" run "))).toBe(false);
  });

  it("is idempotent — no duplicate rules across base + derived merge", () => {
    const config = {
      ...MINIMAL_CONFIG,
      qualityGate: { fast: "pnpm run test", full: "pnpm run test" },
      packageManager: "pnpm",
    } as unknown as NavoriConfig;
    const allow = allowOf(config);
    expect(new Set(allow).size).toBe(allow.length);
  });
});
