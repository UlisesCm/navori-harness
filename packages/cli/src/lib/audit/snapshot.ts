import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { NavoriError } from "../primitives/errors.ts";
import type {
  AuditReport,
  AvailabilityState,
  ComparisonDimension,
  ComparisonOutcome,
  ComparisonReason,
  ComparisonRow,
  EvidenceReason,
  MetricEvidence,
  SessionAudit,
  SnapshotComparison,
} from "./model.ts";
import { createPrivateAuditFile, copyPrivateAuditFile, readPrivateAuditFile } from "./paths.ts";
import { publicLabel, publicMapKey, publishReport } from "./report.ts";

/**
 * Range snapshots (spec 0039 R68, R69, D10; spec 0042 R19, D6).
 *
 * A snapshot is a range frozen under its own versioned format, independent of
 * `AuditReport.schemaVersion`. Format 2 keeps, next to every metric, its
 * availability, N and unit, and the range's cohorts (host, regime, model, work),
 * so a comparison can be refused metric by metric. Format 1 (bare numbers) is
 * still read, as `legacy-unknown`: no dimension is invented for it.
 *
 * PRIVACY. A snapshot is the one audit artifact meant to be copied into a repo
 * and read by other people, so it carries NUMBERS, CLOSED ENUMS AND PUBLIC
 * LABELS ONLY: it is built from `publishReport` (keys already through
 * `publicMapKey`, values already nulled), the cohort labels go through
 * `publicLabel`, and the repo is a hash of its ROOT COMMIT — never a name or a
 * path. That is a pseudonym, not anonymity: whoever holds the repo can compute
 * it. `--all-repos` carries a count and a digest of the sorted repo labels. The
 * `hook.<name>.blocks.<reason>` keys are dropped: `reason` is free text.
 *
 * The reader trusts nothing: a snapshot travels between people.
 */

/** Current snapshot format. Bump when a reader of an old file would misread it. */
export const SNAPSHOT_FORMAT = 2;

type Dist = Record<string, number>;
/** What a population of sessions looked like; `null` = unreadable or legacy. */
export interface Cohort {
  sessions: number;
  host: Dist;
  /** `navori.rendered` per session; `moved` = the harness changed mid-session. */
  regime: Dist;
  /** Role (`main-thread` or an agent type) → model label → sessions (main) or runs. */
  models: Record<string, Dist>;
  /** `tracked` = the session logged an outcome event. Instrumentation, not the kind of work. */
  work: Dist;
}
type Axis = "all" | "tools" | "hooks";
type Unit = "session" | "run" | "call" | "fire" | "other" | "diagnostic";
const STATES = new Set<string>([
  "observed",
  "partial",
  "unavailable",
  "unsupported",
  "invalid",
  "legacy-unknown",
]);
type AuditMode = "opt-in" | "always" | "unknown";

export interface SnapshotMetric {
  value: number | null;
  state: AvailabilityState | "legacy-unknown";
  reason: EvidenceReason | null;
  n: number | null;
}

export interface RangeSnapshot {
  snapshotFormat: 1 | 2;
  generatedBy: string;
  /** `unknown` only for a format-1 file, which never recorded it. */
  scope: "repo" | "all" | "unknown";
  /** Hash of the root commit (`repo`) or digest of the sorted repo labels (`all`); null = unknown. */
  repo: string | null;
  repos: number | null;
  range: { from: string; to: string };
  /** What R43 requires equal besides the cohorts: the config `audit.mode` and the miner (navori version). */
  controls: { auditMode: AuditMode; miner: string };
  cohorts: Record<Axis, Cohort | null>;
  metrics: Record<string, SnapshotMetric>;
  /** Entries of the file dropped for failing validation. */
  invalidEntries: number;
}

/** `hook.<name>.blocks.<reason>`: the per-rule split, whose key is free text. */
function isReasonKey(key: string): boolean {
  return /^hook\..+\.blocks\./.test(key);
}

