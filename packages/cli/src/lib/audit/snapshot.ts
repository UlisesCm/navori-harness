import { execFileSync } from "node:child_process";
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { NavoriError } from "../primitives/errors.ts";
import type { AuditReport } from "./model.ts";

/**
 * Range snapshots (spec 0039 R68, R69, D10).
 *
 * A snapshot is the range's `rangeMetrics` frozen under its own versioned
 * format. It is independent of `AuditReport.schemaVersion` on purpose: the
 * report can change shape and a baseline taken before the change must still be
 * comparable, so the file declares `snapshotFormat` and nothing else about the
 * report's layout.
 *
 * PRIVACY. A snapshot is the one audit artifact meant to be copied into a repo
 * and read by other people, so it carries NUMBERS ONLY:
 *
 * - No command text. The report's blocked-command examples never reach
 *   `rangeMetrics`, and the one place free text could still leak — the
 *   `hook.<name>.blocks.<reason>` keys, whose `reason` is whatever the hook
 *   wrote — is dropped here (`isReasonKey`). The reasons of the managed hooks
 *   are fixed phrases, BUT several interpolate the target: `implementer-no-markdown`
 *   writes `"<tool> sobre '<path>'"`, `guard-destructive` writes the base
 *   branch and `managed_rewrite_msg`, and `subagent-stop-handoff` writes the
 *   handoff problems. A path or branch is part of the command the user ran, so
 *   the per-reason split is not published; `hook.<name>.blocks` (the total)
 *   stays, which is the figure a baseline needs.
 * - No repo name. An `--all-repos` snapshot is built from aggregates alone and
 *   lands under `_all-repos/`.
 */

/** Current snapshot format. Bump when a reader of an old file would misread it. */
export const SNAPSHOT_FORMAT = 1;

export interface RangeSnapshot {
  snapshotFormat: typeof SNAPSHOT_FORMAT;
  generatedBy: string;
  /** `repo` = one audited repo; `all` = every audited repo, aggregated. */
  scope: "repo" | "all";
  range: { from: string; to: string };
  rangeMetrics: Record<string, number | null>;
}

/** `hook.<name>.blocks.<reason>`: the per-rule split, whose key is free text. */
function isReasonKey(key: string): boolean {
  return /^hook\..+\.blocks\./.test(key);
}

/** Builds the snapshot of a report. Pure: nothing is read or written. */
export function buildSnapshot(report: AuditReport, scope: "repo" | "all"): RangeSnapshot {
  if (report.schemaVersion === 11)
    throw new NavoriError("snapshot-schema-unavailable", "schema11-snapshot-pending");
  const rangeMetrics: Record<string, number | null> = {};
  for (const [key, value] of Object.entries(report.rangeMetrics)) {
    if (!isReasonKey(key)) rangeMetrics[key] = value;
  }
  return {
    snapshotFormat: SNAPSHOT_FORMAT,
    generatedBy: report.generatedBy,
    scope,
    range: { from: report.range.from, to: report.range.to },
    rangeMetrics,
  };
}

/**
 * Writes the snapshot at `path`, creating its directory, and refuses to replace
 * an existing file: a baseline that a re-run silently overwrote is no baseline.
 */
export function writeSnapshot(path: string, snapshot: RangeSnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, {
      encoding: "utf-8",
      flag: "wx",
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new NavoriError(
        "snapshot-exists",
        `The snapshot ${path} already exists and is not overwritten: pick another name or remove it yourself.`,
      );
    }
    throw err;
  }
}

