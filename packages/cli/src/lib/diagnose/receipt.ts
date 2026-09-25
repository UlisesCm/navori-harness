import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { LOCKFILES } from "./detect.ts";
import { isUnderProgressDir } from "../primitives/progress-dirs.ts";

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
}

/** The gate/inputs half of R5's "evidence identity" (base+comando+inputs). The
 * tree half is already covered by the existing per-file blob lines in the
 * receipt body; this is the ONLY place the other two are computed, so `sign`
 * and `check` can never diverge on what counts as "the same evidence". */
export interface EvidenceIdentity {
  gate: string;
  inputs: string;
}

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
    error,
  };
}

function git(cwd: string, args: string[], nul = false): string {
  const result = spawnSync(
    "git",
    ["-c", "core.fsmonitor=false", "-c", "core.quotepath=false", ...args],
    { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, encoding: "buffer" },
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

function liveBlob(cwd: string, path: string): string {
  const absolute = resolve(cwd, path);
  const stat = lstatSync(absolute);
  if (!stat.isFile()) throw new Error(`unsupported non-regular file: ${path}`);
  // `-w` stores the approved bytes, allowing the reviewer to inspect a later drift.
  return git(cwd, ["hash-object", "-w", "--", path]);
}

function inspect(options: ReceiptOptions): { targetSha: string; headSha: string; paths: string[] } {
  git(options.cwd, ["fetch", "origin", options.target]);
  const targetSha = git(options.cwd, ["rev-parse", `origin/${options.target}`]);
  const headSha = git(options.cwd, ["rev-parse", "HEAD"]);
  if (git(options.cwd, ["rev-list", "--count", `HEAD..origin/${options.target}`]) !== "0")
    throw new Error(`branch is behind origin/${options.target}`);
  // `--name-only` intentionally cannot express modes. Inspect the raw records first so
  // V1 never signs metadata it cannot later verify (including gitlinks/submodules).
  const raw = pathsFromNul(
    git(
      options.cwd,
      [
        "diff",
        "--raw",
        "--no-renames",
        "-z",
        "--no-ext-diff",
        "--no-textconv",
        `origin/${options.target}`,
      ],
      true,
    ),
  );
  raw.push(
    ...pathsFromNul(
      git(
        options.cwd,
        ["diff", "--cached", "--raw", "--no-renames", "-z", `origin/${options.target}`],
        true,
      ),
    ),
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
    git(
      options.cwd,
      [
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        "--no-ext-diff",
        "--no-textconv",
        `origin/${options.target}`,
      ],
      true,
    ),
  );
  const untracked = pathsFromNul(
    git(options.cwd, ["ls-files", "--others", "--exclude-standard", "-z"], true),
  );
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
    error: null,
  };
}

function receiptPath(options: ReceiptOptions, consumed = false): string {
  return resolve(options.cwd, options.dir, consumed ? "receipt.consumed.txt" : "receipt.txt");
}

/** Signs exactly the working-tree content that differs from the remote target. */
export function signReceipt(options: ReceiptOptions): { exitCode: number; result: ReceiptResult } {
  try {
    const state = inspect(options);
    const identity = evidenceIdentity(options.cwd, options.gate);
    const lines = [
      `# navori-receipt v2 feature=${options.feature} base=${state.targetSha} gate=${identity.gate} inputs=${identity.inputs}`,
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
    const destination = receiptPath(options);
    mkdirSync(resolve(options.cwd, options.dir), { recursive: true });
    const temporary = `${destination}.tmp-${process.pid}`;
    writeFileSync(temporary, output, "utf8");
    renameSync(temporary, destination);
    return { exitCode: 0, result: success(options, state) };
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

function readReceiptFile(path: string): { header: ReceiptHeader; records: Map<string, string> } {
  if (!existsSync(path)) throw new Error("receipt is absent");
  const lines = readFileSync(path, "utf8").split("\n");
  const header = parseHeader(lines[0] ?? "");
  const records = new Map<string, string>();
  for (const line of lines.slice(1)) {
    if (!line || line.startsWith("#")) continue;
    const match = /^(deleted|[0-9a-f]{40})  (.+)$/.exec(line);
    if (!match) throw new Error("receipt is malformed");
    records.set(match[2]!, match[1]!);
  }
  return { header, records };
}

/** Picks `receipt.txt`, or `receipt.consumed.txt` when `includeConsumed` is set
 * and the main receipt is absent. Without the flag, a consumed receipt reads as
 * absent — it can never re-authorize a later commit (R6). */
function resolveReceiptSource(options: ReceiptOptions): { path: string; consumed: boolean } {
  const main = receiptPath(options);
  if (existsSync(main)) return { path: main, consumed: false };
  const archived = receiptPath(options, true);
  if (options.includeConsumed && existsSync(archived)) return { path: archived, consumed: true };
  throw new Error("receipt is absent");
}

/** Checks coverage and byte drift without mutating the signed receipt. */
export function checkReceipt(options: ReceiptOptions): { exitCode: number; result: ReceiptResult } {
  try {
    const state = inspect(options);
    const { path, consumed } = resolveReceiptSource(options);
    const { header, records } = readReceiptFile(path);
    const uncovered = state.paths.filter((path) => !records.has(path));
    const drift: ReceiptResult["drift"] = [];
    for (const [path, blob] of records) {
      validatePath(options.cwd, path);
      const present = existsSync(resolve(options.cwd, path));
      if (blob === "deleted") {
        if (present) drift.push({ path, blob: null, kind: "reappeared" });
      } else if (!present) drift.push({ path, blob, kind: "missing" });
      else if (liveBlob(options.cwd, path) !== blob) drift.push({ path, blob, kind: "changed" });
    }
    const stale: StaleReason[] = [];
    if (header.version !== 2) {
      stale.push("format");
    } else {
      const identity = evidenceIdentity(options.cwd, options.gate);
      if (header.gate !== identity.gate) stale.push("gate");
      if (header.inputs !== identity.inputs) stale.push("inputs");
    }
    const result = success(options, state);
    result.uncovered = uncovered;
    result.drift = drift;
    result.stale = stale;
    result.fresh = stale.length === 0;
    result.consumed = consumed;
    if (uncovered.length || drift.length) result.status = "findings";
    return { exitCode: result.status === "ok" ? 0 : 2, result };
  } catch (cause: unknown) {
    return {
      exitCode: 1,
      result: empty(options, cause instanceof Error ? cause.message : "receipt failed"),
    };
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
