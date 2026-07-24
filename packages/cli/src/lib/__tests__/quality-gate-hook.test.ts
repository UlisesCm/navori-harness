import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { getCoreRoot } from "../bundled-assets.ts";

/**
 * Behavioral tests for the quality-gate pre-commit hook (#88). We install the
 * core-asset script into a temp repo (replacing the {{qualityGate.fast}}
 * placeholder as `navori render` does), then drive it with a restricted PATH so
 * we control exactly which package managers are "installed".
 */
const HOOK_SRC = resolve(getCoreRoot(), "core-assets/hooks/quality-gate-pre-commit.sh");
// /usr/bin + /bin give coreutils (sed/cat/head/jq) but NO pnpm/bun/npm/node —
// those only exist if we fake them into binDir.
const BASE_PATH = "/usr/bin:/bin";

let dir: string;
let binDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "navori-qg-"));
  binDir = join(dir, "fakebin");
  mkdirSync(binDir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function installHook(gate: string): string {
  const raw = readFileSync(HOOK_SRC, "utf-8").replace("{{qualityGate.fast}}", gate);
  const path = join(dir, "hook.sh");
  writeFileSync(path, raw);
  chmodSync(path, 0o755);
  return path;
}

/** Put a fake executable on PATH that echoes its invocation and exits `code`. */
function fakeBin(name: string, code = 0): void {
  const p = join(binDir, name);
  writeFileSync(p, `#!/usr/bin/env bash\necho "RAN ${name} $*"\nexit ${code}\n`);
  chmodSync(p, 0o755);
}

function runHook(hookPath: string, command: string) {
  return spawnSync("bash", [hookPath], {
    cwd: dir,
    input: JSON.stringify({ tool_input: { command } }),
    encoding: "utf-8",
    env: { PATH: `${binDir}:${BASE_PATH}` },
  });
}

describe("quality-gate hook — declared runner present", () => {
  it("runs the gate when the declared package manager is on PATH", () => {
    fakeBin("pnpm", 0);
    const r = runHook(installHook("pnpm run typecheck"), "git commit -m test");
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("running quality-gate fast");
    expect(r.stdout).toContain("RAN pnpm run typecheck");
  });

  it("aborts with exit 2 when the gate command fails", () => {
    fakeBin("pnpm", 2);
    const r = runHook(installHook("pnpm run typecheck"), "git commit -m test");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("quality-gate fast failed");
  });

  it("ignores commands that are not git commit/push", () => {
    fakeBin("pnpm", 0);
    const r = runHook(installHook("pnpm run typecheck"), "ls -la");
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("running quality-gate fast");
  });

  // Segment-based detection: a compound command must NOT skip the gate silently.
  it("runs the gate on a compound `cd x && git commit` (no silent skip)", () => {
    fakeBin("pnpm", 0);
    const r = runHook(installHook("pnpm run typecheck"), "cd sub && git commit -m x");
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("running quality-gate fast");
    expect(r.stdout).toContain("RAN pnpm run typecheck");
  });

  it("runs the gate on `echo done; git push` (separator, no leading git)", () => {
    fakeBin("pnpm", 0);
    const r = runHook(installHook("pnpm run typecheck"), "echo done; git push");
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("running quality-gate fast");
  });

  it("runs the gate past an env-var prefix `FOO=bar git commit`", () => {
    fakeBin("pnpm", 0);
    const r = runHook(installHook("pnpm run typecheck"), "FOO=bar git commit -m x");
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("running quality-gate fast");
  });

  // FIX B: a backslash-newline continuation must not split the command past the
  // gate. `cd x && \<NL> git commit` still triggers.
  it("runs the gate on a multi-line `cd x && \\\\<NL> git commit`", () => {
    fakeBin("pnpm", 0);
    const r = runHook(installHook("pnpm run typecheck"), "cd x && \\\n git commit -m x");
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("running quality-gate fast");
  });

  // FIX C: git global options between `git` and the subcommand still gate.
  it("runs the gate on `git -c k=v commit` (interleaved global option)", () => {
    fakeBin("pnpm", 0);
    const r = runHook(installHook("pnpm run typecheck"), "git -c k=v commit -m x");
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("running quality-gate fast");
  });

  it("does NOT trigger on a quoted `echo \"git commit\"` (not a real invocation)", () => {
    fakeBin("pnpm", 0);
    const r = runHook(installHook("pnpm run typecheck"), 'echo "git commit"');
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("running quality-gate fast");
  });
});

describe("quality-gate hook — declared runner missing (#88)", () => {
  it("remaps to the lockfile-detected package manager (pnpm gate in a bun repo)", () => {
    // Only bun is installed; the repo carries a bun lockfile. The pnpm-based
    // gate must be retried through bun instead of skipped.
    fakeBin("bun", 0);
    writeFileSync(join(dir, "bun.lock"), "");
    const r = runHook(installHook("pnpm run typecheck"), "git commit -m test");
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("uso el package manager detectado por lockfile: 'bun'");
    expect(r.stdout).toContain("RAN bun run typecheck");
  });

  it("detects the PM from the packageManager field in package.json", () => {
    fakeBin("bun", 0);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "bun@1.3.9" }));
    const r = runHook(installHook("pnpm run typecheck"), "git commit -m test");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("RAN bun run typecheck");
  });

  it("BLOCKS the commit (exit 2) instead of skipping silently when nothing can run it", () => {
    // No package manager installed, no lockfile — the old behavior was a silent
    // `exit 0`. It must now block loudly.
    const r = runHook(installHook("pnpm run typecheck"), "git commit -m test");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("BLOQUEADO");
    expect(r.stderr).not.toContain("running quality-gate fast");
  });
});
