import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getCoreRoot } from "../render/bundled-assets.ts";
import { expandHookIncludes } from "../render/hook-includes.ts";
import { evaluatePlanGate } from "../plan/gate.ts";
import type { Workplan } from "../plan/schema.ts";

/**
 * Spec 0035 T2 (R4) — same verdict for the Claude and Codex shapes of the same
 * event, for every hook the payload adapter (`_partials/hook-input.sh`, D2)
 * covers. Each case feeds the SAME intent through both payload shapes and
 * asserts the decision (exit code / allow-deny) agrees.
 */

function installHook(script: string, destRel: string): string {
  const src = resolve(getCoreRoot(), `core-assets/hooks/${script}.sh`);
  const dir = mkdtempSync(join(tmpdir(), "navori-codex-payload-"));
  const path = join(dir, destRel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, expandHookIncludes(readFileSync(src, "utf-8")));
  chmodSync(path, 0o755);
  return path;
}

function run(
  hookPath: string,
  cwd: string,
  input: unknown,
  args: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): { status: number; stderr: string; stdout: string } {
  const result = spawnSync("bash", [hookPath, ...args], {
    cwd,
    input: JSON.stringify(input),
    encoding: "utf-8",
    env,
  });
  return { status: result.status ?? -1, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
}

function expectCodexAdvisory(stdout: string): void {
  const output: unknown = JSON.parse(stdout);
  expect(output).toEqual({ systemMessage: expect.any(String) });
  // Stop/SubagentStop are closed Codex schemas: no hookSpecificOutput or block.
  expect(Object.keys(output as Record<string, unknown>)).toEqual(["systemMessage"]);
}

let cwd: string;
beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "navori-codex-payload-repo-")));
  execFileSync("git", ["init", "--quiet"], { cwd });
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("guard-destructive — same verdict for paired Claude and Codex payloads", () => {
  it("blocks a fork bomb under both engines", () => {
    const claudeHook = installHook(
      "guard-destructive",
      "claude/.claude/hooks/guard-destructive.sh",
    );
    const codexHook = installHook("guard-destructive", "codex/.codex/hooks/guard-destructive.sh");
    const cmd = ":(){ :|:& };:";

    const claude = run(claudeHook, cwd, { tool_name: "Bash", tool_input: { command: cmd } });
    const codex = run(codexHook, cwd, {
      tool_name: "Bash",
      tool_input: { command: cmd },
      cwd,
    });

    expect(claude.status).toBe(2);
    expect(codex.status).toBe(2);
  });

  it("allows an ordinary read-only command under both engines", () => {
    const claudeHook = installHook(
      "guard-destructive",
      "claude/.claude/hooks/guard-destructive.sh",
    );
    const codexHook = installHook("guard-destructive", "codex/.codex/hooks/guard-destructive.sh");
    const cmd = "git status";

    const claude = run(claudeHook, cwd, { tool_name: "Bash", tool_input: { command: cmd } });
    const codex = run(codexHook, cwd, { tool_name: "Bash", tool_input: { command: cmd }, cwd });

    expect(claude.status).toBe(0);
    expect(codex.status).toBe(0);
  });
});

describe("implementer-no-markdown — same verdict for paired Claude and Codex payloads", () => {
  it("blocks the implementer writing a .md file under both engines", () => {
    const claudeHook = installHook(
      "implementer-no-markdown",
      "claude/.claude/hooks/implementer-no-markdown.sh",
    );
    const codexHook = installHook(
      "implementer-no-markdown",
      "codex/.codex/hooks/implementer-no-markdown.sh",
    );

    const claude = run(claudeHook, cwd, {
      agent_type: "implementer",
      tool_name: "Write",
      tool_input: { file_path: "notes.md" },
    });
    const codex = run(codexHook, cwd, {
      agent_type: "implementer",
      tool_name: "apply_patch",
      tool_input: { command: "*** Update File: notes.md\n@@\n-old\n+new\n" },
      cwd,
    });

    expect(claude.status).toBe(2);
    expect(codex.status).toBe(2);
  });

  it("allows the implementer writing a .ts file under both engines", () => {
    const claudeHook = installHook(
      "implementer-no-markdown",
      "claude/.claude/hooks/implementer-no-markdown.sh",
    );
    const codexHook = installHook(
      "implementer-no-markdown",
      "codex/.codex/hooks/implementer-no-markdown.sh",
    );

    const claude = run(claudeHook, cwd, {
      agent_type: "implementer",
      tool_name: "Write",
      tool_input: { file_path: "notes.ts" },
    });
    const codex = run(codexHook, cwd, {
      agent_type: "implementer",
      tool_name: "apply_patch",
      tool_input: { command: "*** Update File: notes.ts\n@@\n-old\n+new\n" },
      cwd,
    });

    expect(claude.status).toBe(0);
    expect(codex.status).toBe(0);
  });
});

