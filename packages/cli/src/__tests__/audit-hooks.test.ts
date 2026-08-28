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
