import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("../../primitives/home.ts", () => ({ safeHomedir: () => home.dir }));

import { scanGlobalClaudeMd } from "../global-claude-md.ts";

function fakeHome(content?: string): void {
  home.dir = mkdtempSync(join(tmpdir(), "navori-global-claude-"));
  if (content === undefined) return;
  mkdirSync(join(home.dir, ".claude"));
  writeFileSync(join(home.dir, ".claude/CLAUDE.md"), content);
}

describe("scanGlobalClaudeMd (#1270)", () => {
  beforeEach(() => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", "");
    fakeHome();
  });
  afterEach(() => vi.unstubAllEnvs());

  // Covers: #1270
  it("measures the file under CLAUDE_CONFIG_DIR when it is set", () => {
    fakeHome("a".repeat(100)); // small file in the fake home: must be ignored
    const dir = mkdtempSync(join(tmpdir(), "navori-config-dir-"));
    writeFileSync(join(dir, "CLAUDE.md"), "b".repeat(2500));
    vi.stubEnv("CLAUDE_CONFIG_DIR", dir);
    expect(scanGlobalClaudeMd()).toEqual({
      path: join(dir, "CLAUDE.md"),
      chars: 2500,
      thresholdChars: 2000,
    });
  });

  // Covers: #1270
  it("reports size and cap when over the default cap", () => {
    fakeHome("a".repeat(2001));
    expect(scanGlobalClaudeMd()).toEqual({
      path: "~/.claude/CLAUDE.md",
      chars: 2001,
      thresholdChars: 2000,
    });
  });

  // Covers: #1270
  it("is null at or under the cap", () => {
    fakeHome("a".repeat(2000));
    expect(scanGlobalClaudeMd()).toBeNull();
  });

  // Covers: #1270
  it("counts characters, not bytes", () => {
    fakeHome("é".repeat(2000));
    expect(scanGlobalClaudeMd()).toBeNull();
  });

  // Covers: #1270
  it("is null when the file is missing", () => {
    expect(scanGlobalClaudeMd()).toBeNull();
  });

  // Covers: #1270
  it("is null when the path is unreadable (a directory)", () => {
    fakeHome();
    mkdirSync(join(home.dir, ".claude/CLAUDE.md"), { recursive: true });
    expect(scanGlobalClaudeMd()).toBeNull();
  });

  // Covers: #1270
  it("honours an injected threshold", () => {
    fakeHome("abcdef");
    expect(scanGlobalClaudeMd(5)?.thresholdChars).toBe(5);
    expect(scanGlobalClaudeMd(6)).toBeNull();
  });
});