describe("subagent-stop-handoff — same verdict for paired Claude and Codex payloads", () => {
  it("flags an implementer handoff missing every required key, under both shapes", () => {
    const hook = installHook(
      "subagent-stop-handoff",
      "shared/.claude/hooks/subagent-stop-handoff.sh",
    );
    mkdirSync(join(cwd, ".claude/progress"), { recursive: true });
    writeFileSync(join(cwd, ".claude/progress/impl_demo.json"), JSON.stringify({}));

    const claude = run(hook, cwd, {
      tool_name: "Agent",
      tool_input: { subagent_type: "implementer" },
      session_id: "claude1078",
    });
    const codex = run(hook, cwd, { agent_type: "implementer", session_id: "codex1078" }, ["codex"]);

    // Advisory hook: it never exits non-zero. The shared verdict is whether it
    // flags the broken handoff in its output, not the exit code.
    expect(claude.status).toBe(0);
    expect(codex.status).toBe(0);
    expectCodexAdvisory(codex.stdout);
    expect(JSON.parse(claude.stdout)).toMatchObject({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: expect.any(String) },
    });
  });

  it("does not stamp a failed emission and retries the same warning", () => {
    const hook = installHook(
      "subagent-stop-handoff",
      "codex/.codex/hooks/subagent-stop-handoff.sh",
    );
    mkdirSync(join(cwd, ".codex/progress"), { recursive: true });
    writeFileSync(join(cwd, ".codex/progress/impl_demo.json"), "{}");
    const fakeBin = join(cwd, "fake-bin");
    mkdirSync(fakeBin);
    for (const binary of ["node", "jq"]) {
      const path = join(fakeBin, binary);
      writeFileSync(path, "#!/bin/sh\nexit 1\n");
      chmodSync(path, 0o755);
    }
    const input = { agent_type: "implementer", session_id: "retry1078" };
    const env = { ...process.env, TMPDIR: cwd, PATH: `${fakeBin}:${process.env.PATH ?? ""}` };
    const failed = run(hook, cwd, input, ["codex"], env);
    expect(failed.status).toBe(0);
    expect(failed.stdout).toBe("");
    const retried = run(hook, cwd, input, ["codex"], { ...env, PATH: process.env.PATH });
    expect(retried.status).toBe(0);
    expectCodexAdvisory(retried.stdout);
    expect(run(hook, cwd, input, ["codex"], { ...env, PATH: process.env.PATH }).stdout).toBe("");
  });

  it("falls back to jq when node exists but fails", () => {
    const hook = installHook(
      "subagent-stop-handoff",
      "codex/.codex/hooks/subagent-stop-handoff.sh",
    );
    mkdirSync(join(cwd, ".codex/progress"), { recursive: true });
    writeFileSync(join(cwd, ".codex/progress/impl_demo.json"), "{}");
    const fakeBin = join(cwd, "fake-bin");
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, "node"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(fakeBin, "node"), 0o755);
    const result = run(hook, cwd, { agent_type: "implementer", session_id: "jq1078" }, ["codex"], {
      ...process.env,
      TMPDIR: cwd,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    });
    expect(result.status).toBe(0);
    expectCodexAdvisory(result.stdout);
  });
});

