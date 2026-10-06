import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkReceipt, formatReceipt, signReceipt, type ReceiptOptions } from "../receipt.ts";
import { executeReceipt, resolveReceiptOptions } from "../../../commands/receipt.ts";
import { repoFromCwd, sessionLogPath } from "../../audit/paths.ts";
import { contentIdentity, type ContentIdentity } from "../../primitives/content-identity.ts";
import { emitReceiptOutcome, receiptOutcomeOf, type ReceiptObserver } from "../receipt.ts";

// Pass-through spies: the receipt-outcome tests count identity computations and git calls.
vi.mock("../../primitives/content-identity.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../primitives/content-identity.ts")>();
  return { ...actual, contentIdentity: vi.fn(actual.contentIdentity) };
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

const workspaces: string[] = [];
afterEach(() =>
  workspaces.splice(0).forEach((path) => rmSync(path, { force: true, recursive: true })),
);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
function fixture(): ReceiptOptions {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "navori-receipt-")));
  workspaces.push(root);
  const remote = join(root, "remote.git");
  const cwd = join(root, "repo");
  git(root, "init", "--bare", "-b", "main", remote);
  mkdirSync(cwd);
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
  writeFileSync(join(cwd, "base.txt"), "base\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "base");
  git(cwd, "remote", "add", "origin", remote);
  git(cwd, "push", "-u", "origin", "main");
  return {
    cwd,
    feature: "receipt-test",
    target: "main",
    dir: ".claude/progress",
    gate: "quality-gate-full",
  };
}

