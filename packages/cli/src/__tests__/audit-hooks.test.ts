import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expandHookIncludes } from "../lib/render/hook-includes.ts";

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
let recorderBin: string;

function run(
  shell: string,
  hook: string,
  payload: string,
  pathOverride?: string,
): { out: string; code: number } {
  try {
    const out = execFileSync(shell, [install(shell, hook)], {
      input: payload,
      encoding: "utf-8",
      env: {
        ...process.env,
        NAVORI_AUDITS_ROOT: root,
        PATH: pathOverride ?? `${recorderBin}:${process.env.PATH ?? ""}`,
      },
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
function install(_shell: string, assetPath: string, auditMode = "opt-in"): string {
  const raw = expandHookIncludes(readFileSync(assetPath, "utf-8"))
    .replace("{{shq:branchBase}}", "'main'")
    // The default mirrors the schema's: a repo that never declares `audit.mode`
    // must behave exactly as it did before the field existed.
    .replace("{{shq:audit.mode}}", `'${auditMode}'`);
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
        PATH: `${recorderBin}:${dirname(process.execPath)}:/usr/bin:/bin:${process.env.PATH ?? ""}`,
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

/**
 * A broken handoff under the dir `runFile` runs in, so `subagent-stop-handoff`
 * takes its INJECTING path and puts `additionalContext` on stdout.
 *
 * The recorder cases below need a hook that emits into the model's channel and
 * needs no git repo; until #774 that role was played by the PreCompact
 * reminder, which was retired precisely because its channel never delivered.
 */
function seedBrokenHandoff(): void {
  mkdirSync(join(root, ".claude", "progress"), { recursive: true });
  writeFileSync(join(root, ".claude", "progress", "impl_x.md"), "# impl\nno terminal marker\n");
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
  // Transparent transport stub only: FD/privacy authorization is tested by the
  // real CLI writer, not claimed by these hook behavior fixtures.
  recorderBin = join(root, "recorder-bin");
  mkdirSync(recorderBin);
  writeFileSync(
    join(recorderBin, "navori"),
    `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2);
if (!args.includes("--record-metadata")) process.exit(0);
const field = name => args[args.indexOf(name) + 1];
const record = JSON.parse(fs.readFileSync(0, "utf8"));
fs.appendFileSync(path.join(field("--root"), "transport-calls.jsonl"), JSON.stringify({args,record}) + "\\n");
const dir = path.join(field("--root"), field("--repo"));
const marker = path.join(dir, "session-" + field("--root-session") + ".log");
if (fs.existsSync(marker)) fs.appendFileSync(marker, JSON.stringify(record) + "\\n");
else if (record.phase === "SessionStart" && fs.existsSync(path.join(dir, ".armed"))) fs.appendFileSync(path.join(dir, "pending-" + field("--root-session") + ".jsonl"), JSON.stringify(record) + "\\n");
process.stdout.write("ignored recorder output");
`,
  );
  chmodSync(join(recorderBin, "navori"), 0o755);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe.each(SHELLS)("native Codex child capture under %s", (shell) => {
  /** Execute the canonical expanded hook with a transparent capture CLI stub. */
  function capture(
    event: "SubagentStart" | "SubagentStop",
    fields: Record<string, unknown> = {},
    code = 0,
    engine = "codex",
    executable = true,
  ): { out: string; calls: string[] } {
    const project = join(root, REPO);
    const hookDir = join(root, `.${engine}`, "hooks");
    const bin = join(root, "capture-bin");
    mkdirSync(project, { recursive: true });
    mkdirSync(hookDir, { recursive: true });
    mkdirSync(bin, { recursive: true });
    const callsFile = join(root, "capture-args");
    const stub = join(bin, "navori");
    if (executable) {
      writeFileSync(
        stub,
        `#!/bin/sh\nprintf '%s\\n' "$@" >> "$NAVORI_CAPTURE_TEST_ARGS"\nprintf 'suppressed capture stdout'\nexit ${code}\n`,
      );
      chmodSync(stub, 0o755);
    }
    const hook = join(hookDir, "subagent-stop-handoff.sh");
    writeFileSync(
      hook,
      expandHookIncludes(readFileSync(join(HOOKS, "subagent-stop-handoff.sh"), "utf-8")),
    );
    const out = execFileSync(
      shell,
      [hook, "codex", ...(event === "SubagentStart" ? ["capture-start"] : [])],
      {
        cwd: root,
        encoding: "utf-8",
        input: JSON.stringify({
          hook_event_name: event,
          session_id: "sess1",
          agent_id: "child1",
          cwd: project,
          transcript_path: "/private/parent.jsonl",
          agent_transcript_path: "/private/child.jsonl",
          ...fields,
        }),
        env: {
          ...process.env,
          HOME: join(root, "home"),
          NAVORI_AUDITS_ROOT: root,
          NAVORI_CAPTURE_TEST_ARGS: callsFile,
          CLAUDE_PROJECT_DIR: project,
          TMPDIR: root,
          PATH: executable
            ? `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`
            : `${bin}:/usr/bin:/bin`,
        },
      },
    );
    return {
      out,
      calls: existsSync(callsFile) ? readFileSync(callsFile, "utf-8").trim().split("\n") : [],
    };
  }

  // Covers: R4, R5, R8, R9
  it("passes distinct root/thread and startup child source, before any handoff/trap output", () => {
    activate();
    seedBrokenHandoff();
    const before = readFileSync(logFile(), "utf-8");
    const result = capture("SubagentStart", { transcript_path: "/private/start child.jsonl" });
    expect(result.calls).toEqual([
      "audit",
      "--capture-child",
      "child1",
      "--root-session",
      "sess1",
      "--rollout",
      "/private/start child.jsonl",
      "--cwd",
      join(root, REPO),
    ]);
    expect(result.out).toBe("");
    expect(readFileSync(logFile(), "utf-8")).toBe(before);
    expect(readdirSync(root).some((name) => name.startsWith("navori-handoff-"))).toBe(false);
  });

  // Covers: R8, R9
  it("does not spawn capture merely because a previous audit directory exists", () => {
    activate("other-root");
    const before = readFileSync(logFile("other-root"), "utf-8");
    expect(capture("SubagentStart")).toEqual({ out: "", calls: [] });
    expect(readFileSync(logFile("other-root"), "utf-8")).toBe(before);
    expect(existsSync(logFile())).toBe(false);
  });

  // Covers: R4, R5, R8, R9
  it("uses the stop child source and keeps advisory capture failure out of handoff stdout", () => {
    activate();
    seedBrokenHandoff();
    const result = capture("SubagentStop", {}, 7);
    expect(result.calls).toContain("/private/child.jsonl");
    expect(result.calls).not.toContain("/private/parent.jsonl");
    expect(result.out).not.toContain("suppressed capture stdout");
    const output = JSON.parse(result.out) as Record<string, unknown>;
    expect(output.systemMessage).toBeTruthy();
    // Native Codex Stop preserves its systemMessage-only advisory contract.
    expect(Object.keys(output)).toEqual(["systemMessage"]);
    expect(output.systemMessage).toContain("impl_x.md");
  });

  // Covers: R4, R8, R9
  it("never substitutes the stop parent transcript for a missing child path", () => {
    activate();
    const { calls } = capture("SubagentStop", { agent_transcript_path: "" });
    expect(calls).not.toContain("--capture-child");
    expect(calls).not.toContain("/private/parent.jsonl");
  });

  // Covers: R8, R9
  it("keeps failed startup silent without scanning malformed handoffs", () => {
    activate();
    seedBrokenHandoff();
    expect(capture("SubagentStart", {}, 7).out).toBe("");
    expect(readdirSync(root).some((name) => name.startsWith("navori-handoff-"))).toBe(false);
  });

  // Covers: R8, R9
  it("remains advisory when the capture CLI is missing", () => {
    activate();
    expect(capture("SubagentStart", {}, 0, "codex", false)).toEqual({ out: "", calls: [] });
  });

  // Covers: R8, R9
  it("does not add capture to Claude events or unsafe root/thread identifiers", () => {
    activate();
    expect(capture("SubagentStart", {}, 0, "claude").calls).toEqual([]);
    expect(capture("SubagentStart", { session_id: "../sess1" }).calls).toEqual([]);
    expect(capture("SubagentStart", { agent_id: "bad/child" }).calls).toEqual([]);
  });
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
  it.each([["user_prompt"], ["prompt"]])("records the typed text length under .%s", (key) => {
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
      kind: "user",
      length: "arregla el login".length,
    });
  });

  // #774: the preference is on the DOCUMENTED key. `prompt` is the field the
  // UserPromptSubmit contract names; `user_prompt` is a spelling a real payload
  // carried and the docs never mention, so it stays a fallback and stops being
  // the winner.
  it("prefers the documented .prompt when the host sends both", () => {
    activate();
    const input = JSON.stringify({
      user_prompt: "el no documentado",
      prompt: "el documentado",
      session_id: "sess1",
      cwd,
    });
    run(shell, TRIGGER, input);
    const last = readFileSync(logFile(), "utf-8").trim().split("\n").at(-1);
    expect(JSON.parse(last ?? "{}")).toMatchObject({
      kind: "user",
      length: "el documentado".length,
    });
  });

  // Covers: R10, R11
  it("does not transport private transcript paths", () => {
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
    expect(JSON.parse(last ?? "{}")).not.toHaveProperty("transcript");
    expect(readFileSync(join(root, "transport-calls.jsonl"), "utf-8")).not.toContain("/Users/x/");
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
      kind: "user",
      length: "haz la tarea".length,
    });
  });

  it("never writes outside the audit root", () => {
    run(shell, TRIGGER, payload("audit mode"));
    expect(existsSync(join(cwd, "session-sess1.log"))).toBe(false);
  });

  it("normalizes agent worktree cwd to parent repo instead of phantom agent directory (#764)", () => {
    activate();
    const wtCwd = join(cwd, ".claude", "worktrees", "agent-a2a999b59fde9ce6c");
    const input = JSON.stringify({
      user_prompt: "prompt in worktree",
      session_id: "sess1",
      cwd: wtCwd,
      hook_event_name: "UserPromptSubmit",
    });
    run(shell, TRIGGER, input);
    const last = readFileSync(logFile(), "utf-8").trim().split("\n").at(-1);
    expect(JSON.parse(last ?? "{}")).toMatchObject({
      kind: "user",
      length: "prompt in worktree".length,
    });
    expect(existsSync(join(root, "agent-a2a999b59fde9ce6c"))).toBe(false);
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
   * The hook's first move is `[ -n "$HOME" ] || exit 0`: with no usable HOME it
   * cannot resolve an audit root, and it must bail silently rather than compose
   * a path from an empty string. The contract: exit 0, nothing written anywhere.
   *
   * HOME is passed EMPTY, not omitted (#954). Omitting it splits the shells —
   * bash leaves it unset, but zsh REPOPULATES $HOME from the passwd entry, which
   * points at the developer's real home, outside the ephemeral HOME the suite
   * runs under and therefore outside the isolation guard's view. An explicit
   * empty value is the same branch of the hook (`-n` is false either way) and
   * both shells honour it, so the case tests what it says and can't escape.
   */
  it("exits 0 and writes nothing when HOME is empty", () => {
    let code = 0;
    try {
      execFileSync(shell, [install(shell, TRIGGER)], {
        input: payload("audit mode"),
        encoding: "utf-8",
        env: { PATH: process.env.PATH ?? "", HOME: "" },
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

  it("normalizes agent worktree cwd in close hook (#764)", () => {
    activate();
    const wtPayload = JSON.stringify({
      session_id: "sess1",
      cwd: join(tmpdir(), REPO, ".claude", "worktrees", "agent-a2a999b59fde9ce6c"),
      reason: "clear",
      hook_event_name: "SessionEnd",
    });
    run(shell, CLOSE, wtPayload);
    const after = readFileSync(logFile(), "utf-8");
    expect(JSON.parse(after.trim().split("\n").pop() ?? "{}")).toMatchObject({
      event: "session-end",
      reason: "clear",
    });
    expect(existsSync(join(root, "agent-a2a999b59fde9ce6c"))).toBe(false);
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

describe("canonical audit metadata filter", () => {
  // Covers: R9, R11
  it("compiles the real jq filter and returns only bounded metadata", () => {
    const source = readFileSync(join(HOOKS, "_partials/audit-log.sh"), "utf-8");
    const filter = source.match(/--argjson tsMs "\$navori_audit_end" '([\s\S]*?)' 2>\/dev\/null/);
    expect(filter?.[1]).toBeTruthy();
    const secret = "SECRET-user@example.test";
    const result = spawnSync(
      "jq",
      [
        "-c",
        "--arg",
        "name",
        "worktree-reclaim",
        "--arg",
        "phase",
        "SessionEnd",
        "--arg",
        "verdict",
        "skip",
        "--arg",
        "reason",
        secret,
        "--arg",
        "tool",
        "Bash",
        "--arg",
        "source",
        "/private/secret",
        "--arg",
        "kind",
        "advisory",
        "--argjson",
        "ms",
        "12",
        "--argjson",
        "tsMs",
        "1756116000000",
        filter?.[1] ?? "",
      ],
      {
        input: JSON.stringify({ agent_id: "child1", tool_use_id: "tool_123", prompt: secret }),
        encoding: "utf-8",
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      event: "hook",
      name: "worktree-reclaim",
      source: "unknown",
      phase: "SessionEnd",
      verdict: "skip",
      agentId: "child1",
      toolUseId: "tool_123",
      tool: "Bash",
      kind: "advisory",
      reason: "unspecified",
      ms: 12,
      tsMs: 1756116000000,
    });
    expect(result.stdout).not.toContain(secret);
    expect(result.stdout).not.toContain("/private/secret");
  });
});

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
    seedBrokenHandoff();
    const hook = install(shell, join(HOOKS, "subagent-stop-handoff.sh"));
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

  // Covers: R5
  it("records tsMs, the only field that can order two events of one second (#685)", () => {
    activate();
    const before = Date.now();
    const hook = install(shell, join(HOOKS, "worktree-reclaim.sh"));
    runFile(shell, hook, JSON.stringify({ session_id: "sess1", cwd }));
    const event = logEvents().find((e) => e.event === "hook");
    expect(typeof event?.tsMs).toBe("number");
    // Checked against this process's clock and no longer against a `ts` in the
    // record, because there is none: what the assertion has to catch is a zero
    // left by the `-ge 0` guard, which is what a broken clock produces.
    expect(Number(event?.tsMs)).toBeGreaterThanOrEqual(before - 2000);
    expect(Number(event?.tsMs)).toBeLessThanOrEqual(Date.now() + 2000);
  });

  // Covers: R5
  it("no gasta un fork de `date` por evento de hook (#696)", () => {
    activate();
    const hook = install(shell, join(HOOKS, "worktree-reclaim.sh"));
    runFile(shell, hook, JSON.stringify({ session_id: "sess1", cwd }));
    const event = logEvents().find((e) => e.event === "hook");
    // `ts` is gone from the hot path: 46,850 events in this store, one `date`
    // fork each, for a string fully derivable from `tsMs`. The file's own cost
    // doctrine says spend a process only when there is no other way.
    expect(event).not.toHaveProperty("ts");
    expect(typeof event?.tsMs).toBe("number");
  });

  // Covers: R7
  it("keeps the hook working when the log cannot be written", () => {
    activate();
    seedBrokenHandoff();
    chmodSync(logFile(), 0o444);
    try {
      const hook = install(shell, join(HOOKS, "subagent-stop-handoff.sh"));
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
    seedBrokenHandoff();
    // A raw asset copy, or a render that half-finished: the include directive is
    // still a comment, so the recorder functions do not exist. Under `set -e` an
    // undefined function is exit 127 — which would kill the hook. The fallback
    // no-ops are what keep that from happening.
    const raw = readFileSync(join(HOOKS, "subagent-stop-handoff.sh"), "utf-8");
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
 *
 * The mark moved from `SubagentStop` to `PostToolUse` on the `Agent` tool in
 * #774 — the event whose context reaches the parent, and the one that fires
 * exactly once per return instead of the 117-for-19 #560 measured. The phase
 * recorded moves with it; what R21 asks for (the END is in the log) does not.
 */
describe.each(SHELLS)("subagent end is observable under %s", (shell) => {
  // Covers: R21
  it("records the handoff hook, on PostToolUse, when a subagent returns", () => {
    activate();
    const hook = install(shell, join(HOOKS, "subagent-stop-handoff.sh"));
    runFile(
      shell,
      hook,
      JSON.stringify({ session_id: "sess1", cwd, agent_id: "ag_42", tool_name: "Agent" }),
    );
    const event = logEvents().find((e) => e.event === "hook");
    expect(event).toMatchObject({ name: "subagent-stop-handoff", phase: "PostToolUse" });
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

  /**
   * #606 — the hook policed the whole directory, which nothing prunes.
   *
   * Handoffs written under an older format failed the check forever: 44 stale
   * files in one measured repo, 19 in another, and in all four the `clean`
   * verdict was unreachable. The window is what makes the check about the
   * handoff that just landed instead of about a month of closed work.
   */
  function ageFile(name: string, daysOld: number): void {
    const when = new Date(Date.now() - daysOld * 86400 * 1000);
    utimesSync(join(progressDir(), name), when, when);
  }

  it("ignores a broken handoff from a closed piece of work", () => {
    activate();
    brokenHandoff("impl_agosto.md");
    ageFile("impl_agosto.md", 30);
    const hook = install(shell, join(HOOKS, "subagent-stop-handoff.sh"));

    expect(runFile(shell, hook, STOP()).out).toBe("");
    // And `clean` becomes reachable again, which is the verdict this hook says
    // is the whole point of recording it.
    expect(verdicts()).toEqual(["clean"]);
  });

  it("keeps checking a handoff written earlier in a long session", () => {
    // Sessions of 10h41m were measured; the window is 48h so an early handoff
    // is still policed when the session ends.
    activate();
    brokenHandoff("impl_temprano.md");
    ageFile("impl_temprano.md", 1);
    const hook = install(shell, join(HOOKS, "subagent-stop-handoff.sh"));

    expect(runFile(shell, hook, STOP()).out).toContain("impl_temprano.md");
  });

  it("does not let a stale file bury the warning about a fresh one", () => {
    // The stamp compares the whole problem string, so an old permanent failure
    // rode along on every message and re-fired when the real one was fixed.
    activate();
    brokenHandoff("impl_agosto.md");
    ageFile("impl_agosto.md", 30);
    brokenHandoff("impl_hoy.md");
    const hook = install(shell, join(HOOKS, "subagent-stop-handoff.sh"));

    const out = runFile(shell, hook, STOP()).out;
    expect(out).toContain("impl_hoy.md");
    expect(out).not.toContain("impl_agosto.md");
  });
});
/** Real CLI-backed opt-in consumption across both consumers, engines and shells. */
describe.each(SHELLS)("checked armed consumption under %s", (shell) => {
  describe.each(["claude", "codex"] as const)("%s", (engine) => {
    describe.each(["session-start-context.sh", "audit-mode-trigger.sh"])("%s", (consumer) => {
      let hook: string;
      let bin: string;
      let armFile: string;
      let auditDir: string;
      let calls: string;

      beforeEach(() => {
        bin = join(root, "real-bin");
        mkdirSync(bin);
        calls = join(root, "real-calls");
        const cli = resolve(fileURLToPath(new URL("../../dist/index.js", import.meta.url)));
        writeFileSync(
          join(bin, "navori"),
          `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexec '${process.execPath}' '${cli}' "$@"\n`,
        );
        chmodSync(join(bin, "navori"), 0o755);
        const installed = install(shell, join(HOOKS, consumer), "opt-in");
        hook = join(root, `.${engine}`, "hooks", consumer);
        mkdirSync(dirname(hook), { recursive: true });
        writeFileSync(hook, readFileSync(installed));
        chmodSync(hook, 0o755);
        chmodSync(root, 0o700);
        auditDir = join(root, REPO);
        mkdirSync(auditDir, { mode: 0o700 });
        armFile = join(auditDir, ".armed");
        writeFileSync(armFile, JSON.stringify({ ts: "2026-09-07T00:00:00Z", cwd }) + "\n", {
          mode: 0o600,
        });
      });

      /** Run the full installed hook with the actual built CLI on PATH. */
      function invoke(id: string): { out: string; status: number | null } {
        const result = spawnSync(shell, [hook], {
          input: JSON.stringify({
            session_id: id,
            cwd,
            user_prompt: "continue",
            hook_event_name:
              consumer === "audit-mode-trigger.sh" ? "UserPromptSubmit" : "SessionStart",
          }),
          encoding: "utf8",
          cwd: root,
          env: {
            ...process.env,
            NAVORI_AUDITS_ROOT: root,
            TMPDIR: root,
            CLAUDE_PROJECT_DIR: root,
            PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
          },
        });
        return { out: result.stdout + result.stderr, status: result.status };
      }

      // Covers: R1, R9, R10
      it("consumes a private arm and activates the exact engine session once", () => {
        const result = invoke("armed-real");
        expect(result.status).toBe(0);
        expect(result.out).toContain("audit-mode ACTIVE");
        expect(existsSync(armFile)).toBe(false);
        const header = JSON.parse(
          readFileSync(join(auditDir, "session-armed-real.log"), "utf8").split("\n")[0] ?? "",
        ) as Record<string, unknown>;
        expect(header.host).toBe(engine);
        expect(readFileSync(calls, "utf8")).toContain("--consume-arm --start armed-real");
        expect(invoke("second").out).not.toContain("audit-mode ACTIVE");
        expect(existsSync(join(auditDir, "session-second.log"))).toBe(false);
      });

      // Covers: R10
      it("consumes only the valid arm even when the destination refuses start", () => {
        const destination = join(auditDir, "session-failed.log");
        writeFileSync(destination, "public sentinel\n", { mode: 0o644 });
        expect(invoke("failed").out).not.toContain("audit-mode ACTIVE");
        expect(existsSync(armFile)).toBe(false);
        expect(readFileSync(destination, "utf8")).toBe("public sentinel\n");
        expect(statSync(destination).mode & 0o777).toBe(0o644);
      });

      // Covers: R10
      it.each([
        "missing",
        "public-leaf",
        "public-parent",
        "public-root",
        "leaf-symlink",
        "parent-symlink",
        "malformed",
        "truncated",
        "utf8",
        "overlimit",
        "wrong-project",
      ])("preserves refused %s arm", (kind) => {
        const good = readFileSync(armFile);
        if (kind === "missing") unlinkSync(armFile);
        if (kind === "public-leaf") chmodSync(armFile, 0o644);
        if (kind === "public-parent") chmodSync(auditDir, 0o755);
        if (kind === "public-root") chmodSync(root, 0o755);
        if (kind === "leaf-symlink") {
          const target = join(root, "arm-target");
          writeFileSync(target, good, { mode: 0o600 });
          unlinkSync(armFile);
          symlinkSync(target, armFile);
        }
        if (kind === "parent-symlink") {
          const target = join(root, "arm-dir");
          renameSync(auditDir, target);
          symlinkSync(target, auditDir);
        }
        if (kind === "malformed") writeFileSync(armFile, "{}\n");
        if (kind === "truncated") writeFileSync(armFile, good.subarray(0, good.length - 1));
        if (kind === "utf8") writeFileSync(armFile, Buffer.from([0xff, 10]));
        if (kind === "overlimit") writeFileSync(armFile, " ".repeat(2049) + "\n");
        if (kind === "wrong-project") {
          const other = join(root, "other", REPO);
          mkdirSync(other, { recursive: true });
          writeFileSync(armFile, JSON.stringify({ ts: "2026-09-07T00:00:00Z", cwd: other }) + "\n");
        }
        const before = kind === "missing" ? null : readFileSync(armFile);
        const mode = kind === "missing" ? null : lstatSync(armFile).mode;
        const result = invoke("refused");
        expect(result.status).toBe(0);
        expect(result.out).not.toContain("audit-mode ACTIVE");
        expect(existsSync(join(auditDir, "session-refused.log"))).toBe(false);
        if (before) {
          expect(readFileSync(armFile)).toEqual(before);
          expect(lstatSync(armFile).mode).toBe(mode);
        }
      });

      // Covers: R10
      it("allows only the exclusive claimant to activate after synchronized readiness", async () => {
        const barrier = join(root, "claim-barrier");
        mkdirSync(barrier);
        const preload = join(root, "claim-barrier.mjs");
        writeFileSync(
          preload,
          `
          import fs from "node:fs";
          import {join} from "node:path";
          import {syncBuiltinESMExports} from "node:module";
          if (process.argv.includes("--consume-arm")) {
            const open = fs.openSync, directory = ${JSON.stringify(barrier)};
            fs.openSync = (path, ...args) => {
              if (String(path).endsWith("/.armed.claim")) {
                fs.writeFileSync(join(directory, String(process.pid)), "ready");
                const deadline = Date.now() + 3000;
                while (fs.readdirSync(directory).length < 2) {
                  if (Date.now() > deadline) throw new Error("claim-barrier-timeout");
                  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
                }
              }
              return open(path, ...args);
            };
            syncBuiltinESMExports();
          }
        `,
        );
        const runConcurrent = (id: string): Promise<string> =>
          new Promise((resolveRun, rejectRun) => {
            const child = spawn(shell, [hook], {
              cwd: root,
              env: {
                ...process.env,
                NAVORI_AUDITS_ROOT: root,
                NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${preload}`,
                TMPDIR: root,
                CLAUDE_PROJECT_DIR: root,
                PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
              },
            });
            let output = "";
            child.stdout.on("data", (bytes: Buffer) => {
              output += bytes.toString();
            });
            child.stderr.on("data", (bytes: Buffer) => {
              output += bytes.toString();
            });
            child.on("error", rejectRun);
            child.on("close", (code: number | null) =>
              code === 0 ? resolveRun(output) : rejectRun(new Error("hook failed")),
            );
            child.stdin.end(
              JSON.stringify({
                session_id: id,
                cwd,
                user_prompt: "continue",
                hook_event_name: "SessionStart",
              }),
            );
          });
        const output = await Promise.all([
          runConcurrent("contender-a"),
          runConcurrent("contender-b"),
        ]);
        expect(
          output.filter((value) => value.includes("audit-mode ACTIVE")),
          JSON.stringify({
            output,
            files: readdirSync(auditDir),
            calls: readFileSync(calls, "utf8"),
          }),
        ).toHaveLength(1);
        expect(
          readdirSync(auditDir).filter((name) => name.startsWith("session-contender-")),
        ).toHaveLength(1);
        expect(existsSync(armFile)).toBe(false);
        expect(readdirSync(barrier)).toHaveLength(2);
        expect(existsSync(join(auditDir, ".armed.claim"))).toBe(false);
      });
    });
  });
});
/**
 * `audit.mode = "always"` — coverage that does not wait on anyone remembering.
 *
 * The field exists because opt-in coverage was measured and it is thin: of 187
 * real sessions only 54 carried a log, so the instrument observed 39% of the
 * work (15,362 tool calls of 39,065). The two arms of a controlled A/B sat at
 * 0% — the one place the measurement was supposed to decide something.
 *
 * These tests pin the three properties that make it safe to turn on: it starts
 * without a flag, it starts ONCE, and it never becomes the reason a prompt
 * fails.
 */
describe.each(SHELLS)("audit.mode = always under %s", (shell) => {
  let navoriCalls: string;
  let shimDir: string;

  function installNavoriShim(exitCode = 0): void {
    shimDir = join(root, "shim-bin");
    mkdirSync(shimDir, { recursive: true });
    navoriCalls = join(root, "navori-calls.log");
    writeFileSync(
      join(shimDir, "navori"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${navoriCalls}"\nexit ${exitCode}\n`,
      "utf-8",
    );
    chmodSync(join(shimDir, "navori"), 0o755);
  }

  function runTrigger(
    sessionId: string,
    mode: string,
    engine: "claude" | "codex" = "claude",
  ): { out: string; code: number } {
    const installed = install(shell, TRIGGER, mode);
    const hook =
      engine === "codex" ? join(root, ".codex", "hooks", "audit-mode-trigger.sh") : installed;
    if (engine === "codex") {
      mkdirSync(dirname(hook), { recursive: true });
      writeFileSync(hook, readFileSync(installed, "utf-8"));
      chmodSync(hook, 0o755);
    }
    const input = JSON.stringify({ user_prompt: "arranca el ticket", session_id: sessionId, cwd });
    try {
      const out = execFileSync(shell, [hook], {
        input,
        encoding: "utf-8",
        cwd: root,
        env: {
          ...process.env,
          NAVORI_AUDITS_ROOT: root,
          TMPDIR: root,
          PATH: `${shimDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
        },
      });
      return { out, code: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      return { out: (e.stdout ?? "") + (e.stderr ?? ""), code: e.status ?? -1 };
    }
  }

  const startCalls = () =>
    (existsSync(navoriCalls) ? readFileSync(navoriCalls, "utf-8") : "")
      .split("\n")
      .filter((l) => l.includes("audit --start"));

  it("starts the recorder on the first prompt, with no flag armed", () => {
    installNavoriShim();
    const { out, code } = runTrigger("sess-always-1", "always");
    expect(code).toBe(0);
    expect(startCalls().join("\n")).toContain("audit --start sess-always-1");
    expect(startCalls().join("\n")).toContain("--host claude");
    // stdout is injected as context, so the model learns it is being recorded.
    expect(out).toContain("audit-mode ACTIVE");
  });

  // Covers: R1
  it("stamps Codex in audit.mode=always rather than assuming Claude", () => {
    installNavoriShim();
    const { code } = runTrigger("cx-always-1", "always", "codex");
    expect(code).toBe(0);
    expect(startCalls().join("\n")).toContain("audit --start cx-always-1");
    expect(startCalls().join("\n")).toContain("--host codex");
  });

  it("starts ONCE — a session already recording is not re-started every prompt", () => {
    installNavoriShim();
    activate("sess-always-2");
    const { out, code } = runTrigger("sess-always-2", "always");
    expect(code).toBe(0);
    // The `! -f "$log_file"` guard is what makes this idempotent: without it the
    // hook would shell out to `navori` on every single prompt of every session.
    expect(startCalls()).toEqual([]);
    expect(out).toBe("");
  });

  it("opt-in behaves exactly as before the field existed", () => {
    installNavoriShim();
    const { out, code } = runTrigger("sess-optin-1", "opt-in");
    expect(code).toBe(0);
    expect(startCalls()).toEqual([]);
    expect(out).toBe("");
  });

  it("a failed start leaves the session unrecorded, and the prompt still succeeds", () => {
    installNavoriShim(1);
    const { code, out } = runTrigger("sess-always-3", "always");
    // FAIL-OPEN ABSOLUTE: a recorder may never be the reason a prompt fails.
    expect(code).toBe(0);
    expect(out).not.toContain("audit-mode ACTIVE");
    expect(logEvents("sess-always-3")).toEqual([]);
  });
});

/** The transport is observed through a stub; private persistence is CLI-owned. */
describe.each(SHELLS)("private metadata transport under %s", (shell) => {
  function calls(): Array<{ args: string[]; record: Record<string, unknown> }> {
    const file = join(root, "transport-calls.jsonl");
    return existsSync(file)
      ? readFileSync(file, "utf-8")
          .trim()
          .split("\n")
          .map(
            (line: string) =>
              JSON.parse(line) as { args: string[]; record: Record<string, unknown> },
          )
      : [];
  }

  /** Exercise the canonical partial without invoking unrelated hook logic. */
  function recorder(phase: string, reason = ""): string {
    const script = join(root, "recorder.sh");
    writeFileSync(
      script,
      expandHookIncludes(`#!/bin/bash
set -eu
# navori:include audit-repo
# navori:include audit-log
payload=$(cat)
navori_audit_phase=${JSON.stringify(phase)}
navori_audit_name=fixture-hook
navori_audit_begin
navori_audit_log allow ${JSON.stringify(reason)}
`),
    );
    return script;
  }

  // Covers: R10, R11
  it("does not pass human prompt, reason or private paths to the writer", () => {
    activate();
    const secret = "SECRET-user@example.test";
    expect(
      run(
        shell,
        TRIGGER,
        JSON.stringify({
          session_id: "sess1",
          cwd,
          prompt: secret,
          transcript_path: "/private/secret.jsonl",
        }),
      ),
    ).toEqual({ out: "", code: 0 });
    expect(run(shell, CLOSE, JSON.stringify({ session_id: "sess1", cwd, reason: secret }))).toEqual(
      { out: "", code: 0 },
    );
    expect(
      runFile(
        shell,
        recorder("PreToolUse", secret),
        JSON.stringify({ session_id: "sess1", cwd, tool_use_id: "tool_123" }),
      ),
    ).toEqual({ out: "", code: 0 });
    const recorded = calls();
    expect(recorded).toHaveLength(3);
    expect(JSON.stringify(recorded)).not.toContain(secret);
    expect(JSON.stringify(recorded)).not.toContain("/private/secret.jsonl");
    expect(recorded[0]?.record).toMatchObject({
      event: "prompt",
      kind: "user",
      length: secret.length,
    });
    expect(recorded[1]?.record.reason).toBe("other");
    expect(recorded[2]?.record).toMatchObject({ reason: "unspecified", toolUseId: "tool_123" });
    for (const call of recorded) {
      expect(call.args).toContain("--record-metadata");
      expect(call.record).not.toHaveProperty("eventId");
      expect(call.record).not.toHaveProperty("wireVersion");
    }
  });

  // Covers: R10, R11
  it("never invokes the writer for another repository's audit root", () => {
    mkdirSync(join(root, "other-repo"));
    writeFileSync(join(root, "other-repo", ".armed"), "{}");
    expect(runFile(shell, recorder("PreToolUse"), payload("secret"))).toEqual({ out: "", code: 0 });
    expect(runFile(shell, recorder("SessionStart"), payload("secret"))).toEqual({
      out: "",
      code: 0,
    });
    expect(calls()).toEqual([]);
    expect(existsSync(join(root, REPO))).toBe(false);
  });

  // Covers: R10, R11
  it("offers startup only for the exact repo arm, not ordinary events", () => {
    mkdirSync(join(root, REPO), { mode: 0o700 });
    writeFileSync(join(root, REPO, ".armed"), "{}", { mode: 0o600 });
    runFile(shell, recorder("PreToolUse"), payload("secret"));
    expect(calls()).toEqual([]);
    runFile(shell, recorder("SessionStart"), payload("secret"));
    expect(calls()).toHaveLength(1);
    expect(calls()[0]?.record.phase).toBe("SessionStart");
    expect(existsSync(logFile())).toBe(false);
    expect(existsSync(join(root, REPO, "pending-sess1.jsonl"))).toBe(true);
  });

  // Covers: R10, R11
  it("keeps recorder failure advisory without a shell-write fallback", () => {
    activate();
    const before = readFileSync(logFile(), "utf-8");
    writeFileSync(join(recorderBin, "navori"), "#!/bin/sh\nprintf unsafe-stdout\nexit 1\n");
    expect(run(shell, TRIGGER, payload("secret"))).toEqual({ out: "", code: 0 });
    expect(readFileSync(logFile(), "utf-8")).toBe(before);
  });
});
