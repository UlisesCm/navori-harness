import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
  readExistingSettings,
  settingsHasBaseline,
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

/**
 * #497 — `~/.claude/settings.json` is machine-wide, hand-edited, and versioned by
 * nobody. These specs pin the two halves of the fix: an unreadable file aborts
 * instead of being merged against `{}`, and a readable one is snapshotted before
 * it is rewritten.
 */

/** The user's real global settings, as the issue reported them. */
const USER_SETTINGS = {
  model: "opusplan",
  statusLine: { type: "command", command: "~/.claude/statusline.sh" },
  env: { ANTHROPIC_LOG: "debug" },
  hooks: {
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: "bash ~/.claude/hooks/mine.sh" }] },
    ],
  },
  permissions: { allow: ["Bash(ls:*)"], deny: ["Bash(rm -rf:*)"] },
};

/** The same settings with ONE trailing comma — how a hand-edited file breaks. */
const CORRUPT_SETTINGS = `${JSON.stringify(USER_SETTINGS, null, 2).replace(/\n\}$/, ",\n}")}\n`;

/** Every file under `dir`, as paths relative to it. */
function filesUnder(dir: string, root = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full, root));
    else out.push(relative(root, full));
  }
  return out;
}

describe("global-render — an unreadable settings.json is never merged over (#497)", () => {
  it("readExistingSettings tells absent from unreadable instead of returning {}", () => {
    const path = join(claudeDir, "settings.json");
    expect(readExistingSettings(claudeDir)).toEqual({ kind: "absent" });

    writeFileSync(path, JSON.stringify(USER_SETTINGS));
    expect(readExistingSettings(claudeDir)).toEqual({ kind: "ok", settings: USER_SETTINGS });

    writeFileSync(path, CORRUPT_SETTINGS);
    const corrupt = readExistingSettings(claudeDir);
    expect(corrupt.kind).toBe("parse-error");
    expect(corrupt.kind === "parse-error" && corrupt.detail.length).toBeGreaterThan(0);

    writeFileSync(path, "[1, 2]");
    expect(readExistingSettings(claudeDir)).toEqual({ kind: "not-object" });
  });

  it("aborts on a trailing comma, naming the file, and leaves it byte-for-byte", () => {
    const path = join(claudeDir, "settings.json");
    writeFileSync(path, CORRUPT_SETTINGS);
    const before = readFileSync(path, "utf-8");

    expect(() => planGlobalRender(defaultGlobalConfig("0.5.0"))).toThrow(path);
    expect(() => planGlobalRender(defaultGlobalConfig("0.5.0"))).toThrow(/JSON/);
    expect(readFileSync(path, "utf-8")).toBe(before);
  });

  it("aborts when settings.json holds something that is not a JSON object", () => {
    const path = join(claudeDir, "settings.json");
    writeFileSync(path, '["not", "an", "object"]');
    const before = readFileSync(path, "utf-8");

    expect(() => planGlobalRender(defaultGlobalConfig("0.5.0"))).toThrow(path);
    expect(readFileSync(path, "utf-8")).toBe(before);
  });

  it("still installs normally when there is no settings.json at all", () => {
    expect(existsSync(join(claudeDir, "settings.json"))).toBe(false);
    const plan = planGlobalRender(defaultGlobalConfig("0.5.0"));
    expect(applyGlobalRender(plan)).toBeNull(); // nothing to snapshot on a first install
    const written = JSON.parse(readFileSync(plan.settingsPath, "utf-8")) as Record<string, unknown>;
    expect(written.hooks).toBeDefined();
  });

  it("doctor's checks report 'not registered' instead of trusting an unreadable file", () => {
    const cfg = defaultGlobalConfig("0.5.0");
    cfg.permissions.allow = ["Bash(pnpm test:*)"];
    applyGlobalRender(planGlobalRender(cfg));
    expect(settingsHasBaseline(claudeDir)).toBe(true);
    expect(settingsHasPermissions(cfg, claudeDir)).toBe(true);

    writeFileSync(join(claudeDir, "settings.json"), CORRUPT_SETTINGS);
    expect(settingsHasBaseline(claudeDir)).toBe(false);
    expect(settingsHasPermissions(cfg, claudeDir)).toBe(false);
  });
});

