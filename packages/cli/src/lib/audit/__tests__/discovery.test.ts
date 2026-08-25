import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findMarkedSessions } from "../discovery.ts";
import { encodeCwdToSlug, auditsRoot, sessionLogPath } from "../paths.ts";

let root: string;
const REPO = "fixture-repo";

function markSession(id: string, cwd: string, ts: string): void {
  const dir = join(root, REPO);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `session-${id}.log`),
    `${JSON.stringify({ ts, event: "start", cwd, repo: REPO, sessionId: id })}\n`,
    "utf-8",
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "navori-audit-"));
  process.env.NAVORI_AUDITS_ROOT = root;
});

afterEach(() => {
  delete process.env.NAVORI_AUDITS_ROOT;
  rmSync(root, { recursive: true, force: true });
});

describe("discovery: only marked sessions", () => {
  it("returns nothing when no session was ever marked", () => {
    expect(findMarkedSessions(REPO)).toEqual([]);
  });

  it("finds a marked session and reads its header", () => {
    markSession("abc123", "/tmp/fixture-repo", "2026-08-25T10:00:00.000Z");
    const found = findMarkedSessions(REPO);
    expect(found).toHaveLength(1);
    expect(found[0]?.sessionId).toBe("abc123");
    expect(found[0]?.cwd).toBe("/tmp/fixture-repo");
  });

  it("survives a truncated log without a usable header", () => {
    mkdirSync(join(root, REPO), { recursive: true });
    writeFileSync(join(root, REPO, "session-broken.log"), "{not json\n", "utf-8");
    const found = findMarkedSessions(REPO);
    expect(found).toHaveLength(1);
    expect(found[0]?.markedAt).toBe("");
  });
});

describe("discovery: filters", () => {
  beforeEach(() => {
    markSession("old11111", "/tmp/fixture-repo", "2020-01-01T10:00:00.000Z");
    markSession("new22222", "/tmp/fixture-repo", "2026-08-25T10:00:00.000Z");
  });

  it("orders newest first", () => {
    expect(findMarkedSessions(REPO).map((s) => s.sessionId)).toEqual(
      ["old11111", "new22222"].reverse(),
    );
  });

  it("filters by date range", () => {
    const found = findMarkedSessions(REPO, { since: "2026-01-01" });
    expect(found.map((s) => s.sessionId)).toEqual(["new22222"]);
  });

  it("'latest' picks exactly one", () => {
    const found = findMarkedSessions(REPO, { session: "latest" });
    expect(found).toHaveLength(1);
    expect(found[0]?.sessionId).toBe("new22222");
  });

  it("accepts a session id prefix", () => {
    expect(findMarkedSessions(REPO, { session: "new2" }).map((s) => s.sessionId)).toEqual([
      "new22222",
    ]);
  });
});

describe("paths: cwd → transcript slug", () => {
  it("reproduces Claude Code's encoding, spaces included", () => {
    expect(encodeCwdToSlug("/Users/u/Documents/Dev - Docs/navori-harness")).toBe(
      "-Users-u-Documents-Dev---Docs-navori-harness",
    );
  });

  it("collapses dots, which appear in real repo names", () => {
    expect(encodeCwdToSlug("/a/b.c/d")).toBe("-a-b-c-d");
  });
});

describe("paths: audit root isolation", () => {
  it("honours the env override so tests never touch the real ~/.navori", () => {
    expect(auditsRoot()).toBe(root);
    expect(sessionLogPath(REPO, "s1")).toBe(join(root, REPO, "session-s1.log"));
  });

  it("resolves a relative override so a chdir cannot move the store", () => {
    process.env.NAVORI_AUDITS_ROOT = "relative-audits";
    expect(auditsRoot().startsWith("/")).toBe(true);
  });
});
