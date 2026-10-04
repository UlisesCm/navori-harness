import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { appendCliEvent } from "../cli-event.ts";
import { sessionLogPath, repoFromCwd } from "../paths.ts";

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
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

function markSession(): string {
  const log = sessionLogPath(repoFromCwd(repo), "sess-1");
  mkdirSync(join(log, ".."), { recursive: true });
  writeFileSync(
    log,
    `${JSON.stringify({ event: "start", host: "claude", sessionId: "sess-1", cwd: repo })}\n`,
  );
  return log;
}

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
    mkdirSync(join(log, ".."), { recursive: true });
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
    mkdirSync(join(log, ".."), { recursive: true });
    writeFileSync(
      log,
      `${JSON.stringify({ event: "start", host: "codex", sessionId: "cx-1", cwd: repo })}\n`,
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
});
