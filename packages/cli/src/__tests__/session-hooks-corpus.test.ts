import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expandHookIncludes } from "../lib/render/hook-includes.ts";
import { type FixtureFile, type HookCase, runHookIsolated } from "./helpers/hook-batch.ts";

/**
 * Spec 0059 T5 (R54, D35): one case per verdict class and mode argument, in every engine that
 * registers each session hook, before the hook enters shadow. Each case declares its state
 * (`fixture`) so the corpus replay recreates it, and asserts its class here, so a capture
 * (`NAVORI_HOOK_CORPUS=<dir>`) of this file is the seed of those hooks' corpus.
 *
 * The corpus replays the expanded asset with its templates unrendered: `qualityGate.fast` stays
 * the literal `{{shq:qualityGate.fast}}`, so a stub with that exact name stands in for the
 * project's gate runner.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const HOOKS = join(REPO_ROOT, "packages", "core", "core-assets", "hooks");
const ENGINE_DIRS = { claude: ".claude/hooks", codex: ".codex/hooks", pi: ".pi/navori/hooks" };
type Engine = keyof typeof ENGINE_DIRS;

/** Case cwds go after each test; installed hooks, shared by a describe's tests, at the end. */
const dirs: string[] = [];
const installed: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterAll(() => {
  for (const dir of installed.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string, owner = dirs): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  owner.push(dir);
  return dir;
}

/** The expanded core asset installed under an engine's hooks directory. */
function install(name: string, engine: Engine): string {
  const target = join(temp("navori-session-hook-", installed), ENGINE_DIRS[engine], name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, expandHookIncludes(readFileSync(join(HOOKS, name), "utf8")), {
    mode: 0o755,
  });
  return target;
}

/** An executable stub under the case's `bin/`. */
const stub = (name: string, body: string): FixtureFile => ({
  path: `bin/${name}`,
  content: `#!/bin/sh\n${body}\n`,
  mode: 0o755,
});

/**
 * Node's own directory, for hooks that run `node`. The replay swaps an nvm directory for one that
 * holds only Node, so a global `navori` installed next to it never reaches a case.
 */
const NODE_DIR = dirname(process.execPath);

interface CaseOptions {
  fixture?: FixtureFile[];
  args?: string[];
  /** Puts {@link NODE_DIR} on PATH. */
  node?: boolean;
  /** Env on top of PATH; `@cwd` inside a value stands for the case's cwd. */
  env?: Record<string, string>;
}

/**
 * A case in a fresh temp cwd whose PATH starts at its own `bin/`. `input` may be built from the
 * cwd, so a payload can carry paths under it (the capture turns them into `@CWD@`).
 */
function inTemp(input: object | ((cwd: string) => object), options: CaseOptions = {}): HookCase {
  const cwd = temp("navori-session-case-");
  const payload = typeof input === "function" ? input(cwd) : input;
  const path = [`${cwd}/bin`, ...(options.node === true ? [NODE_DIR] : []), "/usr/bin", "/bin"];
  const extra = Object.fromEntries(
    Object.entries(options.env ?? {}).map(([k, v]) => [k, v.replaceAll("@cwd", cwd)]),
  );
  return {
    input: JSON.stringify(payload),
    cwd,
    env: { PATH: path.join(":"), ...extra },
    fixture: options.fixture ?? [],
    ...(options.args === undefined ? {} : { args: options.args }),
  };
}

const GATE = "{{shq:qualityGate.fast}}";
const bash = (command: string, permission = "default") => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  permission_mode: permission,
  session_id: "corpus-session",
  tool_input: { command },
});