describe("stop-verify-reminder — Codex event output", () => {
  it("emits only the strict Stop advisory while preserving Claude context", () => {
    const hook = installHook("stop-verify-reminder", "codex/.codex/hooks/stop-verify-reminder.sh");
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd });
    execFileSync("git", ["config", "user.name", "Test"], { cwd });
    writeFileSync(join(cwd, "tracked.txt"), "before\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd });
    execFileSync("git", ["commit", "-qm", "seed"], { cwd });
    writeFileSync(join(cwd, "tracked.txt"), "after\n");
    const codex = run(hook, cwd, { hook_event_name: "Stop" }, ["codex"]);
    const claude = run(hook, cwd, { hook_event_name: "Stop" });
    expect(codex.status).toBe(0);
    expectCodexAdvisory(codex.stdout);
    expect(claude.status).toBe(0);
    expect(JSON.parse(claude.stdout)).toMatchObject({
      hookSpecificOutput: { hookEventName: "Stop", additionalContext: expect.any(String) },
    });
  });
});

/**
 * Spec 0037 T11 (R8, R9, R10) — redacted per-event fixtures from T9 corrida 2
 * (Codex 0.158.0, stub hooks under a per-invocation hook-trust bypass). Only the
 * fields that record lists are encoded: no Post `collaborationspawn_agent` fields
 * and no `collaborationwait_agent` shape beyond its tool name. `cwd` is the one
 * addition the shared adapter needs to resolve the project root.
 */
describe("Codex 0.158.0 observed payloads (T9 corrida 2) through the shared hook partials", () => {
  const CHILD_ID = "agent-redacted-1";

  function childPre(agentType: string, tool: "Bash" | "apply_patch", target: string): unknown {
    const toolInput =
      tool === "apply_patch"
        ? { command: `*** Add File: ${target}\n+synthetic\n` }
        : { command: `echo synthetic > ${target}` };
    return {
      hook_event_name: "PreToolUse",
      agent_type: agentType,
      agent_id: CHILD_ID,
      tool_name: tool,
      tool_input: toolInput,
      cwd,
    };
  }

  /** Runs the REAL adapter partials (`nv_tool`, `nv_subagent_type`) under a Codex-path script. */
  function probe(input: unknown): { tool: string; type: string } {
    const dir = mkdtempSync(join(tmpdir(), "navori-codex-probe-"));
    const path = join(dir, "codex/.codex/hooks/probe.sh");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      expandHookIncludes(
        "#!/usr/bin/env bash\n# navori:include extract-cmd\n# navori:include hook-input\n" +
          'printf "%s|%s" "$(nv_tool)" "$(nv_subagent_type)"\n',
      ),
    );
    const out = run(path, cwd, input).stdout;
    rmSync(dir, { recursive: true, force: true });
    const [tool = "", type = ""] = out.split("|");
    return { tool, type };
  }

  // Covers: R8, R9
  it.each(["Bash", "apply_patch"] as const)(
    "denies a child with top-level agent_type implementer writing .md via %s",
    (tool) => {
      const hook = installHook(
        "implementer-no-markdown",
        "codex/.codex/hooks/implementer-no-markdown.sh",
      );
      expect(run(hook, cwd, childPre("implementer", tool, "notes/impl.md")).status).toBe(2);
    },
  );

  // Covers: R8, R9
  it.each(["Bash", "apply_patch"] as const)(
    "allows scribe and the observed default child writing .md via %s",
    (tool) => {
      const hook = installHook(
        "implementer-no-markdown",
        "codex/.codex/hooks/implementer-no-markdown.sh",
      );
      expect(run(hook, cwd, childPre("scribe", tool, "notes/scribe.md")).status).toBe(0);
      // "default" is what a child spawned without agent_type reports: never an implementer.
      expect(run(hook, cwd, childPre("default", tool, "notes/default.md")).status).toBe(0);
    },
  );

  // Covers: R9
  it("does not derive a role from task_name alone", () => {
    const hook = installHook(
      "implementer-no-markdown",
      "codex/.codex/hooks/implementer-no-markdown.sh",
    );
    const noRole = {
      hook_event_name: "PreToolUse",
      tool_name: "apply_patch",
      tool_input: { command: "*** Add File: notes/x.md\n+synthetic\n", task_name: "implementer" },
      cwd,
    };
    expect(run(hook, cwd, noRole).status).toBe(0);
    expect(
      probe({
        tool_name: "collaborationspawn_agent",
        tool_input: { task_name: "implementer", message: "synthetic task" },
        cwd,
      }).type,
    ).toBe("");
  });

  // Covers: R9, R10
  it("keeps unobserved collaboration tool names raw and exposes the typed role only when passed", () => {
    const spawn = (toolInput: Record<string, string>) =>
      probe({
        hook_event_name: "PreToolUse",
        tool_name: "collaborationspawn_agent",
        tool_input: toolInput,
        cwd,
      });
    expect(spawn({ message: "synthetic task", task_name: "probe" })).toEqual({
      tool: "collaborationspawn_agent",
      type: "",
    });
    expect(spawn({ agent_type: "implementer", message: "synthetic task" }).type).toBe(
      "implementer",
    );
    expect(probe({ tool_name: "collaborationwait_agent", cwd }).tool).toBe(
      "collaborationwait_agent",
    );
  });

  // Covers: R9, R10
  it("reads top-level agent_type from SubagentStart and SubagentStop as recorded", () => {
    const start = {
      hook_event_name: "SubagentStart",
      agent_type: "implementer",
      agent_id: CHILD_ID,
      cwd,
    };
    const stop = {
      ...start,
      hook_event_name: "SubagentStop",
      agent_transcript_path: "/redacted/transcript",
      last_assistant_message: "synthetic",
      stop_hook_active: false,
    };
    expect(probe(start).type).toBe("implementer");
    expect(probe(stop).type).toBe("implementer");
    expect(probe({ ...start, agent_type: "default" }).type).toBe("default");
  });
});

