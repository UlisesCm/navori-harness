import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expandHookIncludes } from "../lib/hook-includes.ts";

/**
 * The audit-mode hooks run on EVERY prompt of every repo that renders the
 * harness, so their contract is narrow and absolute: never a non-zero exit,
 * never a write outside the audit root, and never activation without a human
 * saying yes first.
 *
 * Both shells are exercised because this repo has shipped hooks that passed
 * under bash and silently no-opped under zsh (#391).
 */

const HOOKS = resolve(fileURLToPath(new URL("../../../core/core-assets/hooks/", import.meta.url)));
const TRIGGER = join(HOOKS, "audit-mode-trigger.sh");
const CLOSE = join(HOOKS, "audit-mode-close.sh");
const SHELLS = ["bash", "zsh"] as const;
const REPO = "fixture-repo";

let root: string;
let cwd: string;

function run(
  shell: string,
  hook: string,
  payload: string,
  pathOverride?: string,
): { out: string; code: number } {
  try {
    const out = execFileSync(shell, [hook], {
      input: payload,
      encoding: "utf-8",
      env: { ...process.env, NAVORI_AUDITS_ROOT: root, PATH: pathOverride ?? process.env.PATH },
    });
    return { out, code: 0 };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { out: err.stdout ?? "", code: err.status ?? 1 };
  }
}

function payload(prompt: string, sessionId = "sess1"): string {
  return JSON.stringify({
    user_prompt: prompt,
    session_id: sessionId,
    cwd,
    hook_event_name: "UserPromptSubmit",
  });
}

function logFile(sessionId = "sess1"): string {
  return join(root, REPO, `session-${sessionId}.log`);
}

/**
 * Materialize a hook the way `render` does — includes expanded, `{{shq:...}}`
 * resolved — and return its path. The raw asset is not a runnable script: its
 * `# navori:include` lines are resolved at render time, so testing the raw file
 * would exercise something that exists in no repo.
 */
function install(_shell: string, assetPath: string): string {
  const raw = expandHookIncludes(readFileSync(assetPath, "utf-8")).replace(
    "{{shq:branchBase}}",
    "'main'",
  );
  const path = join(root, `installed-${assetPath.split("/").pop()}`);
  writeFileSync(path, raw, "utf-8");
  chmodSync(path, 0o755);
  return path;
}

