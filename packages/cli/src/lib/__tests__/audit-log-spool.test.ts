import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expandHookIncludes } from "../render/hook-includes.ts";
import { acrossShells, type HookShell } from "./helpers/shells.ts";

/**
 * The SessionStart spool, driven through the real partial (#778).
 *
 * `navori audit --start` creates the session log from the UserPromptSubmit hook,
 * so every SessionStart hook fires before that file exists — and the recorder's
 * `[ -f "$navori_audit_file" ] || return 0` threw the record away every time.
 * Measured in this repo: `session-start-context` recorded 1 of ~20 startups, and
 * that one survivor was a resume onto an already-open log. "Did the session load
 * the harness?" had no witness at all.
 *
 * Under bash AND zsh, like every hook suite (#391), and asserting the two limits
 * that keep the spool from becoming a leak as hard as it asserts that it works:
 * SessionStart only, and only in a repo that has already used audit-mode.
 */

const runsBash = process.platform !== "win32";
const hasJq = spawnSync("jq", ["--version"]).status === 0;

const SESSION = "sess-spool-1";
const CWD = "/tmp/navori-spool-repo";

/** A minimal hook carrying the partial, for one phase. */
function probeFor(phase: string): string {
  const dir = mkdtempSync(join(tmpdir(), "navori-spool-src-"));
  const p = join(dir, "probe.sh");
  writeFileSync(
    p,
    expandHookIncludes(`#!/usr/bin/env bash
set -euo pipefail
payload=$(cat 2>/dev/null) || payload=""
navori_audit_name="probe"
navori_audit_phase="${phase}"
navori_audit_begin() { :; }
navori_audit_log() { :; }
# navori:include audit-repo
# navori:include audit-log
navori_audit_begin
navori_audit_log "inject" "probe"
`),
  );
  chmodSync(p, 0o755);
  return p;
}

interface Run {
  /** Files under the repo's audit directory after the hook ran. */
  files: string[];
  /** The spooled event, minus its wall-clock fields — those cannot agree
   *  between two runs, and comparing them would make every row flaky. */
  spool: Record<string, unknown> | null;
  status: number;
  stdout: string;
}

/**
 * Drive the partial once.
 *
 * `repoDirExists` is the second gate: the audit ROOT exists in any machine that
 * ever used audit-mode anywhere, so the per-repo directory is what says THIS
 * repo opted in.
 */
function run(
  shell: HookShell,
  opts: { phase: string; repoDirExists: boolean; logExists: boolean },
): Run {
  const root = mkdtempSync(join(tmpdir(), "navori-spool-root-"));
  const repo = basename(CWD);
  const repoDir = join(root, repo);
  if (opts.repoDirExists) mkdirSync(repoDir, { recursive: true });
  if (opts.logExists) writeFileSync(join(repoDir, `session-${SESSION}.log`), "", "utf-8");

  const res = spawnSync(shell, [probeFor(opts.phase)], {
    input: JSON.stringify({ session_id: SESSION, cwd: CWD }),
    encoding: "utf-8",
    env: { ...process.env, NAVORI_AUDITS_ROOT: root },
  });

  const files = existsSync(repoDir) ? readdirSync(repoDir).sort() : [];
  const spoolPath = join(repoDir, `pending-${SESSION}.jsonl`);
  let spool: Record<string, unknown> | null = null;
  if (existsSync(spoolPath)) {
    const body = readFileSync(spoolPath, "utf-8").trim();
    const {
      tsMs: _tsMs,
      ts: _ts,
      ms: _ms,
      ...stable
    } = JSON.parse(body) as Record<string, unknown>;
    spool = stable;
  }
  return { files, spool, status: res.status ?? -1, stdout: res.stdout ?? "" };
}

describe.runIf(runsBash && hasJq)("audit-log — spool de SessionStart (#778)", () => {
  it("parquea el evento cuando el log todavía no existe", () => {
    const out = acrossShells((shell) =>
      run(shell, { phase: "SessionStart", repoDirExists: true, logExists: false }),
    );
    expect(out.files).toEqual([`pending-${SESSION}.jsonl`]);
    // Mismo formato que el log: `--start` lo absorbe concatenando, no traduciendo.
    expect(out.spool).toEqual({
      event: "hook",
      name: "probe",
      phase: "SessionStart",
      verdict: "inject",
      source: "core",
      reason: "probe",
      agentId: "orchestrator",
    });
  });

  it("no parquea fases posteriores al primer prompt — ahí 'sin log' significa 'sin marcar'", () => {
    // El límite de volumen: PreToolUse dispara cuatro veces por comando de shell,
    // en cada sesión de cada repo. Parquear eso serían miles de escrituras para
    // nada — el log no existe porque la sesión no se marcó, no porque sea pronto.
    const out = acrossShells((shell) =>
      run(shell, { phase: "PreToolUse", repoDirExists: true, logExists: false }),
    );
    expect(out.files).toEqual([]);
  });

  it("no crea nada en un repo que nunca usó audit-mode", () => {
    // El partial nunca hace `mkdir`: un repo que no optó por audit-mode se queda
    // en cero archivos y cero forks, el mismo contrato que el gate de la raíz.
    const out = acrossShells((shell) =>
      run(shell, { phase: "SessionStart", repoDirExists: false, logExists: false }),
    );
    expect(out.files).toEqual([]);
    expect(out.spool).toBeNull();
  });

  it("con log presente escribe ahí, no en el spool", () => {
    const out = acrossShells((shell) =>
      run(shell, { phase: "SessionStart", repoDirExists: true, logExists: true }),
    );
    expect(out.files).toEqual([`session-${SESSION}.log`]);
    expect(out.spool).toBeNull();
  });

  it("es fail-open en los cuatro casos: exit 0 y ni un byte a stdout", () => {
    // Esto corre mientras una sesión ABRE. Un stdout perdido lo lee el host como
    // salida del hook (contexto inyectado, o razón de bloqueo), y un exit≠0 haría
    // que observar sea el motivo de que la sesión no arranque.
    for (const phase of ["SessionStart", "PreToolUse"]) {
      for (const repoDirExists of [true, false]) {
        const out = acrossShells((shell) => run(shell, { phase, repoDirExists, logExists: false }));
        expect(out.status, `${phase} · repoDir=${repoDirExists}`).toBe(0);
        expect(out.stdout, `${phase} · repoDir=${repoDirExists}`).toBe("");
      }
    }
  });
});
