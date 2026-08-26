import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { NavoriConfig } from "../../lib/config.ts";
import { writeFileAtomic } from "../../lib/atomic.ts";
import { createBackup, purgeOldBackups } from "../../lib/backup.ts";
import { RenderWriteError } from "../../lib/errors.ts";
import { readCliVersion } from "../../lib/bundled-assets.ts";
import { injectManagedSection } from "../../lib/marker.ts";
import type { LoadedPlugin } from "../../lib/plugins.ts";
import type { loadPreset } from "../../lib/presets.ts";
import type { RenderStatus } from "../../lib/style.ts";
// The authorship test both delete paths share — see lib/removable.ts (#496).
import { isRemovableNavoriFile } from "../../lib/removable.ts";
import { tc, DEFAULT_LANG, type Lang } from "../../lib/i18n.ts";
import { renderManagedFile } from "./render-managed-file.ts";
import { EPHEMERAL_HARNESS_PATHS } from "./ephemeral-paths.ts";
import type { HarnessPlan, PlannedAgent, PlannedHook, PlannedSkill } from "./harness-plan.ts";

/**
 * Shared render pipeline (Spec 0007, Capa 3). Turns a HarnessPlan + an
 * EngineAdapter into files on disk exactly once: render each placement,
 * accumulate pending/skipped by status, prune orphaned managed files,
 * back up, write atomically, chmod, and report. Every provider reuses this
 * plumbing so a fix here (anti-downgrade, atomic write, prune) reaches all
 * engines at once instead of being re-implemented per engine.
 */

const CORE_META = { source: "@navori/core" as const, version: readCliVersion() };

/** One file the engine wants on disk, fully placed (output of Capa 2). */
export interface PlacementRequest {
  /** Managed asset rendered from a source file (renderManagedFile path)… */
  assetPath?: string;
  /** …or a raw body already serialized by the adapter (config.toml, agent .toml). */
  body?: string;
  destRelPath: string;
  managedId: string;
  commentStyle: "html" | "shell";
  chmodExec?: boolean;
  /** Written around the managed block only the FIRST time the file is created. */
  firstRenderSeed?: { header?: string; trailer?: string };
  /**
   * Engine-specific rewrite of the asset text (paths, tool vocabulary) applied
   * before the asset is parsed, so frontmatter, managed body and user template
   * are all adapted in one pass. An engine that serializes its own `body`
   * adapts it itself and leaves this unset. #364: without it, a `placeSkill`
   * that returns an `assetPath` ships the Claude-oriented asset verbatim, and
   * the Codex agents end up reading `.codex/progress/` while the skills tell
   * them to write to `.claude/progress/`.
   */
  transform?: (text: string) => string;
}

export interface OrphanScan {
  /** Dir to scan, relative to cwd (e.g. ".codex/agents"). */
  dir: string;
  /** File/dir name filter (e.g. name => name.endsWith(".toml")). */
  match: (name: string) => boolean;
  /** Desired rel paths that must NOT be removed. */
  desired: ReadonlySet<string>;
  /** "file" removes the file; "skill-dir" removes `<dir>/<name>` when SKILL.md is its only child. */
  shape: "file" | "skill-dir";
}

export interface AdapterCtx {
  cwd: string;
  config: NavoriConfig;
  repoRoot: string;
  isWorkspace: boolean;
  coreAssets: string;
  preset: ReturnType<typeof loadPreset>;
  plugins: readonly LoadedPlugin[];
}

export interface EngineAdapter {
  id: string;
  /** Human-facing name used in error messages (defaults to id). */
  label?: string;
  /** Placement for each HarnessPlan asset; null = this engine does not emit it. */
  placeAgent(a: PlannedAgent, ctx: AdapterCtx): PlacementRequest | null;
  placeSkill(s: PlannedSkill, ctx: AdapterCtx): PlacementRequest | null;
  placeHook(h: PlannedHook, ctx: AdapterCtx): PlacementRequest | null;
  /** Files that do not derive 1:1 from an asset (settings.json / config.toml / AGENTS.md). */
  extraFiles(ctx: AdapterCtx): PlacementRequest[];
  orphanScans(plan: HarnessPlan, ctx: AdapterCtx): OrphanScan[];
}