/** Run an already-installed script with `payload` on stdin. */
function runFile(shell: string, path: string, input: string): { out: string; code: number } {
  try {
    const out = execFileSync(shell, [path], {
      input,
      encoding: "utf-8",
      cwd: root,
      env: {
        ...process.env,
        NAVORI_AUDITS_ROOT: root,
        CLAUDE_PROJECT_DIR: root,
        // `subagent-stop-handoff` remembers its last report under $TMPDIR
        // (#560). Pointing it at the case's own root keeps that memory scoped
        // to one test and removed with it.
        TMPDIR: root,
        // Several hooks prefer `node` to serialize their JSON; without it on
        // PATH they take a different branch and the test measures the fallback.
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin:${process.env.PATH ?? ""}`,
      },
    });
    return { out, code: 0 };
  } catch (err) {
    // stderr is surfaced deliberately: a hook that dies takes its reason with it
    // otherwise, and "exit 127" alone says nothing about WHICH command was
    // missing.
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: (e.stdout ?? "") + (e.stderr ?? ""), code: e.status ?? -1 };
  }
}

/** Every parsed line of the session log. */
function logEvents(sessionId = "sess1"): Array<Record<string, unknown>> {
  if (!existsSync(logFile(sessionId))) return [];
  return readFileSync(logFile(sessionId), "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function activate(sessionId = "sess1"): void {
  mkdirSync(join(root, REPO), { recursive: true });
  writeFileSync(
    logFile(sessionId),
    `${JSON.stringify({ ts: "2026-08-25T10:00:00Z", event: "start", cwd, repo: REPO })}\n`,
    "utf-8",
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "navori-hook-"));
  cwd = join(tmpdir(), REPO);
  mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe.each(SHELLS)("audit-mode trigger under %s", (shell) => {
  it("stays silent on an unrelated prompt", () => {
    const { out, code } = run(shell, TRIGGER, payload("arregla el login"));
    expect(code).toBe(0);
    expect(out.trim()).toBe("");
  });

  /**
   * The hook used to match `audit mode` as a substring and ask Claude to offer
   * activation. Removed in spec 0013 (R3): substring matching cannot separate
   * INVOKING the mode from TALKING ABOUT it, and the second is what you do all
   * day while working on the feature — the request that opened this spec was
   * itself misread as an invocation. Activation is now `--start` only.
   */
  // Covers: R3
  it.each([
    ["english", "audita el ticket en audit mode"],
    ["spanish", "entra en modo audit por favor"],
    ["hyphenated", "mi feature de audit-mode no funciona"],
    ["off-intent", "apaga el audit mode"],
  ])("proposes nothing for a prompt that merely mentions audit-mode (%s)", (_label, text) => {
    const { out, code } = run(shell, TRIGGER, payload(text));
    expect(code).toBe(0);
    expect(out.trim()).toBe("");
    // Detection left nothing on disk before, and proposes nothing now.
    expect(existsSync(logFile())).toBe(false);
  });

  // Covers: R3
  it("proposes nothing about turning the mode off while it is active", () => {
    activate();
    const { out, code } = run(shell, TRIGGER, payload("apaga el audit mode"));
    expect(code).toBe(0);
    expect(out.trim()).toBe("");
    // …and the prompt is still recorded, because the mode IS active (R4).
    const last = readFileSync(logFile(), "utf-8").trim().split("\n").at(-1);
    expect(JSON.parse(last ?? "{}")).toMatchObject({ event: "prompt" });
  });

  /**
   * Regression: reading only `.user_prompt` logged `{"prompt":""}` against a
   * real session — the hook fired and matched, the field just wasn't there.
   * Blank entries are worse than none in a log whose job is attribution.
   */
  it.each([["user_prompt"], ["prompt"]])("records the typed text under .%s", (key) => {
    activate();
    const input = JSON.stringify({
      [key]: "arregla el login",
      session_id: "sess1",
      cwd,
      hook_event_name: "UserPromptSubmit",
    });
    run(shell, TRIGGER, input);
    const last = readFileSync(logFile(), "utf-8").trim().split("\n").at(-1);
    expect(JSON.parse(last ?? "{}")).toMatchObject({
      event: "prompt",
      prompt: "arregla el login",
    });
  });

  it("prefers user_prompt when the host sends both", () => {
    activate();
    const input = JSON.stringify({
      user_prompt: "el especifico",
      prompt: "el generico",
      session_id: "sess1",
      cwd,
    });
    run(shell, TRIGGER, input);
    const last = readFileSync(logFile(), "utf-8").trim().split("\n").at(-1);
    expect(JSON.parse(last ?? "{}").prompt).toBe("el especifico");
  });

  it("records transcript_path so the reader never has to guess it", () => {
    activate();
    const input = JSON.stringify({
      prompt: "haz X",
      session_id: "sess1",
      cwd,
      transcript_path: "/Users/x/.claude/projects/enc/sess1.jsonl",
    });
    run(shell, TRIGGER, input);
    const last = readFileSync(logFile(), "utf-8").trim().split("\n").at(-1);
    // Only the payload states this path; without it, discovery falls back to
    // re-deriving Claude Code's undocumented directory encoding.
    expect(JSON.parse(last ?? "{}").transcript).toBe("/Users/x/.claude/projects/enc/sess1.jsonl");
  });

  it("omits the transcript key when the payload has no path", () => {
    activate();
    run(shell, TRIGGER, payload("haz X"));
    const last = readFileSync(logFile(), "utf-8").trim().split("\n").at(-1);
    // An empty string would read as "recorded, and it is nowhere".
    expect(JSON.parse(last ?? "{}")).not.toHaveProperty("transcript");
  });

  it("appends the typed prompt while active, and only appends", () => {
    activate();
    const before = readFileSync(logFile(), "utf-8");
    run(shell, TRIGGER, payload("haz la tarea"));
    const after = readFileSync(logFile(), "utf-8");
    expect(after.startsWith(before)).toBe(true);
    expect(after.trim().split("\n")).toHaveLength(2);
    expect(JSON.parse(after.trim().split("\n")[1] ?? "{}")).toMatchObject({
      event: "prompt",
      prompt: "haz la tarea",
    });
  });

  it("never writes outside the audit root", () => {
    run(shell, TRIGGER, payload("audit mode"));
    expect(existsSync(join(cwd, "session-sess1.log"))).toBe(false);
  });
});

describe.each(SHELLS)("audit-mode fail-open under %s", (shell) => {
  const hostile: Array<[string, string]> = [
    ["empty payload", ""],
    ["malformed JSON", "{not json at all"],
    ["JSON without the expected fields", "{}"],
    ["null session id", JSON.stringify({ user_prompt: "audit mode", session_id: null })],
    [
      "prompt with quotes and newlines",
      JSON.stringify({ user_prompt: 'a "b" \n audit mode', session_id: "s", cwd: "/tmp" }),
    ],
    // The table used to assume what the CLI assumed — "a session id is a UUID"
    // — which is precisely why neither half caught the traversal of #503.
    [
      "path-shaped session id",
      JSON.stringify({ user_prompt: "audit mode", session_id: "a/../../escaped", cwd: "/tmp" }),
    ],
  ];

  it.each(hostile)("exits 0 on %s", (_label, input) => {
    expect(run(shell, TRIGGER, input).code).toBe(0);
    expect(run(shell, CLOSE, input).code).toBe(0);
  });

  /**
   * A path-shaped id would compose `<root>/<repo>/session-a/../../escaped.log`,
   * i.e. `<root>/escaped.log`.
   *
   * BOTH halves now refuse it on their own. The CLI validates the id because it
   * is the half that CREATES the file (#503, see commands/__tests__/audit.test.ts),
   * and the hook validates it because it is the half that COMPOSES the path.
   * The hook used to be safe only structurally — it appends solely to a log that
   * already exists, and the intermediate `session-a` directory is one navori
   * never creates — but "safe because the other layer cannot produce the case"
   * is precisely the coupling that let three delete paths drift apart in this
   * same audit. A guard that holds on its own survives a change to its neighbour.
   */
  it("writes nothing outside the audit root for a path-shaped session id", () => {
    activate(); // a legitimate session is recording at the same time
    const before = readFileSync(logFile(), "utf-8");
    const input = JSON.stringify({
      user_prompt: "audit mode",
      session_id: "a/../../escaped",
      cwd,
    });

    expect(run(shell, TRIGGER, input).code).toBe(0);
    expect(existsSync(join(root, "escaped.log"))).toBe(false);
    expect(existsSync(join(root, REPO, "escaped.log"))).toBe(false);
    // …and the real session's log is untouched.
    expect(readFileSync(logFile(), "utf-8")).toBe(before);
  });

  /**
   * The guard, isolated from the structural protection above.
   *
   * What makes the append REACHABLE is the TARGET FILE existing, not the
   * intermediate directory: the hook appends only `if [ -f "$log_file" ]`, and
   * `session-a/../../escaped` composes `<root>/escaped.log`. An earlier version
   * of this test seeded `<root>/<repo>/session-a/` instead — which only makes
   * the path RESOLVABLE — so the `[ -f ]` still failed, the `>>` was never
   * reached, and removing the guard left the suite green. It tested nothing.
   *
   * Seeding the target is the one arrangement under which the unguarded hook
   * really writes (measured: 69 bytes appended outside the repo's audit dir),
   * so it is the only arrangement in which this assertion means anything.
   */
  it("refuses a path-shaped id even when the escape target already exists", () => {
    activate();
    const before = readFileSync(logFile(), "utf-8");
    // Both halves of what the unguarded hook needs: the walked-through directory…
    mkdirSync(join(root, REPO, "session-a"), { recursive: true });
    // …and the file `[ -f "$log_file" ]` tests for.
    const target = join(root, "escaped.log");
    writeFileSync(target, "", "utf-8");
    const input = JSON.stringify({ user_prompt: "audit mode", session_id: "a/../../escaped", cwd });

    expect(run(shell, TRIGGER, input).code).toBe(0);
    // The guard refused, so the pre-seeded file is still empty…
    expect(readFileSync(target, "utf-8")).toBe("");
    // …and the real session's log is untouched.
    expect(readFileSync(logFile(), "utf-8")).toBe(before);
  });

  /**
   * Anti-false-green for the two cases above: if the guard rejected every id,
   * they would pass while the hook silently stopped working for everyone.
   */
  it("still records a legitimate session id (the guard is not a blanket refusal)", () => {
    activate();
    const before = readFileSync(logFile(), "utf-8");
    expect(run(shell, TRIGGER, payload("seguimos en audit mode")).code).toBe(0);
    expect(readFileSync(logFile(), "utf-8").length).toBeGreaterThan(before.length);
  });

  /**
   * With HOME stripped from the environment the two shells genuinely differ:
   * bash leaves it unset, so the hook cannot resolve an audit root and bails
   * silently; zsh REPOPULATES $HOME from the passwd entry, so the same hook
   * proceeds and emits its question. Both are acceptable — what must hold in
   * either case is the contract: exit 0, and nothing written anywhere.
   */
  it("exits 0 and writes nothing when HOME is unset", () => {
    let code = 0;
    try {
      execFileSync(shell, [TRIGGER], {
        input: payload("audit mode"),
        encoding: "utf-8",
        env: { PATH: process.env.PATH ?? "" },
      });
    } catch (e) {
      code = (e as { status?: number }).status ?? 1;
    }
    expect(code).toBe(0);
    expect(existsSync(logFile())).toBe(false);
    expect(existsSync(join(cwd, "session-sess1.log"))).toBe(false);
  });
});

describe.each(SHELLS)("audit-mode close under %s", (shell) => {
  const endPayload = JSON.stringify({
    session_id: "sess1",
    cwd: join(tmpdir(), REPO),
    reason: "clear",
    hook_event_name: "SessionEnd",
  });

  it("does nothing when the session was never marked", () => {
    const { code } = run(shell, CLOSE, endPayload);
    expect(code).toBe(0);
    expect(existsSync(logFile())).toBe(false);
  });

  it("seals an active log by appending, never rewriting", () => {
    activate();
    const before = readFileSync(logFile(), "utf-8");
    run(shell, CLOSE, endPayload);
    const after = readFileSync(logFile(), "utf-8");
    expect(after.startsWith(before)).toBe(true);
    expect(JSON.parse(after.trim().split("\n").pop() ?? "{}")).toMatchObject({
      event: "session-end",
      reason: "clear",
    });
  });
});

/**
 * Spec 0013, lote B — the harness records its own execution.
 *
 * A hook is only visible to the transcript when it BLOCKS or INJECTS; one that
 * runs and lets the action through leaves no trace at all. So `navori audit`
 * could never answer "did the gate run, and what did it cost?" — not from
 * missing parsing, but because the evidence did not exist. The harness now
 * writes it.
 *
 * These specs run the EXPANDED hook (`# navori:include` is a render-time
 * directive), because the raw asset is a file that exists nowhere.
 */
/** Every managed hook that carries the recorder, with the payload shape its
 *  phase actually receives. Derived from the assets, not hand-listed: a new
 *  hook that forgets the recorder must fail HERE (B3). */
function hooksWithRecorder(): string[] {
  const dirs = [HOOKS, resolve(HOOKS, "../../../plugins")];
  const found: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (
          entry.name.endsWith(".sh") &&
          readFileSync(full, "utf-8").includes("navori_audit_log")
        ) {
          found.push(full);
        }
      }
    }
  }
  return found.sort();
}

describe.each(SHELLS)("audit-mode hook recorder under %s", (shell) => {
  // Covers: R5
  it("wires the recorder into every managed hook that has a phase", () => {
    const wired = hooksWithRecorder().map((f) => f.split("/").pop());
    // The two audit-mode hooks write their own events; the partial itself is not
    // a hook. Everything else that Claude Code invokes must be here.
    for (const expected of [
      "guard-destructive.sh",
      "quality-gate-pre-commit.sh",
      "managed-drift-watch.sh",
      "session-start-context.sh",
      "subagent-stop-handoff.sh",
      "precompact-session-summary.sh",
      "worktree-reclaim.sh",
      "stop-verify-reminder.sh",
      "check-jscpd.sh",
      "check-semgrep.sh",
    ]) {
      expect(wired, `${expected} does not record its execution`).toContain(expected);
    }
  });

  // Covers: R6
  it("writes nothing and stays silent when audit-mode is off", () => {
    // No `activate()`: the log does not exist, which is every session that never
    // opted in. This is the path that must cost nothing.
    const hook = install(shell, join(HOOKS, "precompact-session-summary.sh"));
    const { code, out } = runFile(shell, hook, JSON.stringify({ session_id: "sess1", cwd }));
    expect(code).toBe(0);
    // The hook's OWN output is untouched — the recorder never writes to stdout,
    // where a stray byte would be read by the host as context injection.
    expect(out).toContain("additionalContext");
    expect(existsSync(logFile())).toBe(false);
  });

  // Covers: R5, R22
  it("records a hook that ran and decided it had nothing to do", () => {
    activate();
    const hook = install(shell, join(HOOKS, "worktree-reclaim.sh"));
    runFile(shell, hook, JSON.stringify({ session_id: "sess1", cwd }));
    const events = logEvents().filter((e) => e.event === "hook");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ name: "worktree-reclaim", phase: "SessionEnd" });
    // `skip` is the whole point: this sandbox is not a git repo, so the hook
    // bailed at its first guard. Without a recorded verdict that run would be
    // indistinguishable from the hook never having executed — and the default
    // is what makes a NEW early exit correct without anyone remembering to
    // wire it.
    expect(events[0]?.verdict).toBe("skip");
    expect(typeof events[0]?.ms).toBe("number");
  });

  // Covers: R7
  it("keeps the hook working when the log cannot be written", () => {
    activate();
    chmodSync(logFile(), 0o444);
    try {
      const hook = install(shell, join(HOOKS, "precompact-session-summary.sh"));
      const { code, out } = runFile(shell, hook, JSON.stringify({ session_id: "sess1", cwd }));
      // The hook's contract is fail-open ABSOLUTE. A recorder that can break the
      // thing it observes is the one defect this partial may never have.
      expect(code).toBe(0);
      expect(out).toContain("additionalContext");
    } finally {
      chmodSync(logFile(), 0o644);
    }
  });

  // Covers: R5
  it("carries the agent id when the payload states one", () => {
    activate();
    const hook = install(shell, join(HOOKS, "worktree-reclaim.sh"));
    runFile(shell, hook, JSON.stringify({ session_id: "sess1", cwd, agent_id: "ag_07" }));
    // Attribution by agent id, not by overlapping time windows: with agents
    // running in parallel the windows overlap and timestamps become a guess.
    expect(logEvents().find((e) => e.event === "hook")?.agentId).toBe("ag_07");
  });

  // Covers: R5
  it("names the plugin a hook came from, not just 'core'", () => {
    const semgrep = resolve(HOOKS, "../../../plugins/semgrep/scripts/check-semgrep.sh");
    // Disabling a plugin changes which hooks run; without `source` the report
    // cannot explain why a phase thinned out between two sessions.
    expect(readFileSync(semgrep, "utf-8")).toContain('navori_audit_source="plugin:semgrep"');
  });

  // Covers: R7
  it("survives being run with its includes UNexpanded", () => {
    activate();
    // A raw asset copy, or a render that half-finished: the include directive is
    // still a comment, so the recorder functions do not exist. Under `set -e` an
    // undefined function is exit 127 — which would kill the hook. The fallback
    // no-ops are what keep that from happening.
    const raw = readFileSync(join(HOOKS, "precompact-session-summary.sh"), "utf-8");
    const path = join(root, "unexpanded.sh");
    writeFileSync(path, raw, "utf-8");
    chmodSync(path, 0o755);
    const { code, out } = runFile(shell, path, JSON.stringify({ session_id: "sess1", cwd }));
    expect(code).toBe(0);
    expect(out).toContain("additionalContext");
  });
});

