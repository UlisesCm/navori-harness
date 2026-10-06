import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import {
  mkdirSync,
  chmodSync,
  appendFileSync,
  realpathSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  appendCliEvent,
  hasAuditTarget,
  captureCodexChild,
  recordAuditMetadata,
  absorbAuditMetadataSpool,
  readAuditHeaderFromFd,
  matchesAuditHeaderIdentity,
} from "../cli-event.ts";
import { readChildSourceBindings, readChildSourceRegistrations } from "../discovery.ts";
import { sessionLogPath, repoFromCwd } from "../paths.ts";
import { normalizeOutcome } from "../model.ts";

vi.mock(import("node:fs"), { spy: true });

describe("bounded lifecycle header primitives", () => {
  const cwd = process.cwd();
  const marker = { event: "start", sessionId: "explicit", repo: repoFromCwd(cwd), cwd };
  // Covers: R10 R11
  it.each([null, "other", 0, []])("rejects malformed declared host %j", (host) => {
    expect(
      matchesAuditHeaderIdentity({ ...marker, host }, "claude", "explicit", marker.repo, cwd),
    ).toBe(false);
  });
  // Covers: R10
  it.each(["", ".", "relative/path", "/" + "x".repeat(8192)])(
    "rejects noncanonical or oversized cwd %s",
    (path) => {
      expect(
        matchesAuditHeaderIdentity(
          { ...marker, cwd: path },
          "claude",
          "explicit",
          marker.repo,
          cwd,
        ),
      ).toBe(false);
    },
  );
  // Covers: R10
  it("accepts absolute legacy identity and rejects conflicting aliases and projects", () => {
    expect(matchesAuditHeaderIdentity(marker, "claude", "explicit", marker.repo, cwd)).toBe(true);
    expect(
      matchesAuditHeaderIdentity(
        { ...marker, id: "other" },
        "claude",
        "explicit",
        marker.repo,
        cwd,
      ),
    ).toBe(false);
    expect(
      matchesAuditHeaderIdentity(
        marker,
        "claude",
        "explicit",
        marker.repo,
        "/other/" + marker.repo,
      ),
    ).toBe(false);
  });
  // Covers: R10
  it("requires a complete valid UTF8 header on the supplied descriptor", () => {
    const path = join(root, "header");
    for (const bytes of [Buffer.from(JSON.stringify(marker)), Buffer.from([255, 10])]) {
      writeFileSync(path, bytes);
      const fd = fs.openSync(path, "r");
      try {
        expect(readAuditHeaderFromFd(fd)).toBeNull();
      } finally {
        fs.closeSync(fd);
      }
    }
  });
});

let root: string;
let repo: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {
    NAVORI_AUDITS_ROOT: process.env.NAVORI_AUDITS_ROOT,
    CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
    NAVORI_AUDIT_HOST: process.env.NAVORI_AUDIT_HOST,
    NAVORI_AUDIT_SESSION_ID: process.env.NAVORI_AUDIT_SESSION_ID,
    CODEX_SESSION_ID: process.env.CODEX_SESSION_ID,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    CODEX_HOME: process.env.CODEX_HOME,
  };
  delete process.env.NAVORI_AUDIT_HOST;
  delete process.env.NAVORI_AUDIT_SESSION_ID;
  delete process.env.CODEX_SESSION_ID;
  delete process.env.CODEX_THREAD_ID;
  root = mkdtempSync(join(tmpdir(), "navori-cli-event-"));
  repo = join(root, "myrepo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "navori.config.json"), "{}");
  process.env.NAVORI_AUDITS_ROOT = join(root, "audits");
  process.env.CLAUDE_CODE_SESSION_ID = "sess-1";
});

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

/** Private synthetic metadata only; no host log or developer HOME is read. */
function childFixture(parent = "root"): { log: string; child: string; sources: string } {
  root = realpathSync(root);
  repo = join(root, "myrepo");
  const audit = join(root, "private-audits");
  process.env.NAVORI_AUDITS_ROOT = audit;
  process.env.CODEX_HOME = join(root, "synthetic-codex");
  const sources = join(process.env.CODEX_HOME, "sessions");
  mkdirSync(sources, { recursive: true, mode: 0o700 });
  mkdirSync(join(audit, "myrepo"), { recursive: true, mode: 0o700 });
  const source = (id: string, p: string | null): string => {
    const path = join(sources, `rollout-fixture-${id}.jsonl`);
    writeFileSync(
      path,
      JSON.stringify({
        type: "session_meta",
        payload: {
          id,
          session_id: "root",
          cwd: repo,
          cli_version: "0.160.0",
          parent_thread_id: p,
          source: p ? { subagent: { thread_spawn: { parent_thread_id: p, depth: 1 } } } : "cli",
          base_instructions: "sensitive human sentinel",
        },
      }) + "\n",
      { mode: 0o600 },
    );
    return path;
  };
  const rootSource = source("root", null);
  if (parent !== "root") source(parent, "root");
  const child = source("child", parent);
  const log = sessionLogPath("myrepo", "root");
  writeFileSync(
    log,
    JSON.stringify({
      event: "start",
      host: "codex",
      sessionId: "root",
      cwd: repo,
      repo: "myrepo",
      ts: "2026-10-04T12:00:00Z",
      transcript: rootSource,
    }) + "\n",
    { mode: 0o600 },
  );
  return { log, child, sources };
}

