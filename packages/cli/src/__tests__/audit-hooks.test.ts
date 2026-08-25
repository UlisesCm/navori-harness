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

function run(shell: string, hook: string, payload: string): { out: string; code: number } {
  try {
    const out = execFileSync(shell, [hook], {
      input: payload,
      encoding: "utf-8",
      env: { ...process.env, NAVORI_AUDITS_ROOT: root },
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

  it("asks for confirmation instead of activating", () => {
    const { out, code } = run(shell, TRIGGER, payload("audita el ticket en audit mode"));
    expect(code).toBe(0);
    expect(out).toContain("¿continuar?");
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
    expect(out).toContain("¿continuar?");
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