/**
 * The volume valve (spec 0013). `PreToolUse(Bash)` chains four hooks, so every
 * shell command leaves four lines and most are `skip`.
 */
describe.each(SHELLS)("audit-mode volume valve under %s", (shell) => {
  // Covers: R22
  it("records skip verdicts by default", () => {
    activate();
    const hook = install(shell, join(HOOKS, "worktree-reclaim.sh"));
    runFile(shell, hook, JSON.stringify({ session_id: "sess1", cwd }));
    expect(logEvents().filter((e) => e.event === "hook")).toHaveLength(1);
  });

  // Covers: R22
  it("drops them only when NAVORI_AUDIT_SKIP_NOOPS is explicitly set", () => {
    activate();
    const hook = install(shell, join(HOOKS, "worktree-reclaim.sh"));
    const before = logEvents().length;
    try {
      process.env.NAVORI_AUDIT_SKIP_NOOPS = "1";
      runFile(shell, hook, JSON.stringify({ session_id: "sess1", cwd }));
    } finally {
      process.env.NAVORI_AUDIT_SKIP_NOOPS = undefined;
    }
    // Opt-in, never the default: a `skip` is the only evidence separating "ran
    // and had nothing to do" from "never executed".
    expect(logEvents()).toHaveLength(before);
  });
});

