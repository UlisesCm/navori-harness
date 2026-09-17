import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

export type ReceiptStatus = "ok" | "findings" | "error";
export type DriftKind = "changed" | "missing" | "reappeared";
export interface ReceiptResult {
  formatVersion: 1;
  target: string;
  targetSha: string | null;
  headSha: string | null;
  status: ReceiptStatus;
  uncovered: string[];
  drift: Array<{ path: string; blob: string | null; kind: DriftKind }>;
  error: string | null;
}
export interface ReceiptOptions {
  cwd: string;
  feature: string;
  target: string;
  dir: string;
}

const PROGRESS_DIRS = [".claude/progress/", ".codex/progress/", "progress/"];

function empty(options: ReceiptOptions, error: string): ReceiptResult {
  return {
    formatVersion: 1,
    target: options.target,
    targetSha: null,
    headSha: null,
    status: "error",
    uncovered: [],
    drift: [],
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

function isProgress(path: string): boolean {
  return PROGRESS_DIRS.some((prefix) => path.startsWith(prefix));
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
    if (oldMode !== newMode && oldBlob === newBlob) throw new Error("diff changes file mode only");
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
  const paths = [...new Set([...tracked, ...untracked])].filter((path) => !isProgress(path)).sort();
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
    error: null,
  };
}

function receiptPath(options: ReceiptOptions): string {
  return resolve(options.cwd, options.dir, "receipt.txt");
}

/** Signs exactly the working-tree content that differs from the remote target. */
export function signReceipt(options: ReceiptOptions): { exitCode: number; result: ReceiptResult } {
  try {
    const state = inspect(options);
    const lines = [`# navori-receipt v1 feature=${options.feature}`];
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

function readReceipt(options: ReceiptOptions): Map<string, string> {
  const destination = receiptPath(options);
  if (!existsSync(destination)) throw new Error("receipt is absent");
  const records = new Map<string, string>();
  for (const line of readFileSync(destination, "utf8").split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const match = /^(deleted|[0-9a-f]{40})  (.+)$/.exec(line);
    if (!match) throw new Error("receipt is malformed");
    records.set(match[2]!, match[1]!);
  }
  return records;
}

/** Checks coverage and byte drift without mutating the signed receipt. */
export function checkReceipt(options: ReceiptOptions): { exitCode: number; result: ReceiptResult } {
  try {
    const state = inspect(options);
    const records = readReceipt(options);
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
    const result = success(options, state);
    result.uncovered = uncovered;
    result.drift = drift;
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
  ];
  return findings.length ? findings.join("\n") : "OK";
}