describe("explicit private Codex child registration", () => {
  // Covers: R5, R8, R9, R10
  it("retains both physical revisions but only one logical capture and skips the revision retry", () => {
    const { log, child, sources } = childFixture();
    expect(captureCodexChild(repo, "root", "child", child)).toMatchObject({
      registered: 1,
      skipped: 0,
    });
    const first = readChildSourceRegistrations(log, "root")[0];
    const revision = join(sources, "arbitrary-revision.jsonl");
    writeFileSync(revision, readFileSync(child), { mode: 0o600 });
    expect(captureCodexChild(repo, "root", "child", revision)).toMatchObject({
      registered: 1,
      skipped: 0,
    });
    const bytes = readFileSync(log, "utf-8");
    expect(captureCodexChild(repo, "root", "child", revision)).toMatchObject({
      registered: 0,
      skipped: 1,
    });
    expect(readFileSync(log, "utf-8")).toBe(bytes);
    expect(readChildSourceRegistrations(log, "root")).toEqual([first]);
    expect(readChildSourceBindings(log, "root").map((record) => record.sourcePath)).toEqual([
      child,
      revision,
    ]);
  });

  // Covers: R5, R8, R9, R10
  it("does not promote real short-write JSON without its newline into capture evidence", async () => {
    const { log, child } = childFixture();
    const original = readFileSync(log, "utf-8");
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(fs.writeSync).mockImplementation((fd: number, data: unknown) => {
      if (!Buffer.isBuffer(data)) throw new Error("expected encoded registration bytes");
      return actual.writeSync(fd, data.subarray(0, data.byteLength - 1));
    });
    expect(captureCodexChild(repo, "root", "child", child)).toMatchObject({
      ok: false,
      state: "partial",
      registered: 0,
      reason: "short-write",
    });
    const partial = readFileSync(log, "utf-8");
    expect(partial.startsWith(original)).toBe(true);
    expect(partial.endsWith("\n")).toBe(false);
    expect(JSON.parse(partial.slice(original.length))).toMatchObject({
      event: "child-source",
      threadId: "child",
    });
    expect(readChildSourceRegistrations(log, "root")).toEqual([]);
    expect(readChildSourceBindings(log, "root")).toEqual([]);
    vi.resetAllMocks();
    expect(captureCodexChild(repo, "root", "child", child).ok).toBe(false);
    expect(readFileSync(log, "utf-8")).toBe(partial);
    // The equivalent complete fixture is evidence; adding a subsequent partial record cannot erase it.
    writeFileSync(log, partial + "\n");
    const complete = readChildSourceRegistrations(log, "root");
    expect(complete).toHaveLength(1);
    appendFileSync(log, JSON.stringify(complete[0]));
    expect(readChildSourceRegistrations(log, "root")).toEqual(complete);
    expect(readChildSourceBindings(log, "root")).toHaveLength(1);
  });

  // Covers: R4, R5, R8, R9, R10
  it.each(["root", "parent"])(
    "registers %s lineage once without ambient identity aliases or human metadata",
    (parent) => {
      const { log, child } = childFixture(parent);
      process.env.CODEX_THREAD_ID = "unrelated";
      process.env.NAVORI_AUDIT_SESSION_ID = "another";
      const original = readFileSync(log, "utf-8");
      expect(captureCodexChild(repo, "root", "child", child)).toMatchObject({
        ok: true,
        registered: 1,
      });
      expect(captureCodexChild(repo, "root", "child", child)).toMatchObject({
        ok: true,
        skipped: 1,
      });
      const events = readChildSourceRegistrations(log, "root");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event: "child-source",
        rootSessionId: "root",
        threadId: "child",
        parentThreadId: parent,
      });
      expect(readFileSync(log, "utf-8").startsWith(original)).toBe(true);
      expect(readFileSync(log, "utf-8")).not.toContain("sensitive human sentinel");
      expect(events[0]).not.toHaveProperty("tsMs");
      expect(events[0]).not.toHaveProperty("sessionId");
      const bytes = readFileSync(log, "utf-8");
      readChildSourceRegistrations(log, "root");
      expect(readFileSync(log, "utf-8")).toBe(bytes);
      appendFileSync(log, JSON.stringify(events[0]) + "\n");
      expect(readChildSourceRegistrations(log, "root")).toHaveLength(1);
    },
  );

  // Covers: R5, R9, R10
  it("keeps identity fingerprint stable on append and human-only header changes", () => {
    const { log, child } = childFixture();
    expect(captureCodexChild(repo, "root", "child", child).ok).toBe(true);
    const before = readChildSourceRegistrations(log, "root")[0]?.sourceHeaderFingerprint;
    const text = readFileSync(child, "utf-8").replace("sensitive human sentinel", "different text");
    writeFileSync(child, text + JSON.stringify({ type: "response_item", payload: {} }) + "\n");
    expect(captureCodexChild(repo, "root", "child", child)).toMatchObject({ ok: true, skipped: 1 });
    expect(readChildSourceRegistrations(log, "root")[0]?.sourceHeaderFingerprint).toBe(before);
  });

  // Covers: R5, R9, R10
  it.each([
    "wrong-root",
    "wrong-thread",
    "future",
    "self-parent",
    "cycle",
    "wrong-checkout",
    "missing-parent",
  ])("refuses %s without mutating source or log", (mode) => {
    const { log, child, sources } = childFixture(mode === "cycle" ? "parent" : "root");
    const rec = JSON.parse(readFileSync(child, "utf-8")) as {
      payload: {
        cli_version: string;
        parent_thread_id: string;
        cwd: string;
        source: { subagent: { thread_spawn: { parent_thread_id: string } } };
      };
    };
    if (mode === "future") rec.payload.cli_version = "0.161.0";
    if (mode === "self-parent") {
      rec.payload.parent_thread_id = "child";
      rec.payload.source.subagent.thread_spawn.parent_thread_id = "child";
    }
    if (mode === "cycle") {
      const parent = join(sources, "rollout-fixture-parent.jsonl");
      writeFileSync(
        parent,
        readFileSync(parent, "utf-8").replaceAll(
          '"parent_thread_id":"root"',
          '"parent_thread_id":"child"',
        ),
      );
    }
    if (mode === "missing-parent") {
      rec.payload.parent_thread_id = "absent";
      rec.payload.source.subagent.thread_spawn.parent_thread_id = "absent";
    }
    if (mode === "wrong-checkout") rec.payload.cwd = root;
    writeFileSync(child, JSON.stringify(rec) + "\n");
    const original = readFileSync(log, "utf-8");
    const source = readFileSync(child, "utf-8");
    expect(
      captureCodexChild(
        repo,
        mode === "wrong-root" ? "other" : "root",
        mode === "wrong-thread" ? "other" : "child",
        child,
      ).ok,
    ).toBe(false);
    expect(readFileSync(log, "utf-8")).toBe(original);
    expect(readFileSync(child, "utf-8")).toBe(source);
  });

  // Covers: R9, R10
  it.each(["log", "repo", "root"])("refuses nonprivate %s without chmod", (target) => {
    const { log, child } = childFixture();
    const path =
      target === "log" ? log : target === "repo" ? join(log, "..") : join(log, "..", "..");
    chmodSync(path, target === "log" ? 0o644 : 0o755);
    const original = readFileSync(log, "utf-8");
    expect(captureCodexChild(repo, "root", "child", child).reason).toBe("unsafe-target");
    expect(fs.statSync(path).mode & 0o777).toBe(target === "log" ? 0o644 : 0o755);
    expect(readFileSync(log, "utf-8")).toBe(original);
  });

  // Covers: R9, R10
  it.each(["log", "source", "repo", "root"])(
    "refuses a symlinked %s without following it",
    (target) => {
      const { log, child } = childFixture();
      const path =
        target === "source"
          ? child
          : target === "log"
            ? log
            : target === "repo"
              ? join(log, "..")
              : join(log, "..", "..");
      const original = readFileSync(log, "utf-8");
      const sourceBytes = readFileSync(child, "utf-8");
      renameSync(path, path + ".original");
      symlinkSync(path + ".original", path);
      expect(captureCodexChild(repo, "root", "child", child).ok).toBe(false);
      expect(readFileSync(log, "utf-8")).toBe(original);
      expect(readFileSync(child, "utf-8")).toBe(sourceBytes);
    },
  );

  // Covers: R5, R9, R10
  it("reports changed identity as a conflict rather than choosing a new parent", () => {
    const { log, child, sources } = childFixture();
    expect(captureCodexChild(repo, "root", "child", child).ok).toBe(true);
    const parent = join(sources, "arbitrary-parent-filename.jsonl");
    writeFileSync(
      parent,
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "new-parent",
          session_id: "root",
          cli_version: "0.160.0",
          cwd: repo,
          parent_thread_id: "root",
          source: { subagent: { thread_spawn: { parent_thread_id: "root" } } },
        },
      }) + "\n",
      { mode: 0o600 },
    );
    writeFileSync(
      child,
      readFileSync(child, "utf-8").replaceAll(
        '"parent_thread_id":"root"',
        '"parent_thread_id":"new-parent"',
      ),
    );
    const original = readFileSync(log, "utf-8");
    expect(captureCodexChild(repo, "root", "child", child)).toMatchObject({
      ok: false,
      state: "invalid",
      reason: "binding-conflict",
      conflicted: 1,
      registered: 0,
    });
    expect(readFileSync(log, "utf-8")).toBe(original);
  });

  // Covers: R9, R10
  it("rejects a replaced source before append and a short UTF-8 write as partial", async () => {
    const { log, child } = childFixture();
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(fs.openSync).mockImplementation((path, flags, mode) => {
      if (path === log) {
        renameSync(child, child + ".old");
        writeFileSync(child, readFileSync(child + ".old"), { mode: 0o600 });
      }
      return actual.openSync(path, flags, mode);
    });
    expect(captureCodexChild(repo, "root", "child", child).ok).toBe(false);
    expect(readChildSourceRegistrations(log, "root")).toHaveLength(0);
    vi.resetAllMocks();
    vi.mocked(fs.writeSync).mockReturnValue(1);
    expect(captureCodexChild(repo, "root", "child", child)).toMatchObject({
      ok: false,
      state: "partial",
      reason: "short-write",
      registered: 0,
    });
    expect(readChildSourceRegistrations(log, "root")).toHaveLength(0);
  });
});