/**
 * The defect this suite exists to prevent from recurring.
 *
 * `guard-destructive` closes its managed block BEFORE its `navori:user-section`.
 * The render only syncs what is inside the block, so a recorder call written
 * after the `end` marker lives in the user's own territory and NEVER reaches the
 * rendered mirror. That is how the most critical hook in the harness — the one
 * that blocks destructive commands — became the only one silently not
 * recording, while its asset looked perfectly wired.
 *
 * A test asserting "the asset calls the recorder" would have passed. What has to
 * be asserted is WHERE the call lives.
 */
describe("recorder calls live inside the managed block", () => {
  // Covers: R5
  it("never places a recorder call after the managed end marker", () => {
    const offenders: string[] = [];
    for (const file of hooksWithRecorder()) {
      const body = readFileSync(file, "utf-8");
      const endMarker = body.indexOf("navori:managed end");
      if (endMarker === -1) continue; // no managed block: nothing to fall out of
      const tail = body.slice(endMarker);
      // Assignments are fine out there — the trap that reads them is inside.
      // A CALL is not: it would never be rendered.
      if (/^\s*navori_audit_(log|begin)\b/m.test(tail)) offenders.push(file);
    }
    expect(
      offenders,
      "recorder call after the managed end marker: it will not be rendered",
    ).toEqual([]);
  });

  // Covers: R5
  it("keeps guard-destructive's verdict wired through its trap", () => {
    // The specific hook that broke, pinned: its block path must set a verdict,
    // and the recording must happen where the render can reach it.
    const body = readFileSync(join(HOOKS, "guard-destructive.sh"), "utf-8");
    const endMarker = body.indexOf("navori:managed end");
    expect(body.slice(0, endMarker)).toContain("trap navori_audit_on_exit EXIT");
    expect(body.slice(0, endMarker)).toContain('navori_audit_verdict="block"');
  });
});

