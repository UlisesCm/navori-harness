import { chmodSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "git-hooks", "pre-push");
const marker = "# navori pre-push gate";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf-8" }).trim();
}

const root = git("rev-parse", "--show-toplevel");
const target = resolve(root, git("-C", root, "rev-parse", "--git-path", "hooks/pre-push"));

if (existsSync(target) && !readFileSync(target, "utf-8").includes(marker)) {
  throw new Error(
    `Refusing to overwrite non-navori hook: ${target}. Merge scripts/git-hooks/pre-push manually instead.`,
  );
}

copyFileSync(source, target);
chmodSync(target, 0o755);
console.log(`Installed versioned pre-push hook at ${target}`);
