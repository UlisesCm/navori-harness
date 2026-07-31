import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadPlugin, PluginNotFoundError, PluginManifestError } from "./plugins.ts";
import { readCliVersion } from "./bundled-assets.ts";
import { computeManagedHash, extractManagedContent, reorderManagedBlocks } from "./marker.ts";
import { canonicalManagedOrder, EXCLUDABLE_BLOCK_IDS, CORE_BLOCK_IDS } from "./render-plan.ts";
import { detectClaudeInfra } from "./claude-infra.ts";
import { detectLegacyAgents, type LegacyAgent } from "./legacy-agents.ts";
import { isDowngrade } from "./semver.ts";
import type { NavoriConfig } from "./config.ts";
import { effectiveConfigForWorkspace } from "./monorepo.ts";
import { tc, DEFAULT_LANG, type Lang } from "./i18n.ts";

/**
 * Shared health-check logic for `doctor` (verbose) and `status` (concise) —
 * spec 0003 §3.5.3. Pure: reads the repo, never writes or exits.
 */

export interface MarkerInfo {
  id: string;
  hash: string | null;
  version: string | null;
  source: string | null;
}

/** Parse navori managed-marker metadata out of an HTML- or shell-comment file. */
export function listMarkers(filePath: string): MarkerInfo[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf-8");
  const re = /(?:<!--|#) navori:managed [^\n>]*(?:-->)?/g;
  const result: MarkerInfo[] = [];
  for (const match of content.matchAll(re)) {
    const tag = match[0];
    if (tag.startsWith("<!-- /navori:managed") || tag.startsWith("# navori:managed end")) continue;
    const id = tag.match(/id="([^"]+)"/)?.[1] ?? "?";
    const hash = tag.match(/hash="([^"]+)"/)?.[1] ?? null;
    const version = tag.match(/version="([^"]+)"/)?.[1] ?? null;
    const source = tag.match(/source="([^"]+)"/)?.[1] ?? null;
    result.push({ id, hash, version, source });
  }
  return result;
}

