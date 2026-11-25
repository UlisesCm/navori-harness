import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Spec 0057 R23 / D10: age of the oldest unmerged first-parent commit on dev. */
export function syncAge(cwd, { dev = "origin/dev", head = "HEAD", now = Date.now() } = {}) {
  const git = (args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  // Resolve refs even when the range would otherwise be empty; a missing ref is an error.
  const devSha = git(["rev-parse", "--verify", `${dev}^{commit}`]);
  const headSha = git(["rev-parse", "--verify", `${head}^{commit}`]);
  const pending = git(["rev-list", "--first-parent", `${headSha}..${devSha}`])
    .split("\n")
    .filter(Boolean);
  const oldest = pending.reduce((found, sha) => {
    const timestamp = Number(git(["show", "-s", "--format=%ct", sha])) * 1000;
    if (!Number.isFinite(timestamp)) throw new Error(`invalid commit date: ${sha}`);
    return !found || timestamp < found.timestamp ? { sha, timestamp } : found;
  }, null);
  const ageDays = oldest ? Math.max(0, now - oldest.timestamp) / 86_400_000 : 0;
  return { pending: pending.length, oldest: oldest?.sha ?? null, ageDays, ok: ageDays <= 7 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = syncAge(process.cwd());
    console.log(
      `rust-sync-age: ${result.pending} pending dev commits; oldest ${result.ageDays.toFixed(2)} days${result.ok ? "" : "; merge origin/dev into migration/rust"}`,
    );
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error(`rust-sync-age: cannot inspect origin/dev: ${error.message}`);
    process.exitCode = 1;
  }
}
