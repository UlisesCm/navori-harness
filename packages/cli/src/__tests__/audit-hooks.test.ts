import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
let pathWithAudit: string;
let pathWithoutAudit: string;
const binDirs: string[] = [];

/**
 * A stub `navori` on PATH.
 *
 * The trigger introspects the CLI before ordering `navori audit`, so without a
 * controlled PATH this suite would assert against whichever version the
 * developer happens to have installed — green on a machine with a fresh navori
 * and red on one release behind. The stub only has to print a USAGE line: that
 * is the whole surface the hook reads.
 */
function fakeNavoriPath(withAudit: boolean): string {
  const bin = mkdtempSync(join(tmpdir(), "navori-bin-"));
  const usage = withAudit ? "USAGE navori init|add|audit|doctor" : "USAGE navori init|add|doctor";
  writeFileSync(join(bin, "navori"), `#!/bin/sh\necho "${usage}"\n`, { mode: 0o755 });
  binDirs.push(bin);
  return `${bin}:${process.env.PATH ?? ""}`;
}

/**
 * The real PATH with every directory holding a `navori` binary removed.
 *
 * Blanking PATH outright is not an option: the hook needs jq (and the harness
 * needs the shell itself), so an empty PATH tests "no tools" rather than "no
 * navori" — the hook would bail at its jq guard and emit nothing.
 */
function pathWithoutNavori(): string {
  return (process.env.PATH ?? "")
    .split(":")
    .filter((dir) => dir !== "" && !existsSync(join(dir, "navori")))
    .join(":");
}

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
      env: { ...process.env, NAVORI_AUDITS_ROOT: root, PATH: pathOverride ?? pathWithAudit },
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
  pathWithAudit = fakeNavoriPath(true);
  pathWithoutAudit = fakeNavoriPath(false);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  while (binDirs.length > 0) rmSync(binDirs.pop() as string, { recursive: true, force: true });
});

describe.each(SHELLS)("audit-mode trigger under %s", (shell) => {
  it("stays silent on an unrelated prompt", () => {
    const { out, code } = run(shell, TRIGGER, payload("arregla el login"));
    expect(code).toBe(0);
    expect(out.trim()).toBe("");
  });

  it("asks for confirmation instead of activating", () => {
    const { out, code } = run(shell, TRIGGER, payload("audita el ticket en audit mode"));
    expect(code).toBe(0);
    expect(out).toContain("continue?");
    expect(out).toContain("navori audit --start sess1");
    // The decisive assertion: detection alone must leave NOTHING on disk.
    expect(existsSync(logFile())).toBe(false);
  });

  it("accepts the Spanish phrasing too", () => {
    const { out } = run(shell, TRIGGER, payload("entra en modo audit por favor"));
    expect(out).toContain("navori audit --start");
  });

  it("does not re-ask once the session is already active", () => {
    activate();
    const { out, code } = run(shell, TRIGGER, payload("seguimos en audit mode"));
    expect(code).toBe(0);
    expect(out).not.toContain("--start");
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

  it("asks before turning the mode off", () => {
    activate();
    const { out } = run(shell, TRIGGER, payload("apaga el audit mode"));
    expect(out).toContain("navori audit --stop sess1");
    expect(out).toContain("continue?");
  });

  it("never writes outside the audit root", () => {
    run(shell, TRIGGER, payload("audit mode"));
    expect(existsSync(join(cwd, "session-sess1.log"))).toBe(false);
  });
});

/**
 * The hook orders a command that resolves the PUBLISHED binary, never the
 * working tree's build. When the installed navori predates `audit`, citty
 * prints the help and exits 0 — so an agent checking only the status reads a
 * silent no-op as success and reports a recording that never started. The
 * trigger must therefore introspect the CLI before ordering anything.
 */
describe.each(SHELLS)("audit-mode availability under %s", (shell) => {
  // The fallback names the command in order to FORBID it ("Do NOT run ...
  // blindly"), so the assertion is about the imperative that would launch it,
  // not about the flag appearing anywhere in the text.
  const ORDERS_START = "run: navori audit --start";
  const ORDERS_STOP = "run: navori audit --stop";

  it("does not order --start when the CLI has no audit subcommand", () => {
    const { out, code } = run(shell, TRIGGER, payload("audit mode"), pathWithoutAudit);
    expect(code).toBe(0);
    expect(out).not.toContain(ORDERS_START);
    expect(out).toContain("Do NOT run");
    expect(out).toContain("could not be confirmed");
    expect(existsSync(logFile())).toBe(false);
  });

  it("does not order --start when navori is not installed at all", () => {
    const { out, code } = run(shell, TRIGGER, payload("audit mode"), pathWithoutNavori());
    expect(code).toBe(0);
    expect(out).not.toContain(ORDERS_START);
    // A machine with no navori must not be told its version is old.
    expect(out).toContain("may not be installed");
    expect(existsSync(logFile())).toBe(false);
  });

  it("orders --start AND demands the output be verified when audit exists", () => {
    const { out } = run(shell, TRIGGER, payload("audit mode"), pathWithAudit);
    expect(out).toContain("navori audit --start sess1");
    // Introspection can be right and the call still fail, so the agent is told
    // to read the output. The cue is the log path, not a localized string: the
    // CLI translates its own output and the hook must not depend on that.
    expect(out).toContain("name the log file");
    expect(out).toContain("USAGE");
  });

  it("does not order --stop when the subcommand is missing, and keeps the log", () => {
    activate();
    const before = readFileSync(logFile(), "utf-8");
    const { out, code } = run(shell, TRIGGER, payload("apaga el audit mode"), pathWithoutAudit);
    expect(code).toBe(0);
    expect(out).not.toContain(ORDERS_STOP);
    expect(out).toContain("stays intact");
    // The log is append-only: a failed close must never truncate it.
    expect(readFileSync(logFile(), "utf-8").startsWith(before)).toBe(true);
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
  ];

  it.each(hostile)("exits 0 on %s", (_label, input) => {
    expect(run(shell, TRIGGER, input).code).toBe(0);
    expect(run(shell, CLOSE, input).code).toBe(0);
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