/**
 * R21 — the only end-of-subagent mark the host lets a hook observe.
 *
 * There is NO subagent-start phase (the host offers PreToolUse, PostToolUse,
 * UserPromptSubmit, SessionStart, SessionEnd, Stop, SubagentStop, PreCompact),
 * so identity and duration keep coming from the transcript. What the log can
 * carry is that a subagent finished, and that is what this pins.
 */
describe.each(SHELLS)("subagent end is observable under %s", (shell) => {
  // Covers: R21
  it("records the SubagentStop hook when a subagent finishes", () => {
    activate();
    const hook = install(shell, join(HOOKS, "subagent-stop-handoff.sh"));
    runFile(shell, hook, JSON.stringify({ session_id: "sess1", cwd, agent_id: "ag_42" }));
    const event = logEvents().find((e) => e.event === "hook");
    expect(event).toMatchObject({ name: "subagent-stop-handoff", phase: "SubagentStop" });
    // The agent id rides along, so the end can be tied to the run the
    // transcript reconstructed.
    expect(event?.agentId).toBe("ag_42");
  });
});

/**
 * bash keeps exactly ONE EXIT trap. A hook that installs its own cleanup trap
 * after the recorder's silently discards it — and `check-jscpd` did, on the one
 * path where it does real work.
 */
