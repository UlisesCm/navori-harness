import { join } from "node:path";
import { globalConfigDir } from "./home.ts";
import type { RenderScope } from "./render-plan.ts";

/**
 * A render TARGET (spec 0005 §2.3): the concrete file layout a render pass
 * writes into. navori rendes two of them with the SAME marker/hash/backup
 * machinery, pointed at different roots:
 *
 *   - repo   → `<cwd>/CLAUDE.md` + `<cwd>/.claude/…`  (the project harness)
 *   - global → `<dir>/CLAUDE.md` + `<dir>/…`          (the persona identity,
 *              where `dir = CLAUDE_CONFIG_DIR ?? ~/.claude`)
 *
 * The user-level Claude layout is FLAT: agents/skills/settings live directly
 * under `dir`, not under a nested `.claude/`. So the only structural difference
 * between the targets is `dotDir` — repo nests `.claude/`, global does not.
 * `claudeMd` is `<baseDir>/CLAUDE.md` in both.
 */
export interface RenderTarget {
  scope: RenderScope;
  /** Root directory of this target (repo root, or the global config dir). */
  baseDir: string;
  /** Absolute path to the target's CLAUDE.md. */
  claudeMd: string;
  /** Directory the `.claude/*` tree lives under: `<cwd>/.claude` for a repo,
   * the bare global dir for the user-level layout. */
  dotDir: string;
}

/** Repo render target rooted at a checkout directory. */
export function repoTarget(cwd: string): RenderTarget {
  return {
    scope: "repo",
    baseDir: cwd,
    claudeMd: join(cwd, "CLAUDE.md"),
    dotDir: join(cwd, ".claude"),
  };
}

/**
 * Global (persona) render target. Defaults to `CLAUDE_CONFIG_DIR ?? ~/.claude`
 * via {@link globalConfigDir}; a caller/test may pass an explicit dir. The
 * user-level layout is flat, so `dotDir === baseDir`.
 */
export function globalTarget(dir: string = globalConfigDir()): RenderTarget {
  return {
    scope: "global",
    baseDir: dir,
    claudeMd: join(dir, "CLAUDE.md"),
    dotDir: dir,
  };
}