function collectFilesRecursive(
  cwd: string,
  dir: string,
  include: (name: string) => boolean,
): string[] {
  // Skill trees are shallow; a depth cap bounds the walk against a pathological
  // or symlink-inflated tree, and symlinked dirs are skipped so a user symlink
  // can't send the scan out of the tree (or into a cycle). readdir(withFileTypes)
  // reports the link itself, so isSymbolicLink() catches a symlink even when it
  // targets a directory.
  const MAX_DEPTH = 6;
  const out: string[] = [];
  const walk = (rel: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(join(cwd, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(childRel, depth + 1);
      else if (entry.isFile() && include(entry.name)) out.push(childRel);
    }
  };
  if (existsSync(join(cwd, dir))) walk(dir, 0);
  return out;
}

/** Repo-relative `<ext>` paths directly under `cwd/<dir>` (non-recursive). */
function collectFilesFlat(cwd: string, dir: string, ext: string): string[] {
  const absDir = join(cwd, dir);
  if (!existsSync(absDir)) return [];
  try {
    return readdirSync(absDir)
      .filter((f) => f.endsWith(ext))
      .map((f) => `${dir}/${f}`);
  } catch {
    return [];
  }
}

/** Marker syntax a managed file uses: html comments (CLAUDE.md-style prose and
 *  the Claude/Codex `.md` assets) or shell comments (Codex `.toml`/`.sh`). */
type MarkerStyle = "html" | "shell";

/** One managed-output source: a fixed file, a flat dir of `<ext>` files, or a
 *  recursively-walked dir of `<ext>` files. */
type MarkerSource =
  | { kind: "file"; path: string; style: MarkerStyle }
  | { kind: "flat"; dir: string; ext: string; style: MarkerStyle }
  | { kind: "recursive"; dir: string; ext: string; style: MarkerStyle };

interface EngineOutputs {
  engine: string;
  /** Marker-bearing sources (drift + malformed-marker scans). */
  markers: MarkerSource[];
  /** Extra whole-dir text roots concatenated for invariant matching. The root
   *  prose files are read from `markers` (kind:"file"); these are the asset
   *  trees under them. */
  textDirs: string[];
}

/**
 * SINGLE SOURCE OF TRUTH for where each engine writes managed output (#226).
 * Before this, three scans — `scanManagedDrift`, `scanMalformedMarkers` and
 * doctor's `readRenderedText` — each hardcoded their own, overlapping and
 * drifting list, so an engine that moved (or added) an output left one scan
 * blind: e.g. `scanMalformedMarkers` claimed "same scope as scanManagedDrift"
 * yet omitted the Copilot / Cursor prose files. Every health scan now derives
 * its file set from this one table.
 *
 * NOTE (deferred): the real owners of these paths are the engine adapters
 * (engines/*). Having each adapter export its output manifest and building this
 * table from them would drop the last copy — but that touches the adapter layer,
 * so it stays a follow-up; this fix is contained to the health layer.
 */
export const ENGINE_OUTPUTS: EngineOutputs[] = [
  {
    engine: "claude",
    markers: [
      { kind: "file", path: "CLAUDE.md", style: "html" },
      { kind: "flat", dir: ".claude/agents", ext: ".md", style: "html" },
      { kind: "recursive", dir: ".claude/skills", ext: ".md", style: "html" },
      // Hooks under `.claude/hooks/*.sh` are marker-managed (shell style), so
      // their content drift — including the security guard `guard-destructive.sh`
      // — must be scanned like codex's `.codex/hooks`. Without this, doctor/status
      // stayed green while a hook's managed body was tampered with (#275).
      { kind: "recursive", dir: ".claude/hooks", ext: ".sh", style: "shell" },
    ],
    textDirs: [".claude"],
  },
  {
    engine: "codex",
    markers: [
      { kind: "file", path: "AGENTS.md", style: "html" },
      { kind: "recursive", dir: ".agents/skills", ext: ".md", style: "html" },
      { kind: "file", path: ".codex/config.toml", style: "shell" },
      { kind: "recursive", dir: ".codex/agents", ext: ".toml", style: "shell" },
      { kind: "recursive", dir: ".codex/hooks", ext: ".sh", style: "shell" },
    ],
    textDirs: [".agents", ".codex"],
  },
  {
    engine: "agents-md",
    markers: [{ kind: "file", path: "AGENTS.md", style: "html" }],
    textDirs: [],
  },
  {
    engine: "cursor",
    markers: [{ kind: "file", path: ".cursor/rules/navori.mdc", style: "html" }],
    textDirs: [".cursor"],
  },
  {
    engine: "copilot",
    markers: [{ kind: "file", path: ".github/copilot-instructions.md", style: "html" }],
    textDirs: [],
  },
];

/**
 * Engines that materialize plugin-contributed blocks (protocol blocks) into
 * their output. The full Claude engine emits them, and Codex passes
 * `includePluginBlocks: true` (codex/index.ts). The three prose-only engines
 * (agents-md, cursor, copilot) deliberately DROP them (prose-harness.ts). Doctor
 * uses this to skip validating a plugin's invariants when no configured engine
 * would ever emit the block that carries them — otherwise a prose-only repo goes
 * permanently red on an invariant that by design can't appear (#269). Must stay
 * in sync with who passes `includePluginBlocks`.
 */
export const PLUGIN_BLOCK_ENGINES = new Set<string>(["claude", "codex"]);

/** Repo-relative marker files that exist under `cwd`, deduped by path (AGENTS.md
 *  is claimed by both `codex` and `agents-md`) with their marker style.
 *  `styleFilter` narrows to one syntax — the malformed-marker scan is html-only,
 *  since the `-->` terminator check is meaningless for shell markers. */
export function collectMarkerFiles(
  cwd: string,
  styleFilter?: MarkerStyle,
): Array<{ path: string; style: MarkerStyle }> {
  const seen = new Map<string, MarkerStyle>();
  for (const eo of ENGINE_OUTPUTS) {
    for (const src of eo.markers) {
      if (styleFilter && src.style !== styleFilter) continue;
      const paths =
        src.kind === "file"
          ? existsSync(join(cwd, src.path))
            ? [src.path]
            : []
          : src.kind === "flat"
            ? collectFilesFlat(cwd, src.dir, src.ext)
            : collectFilesRecursive(cwd, src.dir, (name) => name.endsWith(src.ext));
      for (const p of paths) if (!seen.has(p)) seen.set(p, src.style);
    }
  }
  return [...seen].map(([path, style]) => ({ path, style }));
}

export interface MissingPlugin {
  id: string;
  reason: string;
}

/** True for a TRANSIENT filesystem error — fd exhaustion / retryable IO — as
 *  opposed to a real "unknown or corrupt plugin". Under heavy test parallelism a
 *  manifest read can hit EMFILE/ENFILE/EAGAIN; misclassifying that as a missing
 *  plugin flipped `doctor` red and made the e2e suite flaky (#281). Callers rethrow
 *  these so a fd hiccup fails loud/retryable instead of being counted as missing. */
function isTransientFsError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "EMFILE" || code === "ENFILE" || code === "EAGAIN";
}

