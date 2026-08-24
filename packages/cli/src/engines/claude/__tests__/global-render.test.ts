import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultGlobalConfig } from "../../../lib/global-config.ts";
import {
  applyGlobalRender,
  composeBaseline,
  configuredPermissionsCount,
  generateHookScript,
  globalHookPath,
  globalTargetDir,
  permissionsFragment,
  planGlobalRender,
  settingsHasPermissions,
  stripBaselineFromSettings,
  uninstallGlobalRender,
} from "../global-render.ts";

/**
 * The global render targets Claude Code's config dir, which we pin to a throwaway
 * temp dir via CLAUDE_CONFIG_DIR so nothing touches the developer's real
 * ~/.claude. composeBaseline reads the REAL core blocks (getCoreRoot), which is
 * the point — it validates against shipped content.
 */
let claudeDir: string;
let scratch: string;
const savedEnv = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
  claudeDir = mkdtempSync(join(tmpdir(), "navori-claude-"));
  scratch = mkdtempSync(join(tmpdir(), "navori-scratch-"));
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedEnv;
  rmSync(claudeDir, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

describe("global-render — target dir", () => {
  it("globalTargetDir respects CLAUDE_CONFIG_DIR", () => {
    expect(globalTargetDir()).toBe(claudeDir);
    expect(globalHookPath()).toBe(join(claudeDir, "hooks/navori-global-baseline.sh"));
  });
});

describe("global-render — composeBaseline", () => {
  it("stitches the audited baseline blocks with a (Spanish default) intro", () => {
    const body = composeBaseline(defaultGlobalConfig("0.5.0"));
    expect(body).toContain("baseline navori de máquina"); // localized intro (es default)
    expect(body).toContain("Operations on data and infrastructure"); // operaciones-seguras
    expect(body).toContain("Idioma y rol"); // idioma-rol
    expect(body).toContain("Concisión"); // formato-respuesta
  });

  it("localizes the intro to the config language (en)", () => {
    const body = composeBaseline(defaultGlobalConfig("0.5.0", "en"));
    expect(body).toContain("machine-wide navori baseline");
    expect(body).not.toContain("baseline navori de máquina");
  });

  it("rejects an unknown block id", () => {
    const cfg = defaultGlobalConfig("0.5.0");
    cfg.blocks.include = ["does-not-exist"];
    expect(() => composeBaseline(cfg)).toThrow(/unknown core block/);
  });

  it("rejects a block that interpolates repo config (audit enforced at runtime)", () => {
    const cfg = defaultGlobalConfig("0.5.0");
    cfg.blocks.include = ["orquestacion"]; // has {{branchBase}} / {{qualityGate.*}}
    expect(() => composeBaseline(cfg)).toThrow(/interpolates repo config/);
  });
});

describe("global-render — hook script + gate (executed with bash)", () => {
  it("emits the baseline as SessionStart context when NO repo navori config is present", () => {
    const script = generateHookScript(composeBaseline(defaultGlobalConfig("0.5.0")));
    const hookFile = join(scratch, "hook.sh");
    writeFileSync(hookFile, script);
    const out = execFileSync("bash", [hookFile], { cwd: scratch, input: "", encoding: "utf-8" });
    const parsed = JSON.parse(out) as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
    };
    expect(parsed.hookSpecificOutput?.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput?.additionalContext).toContain(
      "Operations on data and infrastructure",
    );
  });

  it("DEFERS (emits nothing) when a navori.config.json exists at/above cwd", () => {
    const script = generateHookScript(composeBaseline(defaultGlobalConfig("0.5.0")));
    const hookFile = join(scratch, "hook.sh");
    writeFileSync(hookFile, script);
    // Simulate a navori repo: config at cwd.
    const repo = join(scratch, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "navori.config.json"), JSON.stringify({ name: "x" }));
    const out = execFileSync("bash", [hookFile], { cwd: repo, input: "", encoding: "utf-8" });
    expect(out.trim()).toBe("");
  });

  it("DEFERS from a nested subdir of a navori repo (walks up to find the config)", () => {
    const script = generateHookScript(composeBaseline(defaultGlobalConfig("0.5.0")));
    const hookFile = join(scratch, "hook.sh");
    writeFileSync(hookFile, script);
    const nested = join(scratch, "repo", "src", "deep");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(scratch, "repo", "navori.config.json"), JSON.stringify({ name: "x" }));
    const out = execFileSync("bash", [hookFile], { cwd: nested, input: "", encoding: "utf-8" });
    expect(out.trim()).toBe("");
  });
});

