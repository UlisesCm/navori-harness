import { existsSync, statSync } from "node:fs";
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
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (existsSync(candidate)) {
        try {
          if (statSync(candidate).isFile()) return true;
        } catch {
          // ignore
        }
      }
    }
  }
  return false;
}
