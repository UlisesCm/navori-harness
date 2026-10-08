import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { NavoriConfig } from "../../lib/config/config.ts";
import { writeFileAtomic } from "../../lib/primitives/atomic.ts";
import { createBackup, purgeOldBackups } from "../../lib/render/backup.ts";
import { RenderWriteError } from "../../lib/primitives/errors.ts";
import { readCliVersion } from "../../lib/render/bundled-assets.ts";
import {
  injectManagedSection,
  readMarkerAttrs,
  type CommentStyle,
  type MarkerMeta,
} from "../../lib/render/marker.ts";
import type { LoadedPlugin } from "../../lib/config/plugins.ts";
import type { loadPreset } from "../../lib/config/presets.ts";
import type { RenderStatus } from "../../lib/primitives/style.ts";
// The authorship test both delete paths share — see lib/removable.ts (#496).
import {
  isRemovableNavoriFile,
  navoriAuthorship,
  type KeepReason,
} from "../../lib/render/removable.ts";
import { tc, DEFAULT_LANG, type Lang } from "../../lib/i18n.ts";
import { forcedManagedFileContent, renderManagedFile } from "./render-managed-file.ts";
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
  /** Plugin provenance and derived interpolation values, when not a core asset. */
  meta?: { source: string; version: string };
  extraVars?: Record<string, string>;
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
  /**
   * "file" removes the file; "skill-dir" removes `<dir>/<name>` when SKILL.md
   * is its only child; "skill-nested-file" removes `<dir>/<name>/<nestedRelPath>`
   * when a skill keeps existing but stops wanting that one nested file (e.g. a
   * skill's `agents/openai.yaml` sidecar after `disable-model-invocation` is
   * dropped, #823) — same "delete only when now-orphaned" rule as "skill-dir",
   * scoped one level deeper so the skill directory itself survives.
   */
  shape: "file" | "skill-dir" | "skill-nested-file";
  /** Path from the skill dir to the nested file. Required when shape is "skill-nested-file". */
  nestedRelPath?: string;
  /**
   * Opt-in (spec 0041 R13): for a `"file"` orphan, the unit as navori renders it
   * fresh, or null when unknown. When non-null the orphan is deleted only if
   * nothing the user wrote sits outside its managed blocks (`requirePristine`);
   * otherwise it is kept and reported. Unset = the scan's previous behavior,
   * so engines that do not set it are unaffected.
   */
  expected?: (relPath: string) => string | null;
  /**
   * With `expected`: rewrites the on-disk copy of `relPath` before it is compared
   * with it (`PristineOpts.requirePristine.normalize`), so a copy rendered by an
   * older navori does not read as user-edited. Takes the path because one scan
   * judges many units, each normalized against its own asset.
   */
  normalize?: (onDisk: string, relPath: string) => string;
  /**
   * What the report calls a deletion this scan queues. Defaults to
   * `removed-condition-false`; spec 0043 names the ones that come from a trimmed
   * workspace `removed-trimmed`.
   */
  removalStatus?: PendingRemoval["status"];
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
  written: Array<{ path: string; status: RenderStatus }>;
  skipped: SkippedFile[];
  backupPath: string | null;
}

/** A path an orphan scan found but did NOT remove, and why (spec 0026 T10,
 *  R39/R41) — repo-relative, same shape `commands/render.ts`'s own
 *  `KeptEngineOutput` uses for the disabled-engine prune (route B), so a
 *  Codex render reports "conserved, and why" on the SAME terms as that path
 *  and as the Claude engine's own retired-asset reconciliation (§8.7b–d). */
export interface KeptOrphan {
  path: string;
  reason: KeepReason;
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
  /**
   * Present only when `navori sync` may resolve this skip by writing the forced
   * render of an existing file that still carries a navori marker. Never set on
   * a downgrade, a non-regular destination, a markerless file or a sub-block /
   * settings skip — presence of the field is the single "resolvable" test.
   * Bulk and `--json` consumers read ONLY this field.
   */
  resolution?: SkipResolution;
  /**
   * Present only for a markerless file (no `navori:managed` text anywhere) the
   * user edited, or that is not navori's at all (#1245). ONLY an interactive,
   * per-file answer may write it: accepting replaces the WHOLE file with a fresh
   * render. Never set together with `resolution`, and bulk/`--json` paths must
   * not read it (a separate field keeps them fail-closed by construction).
   */
  markerlessResolution?: SkipResolution;
}