describe("global-render — settings merge (no clobber)", () => {
  it("registers the hook pointing at the absolute path", () => {
    const plan = planGlobalRender(defaultGlobalConfig("0.5.0"));
    const ss = (plan.settings.hooks as { SessionStart?: Array<{ hooks: { command: string }[] }> })
      .SessionStart;
    expect(ss).toBeDefined();
    const cmd = ss?.[0]?.hooks[0]?.command;
    expect(cmd).toBe(`bash "${plan.hookPath}"`);
    expect(plan.hookPath).toBe(join(claudeDir, "hooks/navori-global-baseline.sh"));
  });

  it("preserves the user's existing global settings", () => {
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify({ model: "opusplan", permissions: { allow: ["Bash(ls:*)"] } }),
    );
    const plan = planGlobalRender(defaultGlobalConfig("0.5.0"));
    expect(plan.settings.model).toBe("opusplan");
    expect((plan.settings.permissions as { allow: string[] }).allow).toContain("Bash(ls:*)");
    expect(plan.settings.hooks).toBeDefined();
  });
});

describe("global-render — personal permissions merge (#237)", () => {
  function cfgWithPerms() {
    const cfg = defaultGlobalConfig("0.5.0");
    cfg.permissions.allow = ["Bash(pnpm test:*)"];
    cfg.permissions.deny = ["Bash(rm -rf:*)"];
    return cfg;
  }

  it("emits no permissions fragment when none are configured", () => {
    expect(permissionsFragment(defaultGlobalConfig("0.5.0"))).toEqual({});
    expect(configuredPermissionsCount(defaultGlobalConfig("0.5.0"))).toBe(0);
  });

  it("merges configured permissions additively into settings.json", () => {
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }),
    );
    const cfg = cfgWithPerms();
    const plan = planGlobalRender(cfg);
    const perms = plan.settings.permissions as { allow: string[]; deny: string[] };
    expect(perms.allow).toContain("Bash(ls:*)"); // user's existing kept
    expect(perms.allow).toContain("Bash(pnpm test:*)"); // navori's added
    expect(perms.deny).toContain("Bash(rm -rf:*)");
    expect(plan.settings.hooks).toBeDefined(); // hook still registered too
  });

  it("settingsHasPermissions reflects whether the perms landed on disk", () => {
    const cfg = cfgWithPerms();
    expect(settingsHasPermissions(cfg)).toBe(false); // nothing written yet
    applyGlobalRender(planGlobalRender(cfg));
    expect(settingsHasPermissions(cfg)).toBe(true);
  });
});

describe("global-render — apply + uninstall round-trip", () => {
  it("writes an executable hook and merged settings, then uninstall removes only navori", () => {
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ model: "opusplan" }));
    const plan = planGlobalRender(defaultGlobalConfig("0.5.0"));
    applyGlobalRender(plan);

    expect(existsSync(plan.hookPath)).toBe(true);
    expect(statSync(plan.hookPath).mode & 0o111).toBeGreaterThan(0); // executable bit
    const written = JSON.parse(readFileSync(plan.settingsPath, "utf-8")) as Record<string, unknown>;
    expect(written.model).toBe("opusplan");
    expect(written.hooks).toBeDefined();

    const result = uninstallGlobalRender();
    expect(result.removedHook).toBe(true);
    expect(result.updatedSettings).toBe(true);
    expect(existsSync(plan.hookPath)).toBe(false);
    const after = JSON.parse(readFileSync(plan.settingsPath, "utf-8")) as Record<string, unknown>;
    expect(after.model).toBe("opusplan"); // user key intact
    expect(after.hooks).toBeUndefined(); // navori's only hook pruned cleanly
  });

  it("stripBaselineFromSettings leaves an unrelated SessionStart hook intact", () => {
    const settings = {
      hooks: {
        SessionStart: [
          {
            matcher: "startup",
            hooks: [
              { type: "command", command: "bash /other/tool.sh" },
              { type: "command", command: 'bash "/x/hooks/navori-global-baseline.sh"' },
            ],
          },
        ],
      },
    };
    const stripped = stripBaselineFromSettings(settings) as typeof settings;
    // `?? []` cannot hide a dropped bucket: the length assertion below fails on it.
    const kept = stripped.hooks.SessionStart[0]?.hooks ?? [];
    expect(kept).toHaveLength(1);
    expect(kept[0]?.command).toBe("bash /other/tool.sh");
  });
});
