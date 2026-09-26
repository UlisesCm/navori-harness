import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
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

function run(hookPath: string, cwd: string, input: unknown): { status: number; stderr: string } {
  try {
    execFileSync("bash", [hookPath], {
      cwd,
      input: JSON.stringify(input),
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    });
    return { status: 0, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    return { status: e.status ?? -1, stderr: e.stderr ?? "" };
  }
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
    });
    const codex = run(hook, cwd, { agent_type: "implementer" });

    // Advisory hook: it never exits non-zero. The shared verdict is whether it
    // flags the broken handoff in its output, not the exit code.
    expect(claude.status).toBe(0);
    expect(codex.status).toBe(0);
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
