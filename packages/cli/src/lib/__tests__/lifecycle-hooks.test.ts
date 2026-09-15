import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { expandHookIncludes } from "../hook-includes.ts";
import { getCoreRoot } from "../bundled-assets.ts";
import { acrossShells } from "./helpers/shells.ts";

/**
 * Behavioral tests for the Stop reminder and the handoff validator (#169 / N1).
 * Each core-asset script is installed into a temp repo and driven with its event
 * JSON on stdin; we assert the JSON it emits. These scripts carry no `{{...}}`
 * placeholders, so install is a plain copy. The real PATH is inherited
 * (node/git/bash resolvable) as in session-start-hook.test.ts.
 *
 * The PreCompact reminder used to have a `describe` here. It was retired in
 * #774 — PreCompact has no documented channel to the model — and its content now
 * rides `SessionStart(compact)`, so its behavioural test lives in
 * `session-start-hook.test.ts` with the rest of that hook's sources.
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
  // Expanded, not raw: `# navori:include` is resolved at RENDER time, so the
  // file that actually runs in a user repo is the expanded one. Testing the
  // raw asset would exercise a script that never exists anywhere.
  const raw = expandHookIncludes(readFileSync(join(HOOKS_DIR, script), "utf-8"));
  const path = join(dir, script);
  writeFileSync(path, raw);
  chmodSync(path, 0o755);
  const nodeDir = dirname(process.execPath);
  return acrossShells((shell) => {
    // A temp dir PER SHELL, inside the case's own dir so it is cleaned with it.
    // `subagent-stop-handoff` remembers what it last reported under $TMPDIR, on
    // purpose (#560): the host re-fires it while nothing changed, and the note
    // is said once. Sharing one $TMPDIR across the two shells would hand the
    // second run the first run's memory and read as a portability divergence.
    const shellTmp = join(dir, `tmp-${shell}`);
    mkdirSync(shellTmp, { recursive: true });
    const r = spawnSync(shell, [path], {
      cwd: dir,
      input: JSON.stringify(payload),
      encoding: "utf-8",
      env: {
        ...process.env,
        TMPDIR: shellTmp,
        PATH: `${nodeDir}:/usr/bin:/bin:${process.env.PATH ?? ""}`,
      },
    });
    return { status: r.status ?? -1, stdout: r.stdout ?? "" };
  });
}

function systemMessage(stdout: string): string | undefined {
  if (!stdout.trim()) return undefined;
  return (JSON.parse(stdout) as { systemMessage?: string }).systemMessage;
}

/** The half of the payload that reaches the MODEL, keyed by its event name. */
function additionalContext(stdout: string): { event?: string; text?: string } {
  if (!stdout.trim()) return {};
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
  };
  return {
    event: parsed.hookSpecificOutput?.hookEventName,
    text: parsed.hookSpecificOutput?.additionalContext,
  };
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

  // The other half of the #774 defect, same shape as the handoff's: the text
  // tells the MODEL to run the gate and commit, and `systemMessage` is
  // documented as "Warning message shown to the user" — so on its own it
  // reached the human and nobody who could act on it. `Stop` does have a
  // channel to the model ("Stop and SubagentStop also accept
  // `hookSpecificOutput.additionalContext`"), and this pins that it is used.
  it("speaks to the agent through additionalContext, not only to the human", () => {
    seedRepo();
    writeFileSync(join(dir, "a.txt"), "changed\n");
    const { stdout } = run();
    const { event, text } = additionalContext(stdout);
    expect(event).toBe("Stop");
    expect(text).toContain("verify-before-done");
    // …and the human still sees it: both channels, one emission.
    expect(systemMessage(stdout)).toBe(text);
  });
});

describe("subagent-stop-handoff hook", () => {
  // PostToolUse on the `Agent` tool since #774: that is the event whose
  // `additionalContext` lands in the PARENT session, which is the only reader
  // that can act on a broken handoff.
  const run = () =>
    runHook("subagent-stop-handoff.sh", {
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
    });
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

  // The defect #774 fixes, pinned: the note asks the MODEL for an action, so it
  // has to travel on the channel the model reads. `systemMessage` is documented
  // as "warning message shown to the user" — on its own it reached the human's
  // UI and nobody else.
  it("speaks to the leader through additionalContext, not only to the human", () => {
    writeProgress("impl_x.md", "# impl\nno terminal marker\n");
    // ONE run: the hook remembers what it reported, so a second call in the
    // same case would be the `repeat` path and say nothing.
    const { stdout } = run();
    const { event, text } = additionalContext(stdout);
    expect(event).toBe("PostToolUse");
    expect(text).toContain("impl_x.md");
    // …and the human still sees it: both channels, one emission.
    expect(systemMessage(stdout)).toContain("impl_x.md");
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

/**
 * The asset ships no `precompact-session-summary.sh` any more, and nothing may
 * quietly bring it back: PreCompact discards `systemMessage`/`continue` and is
 * absent from the host's "where the reminder appears" list, so a hook there
 * emits into a channel that does not deliver while its audit line claims it
 * did (#774).
 */
describe("the retired PreCompact hook", () => {
  it("ships no hook that emits under the PreCompact event", () => {
    const files = readdirSync(HOOKS_DIR).filter((f) => f.endsWith(".sh"));
    expect(files).not.toContain("precompact-session-summary.sh");
    const offenders = files.filter((f) =>
      /hookEventName\s*:\s*"PreCompact"/.test(readFileSync(join(HOOKS_DIR, f), "utf-8")),
    );
    expect(offenders).toEqual([]);
  });
});
