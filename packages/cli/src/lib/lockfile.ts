import { openSync, closeSync, rmSync, statSync, writeSync } from "node:fs";

/**
 * Cross-process advisory file lock for the shared ~/.navori state.
 *
 * The registry writes (workspace.json, …) are read-modify-write: two navori
 * processes touching the same file concurrently lose one of the updates (#82).
 * A lock file created with `O_EXCL` ("wx") is the standard advisory primitive —
 * only one process can create it; the rest wait, then retry.
 *
 * Robustness:
 *  - A stale lock (holder crashed) is stolen once it's older than `staleMs`.
 *  - After `timeoutMs` of contention we throw rather than block forever.
 *  - The lock is always released in a `finally`, even if `fn` throws.
 */

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_MS = 30_000;
const POLL_MS = 50;

/** Synchronous sleep that doesn't spin the CPU — the CLI is single-shot, so
 * briefly parking the main thread while waiting for a lock is fine. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface LockOptions {
  timeoutMs?: number;
  staleMs?: number;
}

export class LockTimeoutError extends Error {
  constructor(lockPath: string, timeoutMs: number) {
    super(
      `Timed out after ${timeoutMs}ms waiting for lock ${lockPath} (another navori process may be stuck).`,
    );
    this.name = "LockTimeoutError";
  }
}

export function withFileLock<T>(lockPath: string, fn: () => T, options: LockOptions = {}): T {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const start = Date.now();

  let fd: number | null = null;
  for (;;) {
    try {
      fd = openSync(lockPath, "wx"); // O_CREAT | O_EXCL — fails with EEXIST if held
      try {
        writeSync(fd, `${process.pid}\n`); // breadcrumb for debugging stuck locks
      } catch {
        // non-fatal; the lock's existence is what matters, not its content
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Lock is held. Steal it if the holder died and left it stale.
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
          rmSync(lockPath, { force: true });
          continue; // retry immediately after stealing
        }
      } catch {
        // Lock vanished between open and stat — the holder released it. Retry.
        continue;
      }
      if (Date.now() - start > timeoutMs) throw new LockTimeoutError(lockPath, timeoutMs);
      sleepSync(POLL_MS);
    }
  }

  try {
    return fn();
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // best-effort release; a leftover lock is reclaimed via the stale check
    }
  }
}
