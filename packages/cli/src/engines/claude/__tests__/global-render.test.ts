import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readCliVersion } from "../../../lib/bundled-assets.ts";
import { defaultGlobalConfig } from "../../../lib/global-config.ts";
import {
  applyGlobalRender,
  composeBaseline,
  configuredPermissionsCount,
  generateHookScript,
  legacyGlobalHookPath,
  probeGate,
  readHookDrift,
  globalTargetDir,
  permissionsFragment,
  planGlobalRender,
  readExistingSettings,
  settingsHasLegacyHook,
  settingsHasPermissions,
  stripBaselineFromSettings,
  uninstallGlobalRender,
} from "../global-render.ts";
import {
  applyGlobalPlugin,
  globalPluginDir,
  planGlobalPlugin,
  pluginInstalled,
  removeGlobalPlugin,
  PLUGIN_HOOKS_REL,
  PLUGIN_HOOK_SCRIPT_REL,
  PLUGIN_MANIFEST_REL,
} from "../global-plugin.ts";

/** Where the gate hook lives since FB: inside the @skills-dir plugin. */
function hookPathOf(dir: string): string {
  return join(globalPluginDir(dir), PLUGIN_HOOK_SCRIPT_REL);
}

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
    expect(globalPluginDir()).toBe(join(claudeDir, "skills/navori"));
    expect(legacyGlobalHookPath()).toBe(join(claudeDir, "hooks/navori-global-baseline.sh"));
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

  it("rejects a block that is not marked globalSafe (audit enforced at runtime)", () => {
    const cfg = defaultGlobalConfig("0.5.0");
    cfg.blocks.include = ["tipado-fuerte"]; // condition-gated: reads repo config
    expect(() => composeBaseline(cfg)).toThrow(/not marked globalSafe/);
  });

  /**
   * FB (#546): the routing doctrine ships whole. Its three repo-truths render as
   * the instruction to derive them, so what a session inherits never quotes a
   * quality gate or a base branch that belongs to some other repo.
   */
  it("renders orquestacion with derived repo-truths, not a baked command", () => {
    const body = composeBaseline(defaultGlobalConfig("0.5.0"));
    expect(body).toContain("R1 · Inline");
    expect(body).not.toContain("{{qualityGate.full}}");
    expect(body).not.toContain("<not configured:");
    expect(body).toContain("el quality gate que el proyecto declare");
  });

  /**
   * The #541 regression, pinned where it would actually bite. `arranque-sesion`
   * interpolates NOTHING, so the former `/\{\{/` audit waved it through — and it
   * describes `progress/current.md`, `navori doctor` and `navori.config.json`,
   * none of which exist in a project without navori. The declared mark is what
   * catches it; the interpolation scan never could.
   *
   * (The unresolved-placeholder scan survives in `composeBaseline` as a
   * secondary net. It is unreachable while `global-safe-inventory.test.ts` is
   * green, since that suite asserts every globalSafe asset resolves — which is
   * the point of a net.)
   */
  it("rejects arranque-sesion, which the old interpolation-only audit accepted", () => {
    const cfg = defaultGlobalConfig("0.5.0");
    cfg.blocks.include = ["arranque-sesion"];
    expect(() => composeBaseline(cfg)).toThrow(/not marked globalSafe/);
  });

  it("accepts every block the default baseline ships with", () => {
    const cfg = defaultGlobalConfig("0.5.0");
    expect(() => composeBaseline(cfg)).not.toThrow();
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

  /**
   * The baseline is PROSE, and prose has apostrophes. While the heredoc sat
   * directly inside `$( … )`, bash 3.2 (still `/bin/bash` on macOS) parsed the
   * body before honoring the heredoc's quoting, so the hook aborted with
   * "unexpected EOF while looking for matching `''" whenever the embedded
   * assets happened to hold an ODD number of `'`. It shipped green only by
   * parity: one edit to one sentence in `operaciones-seguras.md` was enough to
   * take the global baseline down for every repo without its own harness.
   * Metacharacters the shell would otherwise expand ride along in the same case.
   */
  it("survives a baseline with an unbalanced quote and shell metacharacters", () => {
    const prose = "don't stop — a lone ' and a ) plus $(echo pwned) and `backticks`";
    const hookFile = join(scratch, "hook.sh");
    writeFileSync(hookFile, generateHookScript(prose));
    const out = execFileSync("bash", [hookFile], { cwd: scratch, input: "", encoding: "utf-8" });
    const parsed = JSON.parse(out) as { hookSpecificOutput?: { additionalContext?: string } };
    // Verbatim: the quote does not abort the parse and `$(…)` is not expanded.
    expect(parsed.hookSpecificOutput?.additionalContext).toContain(prose);
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
  /**
   * FB (#546): the gate is registered by the plugin's own `hooks/hooks.json`,
   * addressed through `${CLAUDE_PLUGIN_ROOT}`. Nothing navori writes reaches the
   * `hooks` key of the user's machine-wide settings.json anymore.
   */
  it("puts NO hook in settings.json — the plugin's hooks.json owns the gate", () => {
    const plan = planGlobalRender(defaultGlobalConfig("0.5.0"));
    expect(plan.settings.hooks).toBeUndefined();
    expect(plan.settingsChanged).toBe(false);

    const cfg = defaultGlobalConfig("0.5.0");
    const hooks = JSON.parse(
      planGlobalPlugin(cfg, composeBaseline(cfg), claudeDir).files.find(
        (f) => f.relPath === PLUGIN_HOOKS_REL,
      )!.content,
    ) as { hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> } };
    expect(hooks.hooks.SessionStart[0]!.hooks[0]!.command).toBe(
      `"\${CLAUDE_PLUGIN_ROOT}"/${PLUGIN_HOOK_SCRIPT_REL}`,
    );
  });

  it("preserves the user's existing global settings", () => {
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify({ model: "opusplan", permissions: { allow: ["Bash(ls:*)"] } }),
    );
    const plan = planGlobalRender(defaultGlobalConfig("0.5.0"));
    expect(plan.settings.model).toBe("opusplan");
    expect((plan.settings.permissions as { allow: string[] }).allow).toContain("Bash(ls:*)");
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
    expect(plan.settingsChanged).toBe(true);
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
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify({ model: "opusplan", permissions: { allow: ["Bash(ls:*)"] } }),
    );
    const cfg = defaultGlobalConfig("0.5.0");
    cfg.permissions.allow = ["Bash(pnpm test:*)"];
    const plan = planGlobalRender(cfg, claudeDir);
    applyGlobalPlugin(planGlobalPlugin(cfg, composeBaseline(cfg), claudeDir));
    applyGlobalRender(plan);
    cfg.ownedPermissions = plan.ownedPermissions;

    const hookPath = hookPathOf(claudeDir);
    expect(existsSync(hookPath)).toBe(true);
    expect(statSync(hookPath).mode & 0o111).toBeGreaterThan(0); // executable bit
    const written = JSON.parse(readFileSync(plan.settingsPath, "utf-8")) as Record<string, unknown>;
    expect(written.model).toBe("opusplan");
    expect(written.hooks).toBeUndefined(); // FB: the gate lives in the plugin

    expect(removeGlobalPlugin(claudeDir)).toBe(true);
    const result = uninstallGlobalRender(claudeDir, cfg);
    expect(result.updatedSettings).toBe(true);
    expect(existsSync(hookPath)).toBe(false);
    expect(existsSync(globalPluginDir(claudeDir))).toBe(false);
    const after = JSON.parse(readFileSync(plan.settingsPath, "utf-8")) as {
      model?: string;
      permissions?: { allow?: string[] };
    };
    expect(after.model).toBe("opusplan"); // user key intact
    expect(after.permissions?.allow).toEqual(["Bash(ls:*)"]); // theirs stays, navori's goes
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

/**
 * A config that actually changes settings.json. Since FB moved the gate into
 * the plugin, a default config merges NOTHING into the user's file — so the
 * write/backup contract can only be exercised with a permission declared.
 */
function cfgThatWritesSettings(version = "0.5.0") {
  const cfg = defaultGlobalConfig(version);
  cfg.permissions.allow = ["Bash(pnpm test:*)"];
  return cfg;
}

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
    const plan = planGlobalRender(cfgThatWritesSettings());
    expect(applyGlobalRender(plan)).toBeNull(); // nothing to snapshot on a first install
    const written = JSON.parse(readFileSync(plan.settingsPath, "utf-8")) as {
      permissions?: { allow?: string[] };
    };
    expect(written.permissions?.allow).toEqual(["Bash(pnpm test:*)"]);
  });

  /**
   * A default config now leaves settings.json alone entirely, so a first install
   * on a machine with no settings.json creates no file — the absence IS the
   * correct state, not a failed write.
   */
  it("writes no settings.json at all when nothing has to be merged into it", () => {
    const plan = planGlobalRender(defaultGlobalConfig("0.5.0"));
    expect(plan.settingsChanged).toBe(false);
    expect(applyGlobalRender(plan)).toBeNull();
    expect(existsSync(join(claudeDir, "settings.json"))).toBe(false);
  });

  it("doctor's checks report 'not merged' instead of trusting an unreadable file", () => {
    const cfg = cfgThatWritesSettings();
    applyGlobalRender(planGlobalRender(cfg));
    expect(settingsHasPermissions(cfg, claudeDir)).toBe(true);

    writeFileSync(join(claudeDir, "settings.json"), CORRUPT_SETTINGS);
    expect(settingsHasPermissions(cfg, claudeDir)).toBe(false);
    expect(settingsHasLegacyHook(claudeDir)).toBe(false);
  });
});