/** Reads and validates a snapshot file for `--compare`. */
export function readSnapshot(path: string): RangeSnapshot {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    throw new NavoriError("snapshot-unreadable", `Cannot read the snapshot ${path}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new NavoriError("snapshot-invalid", `${path} is not valid JSON.`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new NavoriError("snapshot-invalid", `${path} is not a snapshot.`);
  }
  const rec = parsed as Record<string, unknown>;
  if (rec.snapshotFormat !== SNAPSHOT_FORMAT) {
    throw new NavoriError(
      "snapshot-format",
      `${path} has snapshotFormat ${String(rec.snapshotFormat)}; this navori reads format ${SNAPSHOT_FORMAT}.`,
    );
  }
  const metrics = rec.rangeMetrics;
  const range = rec.range as { from?: unknown; to?: unknown } | null | undefined;
  if (typeof metrics !== "object" || metrics === null || Array.isArray(metrics)) {
    throw new NavoriError("snapshot-invalid", `${path} has no rangeMetrics.`);
  }
  const clean: Record<string, number | null> = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (typeof value === "number" || value === null) clean[key] = value;
  }
  return {
    snapshotFormat: SNAPSHOT_FORMAT,
    generatedBy: typeof rec.generatedBy === "string" ? rec.generatedBy : "unknown",
    scope: rec.scope === "all" ? "all" : "repo",
    range: {
      from: typeof range?.from === "string" ? range.from : "",
      to: typeof range?.to === "string" ? range.to : "",
    },
    rangeMetrics: clean,
  };
}

export interface MetricDiff {
  key: string;
  /** `undefined` = the metric is absent from that snapshot. */
  base: number | null | undefined;
  current: number | null | undefined;
  /** current − base, only when both sides hold a number. */
  delta: number | null;
}

/** Per-metric difference over the union of both snapshots' keys, sorted. */
export function compareSnapshots(base: RangeSnapshot, current: RangeSnapshot): MetricDiff[] {
  const keys = new Set([...Object.keys(base.rangeMetrics), ...Object.keys(current.rangeMetrics)]);
  return [...keys].sort().map((key) => {
    const b = base.rangeMetrics[key];
    const c = current.rangeMetrics[key];
    return {
      key,
      base: b,
      current: c,
      delta:
        typeof b === "number" && typeof c === "number" ? Math.round((c - b) * 100) / 100 : null,
    };
  });
}

/** `n/a` for a metric the snapshot lacks and for one no session could measure. */
function cell(v: number | null | undefined): string {
  return v === null || v === undefined ? "n/a" : String(v);
}

/**
 * The comparison as printable lines. Rows that did not move are counted, not
 * listed: a baseline holds hundreds of metrics and the reader asked what changed.
 */
export function renderComparison(
  diffs: readonly MetricDiff[],
  base: RangeSnapshot,
  current: RangeSnapshot,
): string[] {
  const moved = diffs.filter((d) => d.base !== d.current);
  const lines = [
    `base:    ${base.generatedBy} · ${base.scope} · ${base.range.from} → ${base.range.to}`,
    `current: ${current.generatedBy} · ${current.scope} · ${current.range.from} → ${current.range.to}`,
  ];
  if (base.scope !== current.scope) {
    lines.push(
      `warning: the scopes differ (${base.scope} vs ${current.scope}); the figures are not like for like`,
    );
  }
  lines.push("", "| metric | base | current | delta |", "|---|---:|---:|---:|");
  for (const d of moved) {
    lines.push(`| ${d.key} | ${cell(d.base)} | ${cell(d.current)} | ${cell(d.delta)} |`);
  }
  lines.push("", `${moved.length} changed, ${diffs.length - moved.length} unchanged`);
  return lines;
}

/** Git toplevel of `cwd`, or null outside a repository. */
export function gitToplevel(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** `realpath` of the nearest existing ancestor joined with what does not exist yet. */
function realTarget(path: string): string {
  let existing = path;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return path;
    rest.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync(existing), ...rest);
}

/** True when `path` is, or sits under, one of `roots` or any directory with a `.git`. */
function insideAnyRepo(path: string, roots: readonly string[]): boolean {
  const target = realTarget(path);
  for (const root of roots) {
    const real = realTarget(root);
    if (target === real || target.startsWith(real + sep)) return true;
  }
  let dir = target;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Resolves `--copy-to` and copies the snapshot there.
 *
 * - The path is explicit and resolved FROM THE GIT TOPLEVEL of `cwd`, not from
 *   wherever the command happened to run: a relative `docs/x.json` means the
 *   same file from any subdirectory. An absolute path is taken as given;
 *   outside a repository a relative one has no anchor and is refused.
 * - An existing file is never replaced; an existing directory receives the
 *   snapshot under its own name.
 * - For an `--all-repos` snapshot (`scope: "all"`), a destination inside ANY
 *   repo is refused: `repoRoots` are the audited roots, and any directory with a
 *   `.git` above the target counts too, so an unaudited repo is covered.
 *
 * @returns the path written.
 */
export function copySnapshotTo(
  snapshotFile: string,
  copyTo: string,
  opts: { cwd: string; scope: "repo" | "all"; repoRoots: readonly string[] },
): string {
  const top = gitToplevel(opts.cwd);
  if (!isAbsolute(copyTo) && top === null) {
    throw new NavoriError(
      "copy-to-no-anchor",
      `--copy-to '${copyTo}' is relative and ${opts.cwd} is not inside a git repository: pass an absolute path.`,
    );
  }
  let target = isAbsolute(copyTo) ? copyTo : resolve(top ?? opts.cwd, copyTo);
  if (existsSync(target) && statSync(target).isDirectory()) {
    target = join(target, basename(snapshotFile));
  }
  if (opts.scope === "all") {
    const roots = top === null ? opts.repoRoots : [...opts.repoRoots, top];
    if (insideAnyRepo(target, roots)) {
      throw new NavoriError(
        "copy-to-inside-repo",
        `Refusing to write a multi-repo snapshot inside a repository (${target}): it aggregates every audited repo and must not be committed into any of them.`,
      );
    }
  }
  if (existsSync(target)) {
    throw new NavoriError(
      "copy-to-exists",
      `${target} already exists and is not overwritten: pass a different --copy-to path.`,
    );
  }
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(snapshotFile, target, constants.COPYFILE_EXCL);
  return target;
}
