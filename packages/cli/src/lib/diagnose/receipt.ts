import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { LOCKFILES } from "./detect.ts";
import { isUnderProgressDir } from "../primitives/progress-dirs.ts";
import { appendCliEvent, outcomeFeatureKey } from "../audit/cli-event.ts";
import type { OutcomePayload, ReceiptAction, ReceiptOutcome } from "../audit/model.ts";
import type { ContentIdentity } from "../primitives/content-identity.ts";
import { reviewEvidenceWarning } from "../handoff/review-evidence.ts";
import {
  ensureStateDirectory,
  resolveStateRoot,
  stateArtifactPath,
  type StateRoot,
} from "../primitives/state-root.ts";

export type ReceiptStatus = "ok" | "findings" | "error";
export type DriftKind = "changed" | "missing" | "reappeared";
/** R5/R7: which part of the identity (base + comando + inputs) no longer matches
 * the signed receipt. "format" covers a receipt signed before v2 (no gate/inputs
 * to compare at all) — see Migration in the design. */
export type StaleReason = "gate" | "inputs" | "format";
export interface ReceiptResult {
  formatVersion: 1;
  target: string;
  targetSha: string | null;
  headSha: string | null;
  status: ReceiptStatus;
  uncovered: string[];
  drift: Array<{ path: string; blob: string | null; kind: DriftKind }>;
  /** `stale.length === 0`. Never affects `status`/exit code — see D1. */
  fresh: boolean;
  stale: StaleReason[];
  /** True only when `check` read `receipt.consumed.txt` via `includeConsumed`. */
  consumed: boolean;
  /** `sign`: the kind written; `check`: read from the header. `null` for a receipt older than v2 or on error. */
  gateKind: "full" | "scoped" | null;
  error: string | null;
}
export interface ReceiptOptions {
  cwd: string;
  feature: string;
  target: string;
  dir: string;
  /** The resolved `qualityGate.full` command. Part of R5's evidence identity. */
  gate: string;
  /** `check` only: fall back to `receipt.consumed.txt` when `receipt.txt` is absent. */
  includeConsumed?: boolean;
  /** `sign` only: the recomputed `decideGate` result (spec 0044 R25). */
  gateDecision?: { gateKind: "scoped" | "full"; reason: string };
  /**
   * `sign` only: the gate the reviewer declares to have run. `docs` re-signs a
   * delta of Markdown under `specs/` or `docs/` over a current `full` receipt
   * after `qualityGate.docs` (spec 0054 R21, D6); the CLI refuses anything else.
   */
  gateRan?: "scoped" | "full" | "docs";
  /** The resolved `qualityGate.docs`; `--gate-ran docs` is refused when unset. */
  docsGate?: string;
  /**
   * Audit observation (spec 0042 T9b). Absent unless an exact audit context
   * exists, so a command outside one computes no identity at all. It only
   * collects what the command already computes plus two identity samples; it
   * never changes the result, the exit code or `ReceiptResult`.
   */
  observer?: ReceiptObserver;
  /** Resume uses local refs and hashes without writing Git objects. */
  readOnly?: boolean;
  deadline?: number;
  currentContent?: ContentIdentity;
}

/**
 * Mutable collector for the `receipt-outcome` projection. `sample` is invoked
 * through a guard (a throw reads as an unavailable identity), once before
 * `inspect` and once after the receipt was written or read: the "sandwich" that
 * tells a stable tree from one edited while the command ran.
 */
export interface ReceiptObserver {
  sample: () => ContentIdentity;
  before?: ContentIdentity;
  after?: ContentIdentity;
  /** sha256 of the receipt text written (sign) or read (check). */
  receipt?: string;
  /** Recomputed gate/inputs digests; `gate` is left unset when no gate is configured. */
  gate?: string;
  inputs?: string;
}

/** Samples the identity without ever letting an observation failure escape. */
function sampleIdentity(observer: ReceiptObserver | undefined): ContentIdentity | undefined {
  if (!observer) return undefined;
  try {
    return observer.sample();
  } catch {
    return { ok: false, reason: "git-failed" };
  }
}

/** The gate/inputs half of R5's "evidence identity" (base+comando+inputs). The
 * tree half is already covered by the existing per-file blob lines in the
 * receipt body; this is the ONLY place the other two are computed, so `sign`
 * and `check` can never diverge on what counts as "the same evidence". */
