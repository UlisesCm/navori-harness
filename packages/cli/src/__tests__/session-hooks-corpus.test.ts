import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expandHookIncludes } from "../lib/render/hook-includes.ts";
import { getCoreRoot } from "../lib/render/bundled-assets.ts";
import { runHookBatch, type HookCase } from "./helpers/hook-batch.ts";

/**
 * Spec 0059 D35, R54 — the invocations that widen the verdict corpus of the five session hooks.
 *
 * Each case is a real invocation of the core hook asset, installed where its engine registers it
 * (`.claude/hooks`, `.codex/hooks`, `.pi/navori/hooks`), with the hook's own mode as its argument
 * and the state it reads in its working directory. Run with `NAVORI_HOOK_CORPUS=<dir>`, the batch
 * helper records each one; `hook-verdict-replay.mjs --generate <dir> --hook <h>.sh --append`
 * turns the capture into committed cases, with the expected output of the real shell. The cases
 * here are also the check that every hook runs to a verdict (0 or 2) in each mode.
 *
 * `session-hooks-corpus-matrix.test.ts` is the other half: it fails when the committed corpus lacks
 * a verdict class of a hook, mode or engine.
 */

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..", "..", "..");
const NODE_DIR = dirname(process.execPath);
/** The directory the replay rebinds to its local CLI, so `navori` is the checkout's own. */
const TOOLS = join(REPO_ROOT, "packages", "cli", "node_modules", ".bin");
const PATH = `${TOOLS}:${NODE_DIR}:/usr/bin:/bin`;
/** A PATH without any `navori`, for the "not installed" branch. */
const PATH_WITHOUT_NAVORI = `${NODE_DIR}:/usr/bin:/bin`;

const ENGINE_DIRS = {
  claude: [".claude", "hooks"],
  codex: [".codex", "hooks"],
  pi: [".pi", "navori", "hooks"],
} as const;
type Engine = keyof typeof ENGINE_DIRS;

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

/** The real asset, expanded the way the replay expands it, installed for `engine`. */
function install(hook: string, engine: Engine): string {
  const root = mkdtempSync(join(tmpdir(), "navori-session-hooks-"));
  roots.push(root);
  const dir = join(root, ...ENGINE_DIRS[engine]);
  mkdirSync(dir, { recursive: true });
  const source = readFileSync(resolve(getCoreRoot(), "core-assets/hooks", hook), "utf-8");
  const path = join(dir, hook);
  writeFileSync(path, expandHookIncludes(source));
  chmodSync(path, 0o755);
  return path;
}

/** A fresh working directory holding `files`, the state the hook reads. */
function workdir(files: Record<string, string> = {}, git = false): string {
  const dir = mkdtempSync(join(tmpdir(), "navori-session-case-"));
  roots.push(dir);
  if (git)
    spawnSync("git", ["init", "-q"], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", HOME: dir },
    });
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

interface Invocation {
  /** What this case is for: the verdict class it stands for. */
  label: string;
  args?: string[];
  /** The payload, given the case's working directory. */
  payload: (cwd: string) => Record<string, unknown>;
  files?: Record<string, string>;
  env?: Record<string, string>;
  /** The working directory is a Git work tree (the plan gate refuses any other). */
  git?: boolean;
}

function drive(hook: string, engine: Engine, cases: readonly Invocation[]): void {
  const path = install(hook, engine);
  const batch: HookCase[] = cases.map((c): HookCase => {
    const cwd = workdir(c.files, c.git);
    return {
      input: JSON.stringify(c.payload(cwd)),
      cwd,
      args: c.args ?? [],
      env: {
        PATH,
        HOME: cwd,
        TMPDIR: cwd,
        CLAUDE_PROJECT_DIR: cwd,
        ...c.env,
      },
    };
  });
  const results = runHookBatch(path, "bash", batch);
  results.forEach((result, i) => {
    // A verdict, never a crash: 0 allows or advises, 2 blocks.
    expect([0, 2], `${hook} ${engine} ${cases[i]?.label}`).toContain(result.status);
  });
}

const advisorState = (model: string, notified: boolean): Record<string, string> => ({
  "scratch/navori-model-advisor.json": JSON.stringify({ model, notified }),
});

