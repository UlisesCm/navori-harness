import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

/**
 * Spec 0010 FB (#546) — moving an F1 install off the loose gate hook.
 *
 * The migration snapshots what it removes into `~/.navori/migrations/`, so this
 * spec mocks `safeHomedir` to a throwaway dir: without that it would write into
 * the developer's REAL machine-global store, which the isolation guard
 * (#404/#424) rightly fails the run over. That mock is also why the migration
 * lives in its own file rather than alongside the rest of `global-render`.
 */
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("../../../lib/home.ts", () => ({ safeHomedir: () => home.dir }));

const { composeBaseline, detectLegacyGlobalHook, generateHookScript, migrateLegacyGlobalHook } =
  await import("../global-render.ts");
const { legacyGlobalHookPath, settingsHasLegacyHook } = await import("../global-render.ts");
const { defaultGlobalConfig } = await import("../../../lib/global-config.ts");

let claudeDir: string;
const savedEnv = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "navori-legacy-home-"));
  claudeDir = mkdtempSync(join(tmpdir(), "navori-legacy-claude-"));
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedEnv;
  rmSync(home.dir, { recursive: true, force: true });
  rmSync(claudeDir, { recursive: true, force: true });
});

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

/**
 * Seed an F1-era install: the gate hook loose under the Claude config dir, plus
 * the SessionStart entry navori used to merge into the user's settings.json.
 */
function seedLegacyInstall(dir: string, extra: Record<string, unknown> = {}): string {
  const hookPath = legacyGlobalHookPath(dir);
  mkdirSync(dirname(hookPath), { recursive: true });
  writeFileSync(hookPath, generateHookScript(composeBaseline(defaultGlobalConfig("0.5.0"))));
  writeFileSync(
    join(dir, "settings.json"),
    `${JSON.stringify(
      {
        ...extra,
        hooks: {
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

describe("global-render — migrating an F1 install off the loose hook", () => {
  it("is a no-op on a machine that never had one", () => {
    expect(migrateLegacyGlobalHook(claudeDir)).toEqual({
      snapshotPath: null,
      removedHook: false,
      updatedSettings: false,
      settingsUnreadable: false,
    });
    expect(existsSync(join(home.dir, ".navori", "migrations"))).toBe(false);
  });

  it("deletes the loose hook, drops its registration, and leaves a restorable copy", () => {
    const hookPath = seedLegacyInstall(claudeDir, { model: "opusplan" });
    expect(detectLegacyGlobalHook(claudeDir)).toMatchObject({
      filePresent: true,
      registeredInSettings: true,
    });

    const result = migrateLegacyGlobalHook(claudeDir);
    expect(result.removedHook).toBe(true);
    expect(result.updatedSettings).toBe(true);
    expect(existsSync(hookPath)).toBe(false);
    expect(settingsHasLegacyHook(claudeDir)).toBe(false);

    // The user's own keys survive, and both removed files are recoverable.
    const after = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf-8")) as {
      model?: string;
      hooks?: unknown;
    };
    expect(after.model).toBe("opusplan");
    expect(after.hooks).toBeUndefined();
    expect(filesUnder(result.snapshotPath as string).sort()).toEqual([
      "hooks/navori-global-baseline.sh",
      "settings.json",
    ]);
    // …and it lands where `navori migrations list` looks for it.
    expect(result.snapshotPath?.startsWith(join(home.dir, ".navori", "migrations"))).toBe(true);
  });

  it("cleans up a half-install: a registration whose hook file is already gone", () => {
    seedLegacyInstall(claudeDir);
    rmSync(legacyGlobalHookPath(claudeDir));

    const result = migrateLegacyGlobalHook(claudeDir);
    expect(result.removedHook).toBe(false);
    expect(result.updatedSettings).toBe(true);
    expect(settingsHasLegacyHook(claudeDir)).toBe(false);
  });

  it("leaves an unreadable settings.json byte-for-byte and reports it", () => {
    seedLegacyInstall(claudeDir);
    const path = join(claudeDir, "settings.json");
    writeFileSync(path, "{ oops,\n");
    const before = readFileSync(path, "utf-8");

    const result = migrateLegacyGlobalHook(claudeDir);
    expect(result.removedHook).toBe(true);
    expect(result.settingsUnreadable).toBe(true);
    expect(result.updatedSettings).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe(before);
  });
});