describe("sign", () => {
  // Covers: R1
  it("defaults target to prTarget and then branchBase", () => {
    const options = fixture();
    writeFileSync(
      join(options.cwd, "navori.config.json"),
      JSON.stringify({
        name: "test",
        version: "1",
        preset: "node",
        engines: ["claude"],
        branchBase: "fork-base",
        prTarget: "pr-base",
      }),
    );
    expect(resolveReceiptOptions({ cwd: options.cwd, feature: "x" }).target).toBe("pr-base");
    writeFileSync(
      join(options.cwd, "navori.config.json"),
      JSON.stringify({
        name: "test",
        version: "1",
        preset: "node",
        engines: ["claude"],
        branchBase: "fork-base",
      }),
    );
    expect(resolveReceiptOptions({ cwd: options.cwd, feature: "x" }).target).toBe("fork-base");
  });
  // Covers: R1, R3, R4
  it("signs new, deleted and untracked files while excluding progress", () => {
    const options = fixture();
    writeFileSync(join(options.cwd, "new file.ts"), "new\n");
    writeFileSync(join(options.cwd, "untracked.ts"), "u\n");
    writeFileSync(join(options.cwd, "base.txt"), "changed\n");
    mkdirSync(join(options.cwd, ".claude/progress"), { recursive: true });
    writeFileSync(join(options.cwd, ".claude/progress", "impl.md"), "ignored\n");
    const signed = signReceipt(options);
    expect(signed.exitCode).toBe(0);
    expect(signed.result.status).toBe("ok");
    const receipt = readFileSync(join(options.cwd, options.dir, "receipt.txt"), "utf8");
    expect(receipt).toContain("new file.ts");
    expect(receipt).toContain("untracked.ts");
    expect(receipt).not.toContain("impl.md");
  });

  // Covers: R6
  it("rejects a preexisting receipt temp symlink without writing outside the checkout", () => {
    const options = fixture();
    writeFileSync(join(options.cwd, "base.txt"), "reviewed\n");
    const external = mkdtempSync(join(tmpdir(), "navori-receipt-external-"));
    workspaces.push(external);
    const outside = join(external, "outside.txt");
    writeFileSync(outside, "unchanged\n");
    const temporary = join(options.cwd, options.dir, `receipt.txt.tmp-${process.pid}`);
    mkdirSync(join(options.cwd, options.dir), { recursive: true });
    symlinkSync(outside, temporary);
    const signed = signReceipt(options);
    expect(signed.exitCode).toBe(1);
    expect(signed.result.error).toContain("escapes checkout");
    expect(readFileSync(outside, "utf8")).toBe("unchanged\n");
  });

  // Covers: R1, R3
  it("rejects a symlink without replacing the prior receipt", () => {
    const options = fixture();
    writeFileSync(join(options.cwd, "base.txt"), "reviewed\n");
    expect(signReceipt(options).exitCode).toBe(0);
    const before = readFileSync(join(options.cwd, options.dir, "receipt.txt"), "utf8");
    git(options.cwd, "rm", "-f", "base.txt");
    writeFileSync(join(options.cwd, "target.txt"), "target\n");
    git(options.cwd, "add", "target.txt");
    git(options.cwd, "commit", "-m", "remove base");
    // Symlink lstat must reject instead of following the target.
    execFileSync("ln", ["-s", "target.txt", join(options.cwd, "link.txt")]);
    const signed = signReceipt(options);
    expect(signed.exitCode).toBe(1);
    expect(signed.result.status).toBe("error");
    expect(readFileSync(join(options.cwd, options.dir, "receipt.txt"), "utf8")).toBe(before);
  });

  // Covers: R1, R3, R4
  it("rejects newline paths and an out-of-date branch without mutating a receipt", () => {
    const options = fixture();
    writeFileSync(join(options.cwd, "base.txt"), "reviewed\n");
    expect(signReceipt(options).exitCode).toBe(0);
    const before = readFileSync(join(options.cwd, options.dir, "receipt.txt"), "utf8");
    writeFileSync(join(options.cwd, "line\nbreak.ts"), "bad\n");
    expect(signReceipt(options).exitCode).toBe(1);
    expect(readFileSync(join(options.cwd, options.dir, "receipt.txt"), "utf8")).toBe(before);
  });

  // Covers: R1, R3
  it("rejects mode-only changes without reporting findings", () => {
    const options = fixture();
    writeFileSync(join(options.cwd, "base.txt"), "same\n");
    git(options.cwd, "add", "base.txt");
    git(options.cwd, "commit", "-m", "content");
    git(options.cwd, "push", "origin", "main");
    execFileSync("chmod", ["+x", join(options.cwd, "base.txt")]);
    git(options.cwd, "update-index", "--chmod=+x", "base.txt");
    const result = signReceipt(options);
    expect(result.exitCode).toBe(1);
    expect(result.result.status).toBe("error");
  });

  // Covers: #1038
  it("signs a new committed file that also has unstaged changes", () => {
    const options = fixture();
    writeFileSync(join(options.cwd, "b.ts"), "b\n");
    git(options.cwd, "add", "b.ts");
    git(options.cwd, "commit", "-m", "add b");
    writeFileSync(join(options.cwd, "b.ts"), "b\nb2\n");
    const signed = signReceipt(options);
    expect(signed.exitCode).toBe(0);
    expect(signed.result.status).toBe("ok");
  });

  // Covers: #1038
  it("still rejects a staged chmod with no content change on a file that exists in origin", () => {
    const options = fixture();
    writeFileSync(join(options.cwd, "base.txt"), "same\n");
    git(options.cwd, "add", "base.txt");
    git(options.cwd, "commit", "-m", "content");
    git(options.cwd, "push", "origin", "main");
    execFileSync("chmod", ["+x", join(options.cwd, "base.txt")]);
    git(options.cwd, "update-index", "--chmod=+x", "base.txt");
    const result = signReceipt(options);
    expect(result.exitCode).toBe(1);
    expect(result.result.status).toBe("error");
  });

  // Covers: R1, R3
  it("keeps UTF-8 and space paths, and records a tracked deletion", () => {
    const options = fixture();
    writeFileSync(join(options.cwd, "with space.ts"), "x\n");
    writeFileSync(join(options.cwd, "café.ts"), "x\n");
    git(options.cwd, "rm", "base.txt");
    expect(signReceipt(options).exitCode).toBe(0);
    const receipt = readFileSync(join(options.cwd, options.dir, "receipt.txt"), "utf8");
    expect(receipt).toContain("with space.ts");
    expect(receipt).toContain("café.ts");
    expect(receipt).toContain("deleted  base.txt");
  });

  // Covers: R1, R3
  it("rejects a broken symlink and a regular-to-symlink replacement", () => {
    const options = fixture();
    execFileSync("ln", ["-s", "missing-target", join(options.cwd, "broken")]);
    expect(signReceipt(options).exitCode).toBe(1);
    execFileSync("rm", [join(options.cwd, "base.txt")]);
    execFileSync("ln", ["-s", "missing-target", join(options.cwd, "base.txt")]);
    expect(signReceipt(options).exitCode).toBe(1);
  });

  // Covers: R3
  it("returns ERROR when git is absent", () => {
    const options = fixture();
    const path = process.env.PATH;
    try {
      process.env.PATH = "";
      expect(signReceipt(options).exitCode).toBe(1);
    } finally {
      process.env.PATH = path;
    }
  });

  // Covers: R4
  it("refuses to sign when origin target advanced and preserves no receipt", () => {
    const options = fixture();
    const peer = join(options.cwd, "..", "peer");
    git(options.cwd, "clone", git(options.cwd, "remote", "get-url", "origin"), peer);
    git(peer, "config", "user.email", "test@example.com");
    git(peer, "config", "user.name", "Test");
    writeFileSync(join(peer, "ahead.txt"), "ahead\n");
    git(peer, "add", ".");
    git(peer, "commit", "-m", "ahead");
    git(peer, "push", "origin", "main");
    expect(signReceipt(options).exitCode).toBe(1);
  });

  // Covers: R1
  it("ignores a configured external diff driver", () => {
    const options = fixture();
    writeFileSync(join(options.cwd, "base.txt"), "changed\n");
    git(options.cwd, "config", "diff.external", "false");
    expect(signReceipt(options).exitCode).toBe(0);
  });

  // Covers: R1, R3
  it("rejects a gitlink without treating it as a deletion", () => {
    const options = fixture();
    const commit = git(options.cwd, "rev-parse", "HEAD");
    git(options.cwd, "update-index", "--add", "--cacheinfo", `160000,${commit},nested`);
    const result = signReceipt(options);
    expect(result.exitCode).toBe(1);
    expect(result.result.status).toBe("error");
  });
});