export interface ExecuteResult {
  written: Array<{ path: string; status: RenderStatus | "removed-condition-false" }>;
  skipped: SkippedFile[];
  backupPath: string | null;
}

/**
 * Machine-readable skip status. Consumers (e.g. `navori sync` conflict
 * detection) branch on this stable code instead of parsing the localized
 * `reason` prose (#241). `user-modified-skipped` = the user hand-edited a
 * managed block and navori refuses to clobber it (a sync conflict);
 * `downgrade-skipped` = the block was written by a newer navori than this CLI.
 */
export type SkipStatus = "user-modified-skipped" | "downgrade-skipped";

/**
 * A managed file/block navori chose not to write. `reason` is localized prose
 * for humans; `status` is the stable code machines branch on. `status` is
 * optional because some skips (e.g. a settings.json that failed to parse) are
 * not managed-block skips and carry no such status.
 */
export interface SkippedFile {
  path: string;
  reason: string;
  status?: SkipStatus;
}

export interface PendingWrite {
  path: string;
  relPath: string;
  content: string;
  status: RenderStatus;
  chmodExec?: boolean;
}

export interface PendingRemoval {
  path: string;
  recursive?: boolean;
}

/**
 * Capa 3, mitad 1: resolve the HarnessPlan through the adapter into pending
 * writes + orphan removals, WITHOUT touching disk. Split out (Spec 0008 C.1)
 * so an engine with its own extra pending (e.g. Claude's CLAUDE.md pipeline)
 * can concatenate and share a single `commitWrites` — one backup, one write
 * loop, one write-order invariant.
 */
export function collectPlan(
  plan: HarnessPlan,
  adapter: EngineAdapter,
  ctx: AdapterCtx,
  options: { prune?: boolean; skipReason?: SkipReason; lang?: Lang } = {},
): { pending: PendingWrite[]; removals: PendingRemoval[]; skipped: ExecuteResult["skipped"] } {
  const prune = options.prune !== false;
  const skipReason = options.skipReason ?? makeDefaultSkipReason(options.lang ?? DEFAULT_LANG);
  const pending: PendingWrite[] = [];
  const skipped: ExecuteResult["skipped"] = [];

  const requests: PlacementRequest[] = [];
  for (const agent of plan.agents) {
    const req = adapter.placeAgent(agent, ctx);
    if (req) requests.push(req);
  }
  for (const skill of plan.skills) {
    const req = adapter.placeSkill(skill, ctx);
    if (req) requests.push(req);
  }
  for (const hook of plan.hooks) {
    const req = adapter.placeHook(hook, ctx);
    if (req) requests.push(req);
  }
  // extraFiles runs last so adapters that accumulate state while placing
  // agents/skills (e.g. Codex's AGENTS.md agent catalog) see the full set.
  requests.push(...adapter.extraFiles(ctx));

  for (const req of requests) collectRequest(req, ctx, pending, skipped, skipReason);

  const removals = prune ? collectOrphans(adapter.orphanScans(plan, ctx), ctx.cwd) : [];

  return { pending, removals, skipped };
}

export function executePlan(
  plan: HarnessPlan,
  adapter: EngineAdapter,
  ctx: AdapterCtx,
  options: { dryRun?: boolean; prune?: boolean; lang?: Lang } = {},
): ExecuteResult {
  const { pending, removals, skipped } = collectPlan(plan, adapter, ctx, options);
  const { written, backupPath } = commitWrites({
    pending,
    removals,
    cwd: ctx.cwd,
    dryRun: options.dryRun === true,
    writeLast: (p) => p.path.endsWith("/AGENTS.md"),
    engineLabel: adapter.label ?? adapter.id,
    lang: options.lang,
  });
  return { written, skipped, backupPath };
}

/**
 * Skip-reason localizer. Engines share the render mechanics but surface their
 * own skip prose (Claude keeps its detailed `navori sync` hints). `collectPlan`
 * takes one via options; Codex uses this default.
 */
export type SkipReason = (
  status: SkipStatus,
  destRelPath: string,
  existingVersion: string | undefined,
) => string;

const makeDefaultSkipReason =
  (lang: Lang): SkipReason =>
  (status, _destRelPath, existingVersion) =>
    status === "user-modified-skipped"
      ? tc(lang).engine.managedBlockEditedByHand
      : tc(lang).engine.blockFromNewerNavori(existingVersion);

