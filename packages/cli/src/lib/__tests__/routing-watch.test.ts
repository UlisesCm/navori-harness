import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getCoreRoot } from "../render/bundled-assets.ts";
import { expandHookIncludes } from "../render/hook-includes.ts";
import { acrossShells, type HookShell } from "./helpers/shells.ts";
import { buildClaudeSettings } from "../../engines/claude/build-settings.ts";
import { resolveHarnessPlan } from "../../engines/shared/harness-plan.ts";
import { EPHEMERAL_HARNESS_PATHS } from "../../engines/shared/ephemeral-paths.ts";
import type { NavoriConfig } from "../config/config.ts";
import { resolveStateRoot } from "../primitives/state-root.ts";
import { writeAcceptanceIndex } from "../plan/acceptance-index.ts";
import {
  computeWorktreeTree,
  readEvidenceLog,
  readHead,
  validateEvidence,
  type EvidenceLine,
} from "../plan/evidence.ts";

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

/** A `PostToolUse` payload for a shell command (#722). */
function bash(command: string): Record<string, unknown> {
  return { session_id: SESSION, tool_name: "Bash", tool_input: { command } };
}

/**
 * The same, with the `tool_response` the host really sends — the command's own
 * output. It exists to drive rung 2 of the write probe: rung 1 can only test
 * the whole payload, so a `>` printed by `git log --graph` reaches it, and only
 * the extracted COMMAND can settle the question.
 */
function bashWithOutput(command: string, output: string): Record<string, unknown> {
  return {
    session_id: SESSION,
    tool_name: "Bash",
    tool_input: { command },
    tool_response: { stdout: output, stderr: "", interrupted: false },
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

/** `git init` a fresh repo, quietly — the hook validates its checkout root,
 *  so every project dir below is a real repo
 *  unless a test is specifically about the no-git case. */
function gitInit(dir: string): void {
  execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "ignore" });
}

/** The legacy shared Git dir, used to assert old stamps remain untouched.
 *  Realpath'd: macOS resolves a worktree's gitdir file to an absolute
 *  path through `/tmp`'s `/private` symlink but leaves a plain repo's
 *  relative `.git` alone, so the two forms need normalizing before comparing. */
function gitCommonDir(dir: string): string {
  const raw = execFileSync("git", ["-C", dir, "rev-parse", "--git-common-dir"], {
    encoding: "utf-8",
  }).trim();
  return realpathSync(raw.startsWith("/") ? raw : join(dir, raw));
}

/** The checkout-local stamp dir for a repository. */
function stampDirFor(dir: string): string {
  return join(dir, ".navori", "state", "hooks", "routing-watch");
}

/**
 * Play a whole sequence against a fresh project dir, under every available
 * shell, and assert the shells agree (#391). Returns the agreed run list.
 */
function play(payloads: Array<Record<string, unknown>>): HookRun[] {
  return acrossShells((shell) => {
    const cwd = mkdtempSync(join(tmpdir(), "navori-routing-"));
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    gitInit(cwd);
    return payloads.map((p) => runHook(shell, cwd, p));
  });
}

/** A fresh project dir with `.claude/`, for sequences that must pre-seed or
 * inspect the stamp dir afterwards (`play()` keeps its dir private). */
function freshProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), "navori-routing-"));
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  gitInit(cwd);
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
    const runs = play([edit("src/a.ts"), edit("src/b.ts"), edit("src/c.ts"), edit("src/d.ts")]);

    const emitted = notices(runs);
    expect(emitted).toHaveLength(1);
    // On the edit that CROSSES the threshold, not on a later one: that is the
    // moment of the decision, and the whole reason this is PostToolUse.
    expect(runs.indexOf(emitted[0]!)).toBe(3);

    const context = contextOf(emitted[0]!);
    // The real count, so the note is evidence and not a slogan.
    expect(context).toMatch(/\b4 distinct files\b/);
    // #769: the reminder must not route to agents the repo disabled.
    expect(context).toMatch(/enabled orchestration route/i);
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
    const runs = play([edit("src/a.ts"), edit("src/a.ts"), edit("src/a.ts"), edit("src/a.ts")]);

    expect(notices(runs)).toHaveLength(0);
  });

  // Covers: R2
  it("cuenta Write y NotebookEdit, no solo Edit", () => {
    const runs = play([
      edit("src/a.ts", "Write"),
      edit("src/b.ipynb", "NotebookEdit"),
      edit("src/c.ts", "Write"),
      edit("src/d.ts"),
    ]);

    expect(notices(runs)).toHaveLength(1);
  });
});