describe("quality-gate-pre-commit: every verdict class per engine", () => {
  const hook = "quality-gate-pre-commit.sh";
  const green = stub(GATE, "exit 0");
  const red = stub(GATE, "echo 'lint failed' >&2\nexit 1");
  const cached = stub("navori", '[ "$1 $2 $3" = "gate probe --clean" ] && exit 0\nexit 1');

  for (const engine of ["claude", "codex", "pi"] as const) {
    const path = install(hook, engine);
    const run = (c: HookCase) => runHookIsolated(path, "bash", c);
    const commit = (fixture: FixtureFile[], permission?: string) =>
      run(inTemp(bash("git commit -m x", permission), { fixture }));

    // Covers: R54
    it(`${engine}: skip, allow, block and the cache hit`, () => {
      expect(run(inTemp(bash("ls -la"))).status).toBe(0);
      const allowed = commit([green]);
      expect(allowed.status).toBe(0);
      expect(allowed.stderr).toContain("running quality-gate fast");
      const failed = commit([red]);
      expect(failed.status).toBe(2);
      expect(failed.stderr).toContain("quality-gate fast failed");
      const hit = commit([green, cached]);
      expect(hit.status).toBe(0);
      expect(hit.stderr).toContain("green fast result is cached");
    });

    // Covers: R54
    it(`${engine}: a missing runner asks where the host can, blocks elsewhere`, () => {
      const asked = commit([]);
      const blocked = commit([], "bypassPermissions");
      expect(blocked.status).toBe(2);
      if (engine === "codex") {
        expect(asked.status).toBe(2);
      } else {
        expect(asked.status).toBe(0);
        expect(asked.stdout).toContain('"permissionDecision":"ask"');
      }
    });
  }

  // Covers: R54
  it("pi: a push is gated too, claude and codex let it through", () => {
    for (const engine of ["pi", "claude"] as const) {
      const pushed = runHookIsolated(
        install(hook, engine),
        "bash",
        inTemp(bash("git push origin feature"), { fixture: [red] }),
      );
      expect(pushed.status).toBe(engine === "pi" ? 2 : 0);
    }
  });
});

describe("plan-gate: every verdict class per engine", () => {
  const hook = "plan-gate.sh";
  /** A `navori` whose `plan gate` prints the engine it was told and exits `status`. */
  const navori = (status: number) =>
    stub(
      "navori",
      [
        'case "$1 $2" in',
        `  "plan gate") cat >/dev/null; echo "plan gate for \${NAVORI_HOOK_ENGINE:-claude}" >&2; exit ${status} ;;`,
        '  "--version "*) echo "navori 0.1.0" ;;',
        "esac",
      ].join("\n"),
    );
  const newerHarness: FixtureFile = {
    path: "navori.config.json",
    content: '{ "harnessVersion": "9.0.0" }\n',
  };
  const dispatch = (permission = "default") => ({
    session_id: "corpus-session",
    hook_event_name: "PreToolUse",
    permission_mode: permission,
    tool_name: "Agent",
    tool_input: { subagent_type: "implementer", prompt: "workplan: corpus" },
  });

  for (const engine of ["claude", "codex"] as const) {
    const path = install(hook, engine);
    const run = (fixture: FixtureFile[], permission?: string) =>
      runHookIsolated(
        path,
        "bash",
        inTemp(dispatch(permission), { fixture, env: { CLAUDE_PROJECT_DIR: "@cwd" } }),
      );

    // Covers: R54
    it(`${engine}: allow, denied, denied with an outdated CLI and a broken subcommand`, () => {
      const allowed = run([navori(0)]);
      expect(allowed.status).toBe(0);
      expect(allowed.stderr).toContain(`plan gate for ${engine}`);
      const denied = run([navori(2)]);
      expect(denied.status).toBe(2);
      expect(denied.stderr).not.toContain("outdated");
      expect(run([navori(2), newerHarness]).stderr).toContain("the navori CLI is outdated");
      const broken = run([navori(1)]);
      if (engine === "codex") {
        expect(broken.status).toBe(2);
        expect(broken.stderr).toContain("no working 'plan' subcommand");
      } else {
        expect(broken.status).toBe(0);
        expect(broken.stdout).toContain('"permissionDecision":"ask"');
      }
    });

    // Covers: R54
    it(`${engine}: without navori it asks where the host can, blocks elsewhere`, () => {
      const missing = run([]);
      const bypass = run([], "bypassPermissions");
      expect(bypass.status).toBe(2);
      expect(bypass.stderr).toContain("navori is not installed");
      expect(missing.status).toBe(engine === "codex" ? 2 : 0);
      if (engine === "claude") expect(missing.stdout).toContain('"permissionDecision":"ask"');
    });
  }
});

