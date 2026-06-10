import { homedir } from "node:os";
import { isAbsolute } from "node:path";

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
    throw new Error(
      "Could not determine home directory: HOME env var is empty or not absolute. " +
        "Set HOME explicitly (e.g. 'HOME=/home/runner') before running navori-ai.",
    );
  }
  return home;
}
