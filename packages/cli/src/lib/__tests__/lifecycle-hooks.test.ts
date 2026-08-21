import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { getCoreRoot } from "../bundled-assets.ts";
import { acrossShells } from "./helpers/shells.ts";

/**
 * Behavioral tests for the Stop / SubagentStop / PreCompact lifecycle hooks
 * (#169 / N1). Each core-asset script is installed into a temp repo and driven
 * with its event JSON on stdin; we assert the JSON it emits. These scripts carry
 * no `{{...}}` placeholders, so install is a plain copy. The real PATH is
 * inherited (node/git/bash resolvable) as in session-start-hook.test.ts.
 */
const HOOKS_DIR = resolve(getCoreRoot(), "core-assets/hooks");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "navori-lc-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function git(...args: string[]): void {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

function seedRepo(): void {
  git("init", "-q", "-b", "feat/x");
  git("config", "user.email", "t@t.co");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git("add", "a.txt");
  git("commit", "-qm", "chore: seed");
}

/** Install a hook script (plain copy) and run it with `payload` on stdin.
 * Runs under every available shell (bash AND zsh, #391); the outputs must agree. */
function runHook(script: string, payload: unknown): { status: number; stdout: string } {
  const raw = readFileSync(join(HOOKS_DIR, script), "utf-8");
  const path = join(dir, script);
  writeFileSync(path, raw);
  chmodSync(path, 0o755);
  const nodeDir = dirname(process.execPath);
  return acrossShells((shell) => {
    const r = spawnSync(shell, [path], {
      cwd: dir,
      input: JSON.stringify(payload),
      encoding: "utf-8",
      env: { ...process.env, PATH: `${nodeDir}:/usr/bin:/bin:${process.env.PATH ?? ""}` },
    });
    return { status: r.status ?? -1, stdout: r.stdout ?? "" };
  });
}

function systemMessage(stdout: string): string | undefined {
  if (!stdout.trim()) return undefined;
  return (JSON.parse(stdout) as { systemMessage?: string }).systemMessage;
}

describe("stop-verify-reminder hook", () => {
  const run = () => runHook("stop-verify-reminder.sh", { hook_event_name: "Stop" });

  it("stays silent (exit 0, no output) outside a git repo", () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("stays silent when the working tree is clean", () => {
    seedRepo();
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("stays silent when only untracked files are present", () => {
    seedRepo();
    writeFileSync(join(dir, "scratch.log"), "junk\n");
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("emits an advisory systemMessage (never blocks) when tracked files are dirty", () => {
    seedRepo();
    writeFileSync(join(dir, "a.txt"), "changed\n");
    const r = run();
    expect(r.status).toBe(0);
    const msg = systemMessage(r.stdout);
    expect(msg).toContain("verify-before-done");
    // advisory: no `decision` field → never forces the model to continue
    expect(JSON.parse(r.stdout)).not.toHaveProperty("decision");
  });
});

describe("subagent-stop-handoff hook", () => {
  const run = () => runHook("subagent-stop-handoff.sh", { hook_event_name: "SubagentStop" });
  const writeProgressIn = (engineDir: string, name: string, body: string) => {
    mkdirSync(join(dir, engineDir, "progress"), { recursive: true });
    writeFileSync(join(dir, engineDir, "progress", name), body);
  };
  const writeProgress = (name: string, body: string) => writeProgressIn(".claude", name, body);

  it("stays silent when there is no progress dir", () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("stays silent for a well-formed impl handoff (has Status:)", () => {
    writeProgress("impl_x.md", "# impl\nStatus: DONE\n");
    const r = run();
    expect(r.stdout.trim()).toBe("");
  });

  it("flags an empty impl handoff", () => {
    writeProgress("impl_x.md", "   \n");
    const r = run();
    expect(systemMessage(r.stdout)).toContain("impl_x.md");
  });

  it("flags an impl handoff missing its Status: marker", () => {
    writeProgress("impl_x.md", "# impl\nsome notes but no terminal marker\n");
    expect(systemMessage(run().stdout)).toContain("Status:");
  });

  it("stays silent for a review handoff carrying a verdict", () => {
    writeProgress("review_x.md", "# review\nVerdict: APPROVED\n");
    expect(run().stdout.trim()).toBe("");
  });

  it("flags a review handoff with no verdict, and never blocks", () => {
    writeProgress("review_x.md", "# review\nlooks fine to me\n");
    const r = run();
    expect(systemMessage(r.stdout)).toContain("review_x.md");
    expect(JSON.parse(r.stdout)).not.toHaveProperty("decision");
  });

  // #389: `placeHook` copies this body verbatim for every engine, so the hook
  // has to know each engine's progress dir itself. It knew two names Codex
  // never uses, which made it a silent no-op there — the same shape as #352.
  it("reads the Codex progress dir too", () => {
    writeProgressIn(".codex", "impl_x.md", "# impl\nno terminal marker\n");
    expect(systemMessage(run().stdout)).toContain(".codex/progress/impl_x.md");
  });

  // Both dirs exist in a repo that renders both engines. Stopping at the first
  // one found would leave whichever engine came second unwatched.
  it("scans EVERY progress dir, not just the first one it finds", () => {
    writeProgressIn(".claude", "impl_a.md", "   \n");
    writeProgressIn(".codex", "review_b.md", "# review\nno verdict here\n");
    const msg = systemMessage(run().stdout);
    expect(msg).toContain(".claude/progress/impl_a.md");
    expect(msg).toContain(".codex/progress/review_b.md");
  });

  it("names the report by its path, so the message says which dir to open", () => {
    writeProgressIn(".codex", "impl_x.md", "   \n");
    expect(systemMessage(run().stdout)).toContain(".codex/progress/impl_x.md");
  });
});

describe("precompact-session-summary hook", () => {
  it("injects a session-summary reminder via additionalContext (never blocks)", () => {
    const r = runHook("precompact-session-summary.sh", {
      hook_event_name: "PreCompact",
      trigger: "auto",
    });
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
      decision?: unknown;
    };
    expect(parsed.hookSpecificOutput?.hookEventName).toBe("PreCompact");
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("resumen de sesión");
    // Deliberately does NOT hard-code engram's exact tool token — see the hook
    // header (a doctor invariant the engram plugin owns).
    expect(parsed.hookSpecificOutput?.additionalContext).not.toContain("mem_session_summary");
    expect(parsed).not.toHaveProperty("decision");
  });
});