describe("sign and check json", () => {
  // Covers: R2, R3, R5
  it("returns the shared JSON schema for check success, findings and early error", () => {
    const options = fixture();
    const absent = checkReceipt(options);
    expect(absent.exitCode).toBe(1);
    expect(absent.result).toMatchObject({
      formatVersion: 1,
      status: "error",
      targetSha: null,
      headSha: null,
      error: expect.any(String),
    });
    expect(signReceipt(options).exitCode).toBe(0);
    expect(checkReceipt(options)).toMatchObject({
      exitCode: 0,
      result: { status: "ok", formatVersion: 1, uncovered: [], drift: [] },
    });
    writeFileSync(join(options.cwd, "outside.ts"), "uncovered\n");
    expect(checkReceipt(options)).toMatchObject({
      exitCode: 2,
      result: { status: "findings", uncovered: ["outside.ts"] },
    });
  });
});

describe("check", () => {
  // Covers: R2, R3, R5
  it("reports changed bytes as findings and retains the approved blob", () => {
    const options = fixture();
    writeFileSync(join(options.cwd, "base.txt"), "reviewed\n");
    expect(signReceipt(options).exitCode).toBe(0);
    writeFileSync(join(options.cwd, "base.txt"), "changed later\n");
    const checked = checkReceipt(options);
    expect(checked.exitCode).toBe(2);
    expect(checked.result.status).toBe("findings");
    expect(checked.result.drift).toEqual([
      expect.objectContaining({ path: "base.txt", kind: "changed", blob: expect.any(String) }),
    ]);
  });

  // Covers: R2, R3, R5
  it("classifies changed, missing and reappeared receipt entries", () => {
    const options = fixture();
    writeFileSync(join(options.cwd, "base.txt"), "signed\n");
    expect(signReceipt(options).exitCode).toBe(0);
    writeFileSync(join(options.cwd, "base.txt"), "changed\n");
    expect(checkReceipt(options).result.drift).toEqual([
      expect.objectContaining({ path: "base.txt", kind: "changed" }),
    ]);
    execFileSync("rm", [join(options.cwd, "base.txt")]);
    expect(checkReceipt(options).result.drift).toEqual([
      expect.objectContaining({ path: "base.txt", kind: "missing" }),
    ]);
    git(options.cwd, "rm", "--cached", "base.txt");
    expect(signReceipt(options).exitCode).toBe(0);
    writeFileSync(join(options.cwd, "base.txt"), "back\n");
    expect(checkReceipt(options).result.drift).toEqual([
      expect.objectContaining({ path: "base.txt", kind: "reappeared" }),
    ]);
  });

  // Covers: R2, R3, R5
  it("keeps errors separate from drift and prints the inspection command", () => {
    const options = fixture();
    const absent = checkReceipt(options);
    expect(absent.exitCode).toBe(1);
    expect(absent.result.drift).toEqual([]);
    writeFileSync(join(options.cwd, "base.txt"), "signed\n");
    expect(signReceipt(options).exitCode).toBe(0);
    writeFileSync(join(options.cwd, "base.txt"), "changed\n");
    const drift = checkReceipt(options);
    expect(formatReceipt(drift.result)).toContain(
      `git diff ${drift.result.drift[0]!.blob} base.txt`,
    );
    execFileSync("chmod", ["+x", join(options.cwd, "base.txt")]);
    const mode = checkReceipt(options);
    expect(mode.exitCode).toBe(2);
    expect(mode.result.status).toBe("findings");
  });
});

