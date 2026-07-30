import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { getCoreRoot } from "../bundled-assets.ts";

/**
 * Behavioral tests for the SessionStart context hook (#169 / N1). We install
 * the core-asset script into a temp repo (filling the `{{...}}` placeholders as
 * `navori render` does), then drive it with a SessionStart JSON payload on
 * stdin and assert the `additionalContext` it emits. The real PATH is inherited
 * so `git` and `node` (used to build the JSON) are available.
 */
const HOOK_SRC = resolve(getCoreRoot(), "core-assets/hooks/session-start-context.sh");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "navori-ss-"));
  installHook();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function git(...args: string[]): void {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

/** Install the hook with placeholders resolved (branchBase = "main"). */
function installHook(): string {
  const raw = readFileSync(HOOK_SRC, "utf-8").replace("{{branchBase}}", "main");
  const path = join(dir, "hook.sh");
  writeFileSync(path, raw);
  chmodSync(path, 0o755);
  return path;
}

/** Run the hook with a SessionStart payload; return {status, ctx} where ctx is
 *  the parsed additionalContext ("" when the hook emits nothing). */
function runHook(source = "startup"): { status: number; stdout: string; ctx: string } {
  // Ensure `bash`/`git` (/usr/bin, /bin) and `node` (this runtime's dir, used
  // to build the JSON) resolve. Vitest's inherited PATH can be too thin to find
  // them, so build it explicitly — node's own dir first, then the standard bins.
  const nodeDir = dirname(process.execPath);
  const r = spawnSync("bash", [join(dir, "hook.sh")], {
    cwd: dir,
    input: JSON.stringify({ hook_event_name: "SessionStart", source }),
    encoding: "utf-8",
    env: { ...process.env, PATH: `${nodeDir}:/usr/bin:/bin:${process.env.PATH ?? ""}` },
  });
  const stdout = r.stdout ?? "";
  let ctx = "";
  if (stdout.trim()) {
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
    };
    expect(parsed.hookSpecificOutput?.hookEventName).toBe("SessionStart");
    ctx = parsed.hookSpecificOutput?.additionalContext ?? "";
  }
  return { status: r.status ?? -1, stdout, ctx };
}

describe("session-start context hook", () => {
  it("emits branch + recent commits + progress/current.md on a working branch", () => {
    git("init", "-q", "-b", "feat/x");
    git("config", "user.email", "t@t.co");
    git("config", "user.name", "t");
    writeFileSync(join(dir, "a.txt"), "a\n");
    git("add", "a.txt");
    git("commit", "-qm", "feat: primer commit");
    mkdirSync(join(dir, "progress"), { recursive: true });
    writeFileSync(join(dir, "progress", "current.md"), "Task: seguir con N1\n");

    const r = runHook("startup");
    expect(r.status).toBe(0);
    expect(r.ctx).toContain("Branch: feat/x");
    expect(r.ctx).toContain("(base: main)");
    expect(r.ctx).toContain("feat: primer commit");
    expect(r.ctx).toContain("Resume — progress/current.md");
    expect(r.ctx).toContain("Task: seguir con N1");
  });

  it("warns when the session starts on the base branch", () => {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.co");
    git("config", "user.name", "t");
    writeFileSync(join(dir, "a.txt"), "a\n");
    git("add", "a.txt");
    git("commit", "-qm", "chore: seed");

    const r = runHook("resume");
    expect(r.status).toBe(0);
    expect(r.ctx).toContain("on the base branch");
  });

  it("emits nothing (exit 0, empty stdout) outside a git repo with no progress file", () => {
    const r = runHook("startup");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
    expect(r.ctx).toBe("");
  });

  it("emits just the resume when current.md exists but it is not a git repo", () => {
    mkdirSync(join(dir, "progress"), { recursive: true });
    writeFileSync(join(dir, "progress", "current.md"), "Next: wire the hook\n");
    const r = runHook("startup");
    expect(r.status).toBe(0);
    expect(r.ctx).toContain("Next: wire the hook");
    expect(r.ctx).not.toContain("Branch:");
  });
});
