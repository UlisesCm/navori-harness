import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { getCoreRoot } from "../render/bundled-assets.ts";
import { shellSingleQuote } from "../primitives/shell-escape.ts";
import { interpolate } from "../render/interpolate.ts";
import { expandHookIncludes } from "../render/hook-includes.ts";
import type { NavoriConfig } from "../config/config.ts";
import { shellSensitive, type HookShell } from "./helpers/shells.ts";

const GATE_SENSITIVE =
  "runner lookup via PATH, `command -v` and exit-status propagation of the gate are shell-specific";

/**
 * #1117 — what a core gate hook EXITS WITH is its verdict, and `PreToolUse`
 * reads exactly one code as a block (2). A gate whose tool failed has no
 * verdict: under a Claude hook the user is asked, Codex and git hooks keep
 * blocking. The plugin scanner gates (#510/#511) were retired with jscpd and
 * semgrep; these cases drive the quality gate, guard-destructive and plan-gate.
 */

const runsBash = process.platform !== "win32";
/** /usr/bin + /bin give the real git/sed/date the hooks need. */
const BASE_PATH = "/usr/bin:/bin";

/** `PreToolUse`'s only blocking code. */
const BLOCKS = 2;
const CLEAN = 0;

/**
 * #1117 — a gate whose TOOL failed has no verdict. Under a Claude PreToolUse
 * hook the user is asked (exit 0 + `permissionDecision: "ask"`); Codex drops
 * that field, and a git hook / CLI has nobody to ask, so both keep blocking.
 * Real verdicts (red gate, semgrep findings) stay hard blocks everywhere.
 */
const hasJq = spawnSync("jq", ["--version"], { env: { PATH: BASE_PATH } }).status === 0;
const HOOK_PAYLOAD = (
  cwd: string,
  command = "git commit -m x",
  permissionMode: string | null = "default",
): string =>
  JSON.stringify({
    session_id: "s1",
    cwd,
    hook_event_name: "PreToolUse",
    ...(permissionMode === null ? {} : { permission_mode: permissionMode }),
    tool_name: "Bash",
    tool_input: { command },
  });

interface AskRun {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Audit events written by the run. */
  events: { verdict?: string; reason?: string; kind?: string }[];
}

/**
 * Run `script` (copied to `relPath` under the fixture, so `.codex/` placement
 * can be simulated) with `input` on stdin and a throwaway audit root.
 */
function runAsk(
  shell: HookShell,
  dir: string,
  binDir: string,
  script: string,
  relPath: string,
  input: string,
  /** Replaces the `navori` shim: null = no binary on PATH; a string = wrapper body. */
  navoriShim?: string | null,
): AskRun {
  const target = join(dir, relPath);
  mkdirSync(resolve(target, ".."), { recursive: true });
  writeFileSync(target, readFileSync(script, "utf-8"));
  chmodSync(target, 0o755);
  const auditsRoot = realpathSync(mkdtempSync(join(tmpdir(), "navori-1117-audits-")));
  mkdirSync(join(auditsRoot, basename(dir)), { mode: 0o700 });
  const realNavori = `exec '${process.execPath}' '${resolve("dist/index.js")}' "$@"`;
  if (navoriShim !== null)
    writeFileSync(join(binDir, "navori"), `#!/bin/sh\n${navoriShim ?? ""}\n${realNavori}\n`, {
      mode: 0o700,
    });
  const log = join(auditsRoot, basename(dir), "session-s1.log");
  writeFileSync(
    log,
    `${JSON.stringify({ event: "start", host: relPath.includes(".codex/") ? "codex" : "claude", sessionId: "s1", cwd: dir })}\n`,
    {
      mode: 0o600,
    },
  );
  const r = spawnSync(shell, [target], {
    cwd: dir,
    input,
    encoding: "utf-8",
    env: {
      PATH: `${binDir}:${BASE_PATH}`,
      CLAUDE_PROJECT_DIR: dir,
      NAVORI_AUDITS_ROOT: auditsRoot,
    },
  });
  const events = readFileSync(log, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { verdict?: string; reason?: string; kind?: string });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", events };
}