export interface EvidenceIdentity {
  gate: string;
  inputs: string;
}

/** Header `gate=` value of a receipt signed after a scoped cycle; never a sha256, so `check` reads it stale. */
const SCOPED_GATE = "scoped";

function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Ordered `<lockfile>\0<content sha256>\n` payload over every `LOCKFILES`
 * entry present at the repo root. Empty (hash of `""`) when none are present. */
function inputsPayload(cwd: string): string {
  let payload = "";
  for (const name of LOCKFILES) {
    const path = resolve(cwd, name);
    if (!existsSync(path)) continue;
    payload += `${name}\0${sha256(readFileSync(path))}\n`;
  }
  return payload;
}

export function evidenceIdentity(cwd: string, gate: string): EvidenceIdentity {
  return { gate: sha256(gate), inputs: sha256(inputsPayload(cwd)) };
}

function empty(options: ReceiptOptions, error: string): ReceiptResult {
  return {
    formatVersion: 1,
    target: options.target,
    targetSha: null,
    headSha: null,
    status: "error",
    uncovered: [],
    drift: [],
    fresh: false,
    stale: [],
    consumed: false,
    gateKind: null,
    error,
  };
}

function git(cwd: string, args: string[], nul = false, deadline?: number): string {
  if (deadline !== undefined && Date.now() >= deadline) throw new Error("receipt timeout");
  if (!process.env.PATH) throw new Error("git failed: PATH is empty");
  const result = spawnSync(
    "git",
    ["-c", "core.fsmonitor=false", "-c", "core.quotepath=false", ...args],
    {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      encoding: "buffer",
      timeout: deadline ? Math.max(1, deadline - Date.now()) : undefined,
    },
  );
  if (result.error) throw new Error(`git failed: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(`git failed: ${(result.stderr?.toString() || "unknown error").trim()}`);
  const value = result.stdout?.toString() ?? "";
  return nul ? value : value.trim();
}

function pathsFromNul(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

function validatePath(cwd: string, path: string): void {
  if (path.includes("\n") || path.includes("\r"))
    throw new Error(`path cannot be represented in receipt: ${JSON.stringify(path)}`);
  const absolute = resolve(cwd, path);
  const rel = relative(cwd, absolute);
  if (rel.startsWith(`..${sep}`) || rel === "..")
    throw new Error(`path escapes repository: ${path}`);
}

function liveBlob(cwd: string, path: string, options?: ReceiptOptions): string {
  const absolute = resolve(cwd, path);
  const stat = lstatSync(absolute);
  if (!stat.isFile()) throw new Error(`unsupported non-regular file: ${path}`);
  // `-w` stores the approved bytes, allowing the reviewer to inspect a later drift.
  return git(
    cwd,
    ["hash-object", ...(options?.readOnly ? ["--no-filters"] : ["-w"]), "--", path],
    false,
    options?.deadline,
  );
}

/**
 * Resolves the base ref the receipt diffs against. With an `origin` remote the target is
 * fetched and `origin/<target>` is used (a failed fetch fails closed). Without any `origin`
 * remote there is no remote truth, so the local `refs/heads/<target>` is used instead, never
 * when the current branch is the target (committed work there would diff as empty).
 */
function resolveBase(options: ReceiptOptions): { ref: string; label: string } {
  const run = (args: string[], nul = false): string =>
    git(options.cwd, args, nul, options.deadline);
  const remotes = run(["remote"]).split("\n");
  if (remotes.includes("origin")) {
    if (!options.readOnly) run(["fetch", "origin", options.target]);
    return { ref: `origin/${options.target}`, label: `origin/${options.target}` };
  }
  const local = `refs/heads/${options.target}`;
  try {
    run(["rev-parse", "--verify", "--quiet", local]);
  } catch {
    throw new Error(
      `no 'origin' remote and no local branch '${options.target}': set branchBase (navori configure branch-base <branch>) or pass --target <branch>`,
    );
  }
  let current = "";
  try {
    current = run(["symbolic-ref", "-q", "--short", "HEAD"]);
  } catch {
    // Detached HEAD: not the target branch.
  }
  if (current === options.target)
    throw new Error(
      `no 'origin' remote and the current branch is the target '${options.target}': switch to a feature branch or pass --target <branch>`,
    );
  return { ref: local, label: options.target };
}

function inspect(options: ReceiptOptions): { targetSha: string; headSha: string; paths: string[] } {
  const run = (args: string[], nul = false): string =>
    git(options.cwd, args, nul, options.deadline);
  const base = resolveBase(options);
  const targetSha = run(["rev-parse", base.ref]);
  const headSha = run(["rev-parse", "HEAD"]);
  if (run(["rev-list", "--count", `HEAD..${base.ref}`]) !== "0")
    throw new Error(`branch is behind ${base.label}`);
  // `--name-only` intentionally cannot express modes. Inspect the raw records first so
  // V1 never signs metadata it cannot later verify (including gitlinks/submodules).
  const raw = pathsFromNul(
    run(["diff", "--raw", "--no-renames", "-z", "--no-ext-diff", "--no-textconv", base.ref], true),
  );
  raw.push(
    ...pathsFromNul(run(["diff", "--cached", "--raw", "--no-renames", "-z", base.ref], true)),
  );
  for (const record of raw) {
    if (!record.startsWith(":")) continue;
    const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])/.exec(record);
    if (!match) throw new Error("unreadable git diff record");
    const [, oldMode, newMode, oldBlob, newBlob, status] = match;
    const regular = (mode: string): boolean => mode === "100644" || mode === "100755";
    if (!regular(oldMode!) && !(status === "A" && oldMode === "000000"))
      throw new Error("unsupported non-regular git entry");
    if (!regular(newMode!) && !(status === "D" && newMode === "000000"))
      throw new Error("unsupported non-regular git entry");
    // An all-zero blob means "unhashed" (the working tree entry was never hashed against the
    // target), not "identical content" — `git diff --raw` reports it that way for a new file
    // that also has unstaged changes. Only real, equal hashes indicate a mode-only change.
    const unhashed = (blob: string): boolean => /^0+$/.test(blob);
    if (oldMode !== newMode && oldBlob === newBlob && !unhashed(newBlob!))
      throw new Error("diff changes file mode only");
  }
  const tracked = pathsFromNul(
    run(
      ["diff", "--name-only", "--no-renames", "-z", "--no-ext-diff", "--no-textconv", base.ref],
      true,
    ),
  );
  const untracked = pathsFromNul(run(["ls-files", "--others", "--exclude-standard", "-z"], true));
  const paths = [...new Set([...tracked, ...untracked])]
    .filter((path) => !isUnderProgressDir(path))
    .sort();
  for (const path of paths) validatePath(options.cwd, path);
  return { targetSha, headSha, paths };
}

function success(
  options: ReceiptOptions,
  state: { targetSha: string; headSha: string },
): ReceiptResult {
  return {
    formatVersion: 1,
    target: options.target,
    targetSha: state.targetSha,
    headSha: state.headSha,
    status: "ok",
    uncovered: [],
    drift: [],
    fresh: true,
    stale: [],
    consumed: false,
    gateKind: "full",
    error: null,
  };
}

function receiptRoot(options: ReceiptOptions): StateRoot {
  const root = resolveStateRoot({ cwd: options.cwd, feature: options.feature, dir: options.dir });
  if (!options.readOnly) ensureStateDirectory(root);
  return root;
}

function receiptPath(root: StateRoot, consumed = false): string {
  return stateArtifactPath(root, consumed ? "receipt.consumed.txt" : "receipt.txt");
}

/** Sign and check share the same current independent approval requirement. */
function requireCurrentReview(root: StateRoot, options: ReceiptOptions): void {
  const recorded = ["ownership", "review"].some((kind) =>
    existsSync(stateArtifactPath(root, `${kind}_${options.feature}.json`)),
  );
  if (!process.env.CODEX_THREAD_ID && !recorded) return;
  const problem = reviewEvidenceWarning(root, options.feature, options);
  if (problem) throw new Error(problem);
}

/** Signs exactly the working-tree content that differs from the remote target. */
export function signReceipt(options: ReceiptOptions): { exitCode: number; result: ReceiptResult } {
  try {
    const root = receiptRoot(options);
    options = { ...options, cwd: root.cwd, dir: root.dir };
    requireCurrentReview(root, options);
    if (options.observer) options.observer.before = sampleIdentity(options.observer);
    if (options.gateRan === "scoped" && options.gateDecision?.gateKind !== "scoped") {
      throw new Error(
        `this cycle needs qualityGate.full (${options.gateDecision?.reason ?? "no-spec-flags"}), but --gate-ran scoped was declared\nWHY:   a scoped receipt cannot stand in for the full gate\nFIX:   run qualityGate.full and sign again with --gate-ran full (or without the spec flags)`,
      );
    }
    const scoped = options.gateRan === "scoped";
    const state = inspect(options);
    const identity = evidenceIdentity(options.cwd, options.gate);
    const signed =
      options.gateRan === "docs"
        ? docsResignHeader(root, options, state, identity)
        : { gate: scoped ? SCOPED_GATE : identity.gate, inputs: identity.inputs };
    const lines = [
      `# navori-receipt v2 feature=${options.feature} base=${state.targetSha} gate=${signed.gate} inputs=${signed.inputs}`,
    ];
    for (const path of state.paths) {
      const absolute = resolve(options.cwd, path);
      try {
        lstatSync(absolute);
        lines.push(`${liveBlob(options.cwd, path)}  ${path}`);
      } catch (cause: unknown) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        lines.push(`deleted  ${path}`);
      }
    }
    const output = `${lines.join("\n")}\n`;
    const destination = receiptPath(root);
    const temporary = stateArtifactPath(root, `receipt.txt.tmp-${process.pid}`);
    writeFileSync(temporary, output, { encoding: "utf8", flag: "wx" });
    stateArtifactPath(root, `receipt.txt.tmp-${process.pid}`);
    stateArtifactPath(root, "receipt.txt");
    renameSync(temporary, destination);
    if (options.observer) {
      options.observer.after = sampleIdentity(options.observer);
      options.observer.receipt = sha256(output);
      if (options.gate !== "") options.observer.gate = identity.gate;
      options.observer.inputs = identity.inputs;
    }
    const result = success(options, state);
    result.gateKind = scoped ? "scoped" : "full";
    return { exitCode: 0, result };
  } catch (cause: unknown) {
    return {
      exitCode: 1,
      result: empty(options, cause instanceof Error ? cause.message : "receipt failed"),
    };
  }
}