/** Plugins enabled in config that can't be loaded (unknown id / bad manifest). */
export function collectMissingPlugins(config: NavoriConfig): MissingPlugin[] {
  const missing: MissingPlugin[] = [];
  for (const [id, settings] of Object.entries(config.plugins ?? {})) {
    if (settings.enabled !== true) continue;
    try {
      loadPlugin(id);
    } catch (err) {
      // A transient fs error is not a missing plugin — rethrow so it isn't
      // silently counted as absent and used to flip doctor's verdict (#281).
      if (isTransientFsError(err)) throw err;
      if (err instanceof PluginNotFoundError) {
        missing.push({ id, reason: "unknown plugin id" });
      } else if (err instanceof PluginManifestError) {
        missing.push({ id, reason: err.message });
      } else {
        missing.push({ id, reason: (err as Error).message });
      }
    }
  }
  return missing;
}

export interface DriftReport {
  /** Repo-relative path of the file with the drifted marker. */
  filePath: string;
  markerId: string;
  source: string;
  /** "version" — the bundle moved ahead (disk older than the CLI; render/sync
   * brings it forward). "downgrade" — disk is NEWER than the CLI; render's
   * anti-rollback preserves the block, so the fix is updating the CLI, not
   * render (#242). "content" — the body of the managed block no longer matches
   * its `hash=` attribute, i.e. the user edited inside the marker. */
  kind: "version" | "downgrade" | "content";
  fromVersion?: string;
  toVersion?: string;
  expectedHash?: string;
  actualHash?: string;
}

/**
 * Walk `.claude/agents/` and `.claude/skills/` and report drift for each
 * managed marker found:
 *   - **version drift** — the marker's `version=` is older than the bundle's.
 *   - **content drift** — the body no longer hashes to its `hash=` attr,
 *     i.e. hand-edited. `navori sync` surfaces this as a conflict.
 * Markers without `version=`/`hash=` or with unknown sources are skipped.
 */
export function scanManagedDrift(cwd: string, config: NavoriConfig): DriftReport[] {
  // Every managed marker — core, preset, plugin — now stamps the navori release
  // version (#79), so that's the single "expected" version to compare against.
  // We still gate on KNOWN sources (core + enabled plugins that load) so an
  // unknown/foreign marker isn't flagged as drift.
  const naviVersion = readCliVersion();
  const knownSources = knownDriftSources(config);

  const out = scanManagedDriftAt(cwd, "", naviVersion, knownSources);
  // Monorepo: render/sync manage the managed blocks in EVERY workspace, so the
  // scan must too — otherwise a hand-edited block in `apps/backend/CLAUDE.md`
  // makes `sync` report a conflict while `doctor --strict` exits green (#235).
  // Reported paths are prefixed with the workspace path so the diagnostic points
  // at the real file. Plugins aren't workspace-overridable, so `knownSources`
  // (built from the inherited plugin list) is reused.
  for (const ws of config.monorepo?.workspaces ?? []) {
    const wsCwd = join(cwd, ws.path);
    if (!existsSync(wsCwd)) continue; // orphaned workspace — render skips it too
    out.push(...scanManagedDriftAt(wsCwd, ws.path, naviVersion, knownSources));
  }
  return out;
}

/** Core + enabled-plugin marker sources, the set a marker's `source=` must be in
 *  to count as drift (a foreign/unknown marker is never flagged). */
function knownDriftSources(config: NavoriConfig): Set<string> {
  const known = new Set<string>(["@navori/core"]);
  for (const [id, settings] of Object.entries(config.plugins ?? {})) {
    if (settings.enabled !== true) continue;
    try {
      loadPlugin(id);
      known.add(`@navori/plugin-${id}`);
    } catch (err) {
      // A transient fs error must not be swallowed as "unknown plugin" (#281);
      // let it propagate. A genuine unknown/broken plugin is reported elsewhere
      // via missingPlugins.
      if (isTransientFsError(err)) throw err;
    }
  }
  return known;
}