/** Parse the single ask decision a hook printed on stdout. */
function askDecision(stdout: string): { decision: string; reason: string; event: string } {
  const out = JSON.parse(stdout) as {
    hookSpecificOutput: {
      hookEventName: string;
      permissionDecision: string;
      permissionDecisionReason: string;
    };
  };
  return {
    decision: out.hookSpecificOutput.permissionDecision,
    reason: out.hookSpecificOutput.permissionDecisionReason,
    event: out.hookSpecificOutput.hookEventName,
  };
}

describe.runIf(runsBash && hasJq)("quality-gate runner missing asks under Claude (#1117)", () => {
  const HOOK_SRC = resolve(getCoreRoot(), "core-assets/hooks/quality-gate-pre-commit.sh");

  /** A non-git dir, a gate whose runner is absent from PATH or present-but-red. */
  function qgFixture(runner: "missing" | "red"): { dir: string; binDir: string; script: string } {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "navori-1117-qg-")));
    const binDir = join(dir, "fakebin");
    mkdirSync(binDir);
    if (runner === "red") {
      const stub = join(binDir, "pnpm");
      writeFileSync(stub, "#!/usr/bin/env bash\nexit 1\n");
      chmodSync(stub, 0o755);
    }
    const script = join(dir, "src-hook.sh");
    writeFileSync(
      script,
      expandHookIncludes(readFileSync(HOOK_SRC, "utf-8")).replace(
        "{{shq:qualityGate.fast}}",
        shellSingleQuote("pnpm run typecheck"),
      ),
    );
    return { dir, binDir, script };
  }

  // Covers: A2
  it("runner not on PATH + Claude hook payload → ask JSON, exit 0, no 'outside the agent'", () => {
    for (const shell of shellSensitive(GATE_SENSITIVE)) {
      const fx = qgFixture("missing");
      const out = runAsk(shell, fx.dir, fx.binDir, fx.script, "hook.sh", HOOK_PAYLOAD(fx.dir));
      expect(out.status).toBe(CLEAN);
      const d = askDecision(out.stdout);
      expect(d.decision).toBe("ask");
      expect(d.reason).toContain("'pnpm'");
      expect(d.reason).toContain("no verdict");
      expect(d.reason).not.toContain("outside the agent");
    }
  });

  // Covers: A3
  it("records the ask outcome in the audit log with its reason", () => {
    const fx = qgFixture("missing");
    const out = runAsk("bash", fx.dir, fx.binDir, fx.script, "hook.sh", HOOK_PAYLOAD(fx.dir));
    expect(out.events.find((e) => e.verdict === "ask")?.reason).toBe("unspecified");
    expect(out.events.some((e) => e.verdict === "block")).toBe(false);
  });

  // Covers: A1, A2
  it("the ask record carries kind=ask", () => {
    const fx = qgFixture("missing");
    const out = runAsk("bash", fx.dir, fx.binDir, fx.script, "hook.sh", HOOK_PAYLOAD(fx.dir));
    expect(out.events.find((e) => e.verdict === "ask")?.kind).toBe("ask");
  });

  // Covers: A1, A2
  it("a red gate records its own block reason with kind=hard", () => {
    const fx = qgFixture("red");
    const out = runAsk("bash", fx.dir, fx.binDir, fx.script, "hook.sh", HOOK_PAYLOAD(fx.dir));
    const block = out.events.find((e) => e.verdict === "block");
    expect(block?.reason).toBe("unspecified");
    expect(out.stderr).toContain("quality-gate fast failed. Commit aborted.");
    expect(block?.kind).toBe("hard");
  });

  // Covers: A1, A2
  it("a missing runner outside an ask-capable context records a distinct block reason", () => {
    const fx = qgFixture("missing");
    const out = runAsk(
      "bash",
      fx.dir,
      fx.binDir,
      fx.script,
      ".codex/hooks/qg.sh",
      HOOK_PAYLOAD(fx.dir),
    );
    const block = out.events.find((e) => e.verdict === "block");
    expect(block?.reason).toBe("unspecified");
    expect(out.stderr).toContain("Commit BLOCKED to avoid skipping the gate silently");
    expect(block?.kind).toBe("hard");
  });

  // Covers: A2
  it("a red gate stays exit 2 under a Claude hook payload", () => {
    const fx = qgFixture("red");
    const out = runAsk("bash", fx.dir, fx.binDir, fx.script, "hook.sh", HOOK_PAYLOAD(fx.dir));
    expect(out.status).toBe(BLOCKS);
    expect(out.stdout).not.toContain("permissionDecision");
  });

  // Covers: A2
  it("Codex copy (.codex/hooks) keeps exit 2 with the original block message", () => {
    const fx = qgFixture("missing");
    const out = runAsk(
      "bash",
      fx.dir,
      fx.binDir,
      fx.script,
      ".codex/hooks/qg.sh",
      HOOK_PAYLOAD(fx.dir),
    );
    expect(out.status).toBe(BLOCKS);
    expect(out.stdout).not.toContain("permissionDecision");
    expect(out.stderr).toContain("Commit BLOCKED");
    expect(out.events.some((e) => e.verdict === "block")).toBe(true);
  });

  // Covers: A2
  it("a payload with no hook_event_name keeps exit 2", () => {
    const fx = qgFixture("missing");
    const out = runAsk(
      "bash",
      fx.dir,
      fx.binDir,
      fx.script,
      "hook.sh",
      JSON.stringify({ session_id: "s1", cwd: fx.dir, tool_input: { command: "git commit -m x" } }),
    );
    expect(out.status).toBe(BLOCKS);
    expect(out.stdout).toBe("");
  });
});