interface ReceiptHeader {
  version: number;
  feature: string;
  base: string | null;
  gate: string | null;
  inputs: string | null;
}

const HEADER_RE = /^# navori-receipt v(\d+) feature=(\S+)(?: base=(\S+) gate=(\S+) inputs=(\S+))?$/;

function parseHeader(line: string): ReceiptHeader {
  const match = HEADER_RE.exec(line);
  if (!match) throw new Error("receipt is malformed");
  return {
    version: Number(match[1]),
    feature: match[2]!,
    base: match[3] ?? null,
    gate: match[4] ?? null,
    inputs: match[5] ?? null,
  };
}

function readReceiptFile(path: string): {
  header: ReceiptHeader;
  records: Map<string, string>;
  hash: string;
} {
  if (!existsSync(path)) throw new Error("receipt is absent");
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  const header = parseHeader(lines[0] ?? "");
  const records = new Map<string, string>();
  for (const line of lines.slice(1)) {
    if (!line || line.startsWith("#")) continue;
    const match = /^(deleted|[0-9a-f]{40})  (.+)$/.exec(line);
    if (!match) throw new Error("receipt is malformed");
    records.set(match[2]!, match[1]!);
  }
  return { header, records, hash: sha256(text) };
}

/** Picks `receipt.txt`, or `receipt.consumed.txt` when `includeConsumed` is set
 * and the main receipt is absent. Without the flag, a consumed receipt reads as
 * absent — it can never re-authorize a later commit (R6). */
