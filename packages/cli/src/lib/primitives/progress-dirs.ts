/**
 * Progress directories shared by `receipt` and `handoff check` (spec 0033
 * D3). These hold ephemeral inter-agent state — session state
 * (`progress/current.md`) and handoff reports (`impl_<feature>.json`,
 * `review_<feature>.md`) — that must never be treated as reviewable content
 * (`receipt.ts`) nor as a valid destination for a `markdownRequests[].path`
 * (`handoff/check.ts`, R16): a handoff writer that could point there could
 * overwrite another feature's handoff or the session state file itself.
 */
export const PROGRESS_DIRS = [".claude/progress/", ".codex/progress/", "progress/"] as const;

/** Whether a repo-relative path falls under any of `PROGRESS_DIRS`. */
export function isUnderProgressDir(relativePath: string): boolean {
  return PROGRESS_DIRS.some((prefix) => relativePath.startsWith(prefix));
}