describe("global-render — the previous settings.json is backed up before the rewrite (#497)", () => {
  it("saves the user's file byte-for-byte, with its original keys, into the backup store", () => {
    const path = join(claudeDir, "settings.json");
    writeFileSync(path, `${JSON.stringify(USER_SETTINGS, null, 2)}\n`);
    const original = readFileSync(path, "utf-8");

    const backupPath = applyGlobalRender(planGlobalRender(cfgThatWritesSettings()));
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

    const backupPath = applyGlobalRender(planGlobalRender(cfgThatWritesSettings()));
    expect(filesUnder(backupPath as string)).toEqual(["settings.json"]);
  });
});

/**
 * Seed an F1-era install: the gate hook loose under the Claude config dir, plus
 * the SessionStart entry navori used to merge into the user's settings.json.
 * That layout is what uninstall and the FB migration still have to handle.
 */
function seedLegacyInstall(dir: string, extraSettings: Record<string, unknown> = {}): string {
  const hookPath = legacyGlobalHookPath(dir);
  mkdirSync(dirname(hookPath), { recursive: true });
  writeFileSync(hookPath, generateHookScript(composeBaseline(defaultGlobalConfig("0.5.0"))));
  writeFileSync(
    join(dir, "settings.json"),
    `${JSON.stringify(
      {
        ...extraSettings,
        hooks: {
          ...((extraSettings.hooks as Record<string, unknown>) ?? {}),
          SessionStart: [
            {
              matcher: "startup|resume|compact",
              hooks: [{ type: "command", command: `bash "${hookPath}"` }],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
  );
  return hookPath;
}

describe("global-render — uninstall against an unreadable settings.json (#497)", () => {
  it("removes the hook file but leaves the settings byte-for-byte, and says so", () => {
    const hookPath = seedLegacyInstall(claudeDir);
    const path = join(claudeDir, "settings.json");
    writeFileSync(path, CORRUPT_SETTINGS);
    const before = readFileSync(path, "utf-8");

    const result = uninstallGlobalRender(claudeDir);
    expect(result.removedHook).toBe(true);
    expect(existsSync(hookPath)).toBe(false);
    expect(result.updatedSettings).toBe(false);
    expect(result.settingsUnreadable).toBe(true);
    expect(result.backupPath).toBeNull();
    expect(readFileSync(path, "utf-8")).toBe(before);
  });

  it("backs up the settings it DOES rewrite, keeping the pre-uninstall state", () => {
    seedLegacyInstall(claudeDir, { model: "opusplan" });

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
  function runGlobalInit(...extra: string[]): { status: number; combined: string } {
    const r = spawnSync("node", [CLI, "global", "init", ...extra], {
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

    // The write path, which is the one with something to lose (#545 made
    // --apply explicit; a preview writes nothing by construction).
    const { status, combined } = runGlobalInit("--recommended", "--apply");

    expect(status).not.toBe(0);
    expect(combined).toContain(path);
    expect(readFileSync(path, "utf-8")).toBe(before); // byte-for-byte, not just present
    expect(existsSync(hookPathOf(claudeDir))).toBe(false);
    expect(pluginInstalled(claudeDir)).toBe(false);
    expect(existsSync(join(scratch, ".navori", "global.json"))).toBe(false); // nothing persisted
  });

  it("installs the plugin, its gate hook and the agents, leaving settings.json alone", () => {
    const { status } = runGlobalInit("--recommended", "--apply");

    expect(status).toBe(0);
    expect(pluginInstalled(claudeDir)).toBe(true);
    expect(existsSync(hookPathOf(claudeDir))).toBe(true);
    expect(statSync(hookPathOf(claudeDir)).mode & 0o111).toBeGreaterThan(0);

    const pluginDir = globalPluginDir(claudeDir);
    const manifest = JSON.parse(readFileSync(join(pluginDir, PLUGIN_MANIFEST_REL), "utf-8")) as {
      name: string;
    };
    expect(manifest.name).toBe("navori");
    expect(existsSync(join(pluginDir, "agents/implementer.md"))).toBe(true);
    expect(existsSync(join(pluginDir, "skills/review-diff/SKILL.md"))).toBe(true);

    // FB: a default config merges nothing, so the user's machine-wide settings
    // file is not even created.
    expect(existsSync(join(claudeDir, "settings.json"))).toBe(false);
  });
});

describe("global init — interactive, preview and re-init (#545)", () => {
  const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../dist/index.js");

  function runGlobalInit(...extra: string[]): { status: number; combined: string } {
    const r = spawnSync("node", [CLI, "global", "init", ...extra], {
      encoding: "utf-8",
      env: { ...process.env, HOME: scratch, CLAUDE_CONFIG_DIR: claudeDir, FORCE_COLOR: "0" },
    });
    return { status: r.status ?? -1, combined: (r.stdout ?? "") + (r.stderr ?? "") };
  }

  const globalJson = () => join(scratch, ".navori", "global.json");
  function readManifest(): {
    blocks: { include: string[] };
    permissions: { allow: string[]; deny: string[]; ask: string[] };
    ownedPermissions: { allow: string[]; deny: string[]; ask: string[] };
  } {
    return JSON.parse(readFileSync(globalJson(), "utf-8")) as ReturnType<typeof readManifest>;
  }

  /** Seed an existing install's manifest without running the CLI. */
  function seedManifest(config: Record<string, unknown>): void {
    mkdirSync(join(scratch, ".navori"), { recursive: true });
    writeFileSync(globalJson(), `${JSON.stringify(config, null, 2)}\n`);
  }

  it("--recommended is headless: it never prompts and writes the expected install", () => {
    const { status, combined } = runGlobalInit("--recommended", "--apply");

    expect(status).toBe(0);
    // A prompt in a spawned process with no TTY would crash or hang; asserting
    // the copy is absent says it was never even reached.
    expect(combined).not.toContain("¿Qué bloques quieres");
    expect(combined).not.toContain("¿Declarar permisos personales");
    // Nor the no-TTY fallback notice: --recommended is the DECLARED headless
    // path, so it must not read as an accident.
    expect(combined).not.toContain("Sin terminal interactiva");

    expect(pluginInstalled(claudeDir)).toBe(true);
    expect(existsSync(hookPathOf(claudeDir))).toBe(true);
    expect(readManifest().blocks.include).toEqual([
      "operaciones-seguras",
      "idioma-rol",
      "formato-respuesta",
      "orquestacion",
    ]);
  });

  it("without --apply it writes NOTHING, and the preview names hook, settings and blocks", () => {
    const { status, combined } = runGlobalInit("--recommended");

    expect(status).toBe(0);
    // Verified against the filesystem, not the output: the zero-footprint
    // invariant (Spec 0010 §2.4) is about bytes, and a preview that creates the
    // manifest "so it can describe it" breaks exactly what the layer promises.
    expect(readdirSync(claudeDir)).toEqual([]);
    expect(readdirSync(scratch)).toEqual([]);
    expect(existsSync(globalJson())).toBe(false);
    expect(pluginInstalled(claudeDir)).toBe(false);

    expect(combined).toContain(hookPathOf(claudeDir));
    expect(combined).toContain(join(claudeDir, "settings.json"));
    expect(combined).toContain("orquestacion");
    // The default stopped writing, so the preview has to say how to apply.
    expect(combined).toContain("navori global init --apply");
  });

  it("a re-init PRESERVES the previous selection instead of resetting the defaults", () => {
    seedManifest({
      version: "0.0.1",
      language: "es",
      blocks: { include: ["idioma-rol", "formato-respuesta"] },
      permissions: { allow: ["Read(//tmp/**)"], deny: [], ask: [] },
    });

    const { status, combined } = runGlobalInit("--recommended", "--apply");

    expect(status).toBe(0);
    const manifest = readManifest();
    expect(manifest.blocks.include).toEqual(["idioma-rol", "formato-respuesta"]);
    expect(manifest.blocks.include).not.toContain("orquestacion");
    expect(combined).toContain("idioma-rol, formato-respuesta");

    // The permissions the manifest declared still travel the #544 ownership
    // path: merged into settings.json AND claimed, or uninstall could not
    // retract them.
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf-8")) as {
      permissions?: { allow?: string[] };
    };
    expect(settings.permissions?.allow).toEqual(["Read(//tmp/**)"]);
    expect(manifest.ownedPermissions.allow).toEqual(["Read(//tmp/**)"]);
  });

  it("with no TTY and no --recommended it falls back to the recommended values", () => {
    // The prompts need a TTY; a piped/CI run must degrade to the declared
    // headless path instead of crashing on setRawMode.
    const { status, combined } = runGlobalInit();
    expect(status).toBe(0);
    expect(combined).toContain("Sin terminal interactiva");
    expect(readdirSync(scratch)).toEqual([]); // still a preview: no --apply
  });
});

// ============================================================
// #542 — the hook carries a marker + digest, so drift is visible
// ============================================================

/** Install the hook for `config` and hand back its path and expected content. */
function installHook(config = defaultGlobalConfig("9.9.9", "es")) {
  const plan = planGlobalPlugin(config, composeBaseline(config), claudeDir);
  applyGlobalPlugin(plan);
  const file = plan.files.find((f) => f.relPath === PLUGIN_HOOK_SCRIPT_REL);
  return { path: join(plan.dir, PLUGIN_HOOK_SCRIPT_REL), expected: file?.content ?? "" };
}

describe("global-render — hook authorship marker and drift (#542)", () => {
  it("stamps a navori:managed marker carrying the CLI version and a digest", () => {
    const script = generateHookScript("baseline body", "1.2.3");
    const marker = script.split("\n")[1];
    expect(marker).toMatch(/^# navori:managed version="1\.2\.3" hash="[0-9a-f]{16}"$/);
    // The shebang must stay first or the kernel never runs it as a script.
    expect(script.split("\n")[0]).toBe("#!/usr/bin/env bash");
  });

  it("the stamped digest is stable for the same input and moves with the baseline", () => {
    const a = generateHookScript("baseline body", "1.2.3");
    const b = generateHookScript("baseline body", "1.2.3");
    const c = generateHookScript("a DIFFERENT baseline", "1.2.3");
    expect(a).toBe(b);
    expect(hashOf(a)).not.toBe(hashOf(c));
  });

  it("reports a freshly applied hook as up to date", () => {
    const { path, expected } = installHook();
    expect(readHookDrift(path, expected)).toEqual({ kind: "ok" });
  });

  it("reports 'absent' when nothing is installed", () => {
    const expected = generateHookScript("x", "1.0.0");
    expect(readHookDrift(join(claudeDir, "hooks/navori-global-baseline.sh"), expected)).toEqual({
      kind: "absent",
    });
  });

  it("reports 'unmarked' for a hook written by a navori older than #542", () => {
    const path = join(claudeDir, "hooks/navori-global-baseline.sh");
    mkdirSync(dirname(path), { recursive: true });
    // The pre-#542 shape: managed, but with nothing to verify it against.
    writeFileSync(path, "#!/usr/bin/env bash\n# navori global baseline\nexit 0\n");
    expect(readHookDrift(path, generateHookScript("x", "1.0.0"))).toEqual({ kind: "unmarked" });
  });

  it("catches a HAND EDIT — the file no longer matches its own hash", () => {
    const { path, expected } = installHook();
    const tampered = readFileSync(path, "utf-8").replace(
      "exit 0\n",
      "rm -rf /tmp/whatever\nexit 0\n",
    );
    writeFileSync(path, tampered);
    expect(readHookDrift(path, expected)).toEqual({ kind: "hand-edited" });
  });

  it("catches a hand edit even when the marker line itself is the thing edited", () => {
    const { path, expected } = installHook();
    const onDisk = readFileSync(path, "utf-8");
    // Forging a plausible-looking digest must not buy the file a clean verdict.
    writeFileSync(path, onDisk.replace(/hash="[0-9a-f]{16}"/, 'hash="deadbeefdeadbeef"'));
    expect(readHookDrift(path, expected)).toEqual({ kind: "hand-edited" });
  });

  it("the marker records the CLI that rendered it, not the version stored in global.json", () => {
    // They are different facts: `global.json.version` is what last wrote the
    // CONFIG, and `render` never touches it, so it lags. Only the renderer's own
    // version can answer "what produced these bytes".
    const { path } = installHook(defaultGlobalConfig("0.1.0", "es"));
    expect(readFileSync(path, "utf-8")).toContain(`version="${readCliVersion()}"`);
  });

  it("catches STALENESS — an intact hook whose baseline asset changed under the same version", () => {
    const { path } = installHook();
    // The exact case doctor could never see before: same CLI version, different
    // rendered content, file untouched since navori wrote it.
    const drift = readHookDrift(path, generateHookScript("the asset was edited"));
    expect(drift).toEqual({
      kind: "stale",
      installedVersion: readCliVersion(),
      expectedVersion: readCliVersion(),
    });
  });

  it("names both versions when the CLI moved on", () => {
    const path = writeHook(generateHookScript("baseline", "0.1.0"));
    const drift = readHookDrift(path, generateHookScript("newer baseline", "0.2.0"));
    expect(drift).toEqual({
      kind: "stale",
      installedVersion: "0.1.0",
      expectedVersion: "0.2.0",
    });
  });

  it("re-applying reconciles a hand-edited hook back to 'ok'", () => {
    const config = defaultGlobalConfig("9.9.9", "es");
    const { path, expected } = installHook(config);
    writeFileSync(path, `${readFileSync(path, "utf-8")}\n# smuggled\n`);
    expect(readHookDrift(path, expected).kind).toBe("hand-edited");

    const again = installHook(config);
    expect(readHookDrift(again.path, again.expected)).toEqual({ kind: "ok" });
  });

  it("the marker does not break the script — bash still runs it and the gate still works", () => {
    const { path } = installHook();
    const out = execFileSync("bash", [path], { cwd: scratch, input: "{}", encoding: "utf-8" });
    expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe("SessionStart");
  });
});