function resolveReceiptSource(
  root: StateRoot,
  options: ReceiptOptions,
): { path: string; consumed: boolean } {
  const main = receiptPath(root);
  if (existsSync(main)) return { path: main, consumed: false };
  const archived = receiptPath(root, true);
  if (options.includeConsumed && existsSync(archived)) return { path: archived, consumed: true };
  throw new Error("receipt is absent");
}

/** Paths of the publish set not in the receipt, and recorded paths whose bytes or presence changed. */
function receiptDelta(
  options: ReceiptOptions,
  paths: readonly string[],
  records: ReadonlyMap<string, string>,
): Pick<ReceiptResult, "uncovered" | "drift"> {
  const uncovered = paths.filter((path) => !records.has(path));
  const drift: ReceiptResult["drift"] = [];
  for (const [path, blob] of records) {
    validatePath(options.cwd, path);
    const present = existsSync(resolve(options.cwd, path));
    if (blob === "deleted") {
      if (present) drift.push({ path, blob: null, kind: "reappeared" });
    } else if (!present) drift.push({ path, blob, kind: "missing" });
    else if (liveBlob(options.cwd, path, options) !== blob)
      drift.push({ path, blob, kind: "changed" });
  }
  return { uncovered, drift };
}

/** Case-sensitive: only Markdown under `specs/` or `docs/` (spec 0054 R21, D6). */
const DOCS_RESIGN_PATH = /^(specs|docs)\/.*\.md$/; // git paths never hold NUL; newlines are rejected by `validatePath`

