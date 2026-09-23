import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Check whether a binary exists in PATH without spawning a shell.
 * Safer than `execSync('command -v ...')` — avoids any shell interpretation
 * of the name.
 *
 * Only accepts simple binary names (validated by the plugin schema regex).
 */
export function hasBinary(name: string): boolean {
  const pathEnv = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  const dirs = pathEnv.split(sep).filter(Boolean);
  const exts =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try {
        if (!statSync(candidate).isFile()) continue;
        // Executability check (#967) — POSIX only. Node's docs are explicit
        // that `X_OK` "has no effect on Windows (will behave like F_OK)"
        // (https://nodejs.org/api/fs.html#file-access-constants): on
        // win32 executability is PATHEXT membership, already filtered above
        // via `exts`. `accessSync` delegates to the kernel, which evaluates
        // the mode against the calling process's real uid/gid — unlike a raw
        // `mode & 0o111` check, which would also return true for a file
        // executable only by a DIFFERENT user.
        if (process.platform !== "win32") {
          accessSync(candidate, constants.X_OK);
        }
        return true;
      } catch {
        // Missing, a directory, a dangling symlink, or (POSIX) not
        // executable by this process — any of these means "not this one".
      }
    }
  }
  return false;
}
