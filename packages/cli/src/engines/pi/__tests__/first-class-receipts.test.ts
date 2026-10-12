import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planCommand } from "../../../commands/plan.ts";
import { computeWorktreeTree, readHead } from "../../../lib/plan/evidence.ts";

const DIR = ".navori/state/handoffs";
const COMMAND = "bun run --cwd packages/cli test first-class";
const SAVED = ["CLAUDE_CODE_CHILD_SESSION", "PI_SESSION_ID"] as const;

let cwd: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(SAVED.map((name) => [name, process.env[name]]));
  for (const name of SAVED) delete process.env[name];
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "navori-pi-receipts-")));
  execFileSync("git", ["init", "-b", "main"], { cwd });
  writeFileSync(
    join(cwd, "navori.config.json"),
    JSON.stringify({ name: "pi", engines: ["pi"], preset: "custom" }),
  );
  mkdirSync(join(cwd, DIR), { recursive: true });
  writeFileSync(
    join(cwd, DIR, "workplan_demo.json"),
    JSON.stringify({
      feature: "demo",
      level: 1,
      classification: { score: 2, level: 1, signals: [] },
      objective: "Close from Pi.",
      acceptance: [{ id: "A1", description: "d", command: COMMAND, expected: "exit0" }],
      outOfScope: [],
      files: [],
      progress: { A1: "pendiente" },
      decisions: [],
    }),
  );
  process.exitCode = undefined;
});

afterEach(() => {
  for (const name of SAVED) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  rmSync(cwd, { recursive: true, force: true });
  process.exitCode = undefined;
});

/** The exact line the Pi extension appends after a verified exit-0 run. */
function recordRun(overrides: Record<string, unknown> = {}): void {
  const line = {
    ts: "2026-10-09T10:00:00Z",
    feature: "demo",
    id: "A1",
    command: COMMAND,
    tree: cwd,
    cwd,
    head: readHead(cwd),
    worktreeTree: computeWorktreeTree(cwd),
    dirty: true,
    sessionId: "pi-session-1",
    ...overrides,
  };
  writeFileSync(join(cwd, DIR, "workplan_demo.evidence.jsonl"), `${JSON.stringify(line)}\n`);
}

async function update(): Promise<string> {
  const err: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await runCommand(planCommand, {
      rawArgs: ["update", "demo", "--progress", "A1=cumplido", "--json", "--cwd", cwd],
    });
  } finally {
    process.stderr.write = original;
  }
  return err.join("");
}

const planBytes = (): string => readFileSync(join(cwd, DIR, "workplan_demo.json"), "utf8");

// Covers: R8
describe("Pi closure through the shared receipts", () => {
  // Covers: R8
  it("reject missing failed and stale evidence", async () => {
    process.env.PI_SESSION_ID = "pi-session-1";
    const before = planBytes();
    const other = realpathSync(mkdtempSync(join(tmpdir(), "navori-pi-other-")));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: other });
      // A failed run is never recorded by the extension, so "failed" and "missing" both leave an empty log.
      const cases: Array<[string, (() => void) | undefined]> = [
        ["no run recorded", undefined],
        ["recorded for a different command", () => recordRun({ command: "something else" })],
        ["tree changed", () => recordRun({ head: "deadbeef" })],
        ["not this feature's checkout", () => recordRun({ tree: other, cwd: other })],
      ];
      for (const [why, arrange] of cases) {
        process.exitCode = undefined;
        arrange?.();
        const stderr = await update();
        expect(process.exitCode).toBe(1);
        expect(stderr).toContain(why);
        expect(planBytes()).toBe(before);
      }
      // Stale tree: valid line, then the tree changes after the run.
      process.exitCode = undefined;
      recordRun();
      writeFileSync(join(cwd, "edited.txt"), "after the run\n");
      expect(await update()).toContain("tree changed since the run");
      expect(process.exitCode).toBe(1);
      expect(planBytes()).toBe(before);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  // Covers: R8
  it("accepts the current evidence of an exact run from an identified Pi session", async () => {
    process.env.PI_SESSION_ID = "pi-session-1";
    recordRun();
    await update();
    expect(process.exitCode ?? 0).toBe(0);
    const written = JSON.parse(planBytes());
    expect(written.progress.A1).toBe("cumplido");
    expect(written.evidence.A1).toMatchObject({ kind: "recorded", command: COMMAND });
  });

  // Covers: R8
  it("keeps human terminals unevidenced and Claude sessions on their own branch", async () => {
    // No Pi signal: unchanged behaviour (warning, unevidenced).
    expect(await update()).toContain("WARNING: A1 marked cumplido without evidence");
    expect(JSON.parse(planBytes()).evidence.A1.kind).toBe("unevidenced");
    // A stray PI_SESSION_ID in a Claude child session does not turn a claude-less repo into a Pi one.
    process.exitCode = undefined;
    process.env.CLAUDE_CODE_CHILD_SESSION = "1";
    process.env.PI_SESSION_ID = "pi-session-1";
    await update();
    expect(process.exitCode ?? 0).toBe(0);
    // A Pi session of a repo that does not render pi is not held to Pi evidence either.
    delete process.env.CLAUDE_CODE_CHILD_SESSION;
    writeFileSync(
      join(cwd, "navori.config.json"),
      JSON.stringify({ name: "pi", engines: ["codex"], preset: "custom" }),
    );
    await update();
    expect(process.exitCode ?? 0).toBe(0);
  });
});
