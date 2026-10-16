import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const DEFAULT_WAIT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_MS = 200;
// Capture before fixture routing; descendants inherit this coordination base.
const coordinationBase = process.env.NAVORI_TEST_COORDINATION_BASE ?? tmpdir();
process.env.NAVORI_TEST_COORDINATION_BASE = coordinationBase;

interface DistLockFileSystem {
  mkdir(path: string): void;
  writeFile(path: string, contents: string): void;
  remove(path: string): void;
  readFile(path: string): string;
  /** Atomic move used to reclaim a dead owner's lock; absent in seams that never reclaim. */
  rename?(from: string, to: string): void;
}

const nodeFileSystem: DistLockFileSystem = {
  mkdir: (path) => mkdirSync(path),
  writeFile: (path, contents) => writeFileSync(path, contents),
  remove: (path) => rmSync(path, { recursive: true, force: true }),
  readFile: (path) => readFileSync(path, "utf-8"),
  rename: (from, to) => renameSync(from, to),
};

export interface DistLockOptions {
  /** Absolute package path whose fixed dist/ output this lock protects. */
  packageRoot: string;
  waitMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Receives the one-time "waiting on a held lock" notice. Defaults to stderr. */
  warn?: (message: string) => void;
  /** Test-only filesystem seam for acquisition-failure coverage. */
  fileSystem?: DistLockFileSystem;
}

interface LockOwner {
  token: string;
  packageRoot: string;
  /** Absent in locks written before reclamation existed; those are never reclaimed. */
  pid?: number;
  host?: string;
}

/** True only when the kernel proves the pid is gone (ESRCH); EPERM and anything else mean alive. */
function isDeadPid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Moves a dead owner's lock aside and deletes it. The rename is atomic, so only
 * one waiter wins; if what was moved turns out to belong to someone else (a
 * waiter reclaimed and re-acquired between our read and our rename), it is put
 * back best-effort. Pid reuse leaves a lock held, which is the safe direction.
 */
function reclaimDeadLock(
  lockPath: string,
  observed: LockOwner,
  fileSystem: DistLockFileSystem,
): boolean {
  if (observed.pid === undefined || observed.host !== hostname() || !isDeadPid(observed.pid)) {
    return false;
  }
  if (fileSystem.rename === undefined) return false;
  const aside = `${lockPath}.stale-${randomUUID()}`;
  try {
    fileSystem.rename(lockPath, aside);
  } catch {
    return false;
  }
  if (readOwner(aside, fileSystem)?.token !== observed.token) {
    try {
      fileSystem.rename(aside, lockPath);
    } catch {
      // Someone re-created the lock meanwhile; the displaced one is already gone.
    }
    return false;
  }
  fileSystem.remove(aside);
  return true;
}

export interface DistLockHandle {
  path: string;
  release(): void;
}

/**
 * Returns a machine-local lock path scoped to one checkout. The hash avoids
 * collisions between worktrees that share the same package directory name.
 */
export function distLockPath(packageRoot: string): string {
  const resolvedRoot = resolve(packageRoot);
  const hash = createHash("sha256").update(resolvedRoot).digest("hex").slice(0, 16);
  return join(coordinationBase, `navori-cli-dist-${basename(resolvedRoot)}-${hash}.lock`);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function readOwner(lockPath: string, fileSystem: DistLockFileSystem): LockOwner | undefined {
  try {
    return JSON.parse(fileSystem.readFile(join(lockPath, "owner.json"))) as LockOwner;
  } catch {
    return undefined;
  }
}

/**
 * Acquires a checkout-scoped lock for the full lifetime of a Vitest suite.
 *
 * Elapsed time never reclaims a lock: a long suite is safer than deleting dist/
 * below it. The one exception is proof of death: an owner on this host whose
 * pid answers `ESRCH` (a SIGKILLed suite) is reclaimed. Otherwise a timed-out
 * waiter reports the exact path for verified operator cleanup.
 */
export async function acquireDistLock(options: DistLockOptions): Promise<DistLockHandle> {
  const lockPath = distLockPath(options.packageRoot);
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? wait;
  const deadline = now() + waitMs;
  const token = randomUUID();
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const warn = options.warn ?? ((message: string) => void process.stderr.write(`${message}\n`));
  let warned = false;

  for (;;) {
    let acquiredDirectory = false;
    try {
      fileSystem.mkdir(lockPath);
      acquiredDirectory = true;
      fileSystem.writeFile(
        join(lockPath, "owner.json"),
        JSON.stringify({
          token,
          packageRoot: resolve(options.packageRoot),
          pid: process.pid,
          host: hostname(),
        }),
      );
      break;
    } catch (error) {
      if (acquiredDirectory) {
        // A handle does not exist yet, so acquisition owns cleanup of a partial
        // lock. Do not let a cleanup error mask the original write failure.
        try {
          fileSystem.remove(lockPath);
        } catch {
          // The original error identifies why the owner record was never made.
        }
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = readOwner(lockPath, fileSystem);
      if (holder !== undefined && reclaimDeadLock(lockPath, holder, fileSystem)) continue;
      if (now() >= deadline) {
        const owner = readOwner(lockPath, fileSystem);
        const ownerHint = owner ? ` Current owner: ${owner.packageRoot}.` : "";
        throw new Error(
          `vitest globalSetup: timed out waiting for the dist/ suite lock at ${lockPath}.${ownerHint} ` +
            "Do not remove it while a Vitest suite for this checkout is active; after verifying no owner remains, remove it and retry.",
        );
      }
      if (!warned) {
        warned = true;
        const owner = readOwner(lockPath, fileSystem);
        const ownerHint = owner ? ` Current owner: ${owner.packageRoot}.` : "";
        warn(
          `vitest globalSetup: waiting for the dist/ suite lock at ${lockPath}.${ownerHint} ` +
            "Do not remove it while a Vitest suite for this checkout is active; after verifying no owner remains, remove it.",
        );
      }
      await sleep(pollMs);
    }
  }

  return {
    path: lockPath,
    release(): void {
      // A matching token is enough to ensure a handle cannot erase another
      // owner's lock after a reclamation or an operator intervention.
      if (readOwner(lockPath, fileSystem)?.token === token) fileSystem.remove(lockPath);
    },
  };
}

/** The slice of `process` the exit release needs; an EventEmitter satisfies it in tests. */
export interface ExitEmitter {
  once(event: "exit", listener: () => void): unknown;
  off(event: "exit", listener: () => void): unknown;
}

/**
 * Arms a one-shot `exit` listener that releases the lock, and returns a
 * function that disarms it.
 *
 * Vitest's SIGINT/SIGTERM handler calls `process.exit()` without running
 * globalSetup teardown, which would orphan the lock. `exit` listeners run
 * synchronously on that path, and `release()` is token-checked, so this never
 * removes another owner's lock.
 */
export function releaseOnProcessExit(
  handle: DistLockHandle,
  target: ExitEmitter = process,
): () => void {
  const onExit = (): void => {
    try {
      handle.release();
    } catch {
      // Exiting anyway; a failed cleanup must not mask the exit.
    }
  };
  target.once("exit", onExit);
  return () => void target.off("exit", onExit);
}