describe.runIf(runsBash)("routing-watch.sh — solo cuenta lo que es del cambio", () => {
  /**
   * El hook contaba `tool_input.file_path` tal cual: sin filtrar por repo y sin
   * mirar qué clase de archivo era. Medido sobre el parque, el 13.4% de lo que
   * el minero llamaba "escrituras de fuente" eran archivos fuera del repo, y un
   * `render --apply` que reescribe 45 rutas de espejo cruzaba el umbral cuatro
   * veces sin que nadie hubiera escrito una línea de lógica.
   *
   * Las dos condiciones salen de la MISMA definición que usan el minero y el
   * pilot (`lib/source-classify.ts`), inlineada aquí como partial generado.
   */

  it("no cuenta un archivo fuera del repo", () => {
    // Cuatro escrituras absolutas bajo otro árbol: ninguna llega a un diff.
    const runs = play([
      edit("/tmp/scratch/a.ts"),
      edit("/tmp/scratch/b.ts"),
      edit("/tmp/scratch/c.ts"),
      edit("/tmp/scratch/d.ts"),
    ]);
    expect(notices(runs)).toHaveLength(0);
  });

  it("no cuenta el espejo renderizado — un release no es una delegación", () => {
    const runs = play([
      edit(".claude/agents/reviewer.md"),
      edit(".claude/hooks/guard-destructive.sh"),
      edit("CLAUDE.md"),
      edit(".mcp.json"),
    ]);
    expect(notices(runs)).toHaveLength(0);
  });

  it("no cuenta tests, lockfiles ni docs", () => {
    const runs = play([
      edit("src/__tests__/a.test.ts"),
      edit("pnpm-lock.yaml"),
      edit("docs/research/x.md"),
      edit("package.json"),
    ]);
    expect(notices(runs)).toHaveLength(0);
  });

  it("sí cuenta la prosa del harness que un agente obedece", () => {
    // Clause (a) la llama comportamiento: un agente la lee y actúa sobre ella.
    const runs = play([
      edit("packages/core/core-assets/agents/reviewer.md"),
      edit("packages/core/core-assets/skills/review-diff.md"),
      edit("packages/plugins/engram/skills/engram-subagent.md"),
      edit("packages/core/core-assets/managed/sdd.md"),
    ]);
    expect(notices(runs)).toHaveLength(1);
  });

  it("mezcla: solo las de fuente suman hacia el umbral", () => {
    // Tres fuentes y tres descartadas: no alcanza.
    const runs = play([
      edit("src/a.ts"),
      edit("pnpm-lock.yaml"),
      edit("src/b.ts"),
      edit(".claude/settings.json"),
      edit("src/c.ts"),
      edit("/tmp/x/d.ts"),
    ]);
    expect(notices(runs)).toHaveLength(0);
  });
});

describe.runIf(runsBash)("routing-watch.sh — and never becomes noise (spec 0020)", () => {
  // Covers: R3
  it("una sola vez", () => {
    const runs = play([
      edit("src/a.ts"),
      edit("src/b.ts"),
      edit("src/c.ts"),
      edit("src/d.ts"),
      // The session carries on writing — which is exactly when a re-firing hook
      // turns into wallpaper. The stamp is what makes this at-most-once, and it
      // survives a compaction on purpose: repeating is what erodes.
      edit("src/e.ts"),
      edit("src/f.ts"),
      edit("src/g.ts"),
      edit("src/h.ts"),
    ]);

    expect(notices(runs)).toHaveLength(1);
  });

  // Covers: R3
  it("no avisa si ya delegó", () => {
    const runs = play([
      edit("src/a.ts"),
      edit("src/b.ts"),
      // Delegation before the threshold: R2's condition is "N files AND zero
      // delegation", so its second half is already false and the note would be
      // advice against something that already happened.
      delegation(),
      edit("src/c.ts"),
      edit("src/d.ts"),
      edit("src/e.ts"),
      edit("src/f.ts"),
    ]);

    expect(notices(runs)).toHaveLength(0);
  });

  // Covers: R3
  it("nunca bloquea", () => {
    const runs = play([
      edit("src/a.ts"),
      edit("src/b.ts"),
      delegation(),
      edit("src/c.ts"),
      edit("src/d.ts"),
    ]).concat(play([edit("src/a.ts"), edit("src/b.ts"), edit("src/c.ts"), edit("src/d.ts")]));

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
    // A read-only checkout-local hook state dir cannot hold the stamp.
    // It must stay silent and exit 0 — a
    // PostToolUse hook runs after tool calls all session long, so failing
    // loudly there is worse than never warning.
    const runs = acrossShells((shell) => {
      const cwd = mkdtempSync(join(tmpdir(), "navori-routing-ro-"));
      mkdirSync(join(cwd, ".claude"), { recursive: true });
      gitInit(cwd);
      const stateDir = join(cwd, ".navori", "state", "hooks");
      mkdirSync(stateDir, { recursive: true });
      chmodSync(stateDir, 0o500);
      const out = [edit("src/a.ts"), edit("src/b.ts"), edit("src/c.ts"), edit("src/d.ts")].map(
        (p) => runHook(shell, cwd, p),
      );
      chmodSync(stateDir, 0o700);
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
    // or a Grep from spawning a shell at all. `Bash` belongs to that set and
    // was missing until #775 — the script's `case` had accepted it since #722
    // A4, so the branch shipped inert. The derived, drift-proof version of this
    // assertion lives in `hook-matcher-wiring.test.ts`; this one stays because
    // a hand-written list is what a reader of THIS file can check.
    for (const tool of ["Bash", "Edit", "Write", "NotebookEdit", "Agent"]) {
      expect(bucket?.matcher?.split("|")).toContain(tool);
    }

    // Materialized in every onboarded repo, not just this one.
    const plan = resolveHarnessPlan(MINIMAL_CONFIG, resolve(getCoreRoot(), "core-assets"), null);
    expect(plan.hooks.map((h) => h.id)).toContain("routing-watch");

    // The stamp moved from `.claude/` to the Git common dir, then to
    // checkout-local `.navori/state/hooks/`. The legacy entry stays in
    // `EPHEMERAL_HARNESS_PATHS` (round 2, #1024):
    // a repo onboarded on navori <=0.10.0 already has the old stamp on disk,
    // this hook never deletes it, and dropping the entry untracked those
    // leftovers retroactively on every repo's next render. Legacy, not stale.
    expect(EPHEMERAL_HARNESS_PATHS).toContain(".claude/.routing-watch/");
  });

  // Covers: R2
  it.runIf(runsBash)("escribe el sello donde lo declara #1024: fuera de .claude/", () => {
    // The hook and the test must agree independently on where the stamp
    // lands — `stampDirFor` re-derives it via `git rev-parse`, never by
    // reading the hook's own source.
    const cwd = mkdtempSync(join(tmpdir(), "navori-routing-stamp-"));
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    gitInit(cwd);
    runHook("bash", cwd, edit("src/a.ts"));

    expect(existsSync(join(stampDirFor(cwd), SESSION))).toBe(true);
    expect(existsSync(join(cwd, ".claude", ".routing-watch", SESSION))).toBe(false);
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
      const stamp = readFileSync(join(stampDirFor(cwd), SESSION), "utf-8");
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
      const dir = stampDirFor(cwd);
      mkdirSync(dir, { recursive: true });
      const stale = join(dir, "sess-ancient");
      const recent = join(dir, "sess-recent");
      writeFileSync(stale, "path:/old.ts\n");
      writeFileSync(recent, "path:/new.ts\n");
      // 8 days old — past the 7-day window the hook sweeps.
      const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
      utimesSync(stale, eightDaysAgo, eightDaysAgo);

      const r = runHook(shell, cwd, edit("src/a.ts"));
      expect(r.code).toBe(0);

      expect(existsSync(stale)).toBe(false); // swept
      expect(existsSync(recent)).toBe(true); // a live session's stamp survives
      expect(existsSync(join(dir, SESSION))).toBe(true);
    });
  });
});

