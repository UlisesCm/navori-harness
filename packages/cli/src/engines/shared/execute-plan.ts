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
import { isDowngrade } from "../../lib/semver.ts";
import { renderManagedFile } from "./render-managed-file.ts";
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
  backupTargets: string[];
}

export interface ExecuteResult {
  written: Array<{ path: string; status: RenderStatus | "removed-condition-false" }>;
  skipped: Array<{ path: string; reason: string }>;
  backupPath: string | null;
}

interface PendingWrite {
  path: string;
  relPath: string;
  content: string;
  status: RenderStatus;
  chmodExec?: boolean;
}

interface PendingRemoval {
  path: string;
  recursive?: boolean;
}

export function executePlan(
  plan: HarnessPlan,
  adapter: EngineAdapter,
  ctx: AdapterCtx,
  options: { dryRun?: boolean; prune?: boolean } = {},
): ExecuteResult {
  const dryRun = options.dryRun === true;
  const prune = options.prune !== false;
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

  for (const req of requests) collectRequest(req, ctx, pending, skipped);

  const removals = prune ? collectOrphans(adapter.orphanScans(plan, ctx), ctx.cwd) : [];

  const backupPath = writeAll(pending, removals, ctx.cwd, adapter, dryRun);

  return {
    written: [
      ...pending.map((item) => ({ path: item.relPath, status: item.status })),
      ...removals.map((item) => ({
        path: relative(ctx.cwd, item.path),
        status: "removed-condition-false" as const,
      })),
    ],
    skipped,
    backupPath,
  };
}

function collectRequest(
  req: PlacementRequest,
  ctx: AdapterCtx,
  pending: PendingWrite[],
  skipped: ExecuteResult["skipped"],
): void {
  const path = join(ctx.cwd, req.destRelPath);
  let content: string;
  let status: RenderStatus;

  if (req.assetPath !== undefined) {
    const existing = existsSync(path) ? readFileSync(path, "utf-8") : null;
    const result = renderManagedFile({
      assetPath: req.assetPath,
      existingContent: existing,
      managedId: req.managedId,
      meta: CORE_META,
      config: ctx.config,
      commentStyle: req.commentStyle,
    });
    content = result.content;
    status = result.status;
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
  }

  if (status === "unchanged") return;
  if (status === "user-modified-skipped" || status === "downgrade-skipped") {
    skipped.push({
      path: req.destRelPath,
      reason:
        status === "user-modified-skipped"
          ? "managed block edited by hand"
          : "escrito por una navori más nueva",
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

function writeAll(
  pending: PendingWrite[],
  removals: PendingRemoval[],
  cwd: string,
  adapter: EngineAdapter,
  dryRun: boolean,
): string | null {
  let backupPath: string | null = null;
  if (!((pending.length > 0 || removals.length > 0) && !dryRun)) return backupPath;

  if (pending.some((item) => existsSync(item.path)) || removals.length > 0) {
    const handle = createBackup(cwd, adapter.backupTargets);
    if (handle.files.length > 0) {
      backupPath = handle.path;
      purgeOldBackups();
    }
  }
  // AGENTS.md is the human-facing entry point; write it last so a partial
  // failure leaves the prior guidance intact.
  pending.sort(
    (a, b) => Number(a.path.endsWith("/AGENTS.md")) - Number(b.path.endsWith("/AGENTS.md")),
  );
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
    for (const removal of removals) {
      current = removal.path;
      rmSync(removal.path, { recursive: removal.recursive === true, force: true });
    }
  } catch (error) {
    const hint = backupPath ? ` Backup pre-escritura disponible en: ${backupPath}` : "";
    throw new RenderWriteError(
      `El render ${adapter.label ?? adapter.id} falló escribiendo ${current}: ${
        error instanceof Error ? error.message : String(error)
      }.${hint}`,
      backupPath,
    );
  }
  return backupPath;
}

function readDirSafe(path: string) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isRemovableNavoriFile(path: string): boolean {
  if (!existsSync(path)) return false;
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return false;
  }
  if (!content.includes("navori:managed")) return false;
  const existingVersion = content.match(/version="([^"]+)"/)?.[1];
  if (!existingVersion) return false;
  return !isDowngrade(existingVersion, CORE_META.version);
}
