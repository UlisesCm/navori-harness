import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentIdentity, type ContentIdentity } from "../content-identity.ts";

const workspaces: string[] = [];
afterEach(() =>
  workspaces.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })),
);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture(): string {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "navori-content-")));
  workspaces.push(cwd);
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
  writeFileSync(join(cwd, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(cwd, "a.txt"), "a\n");
  writeFileSync(join(cwd, "b.txt"), "b\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "base");
  return cwd;
}

function ok(identity: ContentIdentity): Extract<ContentIdentity, { ok: true }> {
  if (!identity.ok) throw new Error(`identity failed: ${identity.reason}`);
  return identity;
}

describe("contentIdentity", () => {
  // Covers: R16
  it("is deterministic and tags the algorithm", () => {
    const cwd = fixture();
    const first = ok(contentIdentity(cwd));
    expect(first.alg).toBe("navori-content/v1");
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(ok(contentIdentity(cwd)).fingerprint).toBe(first.fingerprint);
    expect(first.head).toBe(git(cwd, "rev-parse", "HEAD"));
  });

  // Covers: R16
  it("changes with edited content and includes untracked but not ignored files", () => {
    const cwd = fixture();
    const clean = ok(contentIdentity(cwd)).fingerprint;
    writeFileSync(join(cwd, "ignored.txt"), "x\n");
    expect(ok(contentIdentity(cwd)).fingerprint).toBe(clean);
    writeFileSync(join(cwd, "new.txt"), "n\n");
    const untracked = ok(contentIdentity(cwd)).fingerprint;
    expect(untracked).not.toBe(clean);
    writeFileSync(join(cwd, "a.txt"), "changed\n");
    expect(ok(contentIdentity(cwd)).fingerprint).not.toBe(untracked);
  });

  // Covers: R16
  it("excludes state and progress directories from the hash", () => {
    const cwd = fixture();
    const clean = ok(contentIdentity(cwd)).fingerprint;
    for (const dir of [".navori/state/handoffs", ".claude/progress", "progress"]) {
      mkdirSync(join(cwd, dir), { recursive: true });
      writeFileSync(join(cwd, dir, "note.json"), "{}\n");
    }
    expect(ok(contentIdentity(cwd)).fingerprint).toBe(clean);
  });

  // Covers: R16
  it("hashes the working tree only: staging does not change the fingerprint but flags divergence", () => {
    const cwd = fixture();
    writeFileSync(join(cwd, "a.txt"), "edited\n");
    const unstaged = ok(contentIdentity(cwd));
    expect(unstaged.indexDiverges).toBe(false);
    git(cwd, "add", "a.txt");
    const staged = ok(contentIdentity(cwd));
    expect(staged.fingerprint).toBe(unstaged.fingerprint);
    expect(staged.indexDiverges).toBe(false);
    writeFileSync(join(cwd, "a.txt"), "edited again\n");
    const partial = ok(contentIdentity(cwd));
    expect(partial.fingerprint).not.toBe(staged.fingerprint);
    expect(partial.indexDiverges).toBe(true);
  });

  // Covers: R16
  it("reports an unmerged index as unavailable", () => {
    const cwd = fixture();
    git(cwd, "checkout", "-b", "side");
    writeFileSync(join(cwd, "a.txt"), "side\n");
    git(cwd, "commit", "-am", "side");
    git(cwd, "checkout", "main");
    writeFileSync(join(cwd, "a.txt"), "main\n");
    git(cwd, "commit", "-am", "main");
    expect(() => git(cwd, "merge", "side")).toThrow();
    expect(contentIdentity(cwd)).toEqual({ ok: false, reason: "unmerged-index" });
  });

  // Covers: R16
  it.each([
    ["newline", "bad\nname.txt"],
    ["carriage return", "bad\rname.txt"],
  ])("rejects a path containing a %s", (_label, name) => {
    const cwd = fixture();
    writeFileSync(join(cwd, name), "x\n");
    expect(contentIdentity(cwd)).toEqual({ ok: false, reason: "unsafe-path" });
  });

  // Covers: R16
  it("hashes quoted and odd filenames by their own bytes", () => {
    const cwd = fixture();
    writeFileSync(join(cwd, '"a"'), "one\n");
    writeFileSync(join(cwd, '"q'), "two\n");
    writeFileSync(join(cwd, "sp ace.txt"), "three\n");
    const first = ok(contentIdentity(cwd)).fingerprint;
    writeFileSync(join(cwd, '"a"'), "edited\n");
    expect(ok(contentIdentity(cwd)).fingerprint).not.toBe(first);
  });

  // Covers: R16
  it("hashes a symlink's target text without following it", () => {
    const cwd = fixture();
    const outside = join(cwd, "..", `outside-${Date.now()}.txt`);
    writeFileSync(outside, "secret\n");
    workspaces.push(outside);
    symlinkSync(outside, join(cwd, "link"));
    const first = ok(contentIdentity(cwd)).fingerprint;
    writeFileSync(outside, "changed secret\n");
    expect(ok(contentIdentity(cwd)).fingerprint).toBe(first);
  });

  // Covers: R16
  it("tracks the executable bit", () => {
    const cwd = fixture();
    const before = ok(contentIdentity(cwd)).fingerprint;
    chmodSync(join(cwd, "a.txt"), 0o755);
    expect(ok(contentIdentity(cwd)).fingerprint).not.toBe(before);
  });

  // Covers: R16
  it("writes no git objects and never touches the index", () => {
    const cwd = fixture();
    writeFileSync(join(cwd, "new.txt"), "n\n");
    const objects = git(cwd, "count-objects", "-v");
    const indexMtime = statSync(join(cwd, ".git", "index")).mtimeMs;
    ok(contentIdentity(cwd));
    expect(git(cwd, "count-objects", "-v")).toBe(objects);
    expect(statSync(join(cwd, ".git", "index")).mtimeMs).toBe(indexMtime);
  });

  // Covers: R16
  it("records the local origin/<target> ref as base without fetching", () => {
    const cwd = fixture();
    expect(ok(contentIdentity(cwd, { target: "main" })).base).toBeNull();
    git(cwd, "update-ref", "refs/remotes/origin/main", "HEAD");
    expect(ok(contentIdentity(cwd, { target: "main" })).base).toBe(git(cwd, "rev-parse", "HEAD"));
  });

  // Covers: R16
  it("is unavailable, never partial, past the byte budget or the timeout, and outside a checkout", () => {
    const cwd = fixture();
    expect(contentIdentity(cwd, { maxBytes: 1 })).toEqual({ ok: false, reason: "too-large" });
    expect(contentIdentity(cwd, { timeoutMs: -1 })).toEqual({ ok: false, reason: "timeout" });
    const bare = realpathSync(mkdtempSync(join(tmpdir(), "navori-content-none-")));
    workspaces.push(bare);
    expect(contentIdentity(bare).ok).toBe(false);
  });
});