/** Drift within a single directory. Reported paths are relative to `scanCwd`,
 *  optionally prefixed with `pathPrefix` (the workspace path) so a monorepo
 *  diagnostic still names the file relative to the repo root. */
function scanManagedDriftAt(
  scanCwd: string,
  pathPrefix: string,
  naviVersion: string,
  knownSources: Set<string>,
): DriftReport[] {
  const out: DriftReport[] = [];
  const rel = (p: string): string => (pathPrefix ? `${pathPrefix}/${p}` : p);
  for (const { path, style } of collectMarkerFiles(scanCwd)) {
    const abs = join(scanCwd, path);
    const fileContent = (() => {
      try {
        return readFileSync(abs, "utf-8");
      } catch {
        return null;
      }
    })();
    const markers = listMarkers(abs);

    for (const m of markers) {
      if (!m.source) continue;

      if (m.version) {
        if (knownSources.has(m.source) && naviVersion !== m.version) {
          // Direction matters (#242): when the on-disk block is NEWER than the
          // running CLI, render's anti-rollback (marker.ts `downgrade-skipped`)
          // preserves the block, so recommending render/sync is a fix that does
          // nothing. Classify it as a downgrade so doctor tells the user to
          // update the CLI instead.
          const kind = isDowngrade(m.version, naviVersion) ? "downgrade" : "version";
          out.push({
            filePath: rel(path),
            markerId: m.id,
            source: m.source,
            kind,
            fromVersion: m.version,
            toVersion: naviVersion,
          });
        }
      }

      if (m.hash && fileContent !== null) {
        const body = extractManagedContent(fileContent, m.id, style);
        if (body !== null) {
          const actual = computeManagedHash(body);
          if (actual !== m.hash) {
            out.push({
              filePath: rel(path),
              markerId: m.id,
              source: m.source,
              kind: "content",
              expectedHash: m.hash,
              actualHash: actual,
            });
          }
        }
      }
    }
  }
  return out;
}

export interface ExcludedBlocksReport {
  /** Whitelisted core blocks (EXCLUDABLE_BLOCK_IDS) actually opted out via
   * `blocks.exclude`. Surfaced at a neutral note level so an exclusion never
   * becomes silent config drift. */
  excluded: string[];
  /** Real core block ids listed in `blocks.exclude` that are NOT excludable
   * (identity, session, `operaciones-seguras`). The render ignores them — the
   * block stays — so `doctor` warns the opt-out had no effect. */
  nonExcludable: string[];
  /** Ids in `blocks.exclude` matching no known core block — almost always a
   * typo that silently no-ops (the render can't strip a block that isn't ours).
   * A warning, not an error: it doesn't break the render. */
  unknown: string[];
}

/**
 * Report the repo's `blocks.exclude` opt-outs: which whitelisted core blocks are
 * suppressed (`excluded`), which listed ids are real core blocks that aren't
 * excludable so the render keeps them (`nonExcludable`), and which match no core
 * block at all (`unknown` typo). Returns null when nothing is excluded so the
 * caller skips the section entirely.
 */
export function scanExcludedBlocks(config: NavoriConfig): ExcludedBlocksReport | null {
  const list = config.blocks?.exclude ?? [];
  if (list.length === 0) return null;
  const excludable = new Set<string>(EXCLUDABLE_BLOCK_IDS);
  const coreIds = new Set<string>(CORE_BLOCK_IDS);
  const excluded: string[] = [];
  const nonExcludable: string[] = [];
  const unknown: string[] = [];
  for (const id of list) {
    if (excludable.has(id)) excluded.push(id);
    else if (coreIds.has(id)) nonExcludable.push(id);
    else unknown.push(id);
  }
  return { excluded, nonExcludable, unknown };
}