/** How a metric is compared: its unit, the sessions that measure it and the dimensions it depends on. */
function profile(key: string): { unit: Unit; axis: Axis; role: string | null; session: boolean } {
  const [head = "", second = ""] = key.split(".");
  if (/\.n$/.test(key) || head === "sessions" || head === "coverage")
    return { unit: "diagnostic", axis: "all", role: null, session: false };
  if (head === "session" || (head === "agent" && second === "main-thread"))
    return { unit: "session", axis: "tools", role: "main-thread", session: true };
  if (head === "agent") return { unit: "run", axis: "tools", role: second, session: false };
  if (head === "tool" || head === "edits")
    return { unit: "call", axis: "tools", role: "*", session: false };
  if (head === "hooks" || head === "hook")
    return { unit: "fire", axis: "hooks", role: null, session: false };
  return { unit: "other", axis: "all", role: null, session: false };
}

/** Intensive statistics (a median, a percentage, a per-call figure) survive different window sizes; counts do not. */
function isIntensive(key: string): boolean {
  return /(?:\.p50|\.p90|\.pct|Pct|\.perBashCall)$/.test(key);
}

const hash16 = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);
const measurable = (e: MetricEvidence | undefined): boolean =>
  e?.state === "observed" || e?.state === "partial";

function cohortOf(sessions: readonly SessionAudit[]): Cohort {
  const cohort: Cohort = { sessions: sessions.length, host: {}, regime: {}, models: {}, work: {} };
  const inc = (dist: Dist, label: string): void => {
    dist[label] = (dist[label] ?? 0) + 1;
  };
  const model = (value: string | null | undefined): string =>
    value ? publicLabel(value) : "unknown";
  for (const s of sessions) {
    inc(cohort.host, s.host ?? "claude");
    const rendered = s.navori?.rendered;
    inc(
      cohort.regime,
      s.navoriAtStop
        ? "moved"
        : rendered && /^\d+\.\d+\.\d+$/.test(rendered)
          ? rendered
          : "unknown",
    );
    inc(cohort.work, s.cliEvents?.some((e) => e.outcomePayload) ? "tracked" : "untracked");
    const main = (cohort.models["main-thread"] ??= {});
    const labels = Object.keys(
      Object.keys(s.orchestrator.models).length > 0 || s.rollout?.status !== "parsed"
        ? s.orchestrator.models
        : s.rollout.models,
    );
    if (labels.length === 0) inc(main, "unknown");
    for (const label of labels) inc(main, model(label));
    for (const run of s.agents)
      inc((cohort.models[publicLabel(run.agentType)] ??= {}), model(run.model));
  }
  return cohort;
}

/**
 * Builds the snapshot of a report. Pure: nothing is read or written. The caller
 * resolves what needs git and config (`rootCommit`, `auditMode`) so no I/O hides
 * in here; an unavailable root commit stays `null`, it is never replaced by a name.
 */
export function buildSnapshot(
  report: AuditReport,
  opts: { scope: "repo" | "all"; rootCommit: string | null; auditMode: AuditMode },
): RangeSnapshot {
  if (report.schemaVersion !== 11)
    throw new NavoriError("snapshot-schema-unsupported", "Only schema 11 reports can be frozen.");
  const published = publishReport(report);
  const metrics: Record<string, SnapshotMetric> = {};
  for (const [key, value] of Object.entries(published.rangeMetrics)) {
    if (isReasonKey(key)) continue;
    const a = published.availability[key];
    const sibling = published.rangeMetrics[key.replace(/\.(?:p50|p90)$/, ".n")];
    metrics[key] = {
      value: typeof value === "number" && Number.isFinite(value) ? value : null,
      state: a?.state ?? "unavailable",
      reason: a?.reason ?? null,
      n:
        typeof sibling === "number" && /\.(?:p50|p90)$/.test(key)
          ? sibling
          : (a?.contributors ?? null),
    };
  }
  const sessions = report.sessions;
  const labels = (published.repos ?? []).map((r) => r.repo).sort();
  const all = opts.scope === "all";
  return {
    snapshotFormat: SNAPSHOT_FORMAT,
    generatedBy: report.generatedBy,
    scope: opts.scope,
    repo: all
      ? labels.length > 0
        ? hash16(labels.join("\0"))
        : null
      : opts.rootCommit
        ? hash16(`navori-snapshot-repo/v2\0${opts.rootCommit}`)
        : null,
    repos: all ? labels.length : null,
    range: { from: report.range.from, to: report.range.to },
    controls: { auditMode: opts.auditMode, miner: report.generatedBy.replace(/^navori@/, "") },
    cohorts: {
      all: cohortOf(sessions),
      tools: cohortOf(sessions.filter((s) => measurable(s.availability?.tools))),
      hooks: cohortOf(sessions.filter((s) => measurable(s.availability?.hooks))),
    },
    metrics,
    invalidEntries: 0,
  };
}

