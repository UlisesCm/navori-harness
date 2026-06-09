import { openSync, fsyncSync, closeSync, writeSync, renameSync, mkdtempSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

/**
 * Atomic file write: write to temp file in same dir, fsync, rename to dest.
 * Implements DESIGN §14.8 invariant: never corrupt a target file mid-write.
 */
export function writeFileAtomic(destPath: string, content: string): void {
  const dir = dirname(destPath);
  const base = basename(destPath);
  const tmpName = `.${base}.navori.tmp.${randomBytes(6).toString("hex")}`;
  const tmpPath = join(dir, tmpName);

  const fd = openSync(tmpPath, "w", 0o644);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, destPath);
}

export function createTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
