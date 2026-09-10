import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getCoreRoot } from "../bundled-assets.ts";
import { expandHookIncludes } from "../hook-includes.ts";
import { acrossShells, type HookShell } from "./helpers/shells.ts";
import { buildClaudeSettings } from "../../engines/claude/build-settings.ts";
import { resolveHarnessPlan } from "../../engines/shared/harness-plan.ts";
import { EPHEMERAL_HARNESS_PATHS } from "../../engines/shared/ephemeral-paths.ts";
import type { NavoriConfig } from "../config.ts";

/**
 * Behavioral tests for core-assets/hooks/routing-watch.sh (spec 0020, R2/R3).
 *
 * The hook exists because the routing ladder ships as CLAUDE.md context, which
 * the host itself calls "not enforced configuration": 12 of the 21 audited
 * sessions that crossed R2's threshold delegated nothing. So the value under
 * test is not "the script has the right shape" — it is that a real sequence of
 * `PostToolUse` payloads produces EXACTLY ONE advisory note, at the right
 * moment, and never a block.
 *
 * Everything below drives the hook the way Claude Code does: one spawn per tool
 * call, the payload on stdin, a project dir in the environment. Each sequence
 * gets a FRESH project dir per shell, because the hook is stateful across
 * invocations (its per-session stamp is the whole mechanism) — replaying a
 * sequence into a used stamp would test nothing.
 */

const runsBash = process.platform !== "win32";

/**
 * The hook as a RENDERED repo would run it: `# navori:include extract-cmd` is
 * expanded by `navori render`, and that partial is what defines `payload_field`.
 * Driving the raw asset would exercise a script whose extractor does not exist.
 */
const hookPath = (() => {
  const dir = mkdtempSync(join(tmpdir(), "navori-routing-src-"));
  const p = join(dir, "routing-watch.sh");
  writeFileSync(
    p,
    expandHookIncludes(
      readFileSync(resolve(getCoreRoot(), "core-assets/hooks/routing-watch.sh"), "utf-8"),
    ),
  );
  chmodSync(p, 0o755);
  return p;
})();

const SESSION = "sess-routing-1";

interface HookRun {
  code: number;
  stdout: string;
}

/** A `PostToolUse` payload for a write tool. */
function edit(filePath: string, tool = "Edit"): Record<string, unknown> {
  return { session_id: SESSION, tool_name: tool, tool_input: { file_path: filePath } };
}

/** A `PostToolUse` payload for the subagent tool — i.e. delegation happened. */
function delegation(): Record<string, unknown> {
  return { session_id: SESSION, tool_name: "Agent", tool_input: { subagent_type: "implementer" } };
}

/** An edit fired from INSIDE a subagent: same session, `agent_id` present. */
function subagentEdit(filePath: string): Record<string, unknown> {
  return {
    session_id: SESSION,
    tool_name: "Edit",
    tool_input: { file_path: filePath },
    agent_id: "agent-abc123",
    agent_type: "implementer",
  };
}

function runHook(shell: HookShell, cwd: string, payload: Record<string, unknown>): HookRun {
  const r = spawnSync(shell, [hookPath], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "" };
}

/**
 * Play a whole sequence against a fresh project dir, under every available
 * shell, and assert the shells agree (#391). Returns the agreed run list.
 */
function play(payloads: Array<Record<string, unknown>>): HookRun[] {
  return acrossShells((shell) => {
    const cwd = mkdtempSync(join(tmpdir(), "navori-routing-"));
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    return payloads.map((p) => runHook(shell, cwd, p));
  });
}

/** A fresh project dir with `.claude/`, for sequences that must pre-seed or
 * inspect the stamp dir afterwards (`play()` keeps its dir private). */
function freshProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), "navori-routing-"));
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  return cwd;
}

/** The runs that actually emitted something on stdout — i.e. the notices. */
function notices(runs: HookRun[]): HookRun[] {
  return runs.filter((r) => r.stdout.trim() !== "");
}

