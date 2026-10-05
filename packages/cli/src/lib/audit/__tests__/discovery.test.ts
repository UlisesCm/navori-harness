import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  coverageMetrics,
  countHostSessions,
  findMarkedSessions,
  resolveCodexRollout,
  listAuditedRepos,
  repoCoverage,
  requestedRange,
  markerEnumeration,
  createAuditDiscoveryContext,
} from "../discovery.ts";
import { encodeCwdToSlug, auditsRoot, sessionLogPath } from "../paths.ts";
import { normalizeCodexIdentity, createAuditReadBudget } from "../model.ts";
import { codexIdentityFingerprint } from "../discovery.ts";

let root: string;
const REPO = "fixture-repo";

describe("pinned Codex root/thread identity", () => {
  // Covers: R4, R5, R9
  it.each(["root", "child", "grandchild"])(
    "keeps %s root context separate from thread and parent",
    (thread) => {
      const parent = thread === "root" ? null : thread === "child" ? "root" : "child";
      const decoded = normalizeCodexIdentity(
        {
          id: thread,
          session_id: "root",
          cwd: "/fixture",
          cli_version: "0.160.0",
          parent_thread_id: parent,
          source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent } } } : "cli",
        },
        "/fixture",
      );
      expect(decoded).toMatchObject({
        status: "verified",
        identity: {
          threadId: thread,
          rootSessionId: "root",
          parentThreadId: parent,
          relation: parent ? "child" : "root",
        },
      });
    },
  );

  // Covers: R5, R9
  it("distinguishes unsupported version, unknown relation and contradictory parent evidence", () => {
    const metadata = { id: "child", session_id: "root", cwd: "/fixture", cli_version: "0.160.0" };
    expect(normalizeCodexIdentity({ ...metadata, cli_version: "0.161.0" }, "/fixture")).toEqual({
      status: "unsupported",
    });
    expect(normalizeCodexIdentity(metadata, "/fixture")).toMatchObject({
      status: "verified",
      identity: { relation: "unknown" },
    });
    expect(
      normalizeCodexIdentity(
        {
          ...metadata,
          parent_thread_id: "root",
          source: { subagent: { thread_spawn: { parent_thread_id: "different" } } },
        },
        "/fixture",
      ),
    ).toEqual({ status: "identity-conflict" });
    expect(normalizeCodexIdentity({ ...metadata, parent_thread_id: "child" }, "/fixture")).toEqual({
      status: "identity-conflict",
    });
  });

  // Covers: R5, R9, R10
  it("uses only canonical ownership facts for the fingerprint", () => {
    const fields = { id: "root", session_id: "root", cwd: "/fixture", cli_version: "0.160.0" };
    const first = normalizeCodexIdentity(fields, "/fixture");
    const second = normalizeCodexIdentity(
      {
        ...fields,
        base_instructions: "private human data",
        timestamp: "later",
        model_provider: "arbitrary",
      },
      "/fixture",
    );
    expect(first.status).toBe("verified");
    expect(second.status).toBe("verified");
    if (first.status !== "verified" || second.status !== "verified") throw new Error("fixture");
    expect(codexIdentityFingerprint(first.identity)).toBe(
      codexIdentityFingerprint(second.identity),
    );
    expect(codexIdentityFingerprint(first.identity)).toMatch(/^[a-f0-9]{64}$/);
    expect(codexIdentityFingerprint({ ...first.identity, checkout: "/different" })).not.toBe(
      codexIdentityFingerprint(first.identity),
    );
  });

  // Covers: R5, R9
  it("accepts an exact child marker but never treats a root marker pointing at child as root ownership", () => {
    const source = join(root, "child.jsonl");
    writeFileSync(
      source,
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "child",
          session_id: "root",
          cli_version: "0.160.0",
          cwd: "/fixture",
          parent_thread_id: "root",
          source: { subagent: { thread_spawn: { parent_thread_id: "root" } } },
        },
      }) + "\n",
    );
    mkdirSync(join(root, REPO), { recursive: true });
    for (const id of ["root", "child"])
      writeFileSync(
        sessionLogPath(REPO, id),
        JSON.stringify({
          event: "start",
          sessionId: id,
          host: "codex",
          cwd: "/fixture",
          repo: REPO,
          transcript: source,
          ts: "2026-10-04T10:00:00Z",
        }) + "\n",
      );
    const bytes = readFileSync(source, "utf-8");
    expect(findMarkedSessions(REPO, { session: "child" })[0]).toMatchObject({
      sourceStatus: "verified",
      adapter: "codex-rollout",
    });
    expect(findMarkedSessions(REPO, { session: "root" })[0]).toMatchObject({
      sourceStatus: "identity-conflict",
      adapter: null,
    });
    expect(readFileSync(source, "utf-8")).toBe(bytes);
  });
});

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
    writeFileSync(
      file,
      `${JSON.stringify({ type: "user", sessionId: "sess-rec", cwd: "/some/repo/path" })}\n`,
      "utf-8",
    );

    markWithTranscript("sess-rec", "/some/repo/path", file);
    const [found] = findMarkedSessions(REPO);
    expect(found?.transcript).toBe(file);
    expect(found?.hostProvenance).toBe("recovered:transcript");
    expect(found?.sourceStatus).toBe("verified");
    expect(found).toMatchObject({
      adapter: "claude-transcript",
      source: file,
      sourceVersion: null,
      versionReason: "not-observed",
    });
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
    writeFileSync(
      file,
      `${JSON.stringify({ type: "user", sessionId: name.replace(/\.jsonl$/, ""), cwd: slugOf, timestamp: mtime ?? "2026-09-20T10:00:00Z", isSidechain: false })}\n`,
      "utf-8",
    );
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
    process.env.CODEX_HOME = join(sandbox, "codex");
    mkdirSync(join(sandbox, "codex", "sessions"), { recursive: true });
  });
  afterEach(() => {
    delete process.env.NAVORI_TRANSCRIPTS_ROOT;
    delete process.env.CODEX_HOME;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(sandbox, { recursive: true, force: true });
  });

  // Covers: R61, R62
  // Covers: R8
  it("distinguishes absent/empty marker enumeration from an unreadable directory", () => {
    const one = projectRoot("one");
    expect(markerEnumeration("one")).toMatchObject({ state: "observed", files: [] });
    expect(repoCoverage("one", {}, one).row).toMatchObject({
      audited: 0,
      captured: 0,
      host: 0,
      reason: "empty-population",
    });
    mkdirSync(join(root, "one"));
    expect(markerEnumeration("one")).toMatchObject({ state: "observed", files: [] });
    // ENOTDIR is a deterministic unreadable path even when tests run as root.
    writeFileSync(join(root, "blocked"), "not a directory");
    expect(markerEnumeration("blocked")).toMatchObject({
      state: "unavailable",
      reason: "unreadable",
    });
    expect(repoCoverage("blocked", {}, one).row).toMatchObject({
      audited: null,
      captured: null,
      host: 0,
      reason: "incomplete-enumeration",
      activation: { observed: null, root: null, child: null, unknown: null, markerOnly: null },
    });
    host(one, "only.jsonl");
    expect(repoCoverage("blocked", {}, one).row).toMatchObject({
      audited: null,
      captured: null,
      host: 1,
    });
  });
  // Covers: R8
  it.each(["id", "session_id", "matching-aliases", "conflicting-aliases", "conflicting-header"])(
    "qualifies Codex population and capture identities without changing files: %s",
    (mode) => {
      const cwd = projectRoot("identity");
      const source = join(sandbox, "codex", "sessions", "rollout-s.jsonl");
      const metadata = {
        type: "session_meta",
        timestamp: "2026-09-20T10:00:00Z",
        payload: {
          cwd,
          parent_thread_id: null,
          ...(mode !== "session_id" ? { id: "s" } : {}),
          ...(mode !== "id" && mode !== "conflicting-header"
            ? { session_id: mode === "conflicting-aliases" ? "different" : "s" }
            : {}),
        },
      };
      writeFileSync(source, JSON.stringify(metadata) + "\n");
      const dir = join(root, "identity");
      mkdirSync(dir);
      const marker = join(dir, "session-s.log");
      const header = {
        event: "start",
        host: "codex",
        sessionId: mode === "conflicting-header" ? "different" : "s",
        repo: "identity",
        cwd,
        ts: "2026-09-20T10:00:00Z",
        transcript: source,
      };
      writeFileSync(marker, JSON.stringify(header) + "\n");
      const before = [readFileSync(source, "utf-8"), readFileSync(marker, "utf-8")];
      const conflict = mode.startsWith("conflicting");
      expect(findMarkedSessions("identity")[0]?.sourceStatus).toBe(
        conflict ? "identity-conflict" : "verified",
      );
      const row = repoCoverage("identity").row;
      expect(row).toMatchObject({
        host: mode === "conflicting-aliases" ? null : 1,
        captured: conflict ? null : 1,
        ratio: conflict ? null : 1,
        reason: conflict ? "identity-conflict" : null,
        activation: {
          observed: 1,
          root: conflict ? 0 : 1,
          unknown: conflict ? 1 : 0,
          markerOnly: mode === "conflicting-aliases" ? 1 : 0,
        },
      });
      expect(
        row.populations?.find((p) => p.host === "codex" && p.relation === "root"),
      ).toMatchObject({
        denominator: mode === "conflicting-aliases" ? null : 1,
        captured: conflict ? null : 1,
        ratio: conflict ? null : 1,
      });
      expect([readFileSync(source, "utf-8"), readFileSync(marker, "utf-8")]).toEqual(before);
    },
  );
  // Covers: R8
  it("uses UTC midnight, offsets, and an exclusive instant upper boundary", () => {
    const one = projectRoot("one");
    host(one, "before.jsonl", "2026-09-19T23:59:59.999Z");
    host(one, "at.jsonl", "2026-09-20T02:00:00+02:00");
    host(one, "inside.jsonl", "2026-09-20T23:59:59.999Z");
    host(one, "after.jsonl", "2026-09-21T00:00:00Z");
    audit("one", "at", one, "2026-09-20T00:00:00Z");
    audit("one", "after", one, "2026-09-21T00:00:00Z");
    const row = repoCoverage("one", {
      range: { from: "2026-09-20T00:00:00.000Z", to: "2026-09-21T00:00:00.000Z" },
    }).row;
    expect(row).toMatchObject({ host: 2, captured: 1, audited: 1, ratio: 0.5 });
  });
  // Covers: R8
  it("resolves late root/child relations outside the cohort and distinguishes true marker-only", () => {
    const one = projectRoot("one");
    host(one, "root.jsonl", "2026-09-19T10:00:00Z");
    const child = host(one, "child.jsonl", "2026-09-19T10:00:00Z");
    const rec = JSON.parse(readFileSync(child, "utf-8"));
    writeFileSync(child, JSON.stringify({ ...rec, isSidechain: true }) + "\n");
    for (const id of ["root", "child", "marker-only"]) audit("one", id, one);
    const row = repoCoverage("one", { since: "2026-09-20", until: "2026-09-20" }).row;
    expect(row).toMatchObject({
      host: 0,
      captured: 0,
      audited: 3,
      activation: { root: 1, child: 1, unknown: 1, markerOnly: 1 },
    });
  });
  // Covers: R8
  it("deduplicates identical metadata but never certifies conflicting identities", () => {
    const one = projectRoot("one");
    const source = host(one, "same.jsonl");
    const duplicate = host(one, "duplicate.jsonl");
    writeFileSync(duplicate, readFileSync(source));
    expect(countHostSessions([one])).toBe(1);
    audit("one", "same", one);
    const rec = JSON.parse(readFileSync(source, "utf-8"));
    writeFileSync(duplicate, JSON.stringify({ ...rec, isSidechain: true }) + "\n");
    expect(countHostSessions([one])).toBeNull();
    expect(repoCoverage("one").row).toMatchObject({
      host: null,
      activation: { root: 0, child: 0, unknown: 1, markerOnly: 0 },
    });
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
      "coverage.sessions.captured": 3,
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

  // Covers: R8
  it("uses the same UTC host-start cohort despite late activation and changed mtime", () => {
    const one = projectRoot("one");
    audit("one", "late", one, "2026-09-21T10:00:00Z");
    const source = host(one, "late.jsonl", "2026-09-20T10:00:00Z");
    utimesSync(source, new Date("2030-01-01"), new Date("2030-01-01"));
    const { row } = repoCoverage("one", { since: "2026-09-20", until: "2026-09-20" });
    expect(row).toMatchObject({ host: 1, captured: 1, audited: 0, ratio: 1 });
    const later = repoCoverage("one", { since: "2026-09-21", until: "2026-09-21" }).row;
    expect(later).toMatchObject({
      host: 0,
      captured: 0,
      audited: 1,
      ratio: null,
      reason: "empty-population",
      activation: { root: 1, child: 0, unknown: 0, markerOnly: 0 },
    });
  });
  // Covers: R8
  it("reports zero capture and distinct root/child/unknown partitions without markers", () => {
    const one = projectRoot("one");
    const source = host(one, "child.jsonl", "2026-09-20T10:00:00Z");
    const rec = JSON.parse(readFileSync(source, "utf-8"));
    rec.isSidechain = true;
    writeFileSync(source, JSON.stringify(rec) + "\n");
    host(one, "root.jsonl", "2026-09-20T11:00:00Z");
    const { row } = repoCoverage("one", { since: "2026-09-20", until: "2026-09-20" }, one);
    expect(row).toMatchObject({ host: 2, captured: 0, ratio: 0, activation: { observed: 0 } });
    expect(
      row.populations?.find((r) => r.host === "claude" && r.relation === "child")?.denominator,
    ).toBe(1);
    expect(
      row.populations?.find((r) => r.host === "claude" && r.relation === "root")?.denominator,
    ).toBe(1);
    expect(requestedRange({ since: "2026-09-20", until: "2026-09-20" })).toEqual({
      from: "2026-09-20T00:00:00.000Z",
      to: "2026-09-21T00:00:00.000Z",
    });
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
  // Covers: R8
  it("retains unknown populations rather than presenting known subpopulation as total", () => {
    mkdirSync(join(root, "headless"), { recursive: true });
    writeFileSync(join(root, "headless", "session-h1.log"), "{not json\n");
    const one = projectRoot("one");
    audit("one", "a1", one);
    host(one, "a1.jsonl");

    const { repos } = listAuditedRepos();
    expect(repos.find((r) => r.repo === "headless")?.host).toBeNull();
    expect(coverageMetrics(repos)["coverage.pct"]).toBeNull();
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
    writeFileSync(
      file,
      `${JSON.stringify({ type: "session_meta", payload: { id: SID, cwd: "/w", cli_version: "0.160.0" } })}\n`,
    );
    return file;
  }

  // Covers: R21
  it("builds the Codex fallback index once per context and does not retain newly appended unrelated paths", () => {
    const file = rollout();
    const context = createAuditDiscoveryContext();
    expect(resolveCodexRollout(SID, undefined, context)).toBe(file);
    const retained = context.budget.diagnostics.retainedPaths;
    const laterId = "later-synthetic";
    writeFileSync(join(home, "sessions", `rollout-later-${laterId}.jsonl`), "{}\n");
    expect(resolveCodexRollout(laterId, undefined, context)).toBeNull();
    expect(context.budget.diagnostics.retainedPaths).toBe(retained);
    expect(context.indexedRoots.size).toBe(1);
  });
  // Covers: R21
  it("stops path enumeration before materializing an oversized index and exposes unknown remainder", () => {
    rollout();
    const context = createAuditDiscoveryContext(createAuditReadBudget({ pathsPerReport: 2 }));
    expect(resolveCodexRollout(SID, undefined, context)).toBeNull();
    expect(context.budget.diagnostics).toMatchObject({
      retainedPaths: 2,
      omittedFacts: null,
      truncated: true,
    });
    expect(context.budget.diagnostics.omittedLowerBound).toBeGreaterThan(0);
    expect(context.indexedPaths?.length).toBeLessThanOrEqual(2);
  });

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
    expect(m?.sourceStatus).toBe("verified");
    expect(m).toMatchObject({
      adapter: "codex-rollout",
      source: file,
      sourceVersion: "0.160.0",
      sourceReason: null,
    });
  });

  // Covers: R2, R3
  it("recovers a historical hostless Codex marker only from matching metadata", () => {
    const file = rollout();
    const dir = join(root, REPO);
    mkdirSync(dir, { recursive: true });
    const log = join(dir, `session-${SID}.log`);
    const original =
      [
        JSON.stringify({
          event: "start",
          sessionId: SID,
          cwd: "/w",
          repo: REPO,
          ts: "2026-10-03T03:11:17Z",
        }),
        JSON.stringify({ event: "prompt", transcript: file }),
      ].join("\n") + "\n";
    writeFileSync(log, original);
    const [m] = findMarkedSessions(REPO);
    expect([m?.host, m?.hostProvenance, m?.sourceStatus]).toEqual([
      "codex",
      "recovered:rollout",
      "verified",
    ]);
    expect(m).toMatchObject({ adapter: "codex-rollout", source: file, sourceVersion: "0.160.0" });
    expect(readFileSync(log, "utf-8")).toBe(original);
  });

  // Covers: R2, R3
  it("rejects a declared host that contradicts the source format or identity", () => {
    const file = rollout();
    const dir = join(root, REPO);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `session-${SID}.log`),
      [
        JSON.stringify({ event: "start", host: "claude", sessionId: SID, cwd: "/w", repo: REPO }),
        JSON.stringify({ event: "prompt", transcript: file }),
      ].join("\n") + "\n",
    );
    expect(findMarkedSessions(REPO)[0]).toMatchObject({
      sourceStatus: "wrong-format",
      adapter: null,
      sourceReason: "wrong-format",
    });
    writeFileSync(
      join(dir, `session-${SID}.log`),
      [
        JSON.stringify({
          event: "start",
          host: "codex",
          sessionId: "wrong",
          cwd: "/w",
          repo: REPO,
        }),
        JSON.stringify({ event: "prompt", transcript: file }),
      ].join("\n") + "\n",
    );
    expect(findMarkedSessions(REPO)[0]?.sourceStatus).toBe("identity-conflict");
  });

  // Covers: R2, R3
  it("leaves an empty historical source unknown rather than guessing by path", () => {
    const dir = join(root, REPO);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `session-${SID}.log`),
      `${JSON.stringify({ event: "start", sessionId: SID, cwd: "/w", repo: REPO })}\n`,
    );
    expect(findMarkedSessions(REPO)[0]).toMatchObject({
      host: "unknown",
      sourceStatus: "missing",
      adapter: null,
      sourceVersion: null,
      sourceReason: "missing",
    });
  });
});
