import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanPermissionMode } from "../health.ts";

/**
 * #579 — the harness knew one permission mode of six, and two of the other five
 * change what it can do at all.
 *
 * `dontAsk` is the one that breaks outright: it auto-denies every call that
 * would otherwise prompt, and navori's allow list grants `Read`/`Glob`/`Grep`
 * and its MCP families but NOT `Edit`/`Write` — deliberately, because in every
 * other mode the prompt on a write is the safety net worth keeping. Each choice
 * is defensible alone; together the implement/review cycle cannot run, and the
 * mode never asks, it denies in silence.
 *
 * So the check reports and never fixes: granting the write tools would change
 * what `default` mode does in every repo, which is the user's call.
 */

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-permmode-"));
  mkdirSync(join(cwd, ".claude"), { recursive: true });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function settings(file: string, body: Record<string, unknown>): void {
  writeFileSync(join(cwd, ".claude", file), `${JSON.stringify(body, null, 2)}\n`, "utf-8");
}

const NAVORI_ALLOW = ["Read", "Glob", "Grep", "Bash(git status*)"];

describe("a repo pinned to dontAsk cannot run the cycle (#579)", () => {
  it("reports the mode, the file and the tools it is missing", () => {
    settings("settings.json", {
      permissions: { defaultMode: "dontAsk", allow: NAVORI_ALLOW },
    });
    expect(scanPermissionMode(cwd)).toEqual([
      { mode: "dontAsk", path: join(".claude", "settings.json"), missing: ["Edit", "Write"] },
    ]);
  });

  it("reads the key at the top level too", () => {
    // Both shapes appear in the wild; missing one would make the check depend on
    // which the user happened to write.
    settings("settings.json", { defaultMode: "dontAsk", permissions: { allow: NAVORI_ALLOW } });
    expect(scanPermissionMode(cwd)[0]?.mode).toBe("dontAsk");
  });

  it("catches it in settings.local.json, where it surprises exactly one developer", () => {
    settings("settings.local.json", {
      permissions: { defaultMode: "dontAsk", allow: NAVORI_ALLOW },
    });
    expect(scanPermissionMode(cwd)[0]?.path).toBe(join(".claude", "settings.local.json"));
  });

  it("stays quiet once the allow list can write", () => {
    settings("settings.json", {
      permissions: { defaultMode: "dontAsk", allow: [...NAVORI_ALLOW, "Edit", "Write"] },
    });
    expect(scanPermissionMode(cwd)).toEqual([]);
  });

  it("names only what is actually missing", () => {
    settings("settings.json", {
      permissions: { defaultMode: "dontAsk", allow: [...NAVORI_ALLOW, "Edit"] },
    });
    expect(scanPermissionMode(cwd)[0]?.missing).toEqual(["Write"]);
  });
});

describe("every other mode is left alone (#579)", () => {
  it.each(["default", "acceptEdits", "plan", "auto", "bypassPermissions"])(
    "%s produces no finding",
    (mode) => {
      // These four navori supports, and bypassPermissions is the user's own
      // decision about an isolated environment. None of them auto-denies a
      // write, so the missing allow rule costs nothing there.
      settings("settings.json", { permissions: { defaultMode: mode, allow: NAVORI_ALLOW } });
      expect(scanPermissionMode(cwd)).toEqual([]);
    },
  );

  it("says nothing when no mode is declared, which is the common case", () => {
    settings("settings.json", { permissions: { allow: NAVORI_ALLOW } });
    expect(scanPermissionMode(cwd)).toEqual([]);
  });

  it("leaves an unparseable settings file to the check that owns it", () => {
    writeFileSync(join(cwd, ".claude", "settings.json"), "{ not json", "utf-8");
    expect(scanPermissionMode(cwd)).toEqual([]);
  });
});

/**
 * The prose half: an agent that cannot see the mode plans as if it were in the
 * one it knows. The table is what makes the difference actionable, so it has to
 * name every mode — a table missing one is a table that says "this mode does
 * not exist".
 */
describe("the harness names all six modes (#579)", () => {
  const HERE = resolve(fileURLToPath(import.meta.url), "..");
  const ASSET = resolve(
    HERE,
    "..",
    "..",
    "..",
    "..",
    "core",
    "core-assets",
    "managed",
    "operaciones-seguras.md",
  );
  const asset = readFileSync(ASSET, "utf-8");

  it.each(["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"])(
    "the permissions block tells the agent what `%s` changes",
    (mode) => {
      expect(asset).toContain(`| \`${mode}\` |`);
    },
  );

  it("states which modes navori supports, so `dontAsk` is a decision and not a surprise", () => {
    expect(asset).toContain("does not support");
  });

  it("does not promise a `deny` guarantee it cannot verify under bypassPermissions", () => {
    // The docs never say whether deny rules survive that mode. What they do say
    // is that `exit 2` blocks in any mode, so the hook is the half that holds.
    const row = asset.split("\n").find((line) => line.includes("| `bypassPermissions` |")) ?? "";
    expect(row).toContain("do not rely on them");
    expect(row).toContain("exit 2");
  });
});
