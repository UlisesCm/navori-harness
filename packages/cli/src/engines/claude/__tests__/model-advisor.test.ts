import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NavoriConfigSchema, type NavoriConfig } from "../../../lib/config/schema.ts";
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

interface HookRun {
  /** Prepended to `PATH`, to put the decoy `node` of `decoyNode()` first. */
  readonly pathEntry?: string;
  /**
   * Value of `$CLAUDE_EFFORT`; `null` unsets it. Defaults to the payload's
   * `effort.level`, which is what the host does — the docs define both as the
   * same level. Never inherit it from the runner's environment: a suite run
   * inside Claude Code would otherwise read the developer's live effort.
   */
  readonly effort?: string | null;
}

function runHook(cwd: string, mode: string, payload: object, run: HookRun = {}): string {
  const level = (payload as { effort?: { level?: string } }).effort?.level;
  const effort = run.effort === undefined ? (level ?? null) : run.effort;
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (run.pathEntry) env.PATH = `${run.pathEntry}:${process.env.PATH ?? ""}`;
  if (effort === null) delete env.CLAUDE_EFFORT;
  else env.CLAUDE_EFFORT = effort;
  return execFileSync("bash", [join(cwd, ".claude/hooks/model-advisor.sh"), mode], {
    cwd,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env,
  }).trim();
}

/** Renders the harness and returns the repo plus a fresh scratchpad dir. */
function session(): { cwd: string; scratchpadDir: string } {
  const cwd = mkdtempSync(join(tmpdir(), "navori-model-advisor-"));
  renderClaudeEngine(cwd, config());
  return { cwd, scratchpadDir: mkdtempSync(join(tmpdir(), "navori-model-advisor-state-")) };
}

const sentinel = (scratchpadDir: string, kind: "skip" | "effort-gated"): boolean =>
  existsSync(join(scratchpadDir, `navori-model-advisor.${kind}`));

/**
 * Puts a decoy `node` first on the PATH that records every invocation instead
 * of running the hook's script, so a test can assert on the spawn itself
 * rather than on the hook's output. Returns the marker path the decoy touches.
 */
