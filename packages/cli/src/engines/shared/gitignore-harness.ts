import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { readCliVersion } from "../../lib/bundled-assets.ts";
import { commitWrites } from "./execute-plan.ts";
import { EPHEMERAL_HARNESS_PATHS } from "./ephemeral-paths.ts";
import { ENGINE_OUTPUTS, engineOwnedPaths } from "../../lib/health.ts";
import { tc, type Lang } from "../../lib/i18n.ts";
import {
  computeManagedHash,
  extractManagedContent,
  injectManagedSection,
  type MarkerMeta,
} from "../../lib/marker.ts";
import type { NavoriConfig } from "../../lib/schema.ts";
import type { RenderStatus } from "../../lib/style.ts";

/**
 * Managed-block id for the harness `.gitignore` region. A single block per repo
 * (the `.gitignore` is repo-level, not per-engine), written once by `render`.
 */
export const GITIGNORE_MANAGED_ID = "gitignore-harness";

/** File name at the repo root that carries the managed block. */
const GITIGNORE_FILE = ".gitignore";

/** Marker style for `.gitignore`: shell `#`-comments git reads as valid lines. */
const GITIGNORE_COMMENT_STYLE = "shell" as const;

/**
 * Cubo A — machine-local / runtime entries that must NEVER be committed. These
 * are included whenever `gitignoreHarness` is not `"off"` (both `"local"` and
 * `"full"`). They are runtime state, not a harness output, so they can't be
 * derived from `ENGINE_OUTPUTS`.
 *
 * The ephemeral `.claude/` state comes from `EPHEMERAL_HARNESS_PATHS` (shared
 * with the render backup and doctor's git-hygiene scan — #348). The two extras
 * are gitignore-only: `.codegraph/` is a rebuildable local index and `.navori/`
 * holds machine-local presets; neither is "ephemeral agent state", so neither
 * belongs in the shared set.
 *
 * IMPORTANT: the ignored progress dir is `.claude/progress/`, never the root
 * `progress/`. The root `progress/` (current.md, history.md) is git-persisted by
 * design and must stay tracked.
 */
export const CUBO_A_ENTRIES: readonly string[] = [
  ...EPHEMERAL_HARNESS_PATHS,
  ".codegraph/",
  ".navori/",
];

/**
 * The subset of config that governs the `.gitignore` block body. `gitignoreHarness`
 * is optional here (treated as `"off"`) so configs written before the field existed
 * are handled defensively; a parsed `NavoriConfig` (where it always has its default)
 * satisfies this shape.
 */
type GitignoreConfig = {
  gitignoreHarness?: NavoriConfig["gitignoreHarness"];
  engines: readonly string[];
};

/**
 * Harness outputs an engine generates that are NOT part of `ENGINE_OUTPUTS`
 * (which only tracks marker-managed / prose files for drift scanning). These are
 * regenerable-from-config files that a `full` (Bonum) `.gitignore` must still
 * ignore. `.mcp.json` is written by the Claude engine but is generated JSON, not
 * a marker file, so it never entered
 * `ENGINE_OUTPUTS`. `navori.config.json` is intentionally absent everywhere: it
 * is the checked-in source of truth and stays versioned even in `full` mode.
 */
const ENGINE_EXTRA_OUTPUTS: Readonly<Record<string, readonly string[]>> = {
  claude: [".mcp.json"],
};

/**
 * Cubo B — the versionable harness outputs (`.claude/`, `CLAUDE.md`, `.codex/`,
 * `AGENTS.md`, `.mcp.json`, …) owned by the currently-configured engines. Derived
 * from `ENGINE_OUTPUTS` (single source of truth) via `engineOwnedPaths`, plus the
 * non-marker extras above, so an engine absent from `config.engines` contributes
 * nothing. Directory paths get a trailing slash; deduped (AGENTS.md is claimed by
 * both codex and agents-md) and sorted for a deterministic body.
 */
function cuboBEntries(engines: readonly string[]): string[] {
  const paths = new Set<string>();
  for (const eo of ENGINE_OUTPUTS) {
    if (!engines.includes(eo.engine)) continue;
    for (const owned of engineOwnedPaths(eo.engine)) {
      // A path with no file extension is a directory (e.g. `.claude`, `.codex`);
      // append a trailing slash so git treats it as a dir-only ignore.
      paths.add(extname(owned) === "" ? `${owned}/` : owned);
    }
  }
  for (const engine of engines) {
    for (const extra of ENGINE_EXTRA_OUTPUTS[engine] ?? []) paths.add(extra);
  }
  return [...paths].sort();
}

/**
 * Build the body (paths only, no managed markers) of the `.gitignore` block for
 * the given config:
 * - `"off"` (or absent) → `null` (navori must not touch `.gitignore`).
 * - `"local"` → Cubo A only.
 * - `"full"` → Cubo A plus Cubo B derived from `config.engines`.
 *
 * Returns a multiline string, one entry per line, in a stable order. The caller
 * wraps this in the managed markers (Ronda 2).
 */
