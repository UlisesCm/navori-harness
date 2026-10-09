import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Every regular file under `dir`, as paths relative to `root`. Unreadable
 * entries are skipped silently: `backup` and `migrations` list stores the user
 * may have half-deleted, and one bad entry must not hide the rest.
 */
export function collectFiles(root: string, dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) {
        out.push(...collectFiles(root, full));
      } else if (stat.isFile()) {
        out.push(relative(root, full));
      }
    } catch {
      // ignore
    }
  }
  return out;
}