/**
 * #722 A4 — the threshold only ever accumulated through the NATIVE lane, the
 * one the dominant mode abandons: Bash is 80.4% of the park's 41,889 measured
 * tool calls. A `sed -i`, a `tee` or a `>` redirect left no mark, so in the
 * sessions this notice exists for it was structurally unreachable, and its "2
 * firings, 1 notice" on day one was not calibration — it was blindness to the
 * input. (#775 then found that the branch had never RUN either, because the
 * matcher never delivered `Bash`; the wiring assertion lives above.)
 *
 * The write forms are the ones `guard-destructive` rule 6 recognizes. `tee -a`
 * does not count — its operand is the flag, which the extraction drops — but
 * `>>` DOES, contrary to what this comment used to claim: the extraction's
 * pattern matches the second `>` of an append and takes the operand after it.
 * Appending to a source file is writing to it, so that is the right answer; the
 * cases below pin it in both directions.
 */
describe("shell writes reach the threshold too (#722)", () => {
  it("fires the notice on four files written through the shell", () => {
    const runs = play([
      bash("echo x > src/a.ts"),
      bash("sed -i '' 's/a/b/' src/b.ts"),
      bash("cat plantilla | tee src/c.ts"),
      bash("printf '%s' y > src/d.ts"),
    ]);
    expect(runs.slice(0, 3).every((r) => r.stdout === "")).toBe(true);
    expect(runs[3]?.stdout).toContain("routing check");
    expect(runs[3]?.stdout).toContain("4 distinct files");
  });

  it("mixes the two lanes, because the session does", () => {
    // Two edits and two shell writes are four files. Counting only one lane is
    // what made the threshold unreachable in the mode that matters.
    const runs = play([
      edit("src/a.ts"),
      bash("echo x > src/b.ts"),
      edit("src/c.ts"),
      bash("sed -i '' 's/x/y/' src/d.ts"),
    ]);
    expect(runs[3]?.stdout).toContain("routing check");
  });

  it("does not count a log write, a read, or a redirect between streams", () => {
    // NOTE on the first two: they are here because their TARGET is a log, not
    // because they append. `tee -a` would not count either way (its operand is
    // the flag), but `>> src/a.ts` does count — see the block comment above and
    // the append case in the ladder tests.
    const runs = play([
      bash("echo linea >> registro.log"),
      bash("cat x | tee -a registro.log"),
      bash("sed -n '1,5p' src/a.ts"),
      bash("grep -n foo src/a.ts"),
      bash("pnpm test 2>&1 | tail -5"),
      bash("ls -la"),
    ]);
    expect(runs.every((r) => r.stdout === "")).toBe(true);
  });

  /**
   * The BOUNDED WORK ladder the lane pays for (#775). Connecting `Bash` to the
   * matcher multiplies how often this hook spawns by ~10, and measured over the
   * park only 2.6% of the calls that reached the old gate contributed a single
   * path. So the gate was rewritten as two rungs — a fork-free probe on the
   * payload before anything locates a stamp, then the same probe on the
   * extracted command — and what follows is the executable half of that claim.
   *
   * These cases are the noise the OLD gate accepted: `*">"*` matched
   * `2>/dev/null` and `2>&1`, and bare `*sed*` matched every read.
   */
  it("descarta el ruido que la guarda vieja aceptaba, sin tocar el sello", () => {
    const cwd = freshProject();
    const noise = [
      "command -v jq >/dev/null 2>&1",
      "pnpm test 2>&1 | tail -5",
      "git log --oneline -5 2>/dev/null",
      "sed -n '1,20p' packages/cli/src/index.ts",
      "cat f > /dev/null",
      "echo 'the value used here'",
      "printf '%s' hola >&2",
    ];
    for (const cmd of noise) expect(runHook("bash", cwd, bash(cmd)).stdout).toBe("");
    // Nothing reached the stamp: the probe runs BEFORE `session_id` is read, so
    // a shell command that writes nothing costs what a Read costs.
    expect(existsSync(join(stampDirFor(cwd), SESSION))).toBe(false);
  });

  it("no cuenta un `>` que solo existe en la SALIDA del comando (rung 2)", () => {
    // Rung 1 sees the whole payload and says "maybe" — the output really does
    // carry `>`, `tee` and `sed`. Rung 2 asks the command and says no.
    const runs = play([
      bashWithOutput("git diff --stat", "src/a.ts | 4 ++--\n-> renamed\n"),
      bashWithOutput("git log --graph", "* commit\n|\\\n| > merged sed -i branch\n"),
      bashWithOutput("cat notas.txt", "usé tee y sed -i para escribir src/b.ts\n"),
      bashWithOutput("ls -la", "total 8\ndrwxr-xr-x  4 u  s  128 > x\n"),
    ]);
    expect(runs.every((r) => r.stdout === "")).toBe(true);
  });

  it("sigue contando las formas de escritura reales, una por una", () => {
    // The superset property of the probe, stated as cases: each of these MUST
    // survive both rungs, because each one names a source file the extraction
    // can find. An append is included on purpose — the extraction's `grep -oE`
    // matches the second `>` of a `>>` and counts its operand, so a probe that
    // stripped appends would silently stop counting this one.
    const runs = play([
      bash("printf '%s' y >src/sin-espacio.ts"),
      bash("cat plantilla | tee src/con-tee.ts"),
      bash("sed -E -i 's/a/b/' src/con-sed-flags.ts"),
      bash("cat >> src/anexado.ts <<'EOF'\nconst a = 1;\nEOF"),
    ]);
    expect(runs[3]?.stdout).toContain("routing check");
    expect(runs[3]?.stdout).toContain("4 distinct files");
  });

  /**
   * The regression the early exit nearly introduced, as its own case.
   *
   * `&>` reads like `>&` reversed but means the opposite: `>&` duplicates a
   * descriptor and the extraction finds NOTHING after it, while `&> src/a.ts`
   * is a real redirect whose operand the extraction does take. A first cut of
   * the probe stripped both as "noise", which deleted the `>` before the probe
   * could see it — four `&>` writes to source left the stamp EMPTY and the
   * notice silent. That is this issue's own defect class (a gate quietly
   * accepting less than the thing behind it), reintroduced by the commit that
   * fixes it, so it gets a test rather than a comment.
   */
  it("cuenta las escrituras con `&>`, que no son un dup de descriptor", () => {
    const runs = play([
      bash("pnpm build &> src/f1.ts"),
      bash("pnpm build &>src/f2.ts"),
      bash("pnpm build &> src/f3.ts"),
      bash("pnpm build &> src/f4.ts"),
    ]);
    expect(runs[3]?.stdout).toContain("routing check");
    expect(runs[3]?.stdout).toContain("4 distinct files");
  });

  it("sigue descartando `>&`, que sí es un dup y no nombra archivo", () => {
    // The other half of the pair: stripping THIS one is correct, and the proof
    // is that the extraction finds no operand after it.
    const cwd = freshProject();
    for (const cmd of ["cmd >&2", "cmd >& 2", "pnpm test >&2 | tail -5"]) {
      expect(runHook("bash", cwd, bash(cmd)).stdout).toBe("");
    }
    expect(existsSync(join(stampDirFor(cwd), SESSION))).toBe(false);
  });

  it("keeps the two filters that already applied to the native lane", () => {
    // Non-source targets and paths outside the repo were excluded for the
    // native tools and must stay excluded here: a render that rewrites the
    // mirror is not a change anyone should delegate.
    const runs = play([
      bash("echo x > .claude/settings.json"),
      bash("echo x > /tmp/afuera.ts"),
      bash("echo x > progress/current.md"),
      bash("echo x > pnpm-lock.yaml"),
    ]);
    expect(runs.every((r) => r.stdout === "")).toBe(true);
  });
});