describe("a hook's own EXIT trap must compose with the recorder's", () => {
  // Covers: R5
  it("never replaces the recorder trap with a bare one", () => {
    const offenders: string[] = [];
    for (const file of hooksWithRecorder()) {
      const body = readFileSync(file, "utf-8");
      if (!body.includes("trap navori_audit_on_exit EXIT")) continue;
      // Any OTHER EXIT trap in the same file must call the recorder too.
      for (const m of body.matchAll(/^\s*trap\s+(.+?)\s+EXIT\s*$/gm)) {
        const handler = m[1] ?? "";
        if (handler === "navori_audit_on_exit") continue;
        if (!handler.includes("navori_audit_on_exit")) offenders.push(`${file}: ${handler}`);
      }
    }
    expect(offenders, "this EXIT trap overwrites the recorder's").toEqual([]);
  });
});

/**
 * #560 — the host fires `SubagentStop` far more often than subagents finish.
 *
 * Measured on session `bd3aef2d` (19 subagents): 117 executions of this hook,
 * every one of them `dirty` with the SAME reason, i.e. the identical
 * `systemMessage` injected 117 times for one broken handoff file. The hook is
 * registered once — the extra firings come from the host, and 102 of the 112
 * `agent_id`s it sent match nothing under `~/.claude` — so the harness cannot
 * fire less. What it can do is stop re-telling the reader something already
 * told, which is the part that costs context.
 *
 * The run is still recorded on every firing (verdict `repeat`): "the check ran
 * and found the same thing" is the evidence the audit exists to keep.
 */
