import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const DEFAULT_WAIT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_MS = 200;

interface DistLockFileSystem {
  mkdir(path: string): void;
  writeFile(path: string, contents: string): void;
  remove(path: string): void;
  readFile(path: string): string;
}

const nodeFileSystem: DistLockFileSystem = {
  mkdir: (path) => mkdirSync(path),
  writeFile: (path, contents) => writeFileSync(path, contents),
  remove: (path) => rmSync(path, { recursive: true, force: true }),
  readFile: (path) => readFileSync(path, "utf-8"),
};

export interface DistLockOptions {
  /** Absolute package path whose fixed dist/ output this lock protects. */
  packageRoot: string;
  waitMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Test-only filesystem seam for acquisition-failure coverage. */
  fileSystem?: DistLockFileSystem;
}

interface LockOwner {
  token: string;
  packageRoot: string;
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
  return join(tmpdir(), `navori-cli-dist-${basename(resolvedRoot)}-${hash}.lock`);
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
 * Locks are intentionally never reclaimed automatically: elapsed time and a
 * PID cannot prove that a holder is dead, and deleting a live holder reopens
 * the dist/ race. A timed-out waiter reports the exact path for verified
 * operator cleanup after a crashed process.
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

  for (;;) {
    let acquiredDirectory = false;
    try {
      fileSystem.mkdir(lockPath);
      acquiredDirectory = true;
      fileSystem.writeFile(join(lockPath, "owner.json"), JSON.stringify({ token, packageRoot: resolve(options.packageRoot) }));
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
      if (now() >= deadline) {
        const owner = readOwner(lockPath, fileSystem);
        const ownerHint = owner ? ` Current owner: ${owner.packageRoot}.` : "";
        throw new Error(
          `vitest globalSetup: timed out waiting for the dist/ suite lock at ${lockPath}.${ownerHint} ` +
            "Do not remove it while a Vitest suite for this checkout is active; after verifying no owner remains, remove it and retry.",
        );
      }
      await sleep(pollMs);
    }
  }

  return {
    path: lockPath,
    release(): void {
      // No automatic reclamation means a matching token is enough to ensure a
      // handle cannot erase another owner's lock after an operator intervention.
      if (readOwner(lockPath, fileSystem)?.token === token) fileSystem.remove(lockPath);
    },
  };
}