export function buildGitignoreBody(config: GitignoreConfig): string | null {
  const mode = config.gitignoreHarness ?? "off";
  if (mode === "off") return null;
  const entries =
    mode === "full" ? [...CUBO_A_ENTRIES, ...cuboBEntries(config.engines)] : [...CUBO_A_ENTRIES];
  return entries.join("\n");
}

/**
 * Outcome of reconciling the harness block in `.gitignore` for one render.
 * `status` mirrors the render-plan vocabulary so the report renders it with the
 * same symbols/labels as every other file. `skippedReason` is set (localized)
 * only when the block was hand-edited and preserved (`user-modified-skipped`).
 */
export interface GitignoreRenderResult {
  path: string;
  status: RenderStatus;
  skippedReason?: string;
  /**
   * Snapshot taken before overwriting the file, or `null` when this render had
   * nothing to destroy (created it, or previewed). Surfaced so the user can
   * find the pre-write `.gitignore` — the only file navori edits that it did
   * NOT author (#458).
   */
  backupPath?: string | null;
}

function coreMeta(): MarkerMeta {
  return { source: "@navori/core", version: readCliVersion() };
}

/**
 * Write or reconcile the managed harness block in the repo-root `.gitignore`,
 * driven by `config.gitignoreHarness` and `config.engines`.
 *
 * - Mode `"off"` (body is `null`) → returns `null` and NEVER touches, reads, or
 *   creates `.gitignore` (R8: exact status quo).
 * - Otherwise reads the existing file (or seeds a localized header when it does
 *   not exist yet, R6), injects the block preserving every line outside it (R2,
 *   R5), and — unless `dryRun` (R9) — backs up the previous file and writes it
 *   back atomically through `commitWrites`, the render's single backup choke
 *   point (#458). A hand-edited block is preserved as `user-modified-skipped`
 *   unless `force` is set (R7).
 *
 * The `.gitignore` is a repo-level file, so this is called ONCE per render (not
 * per engine); the body already encodes every configured engine's outputs.
 */
export function renderGitignore(
  cwd: string,
  config: GitignoreConfig,
  options: { dryRun?: boolean; force?: boolean; lang: Lang },
): GitignoreRenderResult | null {
  const body = buildGitignoreBody(config);
  if (body === null) return null; // mode "off": do not read, create, or modify.

  const filePath = join(cwd, GITIGNORE_FILE);
  const exists = existsSync(filePath);
  const existing = exists
    ? readFileSync(filePath, "utf-8")
    : tc(options.lang).render.gitignoreHeader;

  const result = injectManagedSection(
    existing,
    GITIGNORE_MANAGED_ID,
    body,
    coreMeta(),
    GITIGNORE_COMMENT_STYLE,
    options.force === true,
  );

  if (result.status === "user-modified-skipped" || result.status === "downgrade-skipped") {
    return {
      path: GITIGNORE_FILE,
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
    // #458: the write goes through `commitWrites` — the render's single backup
    // choke point — instead of writing here. `.gitignore` is the one file navori
    // edits that it did NOT author: the managed block is injected into a file
    // the user already owns, so a bad injection destroys THEIR rules, and until
    // now no snapshot covered it. Routing it (rather than calling `createBackup`
    // from here) keeps ONE place that decides what a render backs up: the
    // snapshot stays proportional (only an already-existing file enters
    // `targets`, so a first render still snapshots nothing), and a write failure
    // carries the same recovery breadcrumb every other engine's does.
    const { backupPath } = commitWrites({
      pending: [
        {
          path: filePath,
          relPath: GITIGNORE_FILE,
          content: result.output,
          status: result.status,
        },
      ],
      removals: [],
      cwd,
      lang: options.lang,
    });
    return { path: GITIGNORE_FILE, status: result.status, backupPath };
  }

  return { path: GITIGNORE_FILE, status: result.status };
}

/** Drift verdict for the harness `.gitignore` block (doctor, R10). */
export interface GitignoreHealth {
  /** No managed block found (file missing or block absent) — needs a render. */
  missing: boolean;
  /** Block present but its body differs from the config-derived entries. */
  drift: boolean;
}

/**
 * Compare the on-disk managed block in `.gitignore` against the config-derived
 * body (R10). Returns `null` when `gitignoreHarness` is `"off"` (doctor must not
 * evaluate `.gitignore` at all, R8). Otherwise flags a missing block or a hash
 * mismatch so `doctor` surfaces the drift.
 */
export function scanGitignoreHarness(cwd: string, config: GitignoreConfig): GitignoreHealth | null {
  const body = buildGitignoreBody(config);
  if (body === null) return null;

  const filePath = join(cwd, GITIGNORE_FILE);
  if (!existsSync(filePath)) return { missing: true, drift: false };

  const content = readFileSync(filePath, "utf-8");
  const current = extractManagedContent(content, GITIGNORE_MANAGED_ID, GITIGNORE_COMMENT_STYLE);
  if (current === null) return { missing: true, drift: false };

  return { missing: false, drift: computeManagedHash(current) !== computeManagedHash(body) };
}