/** The digest a rendered hook declares about itself. */
function hashOf(script: string): string {
  return /hash="([0-9a-f]{16})"/.exec(script)?.[1] ?? "";
}

// ============================================================
// #543 — doctor RUNS the gate instead of trusting the file exists
// ============================================================

/** Write an arbitrary hook script at the canonical path and return it. */
function writeHook(body: string): string {
  const path = join(claudeDir, "hooks/navori-global-baseline.sh");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

const EMITS_UNCONDITIONALLY = `#!/usr/bin/env bash
cat >/dev/null 2>&1 || true
node -e 'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:"always"}}))'
`;

const GATE_ONLY = `#!/usr/bin/env bash
cat >/dev/null 2>&1 || true
dir="$PWD"
while :; do
  [ -f "$dir/navori.config.json" ] && exit 0
  [ "$dir" = "/" ] && break
  dir="$(dirname "$dir")"
done
`;

describe("global-render — probeGate executes the hook (#543)", () => {
  it("reports 'ok' for a real installed hook: emits outside a navori repo, defers inside one", () => {
    const { path } = installHook();
    expect(probeGate(path)).toEqual({ kind: "ok" });
  });

  it("catches a gate that never defers — the double-emission §3.1 exists to prevent", () => {
    expect(probeGate(writeHook(EMITS_UNCONDITIONALLY))).toEqual({ kind: "no-defer" });
  });

  it("catches a gate that defers correctly but never emits", () => {
    expect(probeGate(writeHook(GATE_ONLY))).toEqual({ kind: "no-emit" });
  });

  it("catches output that is not the SessionStart JSON contract", () => {
    const probe = probeGate(writeHook(`${GATE_ONLY}echo "not json at all"\n`));
    expect(probe.kind).toBe("malformed");
  });

  it("catches an empty additionalContext — valid JSON that injects nothing", () => {
    const probe = probeGate(
      writeHook(
        `${GATE_ONLY}node -e 'process.stdout.write(JSON.stringify({hookSpecificOutput:{additionalContext:"  "}}))'\n`,
      ),
    );
    expect(probe).toEqual({ kind: "malformed", detail: "hookSpecificOutput.additionalContext" });
  });

  it("reports a hook that cannot even run, instead of reading it as 'no baseline'", () => {
    const probe = probeGate(writeHook("#!/usr/bin/env bash\nif [ ; then\n"));
    expect(probe.kind).toBe("error");
  });

  it("distinguishes 'no JSON tool on PATH' from a broken gate — the nvm/app-bundle case", () => {
    const { path } = installHook();
    // A PATH built by hand rather than a real one like "/bin:/usr/bin": which
    // system dirs happen to hold `node` or `jq` varies per machine (this one
    // ships /usr/bin/jq), and a test that depends on that is a test that passes
    // for the wrong reason somewhere else. Symlink in exactly what the gate
    // needs to RUN, and nothing it needs to EMIT.
    const bin = join(scratch, "bin");
    mkdirSync(bin, { recursive: true });
    for (const tool of ["bash", "cat", "dirname"]) {
      symlinkSync(
        execFileSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf-8" }).trim(),
        join(bin, tool),
      );
    }
    const savedPath = process.env.PATH;
    process.env.PATH = bin;
    try {
      expect(probeGate(path)).toEqual({ kind: "no-json-tool" });
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("leaves no probe directories behind", () => {
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith("navori-gate-")).length;
    probeGate(installHook().path);
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith("navori-gate-")).length;
    expect(after).toBe(before);
  });
});

// ============================================================
// #542 + #543 — the verdicts reach `navori global doctor` output
// ============================================================

describe("global doctor — drift and gate reach the report (#542, #543)", () => {
  const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../dist/index.js");

  function run(argv: string[]): { status: number; combined: string } {
    const r = spawnSync("node", [CLI, "global", ...argv], {
      encoding: "utf-8",
      env: { ...process.env, HOME: scratch, CLAUDE_CONFIG_DIR: claudeDir, FORCE_COLOR: "0" },
    });
    return { status: r.status ?? -1, combined: (r.stdout ?? "") + (r.stderr ?? "") };
  }

  it("a fresh install reports the hook up to date AND the gate working", () => {
    expect(run(["init", "--recommended", "--apply"]).status).toBe(0);
    const { combined } = run(["doctor"]);
    expect(combined).toContain("al día");
    expect(combined).toContain("gate funcional");
    expect(combined).not.toContain("editado a mano");
  });

  it("a hand-edited hook is named as such, and doctor does NOT just say 'run render'", () => {
    run(["init", "--recommended", "--apply"]);
    const path = hookPathOf(claudeDir);
    writeFileSync(path, `${readFileSync(path, "utf-8")}\n# someone was here\n`);

    const { combined } = run(["doctor"]);
    expect(combined).toContain("editado a mano");
    // The remediation destroys the edit, so the report has to say so.
    expect(combined).toContain("DESCARTA");
  });

  it("a hook from a navori older than #542 is reported as unmarked, not as healthy", () => {
    run(["init", "--recommended", "--apply"]);
    const path = hookPathOf(claudeDir);
    // Strip the marker line: exactly what a pre-#542 install looks like on disk.
    writeFileSync(path, readFileSync(path, "utf-8").replace(/^# navori:managed .*\n/m, ""));
    expect(run(["doctor"]).combined).toContain("sin marcador");
  });

  it("render --apply reconciles, and doctor goes back to clean", () => {
    run(["init", "--recommended", "--apply"]);
    const path = hookPathOf(claudeDir);
    writeFileSync(path, `${readFileSync(path, "utf-8")}\n# smuggled\n`);
    expect(run(["doctor"]).combined).toContain("editado a mano");

    expect(run(["render", "--apply"]).status).toBe(0);
    const after = run(["doctor"]).combined;
    expect(after).toContain("al día");
    expect(after).not.toContain("editado a mano");
  });

  it("a deleted hook is reported as missing, and the gate is not probed", () => {
    run(["init", "--recommended", "--apply"]);
    rmSync(hookPathOf(claudeDir));
    const { combined } = run(["doctor"]);
    expect(combined).toContain("ausente");
    expect(combined).not.toContain("gate funcional");
  });
});