/**
 * What accepting a `user-modified-skipped` file would write. Carries full file
 * bodies, so consumers that serialize skips (JSON output) must never spread it.
 */
export interface SkipResolution {
  /** Absolute destination (no cwd re-derivation downstream). */
  absPath: string;
  /** Bytes on disk the proposal was computed against (diff left side + TOCTOU check). */
  basis: string;
  /**
   * Full forced render: only the managed block changes, the user zone is kept.
   * For a `markerlessResolution` it is a fresh render of the whole file.
   */
  content: string;
  chmodExec?: boolean;
}

/**
 * Attach a {@link SkipResolution} to a skip, or return it unchanged. Single
 * guard for every resolvable site: the status must be `user-modified-skipped`
 * (a `downgrade-skipped` never gets one — anti-rollback), the destination must
 * be a regular non-symlink file (the atomic write would replace a link), and
 * `render` must produce a body that differs from `basis`. `render` returns
 * null when it cannot guarantee a safe forced body; a throw leaves the plain
 * skip so a clean skip never becomes a hard failure.
 */
export function attachResolution(
  skip: SkippedFile,
  input: {
    absPath: string;
    basis: string;
    chmodExec?: boolean;
    render: () => string | null;
    /** Replaces `skip.reason` when a resolution is attached (sync can fix it). */
    resolvableReason?: string;
  },
): SkippedFile {
  if (skip.status !== "user-modified-skipped") return skip;
  const stats = lstatSync(input.absPath, { throwIfNoEntry: false });
  if (!stats?.isFile() || stats.isSymbolicLink()) return skip;
  let content: string | null;
  try {
    content = input.render();
  } catch {
    return skip;
  }
  if (content === null || content === input.basis) return skip;
  return {
    ...skip,
    ...(input.resolvableReason !== undefined ? { reason: input.resolvableReason } : {}),
    resolution: {
      absPath: input.absPath,
      basis: input.basis,
      content,
      ...(input.chmodExec ? { chmodExec: true } : {}),
    },
  };
}

/**
 * Attach a {@link SkippedFile.markerlessResolution} (#1245) to a skip, or return
 * it unchanged. Delegates to {@link attachResolution} so the status, regular
 * non-symlink, throw and no-op guards live in one place, then moves the result
 * into the interactive-only field. On top of those it refuses any `basis` that
 * contains `navori:managed` text (another id's block, a newer version, a
 * half-deleted marker: anti-rollback stays out of reach) and any fresh body that
 * is not exactly one managed block (#637 duplication guard).
 *
 * `renderFresh` MUST render with `existingContent = null`: any other path
 * appends the block after the existing text and duplicates the file (#637).
 */
export function attachMarkerlessResolution(
  skip: SkippedFile,
  input: {
    absPath: string;
    basis: string;
    chmodExec?: boolean;
    renderFresh: () => string | null;
    /** Replaces `skip.reason` when the resolution is attached. */
    resolvableReason: string;
  },
): SkippedFile {
  if (skip.resolution !== undefined || skip.markerlessResolution !== undefined) return skip;
  if (input.basis.includes("navori:managed")) return skip;
  const attached = attachResolution(skip, {
    absPath: input.absPath,
    basis: input.basis,
    chmodExec: input.chmodExec,
    resolvableReason: input.resolvableReason,
    render: () => {
      const fresh = input.renderFresh();
      return fresh !== null && fresh.split("navori:managed start").length === 2 ? fresh : null;
    },
  });
  if (attached.resolution === undefined) return skip;
  const { resolution, ...rest } = attached;
  return { ...rest, markerlessResolution: resolution };
}

/**
 * Forced inject for a body-only site: the new content, or null when the block
 * is a downgrade (never forced) or the result equals the input.
 */
export function forcedInjectContent(
  existing: string,
  id: string,
  body: string,
  meta: MarkerMeta,
  style: CommentStyle,
): string | null {
  const forced = injectManagedSection(existing, id, body, meta, style, true);
  return forced.details?.downgrade ? null : forced.output;
}

/**
 * A core agent/skill file that already existed without a navori marker and was
 * adopted by name (#1114). Surfaced as a warning by the engines (dry run and
 * apply); the backup path is only known after `commitWrites`.
 */
export interface CollisionNotice {
  relPath: string;
  overwrittenKeys: string[];
}