function markSession(): string {
  const log = sessionLogPath(repoFromCwd(repo), "sess-1");
  mkdirSync(join(log, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(
    log,
    `${JSON.stringify({ event: "start", host: "claude", sessionId: "sess-1", cwd: repo })}\n`,
    { mode: 0o600 },
  );
  return log;
}

const OUTCOME = {
  schemaVersion: 1 as const,
  featureKey: "a".repeat(64),
  sidecar: "b".repeat(64),
  critical: 0,
  high: 1,
  medium: 0,
  low: 0,
  correlation: "correlated" as const,
  fp: "c".repeat(64),
  alg: "navori-content/v1",
};

describe("review-outcome events", () => {
  // Covers: R16
  it("appends a closed review-outcome record", () => {
    const log = markSession();
    expect(appendCliEvent(repo, { name: "review-outcome", verdict: "approved" }, OUTCOME)).toBe(
      true,
    );
    const line = readFileSync(log, "utf-8").trim().split("\n")[1] ?? "";
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(2048);
    expect(JSON.parse(line)).toMatchObject({
      event: "cli",
      name: "review-outcome",
      verdict: "approved",
      featureKey: "a".repeat(64),
      sidecar: "b".repeat(64),
    });
  });

  // Covers: R16
  it.each([
    ["an extra key", { ...OUTCOME, summary: "free text" }],
    ["an invalid hash", { ...OUTCOME, fp: "not-hex" }],
    ["a missing feature key", { ...OUTCOME, featureKey: undefined }],
    ["a negative count", { ...OUTCOME, high: -1 }],
    ["an unknown correlation", { ...OUTCOME, correlation: "accepted" }],
    ["a raw slug as the key", { ...OUTCOME, featureKey: "payroll-leak" }],
  ])("writes nothing for %s", (_label, outcome) => {
    const log = markSession();
    expect(
      appendCliEvent(
        repo,
        { name: "review-outcome", verdict: "approved" },
        outcome as unknown as typeof OUTCOME,
      ),
    ).toBe(false);
    expect(readFileSync(log, "utf-8").trim().split("\n")).toHaveLength(1);
  });

  // Covers: R16
  it("rejects an outcome under another name or an unknown verdict, and an oversized record", () => {
    markSession();
    expect(appendCliEvent(repo, { name: "plan-gate", verdict: "approved" }, OUTCOME)).toBe(false);
    expect(appendCliEvent(repo, { name: "review-outcome", verdict: "accepted" }, OUTCOME)).toBe(
      false,
    );
    expect(
      normalizeOutcome({ name: "review-outcome", verdict: "approved", ...OUTCOME }),
    ).not.toBeNull();
    expect(
      normalizeOutcome({
        name: "review-outcome",
        verdict: "approved",
        ...OUTCOME,
        startedAtMs: "x",
      }),
    ).toBeNull();
    expect(normalizeOutcome(null)).toBeNull();
    expect(normalizeOutcome([])).toBeNull();
    expect(
      normalizeOutcome({
        name: "review-outcome",
        verdict: "approved",
        ...OUTCOME,
        schemaVersion: 2,
      }),
    ).toBeNull();
  });

  // Covers: R16
  it("resolves whether an audit target exists without writing", () => {
    expect(hasAuditTarget(repo)).toBe(false);
    const log = markSession();
    expect(hasAuditTarget(repo)).toBe(true);
    delete process.env.CLAUDE_CODE_SESSION_ID;
    expect(hasAuditTarget(repo)).toBe(false);
    expect(readFileSync(log, "utf-8").trim().split("\n")).toHaveLength(1);
  });
});

const RECEIPT = {
  schemaVersion: 1 as const,
  featureKey: "a".repeat(64),
  action: "check" as const,
  freshness: "fresh" as const,
  consumed: 0 as const,
  uncovered: 0,
  drift: 0,
  base: "d".repeat(40),
  head: "e".repeat(40),
  gate: "1".repeat(64),
  inputs: "2".repeat(64),
  receipt: "3".repeat(64),
  identity: "stable" as const,
  alg: "navori-content/v1",
  fp: "c".repeat(64),
};

describe("receipt-outcome events", () => {
  // Covers: R16
  it("appends a closed receipt-outcome record within the size cap", () => {
    const log = markSession();
    expect(appendCliEvent(repo, { name: "receipt-outcome", verdict: "ok" }, RECEIPT)).toBe(true);
    const line = readFileSync(log, "utf-8").trim().split("\n")[1] ?? "";
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(2048);
    expect(JSON.parse(line)).toMatchObject({
      event: "cli",
      name: "receipt-outcome",
      verdict: "ok",
      action: "check",
      identity: "stable",
      fp: "c".repeat(64),
    });
  });

  // Covers: R16
  it.each([
    ["an extra key", { ...RECEIPT, message: "git failed: secret path" }],
    ["an unknown action", { ...RECEIPT, action: "publish" }],
    ["a raw slug as the key", { ...RECEIPT, featureKey: "payroll-leak" }],
    ["a bad receipt hash", { ...RECEIPT, receipt: "abc" }],
    ["a stale reason outside the enum", { ...RECEIPT, stale: "everything" }],
    ["a fractional count", { ...RECEIPT, drift: 1.5 }],
    ["consumed outside 0/1", { ...RECEIPT, consumed: 2 }],
    ["a fingerprint without a stable identity", { ...RECEIPT, identity: "unstable" }],
  ])("writes nothing for %s", (_label, outcome) => {
    const log = markSession();
    expect(
      appendCliEvent(
        repo,
        { name: "receipt-outcome", verdict: "ok" },
        outcome as unknown as typeof RECEIPT,
      ),
    ).toBe(false);
    expect(readFileSync(log, "utf-8").trim().split("\n")).toHaveLength(1);
  });

  // Covers: R16
  it("normalizes one error shape and refuses a verdict outside the receipt vocabulary", () => {
    const error = {
      name: "receipt-outcome",
      verdict: "error",
      schemaVersion: 1,
      featureKey: "a".repeat(64),
      action: "sign",
    };
    expect(normalizeOutcome(error)).toEqual(error);
    expect(normalizeOutcome({ ...error, verdict: "approved" })).toBeNull();
    // A review payload never validates as a receipt, and vice versa.
    expect(normalizeOutcome({ ...error, name: "review-outcome" })).toBeNull();
    markSession();
    expect(appendCliEvent(repo, { name: "review-outcome", verdict: "ok" }, RECEIPT)).toBe(false);
  });
});

describe("appendCliEvent", () => {
  // Covers: R55, R70
  it("appends one complete cli record to the session log", () => {
    const log = markSession();
    expect(appendCliEvent(repo, { name: "plan-gate", verdict: "block", reason: "stale" })).toBe(
      true,
    );
    const lines = readFileSync(log, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] ?? "")).toMatchObject({
      event: "cli",
      name: "plan-gate",
      verdict: "block",
      reason: "stale",
    });
    expect(typeof JSON.parse(lines[1] ?? "").tsMs).toBe("number");
  });

  // Covers: R55, R70
  it("omits reason when absent", () => {
    const log = markSession();
    appendCliEvent(repo, { name: "x", verdict: "allow" });
    expect("reason" in JSON.parse(readFileSync(log, "utf-8").trim().split("\n")[1] ?? "")).toBe(
      false,
    );
  });

  // Covers: R55
  it("writes nothing and does not throw without the session variable", () => {
    const log = markSession();
    delete process.env.CLAUDE_CODE_SESSION_ID;
    expect(appendCliEvent(repo, { name: "x", verdict: "allow" })).toBe(false);
    expect(readFileSync(log, "utf-8").trim().split("\n")).toHaveLength(1);
  });

  // Covers: R55
  it("writes nothing when the session has no log (audit-mode off)", () => {
    expect(appendCliEvent(repo, { name: "x", verdict: "allow" })).toBe(false);
  });

  // Covers: R55
  it("does not throw on an unsafe session id or a filesystem error", () => {
    process.env.CLAUDE_CODE_SESSION_ID = "../../evil";
    expect(appendCliEvent(repo, { name: "x", verdict: "allow" })).toBe(false);
    process.env.CLAUDE_CODE_SESSION_ID = "sess-1";
    // A directory where the log should be: exists, but append fails.
    const log = sessionLogPath(repoFromCwd(repo), "sess-1");
    mkdirSync(log, { recursive: true });
    expect(appendCliEvent(repo, { name: "x", verdict: "allow" })).toBe(false);
  });

  // Covers: R55
  it("does not follow a symlinked log out of the audit root", () => {
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "untouched\n");
    const log = sessionLogPath(repoFromCwd(repo), "sess-1");
    mkdirSync(join(log, ".."), { recursive: true, mode: 0o700 });
    symlinkSync(outside, log);
    expect(appendCliEvent(repo, { name: "x", verdict: "allow" })).toBe(false);
    expect(readFileSync(outside, "utf-8")).toBe("untouched\n");
  });

  // Covers: R55
  it("rejects an empty and an over-long session id without writing", () => {
    markSession();
    process.env.CLAUDE_CODE_SESSION_ID = "";
    expect(appendCliEvent(repo, { name: "x", verdict: "allow" })).toBe(false);
    process.env.CLAUDE_CODE_SESSION_ID = "a".repeat(5000);
    expect(appendCliEvent(repo, { name: "x", verdict: "allow" })).toBe(false);
  });

  // Covers: R9
  it("uses an exact explicit pair and rejects an incomplete or conflicting pair", () => {
    const log = markSession();
    process.env.NAVORI_AUDIT_HOST = "claude";
    expect(appendCliEvent(repo, { name: "x", verdict: "allow" })).toBe(false);
    process.env.NAVORI_AUDIT_SESSION_ID = "sess-1";
    expect(appendCliEvent(repo, { name: "x", verdict: "allow" })).toBe(true);
    process.env.NAVORI_AUDIT_SESSION_ID = "other";
    expect(appendCliEvent(repo, { name: "x", verdict: "allow" })).toBe(false);
    expect(readFileSync(log, "utf-8").trim().split("\n")).toHaveLength(2);
  });

  // Covers: R9
  it("does not correlate another checkout with the same repo basename", () => {
    markSession();
    const other = join(root, "other", "myrepo");
    mkdirSync(other, { recursive: true });
    expect(appendCliEvent(other, { name: "x", verdict: "allow" })).toBe(false);
  });

  // Covers: R9
  it.each([
    { field: "sessionId", value: "another-session" },
    { field: "repo", value: "another-repo" },
  ])("rejects a Claude marker with a contradictory $field", ({ field, value }) => {
    const log = markSession();
    writeFileSync(
      log,
      `${JSON.stringify({ event: "start", host: "claude", sessionId: "sess-1", cwd: repo, [field]: value })}\n`,
    );
    expect(appendCliEvent(repo, { name: "x", verdict: "allow" })).toBe(false);
    expect(readFileSync(log, "utf-8").trim().split("\n")).toHaveLength(1);
  });

  // Covers: R9
  it("rejects a symlinked repo audit directory without touching its target", () => {
    const log = markSession();
    const auditDir = join(root, "audits", "myrepo");
    const target = join(root, "audit-target");
    renameSync(auditDir, target);
    symlinkSync(target, auditDir);
    expect(appendCliEvent(repo, { name: "x", verdict: "allow" })).toBe(false);
    expect(
      readFileSync(join(target, basename(log)), "utf-8")
        .trim()
        .split("\n"),
    ).toHaveLength(1);
  });

  // Covers: R9
  it("correlates Codex only when the marker and rollout identity match", () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    process.env.NAVORI_AUDIT_HOST = "codex";
    process.env.NAVORI_AUDIT_SESSION_ID = "cx-1";
    process.env.CODEX_HOME = join(root, "codex-home");
    const log = sessionLogPath(repoFromCwd(repo), "cx-1");
    mkdirSync(join(log, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(
      log,
      `${JSON.stringify({ event: "start", host: "codex", sessionId: "cx-1", cwd: repo })}\n`,
      { mode: 0o600 },
    );
    const rollout = join(root, "rollout-cx-1.jsonl");
    writeFileSync(
      rollout,
      `${JSON.stringify({ type: "session_meta", payload: { id: "cx-1", cwd: repo } })}\n`,
    );
    writeFileSync(log, `${JSON.stringify({ event: "prompt", transcript: rollout })}\n`, {
      flag: "a",
    });
    expect(appendCliEvent(repo, { name: "x", verdict: "allow" })).toBe(true);
    process.env.CODEX_THREAD_ID = "another-thread";
    expect(appendCliEvent(repo, { name: "x", verdict: "allow" })).toBe(false);
    delete process.env.CODEX_THREAD_ID;
    writeFileSync(
      rollout,
      `${JSON.stringify({ type: "session_meta", payload: { id: "wrong", cwd: repo } })}\n`,
    );
    expect(appendCliEvent(repo, { name: "x", verdict: "allow" })).toBe(false);
    expect(readFileSync(log, "utf-8").trim().split("\n")).toHaveLength(3);
  });

  // Covers: R9
  it.each(["id", "cli_version"])("revalidates Codex %s before append", async (field) => {
    const { log } = childFixture();
    delete process.env.CLAUDE_CODE_SESSION_ID;
    process.env.NAVORI_AUDIT_HOST = "codex";
    process.env.NAVORI_AUDIT_SESSION_ID = "root";
    const header = JSON.parse(readFileSync(log, "utf-8")) as { transcript: string };
    const source = JSON.parse(readFileSync(header.transcript, "utf-8")) as {
      payload: Record<string, unknown>;
    };
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    let appendOpens = 0;
    vi.spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
      if (path === log && typeof flags === "number" && (flags & fs.constants.O_RDWR) !== 0) {
        appendOpens++;
        if (appendOpens === 2) {
          source.payload[field] = field === "id" ? "another-thread" : "0.161.0";
          writeFileSync(header.transcript, `${JSON.stringify(source)}\n`);
        }
      }
      return actual.openSync(path, flags, mode);
    });
    expect(appendCliEvent(repo, { name: "x", verdict: "allow" })).toBe(false);
    expect(appendOpens).toBe(2);
    expect(readFileSync(log, "utf-8").trim().split("\n")).toHaveLength(1);
  });
});

