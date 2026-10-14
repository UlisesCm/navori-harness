import { runRender, countPendingRenderChanges } from "../../commands/render.ts";

/**
 * Files/blocks a `navori render` would still write or delete, from a dry-run of
 * the same engine (writes nothing). `drift` only sees markers already on disk,
 * so it reads 0 while render would create or retire dozens of files (#1143).
 * `null` when unknown: never rendered (no CLAUDE.md), render refused the repo,
 * or the dry run threw — callers degrade instead of crashing.
 *
 * Shared by `status` and `doctor`; an outdated rendered hook or doctrine (e.g.
 * a `plan-gate.sh` older than the binary) shows up here as pending changes.
 */
export function computeRenderPending(cwd: string, claudeMdExists: boolean): number | null {
  if (!claudeMdExists) return null;
  try {
    const result = runRender(cwd, { dryRun: true });
    return result.ok ? countPendingRenderChanges(result) : null;
  } catch {
    return null;
  }
}