/** Localized collision warnings; `backupPath` is null in a dry run. */
export function collisionWarnings(
  collisions: readonly CollisionNotice[],
  backupPath: string | null,
  lang: Lang,
): string[] {
  return collisions.map((c) =>
    tc(lang).engine.markerlessCollision(
      c.relPath,
      c.overwrittenKeys,
      backupPath === null ? null : join(backupPath, c.relPath),
    ),
  );
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
  /**
   * What `commitWrites` reports for this deletion. Defaults to
   * `removed-condition-false`; a removal with a more specific cause (spec 0043:
   * a workspace copy of a skill the root already provides) names it so the
   * report says why the file went.
   */
  status?: "removed-condition-false" | "removed-trimmed";
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
): {
  pending: PendingWrite[];
  removals: PendingRemoval[];
  skipped: ExecuteResult["skipped"];
  /** Orphan-scan matches that were NOT removed, with why (spec 0026 T10). */
  kept: KeptOrphan[];
  /** Marker-less existing core agent/skill files navori will adopt (#1114). */
  collisions: CollisionNotice[];
} {
  const prune = options.prune !== false;
  const lang = options.lang ?? DEFAULT_LANG;
  const skipReason = options.skipReason ?? makeDefaultSkipReason(lang);
  const pending: PendingWrite[] = [];
  const skipped: ExecuteResult["skipped"] = [];
  const collisions: CollisionNotice[] = [];

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

  for (const req of requests)
    collectRequest(req, ctx, pending, skipped, skipReason, collisions, adapter.id, lang);

  const { removals, kept } = prune
    ? collectOrphans(adapter.orphanScans(plan, ctx), ctx.cwd)
    : { removals: [], kept: [] };

  return { pending, removals, skipped, kept, collisions };
}

export function executePlan(
  plan: HarnessPlan,
  adapter: EngineAdapter,
  ctx: AdapterCtx,
  options: { dryRun?: boolean; prune?: boolean; lang?: Lang } = {},
): ExecuteResult & { kept: KeptOrphan[] } {
  const { pending, removals, skipped, kept } = collectPlan(plan, adapter, ctx, options);
  const { written, backupPath } = commitWrites({
    pending,
    removals,
    cwd: ctx.cwd,
    dryRun: options.dryRun === true,
    writeLast: (p) => p.path.endsWith("/AGENTS.md"),
    engineLabel: adapter.label ?? adapter.id,
    lang: options.lang,
  });
  return { written, skipped, backupPath, kept };
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
  collisions: CollisionNotice[],
  engine: string,
  lang: Lang,
): void {
  const path = join(ctx.cwd, req.destRelPath);
  let content: string;
  let status: RenderStatus;
  let existingVersion: string | undefined;

  // Forced render for the final user-modified skip (lazy: runs only then).
  let forced: { basis: string; render: () => string | null } | null = null;

  if (req.assetPath !== undefined) {
    const assetPath = req.assetPath;
    const existing = existsSync(path) ? readFileSync(path, "utf-8") : null;
    if (existing !== null && req.meta?.source.startsWith("@navori/plugin-")) {
      const authorship = navoriAuthorship(path, req.managedId, { verifyHash: true });
      if (authorship !== "ours") {
        const status = authorship === "newer" ? "downgrade-skipped" : "user-modified-skipped";
        const skip: SkippedFile = {
          path: req.destRelPath,
          reason: skipReason(
            status,
            req.destRelPath,
            readMarkerAttrs(existing, req.managedId, req.commentStyle)?.existingVersion ??
              undefined,
          ),
          status,
        };
        // An edited block that still carries our marker is bulk-resolvable;
        // `foreign` (no marker of this id) is offered only interactively, as a
        // whole-file replace (#1245). `newer` gets nothing (anti-rollback).
        skipped.push(
          authorship === "foreign"
            ? attachMarkerlessResolution(skip, {
                absPath: path,
                basis: existing,
                chmodExec: req.chmodExec,
                resolvableReason: tc(lang).engine.markerlessFileEditedResolvable,
                renderFresh: () =>
                  renderManagedFile({
                    assetPath,
                    existingContent: null,
                    managedId: req.managedId,
                    meta: req.meta ?? CORE_META,
                    config: ctx.config,
                    extraVars: req.extraVars,
                    commentStyle: req.commentStyle,
                    transform: req.transform,
                    engine,
                  }).content,
              })
            : authorship === "modified"
              ? attachResolution(skip, {
                  absPath: path,
                  basis: existing,
                  chmodExec: req.chmodExec,
                  resolvableReason: tc(lang).engine.managedFileEditedResolvable,
                  render: () =>
                    forcedManagedFileContent({
                      assetPath,
                      existingContent: existing,
                      managedId: req.managedId,
                      meta: req.meta ?? CORE_META,
                      config: ctx.config,
                      extraVars: req.extraVars,
                      commentStyle: req.commentStyle,
                      transform: req.transform,
                      engine,
                    }),
                })
              : skip,
        );
        return;
      }
    }
    const renderInput = {
      assetPath,
      existingContent: existing,
      managedId: req.managedId,
      meta: req.meta ?? CORE_META,
      config: ctx.config,
      extraVars: req.extraVars,
      commentStyle: req.commentStyle,
      transform: req.transform,
      engine,
    };
    const result = renderManagedFile(renderInput);
    if (existing !== null) {
      forced = { basis: existing, render: () => forcedManagedFileContent(renderInput) };
    }
    content = result.content;
    status = result.status;
    // Core assets only: the plugin path above already refuses foreign files.
    if (result.collision && !req.meta?.source.startsWith("@navori/plugin-")) {
      collisions.push({
        relPath: req.destRelPath,
        overwrittenKeys: result.collision.overwrittenKeys,
      });
    }
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
      req.meta ?? CORE_META,
      req.commentStyle,
    );
    if (exists) {
      forced = {
        basis: existing,
        render: () =>
          forcedInjectContent(
            existing,
            req.managedId,
            req.body ?? "",
            req.meta ?? CORE_META,
            req.commentStyle,
          ),
      };
    }
    content = result.output;
    if (!exists && req.firstRenderSeed?.trailer) content += req.firstRenderSeed.trailer;
    status = result.status;
    existingVersion = result.details?.existingVersion ?? undefined;
  }

  if (status === "unchanged") return;
  if (status === "user-modified-skipped" || status === "downgrade-skipped") {
    const skip: SkippedFile = {
      path: req.destRelPath,
      reason: skipReason(status, req.destRelPath, existingVersion),
      status,
    };
    skipped.push(
      forced === null
        ? skip
        : attachResolution(skip, {
            absPath: path,
            basis: forced.basis,
            chmodExec: req.chmodExec,
            resolvableReason: tc(lang).engine.managedFileEditedResolvable,
            render: forced.render,
          }),
    );
    return;
  }
  pending.push({ path, relPath: req.destRelPath, content, status, chmodExec: req.chmodExec });
}

