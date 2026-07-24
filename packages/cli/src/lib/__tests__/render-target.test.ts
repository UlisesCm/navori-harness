import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";

// Mock home.ts so globalTarget()'s fallback is deterministic and never resolves
// against the real home dir. CLAUDE_CONFIG_DIR still wins when set.
const home = vi.hoisted(() => ({ dir: "/fake/home" }));
vi.mock("../home.ts", () => ({
  safeHomedir: () => home.dir,
  globalConfigDir: () => process.env.CLAUDE_CONFIG_DIR || join(home.dir, ".claude"),
}));

const { repoTarget, globalTarget } = await import("../render-target.ts");

const savedEnv = process.env.CLAUDE_CONFIG_DIR;
beforeEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedEnv;
});

describe("repoTarget", () => {
  it("nests .claude under the checkout", () => {
    const t = repoTarget("/repo");
    expect(t.scope).toBe("repo");
    expect(t.claudeMd).toBe(join("/repo", "CLAUDE.md"));
    expect(t.dotDir).toBe(join("/repo", ".claude"));
  });
});

describe("globalTarget", () => {
  it("is flat: dotDir === baseDir (user-level layout)", () => {
    const t = globalTarget("/x/.claude");
    expect(t.scope).toBe("global");
    expect(t.baseDir).toBe("/x/.claude");
    expect(t.dotDir).toBe("/x/.claude");
    expect(t.claudeMd).toBe(join("/x/.claude", "CLAUDE.md"));
  });

  it("honors CLAUDE_CONFIG_DIR for the default dir", () => {
    process.env.CLAUDE_CONFIG_DIR = "/custom/claude";
    expect(globalTarget().baseDir).toBe("/custom/claude");
  });

  it("falls back to ~/.claude when CLAUDE_CONFIG_DIR is unset", () => {
    expect(globalTarget().baseDir).toBe(join("/fake/home", ".claude"));
  });
});
