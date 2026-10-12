import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeUserDir, permissionBagOf, readSettingsFile } from "../user-scope.ts";

let dir: string;
const originalEnv = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "navori-user-scope-"));
  process.env.CLAUDE_CONFIG_DIR = dir;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe("user-scope", () => {
  // Covers: R4
  it("claudeUserDir respeta CLAUDE_CONFIG_DIR", () => {
    expect(claudeUserDir()).toBe(dir);
  });

  // Covers: R4
  it("readSettingsFile distingue ausente, ilegible y no-objeto", () => {
    expect(readSettingsFile(dir)).toEqual({ kind: "absent" });
    writeFileSync(join(dir, "settings.json"), '{"a":1}');
    expect(readSettingsFile(dir)).toEqual({ kind: "ok", settings: { a: 1 } });
    writeFileSync(join(dir, "settings.json"), "{nope");
    expect(readSettingsFile(dir).kind).toBe("parse-error");
    writeFileSync(join(dir, "settings.json"), "[]");
    expect(readSettingsFile(dir)).toEqual({ kind: "not-object" });
  });

  // Covers: R4
  it("permissionBagOf normaliza a tres listas de strings", () => {
    expect(permissionBagOf({ permissions: { allow: ["a", 1], deny: "x" } })).toEqual({
      allow: ["a"],
      deny: [],
      ask: [],
    });
    expect(permissionBagOf({})).toEqual({ allow: [], deny: [], ask: [] });
  });
});