function decoyNode(): { pathEntry: string; marker: string } {
  const pathEntry = mkdtempSync(join(tmpdir(), "navori-model-advisor-bin-"));
  const marker = join(pathEntry, "spawned");
  writeFileSync(
    join(pathEntry, "node"),
    `#!/bin/sh\ncat >/dev/null 2>&1\necho spawned >> "${marker}"\n`,
  );
  chmodSync(join(pathEntry, "node"), 0o755);
  return { pathEntry, marker };
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

  // Covers: R5, R8
  it("never spawns a subprocess for a subagent firing", () => {
    const cwd = mkdtempSync(join(tmpdir(), "navori-model-advisor-"));
    renderClaudeEngine(cwd, config());
    const { pathEntry, marker } = decoyNode();
    const session = {
      session_id: "session_spawn",
      cwd,
      scratchpad_dir: mkdtempSync(join(tmpdir(), "navori-model-advisor-state-")),
      effort: { level: "high" },
    };

    expect(
      runHook(cwd, "claude-pre-tool-use", { ...session, agent_id: "subagent_1" }, { pathEntry }),
    ).toBe("");
    expect(
      runHook(cwd, "claude-pre-tool-use", { ...session, agent_type: "implementer" }, { pathEntry }),
    ).toBe("");
    expect(existsSync(marker)).toBe(false);

    // The decoy proves a negative, so pin that a main-thread firing still reaches it.
    expect(runHook(cwd, "claude-pre-tool-use", session, { pathEntry })).toBe("");
    expect(existsSync(marker)).toBe(true);
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

  // Covers: R9
  it("stops spawning node once the session state settles the outcome", () => {
    const { cwd, scratchpadDir } = session();
    const { pathEntry, marker } = decoyNode();
    const payload = { session_id: "settled", cwd, scratchpad_dir: scratchpadDir };

    runHook(cwd, "claude-session-start", { ...payload, model: "claude-opus-4-6" });
    expect(sentinel(scratchpadDir, "effort-gated")).toBe(true);
    // Opus at a low tier can never advise, so the shell answers alone — the
    // poll this fixes paid a `node` spawn per tool call for exactly this case.
    for (const level of ["low", "medium"]) {
      expect(runHook(cwd, "claude-pre-tool-use", { ...payload, effort: { level } })).toBe("");
      expect(
        runHook(cwd, "claude-pre-tool-use", { ...payload, effort: { level } }, { pathEntry }),
      ).toBe("");
    }
    expect(existsSync(marker)).toBe(false);

    // A model that no effort can qualify is settled at SessionStart itself.
    const sonnet = session();
    runHook(sonnet.cwd, "claude-session-start", {
      session_id: "settled_sonnet",
      cwd: sonnet.cwd,
      model: "claude-sonnet-4-6",
      scratchpad_dir: sonnet.scratchpadDir,
    });
    expect(sentinel(sonnet.scratchpadDir, "skip")).toBe(true);
    expect(
      runHook(
        sonnet.cwd,
        "claude-pre-tool-use",
        {
          session_id: "settled_sonnet",
          cwd: sonnet.cwd,
          scratchpad_dir: sonnet.scratchpadDir,
          effort: { level: "max" },
        },
        { pathEntry },
      ),
    ).toBe("");
    expect(existsSync(marker)).toBe(false);
  });

  // Covers: R1, R9
  it("keeps advising when the user raises the effort mid-session", () => {
    const { cwd, scratchpadDir } = session();
    const payload = { session_id: "raised", cwd, scratchpad_dir: scratchpadDir };
    runHook(cwd, "claude-session-start", { ...payload, model: "claude-opus-4-6" });

    expect(runHook(cwd, "claude-pre-tool-use", { ...payload, effort: { level: "medium" } })).toBe(
      "",
    );
    expect(
      runHook(cwd, "claude-pre-tool-use", { ...payload, effort: { level: "high" } }),
    ).toContain("Modelo recomendado disponible");
    // Advised: from here the shell can settle every remaining firing.
    expect(sentinel(scratchpadDir, "skip")).toBe(true);
    expect(sentinel(scratchpadDir, "effort-gated")).toBe(false);
  });

  // Covers: R5, R9
  it("falls through to node when the host does not expose $CLAUDE_EFFORT", () => {
    const { cwd, scratchpadDir } = session();
    const payload = { session_id: "no_env", cwd, scratchpad_dir: scratchpadDir };
    runHook(cwd, "claude-session-start", { ...payload, model: "claude-opus-4-6" });

    // The host omits the variable when the model has no effort parameter; the
    // guard must never treat "undefined" as "low".
    expect(
      runHook(
        cwd,
        "claude-pre-tool-use",
        { ...payload, effort: { level: "high" } },
        {
          effort: null,
        },
      ),
    ).toContain("Modelo recomendado disponible");
  });

  // Covers: R2, R9
  it("never gates Fable behind the effort sentinel", () => {
    const { cwd, scratchpadDir } = session();
    const payload = { session_id: "fable_gate", cwd, scratchpad_dir: scratchpadDir };
    runHook(cwd, "claude-session-start", { ...payload, model: "claude-fable-5" });

    expect(sentinel(scratchpadDir, "skip")).toBe(false);
    expect(sentinel(scratchpadDir, "effort-gated")).toBe(false);
    expect(runHook(cwd, "claude-pre-tool-use", { ...payload, effort: { level: "low" } })).toContain(
      "claude-fable-5",
    );
  });

  // Covers: R1, R9
  it("replaces the stale sentinel when the session model changes", () => {
    const { cwd, scratchpadDir } = session();
    const payload = { session_id: "switched", cwd, scratchpad_dir: scratchpadDir };
    runHook(cwd, "claude-session-start", { ...payload, model: "claude-sonnet-4-6" });
    expect(sentinel(scratchpadDir, "skip")).toBe(true);

    runHook(cwd, "claude-post-model-switch", { ...payload, to_model: "claude-opus-4-6" });
    expect(sentinel(scratchpadDir, "skip")).toBe(false);
    expect(sentinel(scratchpadDir, "effort-gated")).toBe(true);
    expect(
      runHook(cwd, "claude-pre-tool-use", { ...payload, effort: { level: "high" } }),
    ).toContain("Modelo recomendado disponible");
  });

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