describe("model-advisor: the modes of each engine", () => {
  // Covers: R54
  it("claude: session start, post model switch and stop, in each state they read", () => {
    const scratch = (cwd: string): string => join(cwd, "scratch");
    const base = (cwd: string): Record<string, unknown> => ({
      session_id: "s1",
      cwd,
      scratchpad_dir: scratch(cwd),
    });
    drive("model-advisor.sh", "claude", [
      {
        label: "session start records the model",
        args: ["claude-session-start"],
        payload: (cwd) => ({
          ...base(cwd),
          hook_event_name: "SessionStart",
          model: "claude-opus-4",
        }),
      },
      {
        label: "session start of a model nothing can advise on",
        args: ["claude-session-start"],
        payload: (cwd) => ({
          ...base(cwd),
          hook_event_name: "SessionStart",
          model: "claude-haiku-4",
        }),
      },
      {
        label: "session start without a model",
        args: ["claude-session-start"],
        payload: (cwd) => ({ ...base(cwd), hook_event_name: "SessionStart" }),
      },
      {
        label: "session start of a subagent is not advised",
        args: ["claude-session-start"],
        payload: (cwd) => ({ ...base(cwd), agent_id: "a1", model: "claude-opus-4" }),
      },
      {
        label: "post model switch keeps an advised session settled",
        args: ["claude-post-model-switch"],
        files: advisorState("claude-opus-4", true),
        payload: (cwd) => ({
          ...base(cwd),
          hook_event_name: "PostModelSwitch",
          to_model: "claude-fable-5",
        }),
      },
      {
        label: "post model switch records the new model",
        args: ["claude-post-model-switch"],
        payload: (cwd) => ({
          ...base(cwd),
          hook_event_name: "PostModelSwitch",
          to_model: "claude-opus-4",
        }),
      },
      {
        label: "post model switch without a target model",
        args: ["claude-post-model-switch"],
        payload: (cwd) => ({ ...base(cwd), hook_event_name: "PostModelSwitch" }),
      },
      {
        label: "stop advises on a model that qualifies at any effort",
        args: ["claude-stop"],
        files: advisorState("claude-fable-5", false),
        payload: (cwd) => ({ ...base(cwd), hook_event_name: "Stop" }),
      },
      {
        label: "stop advises on a high-effort opus (effort from the payload)",
        args: ["claude-stop"],
        files: advisorState("claude-opus-4", false),
        payload: (cwd) => ({ ...base(cwd), hook_event_name: "Stop", effort: { level: "high" } }),
      },
      {
        label: "stop advises on a high-effort opus (effort from the environment)",
        args: ["claude-stop"],
        files: advisorState("claude-opus-4", false),
        env: { CLAUDE_EFFORT: "max" },
        payload: (cwd) => ({ ...base(cwd), hook_event_name: "Stop" }),
      },
      {
        label: "stop stays silent on a medium-effort opus",
        args: ["claude-stop"],
        files: advisorState("claude-opus-4", false),
        env: { CLAUDE_EFFORT: "medium" },
        payload: (cwd) => ({ ...base(cwd), hook_event_name: "Stop" }),
      },
      {
        label: "stop stays silent once advised",
        args: ["claude-stop"],
        files: advisorState("claude-fable-5", true),
        payload: (cwd) => ({ ...base(cwd), hook_event_name: "Stop" }),
      },
      {
        label: "stop with no recorded state",
        args: ["claude-stop"],
        payload: (cwd) => ({ ...base(cwd), hook_event_name: "Stop" }),
      },
      {
        label: "stop with no scratchpad",
        args: ["claude-stop"],
        payload: (cwd) => ({ session_id: "s1", cwd, hook_event_name: "Stop" }),
      },
      {
        label: "stop settled by the shell's skip sentinel",
        args: ["claude-stop"],
        files: {
          ...advisorState("claude-opus-4", false),
          "scratch/navori-model-advisor.skip": "",
        },
        payload: (cwd) => ({ ...base(cwd), hook_event_name: "Stop" }),
      },
      {
        label: "stop gated by the effort sentinel on a low effort",
        args: ["claude-stop"],
        files: {
          ...advisorState("claude-opus-4", false),
          "scratch/navori-model-advisor.effort-gated": "",
        },
        env: { CLAUDE_EFFORT: "low" },
        payload: (cwd) => ({ ...base(cwd), hook_event_name: "Stop" }),
      },
      {
        label: "stop of a subagent",
        args: ["claude-stop"],
        files: advisorState("claude-fable-5", false),
        payload: (cwd) => ({ ...base(cwd), hook_event_name: "Stop", agent_id: "a1" }),
      },
    ]);
  });

  // Covers: R54
  it("codex: session start advises on the one model it knows and is silent on the rest", () => {
    drive("model-advisor.sh", "codex", [
      {
        label: "session start of the advised model",
        args: ["codex-session-start"],
        payload: (cwd) => ({
          session_id: "s1",
          cwd,
          hook_event_name: "SessionStart",
          model: "gpt-6-astra",
        }),
      },
      {
        label: "session start of another model",
        args: ["codex-session-start"],
        payload: (cwd) => ({
          session_id: "s1",
          cwd,
          hook_event_name: "SessionStart",
          model: "gpt-5.6-sol",
        }),
      },
      {
        label: "session start without a model",
        args: ["codex-session-start"],
        payload: (cwd) => ({ session_id: "s1", cwd, hook_event_name: "SessionStart" }),
      },
      {
        label: "session start of a subagent",
        args: ["codex-session-start"],
        payload: (cwd) => ({ session_id: "s1", cwd, agent_id: "a1", model: "gpt-6-astra" }),
      },
    ]);
  });

  // Covers: R54
  it("an unknown mode advises nothing", () => {
    drive("model-advisor.sh", "claude", [
      {
        label: "unknown mode",
        args: ["nonsense"],
        payload: (cwd) => ({ session_id: "s1", cwd, model: "claude-fable-5" }),
      },
      {
        label: "no mode at all",
        payload: (cwd) => ({ session_id: "s1", cwd, model: "claude-fable-5" }),
      },
    ]);
  });
});