describe("receipt v2 evidence identity", () => {
  // Covers: R5, R7
  it("stays fresh when origin/target advances but the diffed files don't change", () => {
    const options = fixture();
    writeFileSync(join(options.cwd, "base.txt"), "reviewed\n");
    expect(signReceipt(options).exitCode).toBe(0);
    // A rebase onto a new base with no unique local commits is a fast-forward:
    // the tree it verified (the diffed files) doesn't change, only `base` does.
    const peer = join(options.cwd, "..", "peer-rebase");
    git(options.cwd, "clone", git(options.cwd, "remote", "get-url", "origin"), peer);
    git(peer, "config", "user.email", "test@example.com");
    git(peer, "config", "user.name", "Test");
    writeFileSync(join(peer, "unrelated.txt"), "unrelated\n");
    git(peer, "add", ".");
    git(peer, "commit", "-m", "advance base");
    git(peer, "push", "origin", "main");
    git(options.cwd, "fetch", "origin", "main");
    git(options.cwd, "merge", "--ff-only", "origin/main");
    const checked = checkReceipt(options);
    expect(checked.result.fresh).toBe(true);
    expect(checked.result.stale).toEqual([]);
    expect(checked.result.status).toBe("ok");
  });

  // Covers: R5, R7
  it("marks gate stale when the configured gate command changes, without failing status", () => {
    const options = fixture();
    writeFileSync(join(options.cwd, "base.txt"), "reviewed\n");
    expect(signReceipt(options).exitCode).toBe(0);
    const checked = checkReceipt({ ...options, gate: "a different gate command" });
    expect(checked.result.stale).toEqual(["gate"]);
    expect(checked.result.fresh).toBe(false);
    expect(checked.result.status).toBe("ok");
    expect(checked.exitCode).toBe(0);
  });

  // Covers: R5, R7
  it("marks inputs stale when a declared lockfile's content changes outside the diff", () => {
    const options = fixture();
    writeFileSync(join(options.cwd, "package-lock.json"), "{}\n");
    git(options.cwd, "add", "package-lock.json");
    git(options.cwd, "commit", "-m", "add lockfile");
    git(options.cwd, "push", "origin", "main");
    writeFileSync(join(options.cwd, "base.txt"), "reviewed\n");
    expect(signReceipt(options).exitCode).toBe(0);
    // A peer bumps the lockfile on the base; a fast-forward merge here keeps
    // package-lock.json OUT of the diff against origin/main (both match) while
    // its bytes on disk — the gate INPUT — are no longer what was signed.
    const peer = join(options.cwd, "..", "peer-lockfile");
    git(options.cwd, "clone", git(options.cwd, "remote", "get-url", "origin"), peer);
    git(peer, "config", "user.email", "test@example.com");
    git(peer, "config", "user.name", "Test");
    writeFileSync(join(peer, "package-lock.json"), '{"changed":true}\n');
    git(peer, "add", "package-lock.json");
    git(peer, "commit", "-m", "bump lockfile");
    git(peer, "push", "origin", "main");
    git(options.cwd, "fetch", "origin", "main");
    git(options.cwd, "merge", "--ff-only", "origin/main");
    const checked = checkReceipt(options);
    expect(checked.result.stale).toEqual(["inputs"]);
    expect(checked.result.status).toBe("ok");
    expect(checked.exitCode).toBe(0);
  });

  // Covers: R5, R7
  it("treats a v1 header as stale format without failing status or exit code", () => {
    const options = fixture();
    writeFileSync(join(options.cwd, "base.txt"), "reviewed\n");
    expect(signReceipt(options).exitCode).toBe(0);
    const receiptFile = join(options.cwd, options.dir, "receipt.txt");
    const body = readFileSync(receiptFile, "utf8").split("\n").slice(1).join("\n");
    writeFileSync(receiptFile, `# navori-receipt v1 feature=${options.feature}\n${body}`);
    const checked = checkReceipt(options);
    expect(checked.result.stale).toEqual(["format"]);
    expect(checked.result.fresh).toBe(false);
    expect(checked.result.status).toBe("ok");
    expect(checked.exitCode).toBe(0);
  });

  // Covers: R6
  it("rejects symlinked active and consumed receipts before reading outside the checkout", () => {
    const options = fixture();
    const external = mkdtempSync(join(tmpdir(), "navori-receipt-external-"));
    workspaces.push(external);
    const outside = join(external, "receipt.txt");
    writeFileSync(outside, "outside receipt\n");
    mkdirSync(join(options.cwd, options.dir), { recursive: true });
    symlinkSync(outside, join(options.cwd, options.dir, "receipt.txt"));
    const active = checkReceipt(options);
    expect(active.exitCode).toBe(1);
    expect(active.result.error).toContain("escapes checkout");
    rmSync(join(options.cwd, options.dir, "receipt.txt"));
    symlinkSync(outside, join(options.cwd, options.dir, "receipt.consumed.txt"));
    const consumed = checkReceipt({ ...options, includeConsumed: true });
    expect(consumed.exitCode).toBe(1);
    expect(consumed.result.error).toContain("escapes checkout");
    expect(readFileSync(outside, "utf8")).toBe("outside receipt\n");
  });

  // Covers: R5
  it("rejects an active receipt for a different feature even with explicit --dir", () => {
    const options = fixture();
    writeFileSync(join(options.cwd, "base.txt"), "reviewed\n");
    expect(signReceipt(options).exitCode).toBe(0);
    const receiptFile = join(options.cwd, options.dir, "receipt.txt");
    const content = readFileSync(receiptFile, "utf8").replace(
      `feature=${options.feature}`,
      "feature=other",
    );
    writeFileSync(receiptFile, content);
    const checked = checkReceipt({ ...options, dir: ".claude/progress" });
    expect(checked.exitCode).toBe(1);
    expect(checked.result.error).toContain('belongs to feature "other"');
  });

  // Covers: R5
  it("rejects a consumed receipt for a different feature even with explicit --dir", () => {
    const options = fixture();
    writeFileSync(join(options.cwd, "base.txt"), "reviewed\n");
    expect(signReceipt(options).exitCode).toBe(0);
    const receiptFile = join(options.cwd, options.dir, "receipt.txt");
    const consumedFile = join(options.cwd, options.dir, "receipt.consumed.txt");
    renameSync(receiptFile, consumedFile);
    const content = readFileSync(consumedFile, "utf8").replace(
      `feature=${options.feature}`,
      "feature=other",
    );
    writeFileSync(consumedFile, content);
    const checked = checkReceipt({ ...options, dir: ".claude/progress", includeConsumed: true });
    expect(checked.exitCode).toBe(1);
    expect(checked.result.error).toContain('belongs to feature "other"');
  });

  // Covers: R6
  it("reads receipt.consumed.txt only with includeConsumed, and marks it consumed", () => {
    const options = fixture();
    writeFileSync(join(options.cwd, "base.txt"), "reviewed\n");
    expect(signReceipt(options).exitCode).toBe(0);
    const receiptFile = join(options.cwd, options.dir, "receipt.txt");
    const consumedFile = join(options.cwd, options.dir, "receipt.consumed.txt");
    renameSync(receiptFile, consumedFile);
    const withoutFlag = checkReceipt(options);
    expect(withoutFlag.result.status).toBe("error");
    expect(withoutFlag.exitCode).toBe(1);
    const withFlag = checkReceipt({ ...options, includeConsumed: true });
    expect(withFlag.result.status).toBe("ok");
    expect(withFlag.result.consumed).toBe(true);
  });
});

