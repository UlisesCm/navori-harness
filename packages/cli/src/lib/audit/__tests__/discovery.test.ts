import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  coverageMetrics,
  countHostSessions,
  findMarkedSessions,
  resolveCodexRollout,
  listAuditedRepos,
} from "../discovery.ts";
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

describe("discovery: transcript path recorded by the hook (#489)", () => {
  /**
   * Locating the transcript used to mean re-deriving Claude Code's
   * undocumented directory encoding, with a full scan as fallback. The hook
   * payload states the path outright, so it is recorded on the first `prompt`
   * event and preferred here — an exact answer instead of two guesses.
   */
  function markWithTranscript(id: string, cwd: string, transcript: string): void {
    const dir = join(root, REPO);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `session-${id}.log`),
      [
        JSON.stringify({ ts: "2026-08-25T10:00:00Z", event: "start", cwd, repo: REPO }),
        // The path only ever appears on a prompt event, never on `start`.
        JSON.stringify({ ts: "2026-08-25T10:01:00Z", event: "prompt", prompt: "x", transcript }),
      ].join("\n") + "\n",
      "utf-8",
    );
  }

  it("uses the recorded path, even where the encoding heuristic would miss", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "navori-transcripts-"));
    const file = join(elsewhere, "anywhere.jsonl");
    writeFileSync(file, "", "utf-8");

    markWithTranscript("sess-rec", "/some/repo/path", file);
    const [found] = findMarkedSessions(REPO);
    expect(found?.transcript).toBe(file);
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it("falls back to the search when the recorded path no longer exists", () => {
    // A transcript can be pruned or moved; a stale record must not win.
    markWithTranscript("sess-gone", "/some/repo/path", join(tmpdir(), "definitely-not-here.jsonl"));
    const [found] = findMarkedSessions(REPO);
    expect(found?.transcript).toBeNull();
  });
});