describe("subagent-stop-handoff: codex SubagentStop verdicts", () => {
  const path = install("subagent-stop-handoff.sh", "codex");
  const stop = (agentType: string) => (cwd: string) => ({
    session_id: "corpus-session",
    hook_event_name: "SubagentStop",
    agent_id: "corpus-child",
    agent_type: agentType,
    agent_transcript_path: `${cwd}/child.jsonl`,
    cwd,
  });
  const handoff = (name: string, content: string): FixtureFile => ({
    path: `.navori/state/handoffs/${name}`,
    content,
  });
  const validImpl = JSON.stringify({
    feature: "corpus",
    status: "DONE",
    worktree: ".",
    branch: "b",
    commits: [],
    filesTouched: [],
    verification: [],
    markdownRequests: [],
  });
  // The stamp of a repeated warning lives under $TMPDIR, named after the cwd: a directory the
  // case never creates keeps it out, so each case stands alone.
  const run = (agentType: string, fixture: FixtureFile[]) =>
    runHookIsolated(
      path,
      "bash",
      inTemp(stop(agentType), {
        fixture,
        args: ["codex"],
        node: true,
        env: { TMPDIR: "@cwd/no-tmp" },
      }),
    );

  // Covers: R54
  it("clean with no handoffs or valid ones, dirty with an incomplete one", () => {
    expect(run("implementer", [])).toMatchObject({ status: 0, stdout: "" });
    expect(run("implementer", [handoff("impl_corpus.json", validImpl)]).stdout).toBe("");
    const missing = run("implementer", [handoff("impl_corpus.json", '{"feature":"corpus"}')]);
    expect(missing.status).toBe(0);
    expect(missing.stdout).toContain('"systemMessage"');
    expect(missing.stdout).toContain("sin clave");
    expect(missing.stdout).not.toContain("hookSpecificOutput");
    const review = run("reviewer", [handoff("review_corpus.md", "# Review\n\nno verdict\n")]);
    expect(review.stdout).toContain("sin veredicto");
    const scribe = run("scribe", [handoff("impl_corpus.md", "# Notes\n")]);
    expect(scribe.stdout).toContain("sin línea 'Status:'");
  });
});

describe("model-advisor: every non-deferred mode", () => {
  const claude = install("model-advisor.sh", "claude");
  const codex = install("model-advisor.sh", "codex");
  const state = (model: string, notified: boolean): FixtureFile => ({
    path: "pad/navori-model-advisor.json",
    content: JSON.stringify({ model, notified }),
  });
  const sentinel = (name: "skip" | "effort-gated"): FixtureFile => ({
    path: `pad/navori-model-advisor.${name}`,
    content: "",
  });
  const run = (
    hookPath: string,
    mode: string,
    payload: Record<string, unknown>,
    fixture: FixtureFile[] = [],
    env: Record<string, string> = {},
  ) =>
    runHookIsolated(
      hookPath,
      "bash",
      inTemp(
        (cwd) => ({ session_id: "corpus-session", scratchpad_dir: `${cwd}/pad`, ...payload }),
        {
          fixture,
          args: [mode],
          node: true,
          env,
        },
      ),
    );
  const silent = { status: 0, stdout: "" };

  // Covers: R54
  it("claude-session-start and claude-post-model-switch record the model in silence", () => {
    expect(run(claude, "claude-session-start", { model: "claude-opus-4" })).toMatchObject(silent);
    expect(run(claude, "claude-session-start", { model: "claude-fable-5" })).toMatchObject(silent);
    expect(run(claude, "claude-session-start", {})).toMatchObject(silent);
    expect(
      run(claude, "claude-session-start", { model: "claude-opus-4", agent_id: "child" }),
    ).toMatchObject(silent);
    expect(
      run(claude, "claude-post-model-switch", { to_model: "claude-sonnet-5" }, [
        state("claude-opus-4", true),
      ]),
    ).toMatchObject(silent);
  });

  // Covers: R54
  it("claude-stop recommends once for a high-effort Opus or Fable, and stays silent otherwise", () => {
    const opus = run(claude, "claude-stop", { effort: { level: "high" } }, [
      state("claude-opus-4", false),
    ]);
    expect(opus.status).toBe(0);
    expect(opus.stdout).toContain("claude-opus-4/high");
    const fable = run(claude, "claude-stop", {}, [state("claude-fable-5", false)]);
    expect(fable.stdout).toContain("`claude-fable-5`");
    expect(
      run(claude, "claude-stop", { effort: { level: "low" } }, [state("claude-opus-4", false)]),
    ).toMatchObject(silent);
    expect(
      run(claude, "claude-stop", {}, [state("claude-opus-4", true), sentinel("skip")]),
    ).toMatchObject(silent);
    expect(
      run(claude, "claude-stop", {}, [state("claude-opus-4", false), sentinel("effort-gated")], {
        CLAUDE_EFFORT: "low",
      }),
    ).toMatchObject(silent);
    expect(run(claude, "claude-stop", {}, [])).toMatchObject(silent);
  });

  // Covers: R54
  it("codex-session-start recommends only for the heavy model", () => {
    const heavy = run(codex, "codex-session-start", { model: "gpt-6-astra" });
    expect(heavy.status).toBe(0);
    expect(heavy.stdout).toContain('"systemMessage"');
    expect(run(codex, "codex-session-start", { model: "gpt-5.6-sol" })).toMatchObject(silent);
  });
});