export interface OrderReport {
  /** Managed-block ids in their current document order. */
  current: string[];
  /** The canonical order those same ids should appear in. */
  expected: string[];
  /** True when reordering is blocked because the user wrote prose between two
   * managed blocks — `render`/`sync` can't auto-fix it, the user must move the
   * text out of the managed region first. */
  interleaved: boolean;
  /** The block that should lead (canonical-first among present blocks, the
   * harness "center of gravity") with its 1-based current position — set only
   * when it isn't already first. Spotlights the common legacy case where
   * `orquestacion` got appended last. null when the lead block is correct. */
  misplacedFirst: { id: string; currentPos: number; total: number } | null;
  /** Repo-relative workspace path when the out-of-order CLAUDE.md belongs to a
   * monorepo workspace rather than the root. undefined for the root file. */
  workspacePath?: string;
}

/**
 * Check whether CLAUDE.md's managed blocks are in canonical order. Returns null
 * when there's nothing to flag (no CLAUDE.md, fewer than two blocks, or already
 * ordered). `render`/`sync` auto-fix the order; doctor surfaces it so a
 * hand-edited or legacy file is visible before the next render.
 *
 * Monorepo: the root CLAUDE.md is checked first; if it's clean, each workspace's
 * CLAUDE.md is checked and the FIRST out-of-order one is returned (tagged with
 * `workspacePath`). Order drift is informational and auto-fixed on the next
 * render, so reporting one location — enough to prompt `render` — keeps the
 * single-report contract `doctor`/`status` display expects (#235).
 */
export function scanManagedOrder(
  cwd: string,
  config: NavoriConfig,
  computedBlockIds?: readonly string[],
): OrderReport | null {
  const root = orderReportAt(cwd, config, cwd, { computedBlockIds });
  if (root) return root;
  for (const ws of config.monorepo?.workspaces ?? []) {
    const wsCwd = join(cwd, ws.path);
    if (!existsSync(wsCwd)) continue; // orphaned workspace — render skips it too
    // repoRoot stays the monorepo root (not wsCwd) so LOCAL presets under
    // `<root>/.navori/presets/` resolve, and `omitRootOnly: true` mirrors the
    // render (claude/index.ts), so doctor's canonical order matches byte-for-byte
    // instead of shunting an unresolved local-preset block to the tail (#266).
    const report = orderReportAt(wsCwd, effectiveConfigForWorkspace(config, ws), cwd, {
      computedBlockIds,
      omitRootOnly: true,
    });
    if (report) return { ...report, workspacePath: ws.path };
  }
  return null;
}

/**
 * Order check for the CLAUDE.md directly under `cwd` (no workspace recursion).
 * `computedBlockIds` are the engine's computed-block ids (the Claude adapter's
 * `CLAUDE_COMPUTED_BLOCK_IDS`, threaded from `doctor`); passing them lets the
 * check validate the order AMONG the computed blocks, not just their tail
 * position (#228 follow-up). Omitted callers still get the core/preset/plugin
 * order — the computed blocks sort to the tail on their own.
 */
function orderReportAt(
  cwd: string,
  config: NavoriConfig,
  repoRoot: string,
  options: { computedBlockIds?: readonly string[]; omitRootOnly?: boolean } = {},
): OrderReport | null {
  const claudeMdPath = join(cwd, "CLAUDE.md");
  if (!existsSync(claudeMdPath)) return null;
  const content = readFileSync(claudeMdPath, "utf-8");
  const current = listMarkers(claudeMdPath).map((m) => m.id);
  if (current.length < 2) return null;

  // `repoRoot` is separate from `cwd`: `cwd` is where the CLAUDE.md lives, but
  // LOCAL presets resolve against `<repoRoot>/.navori/presets/`. In a workspace
  // those differ, so passing `cwd` as repoRoot left a local preset unresolved and
  // its managed block dropped out of the canonical order → permanent false order
  // drift (#266). Threading the true monorepo root keeps doctor in sync with render.
  const canonical = canonicalManagedOrder(config, repoRoot, {
    computedBlockIds: options.computedBlockIds,
    omitRootOnly: options.omitRootOnly,
  });
  // Reuse the engine's reorder logic as the source of truth for "in order?".
  const result = reorderManagedBlocks(content, canonical);
  if (!result.reordered && !result.blockedByInterleaving) return null;

  const rank = new Map<string, number>();
  canonical.forEach((id, i) => {
    if (!rank.has(id)) rank.set(id, i);
  });
  const expected = current
    .map((id, i) => ({ id, i, key: rank.has(id) ? rank.get(id)! : canonical.length + i }))
    .sort((a, z) => a.key - z.key || a.i - z.i)
    .map((x) => x.id);

  // Spotlight the block that should lead: `expected[0]` is the canonical-first
  // among the present blocks. If it isn't already at index 0, name it and its
  // current position so the diagnostic is actionable, not just two id lists.
  const lead = expected[0];
  const leadPos = lead !== undefined ? current.indexOf(lead) : -1;
  const misplacedFirst =
    lead !== undefined && leadPos > 0
      ? { id: lead, currentPos: leadPos + 1, total: current.length }
      : null;

  return { current, expected, interleaved: result.blockedByInterleaving, misplacedFirst };
}

