import { spawnSync } from "node:child_process";

/**
 * True when `cwd` is a git repo whose `origin` remote points at github.com.
 * Extracted from `init.ts` (#981) so `add --suggest` and `doctor` can reuse
 * the same signal `init --recommended` already uses to decide whether to
 * enable the `gh` plugin, instead of re-deriving it (or diverging).
 */
export function isGitHubRepo(cwd: string): boolean {
  const r = spawnSync("git", ["-C", cwd, "config", "--get", "remote.origin.url"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (r.status !== 0) return false;
  return /github\.com/i.test(r.stdout);
}
