import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getCoreRoot } from "../render/bundled-assets.ts";
import { expandHookIncludes } from "../render/hook-includes.ts";

// Covers: #1671
// guard-destructive fails CLOSED when its own deadline expires: the host kills it at 10s and
// reads that as an approval, so the guard blocks (exit 2) before the host gets the chance.

const GUARD_SRC = resolve(getCoreRoot(), "core-assets/hooks/guard-destructive.sh");
const DEADLINE_S = 1;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "navori-guard-timeout-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Render the guard like `navori render`; the audit recorder becomes a stderr line. */
function installGuard(): string {
  const raw = expandHookIncludes(readFileSync(GUARD_SRC, "utf-8"))
    .replace(/\{\{shq:branchBase\}\}/g, "'main'")
    .replace(/\{\{shq:piPermissionRules\}\}/g, "'-'")
    // An owned-path inventory makes the copy-destination awk (quadratic) run.
    .replace(/\{\{shq:navoriOwnedPaths\}\}/g, "'/nowhere/owned'")
    .replace("{{navori.progressHardCapBytes}}", "40000")
    .replace("{{navori.progressGuardLane}}", "0")
    .replace(
      'navori_audit_log "$navori_audit_verdict" "$navori_audit_reason" || true',
      'printf \'AUDIT %s %s\\n\' "$navori_audit_verdict" "$navori_audit_reason" >&2',
    );
  const path = join(dir, "hooks", ".claude/hooks", "guard-destructive.sh");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, raw);
  chmodSync(path, 0o755);
  return path;
}

function run(command: string, env: Record<string, string> = {}) {
  const started = Date.now();
  const r = spawnSync("bash", [installGuard()], {
    cwd: dir,
    input: JSON.stringify({ tool_input: { command } }),
    encoding: "utf-8",
    timeout: 20_000,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, ...env },
  });
  return { status: r.status, stderr: r.stderr, ms: Date.now() - started };
}

/** Run the guard asynchronously to learn its pid: the watchdog carries it in its argv. */
function runWithPid(command: string): Promise<{ status: number | null; pid: number }> {
  return new Promise((done, fail) => {
    const child = spawn("bash", [installGuard()], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir },
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", fail);
    child.on("close", (status) => done({ status, pid: child.pid ?? -1 }));
    child.stdin.end(JSON.stringify({ tool_input: { command } }));
  });
}

/** Live processes whose argv is this guard's watchdog (`nv-guard-deadline <pid> <deadline>`). */
function watchdogsOf(pid: number): string {
  const ps = spawnSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf-8" }).stdout;
  return ps
    .split("\n")
    .filter((l) => l.includes(`nv-guard-deadline ${pid} `))
    .join("\n");
}

describe("guard-destructive own deadline (#1671)", () => {
  it("A1: a command that outlasts the deadline is BLOCKED, without echoing it", () => {
    // Quadratic in the copy-dest awk (words x "$(x)") yet under CMD_MAX.
    const command = `echo ${"w ".repeat(4000)}${'"$(x)" '.repeat(4000)}`;
    const r = run(command, { NAVORI_GUARD_DEADLINE: String(DEADLINE_S) });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`inspection did not finish within ${DEADLINE_S}s`);
    // What the recorder is handed: verdict block, no reason code (none is allowlisted for it).
    expect(r.stderr).toMatch(/^AUDIT block $/m);
    expect(r.stderr).not.toContain("$(x)");
    expect(r.ms).toBeLessThan(4000);
  });

  it("A2: a normal command is approved and leaves no watchdog behind", async () => {
    const r = await runWithPid("echo hello");
    expect(r.status).toBe(0);
    expect(r.pid).toBeGreaterThan(0);
    // The guard killed its watchdog on the way out: nothing carries its pid any more.
    expect(watchdogsOf(r.pid)).toBe("");
  });

  it("ignores a NAVORI_GUARD_DEADLINE that would raise the deadline: 8s still applies", () => {
    const command = `echo ${"w ".repeat(4000)}${'"$(x)" '.repeat(4000)}`;
    const r = run(command, { NAVORI_GUARD_DEADLINE: "600" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("inspection did not finish within 8s");
  }, 15_000);
});
