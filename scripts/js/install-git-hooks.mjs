import { chmodSync, copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "..", "git-hooks", "pre-commit");
const marker = "# navori pre-commit gate";
// The full gate used to run on pre-push; it moved to CI on PRs to `main`.
const legacyMarker = "# navori pre-push gate";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf-8" }).trim();
}

const root = git("rev-parse", "--show-toplevel");
const hookPath = (name) => resolve(root, git("-C", root, "rev-parse", "--git-path", `hooks/${name}`));
const target = hookPath("pre-commit");

if (existsSync(target) && !readFileSync(target, "utf-8").includes(marker)) {
  // Warn and exit 0: this runs from `prepare`, so a throw would break `bun install`.
  console.warn(
    `Skipping the pre-commit hook: ${target} is not a navori hook. Merge scripts/git-hooks/pre-commit manually.`,
  );
} else {
  copyFileSync(source, target);
  chmodSync(target, 0o755);
  console.log(`Installed versioned pre-commit hook at ${target}`);
}

const legacy = hookPath("pre-push");
if (existsSync(legacy) && readFileSync(legacy, "utf-8").includes(legacyMarker)) {
  rmSync(legacy);
  console.log(`Removed the old navori pre-push hook at ${legacy}`);
}