describe.each(SHELLS)("the handoff note is said once per problem under %s", (shell) => {
  const STOP = () => JSON.stringify({ session_id: "sess1", cwd, agent_id: "ag_1" });
  const progressDir = (): string => join(root, ".claude", "progress");

  /** An `impl_*.md` with no `Status:` line — the shape the hook flags. */
  function brokenHandoff(name = "impl_feature.md"): void {
    mkdirSync(progressDir(), { recursive: true });
    writeFileSync(join(progressDir(), name), "# report\n\nwork done\n", "utf-8");
  }

  function fixHandoff(name = "impl_feature.md"): void {
    writeFileSync(join(progressDir(), name), "# report\n\nStatus: done\n", "utf-8");
  }

  function verdicts(): unknown[] {
    return logEvents()
      .filter((e) => e.name === "subagent-stop-handoff")
      .map((e) => e.verdict);
  }

  it("injects the message once and records the repeat", () => {
    activate();
    brokenHandoff();
    const hook = install(shell, join(HOOKS, "subagent-stop-handoff.sh"));

    const first = runFile(shell, hook, STOP());
    const second = runFile(shell, hook, STOP());
    const third = runFile(shell, hook, STOP());

    expect(first.out).toContain("systemMessage");
    expect(second.out).toBe("");
    expect(third.out).toBe("");
    // Silent, not absent: every firing is still on the record.
    expect(verdicts()).toEqual(["dirty", "repeat", "repeat"]);
  });

  it("speaks again when a NEW problem appears", () => {
    activate();
    brokenHandoff();
    const hook = install(shell, join(HOOKS, "subagent-stop-handoff.sh"));
    runFile(shell, hook, STOP());

    brokenHandoff("impl_second.md");
    const out = runFile(shell, hook, STOP()).out;
    expect(out).toContain("systemMessage");
    expect(out).toContain("impl_second.md");
  });

  it("speaks again when a fixed handoff breaks a second time", () => {
    activate();
    brokenHandoff();
    const hook = install(shell, join(HOOKS, "subagent-stop-handoff.sh"));
    runFile(shell, hook, STOP());

    fixHandoff();
    expect(runFile(shell, hook, STOP()).out).toBe("");
    // A recurrence is news: the clean run clears what was remembered.
    brokenHandoff();
    expect(runFile(shell, hook, STOP()).out).toContain("systemMessage");
    expect(verdicts()).toEqual(["dirty", "clean", "dirty"]);
  });

  it("never silences a different session", () => {
    activate();
    activate("sess2");
    brokenHandoff();
    const hook = install(shell, join(HOOKS, "subagent-stop-handoff.sh"));
    runFile(shell, hook, STOP());

    const other = JSON.stringify({ session_id: "sess2", cwd, agent_id: "ag_9" });
    expect(runFile(shell, hook, other).out).toContain("systemMessage");
  });

  it("still reports when the payload carries no session id", () => {
    // Fail-open: an unkeyable firing must warn rather than stay quiet.
    activate();
    brokenHandoff();
    const hook = install(shell, join(HOOKS, "subagent-stop-handoff.sh"));
    expect(runFile(shell, hook, JSON.stringify({ cwd })).out).toContain("systemMessage");
  });
});
