import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getCoreRoot } from "../render/bundled-assets.ts";
import { expandHookIncludes } from "../render/hook-includes.ts";
import { shellSingleQuote } from "../primitives/shell-escape.ts";
import { HOOK_SHELLS, type HookShell } from "./helpers/shells.ts";

/**
 * #797 — what the audit log says when the host CANCELS a quality gate.
 *
 * A `command` hook that reaches its timeout is cancelled and its output
 * discarded. Under a handled signal bash still runs the EXIT trap, and `$?` is
 * 0 there (the last COMPLETED command was the `trap` builtin), so the recorder
 * used to write `allow` / "gate ejecutado y verde" for a gate aborted after 3
 * seconds of a 20-second run — a false green that also satisfied
 * `quality-gate-aborted`, whose whole test is a start with no terminal record.
 *
 * The bench is deliberately the RENDERED hook — includes expanded,
 * `{{shq:qualityGate.fast}}` resolved, driven by a real `git commit` payload
 * with a `tool_use_id` — killed with a real signal, because a toy reproducing
 * the trap shape proves the shape and not the asset. The gate command is a
 * `sleep` so the kill lands while the gate is genuinely running.
 *
 * SIGNAL DEFERRAL is asserted, not worked around: bash does not run a trap
 * while it waits for a foreground command, so the record lands when the `sleep`
 * ends rather than when the signal arrived. That is the legitimate behaviour of
 * the shell and the reason the fix records a VERDICT instead of trying to make
 * the process die sooner. SIGKILL is in the table as the case no handler can
 * ever observe: there the absent terminal record is the whole signature, which
 * is why `gate-started` has to stay.
 */

const HOOK_SRC = resolve(getCoreRoot(), "core-assets/hooks/quality-gate-pre-commit.sh");
const REPO = "navori-kill-fixture";
/** Long enough that the kill always lands mid-gate, short enough for a suite. */
const GATE_SECONDS = 2;