/** The `additionalContext` string of a notice, parsed as the host would. */
function contextOf(run: HookRun): string {
  const parsed = JSON.parse(run.stdout) as {
    hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
  };
  expect(parsed.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
  return parsed.hookSpecificOutput?.additionalContext ?? "";
}

describe.runIf(runsBash)("routing-watch.sh — the notice fires (spec 0020)", () => {
  // Covers: R2
  it("emite al cruzar el umbral", () => {
    const runs = play([
      edit("/repo/a.ts"),
      edit("/repo/b.ts"),
      edit("/repo/c.ts"),
      edit("/repo/d.ts"),
    ]);

    const emitted = notices(runs);
    expect(emitted).toHaveLength(1);
    // On the edit that CROSSES the threshold, not on a later one: that is the
    // moment of the decision, and the whole reason this is PostToolUse.
    expect(runs.indexOf(emitted[0]!)).toBe(3);

    const context = contextOf(emitted[0]!);
    // The real count, so the note is evidence and not a slogan.
    expect(context).toMatch(/\b4 distinct files\b/);
    // R2's actual rule, named: 1 implementer -> 1 reviewer.
    expect(context).toMatch(/\bR2\b/);
    expect(context).toMatch(/implementer/);
    expect(context).toMatch(/reviewer/);
    // The heart of the design: today the override happens in silence, so the
    // note ASKS for it to be stated. A note that only says "you should
    // delegate" invites being ignored quietly, which is the current state.
    expect(context).toMatch(/say so explicitly/i);
  });

  // Covers: R2
  it("no cuenta el mismo archivo dos veces", () => {
    // Four writes, ONE file — iterating on a single file is the most common
    // shape there is, and R2 is about four DISTINCT files. Counting rewrites
    // would fire the note on the safest session in the repo, and a hook that
    // guesses is the noise this design refuses to ship.
    const runs = play([
      edit("/repo/a.ts"),
      edit("/repo/a.ts"),
      edit("/repo/a.ts"),
      edit("/repo/a.ts"),
    ]);

    expect(notices(runs)).toHaveLength(0);
  });

  // Covers: R2
  it("cuenta Write y NotebookEdit, no solo Edit", () => {
    const runs = play([
      edit("/repo/a.ts", "Write"),
      edit("/repo/b.ipynb", "NotebookEdit"),
      edit("/repo/c.ts", "Write"),
      edit("/repo/d.ts"),
    ]);

    expect(notices(runs)).toHaveLength(1);
  });
});

describe.runIf(runsBash)("routing-watch.sh — and never becomes noise (spec 0020)", () => {
  // Covers: R3
  it("una sola vez", () => {
    const runs = play([
      edit("/repo/a.ts"),
      edit("/repo/b.ts"),
      edit("/repo/c.ts"),
      edit("/repo/d.ts"),
      // The session carries on writing — which is exactly when a re-firing hook
      // turns into wallpaper. The stamp is what makes this at-most-once, and it
      // survives a compaction on purpose: repeating is what erodes.
      edit("/repo/e.ts"),
      edit("/repo/f.ts"),
      edit("/repo/g.ts"),
      edit("/repo/h.ts"),
    ]);

    expect(notices(runs)).toHaveLength(1);
  });

  // Covers: R3
  it("no avisa si ya delegó", () => {
    const runs = play([
      edit("/repo/a.ts"),
      edit("/repo/b.ts"),
      // Delegation before the threshold: R2's condition is "N files AND zero
      // delegation", so its second half is already false and the note would be
      // advice against something that already happened.
      delegation(),
      edit("/repo/c.ts"),
      edit("/repo/d.ts"),
      edit("/repo/e.ts"),
      edit("/repo/f.ts"),
    ]);

    expect(notices(runs)).toHaveLength(0);
  });

  // Covers: R3
  it("nunca bloquea", () => {
    const runs = play([
      edit("/repo/a.ts"),
      edit("/repo/b.ts"),
      delegation(),
      edit("/repo/c.ts"),
      edit("/repo/d.ts"),
    ]).concat(
      play([edit("/repo/a.ts"), edit("/repo/b.ts"), edit("/repo/c.ts"), edit("/repo/d.ts")]),
    );

    for (const run of runs) {
      // A PostToolUse hook stops nothing by exiting 0, and says nothing about
      // permissions unless it emits a decision field. Both halves are asserted:
      // exit 2 would reach the model as an error, and a `permissionDecision`
      // would make an advisory note into a gate.
      expect(run.code).toBe(0);
      expect(run.stdout).not.toMatch(/permissionDecision/);
      expect(run.stdout).not.toMatch(/"decision"/);
    }
  });

  // Covers: R3
  // Skipped as root, where a 0o500 directory is not read-only at all and the
  // fixture would assert the opposite of what it sets up (containers run as
  // root; the CI runner does not).
  it.runIf(process.getuid?.() !== 0)("sale 0 aunque no pueda escribir el sello", () => {
    // A read-only project dir: the hook cannot create its stamp. It must stay
    // silent and exit 0 — a PostToolUse hook runs after tool calls all session
    // long, so failing loudly there is worse than never warning.
    const runs = acrossShells((shell) => {
      const cwd = mkdtempSync(join(tmpdir(), "navori-routing-ro-"));
      mkdirSync(join(cwd, ".claude"), { recursive: true });
      chmodSync(join(cwd, ".claude"), 0o500);
      const out = [
        edit("/repo/a.ts"),
        edit("/repo/b.ts"),
        edit("/repo/c.ts"),
        edit("/repo/d.ts"),
      ].map((p) => runHook(shell, cwd, p));
      chmodSync(join(cwd, ".claude"), 0o700);
      return out;
    });

    for (const run of runs) expect(run.code).toBe(0);
    expect(notices(runs)).toHaveLength(0);
  });
});

const MINIMAL_CONFIG = {
  name: "test",
  engines: ["claude"],
  preset: "custom",
  version: "1.0.0",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
} as unknown as NavoriConfig;

describe("routing-watch — wiring (spec 0020)", () => {
  // Covers: R2
  it("queda registrado en PostToolUse y su sello es efímero", () => {
    const post = (
      buildClaudeSettings(MINIMAL_CONFIG, []).hooks as {
        PostToolUse?: Array<{ matcher?: string; hooks: Array<{ command: string }> }>;
      }
    ).PostToolUse;
    const bucket = post?.find((b) => b.hooks.some((h) => h.command.includes("routing-watch.sh")));
    expect(bucket).toBeDefined();
    // Confined to the write tools plus the subagent tool: those are the only
    // events that can change the answer, and the matcher is what keeps a Read
    // or a Grep from spawning a shell at all.
    for (const tool of ["Edit", "Write", "NotebookEdit", "Agent"]) {
      expect(bucket?.matcher).toContain(tool);
    }

    // Materialized in every onboarded repo, not just this one.
    const plan = resolveHarnessPlan(MINIMAL_CONFIG, resolve(getCoreRoot(), "core-assets"), null);
    expect(plan.hooks.map((h) => h.id)).toContain("routing-watch");

    // The stamp is machine-local per-session state: `.gitignore`, the render
    // backup's exclusion and doctor's hygiene scan all read this one list.
    expect(EPHEMERAL_HARNESS_PATHS).toContain(".claude/.routing-watch/");
  });

  // Covers: R2
  it.runIf(runsBash)("escribe el sello exactamente donde lo declara efímero", () => {
    // The constant and the script are two files that must agree, and nothing
    // else checks that they do: a rename in the hook would leave a stamp
    // directory that git tracks and that the backup copies, in silence.
    const declared = ".claude/.routing-watch/";
    const cwd = mkdtempSync(join(tmpdir(), "navori-routing-stamp-"));
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    runHook("bash", cwd, edit("/repo/a.ts"));

    expect(existsSync(join(cwd, declared, SESSION))).toBe(true);
  });
});

describe("edits made inside a subagent (the host fires hooks there too)", () => {
  /**
   * Cold-review finding on PR #660. The docs: "When a subagent calls a tool,
   * tool events such as PreToolUse and PostToolUse fire the same configured
   * hooks as in the main conversation", with `agent_id` added to the payload.
   * The `#delegated` mark from the `Agent` case lands only when that tool
   * RETURNS — after the subagent finished — so without the guard, a delegated
   * implementer's 4th edit emitted the notice into the SUBAGENT's context
   * (false and unactionable there) and burned the once-per-session note before
   * the orchestrator could ever get it.
   */
  it.runIf(runsBash)("never notifies a subagent, and records its edits as delegation", () => {
    acrossShells((shell) => {
      const cwd = freshProject();
      // The implementer edits 5 files — well past the threshold.
      for (let i = 1; i <= 5; i++) {
        const r = runHook(shell, cwd, subagentEdit(`/repo/sub-${i}.ts`));
        expect(r.code).toBe(0);
        expect(r.stdout).not.toContain("additionalContext"); // Covers: R3
      }
      // The stamp says what those edits proved: delegation happened.
      const stamp = readFileSync(join(cwd, ".claude", ".routing-watch", SESSION), "utf-8");
      expect(stamp).toContain("#delegated");
      // ...so a later MAIN-thread burst does not notify either: this session
      // already delegated, which is exactly what the notice exists to cause.
      for (let i = 1; i <= 5; i++) {
        const r = runHook(shell, cwd, edit(`/repo/main-${i}.ts`));
        expect(r.code).toBe(0);
        expect(r.stdout).not.toContain("additionalContext");
      }
    });
  });
});

describe("stamp hygiene (one file per session, forever, unless someone sweeps)", () => {
  it.runIf(runsBash)("prunes stale sibling stamps when creating this session's", () => {
    acrossShells((shell) => {
      const cwd = freshProject();
      const dir = join(cwd, ".claude", ".routing-watch");
      mkdirSync(dir, { recursive: true });
      const stale = join(dir, "sess-ancient");
      const recent = join(dir, "sess-recent");
      writeFileSync(stale, "path:/old.ts\n");
      writeFileSync(recent, "path:/new.ts\n");
      // 8 days old — past the 7-day window the hook sweeps.
      const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
      utimesSync(stale, eightDaysAgo, eightDaysAgo);

      const r = runHook(shell, cwd, edit("/repo/a.ts"));
      expect(r.code).toBe(0);

      expect(existsSync(stale)).toBe(false); // swept
      expect(existsSync(recent)).toBe(true); // a live session's stamp survives
      expect(existsSync(join(dir, SESSION))).toBe(true);
    });
  });
});
