import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { getCoreRoot } from "../bundled-assets.ts";
import { expandHookIncludes } from "../hook-includes.ts";
import { acrossShells, type HookShell } from "./helpers/shells.ts";
import { ORCHESTRATOR_OWNER } from "../audit/parse.ts";

/**
 * Who the `audit-log` partial records as the OWNER of a hook event (#709).
 *
 * The field shipped with no test at all, and it was wrong for 41,581 of the
 * park's 52,460 records (79%): an empty `.agent_id` came out as the `cwd`.
 * Command substitution strips trailing newlines, so the empty third field left
 * only two lines; `${rest#*<NL>}` then found no newline and POSIX says a `#`
 * pattern that does not match returns the string UNCHANGED.
 *
 * These drive the partial the way a rendered hook does — payload on stdin, one
 * process per call — under bash AND zsh (#391), because the bug lived in a
 * parameter expansion and that is exactly where the two shells diverge.
 */

const runsBash = process.platform !== "win32";
const hasJq = spawnSync("jq", ["--version"]).status === 0;

/** A minimal hook that includes the partial and records one event. */
const probePath = (() => {
  const dir = mkdtempSync(join(tmpdir(), "navori-owner-src-"));
  const p = join(dir, "probe.sh");
  writeFileSync(
    p,
    expandHookIncludes(`#!/usr/bin/env bash
set -euo pipefail
# navori:include extract-cmd
navori_audit_name="probe"
navori_audit_phase="PreToolUse"
navori_audit_tool="Bash"
navori_audit_begin() { :; }
navori_audit_log() { :; }
# navori:include audit-log
navori_audit_begin
navori_audit_log "allow" "probe"
`),
  );
  chmodSync(p, 0o755);
  return p;
})();

const SESSION = "sess-owner-1";

/** Run the probe against a throwaway audits root; returns the recorded event. */
function record(shell: HookShell, payload: Record<string, unknown>): Record<string, unknown> {
  // NAVORI_AUDITS_ROOT, never the real `~/.navori` — the isolation guard
  // (#404/#424) fails the whole run if a spec touches the machine-global store.
  const root = mkdtempSync(join(tmpdir(), "navori-owner-root-"));
  const repo = basename(String(payload.cwd ?? ""));
  mkdirSync(join(root, repo), { recursive: true });
  const logFile = join(root, repo, `session-${SESSION}.log`);
  writeFileSync(logFile, "", "utf-8");

  spawnSync(shell, [probePath], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
    env: { ...process.env, NAVORI_AUDITS_ROOT: root },
  });

  const lines = readFileSync(logFile, "utf-8").trim().split("\n").filter(Boolean);
  expect(lines, "el partial no registró nada").toHaveLength(1);
  return JSON.parse(lines[0] as string) as Record<string, unknown>;
}

function recorded(payload: Record<string, unknown>): Record<string, unknown> {
  return acrossShells((shell) => {
    const ev = record(shell, payload);
    // `ms` and the timestamps are wall-clock: they cannot agree between two
    // runs, and comparing them would make every row flaky.
    const { ms: _ms, ts: _ts, tsMs: _tsMs, ...stable } = ev;
    return stable;
  });
}

const CWD = "/tmp/navori-owner-repo";

describe.runIf(runsBash && hasJq)("audit-log — de quién es el evento (#709)", () => {
  it("el hilo principal se nombra a sí mismo, NO con el cwd", () => {
    const ev = recorded({ session_id: SESSION, cwd: CWD, tool_name: "Bash", tool_input: {} });
    expect(ev.agentId).toBe(ORCHESTRATOR_OWNER);
    // La regresión exacta: el campo traía la ruta del repo.
    expect(ev.agentId).not.toBe(CWD);
    expect(String(ev.agentId).startsWith("/")).toBe(false);
  });

  it("dentro de un subagente registra el id real que manda el host", () => {
    const ev = recorded({
      session_id: SESSION,
      cwd: CWD,
      tool_name: "Bash",
      tool_input: {},
      agent_id: "a1613f237ec433d42",
    });
    expect(ev.agentId).toBe("a1613f237ec433d42");
  });

  it("acepta `subagent_id` como el alias que ya contemplaba", () => {
    const ev = recorded({
      session_id: SESSION,
      cwd: CWD,
      tool_name: "Bash",
      tool_input: {},
      subagent_id: "b99f0011deadbeef0",
    });
    expect(ev.agentId).toBe("b99f0011deadbeef0");
  });

  it("un `agent_id` vacío es el hilo principal, no una ruta", () => {
    // El caso literal del bug: el host manda la clave con string vacío.
    const ev = recorded({
      session_id: SESSION,
      cwd: CWD,
      tool_name: "Bash",
      tool_input: {},
      agent_id: "",
    });
    expect(ev.agentId).toBe(ORCHESTRATOR_OWNER);
  });
});

describe("audit-log — el literal viaja entre un .sh y un .ts (#709)", () => {
  it("el partial escribe exactamente lo que `ORCHESTRATOR_OWNER` declara", () => {
    // Una palabra compartida entre un script de shell que no puede importar y
    // el módulo que la interpreta. Sin esto, renombrar la constante deja al
    // recolector escribiendo la anterior y `ownerOf` cae a la ventana temporal
    // —el fallback que este campo existe para evitar— en silencio.
    const partial = readFileSync(
      resolve(getCoreRoot(), "core-assets/hooks/_partials/audit-log.sh"),
      "utf-8",
    );
    expect(partial).toContain(`// "${ORCHESTRATOR_OWNER}"`);
  });
});
