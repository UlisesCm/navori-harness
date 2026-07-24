import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { HomeError } from "./errors.ts";

/**
 * Like `os.homedir()` but validates that the result is a usable absolute path.
 *
 * Node returns whatever HOME / USERPROFILE contains, falling back to an empty
 * string if neither is set. Empty strings — and any relative path — make
 * `path.join(homedir(), '.navori', ...)` produce a path relative to the
 * process CWD, which silently writes runtime state INTO THE USER'S REPO
 * instead of `~/.navori/`. That's catastrophic for CI runs and Docker
 * containers without HOME explicitly defined.
 */
export function safeHomedir(): string {
  const home = homedir();
  if (!home || !isAbsolute(home)) {
    throw new HomeError(
      "Could not determine home directory: HOME env var is empty or not absolute. " +
        "Set HOME explicitly (e.g. 'HOME=/home/runner') before running navori.",
    );
  }
  return home;
}

/**
 * The user-level Claude Code config directory — the global render target (spec
 * 0005). Claude Code honors `CLAUDE_CONFIG_DIR` to relocate `~/.claude`; navori
 * follows the same env var so a user (and every hermetic test) can point the
 * global scope at an arbitrary directory. Falls back to `~/.claude`.
 *
 * The override MUST be absolute when set — the same rule `safeHomedir` enforces
 * on HOME, and for the same reason: a relative or empty-after-trim value (`.`,
 * `./claude`, or a stale env leaked from another tool) would make the global
 * render write onto the CWD's `CLAUDE.md` and strip its repo blocks. A relative
 * `CLAUDE_CONFIG_DIR` is almost certainly a mistake, and silently redirecting
 * writes is the dangerous outcome — so we throw a clear error instead of
 * resolving it. An empty / whitespace value falls through to `~/.claude`.
 */
export function globalConfigDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  if (override && override.trim().length > 0) {
    if (!isAbsolute(override)) {
      throw new HomeError(
        `CLAUDE_CONFIG_DIR must be an absolute path, got '${override}'. ` +
          "A relative value would redirect the global render onto the current directory " +
          "and strip its repo blocks. Set it to an absolute path (e.g. '/home/you/.claude') or unset it.",
      );
    }
    return override;
  }
  return join(safeHomedir(), ".claude");
}