/**
 * Spec 0036 — linked worktrees keep independent stamps, and an unavailable
 * checkout degrades to "write nothing, exit 0".
 */
describe.runIf(runsBash)("routing-watch.sh — where the stamp lives (#1024)", () => {
  it("writes an isolated stamp inside an agent worktree", () => {
    const main = freshProject();
    execFileSync(
      "git",
      [
        "-C",
        main,
        "-c",
        "user.email=t@t.io",
        "-c",
        "user.name=t",
        "commit",
        "--allow-empty",
        "-q",
        "-m",
        "init",
      ],
      { stdio: "ignore" },
    );
    const branch = "wt-1024";
    const wtDir = join(main, ".claude", "worktrees", branch);
    mkdirSync(join(main, ".claude", "worktrees"), { recursive: true });
    execFileSync("git", ["-C", main, "worktree", "add", "-q", "-b", branch, wtDir], {
      stdio: "ignore",
    });
    mkdirSync(join(wtDir, ".claude"), { recursive: true });

    const r = runHook("bash", wtDir, edit("src/a.ts"));
    expect(r.code).toBe(0);

    // Covers: R2, R10
    // Linked worktrees share a Git dir, but must not share detector state.
    expect(gitCommonDir(wtDir)).toBe(gitCommonDir(main));
    expect(existsSync(join(stampDirFor(wtDir), SESSION))).toBe(true);
    expect(existsSync(join(stampDirFor(main), SESSION))).toBe(false);
    const otherDir = join(main, ".claude", "worktrees", "wt-1046-other");
    execFileSync("git", ["-C", main, "worktree", "add", "-q", "-b", "wt-1046-other", otherDir], {
      stdio: "ignore",
    });
    expect(existsSync(join(stampDirFor(otherDir), SESSION))).toBe(false);
    expect(runHook("bash", otherDir, edit("src/a.ts")).code).toBe(0);
    expect(readFileSync(join(stampDirFor(otherDir), SESSION), "utf-8")).toBe("path:src/a.ts\n");
    expect(existsSync(join(wtDir, ".claude", ".routing-watch", SESSION))).toBe(false);
  });

  it("outside a git repo: never counts, never notifies, writes no stamp", () => {
    const cwd = mkdtempSync(join(tmpdir(), "navori-routing-nogit-"));
    mkdirSync(join(cwd, ".claude"), { recursive: true });

    const runs = [edit("src/a.ts"), edit("src/b.ts"), edit("src/c.ts"), edit("src/d.ts")].map((p) =>
      runHook("bash", cwd, p),
    );
    for (const r of runs) {
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
    }
  });

  // Covers: R10
  it("preserves old stamps, sanitizes IDs, and skips unsafe or missing roots", () => {
    const main = freshProject();
    const legacyDir = join(gitCommonDir(main), "navori", "routing-watch");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, SESSION), "#notified\n");
    const rearmed = ["a", "b", "c", "d"].map((file) =>
      runHook("bash", main, edit(`src/${file}.ts`)),
    );
    expect(notices(rearmed)).toHaveLength(1);
    const payload = { ...edit("src/a.ts"), session_id: "sess/unsafe:id" };
    expect(runHook("bash", main, payload).code).toBe(0);
    expect(existsSync(join(stampDirFor(main), "sessunsafeid"))).toBe(true);
    expect(readFileSync(join(legacyDir, SESSION), "utf-8")).toBe("#notified\n");

    const unsafe = mkdtempSync(join(tmpdir(), "navori-routing-unsafe-"));
    const anotherRepo = freshProject();
    symlinkSync(unsafe, join(anotherRepo, ".navori"));
    for (const file of ["a", "b", "c", "d"]) {
      const result = runHook("bash", anotherRepo, edit(`src/${file}.ts`));
      expect(result).toEqual({ code: 0, stdout: "" });
    }
    expect(existsSync(join(unsafe, "state"))).toBe(false);
    expect(runHook("bash", "", edit("src/a.ts"))).toEqual({ code: 0, stdout: "" });
  });

  // Covers: R10
  it("does not follow a final session-stamp symlink outside the checkout", () => {
    const main = freshProject();
    const outside = join(mkdtempSync(join(tmpdir(), "navori-routing-target-")), "target");
    writeFileSync(outside, "outside-content\n");
    const stateDir = stampDirFor(main);
    mkdirSync(stateDir, { recursive: true });
    symlinkSync(outside, join(stateDir, SESSION));

    for (const file of ["a", "b", "c", "d"]) {
      expect(runHook("bash", main, edit(`src/${file}.ts`))).toEqual({ code: 0, stdout: "" });
    }
    expect(readFileSync(outside, "utf-8")).toBe("outside-content\n");
  });
});

