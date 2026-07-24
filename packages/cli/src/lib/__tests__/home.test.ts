import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { globalConfigDir } from "../home.ts";
import { HomeError } from "../errors.ts";

/**
 * globalConfigDir must never resolve CLAUDE_CONFIG_DIR against the CWD: a
 * relative or stale value would redirect the global render onto the current
 * repo's CLAUDE.md and strip its blocks (spec 0005 §6 safety). It validates the
 * override the same way safeHomedir validates HOME — absolute-or-throw.
 */

const savedEnv = process.env.CLAUDE_CONFIG_DIR;
const savedHome = process.env.HOME;

beforeEach(() => {
  process.env.HOME = join("/tmp", "navori-home-fixture");
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedEnv;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

describe("globalConfigDir — CLAUDE_CONFIG_DIR validation (spec 0005)", () => {
  it("uses an ABSOLUTE override verbatim", () => {
    process.env.CLAUDE_CONFIG_DIR = "/opt/custom/claude";
    expect(globalConfigDir()).toBe("/opt/custom/claude");
  });

  it("THROWS on a bare-relative override ('.')", () => {
    process.env.CLAUDE_CONFIG_DIR = ".";
    expect(() => globalConfigDir()).toThrow(HomeError);
  });

  it("THROWS on a nested-relative override ('foo/bar')", () => {
    process.env.CLAUDE_CONFIG_DIR = "foo/bar";
    expect(() => globalConfigDir()).toThrow(HomeError);
  });

  it("THROWS on a dot-relative override ('./claude')", () => {
    process.env.CLAUDE_CONFIG_DIR = "./claude";
    expect(() => globalConfigDir()).toThrow(HomeError);
  });

  it("falls back to ~/.claude when the override is empty", () => {
    process.env.CLAUDE_CONFIG_DIR = "";
    expect(globalConfigDir()).toBe(join(process.env.HOME!, ".claude"));
  });

  it("falls back to ~/.claude when the override is whitespace-only", () => {
    process.env.CLAUDE_CONFIG_DIR = "   ";
    expect(globalConfigDir()).toBe(join(process.env.HOME!, ".claude"));
  });

  it("falls back to ~/.claude when the override is unset", () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(globalConfigDir()).toBe(join(process.env.HOME!, ".claude"));
  });
});