export interface MalformedMarker {
  /** File the malformed line lives in, relative to cwd. */
  filePath: string;
  /** 1-based line number of the broken marker. */
  line: number;
  /** The trimmed line text (truncated) for the diagnostic. */
  snippet: string;
}

/**
 * Detect managed-marker lines that lost their `-->` terminator (usually a hand
 * edit that deleted just the closing chars). `findMarker` then stops matching
 * the line, so the next `injectManagedSection` appends a fresh block AND leaves
 * the broken line as permanent cruft. This is a NON-destructive report only —
 * doctor surfaces it so the user fixes the line before that happens. Issue #71
 * item 11. Shares the html-marker file set with `scanManagedDrift` via
 * `collectMarkerFiles` (#226) — this closes the old gap where the "same scope"
 * comment lied and Copilot/Cursor prose files went unscanned. Shell markers
 * (Codex `.toml`/`.sh`) are excluded: the `-->` terminator check is html-only.
 * `config` is optional — pass it to also scan monorepo workspace files (#235).
 */
export function scanMalformedMarkers(cwd: string, config?: NavoriConfig): MalformedMarker[] {
  const out = scanMalformedMarkersAt(cwd, "");
  for (const ws of config?.monorepo?.workspaces ?? []) {
    const wsCwd = join(cwd, ws.path);
    if (!existsSync(wsCwd)) continue; // orphaned workspace — render skips it too
    out.push(...scanMalformedMarkersAt(wsCwd, ws.path));
  }
  return out;
}

/** Malformed html markers within a single directory. Reported paths are
 *  optionally prefixed with `pathPrefix` (the workspace path). */
function scanMalformedMarkersAt(scanCwd: string, pathPrefix: string): MalformedMarker[] {
  const out: MalformedMarker[] = [];
  const rel = (p: string): string => (pathPrefix ? `${pathPrefix}/${p}` : p);
  // Check close before open: the close prefix is a superset string, so testing
  // it first avoids misclassifying a close line as a broken open.
  const prefixes = ["<!-- /navori:managed", "<!-- navori:managed"];
  for (const { path } of collectMarkerFiles(scanCwd, "html")) {
    let content: string;
    try {
      content = readFileSync(join(scanCwd, path), "utf-8");
    } catch {
      continue;
    }
    content.split("\n").forEach((lineText, i) => {
      for (const prefix of prefixes) {
        const idx = lineText.indexOf(prefix);
        if (idx === -1) continue;
        // A well-formed html marker terminates with `-->` on the same line.
        if (!lineText.slice(idx + prefix.length).includes("-->")) {
          out.push({ filePath: rel(path), line: i + 1, snippet: lineText.trim().slice(0, 80) });
        }
        break;
      }
    });
  }
  return out;
}

export interface DuplicateMarker {
  /** File the duplicated managed id lives in, relative to cwd. */
  filePath: string;
  /** The managed-block id that appears more than once. */
  id: string;
  /** How many open markers with this id the file carries (>= 2). */
  count: number;
}

/**
 * Detect managed-block ids that appear MORE THAN ONCE in the same file. `findMarker`
 * (`marker.ts`) matches the FIRST open marker for an id, so a duplicated block is
 * 100% invisible to render/sync/doctor: the drift scan hashes the first body, the
 * inject/remove path only ever touches the first, and the second copy — possibly
 * stale/arbitrary content — survives forever with no diagnostic (#274). A duplicate
 * id is born of a hand edit, a merge, or the degenerate append path of
 * `scanMalformedMarkers` (#71). This is a NON-destructive report only: collapsing a
 * duplicate is ambiguous (which body wins?), so doctor surfaces it and the user
 * removes the extra copy. Mirrors `scanMalformedMarkers`: derives its file set from
 * `collectMarkerFiles` (#226) and recurses monorepo workspaces (#235).
 */
