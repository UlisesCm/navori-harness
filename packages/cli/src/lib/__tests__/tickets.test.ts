import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findReferencingRepos } from "../tickets.ts";

/**
 * Issue #75 — findReferencingRepos must honor `progress.dir` /
 * `progress.currentFile` from each repo's navori.config.json instead of
 * hardcoding `progress/current.md`, falling back to the defaults when the
 * config is missing or unreadable.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "navori-tickets-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeRepo(name: string): string {
  const repo = join(dir, name);
  mkdirSync(repo, { recursive: true });
  return repo;
}

function writeCurrent(repo: string, relDir: string, file: string, content: string): void {
  mkdirSync(join(repo, relDir), { recursive: true });
  writeFileSync(join(repo, relDir, file), content, "utf-8");
}

describe("findReferencingRepos", () => {
  it("scans progress/current.md by default (no config)", () => {
    const repo = makeRepo("plain");
    writeCurrent(repo, "progress", "current.md", "ticket: TICK-1\notra línea\n");

    const refs = findReferencingRepos([repo], "TICK-1");
    expect(refs).toHaveLength(1);
    expect(refs[0].path).toBe(repo);
    expect(refs[0].matches).toEqual(["ticket: TICK-1"]);
  });

  it("honors progress.dir / progress.currentFile from navori.config.json", () => {
    const repo = makeRepo("custom");
    writeFileSync(
      join(repo, "navori.config.json"),
      JSON.stringify({
        name: "custom",
        engines: ["claude"],
        preset: "custom",
        progress: { dir: "state", currentFile: "session.md" },
      }),
      "utf-8",
    );
    writeCurrent(repo, "state", "session.md", "workspace://ws/tickets/TICK-2\n");
    // A stray default-path file must NOT be scanned when the config points elsewhere.
    writeCurrent(repo, "progress", "current.md", "ticket: TICK-2\n");

    const refs = findReferencingRepos([repo], "TICK-2");
    expect(refs).toHaveLength(1);
    expect(refs[0].matches).toEqual(["workspace://ws/tickets/TICK-2"]);
  });

  it("falls back to the default path when the config is unreadable", () => {
    const repo = makeRepo("broken");
    writeFileSync(join(repo, "navori.config.json"), "{ not json", "utf-8");
    writeCurrent(repo, "progress", "current.md", "ticket: TICK-3\n");

    const refs = findReferencingRepos([repo], "TICK-3");
    expect(refs).toHaveLength(1);
    expect(refs[0].matches).toEqual(["ticket: TICK-3"]);
  });

  it("falls back to the default path when the config fails validation", () => {
    const repo = makeRepo("invalid");
    writeFileSync(join(repo, "navori.config.json"), JSON.stringify({ name: 42 }), "utf-8");
    writeCurrent(repo, "progress", "current.md", "ticket: TICK-4\n");

    const refs = findReferencingRepos([repo], "TICK-4");
    expect(refs).toHaveLength(1);
  });

  it("skips repos whose current file does not exist or does not match", () => {
    const missing = makeRepo("missing");
    const noMatch = makeRepo("no-match");
    writeCurrent(noMatch, "progress", "current.md", "ticket: OTHER-9\n");

    expect(findReferencingRepos([missing, noMatch], "TICK-5")).toEqual([]);
  });
});