/**
 * Spec 0039 D5/M3 — the Bash success lane (acceptance evidence). Driven the way
 * the Claude registration drives it: argument `claude-post-tool-use`, the
 * payload on stdin, `acceptance-index` written by the CLI itself.
 */
describe.runIf(runsBash)("routing-watch.sh — acceptance evidence lane (spec 0039 D5)", () => {
  const FEATURE = "lane-demo";
  const COMMAND = 'cd packages/cli && bun test "x y"';

  function laneProject(commands: string[] = [COMMAND]): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "navori-lane-")));
    gitInit(dir);
    for (const [k, v] of [
      ["user.email", "t@t"],
      ["user.name", "t"],
    ] as const) {
      execFileSync("git", ["-C", dir, "config", k, v], { stdio: "ignore" });
    }
    writeFileSync(join(dir, "a.txt"), "a\n");
    writeFileSync(join(dir, "run.sh"), "#!/bin/sh\n");
    chmodSync(join(dir, "run.sh"), 0o755);
    symlinkSync("a.txt", join(dir, "link"));
    execFileSync("git", ["-C", dir, "add", "-A"], { stdio: "ignore" });
    execFileSync("git", ["-C", dir, "commit", "-qm", "init"], { stdio: "ignore" });
    // Dirty on purpose: an untracked file and an edit, to exercise the fingerprint.
    writeFileSync(join(dir, "new.txt"), "n\n");
    writeFileSync(join(dir, "a.txt"), "a2\n");
    const root = resolveStateRoot({ cwd: dir, feature: FEATURE });
    mkdirSync(root.path, { recursive: true });
    const plan = {
      feature: FEATURE,
      level: 1,
      classification: { score: 1, level: 1, signals: [] },
      objective: "o",
      acceptance: commands.map((command, n) => ({
        id: `A${n + 1}`,
        description: "d",
        command,
        expected: "exit 0",
      })),
    };
    writeFileSync(join(root.path, `workplan_${FEATURE}.json`), JSON.stringify(plan));
    writeAcceptanceIndex(root);
    return dir;
  }

  function evidencePath(dir: string): string {
    return join(dir, ".navori/state/handoffs", `workplan_${FEATURE}.evidence.jsonl`);
  }

  function evidenceOf(dir: string): EvidenceLine[] {
    return readEvidenceLog(evidencePath(dir));
  }

  function lane(
    shell: HookShell,
    dir: string,
    payload: Record<string, unknown>,
    args: string[] = ["claude-post-tool-use"],
    env: NodeJS.ProcessEnv = {},
  ): HookRun {
    const r = spawnSync(shell, [hookPath, ...args], {
      input: JSON.stringify({ cwd: dir, ...payload }),
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...env },
    });
    return { code: r.status ?? -1, stdout: r.stdout ?? "" };
  }

  // Covers: R6, R7
  it("records one complete line for the exact command, matching plan update's fingerprint", () => {
    acrossShells((shell) => {
      const dir = laneProject();
      expect(lane(shell, dir, bash(COMMAND))).toEqual({ code: 0, stdout: "" });
      const lines = evidenceOf(dir);
      expect(lines).toHaveLength(1);
      const line = lines[0]!;
      expect(line).toMatchObject({
        feature: FEATURE,
        id: "A1",
        command: COMMAND,
        tree: dir,
        cwd: dir,
        sessionId: SESSION,
        dirty: true,
      });
      expect(line.worktreeTree).toBe(computeWorktreeTree(dir));
      expect(line.head).toBe(readHead(dir));
      // End to end: the CLI accepts what the hook recorded.
      const root = resolveStateRoot({ cwd: dir, feature: FEATURE });
      expect(validateEvidence({ root, feature: FEATURE, id: "A1", command: COMMAND }).ok).toBe(
        true,
      );
      return lines.length;
    });
  });

  // Covers: R6
  it("records in a session that is already #delegated", () => {
    acrossShells((shell) => {
      const dir = laneProject();
      expect(lane(shell, dir, delegation()).code).toBe(0);
      expect(readFileSync(join(stampDirFor(dir), SESSION), "utf-8")).toBe("#delegated\n");
      lane(shell, dir, bash(COMMAND));
      expect(evidenceOf(dir)).toHaveLength(1);
      return evidenceOf(dir).length;
    });
  });

  // Covers: R6
  it("does not record a near-miss command, a prefix, or a command in the output", () => {
    const dir = laneProject();
    for (const command of [`${COMMAND} `, `${COMMAND} && true`, ` ${COMMAND}`, "ls"]) {
      lane("bash", dir, bash(command));
    }
    lane("bash", dir, bashWithOutput("ls", `"command":"${COMMAND}"`));
    expect(evidenceOf(dir)).toEqual([]);
  });

  // Covers: R6
  it("does not record a run_in_background call or an interrupted one", () => {
    const dir = laneProject();
    lane("bash", dir, {
      ...bash(COMMAND),
      tool_input: { command: COMMAND, run_in_background: true },
    });
    lane("bash", dir, {
      ...bash(COMMAND),
      tool_response: { stdout: "", stderr: "", interrupted: true },
    });
    expect(evidenceOf(dir)).toEqual([]);
  });

  // Covers: R6
  it("does not record without the claude-post-tool-use argument (Codex)", () => {
    const dir = laneProject();
    expect(lane("bash", dir, bash(COMMAND), [])).toEqual({ code: 0, stdout: "" });
    expect(evidenceOf(dir)).toEqual([]);
  });

  // Covers: R6
  it("fails open with no acceptance-index, an empty one, or outside a git tree", () => {
    const dir = laneProject();
    const index = join(dir, ".navori/state/handoffs/acceptance-index");
    writeFileSync(index, "");
    expect(lane("bash", dir, bash(COMMAND)).code).toBe(0);
    rmSync(index);
    expect(lane("bash", dir, bash(COMMAND)).code).toBe(0);
    expect(evidenceOf(dir)).toEqual([]);
    const loose = realpathSync(mkdtempSync(join(tmpdir(), "navori-lane-loose-")));
    expect(lane("bash", loose, bash(COMMAND)).code).toBe(0);
  });

  // Covers: R7
  it("never executes the criterion's command (touch sentinel stays absent)", () => {
    const sentinel = join(mkdtempSync(join(tmpdir(), "navori-lane-sentinel-")), "ran");
    const command = `touch ${sentinel}`;
    const dir = laneProject([command]);
    lane("bash", dir, bash(command));
    expect(evidenceOf(dir)).toHaveLength(1);
    expect(existsSync(sentinel)).toBe(false);
  });

  /** PATH shims that log each invocation, then run the real tool. */
  function shimDir(names: string[]): { bin: string; calls: () => string[] } {
    const bin = mkdtempSync(join(tmpdir(), "navori-lane-bin-"));
    const log = join(bin, "calls.log");
    for (const name of names) {
      const real = execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf-8" }).trim();
      const shim = join(bin, name);
      writeFileSync(shim, `#!/bin/sh\necho "${name} $*" >> "${log}"\nexec "${real}" "$@"\n`);
      chmodSync(shim, 0o755);
    }
    return {
      bin,
      calls: () => (existsSync(log) ? readFileSync(log, "utf-8").split("\n").filter(Boolean) : []),
    };
  }

  // Covers: R6
  it("spawns no git, date or mktemp on the fast path (no criterion command in the payload)", () => {
    const dir = laneProject();
    const { bin, calls } = shimDir(["git", "date", "mktemp", "readlink", "awk"]);
    const env = { PATH: `${bin}:${process.env.PATH ?? ""}` };
    lane("bash", dir, bash("ls -la"), ["claude-post-tool-use"], env);
    lane("bash", dir, bash("echo hi > /dev/null"), ["claude-post-tool-use"], env);
    expect(calls()).toEqual([]);
    // Sanity: the shims do see the slow path.
    lane("bash", dir, bash(COMMAND), ["claude-post-tool-use"], env);
    expect(calls().some((c) => c.startsWith("git "))).toBe(true);
  });

  // Covers: R6, R7
  it("leaves no partial line when the hook is killed mid-fingerprint", () => {
    const dir = laneProject();
    const bin = mkdtempSync(join(tmpdir(), "navori-lane-kill-"));
    const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf-8" }).trim();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\ncase " $* " in *" write-tree "*) ps -axo pid=,command= | grep -F "${hookPath}" | awk '{print $1}' | xargs kill -9; sleep 1 ;; esac\nexec "${real}" "$@"\n`,
    );
    chmodSync(join(bin, "git"), 0o755);
    lane("bash", dir, bash(COMMAND), ["claude-post-tool-use"], {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    });
    expect(evidenceOf(dir)).toEqual([]);
    expect(existsSync(evidencePath(dir))).toBe(false);
  });
});

