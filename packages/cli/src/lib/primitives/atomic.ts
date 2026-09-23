import {
  openSync,
  fsyncSync,
  closeSync,
  writeSync,
  renameSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { dirname, basename, join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

/**
 * Atomic file write: write to temp file in same dir, fsync, rename to dest.
 * Implements DESIGN §14.8 invariant: never corrupt a target file mid-write.
 *
 * Wraps low-level errno errors (EACCES, EISDIR, ENOSPC, EROFS, ...) into
 * a friendlier message that includes the target path and a hint. The
 * partial temp file is cleaned up on any failure path.
 */
export function writeFileAtomic(destPath: string, content: string): void {
  const dir = dirname(destPath);
  const base = basename(destPath);
  const tmpName = `.${base}.navori.tmp.${randomBytes(6).toString("hex")}`;
  const tmpPath = join(dir, tmpName);

  try {
    const fd = openSync(tmpPath, "w", 0o644);
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, destPath);
  } catch (err) {
    // Best-effort cleanup of the temp file so we don't litter the directory.
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // ignore
    }
    throw friendlyFsError(err, destPath);
  }
}

function friendlyFsError(err: unknown, target: string): Error {
  if (!(err instanceof Error)) return new Error(String(err));
  const code = (err as NodeJS.ErrnoException).code;
  switch (code) {
    case "EACCES":
      return new Error(
        `Cannot write ${target}: permission denied. Check that you own the file and the parent directory is writable.`,
      );
    case "EROFS":
      return new Error(`Cannot write ${target}: filesystem is read-only.`);
    case "EISDIR":
      return new Error(
        `Cannot write ${target}: a directory exists at that path. Remove it or choose another location.`,
      );
    case "ENOSPC":
      return new Error(`Cannot write ${target}: no space left on device.`);
    case "ENOENT":
      return new Error(`Cannot write ${target}: a directory in the path does not exist.`);
    case "ENAMETOOLONG":
      return new Error(`Cannot write ${target}: path is too long for this filesystem.`);
    default:
      return err;
  }
}

export function createTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
