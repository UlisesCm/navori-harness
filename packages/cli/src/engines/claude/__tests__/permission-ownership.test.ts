import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultGlobalConfig, type GlobalConfig } from "../../../lib/global-config.ts";
import {
  applyGlobalRender,
  planGlobalRender,
  stripOwnedPermissions,
  uninstallGlobalRender,
} from "../global-render.ts";

/**
 * #544 — uninstall used to remove the hook and leave every permission navori
 * had merged into `~/.claude/settings.json` behind, forever.
 *
 * The reason it was left that way is the interesting part, and it is what these
 * specs pin: `deepMerge` concatenates and dedupes, so after the merge a rule
 * navori added is byte-identical to one the user already had. Removing
 * `config.permissions` on uninstall would therefore delete rules navori never
 * added — a worse bug than the residue. Ownership has to be recorded at the one
 * moment it is still knowable, and that is what `plan.ownedPermissions` is.
 *
 * So the suite pushes on both directions of that asymmetry: navori takes back
 * exactly what it added, and never anything that predates it.
 */

let claudeDir: string;
const savedEnv = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
  claudeDir = mkdtempSync(join(tmpdir(), "navori-perms-"));
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedEnv;
  rmSync(claudeDir, { recursive: true, force: true });
});

function cfg(perms: Partial<GlobalConfig["permissions"]> = {}): GlobalConfig {
  const c = defaultGlobalConfig("0.6.5", "es");
  c.permissions = { allow: [], deny: [], ask: [], ...perms };
  return c;
}

/** Seed settings.json in navori's own canonical format (see the byte test). */
function seedSettings(value: Record<string, unknown>): string {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(join(claudeDir, "settings.json"), body);
  return body;
}

describe("ownership is computed at merge time, when it is still knowable (#544)", () => {
  it("claims an entry this render introduces", () => {
    const plan = planGlobalRender(cfg({ allow: ["Bash(ls:*)"] }), claudeDir);
    expect(plan.ownedPermissions.allow).toEqual(["Bash(ls:*)"]);
  });

  it("does NOT claim an entry the user already had, even though the config declares it", () => {
    seedSettings({ permissions: { allow: ["Bash(ls:*)"] } });
    const plan = planGlobalRender(cfg({ allow: ["Bash(ls:*)", "Bash(cat:*)"] }), claudeDir);
    // Declared ≠ owned. The pre-existing rule is the user's forever.
    expect(plan.ownedPermissions.allow).toEqual(["Bash(cat:*)"]);
  });

  it("keeps claiming what a previous render claimed", () => {
    const c = cfg({ allow: ["Bash(ls:*)"] });
    applyGlobalRender(planGlobalRender(c, claudeDir));
    c.ownedPermissions = { allow: ["Bash(ls:*)"], deny: [], ask: [] };

    // Second render: the entry is now present in settings.json, so the
    // "introduced" test alone would no longer recognise it as navori's.
    expect(planGlobalRender(c, claudeDir).ownedPermissions.allow).toEqual(["Bash(ls:*)"]);
  });

  it("keeps owning an entry dropped from the config while it is still on disk", () => {
    const c = cfg({ allow: ["Bash(ls:*)"] });
    applyGlobalRender(planGlobalRender(c, claudeDir));

    // The user removes it from global.json. The merge never subtracts, so the
    // rule stays in settings.json — and uninstall is the only thing that can
    // still clean it, which it can only do while the record remembers.
    const dropped = cfg();
    dropped.ownedPermissions = { allow: ["Bash(ls:*)"], deny: [], ask: [] };
    expect(planGlobalRender(dropped, claudeDir).ownedPermissions.allow).toEqual(["Bash(ls:*)"]);
  });

  it("drops from the record an entry that is no longer on disk — no orphans", () => {
    const c = cfg();
    // Recorded as owned, but absent from settings.json and undeclared: nothing
    // to take back, so the record must not keep growing a stale entry.
    c.ownedPermissions = { allow: ["Bash(gone:*)"], deny: [], ask: [] };
    expect(planGlobalRender(c, claudeDir).ownedPermissions.allow).toEqual([]);
  });

  it("tracks the three buckets independently", () => {
    const plan = planGlobalRender(
      cfg({ allow: ["Bash(ls:*)"], deny: ["Bash(rm:*)"], ask: ["Bash(git push:*)"] }),
      claudeDir,
    );
    expect(plan.ownedPermissions).toEqual({
      allow: ["Bash(ls:*)"],
      deny: ["Bash(rm:*)"],
      ask: ["Bash(git push:*)"],
    });
  });
});

