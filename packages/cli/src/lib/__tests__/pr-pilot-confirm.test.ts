import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getCoreRoot } from "../bundled-assets.ts";
import { expandHookIncludes } from "../hook-includes.ts";
import { acrossShells, type HookShell } from "./helpers/shells.ts";
import { buildClaudeSettings } from "../../engines/claude/build-settings.ts";
import { resolveHarnessPlan } from "../../engines/shared/harness-plan.ts";
import type { NavoriConfig } from "../config.ts";

/**
 * Behavioral tests for core-assets/hooks/pr-pilot-confirm.sh (#705).
 *
 * The hook exists because the `commit-pr-pilot` is invoked on 15% of the PRs
 * this harness opens, and the repo that publishes it sat at 0 of 101 — while a
 * sibling repo runs at 48%, so the pilot works when it is reached. What was
 * missing is anything that INTERRUPTS `gh pr create`; doctrine alone is the
 * layer measured to fail.
 *
 * So the value under test is not the script's shape: it is that a real payload
 * produces an `ask` for a hand-opened PR, stays silent for the pilot's own, and
 * — the part that decides whether this can ship at all — never blocks.
 */

const runsBash = process.platform !== "win32";
// The `ask` payload is built with jq; without it the hook stays deliberately
// silent rather than emit malformed JSON, so those rows would assert nothing.
const hasJq = spawnSync("jq", ["--version"]).status === 0;

/** The hook as a RENDERED repo runs it — includes expanded, as `render` does. */
const hookPath = (() => {
  const dir = mkdtempSync(join(tmpdir(), "navori-prpilot-src-"));
  const p = join(dir, "pr-pilot-confirm.sh");
  writeFileSync(
    p,
    expandHookIncludes(
      readFileSync(resolve(getCoreRoot(), "core-assets/hooks/pr-pilot-confirm.sh"), "utf-8"),
    ),
  );
  chmodSync(p, 0o755);
  return p;
})();

const SESSION = "sess-prpilot-1";

interface HookRun {
  code: number;
  stdout: string;
}

/** A `PreToolUse` Bash payload from the MAIN thread: no `agent_id`. */
function bash(command: string): Record<string, unknown> {
  return { session_id: SESSION, tool_name: "Bash", tool_input: { command } };
}

/** The same command fired from INSIDE a subagent: the host sends a real id. */
function fromSubagent(command: string): Record<string, unknown> {
  return { ...bash(command), agent_id: "a1613f237ec433d42", agent_type: "commit-pr-pilot" };
}

function runHook(shell: HookShell, payload: Record<string, unknown>): HookRun {
  const cwd = mkdtempSync(join(tmpdir(), "navori-prpilot-"));
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  const r = spawnSync(shell, [hookPath], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "" };
}

/** Run under every available shell and assert they agree (#391). */
function run(payload: Record<string, unknown>): HookRun {
  return acrossShells((shell) => runHook(shell, payload));
}

