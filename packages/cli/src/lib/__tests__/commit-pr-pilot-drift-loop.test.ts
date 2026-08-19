import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { getCoreRoot } from "../bundled-assets.ts";

/**
 * #344: the drift loop in `commit-pr-pilot.md` used a variable named `path`. In
 * zsh `path` is tied to $PATH (`typeset -T PATH path`), so the assignment wiped
 * the PATH, the next `git hash-object` died with "command not found", `2>/dev/null`
 * swallowed it and the empty output was reported as DRIFT on EVERY file of the
 * receipt. The agent runs this snippet through its shell tool, i.e. the user's
 * shell — zsh on any stock macOS.
 *
 * These tests run the snippet AS SHIPPED (extracted verbatim from the asset)
 * under both bash and zsh, so a future rename to another zsh-special name
 * (fpath / cdpath / manpath / module_path) fails here instead of in a PR cycle.
 */

const PILOT = resolve(getCoreRoot(), "core-assets", "agents", "commit-pr-pilot.md");

/** The `while … done < .claude/progress/receipt.txt` block, verbatim from the asset. */
function driftLoop(): string {
  const raw = readFileSync(PILOT, "utf-8");
  const m = raw.match(
    /^while IFS= read -r line; do$[\s\S]*?^done < \.claude\/progress\/receipt\.txt$/m,
  );
  expect(m, "drift loop snippet not found in commit-pr-pilot.md").not.toBeNull();
  return (m as RegExpMatchArray)[0];
}

const hasZsh = spawnSync("zsh", ["-c", "exit 0"]).status === 0;

let dir: string;

function git(...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

/** Run the shipped loop under `shell`, returning its combined output. */
function runLoop(shell: "bash" | "zsh"): string {
  const r = spawnSync(shell, ["-c", driftLoop()], { cwd: dir, encoding: "utf-8" });
  return `${r.stdout}${r.stderr}`;
}

function writeReceipt(files: string[]): void {
  const lines = ["# navori-receipt v1 feature=probe"];
  for (const f of files) lines.push(`${git("hash-object", f).trim()}  ${f}`);
  const receipt = join(dir, ".claude/progress/receipt.txt");
  mkdirSync(dirname(receipt), { recursive: true });
  writeFileSync(receipt, `${lines.join("\n")}\n`);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "navori-drift-loop-"));
  git("init", "-q");
  writeFileSync(join(dir, "a.txt"), "alpha\n");
  writeFileSync(join(dir, "b.txt"), "beta\n");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("commit-pr-pilot drift loop — shell portability (#344)", () => {
  it("reports no drift for an untouched receipt under bash", () => {
    writeReceipt(["a.txt", "b.txt"]);
    expect(runLoop("bash")).toBe("");
  });

  it.skipIf(!hasZsh)("reports no drift for an untouched receipt under zsh", () => {
    writeReceipt(["a.txt", "b.txt"]);
    expect(runLoop("zsh")).toBe("");
  });

  it("still flags a file whose bytes really changed (both shells)", () => {
    writeReceipt(["a.txt", "b.txt"]);
    writeFileSync(join(dir, "a.txt"), "tampered\n");
    for (const shell of hasZsh ? (["bash", "zsh"] as const) : (["bash"] as const)) {
      const out = runLoop(shell);
      expect(out, shell).toContain("DRIFT: a.txt");
      expect(out, shell).not.toContain("DRIFT: b.txt");
    }
  });

  // A hashing failure is an environment problem, not evidence that the content
  // drifted — the two verdicts must not be collapsed into one.
  it("reports an unhashable file as ERROR, not as DRIFT", () => {
    writeReceipt(["a.txt"]);
    // Replace the file with a directory: it exists, but `git hash-object` on it
    // fails — the same shape as any other environment failure.
    rmSync(join(dir, "a.txt"));
    mkdirSync(join(dir, "a.txt"));
    const out = runLoop("bash");
    expect(out).toContain("ERROR: could not verify a.txt");
    expect(out).not.toContain("DRIFT: a.txt");
  });

  it("flags an approved file that disappeared as DRIFT (missing)", () => {
    writeReceipt(["a.txt"]);
    rmSync(join(dir, "a.txt"));
    expect(runLoop("bash")).toContain("DRIFT: a.txt (missing since review)");
  });
});