describe.runIf(runsBash && hasJq)("navori_can_ask only asks where the prompt shows (#1117)", () => {
  const HOOK_SRC = resolve(getCoreRoot(), "core-assets/hooks/quality-gate-pre-commit.sh");
  const runMode = (mode: string | null, relPath = "hook.sh"): AskRun => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "navori-1117-mode-")));
    const binDir = join(dir, "fakebin");
    mkdirSync(binDir);
    const script = join(dir, "src-hook.sh");
    writeFileSync(
      script,
      expandHookIncludes(readFileSync(HOOK_SRC, "utf-8")).replace(
        "{{shq:qualityGate.fast}}",
        shellSingleQuote("pnpm run typecheck"),
      ),
    );
    return runAsk("bash", dir, binDir, script, relPath, HOOK_PAYLOAD(dir, "git commit -m x", mode));
  };

  // Covers: A1
  it.each(["default", "acceptEdits", "auto"])(
    "permission_mode %s asks (exit 0 + ask JSON)",
    (m) => {
      const out = runMode(m);
      expect(out.status).toBe(CLEAN);
      expect(askDecision(out.stdout).decision).toBe("ask");
    },
  );

  // Covers: A1
  it.each(["bypassPermissions", "dontAsk", "plan", "", "weird", null])(
    "permission_mode %s fails closed (exit 2, no stdout)",
    (m) => {
      const out = runMode(m);
      expect(out.status).toBe(BLOCKS);
      expect(out.stdout).toBe("");
    },
  );

  // Covers: A1
  it("permission_mode default on a Codex copy keeps exit 2", () => {
    const out = runMode("default", ".codex/hooks/qg.sh");
    expect(out.status).toBe(BLOCKS);
    expect(out.stdout).toBe("");
  });
});

describe.runIf(runsBash && hasJq)("audit kind and reason code on every block (#1117)", () => {
  const GUARD_SRC = resolve(getCoreRoot(), "core-assets/hooks/guard-destructive.sh");
  const guardScript = (dir: string): string => {
    const script = join(dir, "src-guard.sh");
    writeFileSync(
      script,
      interpolate(
        expandHookIncludes(readFileSync(GUARD_SRC, "utf-8")),
        { branchBase: "main", preset: "custom" } as unknown as NavoriConfig,
        {},
      ),
    );
    return script;
  };
  const runGuard = (command: string): AskRun => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "navori-1117-guard-")));
    const binDir = join(dir, "fakebin");
    mkdirSync(binDir);
    return runAsk("bash", dir, binDir, guardScript(dir), "hook.sh", HOOK_PAYLOAD(dir, command));
  };
  /** A minimal hook that only calls the shared recorder, so the partial is tested alone. */
  const runRecorder = (verdict: string, reason: string, kind = ""): AskRun => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "navori-1117-rec-")));
    const binDir = join(dir, "fakebin");
    mkdirSync(binDir);
    const script = join(dir, "src-rec.sh");
    writeFileSync(
      script,
      expandHookIncludes(
        [
          "payload=$(cat)",
          'navori_audit_name="t"',
          'navori_audit_phase="PreToolUse"',
          "# navori:include audit-repo",
          "# navori:include audit-log",
          "navori_audit_begin",
          `navori_audit_log ${shellSingleQuote(verdict)} ${shellSingleQuote(reason)} ${shellSingleQuote(kind)}`,
          "",
        ].join("\n"),
      ),
    );
    return runAsk("bash", dir, binDir, script, "hook.sh", HOOK_PAYLOAD(dir));
  };

  // Covers: A2
  it("a guard block records kind hard and an allowlisted reason code", () => {
    const out = runGuard("git commit --no-verify -m x");
    expect(out.status).toBe(BLOCKS);
    const row = out.events.find((e) => e.verdict === "block");
    expect(row?.kind).toBe("hard");
    expect(row?.reason).toBe("no-verify");
  });

  // Covers: A2
  it("derives the kind from the verdict only for block and ask; deny and explicit kinds are untouched", () => {
    expect(runRecorder("block", "free text").events.at(-1)).toMatchObject({
      kind: "hard",
      reason: "unspecified",
    });
    expect(runRecorder("ask", "").events.at(-1)).toMatchObject({ kind: "ask" });
    expect(runRecorder("deny", "").events.at(-1)?.kind).toBeUndefined();
    expect(runRecorder("allow", "x", "advisory").events.at(-1)?.kind).toBe("advisory");
    expect(runRecorder("block", "rm-var", "advisory").events.at(-1)).toMatchObject({
      kind: "advisory",
      reason: "rm-var",
    });
  });
});