export function scanDuplicateMarkers(cwd: string, config?: NavoriConfig): DuplicateMarker[] {
  const out = scanDuplicateMarkersAt(cwd, "");
  for (const ws of config?.monorepo?.workspaces ?? []) {
    const wsCwd = join(cwd, ws.path);
    if (!existsSync(wsCwd)) continue; // orphaned workspace — render skips it too
    out.push(...scanDuplicateMarkersAt(wsCwd, ws.path));
  }
  return out;
}

/** Duplicated managed ids within a single directory. Reported paths are
 *  optionally prefixed with `pathPrefix` (the workspace path). */
function scanDuplicateMarkersAt(scanCwd: string, pathPrefix: string): DuplicateMarker[] {
  const out: DuplicateMarker[] = [];
  const rel = (p: string): string => (pathPrefix ? `${pathPrefix}/${p}` : p);
  for (const { path } of collectMarkerFiles(scanCwd)) {
    const counts = new Map<string, number>();
    for (const m of listMarkers(join(scanCwd, path))) {
      counts.set(m.id, (counts.get(m.id) ?? 0) + 1);
    }
    for (const [id, count] of counts) {
      if (count > 1) out.push({ filePath: rel(path), id, count });
    }
  }
  return out;
}

/**
 * Scan `.claude/agents/` for legacy agent files (from a hand-rolled harness that
 * predates navori) whose canonical navori replacement is active — e.g. a repo
 * shipping `sdd-leader.md` while navori manages `leader.md`. navori never deletes
 * them (they carry no navori marker, so they're the user's content); it surfaces
 * them so the user can archive the redundant ones instead of ending up with two
 * parallel rosters. See legacy-agents.ts.
 */
export function scanLegacyAgents(cwd: string, config: NavoriConfig): LegacyAgent[] {
  return detectLegacyAgents(detectClaudeInfra(cwd).agentFiles, config);
}

export interface HealthState {
  claudeMdExists: boolean;
  missingPlugins: MissingPlugin[];
  drifts: DriftReport[];
  /** CLAUDE.md managed blocks out of canonical order, if any. */
  orderReport?: OrderReport | null;
  /** Legacy agent files superseded by a canonical navori agent, if any. */
  legacyAgents?: LegacyAgent[];
}

/**
 * Derive the suggested next actions from the current health state. Used by
 * `status` (and as the footer of `doctor`) to answer "what should I do now?".
 *
 * `lang` governs the prose: the human `status`/`doctor` output passes the repo's
 * `config.language`, while the `--json` contract passes `"en"` so the machine-
 * readable `nextSteps` stay stable in English regardless of locale.
 */
export function suggestNextSteps(state: HealthState, lang: Lang = DEFAULT_LANG): string[] {
  const ts = tc(lang).status;
  const steps: string[] = [];
  if (!state.claudeMdExists) {
    steps.push(ts.nextRender);
  }
  if (state.missingPlugins.length > 0) {
    steps.push(ts.nextMissingPlugins(state.missingPlugins.length));
  }
  if (state.drifts.some((d) => d.kind === "content")) {
    steps.push(ts.nextContentDrift);
  }
  if (state.drifts.some((d) => d.kind === "version")) {
    steps.push(ts.nextVersionDrift);
  }
  if (state.drifts.some((d) => d.kind === "downgrade")) {
    steps.push(ts.nextDowngradeDrift);
  }
  if (state.orderReport && !state.orderReport.interleaved) {
    steps.push(ts.nextReorder);
  }
  if (state.orderReport?.interleaved) {
    const mf = state.orderReport.misplacedFirst;
    const lead = mf ? ts.nextInterleavedLead(mf.id, mf.currentPos, mf.total) : "";
    steps.push(ts.nextInterleaved(lead));
  }
  if (state.legacyAgents && state.legacyAgents.length > 0) {
    const names = state.legacyAgents.map((l) => l.legacyName).join(", ");
    steps.push(ts.nextLegacyAgents(state.legacyAgents.length, names));
  }
  if (steps.length === 0) {
    steps.push(ts.allCurrent);
  }
  return steps;
}