/**
 * Spec 0054 R21 / D6, challenge B1: `--gate-ran docs` keeps the signed `gate=`/
 * `inputs=` of a current `full` receipt, so it is only allowed when EVERY change
 * since that receipt is Markdown under `specs/` or `docs/`. The CLI computes the
 * union of `uncovered` (new files), every `drift` kind (changed, missing,
 * reappeared) and deletions; one path outside the set, a symlink or a non-regular
 * file refuses. Returns the header values to preserve; throws a refusal otherwise.
 */
function docsResignHeader(
  root: StateRoot,
  options: ReceiptOptions,
  state: { targetSha: string; paths: string[] },
  identity: EvidenceIdentity,
): { gate: string; inputs: string } {
  const refuse = (why: string): never => {
    throw new Error(
      `--gate-ran docs refused: ${why}\nWHY:   the docs re-sign only covers Markdown under specs/ or docs/ on top of a current full-gate receipt\nFIX:   run qualityGate.full and sign again with --gate-ran full`,
    );
  };
  if (!options.docsGate?.trim()) refuse("qualityGate.docs is not declared in navori.config.json");
  const path = receiptPath(root);
  if (!existsSync(path)) refuse("there is no receipt to extend");
  const { header, records } = readReceiptFile(path);
  if (header.feature !== options.feature) refuse("the receipt belongs to another feature");
  if (header.version !== 2 || header.gate === null || header.inputs === null)
    refuse("the receipt predates v2");
  if (header.gate === SCOPED_GATE || header.gate !== identity.gate)
    refuse("the receipt was not signed after the current full gate");
  if (header.inputs !== identity.inputs) refuse("the lockfiles changed since the receipt");
  if (header.base !== state.targetSha) refuse("the base moved since the receipt");
  const { uncovered, drift } = receiptDelta(options, state.paths, records);
  for (const changed of new Set([...uncovered, ...drift.map((d) => d.path)])) {
    if (!DOCS_RESIGN_PATH.test(changed) || changed.split("/").includes(".."))
      refuse(`${changed} is not Markdown under specs/ or docs/`);
    if (!existsSync(resolve(options.cwd, changed))) continue; // a deleted Markdown file
    if (!lstatSync(resolve(options.cwd, changed)).isFile())
      refuse(`${changed} is not a regular file`);
  }
  return { gate: header.gate!, inputs: header.inputs! };
}