/** A config `readConfig` accepts, with plan tiers on (the gate only acts then). */
const GATED_CONFIG = JSON.stringify({
  ...JSON.parse(
    readFileSync(
      join(
        REPO_ROOT,
        "scripts",
        "js",
        "rust-oracle",
        "fixtures",
        "fresh-init",
        "navori.config.json",
      ),
      "utf8",
    ),
  ),
  harness: { planTiers: true },
});
const VERIFY = "| verify: `true` → exit 0";

describe("plan-gate: the dispatches of the Claude engine", () => {
  // Covers: R54
  it("claude: who may dispatch, with and without the CLI", () => {
    const dispatch = (
      cwd: string,
      role: string,
      opening: string,
      tool = "Agent",
    ): Record<string, unknown> => ({
      session_id: "s1",
      cwd,
      hook_event_name: "PreToolUse",
      tool_name: tool,
      tool_input: { subagent_type: role, description: "d", prompt: `${opening}\n${role}` },
    });
    const gated = { "navori.config.json": GATED_CONFIG };
    const level0 = `nivel-0: README.md demo ${VERIFY}`;
    drive("plan-gate.sh", "claude", [
      {
        label: "implementer with no opening line",
        payload: (cwd) => dispatch(cwd, "implementer", "just do it"),
        files: gated,
        git: true,
      },
      {
        label: "implementer naming a workplan that does not exist",
        payload: (cwd) => dispatch(cwd, "implementer", "workplan: demo"),
        files: gated,
        git: true,
      },
      {
        label: "implementer with a nivel-0 opening",
        payload: (cwd) => dispatch(cwd, "implementer", level0),
        files: gated,
        git: true,
      },
      {
        label: "implementer with plan tiers off",
        payload: (cwd) => dispatch(cwd, "implementer", "just do it"),
        files: {
          "navori.config.json": JSON.stringify({
            ...JSON.parse(GATED_CONFIG),
            harness: { planTiers: false },
          }),
        },
      },
      {
        label: "scout is never gated",
        payload: (cwd) => dispatch(cwd, "scout", "look around"),
        files: gated,
        git: true,
      },
      {
        label: "reviewer is never gated",
        payload: (cwd) => dispatch(cwd, "reviewer", "review"),
        files: gated,
        git: true,
      },
      {
        label: "the Task tool is gated like Agent",
        payload: (cwd) => dispatch(cwd, "implementer", "just do it", "Task"),
        files: gated,
        git: true,
      },
      {
        label: "another tool is not a dispatch",
        payload: (cwd) => ({
          session_id: "s1",
          cwd,
          tool_name: "Bash",
          tool_input: { command: "ls" },
        }),
      },
      {
        label: "a dispatch without a role",
        payload: (cwd) => ({
          session_id: "s1",
          cwd,
          tool_name: "Agent",
          tool_input: { prompt: "x" },
        }),
      },
      { label: "an unreadable payload", payload: () => ({}) },
      {
        label: "the CLI is not installed",
        payload: (cwd) => dispatch(cwd, "implementer", level0),
        files: gated,
        git: true,
        env: { PATH: PATH_WITHOUT_NAVORI },
      },
    ]);
  });
});

