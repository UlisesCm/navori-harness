import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { shellSingleQuote } from "../../lib/primitives/shell-escape.ts";
import type { HookShell } from "../../lib/__tests__/helpers/shells.ts";
import { recordHookCase } from "./hook-corpus.ts";

/**
 * Batched hook runner (spec 0054 D4). One shell process runs N cases, each in
 * its own subshell, instead of N `execFileSync` spawns.
 *
 * Fidelity contract (what keeps a batch verdict equal to an isolated spawn):
 * - `$0` inside the hook is the hook path (the driver is `<shell> -c <driver> <hook> <dir>`);
 * - every case runs in a fresh subshell that inherits NO `set -e`/`trap` from
 *   the driver, so an `exit` (or `exec`) in the hook ends only that case;
 * - stdin, stdout and stderr are per case, so nothing bleeds across cases;
 * - a case without its `@@case` delimiter fails the whole batch (a vacuous
 *   pass is the failure mode this guards against).
 */

/** One hook invocation: stdin payload plus optional extra env and working dir. */
export interface HookCase {
  /** Payload written to the hook's stdin. */
  input: string;
  /** Variables set ON TOP of the inherited environment. */
  env?: Record<string, string>;
  /** Working directory of the case; defaults to the caller's cwd. */
  cwd?: string;
}

/** Observable outcome of one case, identical in shape for batch and isolated runs. */
export interface HookCaseResult {
  status: number;
  stdout: string;
  stderr: string;
}

// Plain POSIX sh so it parses the same under bash and zsh. `set --` clears the
// positional parameters the hook would otherwise see ($1 = batch dir, $2 = lanes).
// Cases are dealt round-robin to `$2` background lanes inside this ONE process:
// the hook itself, not process startup, dominates a case, so a serial batch would
// save almost nothing over N spawns. Each case still gets its own subshell.
const DRIVER = [
  "d=$1; k=$2; l=0; set --",
  'while [ "$l" -lt "$k" ]; do',
  "  (",
  "    n=$((l+1))",
  '    while [ -e "$d/$n.in" ]; do',
  "      (",
  '        if [ -f "$d/$n.cwd" ]; then cd "$(cat "$d/$n.cwd")" || exit 97; fi',
  '        if [ -f "$d/$n.env" ]; then . "$d/$n.env"; fi',
  '        . "$0"',
  '      ) < "$d/$n.in" > "$d/$n.out" 2> "$d/$n.err"',
  '      printf \'@@case %s %s\\n\' "$n" "$?"',
  "      n=$((n+k))",
  "    done",
  "  ) &",
  "  l=$((l+1))",
  "done",
  "wait",
  "echo @@done",
].join("\n");

/** Concurrent lanes per batch; leaves one core for the test runner itself. */
const LANES = Math.max(1, Math.min(4, availableParallelism() - 1));

/** Real spawn of one case: the reference behavior a batch must reproduce. */
export function runHookIsolated(hookPath: string, shell: HookShell, c: HookCase): HookCaseResult {
  recordHookCase(hookPath, shell, c);
  const r = spawnSync(shell, [hookPath], {
    input: c.input,
    cwd: c.cwd,
    env: { ...process.env, ...c.env },
    encoding: "utf-8",
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Options of {@link runHookBatch}. */
export interface HookBatchOptions {
  /** Concurrent lanes; defaults to {@link LANES}. `1` keeps cases strictly sequential. */
  lanes?: number;
}

/**
 * Runs `cases` in ONE `<shell> -c` process. Throws when any case did not report
 * its delimiter, so a hook that kills or replaces the driver can never pass.
 */
export function runHookBatch(
  hookPath: string,
  shell: HookShell,
  cases: readonly HookCase[],
  options: HookBatchOptions = {},
): HookCaseResult[] {
  if (cases.length === 0) return [];
  for (const c of cases) recordHookCase(hookPath, shell, c);
  const dir = mkdtempSync(join(tmpdir(), "navori-hook-batch-"));
  try {
    cases.forEach((c, i) => {
      const n = i + 1;
      writeFileSync(join(dir, `${n}.in`), c.input);
      if (c.cwd !== undefined) writeFileSync(join(dir, `${n}.cwd`), c.cwd);
      const env = Object.entries(c.env ?? {});
      if (env.length > 0) {
        writeFileSync(
          join(dir, `${n}.env`),
          env.map(([k, v]) => `export ${k}=${shellSingleQuote(v)}`).join("\n") + "\n",
        );
      }
    });
    const r = spawnSync(
      shell,
      ["-c", DRIVER, hookPath, dir, String(Math.min(options.lanes ?? LANES, cases.length))],
      {
        encoding: "utf-8",
      },
    );
    // `@@done` proves the driver itself survived every hook (a hook that kills
    // or replaces it must fail the batch, never pass vacuously).
    if (!/^@@done$/m.test(r.stdout ?? "")) {
      throw new Error(`hook batch: driver did not finish (exit ${r.status}, signal ${r.signal})`);
    }
    const statuses = new Map<number, number>();
    for (const m of (r.stdout ?? "").matchAll(/^@@case (\d+) (\d+)$/gm)) {
      statuses.set(Number(m[1]), Number(m[2]));
    }
    return cases.map((_, i) => {
      const n = i + 1;
      const status = statuses.get(n);
      if (status === undefined) {
        throw new Error(
          `hook batch: case ${n}/${cases.length} never reported its delimiter (driver exit ${r.status}, signal ${r.signal})`,
        );
      }
      return {
        status,
        stdout: readFileSync(join(dir, `${n}.out`), "utf-8"),
        stderr: readFileSync(join(dir, `${n}.err`), "utf-8"),
      };
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Memoizing per-hook batch: `prime` runs a table in one process, `run` reads it back. */
export interface HookBatch {
  /** Runs the not-yet-cached cases under every shell in one process each. */
  prime(shells: readonly HookShell[], cases: readonly HookCase[]): void;
  /** Cached result, or a real isolated spawn when the case was never primed. */
  run(shell: HookShell, c: HookCase): HookCaseResult;
  /** Cached result only; `undefined` when the case was never primed (no spawn). */
  cached(shell: HookShell, c: HookCase): HookCaseResult | undefined;
}

const keyOf = (shell: HookShell, c: HookCase): string =>
  JSON.stringify([shell, c.input, c.env ?? null, c.cwd ?? null]);

/** Creates a {@link HookBatch} bound to one hook path. */
export function createHookBatch(hookPath: string): HookBatch {
  const cache = new Map<string, HookCaseResult>();
  return {
    prime(shells, cases) {
      for (const shell of shells) {
        const fresh = new Map<string, HookCase>();
        for (const c of cases) {
          const k = keyOf(shell, c);
          if (!cache.has(k)) fresh.set(k, c);
        }
        const keys = [...fresh.keys()];
        const results = runHookBatch(hookPath, shell, [...fresh.values()]);
        keys.forEach((k, i) => cache.set(k, results[i] as HookCaseResult));
      }
    },
    run(shell, c) {
      return cache.get(keyOf(shell, c)) ?? runHookIsolated(hookPath, shell, c);
    },
    cached(shell, c) {
      return cache.get(keyOf(shell, c));
    },
  };
}