/** Checks coverage and byte drift without mutating the signed receipt. */
export function checkReceipt(options: ReceiptOptions): { exitCode: number; result: ReceiptResult } {
  try {
    const root = receiptRoot(options);
    options = { ...options, cwd: root.cwd, dir: root.dir };
    requireCurrentReview(root, options);
    if (options.observer) options.observer.before = sampleIdentity(options.observer);
    const state = inspect(options);
    const { path, consumed } = resolveReceiptSource(root, options);
    const { header, records, hash } = readReceiptFile(path);
    if (header.feature !== options.feature) {
      throw new Error(`receipt belongs to feature "${header.feature}", not "${options.feature}"`);
    }
    const { uncovered, drift } = receiptDelta(options, state.paths, records);
    const stale: StaleReason[] = [];
    if (header.version !== 2) {
      stale.push("format");
    } else {
      const identity = evidenceIdentity(options.cwd, options.gate);
      if (header.gate !== identity.gate) stale.push("gate");
      if (header.inputs !== identity.inputs) stale.push("inputs");
      if (options.observer) {
        if (options.gate !== "") options.observer.gate = identity.gate;
        options.observer.inputs = identity.inputs;
      }
    }
    if (options.observer) {
      options.observer.after = sampleIdentity(options.observer);
      options.observer.receipt = hash;
    }
    const result = success(options, state);
    result.uncovered = uncovered;
    result.drift = drift;
    result.stale = stale;
    result.fresh = stale.length === 0;
    result.consumed = consumed;
    result.gateKind = header.version !== 2 ? null : header.gate === SCOPED_GATE ? "scoped" : "full";
    if (uncovered.length || drift.length) result.status = "findings";
    return { exitCode: result.status === "ok" ? 0 : 2, result };
  } catch (cause: unknown) {
    return {
      exitCode: 1,
      result: empty(options, cause instanceof Error ? cause.message : "receipt failed"),
    };
  }
}

/**
 * Pure projection of a finished receipt command into its closed
 * `receipt-outcome` payload. Only metadata: counts, enums, hashes and the
 * `featureKey`. An `error` result keeps nothing but `action` and `featureKey`
 * (never the message). `alg`/`fp` appear only when the identity sandwich was
 * stable; an unset `gate` means no gate is configured.
 */
export function receiptOutcomeOf(
  featureKey: string,
  action: ReceiptAction,
  result: ReceiptResult,
  observer?: ReceiptObserver,
): { verdict: ReceiptOutcome["verdict"]; payload: Omit<ReceiptOutcome, "name" | "verdict"> } {
  const base = { schemaVersion: 1 as const, featureKey, action };
  if (result.status === "error") return { verdict: "error", payload: base };
  const before = observer?.before;
  const after = observer?.after;
  const identity: NonNullable<ReceiptOutcome["identity"]> =
    before?.ok && after?.ok
      ? before.fingerprint === after.fingerprint && before.head === after.head
        ? "stable"
        : "unstable"
      : "unavailable";
  const payload: Omit<ReceiptOutcome, "name" | "verdict"> = {
    ...base,
    freshness: result.fresh ? "fresh" : "stale",
    ...(result.stale.length ? { stale: result.stale.join(",") as ReceiptOutcome["stale"] } : {}),
    ...(action === "check"
      ? {
          consumed: result.consumed ? (1 as const) : (0 as const),
          uncovered: result.uncovered.length,
          drift: result.drift.length,
        }
      : {}),
    ...(result.targetSha ? { base: result.targetSha } : {}),
    ...(result.headSha ? { head: result.headSha } : {}),
    ...(observer?.gate ? { gate: observer.gate } : {}),
    ...(observer?.inputs ? { inputs: observer.inputs } : {}),
    ...(observer?.receipt ? { receipt: observer.receipt } : {}),
    identity,
    ...(identity === "stable" && after?.ok ? { alg: after.alg, fp: after.fingerprint } : {}),
  };
  return { verdict: result.status, payload };
}

/** Records the `receipt-outcome` of a finished command. Never throws and never prints. */
export function emitReceiptOutcome(
  options: Pick<ReceiptOptions, "cwd" | "feature" | "observer">,
  action: ReceiptAction,
  result: ReceiptResult,
): void {
  try {
    const { verdict, payload } = receiptOutcomeOf(
      outcomeFeatureKey(options.cwd, options.feature),
      action,
      result,
      options.observer,
    );
    appendCliEvent(options.cwd, { name: "receipt-outcome", verdict }, payload as OutcomePayload);
  } catch {
    // Observation must never change what the command does.
  }
}

export function formatReceipt(result: ReceiptResult): string {
  if (result.status === "error") return `ERROR: ${result.error ?? "receipt failed"}`;
  const findings = [
    ...result.uncovered.map((path) => `UNCOVERED: ${path}`),
    ...result.drift.map(
      ({ path, kind, blob }) =>
        `DRIFT: ${path} (${kind})${blob ? `\ngit diff ${blob} ${path}` : ""}`,
    ),
    ...(result.fresh ? [] : [`STALE: ${result.stale.join(", ")}`]),
  ];
  return findings.length ? findings.join("\n") : "OK";
}
