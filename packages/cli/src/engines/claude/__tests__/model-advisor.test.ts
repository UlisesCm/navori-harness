import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NavoriConfigSchema, type NavoriConfig } from "../../../lib/schema.ts";
import { buildClaudeSettings } from "../build-settings.ts";
import { renderClaudeEngine } from "../index.ts";

function config(): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "model-advisor",
    engines: ["claude"],
    preset: "custom",
    branchBase: "main",
    qualityGate: { fast: "bun lint", full: "bun test" },
    models: { implementer: "sonnet" },
    effort: { implementer: "medium" },
  });
}

function runHook(cwd: string, mode: string, payload: object): string {
  return execFileSync("bash", [join(cwd, ".claude/hooks/model-advisor.sh"), mode], {
    cwd,
    input: JSON.stringify(payload),
    encoding: "utf8",
  }).trim();
}

describe("Claude model advisor", () => {
  // Covers: R1, R2, R4, R5, R6
  it("advises once after verified main-session state and effort", () => {
    const cwd = mkdtempSync(join(tmpdir(), "navori-model-advisor-"));
    renderClaudeEngine(cwd, config());
    const session = {
      session_id: "session_123",
      cwd,
      model: "claude-opus-4-6",
      scratchpad_dir: mkdtempSync(join(tmpdir(), "navori-model-advisor-state-")),
    };
    expect(runHook(cwd, "claude-session-start", session)).toBe("");
    expect(existsSync(join(session.scratchpad_dir, "navori-model-advisor.json"))).toBe(true);
    expect(existsSync(join(cwd, ".claude", ".model-advisor"))).toBe(false);

    const output = runHook(cwd, "claude-pre-tool-use", {
      session_id: "session_123",
      cwd,
      scratchpad_dir: session.scratchpad_dir,
      effort: { level: "high" },
    });
    expect(output).toContain("Modelo recomendado disponible");
    expect(output).toContain("eficiencia de tokens");
    expect(output).toContain("`/model`");
    expect(runHook(cwd, "claude-pre-tool-use", { ...session, effort: { level: "high" } })).toBe("");
  });

  // Covers: R2, R5
  it("advises for Fable regardless of effort and never advises a subagent", () => {
    const cwd = mkdtempSync(join(tmpdir(), "navori-model-advisor-"));
    renderClaudeEngine(cwd, config());
    const session = {
      session_id: "session_456",
      cwd,
      model: "claude-fable-5",
      scratchpad_dir: mkdtempSync(join(tmpdir(), "navori-model-advisor-state-")),
    };
    runHook(cwd, "claude-session-start", session);
    expect(runHook(cwd, "claude-pre-tool-use", { ...session, effort: { level: "low" } })).toContain(
      "claude-fable-5",
    );

    runHook(cwd, "claude-session-start", { ...session, session_id: "session_789" });
    expect(
      runHook(cwd, "claude-pre-tool-use", {
        ...session,
        session_id: "session_789",
        agent_id: "subagent_1",
        effort: { level: "high" },
      }),
    ).toBe("");
  });

  // Covers: R1, R2, R4, R5, R7
  it.each([
    ["claude-opus-4-6", "high", true],
    ["claude-opus-4-6", "xhigh", true],
    ["claude-opus-4-6", "max", true],
    ["claude-opus-4-6", "medium", false],
    ["claude-sonnet-4-6", "high", false],
  ])(
    "emits advice only for supported Claude model and effort tuples: %s/%s",
    (model, effort, expected) => {
      const cwd = mkdtempSync(join(tmpdir(), "navori-model-advisor-"));
      const scratchpad_dir = mkdtempSync(join(tmpdir(), "navori-model-advisor-state-"));
      renderClaudeEngine(cwd, config());
      runHook(cwd, "claude-session-start", {
        session_id: "tuple_session",
        cwd,
        model,
        scratchpad_dir,
      });

      const output = runHook(cwd, "claude-pre-tool-use", {
        session_id: "tuple_session",
        cwd,
        scratchpad_dir,
        effort: { level: effort },
      });
      expect(output === "").toBe(!expected);
    },
  );

  // Covers: R1, R5
  it("fails closed when Claude does not provide scratchpad_dir", () => {
    const cwd = mkdtempSync(join(tmpdir(), "navori-model-advisor-"));
    renderClaudeEngine(cwd, config());
    expect(
      runHook(cwd, "claude-session-start", {
        session_id: "missing_scratchpad",
        cwd,
        model: "claude-opus-4-6",
      }),
    ).toBe("");
    expect(
      runHook(cwd, "claude-pre-tool-use", {
        session_id: "missing_scratchpad",
        cwd,
        effort: { level: "high" },
      }),
    ).toBe("");
  });

  // Covers: R1, R2, R5, R6
  it("registers only advisory lifecycle hooks without changing agent profiles", () => {
    const settings = buildClaudeSettings(config(), []);
    const hooks = settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    expect(
      (hooks.SessionStart ?? [])
        .flatMap((entry) => entry.hooks)
        .some((hook) => hook.command.includes("claude-session-start")),
    ).toBe(true);
    expect(
      (hooks.PostModelSwitch ?? [])
        .flatMap((entry) => entry.hooks)
        .some((hook) => hook.command.includes("claude-post-model-switch")),
    ).toBe(true);
    expect(
      (hooks.PreToolUse ?? [])
        .flatMap((entry) => entry.hooks)
        .some((hook) => hook.command.includes("claude-pre-tool-use")),
    ).toBe(true);
    expect(settings.effortLevel).toBeUndefined();
  });
});