/**
 * Not-desired-but-not-removable: a path an orphan scan matched (its NAME/shape
 * fits, it isn't in `desired`) that `navoriAuthorship` refuses to delete —
 * `"foreign"` (the user's own file, or navori's marker for a DIFFERENT block)
 * or `"newer"` (a navori ahead of this CLI wrote it, anti-rollback). Reported,
 * not silently skipped (spec 0026 T10, R39/R41 — the same "conservarlo y
 * reportar el motivo" the Claude engine's §8.7b–d already give retired
 * skills/hooks/agents, extended here to Codex's per-render orphan scan, which
 * covers agents/skills/hooks uniformly rather than per retired-id registry).
 */
function pushKept(
  kept: KeptOrphan[],
  cwd: string,
  absPath: string,
  markerId?: string,
  verifyHash?: boolean,
  expected?: string | null,
  normalize?: (onDisk: string) => string,
): void {
  const authorship = navoriAuthorship(absPath, markerId, {
    verifyHash,
    ...(expected != null ? { requirePristine: { expected, normalize } } : {}),
  });
  if (authorship === "ours") return;
  kept.push({ path: relative(cwd, absPath), reason: authorship });
}

/** `scan.normalize` bound to one path, or undefined when the scan has none. */
function normalizeFor(scan: OrphanScan, relPath: string): ((onDisk: string) => string) | undefined {
  const normalize = scan.normalize;
  return normalize ? (onDisk) => normalize(onDisk, relPath) : undefined;
}

/** The `status` of a removal this scan queues, when the scan names one. */
function statusOf(scan: OrphanScan): Pick<PendingRemoval, "status"> {
  return scan.removalStatus ? { status: scan.removalStatus } : {};
}

