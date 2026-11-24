import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The hook verdict corpus is captured on a developer machine, so a real home directory leaks
 * into PATH snapshots, commands and messages. Only these fictional or system homes may appear;
 * a capture that brings another one must be normalized before it is committed.
 */
const CORPUS = join(import.meta.dirname, "fixtures", "hook-verdict-corpus");
const ALLOWED = new Set([
  "/Users/x",
  "/Users/me",
  // npm's module walk lists `/Users/node_modules/.bin`; not a user.
  "/Users/node_modules",
  "/home/node_modules",
  // Homebrew on Linux installs under its own system user.
  "/home/linuxbrew",
]);

describe("hook verdict corpus", () => {
  it("contains no home directory outside the fictional allowlist", () => {
    const found = new Map<string, string>();
    for (const name of readdirSync(CORPUS)) {
      const text = readFileSync(join(CORPUS, name), "utf8");
      for (const match of text.matchAll(/\/(?:Users|home)\/[A-Za-z0-9._-]+/g)) {
        if (!ALLOWED.has(match[0])) found.set(match[0].replace(/[^/]+$/, "<name>"), name);
      }
    }
    // The report masks the name so a failure does not print it again.
    expect([...found].map(([home, file]) => `${file}: ${home}`)).toEqual([]);
  });
});