describe("subagent-stop-handoff: Codex SubagentStop and the child capture", () => {
  // Covers: R54
  it("codex: a stop with and without handoffs to check, and the capture start", () => {
    const stop = (cwd: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      session_id: "s1",
      cwd,
      hook_event_name: "SubagentStop",
      agent_id: "child-1",
      agent_type: "implementer",
      ...extra,
    });
    const handoffs = ".navori/state/handoffs";
    drive("subagent-stop-handoff.sh", "codex", [
      { label: "stop with no handoffs directory", args: ["codex"], payload: (cwd) => stop(cwd) },
      {
        label: "stop with a sound handoff",
        args: ["codex"],
        files: { [`${handoffs}/impl_demo.json`]: '{"feature":"demo","status":"done"}' },
        payload: (cwd) => stop(cwd),
      },
      {
        label: "stop with an empty handoff",
        args: ["codex"],
        files: { [`${handoffs}/impl_demo.json`]: "" },
        payload: (cwd) => stop(cwd),
      },
      {
        label: "stop with an unreadable handoff",
        args: ["codex"],
        files: { [`${handoffs}/impl_demo.json`]: "{not json" },
        payload: (cwd) => stop(cwd),
      },
      {
        label: "stop of an agent type that leaves no handoff",
        args: ["codex"],
        files: { [`${handoffs}/impl_demo.json`]: "" },
        payload: (cwd) => stop(cwd, { agent_type: "scout" }),
      },
      {
        label: "stop without a payload identity",
        args: ["codex"],
        payload: () => ({ hook_event_name: "SubagentStop" }),
      },
      {
        label: "child capture start only observes",
        args: ["codex", "capture-start"],
        payload: (cwd) =>
          stop(cwd, {
            hook_event_name: "SubagentStart",
            transcript_path: join(cwd, "rollout.jsonl"),
          }),
      },
    ]);
  });
});

describe("quality-gate-pre-commit: Codex and Pi commits, pushes and other calls", () => {
  // Covers: R54
  it("codex and pi: what the gate decides for each Bash command", () => {
    const bash = (cwd: string, command: string): Record<string, unknown> => ({
      session_id: "s1",
      cwd,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
    });
    const config = JSON.stringify({
      name: "demo",
      engines: ["claude"],
      qualityGate: { fast: "true", full: "true" },
    });
    for (const engine of ["codex", "pi"] as const) {
      drive("quality-gate-pre-commit.sh", engine, [
        {
          label: "a commit with a gate configured",
          payload: (cwd) => bash(cwd, "git commit -m x"),
          files: { "navori.config.json": config },
        },
        { label: "a commit with no config", payload: (cwd) => bash(cwd, "git commit -m x") },
        {
          label: "a commit amending",
          payload: (cwd) => bash(cwd, "git commit --amend --no-edit"),
          files: { "navori.config.json": config },
        },
        {
          label: "a commit with the gate skipped on the line",
          payload: (cwd) => bash(cwd, "git commit --no-verify -m x"),
          files: { "navori.config.json": config },
        },
        {
          label: "a push",
          payload: (cwd) => bash(cwd, "git push origin main"),
          files: { "navori.config.json": config },
        },
        {
          label: "a push of a branch",
          payload: (cwd) => bash(cwd, "git push -u origin feat/x"),
          files: { "navori.config.json": config },
        },
        { label: "a command that is neither", payload: (cwd) => bash(cwd, "ls -la") },
        { label: "a git command that is neither", payload: (cwd) => bash(cwd, "git status") },
        {
          label: "another tool",
          payload: (cwd) => ({
            session_id: "s1",
            cwd,
            tool_name: "Edit",
            tool_input: { file_path: "x" },
          }),
        },
        { label: "an unreadable payload", payload: () => ({}) },
      ]);
    }
  });
});