/** The `ask` verdict as the host would parse it. */
function verdictOf(r: HookRun): { decision?: string; reason: string } {
  const parsed = JSON.parse(r.stdout) as {
    hookSpecificOutput?: {
      hookEventName?: string;
      permissionDecision?: string;
      permissionDecisionReason?: string;
    };
  };
  expect(parsed.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
  return {
    decision: parsed.hookSpecificOutput?.permissionDecision,
    reason: parsed.hookSpecificOutput?.permissionDecisionReason ?? "",
  };
}

describe.runIf(runsBash && hasJq)("pr-pilot-confirm.sh — eleva el PR abierto a mano", () => {
  it("pide confirmación y nombra al pilot", () => {
    const r = run(bash('gh pr create --base main --title "fix: x" --body "y"'));
    expect(r.code).toBe(0);
    const v = verdictOf(r);
    expect(v.decision).toBe("ask");
    // El texto ES la señal de ruteo: un "¿estás seguro?" sin el cómo es un
    // impuesto, y el usuario aprende a descartarlo sin leer.
    expect(v.reason).toContain("commit-pr-pilot");
    expect(v.reason).toContain("Agent tool");
  });

  it("ve el `gh pr create` detrás de un `git push &&`", () => {
    // La forma real: 225 de los 225 PRs a mano del parque salieron encadenados
    // a un push en el mismo comando.
    const r = run(
      bash('git push -u origin feat/x 2>&1 | tail -3 && gh pr create --base main --title "t"'),
    );
    expect(verdictOf(r).decision).toBe("ask");
  });

  it("NUNCA bloquea — el exit es 0 incluso cuando eleva", () => {
    // La condición que decide si esto puede existir. Una sesión donde el
    // operador prohíbe subagentes no puede alcanzar al pilot, y un hook que
    // ahí impidiera abrir PRs costaría más que la desviación que corrige.
    for (const cmd of ["gh pr create", 'gh pr create --title "x"']) {
      expect(run(bash(cmd)).code).toBe(0);
    }
  });
});

describe.runIf(runsBash)("pr-pilot-confirm.sh — y se calla en todo lo demás", () => {
  it("no dice nada cuando el PR viene de un subagente", () => {
    const r = run(fromSubagent('gh pr create --base main --title "t"'));
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it.each([
    ["gh pr view 703 --json state", "otro subcomando de gh pr"],
    ["gh issue create --title x", "crear un issue no es abrir un PR"],
    ['git commit -m "x"', "el commit ya lo cubre el quality gate"],
    ["gh pr list --state open", "solo lectura"],
    ['echo "gh pr create"', "una mención citada no es una invocación"],
    ["npm create vite@latest", "lleva el token del fast path pero no es gh"],
  ])("se calla en `%s` (%s)", (cmd) => {
    const r = run(bash(cmd));
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("se calla cuando no se pudo leer el comando", () => {
    // Fail-open hacia el silencio, al revés que el quality gate: el peor caso
    // de este hook es un prompt en CADA llamada Bash, y un prompt que nadie lee
    // vale menos que ninguno.
    const r = run({ session_id: SESSION, tool_name: "Bash", tool_input: {} });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });
});

/**
 * The cheap gate (#705 follow-up).
 *
 * The hook fires on EVERY Bash call and does real work on almost none of them.
 * Until this gate it paid twice for that: `extract_cmd` forks jq (or node) to
 * read the command, and the `skip` record forks jq again to write "I ran and it
 * was not a PR". Measured on a `git status` payload: 16.7 ms per Bash call,
 * against 4.8 ms with the gate — and the first sample of the old shape was
 * 24.8 ms, half of the ~48 ms that already forced `audit-log.sh` to be redesigned.
 *
 * The property under test is not the timing, which is a machine's opinion. It is
 * that the shortcut is SAFE: it may only skip work for a payload that provably
 * carries no gated command, and every case that matters still reaches the same
 * verdict it did before.
 */
describe.runIf(runsBash && hasJq)("pr-pilot-confirm — el portón barato (#705)", () => {
  it("sigue disparando sobre un compuesto, que es donde el atajo podría equivocarse", () => {
    // `git push && gh pr create` is the shape the issue measured: the PR opens
    // as a continuation of what was already being done by hand. The token scan
    // runs over the WHOLE payload, so the segment split still has to happen.
    const r = run(bash('git push -u origin HEAD && gh pr create --title "x" --body "y"'));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"permissionDecision":"ask"');
  });

  it("no se deja engañar por el token suelto en el payload", () => {
    // `create` appears — in another field, and in a command that is not opening
    // a PR. The fast path is a NECESSARY condition, never a sufficient one: the
    // segment matcher still has the last word.
    const r = run({
      ...bash("pnpm create vite my-app"),
      prompt: "create the PR when you finish",
    });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("calla —y no registra nada— cuando el payload no puede contener un PR", () => {
    // What is given up: the `skip` record for these calls, which said "the hook
    // ran and the command was not a PR" and cost two forks to produce. Every
    // record that carries information (`ask`, `allow`) is still written.
    const auditsRoot = mkdtempSync(join(tmpdir(), "navori-prpilot-audits-"));
    const repo = mkdtempSync(join(tmpdir(), "navori-prpilot-repo-"));
    mkdirSync(join(auditsRoot, "demo"), { recursive: true });
    const log = join(auditsRoot, "demo", `session-${SESSION}.log`);
    writeFileSync(log, "", "utf-8");

    const r = spawnSync("bash", [hookPath], {
      input: JSON.stringify({ ...bash("git status --short"), cwd: repo }),
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: repo, NAVORI_AUDITS_ROOT: auditsRoot },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
    expect(readFileSync(log, "utf-8")).toBe("");
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

describe("pr-pilot-confirm — wiring (#705)", () => {
  it("queda registrado en PreToolUse(Bash) y se materializa en cada repo", () => {
    const pre = (
      buildClaudeSettings(MINIMAL_CONFIG, []).hooks as {
        PreToolUse?: Array<{ matcher?: string; hooks: Array<{ command: string }> }>;
      }
    ).PreToolUse;
    const bucket = pre?.find((b) => b.hooks.some((h) => h.command.includes("pr-pilot-confirm.sh")));
    expect(bucket).toBeDefined();
    expect(bucket?.matcher).toBe("Bash");

    // Sin condición de config: la desviación se midió en todo el parque, no en
    // los repos que configuraron algo.
    const plan = resolveHarnessPlan(MINIMAL_CONFIG, resolve(getCoreRoot(), "core-assets"), null);
    expect(plan.hooks.map((h) => h.id)).toContain("pr-pilot-confirm");
  });
});
