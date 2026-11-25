import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Whether the module at `url` (its `import.meta.url`) is the script Node or Bun was asked to run.
 *
 * Both sides are compared by real path: in ESM `import.meta.url` already names the resolved file,
 * while `process.argv[1]` keeps any symlink the script was invoked through (macOS `tmpdir()` sits
 * under `/var` → `/private/var`). Comparing them with `path.resolve` made a script invoked through
 * a symlink skip its main and exit 0 without doing anything, a silent green for a check (#1816).
 *
 * False, never a throw, when there is no entry script (`node -e`, a test importing the module) or
 * either path cannot be resolved.
 * @param {string} url
 * @returns {boolean}
 */
export function isMain(url) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}