describe("discovery: every audited repo, with coverage (R61, R62)", () => {
  let sandbox: string;
  let transcripts: string;
  let previousHome: string | undefined;

  /** A project root with a `.git` marker, so `projectRootFromCwd` stops there. */
  function projectRoot(name: string): string {
    const dir = join(sandbox, "work", name);
    mkdirSync(join(dir, ".git"), { recursive: true });
    return dir;
  }
  function audit(repo: string, id: string, cwd: string, ts = "2026-09-20T10:00:00.000Z"): void {
    const dir = join(root, repo);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `session-${id}.log`),
      `${JSON.stringify({ ts, event: "start", cwd, repo, sessionId: id })}\n`,
      "utf-8",
    );
  }
  function host(slugOf: string, name: string, mtime?: string): string {
    const dir = join(transcripts, encodeCwdToSlug(slugOf));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, "", "utf-8");
    if (mtime) utimesSync(file, new Date(mtime), new Date(mtime));
    return file;
  }

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "navori-cov-"));
    transcripts = join(sandbox, "projects");
    mkdirSync(transcripts);
    process.env.NAVORI_TRANSCRIPTS_ROOT = transcripts;
    // The real `~` must never be read, even by a code path that forgot the override.
    previousHome = process.env.HOME;
    process.env.HOME = join(sandbox, "home");
  });
  afterEach(() => {
    delete process.env.NAVORI_TRANSCRIPTS_ROOT;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(sandbox, { recursive: true, force: true });
  });

  // Covers: R61, R62
  it("returns one row per repo, counting the repo slug AND its agent worktrees as the denominator", () => {
    const one = projectRoot("one");
    const two = projectRoot("two");
    audit("one", "a1", one);
    audit("one", "a2", join(one, "src"));
    audit("two", "b1", two);

    host(one, "a1.jsonl");
    host(one, "a2.jsonl");
    host(one, "a3.jsonl");
    // The same repo's agent worktrees: `/.claude` encodes to `--claude`.
    host(`${one}/.claude/worktrees/agent-x`, "w1.jsonl");
    host(`${one}/.claude/worktrees/agent-y`, "w2.jsonl");
    // A subagent transcript is not a session, and a neighbour is not this repo.
    const nested = join(transcripts, encodeCwdToSlug(one), "a1", "subagents");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "agent-1.jsonl"), "", "utf-8");
    host(`${one}-other`, "z1.jsonl");
    host(two, "b1.jsonl");

    const { repos, warnings } = listAuditedRepos();
    expect(warnings).toEqual([]);
    expect(repos.map((r) => [r.repo, r.audited, r.host])).toEqual([
      ["one", 2, 5],
      ["two", 1, 1],
    ]);
    expect(coverageMetrics(repos)).toEqual({
      "coverage.sessions.audited": 3,
      "coverage.sessions.host": 6,
      "coverage.pct": 50,
    });
  });

  // Covers: R62
  it("applies the period to both sides of the ratio", () => {
    const one = projectRoot("one");
    audit("one", "old", one, "2026-01-01T10:00:00.000Z");
    audit("one", "new", one, "2026-09-20T10:00:00.000Z");
    host(one, "old.jsonl", "2026-01-01T10:00:00.000Z");
    host(one, "new.jsonl", "2026-09-20T10:00:00.000Z");
    host(one, "new2.jsonl", "2026-09-21T10:00:00.000Z");

    const [row] = listAuditedRepos({ since: "2026-09-01" }).repos;
    expect([row?.audited, row?.host]).toEqual([1, 2]);
    expect(countHostSessions([one], { until: "2026-02-01" })).toBe(1);
  });

  // Covers: R62
  it("warns on a basename collision instead of silently merging two repos", () => {
    const a = join(sandbox, "work", "x", "shared");
    const b = join(sandbox, "work", "y", "shared");
    mkdirSync(join(a, ".git"), { recursive: true });
    mkdirSync(join(b, ".git"), { recursive: true });
    audit("shared", "s1", a);
    audit("shared", "s2", b);

    const { repos, warnings } = listAuditedRepos();
    expect(repos).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("basename collision: 'shared'");
    expect(warnings[0]).toContain(a);
    expect(warnings[0]).toContain(b);
  });

  // Covers: R61
  it("lists only directories that hold a session log", () => {
    const one = projectRoot("one");
    audit("one", "a1", one);
    mkdirSync(join(root, "_all-repos", "ranges", "2026-09-01--2026-09-30"), { recursive: true });
    writeFileSync(
      join(root, "_all-repos", "ranges", "2026-09-01--2026-09-30", "snapshot-x.json"),
      "{}",
    );
    mkdirSync(join(root, "empty-dir"));
    writeFileSync(join(root, "stray.txt"), "x");
    expect(listAuditedRepos().repos.map((r) => r.repo)).toEqual(["one"]);
  });

  // Covers: R62
  it("leaves a repo with no known root out of the ratio instead of counting it as a gap", () => {
    mkdirSync(join(root, "headless"), { recursive: true });
    writeFileSync(join(root, "headless", "session-h1.log"), "{not json\n");
    const one = projectRoot("one");
    audit("one", "a1", one);
    host(one, "a1.jsonl");

    const { repos } = listAuditedRepos();
    expect(repos.find((r) => r.repo === "headless")?.host).toBeNull();
    expect(coverageMetrics(repos)["coverage.pct"]).toBe(100);
    expect(coverageMetrics(repos.filter((r) => r.repo === "headless"))["coverage.pct"]).toBeNull();
  });
});

describe("discovery: Codex rollouts (spec 0041 T18)", () => {
  const SID = "01a10108-38f8-7470-ae6a-fbec838f6c4c";
  let home: string;
  const prevHome = process.env.CODEX_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "navori-codex-home-"));
    process.env.CODEX_HOME = home;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  function rollout(): string {
    const dir = join(home, "sessions", "2026", "10", "03");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `rollout-2026-10-03T03-11-18-${SID}.jsonl`);
    writeFileSync(file, "{}\n");
    return file;
  }

  // Covers: R24
  it("finds the rollout under codexHome()/sessions by session id", () => {
    const file = rollout();
    expect(resolveCodexRollout(SID)).toBe(file);
    expect(resolveCodexRollout("ffffffff-0000-0000-0000-000000000000")).toBeNull();
  });

  // Covers: R24
  it("prefers the recorded path and degrades to null on a bad CODEX_HOME", () => {
    const file = rollout();
    expect(resolveCodexRollout(SID, file)).toBe(file);
    process.env.CODEX_HOME = "relative/home";
    expect(resolveCodexRollout(SID)).toBeNull();
  });

  // Covers: R24
  it("keeps a Codex session's recorded rollout out of the Claude transcript slot", () => {
    const file = rollout();
    const dir = join(root, REPO);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `session-${SID}.log`),
      [
        JSON.stringify({
          ts: "2026-10-03T03:11:17.000Z",
          event: "start",
          host: "codex",
          cwd: "/w",
        }),
        JSON.stringify({ event: "prompt", transcript: file }),
      ].join("\n") + "\n",
    );
    const [m] = findMarkedSessions(REPO);
    expect(m?.host).toBe("codex");
    expect(m?.transcript).toBeNull();
    expect(m?.rollout).toBe(file);
  });
});