/** Synthetic scoped writer probes; no real host logs, HOME or services. */
describe("private metadata recorder and replay", () => {
  // Covers: R10, R11, R21
  it.each(["gate-started", "gate-killed"])(
    "persists the emitted %s witness through the private writer",
    (verdict) => {
      const log = markSession();
      expect(
        recordAuditMetadata(request({ ...hook(), verdict, toolUseId: "gate-1" })),
      ).toMatchObject({ status: "recorded", recorded: 1 });
      expect(events(log).at(-1)).toMatchObject({ verdict, toolUseId: "gate-1", wireVersion: 1 });
    },
  );

  // Covers: R10, R11, R21
  it.each(["master-advance", "master-part-accept", "master-close"])(
    "retains the fixed %s mechanism while hashing caller content",
    (name) => {
      const log = markSession();
      expect(appendCliEvent(repo, { name, verdict: "allow" })).toBe(true);
      expect(events(log).at(-1)?.name).toBe(name);
      const arbitrary = "master-private-user@example.test";
      expect(appendCliEvent(repo, { name: arbitrary, verdict: "allow" })).toBe(true);
      expect(events(log).at(-1)?.name).toMatch(/^unknown-[a-f0-9]{12}$/);
      expect(readFileSync(log, "utf-8")).not.toContain(arbitrary);
    },
  );

  function request(event: unknown): Parameters<typeof recordAuditMetadata>[0] {
    return {
      host: "claude",
      rootSessionId: "sess-1",
      repo: "myrepo",
      auditRoot: process.env.NAVORI_AUDITS_ROOT ?? "",
      event,
    };
  }
  function hook(): Record<string, unknown> {
    return {
      event: "hook",
      name: "guard-destructive",
      phase: "PreToolUse",
      verdict: "allow",
      source: "core",
      ms: 2,
      tsMs: 100,
      agentId: "orchestrator",
    };
  }
  function arm(): string {
    const dir = join(process.env.NAVORI_AUDITS_ROOT ?? "", "myrepo");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, ".armed"), JSON.stringify({ cwd: repo, ts: "2026-10-05T00:00:00Z" }), {
      mode: 0o600,
    });
    return join(dir, "pending-sess-1.jsonl");
  }
  function events(path: string): Array<Record<string, unknown>> {
    return readFileSync(path, "utf-8")
      .trim()
      .split("\n")
      .map((line: string) => JSON.parse(line) as Record<string, unknown>);
  }
  function spoolRecord(): { spool: string; record: Record<string, unknown> } {
    const spool = arm();
    expect(recordAuditMetadata(request({ ...hook(), phase: "SessionStart" }))).toMatchObject({
      status: "spooled",
      recorded: 1,
    });
    return { spool, record: events(spool)[0]! };
  }

  // Covers: R10, R11, R21
  it("writes private metadata with distinct original IDs, never raw human labels", () => {
    const log = markSession();
    const secret = "SECRET-user@example.test";
    const event = { ...hook(), name: secret, source: secret };
    expect(recordAuditMetadata(request(event))).toMatchObject({ status: "recorded", recorded: 1 });
    expect(recordAuditMetadata(request(event))).toMatchObject({ status: "recorded", recorded: 1 });
    const rows = events(log).slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.eventId).not.toBe(rows[1]?.eventId);
    expect(rows[0]).toMatchObject({
      wireVersion: 1,
      host: "claude",
      rootSessionId: "sess-1",
      source: "unknown",
    });
    expect(readFileSync(log, "utf-8")).not.toContain(secret);
    expect(fs.statSync(log).mode & 0o777).toBe(0o600);
  });

  // Covers: R10, R11
  it.each([
    { ...hook(), reason: "raw secret reason" },
    { event: "prompt", kind: "user", length: 7, tsMs: 100, prompt: "SECRET" },
    { event: "session-end", tsMs: 100, reason: "SECRET" },
    { ...hook(), eventId: "supplied-id" },
    { ...hook(), wireVersion: 1 },
    { ...hook(), ms: -1 },
    { ...hook(), agentId: "../outside" },
  ])("rejects nonallowlisted input before writing", (event: Record<string, unknown>) => {
    const log = markSession();
    const before = readFileSync(log);
    expect(recordAuditMetadata(request(event))).toMatchObject({ status: "invalid", recorded: 0 });
    expect(readFileSync(log)).toEqual(before);
  });

  // Covers: R10, R11
  it("requires the exact private repo arm for startup only, without creating root activation", () => {
    const spool = arm();
    expect(recordAuditMetadata(request(hook()))).toMatchObject({
      status: "skipped",
      reason: "unmarked",
    });
    expect(fs.existsSync(spool)).toBe(false);
    expect(recordAuditMetadata(request({ ...hook(), phase: "SessionStart" }))).toMatchObject({
      status: "spooled",
      recorded: 1,
    });
    expect(fs.statSync(spool).mode & 0o777).toBe(0o600);
    expect(fs.statSync(join(spool, "..")).mode & 0o777).toBe(0o700);
    expect(fs.existsSync(sessionLogPath("myrepo", "sess-1"))).toBe(false);
    const armPath = join(spool, "..", ".armed");
    chmodSync(armPath, 0o644);
    const before = readFileSync(spool);
    expect(recordAuditMetadata(request({ ...hook(), phase: "SessionStart" })).recorded).toBe(0);
    expect(readFileSync(spool)).toEqual(before);
    expect(fs.statSync(armPath).mode & 0o777).toBe(0o644);
  });

  // Covers: R10, R11
  it("refuses unsafe markers and wrong repo arms unchanged", () => {
    const log = markSession();
    const before = readFileSync(log);
    chmodSync(log, 0o644);
    expect(recordAuditMetadata(request(hook()))).toMatchObject({
      status: "unavailable",
      recorded: 0,
    });
    expect(readFileSync(log)).toEqual(before);
    expect(fs.statSync(log).mode & 0o777).toBe(0o644);
    rmSync(log);
    const spool = arm();
    writeFileSync(join(spool, "..", ".armed"), JSON.stringify({ cwd: join(root, "other-repo") }));
    expect(recordAuditMetadata(request({ ...hook(), phase: "SessionStart" }))).toMatchObject({
      status: "invalid",
      reason: "identity-conflict",
    });
    expect(fs.existsSync(spool)).toBe(false);
  });

  // Covers: R10, R11, R21
  it("replays original IDs once, including reordered identical copies", () => {
    const { spool, record } = spoolRecord();
    const reordered = Object.fromEntries(Object.entries(record).reverse());
    appendFileSync(spool, JSON.stringify(reordered) + "\n");
    const saved = readFileSync(spool);
    const log = markSession();
    const options = request(undefined);
    expect(absorbAuditMetadataSpool(options)).toMatchObject({
      status: "recorded",
      recorded: 1,
      fullyAbsorbed: true,
    });
    expect(fs.existsSync(spool)).toBe(false);
    expect(events(log).filter((row) => row.eventId === record.eventId)).toHaveLength(1);
    writeFileSync(spool, saved, { mode: 0o600 });
    expect(absorbAuditMetadataSpool(options)).toMatchObject({
      status: "skipped",
      recorded: 0,
      skipped: 1,
      fullyAbsorbed: true,
    });
    expect(events(log).filter((row) => row.eventId === record.eventId)).toHaveLength(1);
  });

  // Covers: R10, R11, R21
  it.each([false, true])(
    "rejects every same-ID conflicting variant independent of order (%s)",
    (reverse: boolean) => {
      const { spool, record } = spoolRecord();
      const copies = [record, { ...record, verdict: "block" }];
      if (reverse) copies.reverse();
      writeFileSync(spool, copies.map((row) => JSON.stringify(row)).join("\n") + "\n");
      const before = readFileSync(spool);
      const log = markSession();
      const original = readFileSync(log);
      expect(absorbAuditMetadataSpool(request(undefined))).toMatchObject({
        status: "invalid",
        reason: "identity-conflict",
        conflicted: 1,
        fullyAbsorbed: false,
      });
      expect(readFileSync(spool)).toEqual(before);
      expect(readFileSync(log)).toEqual(original);
    },
  );

  // Covers: R10, R11, R21
  it("rejects a conflict against root history before appending any spool row", () => {
    const { spool, record } = spoolRecord();
    const log = markSession();
    appendFileSync(log, JSON.stringify({ ...record, verdict: "block" }) + "\n");
    const before = readFileSync(log);
    expect(absorbAuditMetadataSpool(request(undefined))).toMatchObject({
      status: "invalid",
      reason: "identity-conflict",
      fullyAbsorbed: false,
    });
    expect(readFileSync(log)).toEqual(before);
    expect(fs.existsSync(spool)).toBe(true);
  });

  // Covers: R10, R11, R21
  it.each(["legacy", "malformed", "tail"])(
    "retains %s spool without inventing IDs or repairing bytes",
    (invalid: string) => {
      const { spool, record } = spoolRecord();
      const text =
        invalid === "legacy"
          ? JSON.stringify({ event: "hook", name: "old" }) + "\n"
          : invalid === "malformed"
            ? "{bad-json}\n"
            : JSON.stringify(record);
      writeFileSync(spool, text);
      const log = markSession();
      const before = readFileSync(log);
      expect(absorbAuditMetadataSpool(request(undefined))).toMatchObject({
        status: "partial",
        fullyAbsorbed: false,
      });
      expect(readFileSync(spool, "utf-8")).toBe(text);
      expect(readFileSync(log)).toEqual(before);
    },
  );

  // Covers: R10, R11, R21
  it("retains a capped spool instead of deleting unread records", () => {
    const { spool, record } = spoolRecord();
    const line = JSON.stringify(record) + "\n";
    writeFileSync(spool, line.repeat(100_001));
    const log = markSession();
    const before = readFileSync(log);
    const size = fs.statSync(spool).size;
    expect(absorbAuditMetadataSpool(request(undefined))).toMatchObject({
      status: "partial",
      fullyAbsorbed: false,
      recorded: 0,
    });
    expect(fs.statSync(spool).size).toBe(size);
    expect(readFileSync(log)).toEqual(before);
  });

  // Covers: R10, R11, R21
  it("performs direct metadata lookup without enumerating sibling markers", () => {
    markSession();
    vi.mocked(fs.readdirSync).mockImplementation(() => {
      throw new Error("unexpected directory enumeration");
    });
    vi.mocked(fs.opendirSync).mockImplementation(() => {
      throw new Error("unexpected directory enumeration");
    });
    expect(recordAuditMetadata(request(hook()))).toMatchObject({ status: "recorded", recorded: 1 });
    expect(fs.readdirSync).not.toHaveBeenCalled();
    expect(fs.opendirSync).not.toHaveBeenCalled();
  });

  // Covers: R10, R11, R21
  it("retains a replaced spool rather than deleting an unabsorbed object", async () => {
    const { spool } = spoolRecord();
    markSession();
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(fs.writeSync).mockImplementationOnce((fd: number, data: unknown): number => {
      if (!(data instanceof Uint8Array)) throw new Error("unexpected write representation");
      renameSync(spool, spool + ".original");
      writeFileSync(spool, "replacement sentinel\n", { mode: 0o600 });
      return actual.writeSync(fd, data);
    });
    expect(absorbAuditMetadataSpool(request(undefined))).toMatchObject({
      status: "partial",
      fullyAbsorbed: false,
      recorded: 1,
    });
    expect(readFileSync(spool, "utf-8")).toBe("replacement sentinel\n");
    expect(fs.existsSync(spool + ".original")).toBe(true);
  });

  // Covers: R10, R11, R21
  it("preserves a partial appended suffix and its spool without newline repair", async () => {
    const { spool } = spoolRecord();
    const log = markSession();
    const before = readFileSync(log);
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(fs.writeSync).mockImplementation((fd: number, data: unknown): number => {
      if (!(data instanceof Uint8Array)) throw new Error("unexpected write representation");
      return actual.writeSync(fd, data.subarray(0, data.byteLength - 1));
    });
    expect(absorbAuditMetadataSpool(request(undefined))).toMatchObject({
      status: "partial",
      reason: "short-write",
      recorded: 0,
      fullyAbsorbed: false,
    });
    expect(fs.existsSync(spool)).toBe(true);
    const partial = readFileSync(log);
    expect(partial.subarray(0, before.length)).toEqual(before);
    expect(partial.length).toBeGreaterThan(before.length);
    vi.resetAllMocks();
    expect(absorbAuditMetadataSpool(request(undefined)).fullyAbsorbed).toBe(false);
    expect(readFileSync(log)).toEqual(partial);
  });
});