function collectRequest(
  req: PlacementRequest,
  ctx: AdapterCtx,
  pending: PendingWrite[],
  skipped: ExecuteResult["skipped"],
  skipReason: SkipReason,
): void {
  const path = join(ctx.cwd, req.destRelPath);
  let content: string;
  let status: RenderStatus;
  let existingVersion: string | undefined;

  if (req.assetPath !== undefined) {
    const existing = existsSync(path) ? readFileSync(path, "utf-8") : null;
    const result = renderManagedFile({
      assetPath: req.assetPath,
      existingContent: existing,
      managedId: req.managedId,
      meta: CORE_META,
      config: ctx.config,
      commentStyle: req.commentStyle,
      transform: req.transform,
    });
    content = result.content;
    status = result.status;
    // marker.ts reports "no version attribute" as null; the skip-reason
    // formatters take undefined for the same "unknown version" case.
    existingVersion = result.details?.existingVersion ?? undefined;
  } else {
    const exists = existsSync(path);
    const existing = exists ? readFileSync(path, "utf-8") : (req.firstRenderSeed?.header ?? "");
    const result = injectManagedSection(
      existing,
      req.managedId,
      req.body ?? "",
      CORE_META,
      req.commentStyle,
    );
    content = result.output;
    if (!exists && req.firstRenderSeed?.trailer) content += req.firstRenderSeed.trailer;
    status = result.status;
    existingVersion = result.details?.existingVersion ?? undefined;
  }

  if (status === "unchanged") return;
  if (status === "user-modified-skipped" || status === "downgrade-skipped") {
    skipped.push({
      path: req.destRelPath,
      reason: skipReason(status, req.destRelPath, existingVersion),
      status,
    });
    return;
  }
  pending.push({ path, relPath: req.destRelPath, content, status, chmodExec: req.chmodExec });
}

function collectOrphans(scans: readonly OrphanScan[], cwd: string): PendingRemoval[] {
  const removals: PendingRemoval[] = [];
  for (const scan of scans) {
    const dirAbs = join(cwd, scan.dir);
    for (const entry of readDirSafe(dirAbs)) {
      if (scan.shape === "file") {
        if (!entry.isFile() || !scan.match(entry.name)) continue;
        const relPath = `${scan.dir}/${entry.name}`;
        const absPath = join(dirAbs, entry.name);
        if (!scan.desired.has(relPath) && isRemovableNavoriFile(absPath)) {
          removals.push({ path: absPath });
        }
        continue;
      }
      // skill-dir
      if (!entry.isDirectory() || !scan.match(entry.name)) continue;
      const relPath = `${scan.dir}/${entry.name}/SKILL.md`;
      const skillDir = join(dirAbs, entry.name);
      const skillPath = join(skillDir, "SKILL.md");
      if (scan.desired.has(relPath) || !isRemovableNavoriFile(skillPath)) continue;
      const children = readDirSafe(skillDir);
      const onlySkill = children.length === 1 && children[0]?.name === "SKILL.md";
      removals.push({ path: onlySkill ? skillDir : skillPath, recursive: onlySkill });
    }
  }
  return removals;
}

/**
 * Capa 3, mitad 2: back up, write atomically, chmod, prune — once. Shared by
 * every engine (Spec 0008 C.1). Parametrized where engines legitimately
 * differ: extra backup excludes, which file to write LAST (its human-facing
 * entry point — AGENTS.md for Codex, CLAUDE.md for Claude), and the engine
 * label for the write-error message. Builds `written` from the post-sort
 * pending + removals so a dry-run reports the same set it would write.
 *
 * The backup is PROPORTIONAL to the change (#405): what gets snapshotted is
 * derived from `pending`/`removals`, not from a per-engine list of roots — so
 * no engine can under- or over-declare it.
 */