describe.runIf(runsBash && hasJq)("plan-gate asks when there is no verdict (#1117)", () => {
  const SRC = resolve(getCoreRoot(), "core-assets/hooks/plan-gate.sh");
  const run = (opts: { mode?: string | null; relPath?: string; shim?: string | null }): AskRun => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "navori-1117-plan-")));
    const binDir = join(dir, "fakebin");
    mkdirSync(binDir);
    const script = join(dir, "src-plan-gate.sh");
    writeFileSync(script, expandHookIncludes(readFileSync(SRC, "utf-8")));
    const payload = JSON.stringify({
      session_id: "s1",
      cwd: dir,
      hook_event_name: "PreToolUse",
      ...(opts.mode === null ? {} : { permission_mode: opts.mode ?? "default" }),
      tool_name: "Agent",
      tool_input: { subagent_type: "implementer", prompt: "workplan: x" },
    });
    return runAsk("bash", dir, binDir, script, opts.relPath ?? "hook.sh", payload, opts.shim);
  };
  /** A navori whose `plan` subcommand exits with `code`; every other command is the real build. */
  const planExits = (code: number): string => `[ "\${1:-}" = plan ] && exit ${code}`;

  // Covers: A3
  it("navori missing + Claude prompting mode → ask, no 'outside the agent'", () => {
    const out = run({ shim: null });
    expect(out.status).toBe(CLEAN);
    const d = askDecision(out.stdout);
    expect(d.decision).toBe("ask");
    expect(d.reason).not.toContain("outside the agent");
  });

  // Covers: A3
  it("plan subcommand unavailable → ask, recorded as verdict ask kind ask", () => {
    const out = run({ shim: planExits(1) });
    expect(out.status).toBe(CLEAN);
    expect(askDecision(out.stdout).reason).toContain("exit 1");
    expect(out.events.find((e) => e.verdict === "ask")).toMatchObject({
      kind: "ask",
      reason: "subcommand-unavailable",
    });
  });

  // Covers: A3
  it("a real plan denial (navori exit 2) stays a hard block", () => {
    const out = run({ shim: planExits(2) });
    expect(out.status).toBe(BLOCKS);
    expect(out.stdout).toBe("");
    expect(out.events.find((e) => e.verdict === "block")).toMatchObject({
      kind: "hard",
      reason: "plan-denied",
    });
  });

  // Covers: A3
  it("Codex copy keeps exit 2 for both no-verdict paths", () => {
    for (const shim of [null, planExits(1)]) {
      const out = run({ shim, relPath: ".codex/hooks/plan-gate.sh" });
      expect(out.status).toBe(BLOCKS);
      expect(out.stdout).toBe("");
    }
  });

  // Covers: A3
  it.each(["bypassPermissions", "dontAsk", "plan", "", "weird", null])(
    "permission_mode %s fails closed (exit 2)",
    (mode) => {
      for (const shim of [null, planExits(1)]) {
        const out = run({ shim, mode });
        expect(out.status).toBe(BLOCKS);
        expect(out.stdout).toBe("");
      }
    },
  );
});
