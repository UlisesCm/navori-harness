import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { getCoreRoot } from "../bundled-assets.ts";

/**
 * Behavioral guard tests for core-assets/hooks/guard-destructive.sh.
 *
 * The guard reads Claude Code's PreToolUse payload from stdin and HARD-BLOCKS
 * (exit 2) destructive commands. It used to parse the payload with `jq`, which
 * is NOT preinstalled on macOS — a missing jq made the guard wave every command
 * through (fail-open). The fix extracts the command via jq → node → sed so the
 * guard keeps working with no JSON parser on PATH. These tests pin BOTH the
 * happy path and the no-parser fallback so that regression can't come back.
 */

const runsBash = process.platform !== "win32";
const guardPath = resolve(getCoreRoot(), "core-assets/hooks/guard-destructive.sh");

function resolveBin(name: string): string {
  return execFileSync("bash", ["-c", `command -v ${name}`], { encoding: "utf-8" }).trim();
}

/** Run the guard with `command` on stdin; returns its exit code. */
function runGuard(command: string, env?: NodeJS.ProcessEnv): number {
  const payload = JSON.stringify({ tool_input: { command } });
  try {
    execFileSync(resolveBin("bash"), [guardPath], {
      input: payload,
      env: env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? -1;
  }
}

describe.runIf(runsBash)("guard-destructive.sh", () => {
  describe("with a JSON parser on PATH (jq/node)", () => {
    it("blocks `rm -rf /` (exit 2)", () => {
      expect(runGuard("rm -rf /")).toBe(2);
    });

    it("blocks `git commit --no-verify` (exit 2)", () => {
      expect(runGuard("git commit --no-verify -m x")).toBe(2);
    });

    it("allows a benign command (exit 0)", () => {
      expect(runGuard("ls -la")).toBe(0);
    });

    it("allows a normal commit without --no-verify (exit 0)", () => {
      expect(runGuard('git commit -m "feat: x"')).toBe(0);
    });
  });

  describe("with NO JSON parser on PATH (sed fallback)", () => {
    // A minimal PATH with only the coreutils the guard needs — deliberately
    // without jq or node — proves the guard still inspects the command instead
    // of failing open. This is the exact scenario the fix targets.
    let restrictedEnv: NodeJS.ProcessEnv;

    beforeAll(() => {
      const bin = mkdtempSync(join(tmpdir(), "navori-guard-nobin-"));
      for (const tool of ["cat", "grep", "sed"]) {
        symlinkSync(resolveBin(tool), join(bin, tool));
      }
      restrictedEnv = { PATH: bin };
    });

    it("still blocks `rm -rf /` (exit 2)", () => {
      expect(runGuard("rm -rf /", restrictedEnv)).toBe(2);
    });

    it("still blocks `git commit --no-verify` (exit 2)", () => {
      expect(runGuard("git commit --no-verify -m x", restrictedEnv)).toBe(2);
    });

    it("still allows a benign command (exit 0)", () => {
      expect(runGuard("ls", restrictedEnv)).toBe(0);
    });
  });
});