function collectOrphans(
  scans: readonly OrphanScan[],
  cwd: string,
): { removals: PendingRemoval[]; kept: KeptOrphan[] } {
  const removals: PendingRemoval[] = [];
  const kept: KeptOrphan[] = [];
  for (const scan of scans) {
    const dirAbs = join(cwd, scan.dir);
    for (const entry of readDirSafe(dirAbs)) {
      if (scan.shape === "file") {
        if (!entry.isFile() || !scan.match(entry.name)) continue;
        const relPath = `${scan.dir}/${entry.name}`;
        const absPath = join(dirAbs, entry.name);
        if (scan.desired.has(relPath)) continue;
        // Flat orphan files (scripts, hooks, agents): a hand-edited managed block
        // is kept, not deleted (`verifyHash`).
        const expected = scan.expected?.(relPath);
        const normalize = normalizeFor(scan, relPath);
        const pristine = expected != null ? { requirePristine: { expected, normalize } } : {};
        if (navoriAuthorship(absPath, undefined, { verifyHash: true, ...pristine }) === "ours") {
          removals.push({ path: absPath, ...statusOf(scan) });
        } else {
          pushKept(kept, cwd, absPath, undefined, true, expected, normalize);
        }
        continue;
      }
      if (scan.shape === "skill-nested-file") {
        if (!entry.isDirectory() || !scan.match(entry.name)) continue;
        const nestedRelPath = scan.nestedRelPath;
        if (nestedRelPath === undefined) continue; // misconfigured scan — nothing to check
        const relPath = `${scan.dir}/${entry.name}/${nestedRelPath}`;
        const nestedAbs = join(dirAbs, entry.name, nestedRelPath);
        if (scan.desired.has(relPath)) continue;
        if (!existsSync(nestedAbs)) continue; // desired dropped, nothing on disk to judge
        if (!isRemovableNavoriFile(nestedAbs)) {
          pushKept(kept, cwd, nestedAbs);
          continue;
        }
        const parentDir = dirname(nestedAbs);
        const children = readDirSafe(parentDir);
        const onlyNested = children.length === 1 && children[0]?.name === basename(nestedRelPath);
        removals.push({ path: onlyNested ? parentDir : nestedAbs, recursive: onlyNested });
        continue;
      }
      // skill-dir
      if (!entry.isDirectory() || !scan.match(entry.name)) continue;
      const relPath = `${scan.dir}/${entry.name}/SKILL.md`;
      const skillDir = join(dirAbs, entry.name);
      const skillPath = join(skillDir, "SKILL.md");
      if (scan.desired.has(relPath)) continue;
      if (!existsSync(skillPath)) continue; // desired dropped, nothing on disk to judge
      // Opt-in like the `file` shape (spec 0043 R3): with `expected`, a copy that
      // carries anything the user wrote is kept and reported instead of deleted.
      const skillExpected = scan.expected?.(relPath);
      const skillNormalize = normalizeFor(scan, relPath);
      const skillPristine =
        skillExpected != null
          ? { requirePristine: { expected: skillExpected, normalize: skillNormalize } }
          : undefined;
      if (!isRemovableNavoriFile(skillPath, undefined, skillPristine)) {
        pushKept(
          kept,
          cwd,
          skillPath,
          undefined,
          skillExpected != null,
          skillExpected,
          skillNormalize,
        );
        continue;
      }
      const children = readDirSafe(skillDir);
      const onlySkill = children.length === 1 && children[0]?.name === "SKILL.md";
      removals.push({
        path: onlySkill ? skillDir : skillPath,
        recursive: onlySkill,
        ...statusOf(scan),
      });
    }
  }
  return { removals, kept };
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
    const completed: string[] = [];
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
        completed.push(relative(cwd, item.path));
      }
      if (!input.removalsBestEffort) {
        for (const removal of removals) {
          current = removal.path;
          rmSync(removal.path, { recursive: removal.recursive === true, force: true });
          completed.push(relative(cwd, removal.path));
        }
      }
    } catch (error) {
      const strings = tc(input.lang ?? DEFAULT_LANG).engine;
      const hint = backupPath ? strings.backupAvailableAt(backupPath) : "";
      const detail = error instanceof Error ? error.message : String(error);
      const unfinished = [
        ...pending.map((item) => item.relPath),
        ...removals.map((item) => relative(cwd, item.path)),
      ].filter((path) => !completed.includes(path));
      throw new RenderWriteError(
        `${strings.renderFailedWriting(input.engineLabel, current, detail)}. Completed: ${completed.join(", ") || "none"}; unfinished: ${unfinished.join(", ") || "none"}.${hint}`,
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
        status: item.status ?? ("removed-condition-false" as const),
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