describe("stripOwnedPermissions removes the record, not the declaration (#544)", () => {
  it("takes back only the recorded entries", () => {
    const before = { permissions: { allow: ["mine", "theirs"] } };
    const after = stripOwnedPermissions(before, { allow: ["mine"], deny: [], ask: [] });
    expect(after).toEqual({ permissions: { allow: ["theirs"] } });
  });

  it("prunes an emptied bucket and an emptied permissions object", () => {
    const after = stripOwnedPermissions(
      { model: "opusplan", permissions: { allow: ["mine"] } },
      { allow: ["mine"], deny: [], ask: [] },
    );
    expect(after).toEqual({ model: "opusplan" }); // no husk left behind
  });

  it("returns the object untouched when nothing is owned", () => {
    const before = { permissions: { allow: ["theirs"] } };
    expect(stripOwnedPermissions(before, { allow: [], deny: [], ask: [] })).toBe(before);
  });

  it("does not choke on a settings.json whose permissions is not an object", () => {
    const before = { permissions: "nonsense" };
    expect(stripOwnedPermissions(before, { allow: ["mine"], deny: [], ask: [] })).toBe(before);
  });
});

describe("uninstall is symmetric with install (#544)", () => {
  const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../dist/index.js");
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "navori-home-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function run(argv: string[]): number {
    const r = spawnSync("node", [CLI, "global", ...argv], {
      encoding: "utf-8",
      env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: claudeDir, FORCE_COLOR: "0" },
    });
    return r.status ?? -1;
  }

  /** Rewrite global.json's permissions the way a user editing it by hand would. */
  function declarePermissions(perms: Partial<GlobalConfig["permissions"]>): void {
    const path = join(home, ".navori", "global.json");
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as GlobalConfig;
    parsed.permissions = { allow: [], deny: [], ask: [], ...perms };
    writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
  }

  const settingsPath = () => join(claudeDir, "settings.json");
  const readSettings = () => readFileSync(settingsPath(), "utf-8");

  it("leaves settings.json BYTE-IDENTICAL to what it was before install", () => {
    // Seeded in navori's own serialization (2-space + trailing newline) so this
    // asserts the round-trip and not JSON formatting: a file the user wrote
    // compactly comes back pretty-printed, which is a rewrite, not a leak.
    const before = seedSettings({
      model: "opusplan",
      permissions: { allow: ["Bash(theirs:*)"] },
    });

    expect(run(["init"])).toBe(0);
    declarePermissions({ allow: ["Bash(navori:*)"], deny: ["Bash(rm -rf:*)"] });
    expect(run(["render", "--apply"])).toBe(0);
    expect(readSettings()).not.toBe(before); // the install really did land

    expect(run(["uninstall"])).toBe(0);
    expect(readSettings()).toBe(before);
  });

  it("a rule the user already had — and navori also declares — survives uninstall", () => {
    seedSettings({ permissions: { allow: ["Bash(shared:*)"] } });
    run(["init"]);
    declarePermissions({ allow: ["Bash(shared:*)", "Bash(navori:*)"] });
    run(["render", "--apply"]);
    run(["uninstall"]);

    const after = JSON.parse(readSettings()) as { permissions?: { allow?: string[] } };
    expect(after.permissions?.allow).toEqual(["Bash(shared:*)"]);
  });

  it("a rule the user adds AFTER install survives uninstall", () => {
    run(["init"]);
    declarePermissions({ allow: ["Bash(navori:*)"] });
    run(["render", "--apply"]);

    const mid = JSON.parse(readSettings()) as Record<string, unknown>;
    (mid.permissions as { allow: string[] }).allow.push("Bash(added-later:*)");
    writeFileSync(settingsPath(), `${JSON.stringify(mid, null, 2)}\n`);

    run(["uninstall"]);
    const after = JSON.parse(readSettings()) as { permissions?: { allow?: string[] } };
    expect(after.permissions?.allow).toEqual(["Bash(added-later:*)"]);
  });

  it("without a readable global.json, uninstall drops the hook and touches no permission", () => {
    seedSettings({ permissions: { allow: ["Bash(theirs:*)"] } });
    run(["init"]);
    declarePermissions({ allow: ["Bash(navori:*)"] });
    run(["render", "--apply"]);

    // Ownership is unknowable now, so guessing is the one thing not allowed.
    const result = uninstallGlobalRender(claudeDir, null);
    expect(result.removedHook).toBe(true);
    const after = JSON.parse(readSettings()) as { permissions?: { allow?: string[] } };
    expect(after.permissions?.allow).toEqual(["Bash(theirs:*)", "Bash(navori:*)"]);
  });
});