// Covers: R11
describe.runIf(runsBash)("routing-watch — Codex bash-outcome lane (spec 0041 T12)", () => {
  /** The same script as the Codex render writes it: under `.codex/hooks/`, so `nv_engine` is codex. */
  const codexHook = (() => {
    const dir = join(mkdtempSync(join(tmpdir(), "navori-routing-codex-")), ".codex", "hooks");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "routing-watch.sh");
    writeFileSync(p, readFileSync(hookPath, "utf-8"));
    chmodSync(p, 0o755);
    return p;
  })();
  const CODEX_SESSION = "codex-sess-1";
  const COMMAND = "bun run test";

  function project(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "navori-codex-outcome-")));
    gitInit(dir);
    return dir;
  }

  /** A rollout line in the shape observed in probe V4 (`event_msg` / `item_completed`). */
  function itemCompleted(id: string, exitCode: number, output = ""): string {
    return JSON.stringify({
      timestamp: "2026-10-03T18:23:02.485Z",
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          type: "CommandExecution",
          id,
          command: ["/bin/zsh", "-lc", COMMAND],
          status: exitCode === 0 ? "completed" : "failed",
          stdout: output,
          aggregated_output: output,
          exit_code: exitCode,
        },
      },
    });
  }

  function rollout(dir: string, lines: string[]): string {
    const p = join(dir, "rollout.jsonl");
    writeFileSync(p, `${lines.join("\n")}\n`);
    return p;
  }

  function call(
    shell: HookShell,
    dir: string,
    transcript: string,
    id: string,
    command = COMMAND,
  ): HookRun {
    const payload = {
      session_id: CODEX_SESSION,
      cwd: dir,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command },
      tool_use_id: id,
      transcript_path: transcript,
    };
    const env = { ...process.env };
    delete env.CLAUDE_CODE_SESSION_ID;
    const r = spawnSync(shell, [codexHook], {
      input: JSON.stringify(payload),
      encoding: "utf-8",
      env,
    });
    return { code: r.status ?? -1, stdout: r.stdout ?? "" };
  }

  const stateFile = (dir: string): string =>
    join(dir, ".navori/state/hooks/bash-outcome-watch", CODEX_SESSION);

  it("advises on the third consecutive identical failure, once, as additionalContext", () => {
    acrossShells((shell) => {
      const dir = project();
      const ids = ["exec-1", "exec-2", "exec-3", "exec-4"];
      const path = rollout(
        dir,
        ids.map((id) => itemCompleted(id, 1)),
      );
      const runs = ids.map((id) => call(shell, dir, path, id));
      expect(runs.map((r) => r.code)).toEqual([0, 0, 0, 0]);
      expect(runs.map((r) => r.stdout)).toEqual([
        "",
        "",
        expect.stringContaining('"hookEventName":"PostToolUse"'),
        "",
      ]);
      expect(runs[2]!.stdout).toContain("falló 3 veces");
      expect(runs[2]!.stdout).toContain("exit 1");
      return runs.map((r) => r.stdout !== "");
    });
  });

  it("a success resets the counter", () => {
    const dir = project();
    const ids = ["exec-1", "exec-2", "exec-3", "exec-4", "exec-5"];
    const path = rollout(dir, [
      itemCompleted("exec-1", 1),
      itemCompleted("exec-2", 1),
      itemCompleted("exec-3", 0),
      itemCompleted("exec-4", 1),
      itemCompleted("exec-5", 1),
    ]);
    expect(ids.map((id) => call("bash", dir, path, id).stdout)).toEqual(["", "", "", "", ""]);
  });

  it("is silent and never fails with no rollout, an unreadable one or no matching record", () => {
    const dir = project();
    const path = rollout(dir, [itemCompleted("other", 1), "not json {", ""]);
    expect(call("bash", dir, join(dir, "missing.jsonl"), "exec-1")).toEqual({
      code: 0,
      stdout: "",
    });
    expect(call("bash", dir, path, "exec-1")).toEqual({ code: 0, stdout: "" });
    expect(call("bash", dir, `${path}.txt`, "exec-1")).toEqual({ code: 0, stdout: "" });
    writeFileSync(path, "\u0000\u0001garbage exec-1 item_completed\n");
    expect(call("bash", dir, path, "exec-1")).toEqual({ code: 0, stdout: "" });
    expect(existsSync(stateFile(dir))).toBe(false);
  });

  it("ignores a record of another call whose output merely mentions this id and an exit code", () => {
    const dir = project();
    const path = rollout(dir, [itemCompleted("exec-9", 2, 'item_completed exec-1 "exit_code":2')]);
    for (let n = 0; n < 3; n += 1) {
      expect(call("bash", dir, path, "exec-1").stdout).toBe("");
    }
    expect(existsSync(stateFile(dir))).toBe(false);
  });

  it("never reads the output: failures with different output text share one signature", () => {
    const dir = project();
    const path = rollout(dir, [
      itemCompleted("exec-1", 1, "first error"),
      itemCompleted("exec-2", 1, "something else entirely"),
      itemCompleted("exec-3", 1, "yet another message"),
    ]);
    const runs = ["exec-1", "exec-2", "exec-3"].map((id) => call("bash", dir, path, id).stdout);
    expect(runs[2]).toContain("falló 3 veces");
    expect(readFileSync(stateFile(dir), "utf-8")).not.toContain("error");
  });

  it("reads only the bounded tail of a large rollout", () => {
    const dir = project();
    const filler = "x".repeat(2000);
    const lines = Array.from({ length: 800 }, (_unused, n) => itemCompleted(`old-${n}`, 0, filler));
    const path = rollout(dir, [itemCompleted("exec-1", 1), ...lines]);
    // `exec-1` sits beyond the 1 MiB tail, so it is not found: silence, no state.
    expect(call("bash", dir, path, "exec-1")).toEqual({ code: 0, stdout: "" });
    expect(existsSync(stateFile(dir))).toBe(false);
  });
});