export function commitWrites(input: {
  pending: PendingWrite[];
  removals: PendingRemoval[];
  cwd: string;
  backupExclude?: string[];
  dryRun?: boolean;
  /** Predicate: matching files sort to the END of the write loop. */
  writeLast?: (p: PendingWrite) => boolean;
  /** Engine name for the write-error message; omitted → "El render falló…". */
  engineLabel?: string;
  /**
   * When true, removals run AFTER the write loop, each in its own try/catch, so
   * a failed unlink is swallowed (Claude's disabled-plugin script cleanup). When
   * false (default), removals share the write try/catch and a failure throws
   * (Codex's orphan prune).
   */
  removalsBestEffort?: boolean;
  /** Output locale for the write-failure message. Defaults to `es`. */
  lang?: Lang;
}): { written: ExecuteResult["written"]; backupPath: string | null } {
  const { pending, removals, cwd } = input;
  const dryRun = input.dryRun === true;
  let backupPath: string | null = null;

  if ((pending.length > 0 || removals.length > 0) && !dryRun) {
    // #405: back up exactly what this render is about to destroy — the pending
    // writes that ALREADY exist plus every removal — instead of the engine's
    // whole tree (`CLAUDE.md` + all of `.claude/` + …). Nothing recoverable is
    // lost: these are the only paths the write/remove loops below can touch, so
    // the snapshot still covers 100% of what is at risk. The old full-tree copy
    // charged ~370 KB per repo for a one-byte edit — and since a release restamp
    // marks every managed asset "updated", a rollout paid it in every repo.
    const targets = [
      ...new Set(
        [...pending.filter((item) => existsSync(item.path)), ...removals].map((item) =>
          relative(cwd, item.path),
        ),
      ),
    ];
    // `targets` is empty when every pending write creates a new file and there
    // is nothing to remove: a first render destroys nothing, so it gets no
    // (empty) snapshot — same guard the explicit `pending.some(existsSync)`
    // check used to provide.
    if (targets.length > 0) {
      // #348 / audit A2: paths the harness never versions have nothing worth
      // restoring — and restoring them can do harm (`.claude/worktrees/` made
      // every apply weigh gigabytes; a stale Codex receipt resurrected from
      // `.codex/progress/` by `navori backup restore` blocks the next commit).
      // Excluded HERE, the single choke point every engine's backup flows
      // through, so no caller can forget it — the Codex engine did exactly that.
      // Still load-bearing under a proportional backup: a repo that configures
      // `progress.dir` INTO an ephemeral path would otherwise snapshot it.
      // `backupExclude` stays for engine-specific extras; ephemerals are always in.
      const exclude = [...new Set([...EPHEMERAL_HARNESS_PATHS, ...(input.backupExclude ?? [])])];
      const handle = createBackup(cwd, targets, { exclude });
      if (handle.files.length > 0) {
        backupPath = handle.path;
        purgeOldBackups();
      }
    }
    // The engine's human-facing entry point is written LAST so a partial
    // failure leaves the prior version intact.
    if (input.writeLast) {
      const writeLast = input.writeLast;
      pending.sort((a, b) => Number(writeLast(a)) - Number(writeLast(b)));
    }
    let current = "";
    try {
      for (const item of pending) {
        current = item.path;
        mkdirSync(dirname(item.path), { recursive: true });
        writeFileAtomic(item.path, item.content);
        if (item.chmodExec) {
          try {
            chmodSync(item.path, 0o755);
          } catch {
            // Best effort on filesystems without executable bits.
          }
        }
      }
      if (!input.removalsBestEffort) {
        for (const removal of removals) {
          current = removal.path;
          rmSync(removal.path, { recursive: removal.recursive === true, force: true });
        }
      }
    } catch (error) {
      const strings = tc(input.lang ?? DEFAULT_LANG).engine;
      const hint = backupPath ? strings.backupAvailableAt(backupPath) : "";
      const detail = error instanceof Error ? error.message : String(error);
      throw new RenderWriteError(
        `${strings.renderFailedWriting(input.engineLabel, current, detail)}.${hint}`,
        backupPath,
      );
    }
    if (input.removalsBestEffort) {
      for (const removal of removals) {
        try {
          rmSync(removal.path, { recursive: removal.recursive === true, force: true });
        } catch {
          // Best effort — a read-only scripts dir shouldn't crash the render.
        }
      }
    }
  }

  return {
    written: [
      ...pending.map((item) => ({ path: item.relPath, status: item.status })),
      ...removals.map((item) => ({
        path: relative(cwd, item.path),
        status: "removed-condition-false" as const,
      })),
    ],
    backupPath,
  };
}

function readDirSafe(path: string) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}
