import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readCliVersion } from "../../lib/render/bundled-assets.ts";
import { commitWrites } from "./execute-plan.ts";
import { EPHEMERAL_HARNESS_PATHS } from "./ephemeral-paths.ts";
import { tc, type Lang } from "../../lib/i18n.ts";
import { injectManagedSection, type MarkerMeta } from "../../lib/render/marker.ts";
import type { GitignoreRenderResult } from "./gitignore-harness.ts";

/**
 * Managed-block id for a nested `.gitignore` (`.claude/.gitignore`,
 * `.codex/.gitignore`, …), distinct from the root `.gitignore`'s id so a repo
 * that renders both never confuses one block's hash for the other's.
 */
export const NESTED_GITIGNORE_MANAGED_ID = "nested-gitignore-harness";

/** Marker style: shell `#`-comments, same as the root `.gitignore` block. */
const NESTED_GITIGNORE_COMMENT_STYLE = "shell" as const;

/**
 * #1024/#1039: under the default config (`gitignoreHarness: "off"`), the root
 * `.gitignore`'s Cubo A is never written — that mode exists for repos (the
 * Bonum case, `distribution.ts`) that gitignore `.claude/` wholesale by hand
 * and must stay inert. So a fresh `.claude/progress/` or `.claude/worktrees/`
 * is untracked by NOTHING under the default config, even though both are
 * ephemeral by `EPHEMERAL_HARNESS_PATHS`'s own contract.
 *
 * A nested `.gitignore` INSIDE the directory it protects sidesteps that
 * tradeoff entirely: it never reads `config.gitignoreHarness` (unconditional,
 * every mode including `"off"`), it is a normal committed harness output (not
 * self-ignoring — every teammate gets it on their next pull, the same
 * retroactive property that made moving the two hook stamps off `.claude/`
 * the right fix for #1024's other half), and the Bonum case stays inert by
 * construction: a root `.gitignore` that ignores `.claude/` wholesale makes
 * `.claude/.gitignore` itself untracked, so it never surfaces there either.
 *
 * Entries are `EPHEMERAL_HARNESS_PATHS` (the single source of truth, shared
 * with the root Cubo A, the render backup and doctor's git-hygiene scan) that
 * fall under `dir`, relative to `dir` itself — the shape a `.gitignore` FILE
 * INSIDE `dir` needs. Never anything an engine needs to function: every entry
 * this filters to is ephemeral state, never `agents/`, `hooks/`, `skills/`,
 * `settings.json` or `config.toml`.
 */
export function nestedGitignoreEntries(dir: string): string[] {
  const prefix = dir.endsWith("/") ? dir : `${dir}/`;
  return EPHEMERAL_HARNESS_PATHS.filter((p) => p.startsWith(prefix)).map((p) =>
    p.slice(prefix.length),
  );
}

function coreMeta(): MarkerMeta {
  return { source: "@navori/core", version: readCliVersion() };
}

/**
 * Write or reconcile the managed block in a nested `.gitignore` at the root of
 * `dir` (e.g. `dir: ".claude"` → `.claude/.gitignore`), listing only the
 * ephemeral entries `dir` itself owns.
 *
 * Returns `null` when `dir` owns no ephemeral entries at all (nothing to ever
 * write — today only possible if `EPHEMERAL_HARNESS_PATHS` stops naming
 * anything under `dir`, e.g. an engine whose config directory holds no
 * machine-local state). Otherwise behaves exactly like `renderGitignore`:
 * injects the block preserving every line outside it, seeds a localized
 * header on first write, and — unless `dryRun` — backs up the previous file
 * and writes through `commitWrites`, the render's single backup choke point.
 * A hand-edited block is preserved as `user-modified-skipped` unless `force`.
 */
export function renderNestedGitignore(
  cwd: string,
  dir: string,
  options: { dryRun?: boolean; force?: boolean; lang: Lang },
): GitignoreRenderResult | null {
  const entries = nestedGitignoreEntries(dir);
  if (entries.length === 0) return null;
  const body = entries.join("\n");

  const relPath = join(dir, ".gitignore");
  const filePath = join(cwd, relPath);
  const exists = existsSync(filePath);
  const existing = exists
    ? readFileSync(filePath, "utf-8")
    : tc(options.lang).render.gitignoreHeader;

  const result = injectManagedSection(
    existing,
    NESTED_GITIGNORE_MANAGED_ID,
    body,
    coreMeta(),
    NESTED_GITIGNORE_COMMENT_STYLE,
    options.force === true,
  );

  if (result.status === "user-modified-skipped" || result.status === "downgrade-skipped") {
    return {
      path: relPath,
      status: result.status,
      skippedReason:
        result.status === "user-modified-skipped"
          ? tc(options.lang).engine.managedBlockEditedByHand
          : tc(options.lang).engine.blockFromNewerNavori(
              result.details?.existingVersion ?? undefined,
            ),
    };
  }

  if (options.dryRun !== true && (result.status === "created" || result.status === "updated")) {
    const { backupPath } = commitWrites({
      pending: [{ path: filePath, relPath, content: result.output, status: result.status }],
      removals: [],
      cwd,
      lang: options.lang,
    });
    return { path: relPath, status: result.status, backupPath };
  }

  return { path: relPath, status: result.status };
}
