import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeSignal } from "../signal.ts";

// Covers: R15, R19

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-master-signal-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function git(args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function commit(message: string): void {
  git(["add", "-A"]);
  git(["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-m", message]);
}

describe("computeSignal", () => {
  it("returns null git fields and does not throw for a repo without git", () => {
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "x" }));
    const signal = computeSignal(cwd);
    expect(signal.commits).toBeNull();
    expect(signal.firstCommit).toBeNull();
    expect(signal.filesChangedSinceFirst).toBeNull();
    expect(signal.suggested).toBe("template");
  });

  it("reports one commit and zero files changed since it", () => {
    git(["init", "-q"]);
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "x" }));
    commit("initial");
    const signal = computeSignal(cwd);
    expect(signal.commits).toBe(1);
    expect(signal.firstCommit).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(signal.filesChangedSinceFirst).toBe(0);
    expect(signal.suggested).toBe("template");
  });

  it("suggests en-curso for a repo with real history past the thresholds", () => {
    git(["init", "-q"]);
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "x" }));
    commit("initial");
    for (let i = 0; i < 25; i++) {
      writeFileSync(join(cwd, `file-${i}.txt`), `content ${i}`);
      commit(`add file ${i}`);
    }
    const signal = computeSignal(cwd);
    expect(signal.commits).toBe(26);
    expect(signal.filesChangedSinceFirst).toBeGreaterThan(20);
    expect(signal.suggested).toBe("en-curso");
  });

  it("treats a repo with no source code as an open decision, without failing", () => {
    git(["init", "-q"]);
    writeFileSync(join(cwd, "README.md"), "# empty repo");
    commit("initial");
    const signal = computeSignal(cwd);
    expect(signal.framework).toBeNull();
    expect(signal.libraries).toEqual([]);
  });
});