const VALID_LEVEL1: Workplan = {
  feature: "demo",
  level: 1,
  classification: { score: 2, level: 1, signals: [] },
  objective: "Ship the gate.",
  acceptance: [{ id: "A1", description: "gate works", command: "bun test", expected: "pass" }],
  outOfScope: [],
  files: [],
  progress: { A1: "pendiente" },
  decisions: [],
};

describe("plan-gate — same verdict for paired Claude and Codex payloads", () => {
  function writeConfig(): void {
    writeFileSync(
      join(cwd, "navori.config.json"),
      JSON.stringify({
        name: "gate-demo",
        engines: ["claude", "codex"],
        preset: "custom",
        harness: { planTiers: true },
      }),
    );
  }

  it("does not mistake the observed Codex 0.158.0 delegation shape for a typed implementer", () => {
    writeConfig();
    // Redacted live PreToolUse: collaborationspawn_agent supplied only these
    // tool_input keys. The task name did not identify the child's agent role.
    const observed = evaluatePlanGate({
      cwd,
      tool_name: "collaborationspawn_agent",
      tool_input: { task_name: "implementer", message: "synthetic task" },
    });
    expect(observed.decision).toBe("allow");
    expect(
      evaluatePlanGate({
        cwd,
        tool_name: "collaborationspawn_agent",
        tool_input: { agent_type: "implementer", message: "synthetic task" },
      }).decision,
    ).toBe("deny");
  });

  // Covers: R4
  it("denies dispatch with no opening line under both payload shapes", () => {
    writeConfig();
    const claude = evaluatePlanGate({
      cwd,
      tool_input: { subagent_type: "implementer", prompt: "just do it" },
    });
    const codex = evaluatePlanGate({
      cwd,
      tool_input: { agent_type: "implementer", message: "just do it" },
    });
    expect(claude.decision).toBe("deny");
    expect(codex.decision).toBe("deny");
  });

  it("allows a valid workplan under both payload shapes from the neutral state root", () => {
    writeConfig();
    mkdirSync(join(cwd, ".navori/state/handoffs"), { recursive: true });
    writeFileSync(
      join(cwd, ".navori/state/handoffs/workplan_demo.json"),
      JSON.stringify(VALID_LEVEL1),
    );

    const claude = evaluatePlanGate({
      cwd,
      tool_input: { subagent_type: "implementer", prompt: "workplan: demo" },
    });
    const codex = evaluatePlanGate({
      cwd,
      tool_input: { agent_type: "implementer", message: "workplan: demo" },
    });
    expect(claude.decision).toBe("allow");
    expect(codex.decision).toBe("allow");
  });
});
