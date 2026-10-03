import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getCoreRoot } from "../render/bundled-assets.ts";
import { expandHookIncludes } from "../render/hook-includes.ts";
import { acrossShells, type HookShell } from "./helpers/shells.ts";
import { buildClaudeSettings } from "../../engines/claude/build-settings.ts";
import { resolveHarnessPlan } from "../../engines/shared/harness-plan.ts";
import type { NavoriConfig } from "../config/config.ts";

/**
 * Behavioral tests for core-assets/hooks/general-purpose-confirm.sh (spec 0039 R40).
 * Same shape as pr-publisher-confirm: it interrupts with `ask`, never blocks, and
 * stays silent for every other subagent.
 */

const runsBash = process.platform !== "win32";

/** The hook as a RENDERED repo runs it — includes expanded, as `render` does. */
const hookPath = (() => {
  const dir = mkdtempSync(join(tmpdir(), "navori-gp-src-"));
  const p = join(dir, "general-purpose-confirm.sh");
  writeFileSync(
    p,
    expandHookIncludes(
      readFileSync(resolve(getCoreRoot(), "core-assets/hooks/general-purpose-confirm.sh"), "utf-8"),
    ),
  );
  chmodSync(p, 0o755);
  return p;
})();

interface HookRun {
  code: number;
  stdout: string;
}

/** A `PreToolUse` Agent dispatch of `subagentType`. */
function agent(subagentType: string): Record<string, unknown> {
  return {
    session_id: "sess-gp-1",
    tool_name: "Agent",
    tool_input: { subagent_type: subagentType, description: "x", prompt: "y" },
  };
}

function runHook(shell: HookShell, payload: Record<string, unknown>): HookRun {
  const cwd = mkdtempSync(join(tmpdir(), "navori-gp-"));
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  const r = spawnSync(shell, [hookPath], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "" };
}

function run(payload: Record<string, unknown>): HookRun {
  return acrossShells((shell) => runHook(shell, payload));
}

describe.runIf(runsBash)("general-purpose-confirm.sh", () => {
  // Covers: R40, R70
  it("pide confirmación para general-purpose y nombra al scout, sin bloquear", () => {
    const r = run(agent("general-purpose"));
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      hookSpecificOutput: {
        hookEventName: string;
        permissionDecision: string;
        permissionDecisionReason: string;
      };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("scout");
  });

  // Covers: R40
  it.each(["scout", "implementer", "general-purpose-lite"])("se calla para %s", (type) => {
    const r = run(agent(type));
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  // Covers: R40
  it("filtra por subagent_type en el script: se calla para un tipo distinto", () => {
    const r = run(agent("Explore"));
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  // Covers: R40
  it("se calla cuando el payload menciona general-purpose fuera de subagent_type", () => {
    const r = run({ ...agent("scout"), prompt: "no uses general-purpose" });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });
});

/** The same rendered script, placed where Codex installs it (`$0` selects the branch). */
function runCodex(payload: Record<string, unknown>): HookRun {
  const dir = mkdtempSync(join(tmpdir(), "navori-gp-codex-"));
  mkdirSync(join(dir, ".codex/hooks"), { recursive: true });
  const p = join(dir, ".codex/hooks/general-purpose-confirm.sh");
  writeFileSync(p, readFileSync(hookPath, "utf-8"));
  chmodSync(p, 0o755);
  const r = spawnSync("bash", [p], { input: JSON.stringify(payload), encoding: "utf-8", cwd: dir });
  return { code: r.status ?? -1, stdout: r.stdout ?? "" };
}

describe.runIf(runsBash)("general-purpose-confirm.sh — Codex copy (spec 0041 R10)", () => {
  const spawn = (agentType: string): Record<string, unknown> => ({
    tool_name: "spawn_agent",
    tool_input: { agent_type: agentType, message: "x" },
  });

  // Covers: R10
  it("denies general-purpose as a confirmation, never ask and never allow", () => {
    const r = runCodex(spawn("general-purpose"));
    expect(r.code).toBe(0);
    const decision = JSON.parse(r.stdout).hookSpecificOutput.permissionDecision;
    expect(decision).toBe("deny");
    expect(r.stdout).not.toContain('"ask"');
    expect(r.stdout).not.toContain('"allow"');
  });

  // Covers: R10
  it("stays silent for any other agent_type", () => {
    const r = runCodex(spawn("scout"));
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
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

describe("general-purpose-confirm — wiring", () => {
  type Bucket = {
    matcher?: string;
    hooks: Array<{ command: string; if?: string }>;
  };
  const preToolUse = (config: NavoriConfig): Bucket[] =>
    (buildClaudeSettings(config, []).hooks as { PreToolUse?: Bucket[] }).PreToolUse ?? [];

  // Covers: R40, R70
  it("queda en PreToolUse(Agent) sin `if` (el filtro vive en el script)", () => {
    const hook = preToolUse(MINIMAL_CONFIG)
      .filter((b) => b.matcher === "Agent")
      .flatMap((b) => b.hooks)
      .find((h) => h.command.includes("general-purpose-confirm.sh"));
    expect(hook?.if).toBeUndefined();
  });

  // Covers: R40
  it("desaparece con el scout deshabilitado", () => {
    const commands = preToolUse({ ...MINIMAL_CONFIG, harness: { scout: false } } as NavoriConfig)
      .flatMap((b) => b.hooks)
      .map((h) => h.command);
    expect(commands.some((c) => c.includes("general-purpose-confirm.sh"))).toBe(false);
  });

  // Covers: R40
  it("el plan lo materializa solo con el scout habilitado", () => {
    const core = resolve(getCoreRoot(), "core-assets");
    const ids = (config: NavoriConfig): string[] =>
      resolveHarnessPlan(config, core, null).hooks.map((h) => h.id);
    expect(ids(MINIMAL_CONFIG)).toContain("general-purpose-confirm");
    expect(ids({ ...MINIMAL_CONFIG, harness: { scout: false } } as NavoriConfig)).not.toContain(
      "general-purpose-confirm",
    );
  });
});
