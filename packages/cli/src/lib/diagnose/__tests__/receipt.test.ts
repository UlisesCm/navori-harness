import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkReceipt, formatReceipt, signReceipt, type ReceiptOptions } from "../receipt.ts";
import { resolveReceiptOptions } from "../../../commands/receipt.ts";

const workspaces: string[] = [];
afterEach(() =>
  workspaces.splice(0).forEach((path) => rmSync(path, { force: true, recursive: true })),
);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
function fixture(): ReceiptOptions {
  const root = mkdtempSync(join(tmpdir(), "navori-receipt-"));
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