/**
 * Writes the snapshot at `path`, creating its directory, and refuses to replace
 * an existing file: a baseline that a re-run silently overwrote is no baseline.
 */
export function writeSnapshot(path: string, snapshot: RangeSnapshot): void {
  const result = createPrivateAuditFile(path, `${JSON.stringify(snapshot, null, 2)}\n`);
  if (!result.ok) {
    if (result.reason === "exists") {
      throw new NavoriError(
        "snapshot-exists",
        `The snapshot ${path} already exists and is not overwritten: pick another name or remove it yourself.`,
      );
    }
    throw new NavoriError("snapshot-unwritable", `Snapshot refused: ${result.reason}.`);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
/** A label that cannot carry ANSI, Markdown or `__proto__`. */
const LABEL = /^[a-zA-Z0-9][a-zA-Z0-9.:+-]{0,63}$/;

function readDist(v: unknown): Dist | null {
  if (!isRecord(v)) return null;
  const out: Dist = Object.create(null);
  for (const [label, n] of Object.entries(v)) {
    const c = count(n);
    if (!LABEL.test(label) || c === null) return null;
    out[label] = c;
  }
  return out;
}

function readCohort(v: unknown): Cohort | null {
  if (!isRecord(v) || !isRecord(v.models)) return null;
  const host = readDist(v.host);
  const regime = readDist(v.regime);
  const work = readDist(v.work);
  const sessions = count(v.sessions);
  if (!host || !regime || !work || sessions === null) return null;
  const models: Record<string, Dist> = Object.create(null);
  for (const [role, dist] of Object.entries(v.models)) {
    const d = readDist(dist);
    if (!LABEL.test(role) || !d) return null;
    models[role] = d;
  }
  return { sessions, host, regime, models, work };
}

function readMetrics(
  raw: unknown,
  v1: boolean,
): { metrics: Record<string, SnapshotMetric>; invalid: number } {
  const metrics: Record<string, SnapshotMetric> = Object.create(null);
  let invalid = 0;
  if (!isRecord(raw)) return { metrics, invalid };
  const entries = Object.entries(raw);
  // v1 `n` is recovered from its sibling `.n` keys, never invented.
  const siblingN = (key: string): number | null => {
    const n = raw[key.replace(/\.(?:p50|p90)$/, ".n")];
    return /\.(?:p50|p90)$/.test(key) && typeof n === "number" ? n : null;
  };
  for (const [rawKey, entry] of entries) {
    // A key that `publicMapKey` would rewrite is free text: drop it, whatever the format.
    const key = v1 ? publicMapKey(rawKey, "rangeMetrics") : rawKey;
    if (isReasonKey(rawKey)) continue;
    if (v1) {
      if (typeof entry === "number" || entry === null)
        metrics[key] = {
          value: entry,
          state: "legacy-unknown",
          reason: null,
          n: siblingN(rawKey),
        };
      else invalid++;
      continue;
    }
    if (
      publicMapKey(key, "rangeMetrics") !== key ||
      !isRecord(entry) ||
      !(
        entry.value === null ||
        (typeof entry.value === "number" && Number.isFinite(entry.value))
      ) ||
      typeof entry.state !== "string" ||
      !STATES.has(entry.state) ||
      !(
        entry.reason === null ||
        (typeof entry.reason === "string" && /^[a-z-]{1,32}$/.test(entry.reason))
      ) ||
      (entry.n !== null && count(entry.n) === null)
    ) {
      invalid++;
      continue;
    }
    metrics[key] = {
      value: entry.value,
      state: entry.state as SnapshotMetric["state"],
      reason: entry.reason as EvidenceReason | null,
      n: entry.n as number | null,
    };
  }
  return { metrics, invalid };
}

/** Reads and validates a snapshot file (format 1 or 2) for `--compare`. */
export function readSnapshot(path: string): RangeSnapshot {
  let raw: string;
  try {
    const result = readPrivateAuditFile(path, { ownedRoot: null, privateFile: false });
    if (!result.ok) throw new Error(result.reason);
    raw = result.value.toString("utf-8");
  } catch {
    throw new NavoriError("snapshot-unreadable", `Cannot read the snapshot ${path}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new NavoriError("snapshot-invalid", `${path} is not valid JSON.`);
  }
  if (!isRecord(parsed)) {
    throw new NavoriError("snapshot-invalid", `${path} is not a snapshot.`);
  }
  const format = parsed.snapshotFormat;
  if (format !== 1 && format !== 2) {
    throw new NavoriError(
      "snapshot-format",
      `${path} has snapshotFormat ${String(format)}; this navori reads formats 1 and 2.`,
    );
  }
  const v1 = format === 1;
  const source = v1 ? parsed.rangeMetrics : parsed.metrics;
  if (!isRecord(source)) {
    throw new NavoriError("snapshot-invalid", `${path} has no metrics.`);
  }
  const { metrics, invalid } = readMetrics(source, v1);
  const range = isRecord(parsed.range) ? parsed.range : {};
  const iso = (v: unknown): string =>
    typeof v === "string" && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(v)
      ? v
      : "";
  const controls = isRecord(parsed.controls) ? parsed.controls : {};
  const cohorts = isRecord(parsed.cohorts) ? parsed.cohorts : {};
  const generatedBy =
    typeof parsed.generatedBy === "string" &&
    /^navori@\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(parsed.generatedBy)
      ? parsed.generatedBy
      : "navori@unknown";
  return {
    snapshotFormat: v1 ? 1 : 2,
    generatedBy,
    // Format 1 never recorded the scope; defaulting it would invent a dimension.
    scope: v1
      ? "unknown"
      : parsed.scope === "all"
        ? "all"
        : parsed.scope === "repo"
          ? "repo"
          : "unknown",
    repo:
      !v1 && typeof parsed.repo === "string" && /^[a-f0-9]{16}$/.test(parsed.repo)
        ? parsed.repo
        : null,
    repos: v1 ? null : count(parsed.repos),
    range: { from: iso(range.from), to: iso(range.to) },
    controls: {
      auditMode:
        !v1 && (controls.auditMode === "opt-in" || controls.auditMode === "always")
          ? controls.auditMode
          : "unknown",
      miner:
        !v1 &&
        typeof controls.miner === "string" &&
        /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(controls.miner)
          ? controls.miner
          : "unknown",
    },
    cohorts: {
      all: v1 ? null : readCohort(cohorts.all),
      tools: v1 ? null : readCohort(cohorts.tools),
      hooks: v1 ? null : readCohort(cohorts.hooks),
    },
    metrics,
    invalidEntries: invalid,
  };
}

/**
 * The only pre-registered criterion `--compare` knows: Spec 0039 R43, −10% of
 * cache read per implementer launch with n ≥ 100 per window. R43 also demands
 * the same miner and `audit.mode`, and discards a change under the noise band
 * between two base windows; one baseline cannot measure that band, so a metric
 * that clears this preflight is `threshold-met-unverified` at best — the verdict
 * R43 withheld (0039 T44) is not given here.
 */
const PREREGISTERED: Record<string, { threshold: number; minN: number }> = {
  "agent.implementer.cacheRead.p50": { threshold: -0.1, minN: 100 },
};
const UNCONTROLLED = ["task-mix", "ccVersion", "local-harness-edits"];
const INCONCLUSIVE = new Set<string>(["side-unavailable", "partial-coverage", "below-floor"]);
const UNCONTROLLED_REASONS = new Set<string>(["audit-mode-uncontrolled", "miner-differs"]);

/** `unknown` / `mixed` / the single known label of a distribution. */
function homogeneous(dist: Dist | undefined, bad: readonly string[] = ["unknown"]): string {
  const keys = Object.keys(dist ?? {});
  if (keys.length === 0 || keys.some((k) => bad.includes(k))) return "unknown";
  return keys.length > 1 ? "mixed" : keys[0]!;
}

function dimensionLabel(c: Cohort | null, dim: ComparisonDimension, role: string | null): string {
  if (!c) return "unknown";
  if (dim === "host") return homogeneous(c.host);
  if (dim === "work") return homogeneous(c.work);
  if (dim === "regime") return homogeneous(c.regime, ["unknown", "moved"]);
  const roles = role === "*" ? Object.keys(c.models).sort() : [role ?? ""];
  const labels = roles.map((r) => homogeneous(c.models[r]));
  if (labels.length === 0 || labels.includes("unknown")) return "unknown";
  return labels.includes("mixed") ? "mixed" : roles.map((r, i) => `${r}=${labels[i]}`).join(";");
}

/** Window bounds `[from,to)` in ms, or null when unreadable or empty. */
function windowOf(range: { from: string; to: string }): [number, number] | null {
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  return Number.isNaN(from) || Number.isNaN(to) || to <= from ? null : [from, to];
}

/** Checks that hold for every metric: format, window, scope and repo. */
function globalReasons(base: RangeSnapshot, current: RangeSnapshot): ComparisonReason[] {
  const out: ComparisonReason[] = [];
  const legacy = base.snapshotFormat === 1 || current.snapshotFormat === 1;
  if (legacy) out.push("legacy-snapshot");
  const a = windowOf(base.range);
  const b = windowOf(current.range);
  if (!a || !b) out.push("window-unknown");
  else if (a[0] < b[1] && b[0] < a[1]) out.push("overlapping-window");
  if (legacy) return out;
  if (base.scope !== current.scope || base.scope === "unknown") out.push("cohort-mismatch:scope");
  else if (base.repo === null || current.repo === null) out.push("cohort-unknown:repo");
  else if (base.repo !== current.repo) out.push("cohort-mismatch:repo");
  return out;
}

function compareMetric(
  key: string,
  base: RangeSnapshot,
  current: RangeSnapshot,
  global: readonly ComparisonReason[],
): ComparisonRow {
  const b = base.metrics[key];
  const c = current.metrics[key];
  const p = profile(key);
  const legacy = global.includes("legacy-snapshot");
  const reasons: ComparisonReason[] = [...global];
  if (p.unit === "diagnostic") reasons.push("diagnostic-metric");
  else if (!isIntensive(key)) reasons.push("extensive-count");
  let contrast: ComparisonRow["contrast"] = null;
  if (!legacy) {
    const differing: ComparisonDimension[] = [];
    const dims: ComparisonDimension[] = ["host", "regime"];
    if (p.role) dims.push("model");
    if (p.session) dims.push("work");
    for (const dim of dims) {
      const x = dimensionLabel(base.cohorts[p.axis], dim, p.role);
      const y = dimensionLabel(current.cohorts[p.axis], dim, p.role);
      if (x === "unknown" || y === "unknown") reasons.push(`cohort-unknown:${dim}`);
      else if (x === "mixed" || y === "mixed") reasons.push(`cohort-mixed:${dim}`);
      else if (x !== y) differing.push(dim);
    }
    for (const dim of differing)
      if (dim === "host" || dim === "work") reasons.push(`cohort-mismatch:${dim}`);
    const contrasts = differing.filter((d) => d === "regime" || d === "model");
    if (contrasts.length > 1) reasons.push("confounded");
    else if (contrasts[0] === "regime" || contrasts[0] === "model") contrast = contrasts[0];
    if (b?.value == null || c?.value == null) reasons.push("side-unavailable");
    else if (b.state !== "observed" || c.state !== "observed") reasons.push("partial-coverage");
  }
  const pre = PREREGISTERED[key];
  if (!pre) reasons.push("no-preregistered-floor");
  else if ((b?.n ?? 0) < pre.minN || (c?.n ?? 0) < pre.minN) reasons.push("below-floor");
  else if (reasons.length === 0) {
    const known = (v: string): boolean => v !== "unknown";
    const { auditMode: am, miner: mb } = base.controls;
    if (!known(am) || am !== current.controls.auditMode) reasons.push("audit-mode-uncontrolled");
    if (!known(mb) || mb !== current.controls.miner) reasons.push("miner-differs");
  }
  const bv = b?.value ?? null;
  const cv = c?.value ?? null;
  const delta =
    isIntensive(key) && bv !== null && cv !== null ? Math.round((cv - bv) * 100) / 100 : null;
  const relativeChange =
    delta !== null && bv !== null && bv !== 0
      ? Math.round(((cv! - bv) / Math.abs(bv)) * 10_000) / 10_000
      : null;
  const first = reasons[0];
  const outcome: ComparisonOutcome = !first
    ? "matched"
    : INCONCLUSIVE.has(first)
      ? "inconclusive"
      : UNCONTROLLED_REASONS.has(first)
        ? "notControlled"
        : "descriptive";
  return {
    key,
    base: bv,
    current: cv,
    delta,
    relativeChange,
    outcome,
    reasons,
    contrast,
    n: { base: b?.n ?? null, current: c?.n ?? null },
    ...(outcome === "matched" && pre
      ? {
          criterion: {
            source: "spec-0039/R43" as const,
            threshold: pre.threshold,
            minN: pre.minN,
            observedChange: relativeChange,
            state:
              relativeChange !== null && relativeChange <= pre.threshold
                ? ("threshold-met-unverified" as const)
                : ("threshold-not-met" as const),
            noiseBand: "unmeasured" as const,
            uncontrolled: UNCONTROLLED,
          },
        }
      : {}),
  };
}

/**
 * Per-metric preflight. It never says a metric improved: `matched` means "same
 * known cohorts and full coverage", and even a pre-registered criterion stays
 * unverified without a measured noise band.
 */
export function compareSnapshots(base: RangeSnapshot, current: RangeSnapshot): SnapshotComparison {
  const global = globalReasons(base, current);
  const keys = new Set([...Object.keys(base.metrics), ...Object.keys(current.metrics)]);
  const rows = [...keys].sort().map((key) => compareMetric(key, base, current, global));
  const totals = { matched: 0, descriptive: 0, inconclusive: 0, notControlled: 0 };
  for (const row of rows) totals[row.outcome]++;
  const side = (s: RangeSnapshot): SnapshotComparison["base"] => ({
    format: s.snapshotFormat,
    scope: s.scope,
    range: s.range,
    sessions: s.cohorts.all?.sessions ?? null,
  });
  return { base: side(base), current: side(current), rows, totals };
}

const cell = (v: number | null): string => (v === null ? "n/a" : String(v));

/**
 * The comparison as printable lines: the counts by outcome and the rows that
 * cleared or nearly cleared the preflight and moved. Descriptive rows are
 * counted, not listed.
 */
export function renderComparison(
  cmp: SnapshotComparison,
  base: RangeSnapshot,
  current: RangeSnapshot,
): string[] {
  const { totals } = cmp;
  const shown = cmp.rows.filter((r) => r.outcome !== "descriptive" && r.base !== r.current);
  const lines = [
    `base:    ${base.generatedBy} · ${cmp.base.scope} · ${cmp.base.range.from} → ${cmp.base.range.to} · format ${cmp.base.format}`,
    `current: ${current.generatedBy} · ${cmp.current.scope} · ${cmp.current.range.from} → ${cmp.current.range.to}`,
    `matched ${totals.matched} · inconclusive ${totals.inconclusive} · not controlled ${totals.notControlled} · descriptive ${totals.descriptive}`,
    "matched = same known cohorts and coverage; it does not mean improvement, and a difference of medians is not a cause.",
  ];
  if (shown.length > 0)
    lines.push(
      "",
      "| metric | base | current | delta | outcome | reasons |",
      "|---|---:|---:|---:|---|---|",
    );
  for (const r of shown)
    lines.push(
      `| ${r.key} | ${cell(r.base)} | ${cell(r.current)} | ${cell(r.delta)} | ${r.outcome}${r.criterion ? ` (${r.criterion.state}, noise band unmeasured)` : ""} | ${r.reasons.join(", ")} |`,
    );
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

/** Smallest root commit of the repository at `cwd` (stable across worktrees and machines), or null. */
export function gitRootCommit(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return (
      out
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /^[0-9a-f]{40,64}$/.test(l))
        .sort()[0] ?? null
    );
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
  const copy = copyPrivateAuditFile(snapshotFile, target, { destination: { ownedRoot: null } });
  if (!copy.ok)
    throw new NavoriError("copy-to-unwritable", `Snapshot copy refused: ${copy.reason}.`);
  return target;
}