describe("global-render — the previous settings.json is backed up before the rewrite (#497)", () => {
  it("saves the user's file byte-for-byte, with its original keys, into the backup store", () => {
    const path = join(claudeDir, "settings.json");
    writeFileSync(path, `${JSON.stringify(USER_SETTINGS, null, 2)}\n`);
    const original = readFileSync(path, "utf-8");

    const backupPath = applyGlobalRender(planGlobalRender(defaultGlobalConfig("0.5.0")));
    expect(backupPath).toBeTruthy();
    expect(backupPath?.startsWith(process.env.NAVORI_BACKUP_ROOT as string)).toBe(true);

    // The point of a backup is that it can be restored, so assert its CONTENT.
    const saved = readFileSync(join(backupPath as string, "settings.json"), "utf-8");
    expect(saved).toBe(original);
    const parsed = JSON.parse(saved) as typeof USER_SETTINGS;
    expect(parsed.model).toBe("opusplan");
    expect(parsed.env.ANTHROPIC_LOG).toBe("debug");
    expect(parsed.statusLine.command).toBe("~/.claude/statusline.sh");
    expect(parsed.hooks.PreToolUse[0]?.hooks[0]?.command).toBe("bash ~/.claude/hooks/mine.sh");
    expect(parsed.permissions.deny).toEqual(["Bash(rm -rf:*)"]);

    // …and it is a snapshot of the PREVIOUS state, not a copy of the new one.
    expect(readFileSync(path, "utf-8")).not.toBe(original);
  });

  it("snapshots only settings.json, never the Claude config dir (#348)", () => {
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify(USER_SETTINGS));
    // ~/.claude also holds session transcripts and agent worktrees: walking it
    // into a backup on every render is what filled a disk with 131 GB.
    mkdirSync(join(claudeDir, "projects", "some-repo"), { recursive: true });
    writeFileSync(join(claudeDir, "projects", "some-repo", "session.jsonl"), "x".repeat(1024));
    mkdirSync(join(claudeDir, "worktrees", "feature"), { recursive: true });
    writeFileSync(join(claudeDir, "worktrees", "feature", "file.ts"), "x");

    const backupPath = applyGlobalRender(planGlobalRender(defaultGlobalConfig("0.5.0")));
    expect(filesUnder(backupPath as string)).toEqual(["settings.json"]);
  });
});

describe("global-render — uninstall against an unreadable settings.json (#497)", () => {
  it("removes the hook file but leaves the settings byte-for-byte, and says so", () => {
    applyGlobalRender(planGlobalRender(defaultGlobalConfig("0.5.0")));
    const path = join(claudeDir, "settings.json");
    writeFileSync(path, CORRUPT_SETTINGS);
    const before = readFileSync(path, "utf-8");

    const result = uninstallGlobalRender(claudeDir);
    expect(result.removedHook).toBe(true);
    expect(result.updatedSettings).toBe(false);
    expect(result.settingsUnreadable).toBe(true);
    expect(result.backupPath).toBeNull();
    expect(readFileSync(path, "utf-8")).toBe(before);
  });

  it("backs up the settings it DOES rewrite, keeping the pre-uninstall state", () => {
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify(USER_SETTINGS));
    applyGlobalRender(planGlobalRender(defaultGlobalConfig("0.5.0")));

    const result = uninstallGlobalRender(claudeDir);
    expect(result.updatedSettings).toBe(true);
    expect(result.backupPath).toBeTruthy();
    const saved = JSON.parse(
      readFileSync(join(result.backupPath as string, "settings.json"), "utf-8"),
    ) as { model?: string; hooks?: { SessionStart?: unknown } };
    expect(saved.model).toBe("opusplan");
    expect(saved.hooks?.SessionStart).toBeDefined(); // the state BEFORE the strip
  });
});

describe("global init — end to end against the built CLI (#497)", () => {
  const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../dist/index.js");

  /** Run the real binary with HOME and CLAUDE_CONFIG_DIR pinned to temp dirs. */
  function runGlobalInit(): { status: number; combined: string } {
    const r = spawnSync("node", [CLI, "global", "init"], {
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: scratch,
        CLAUDE_CONFIG_DIR: claudeDir,
        FORCE_COLOR: "0",
      },
    });
    return { status: r.status ?? -1, combined: (r.stdout ?? "") + (r.stderr ?? "") };
  }

  it("fails loudly and writes NOTHING when settings.json has a trailing comma", () => {
    const path = join(claudeDir, "settings.json");
    writeFileSync(path, CORRUPT_SETTINGS);
    const before = readFileSync(path, "utf-8");

    const { status, combined } = runGlobalInit();

    expect(status).not.toBe(0);
    expect(combined).toContain(path);
    expect(readFileSync(path, "utf-8")).toBe(before); // byte-for-byte, not just present
    expect(existsSync(globalHookPath(claudeDir))).toBe(false);
    expect(existsSync(join(scratch, ".navori", "global.json"))).toBe(false); // nothing persisted
  });

  it("installs the baseline when settings.json is absent", () => {
    const { status } = runGlobalInit();

    expect(status).toBe(0);
    expect(existsSync(globalHookPath(claudeDir))).toBe(true);
    const written = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf-8")) as {
      hooks?: { SessionStart?: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(written.hooks?.SessionStart?.[0]?.hooks[0]?.command).toContain(
      "navori-global-baseline.sh",
    );
  });
});