let root: string;
let cwd: string;
let hookPath: string;
let gateChildWitness: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "navori-kill-"));
  cwd = join(root, REPO);
  mkdirSync(join(root, "audits", REPO), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  // `navori audit --start` writes this line; without the log file the recorder
  // is off and the bench would measure nothing.
  writeFileSync(
    logFile(),
    `${JSON.stringify({ ts: "2026-09-15T10:00:00Z", event: "start", cwd, repo: REPO })}\n`,
    "utf-8",
  );
  hookPath = join(root, "quality-gate-pre-commit.sh");
  // The gate command is itself a CHILD shell (`sh -c '...'`) that writes a
  // witness before it execs into `sleep`, instead of the hook writing a
  // witness in its own process before forking the gate. That distinction is
  // the fix for #867: the hook's own `gate-started` witness lands BEFORE the
  // `eval` that forks the gate command, so a poller racing to send SIGTERM as
  // soon as it sees that witness can catch bash still mid-fork/exec, land the
  // signal before bash enters `waitpid()`, and skip the trap deferral this
  // suite exists to pin (#797) — that gap is exactly the flake in #867.
  // Moving the witness into the forked child closes it: by the time the
  // child can `write()` the witness it has already been `execve`'d into `sh`
  // (a syscall far slower than the few instructions the parent needs to go
  // from `fork()` returning to calling `waitpid()`), so the witness being
  // visible is itself evidence the parent bash is already blocked waiting on
  // that exact child — the state the deferral depends on.
  gateChildWitness = join(root, "gate-child-started");
  const childScript = `printf x > ${shellSingleQuote(gateChildWitness)}; exec sleep ${GATE_SECONDS}`;
  const gateCommand = `sh -c ${shellSingleQuote(childScript)}`;
  writeFileSync(
    hookPath,
    expandHookIncludes(readFileSync(HOOK_SRC, "utf-8")).replace(
      "{{shq:qualityGate.fast}}",
      shellSingleQuote(gateCommand),
    ),
    "utf-8",
  );
  chmodSync(hookPath, 0o755);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function logFile(): string {
  return join(root, "audits", REPO, "session-kill1.log");
}

function hookEvents(): Array<Record<string, unknown>> {
  if (!existsSync(logFile())) return [];
  return readFileSync(logFile(), "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record.event === "hook");
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Run {
  /** Exit code, or null when the process was terminated by a signal. */
  code: number | null;
  verdicts: string[];
  events: Array<Record<string, unknown>>;
}

/**
 * Run the rendered hook on a `git commit` payload and, once the gate has really
 * started, send it `signal` (or nothing, for the control row). Resolves when
 * the hook process itself has exited.
 *
 * `exit` and not `close`: the gate's own child outlives the kill (#797, residue
 * 3) holding the inherited stderr pipe, so `close` would wait for a process
 * this test is not measuring.
 */
async function runAndSignal(shell: HookShell, signal?: NodeJS.Signals): Promise<Run> {
  const child = spawn(shell, [hookPath], {
    cwd: root,
    env: {
      ...process.env,
      NAVORI_AUDITS_ROOT: join(root, "audits"),
      CLAUDE_PROJECT_DIR: cwd,
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin:${process.env.PATH ?? ""}`,
    },
  });
  const exited = new Promise<number | null>((resolveExit) => {
    child.on("exit", (code) => resolveExit(code));
  });
  child.stdin.end(
    JSON.stringify({
      session_id: "kill1",
      cwd,
      tool_use_id: "toolu_kill1",
      tool_input: { command: "git commit -m x" },
    }),
  );

  if (signal) {
    // The witness the gate CHILD writes right after its own `exec`, not the
    // hook's own `gate-started` marker: waiting for the child's witness is
    // what makes the kill land mid-gate deterministically — see beforeEach
    // for why this specific ordering (fork+exec before the write) is what
    // proves bash is already blocked in `waitpid()` on that child.
    const deadline = Date.now() + 10_000;
    while (!existsSync(gateChildWitness)) {
      if (Date.now() > deadline) throw new Error("the gate child never wrote its witness");
      await sleep(20);
    }
    child.kill(signal);
  }

  const code = await exited;
  // A record written from a signal handler can land after the process is gone;
  // a fixed wait is the only way to catch a late line, and catching one is the
  // point (the SIGTERM row used to be found exactly this way).
  await sleep(300);
  const events = hookEvents();
  return { code, verdicts: events.map((e) => String(e.verdict)), events };
}

describe.each(HOOK_SHELLS)("a cancelled quality gate under %s (#797)", (shell) => {
  it("records allow only when nothing killed it", async () => {
    const run = await runAndSignal(shell);
    expect(run.code).toBe(0);
    expect(run.verdicts).toEqual(["gate-started", "allow"]);
  }, 30_000);

  it.each<NodeJS.Signals>(["SIGTERM", "SIGINT", "SIGHUP"])(
    "records %s as gate-killed, never as a green gate",
    async (signal) => {
      const run = await runAndSignal(shell, signal);
      // THE regression: a gate aborted mid-run used to land here as `allow`.
      expect(run.verdicts).not.toContain("allow");
      expect(run.verdicts).toEqual(["gate-started", "gate-killed"]);
      const terminal = run.events.at(-1);
      expect(terminal?.reason).toBe(`cancelado por ${signal}: nada quedo validado`);
      // The tool call it belongs to, which is what `quality-gate-aborted`
      // correlates on.
      expect(terminal?.toolUseId).toBe("toolu_kill1");
      // Killed is not a clean exit: the handler re-raises the signal, so the
      // process dies from what it was sent instead of returning 0.
      expect(run.code).not.toBe(0);
    },
    30_000,
  );

  it("leaves only the start marker when SIGKILL gives the handler no chance", async () => {
    const run = await runAndSignal(shell, "SIGKILL");
    expect(run.verdicts).toEqual(["gate-started"]);
    // Nothing was recorded, so the ABSENCE is the whole signature — the
    // reason `gate-started` exists and now covers all three gates.
    expect(run.code).toBeNull();
  }, 30_000);
});

/**
 * bash defers a trapped signal until the foreground command it is waiting on
 * finishes, so the hook outlives its own cancellation by however long the gate
 * still had to run. Pinned rather than hidden: it is why the `ms` of a
 * `gate-killed` record measures the gate, not the time to the signal, and why
 * the fix does not pretend to stop the work (killing the gate's process tree is
 * a decision of its own — #797, residue 3).
 */
describe("bash defers the signal until the gate command returns (#797)", () => {
  it("records the kill only after the gate finishes", async () => {
    const started = Date.now();
    const run = await runAndSignal("bash", "SIGTERM");
    expect(run.verdicts).toEqual(["gate-started", "gate-killed"]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(GATE_SECONDS * 1000);
    expect(Number(run.events.at(-1)?.ms)).toBeGreaterThanOrEqual(GATE_SECONDS * 1000);
  }, 30_000);
});