describe("receipt-outcome observation", () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = [
    "NAVORI_AUDITS_ROOT",
    "CLAUDE_CODE_SESSION_ID",
    "NAVORI_AUDIT_HOST",
    "NAVORI_AUDIT_SESSION_ID",
    "CODEX_SESSION_ID",
    "CODEX_THREAD_ID",
  ];
  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
    for (const key of KEYS.slice(2)) delete process.env[key];
    delete process.env.CLAUDE_CODE_SESSION_ID;
  });
  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    process.exitCode = undefined;
    vi.mocked(contentIdentity).mockClear();
    vi.restoreAllMocks();
  });

  /** A pushed repo with a config (gate configurable) and one file to publish. */
  function project(
    gate: string | null = "quality-gate-full",
  ): ReceiptOptions & { feature: string } {
    const options = fixture();
    writeFileSync(
      join(options.cwd, "navori.config.json"),
      JSON.stringify({
        name: "test",
        version: "1",
        preset: "node",
        engines: ["claude"],
        branchBase: "main",
        ...(gate === null ? {} : { qualityGate: { fast: "true", full: gate } }),
      }),
    );
    git(options.cwd, "add", "navori.config.json");
    git(options.cwd, "commit", "-m", "config");
    git(options.cwd, "push", "origin", "main");
    writeFileSync(join(options.cwd, "feature.txt"), "feature\n");
    return { ...options, gate: gate ?? "" };
  }
  function markAudit(cwd: string): string {
    process.env.NAVORI_AUDITS_ROOT = join(cwd, "..", "audits");
    process.env.CLAUDE_CODE_SESSION_ID = "sess-1";
    const log = sessionLogPath(repoFromCwd(cwd), "sess-1");
    mkdirSync(join(log, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(
      log,
      `${JSON.stringify({ event: "start", host: "claude", sessionId: "sess-1", cwd })}\n`,
      { mode: 0o600 },
    );
    return log;
  }
  function events(log: string): Array<Record<string, unknown>> {
    return readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
  /** Runs the command and returns what it printed, its exit code and what it left in `process.exitCode`. */
  function run(
    action: "sign" | "check",
    cwd: string,
    feature: string,
  ): { stdout: string; exit: unknown } {
    let stdout = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    });
    process.exitCode = undefined;
    executeReceipt(action, { cwd, feature, target: "main", json: true });
    const exit = process.exitCode;
    process.exitCode = undefined;
    vi.restoreAllMocks();
    return { stdout, exit };
  }
  const sampleOf =
    (values: ContentIdentity[]): (() => ContentIdentity) =>
    () =>
      values.shift() as ContentIdentity;
  const ok = (fingerprint: string, head = "a".repeat(40)): ContentIdentity => ({
    ok: true,
    alg: "navori-content/v1",
    fingerprint,
    base: "b".repeat(40),
    head,
    indexDiverges: false,
  });

  // Covers: R16
  it("sign and check each emit one closed event with a stable identity and no raw feature", () => {
    const options = project();
    const log = markAudit(options.cwd);
    run("sign", options.cwd, "secret-payroll-fix");
    run("check", options.cwd, "secret-payroll-fix");
    const written = events(log);
    expect(written).toHaveLength(2);
    expect(written[0]).toMatchObject({
      name: "receipt-outcome",
      verdict: "ok",
      schemaVersion: 1,
      action: "sign",
      freshness: "fresh",
      identity: "stable",
      alg: "navori-content/v1",
    });
    expect(written[1]).toMatchObject({
      action: "check",
      verdict: "ok",
      freshness: "fresh",
      consumed: 0,
      uncovered: 0,
      drift: 0,
      identity: "stable",
    });
    for (const event of written) {
      expect(event.fp).toMatch(/^[a-f0-9]{64}$/);
      expect(event.gate).toMatch(/^[a-f0-9]{64}$/);
      expect(event.inputs).toMatch(/^[a-f0-9]{64}$/);
      expect(event.receipt).toMatch(/^[a-f0-9]{64}$/);
      expect(event.featureKey).toMatch(/^[a-f0-9]{64}$/);
    }
    // Same content, same receipt bytes: sign and check agree on the identity and the hash.
    expect(written[1]?.fp).toBe(written[0]?.fp);
    expect(written[1]?.receipt).toBe(written[0]?.receipt);
    expect(readFileSync(log, "utf8")).not.toContain("secret-payroll-fix");
  });

  // Covers: R16
  it("prints and exits exactly the same with and without audit context, and does no work without one", () => {
    const options = project();
    const without = run("sign", options.cwd, "same-output");
    const withoutCheck = run("check", options.cwd, "same-output");
    expect(vi.mocked(contentIdentity)).not.toHaveBeenCalled();
    const log = markAudit(options.cwd);
    const withContext = run("sign", options.cwd, "same-output");
    const withContextCheck = run("check", options.cwd, "same-output");
    expect(withContext).toEqual(without);
    expect(withContextCheck).toEqual(withoutCheck);
    expect(vi.mocked(contentIdentity)).toHaveBeenCalledTimes(4); // sandwich x 2 commands
    expect(events(log)).toHaveLength(2);
    // ReceiptResult keeps its exact shape: nothing of the projection leaks into stdout.
    expect(Object.keys(JSON.parse(withContext.stdout)).sort()).toEqual(
      [
        "consumed",
        "drift",
        "error",
        "formatVersion",
        "fresh",
        "headSha",
        "stale",
        "status",
        "target",
        "targetSha",
        "uncovered",
      ].sort(),
    );
  });

  // Covers: R16
  it("adds no gate run and no second git fetch to the command", () => {
    const options = project();
    const fetches = (): number =>
      vi.mocked(spawnSync).mock.calls.filter((call) => (call[1] as string[]).includes("fetch"))
        .length;
    vi.mocked(spawnSync).mockClear();
    run("check", options.cwd, "fetch-count"); // absent receipt: error, still inspects once
    const baseline = fetches();
    markAudit(options.cwd);
    vi.mocked(spawnSync).mockClear();
    run("check", options.cwd, "fetch-count");
    expect(fetches()).toBe(baseline);
    const gateRuns = vi
      .mocked(spawnSync)
      .mock.calls.filter((call) => String(call[0]).includes("quality-gate-full"));
    expect(gateRuns).toEqual([]);
  });

  // Covers: R16
  it("reports a stale gate as stale without failing, and omits gate when none is configured", () => {
    const options = project();
    const log = markAudit(options.cwd);
    expect(signReceipt(options).exitCode).toBe(0);
    const observer: ReceiptObserver = { sample: () => contentIdentity(options.cwd) };
    const stale = { ...options, gate: "another-gate", observer };
    const checked = checkReceipt(stale);
    expect(checked).toMatchObject({ exitCode: 0, result: { fresh: false, stale: ["gate"] } });
    emitReceiptOutcome(stale, "check", checked.result);
    expect(events(log).at(-1)).toMatchObject({
      verdict: "ok",
      freshness: "stale",
      stale: "gate",
      identity: "stable",
    });
    // No `qualityGate.full`: the gate digest is never published, so it can never satisfy acceptance.
    const bare = project(null);
    const bareLog = markAudit(bare.cwd);
    run("sign", bare.cwd, "no-gate");
    const [event] = events(bareLog);
    expect(event).toMatchObject({ verdict: "ok", identity: "stable" });
    expect(event).not.toHaveProperty("gate");
    expect(event?.inputs).toMatch(/^[a-f0-9]{64}$/);
  });

  // Covers: R16
  it("emits only counts for findings and only action plus key for an error", () => {
    const options = project();
    const log = markAudit(options.cwd);
    expect(signReceipt(options).exitCode).toBe(0);
    writeFileSync(join(options.cwd, "feature.txt"), "edited after review\n");
    writeFileSync(join(options.cwd, "extra-secret-name.ts"), "x\n");
    const checked = run("check", options.cwd, options.feature);
    expect(checked.exit).toBe(2);
    expect(events(log).at(-1)).toMatchObject({ verdict: "findings", uncovered: 1, drift: 1 });
    expect(readFileSync(log, "utf8")).not.toContain("extra-secret-name");
    const failed = run("check", options.cwd, "no-such-receipt");
    expect(failed.exit).toBe(1);
    const error = events(log).at(-1) as Record<string, unknown>;
    expect(Object.keys(error).sort()).toEqual(
      ["action", "event", "featureKey", "name", "schemaVersion", "tsMs", "verdict"].sort(),
    );
    expect(error).toMatchObject({ verdict: "error", action: "check" });
  });

  // Covers: R16
  it("marks the identity unstable (no fp) when the content moves between the two samples", () => {
    const options = project();
    const observer: ReceiptObserver = {
      sample: sampleOf([ok("1".repeat(64)), ok("2".repeat(64))]),
    };
    const signed = signReceipt({ ...options, observer });
    const { payload } = receiptOutcomeOf("f".repeat(64), "sign", signed.result, observer);
    expect(payload).toMatchObject({ identity: "unstable" });
    expect(payload).not.toHaveProperty("fp");
    expect(payload).not.toHaveProperty("alg");
  });

  // Covers: R16
  it("reads a failed or throwing sample as unavailable without changing the result", () => {
    const options = project();
    const baseline = signReceipt(options);
    const failing: ReceiptObserver = {
      sample: sampleOf([ok("1".repeat(64)), { ok: false, reason: "timeout" }]),
    };
    expect(signReceipt({ ...options, observer: failing })).toEqual(baseline);
    expect(
      receiptOutcomeOf("f".repeat(64), "sign", baseline.result, failing).payload,
    ).toMatchObject({ identity: "unavailable" });
    const throwing: ReceiptObserver = {
      sample: () => {
        throw new Error("EMFILE");
      },
    };
    expect(signReceipt({ ...options, observer: throwing })).toEqual(baseline);
    expect(checkReceipt({ ...options, observer: throwing })).toEqual(checkReceipt(options));
    expect(
      receiptOutcomeOf("f".repeat(64), "check", baseline.result, throwing).payload,
    ).toMatchObject({ identity: "unavailable" });
  });

  // Covers: R16
  it("never changes the command when the audit log is unsafe or unwritable", () => {
    const options = project();
    const baseline = run("sign", options.cwd, "unsafe-log");
    const log = markAudit(options.cwd);
    rmSync(log);
    symlinkSync(join(options.cwd, "base.txt"), log);
    expect(run("sign", options.cwd, "unsafe-log")).toEqual(baseline);
    expect(readFileSync(join(options.cwd, "base.txt"), "utf8")).toBe("base\n");
  });
});
