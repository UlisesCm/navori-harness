/**
 * `navori-content/v1` — read-only identity of the content under review (spec
 * 0042 R16, D5).
 *
 * The fingerprint is a sha256 over the WORKING tree only: every tracked or
 * untracked-not-ignored regular file as `<mode> <blob>\t<path>\0`, ordered by
 * the bytes of the path, behind the `navori-content/v1\n` header. Blobs come
 * from `git hash-object --no-filters` WITHOUT `-w`, so nothing is written to
 * the object store or the index, and no repo-configured filter or fsmonitor
 * runs. Symlinks hash their target text and are never followed; gitlinks and
 * directories are skipped. Session/handoff state directories are excluded so a
 * stamp or sidecar never changes the identity it records.
 *
 * Staging is deliberately NOT part of the hash (staging is a no-content
 * change): `indexDiverges` reports it next to the fingerprint. `base` and
 * `head` are provenance, also outside the hash.
 *
 * Failures are values (`ok: false`), never exceptions: an identity that cannot
 * be computed completely is `unavailable`, never a partial hash. The budget
 * (summed `lstat` sizes) and the wall-clock timeout bound the cost of a pass.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { PROGRESS_DIRS } from "./progress-dirs.ts";

export const CONTENT_ALG = "navori-content/v1";
/** Default ceiling on the summed size of hashed files (256 MiB). */
export const CONTENT_MAX_BYTES = 256 * 1024 * 1024;
/** Default wall-clock budget for one identity pass. */
export const CONTENT_TIMEOUT_MS = 30_000;

export type ContentIdentityFailure =
  | "not-a-checkout"
  | "unsafe-path"
  | "unmerged-index"
  | "git-failed"
  | "too-large"
  | "timeout";

export type ContentIdentity =
  | {
      ok: true;
      alg: typeof CONTENT_ALG;
      fingerprint: string;
      /** `origin/<target>` as known locally (no fetch), or `null`. */
      base: string | null;
      head: string;
      /** Staged blobs differ from the working tree. Informational, outside the hash. */
      indexDiverges: boolean;
    }
  | { ok: false; reason: ContentIdentityFailure };

export interface ContentIdentityOptions {
  /** Target branch whose local `origin/<target>` ref is recorded as `base`. */
  target?: string;
  maxBytes?: number;
  timeoutMs?: number;
}

/** State and sibling-worktree paths never part of the identity (match the receipt's exclusions). */
const EXCLUDES: readonly string[] = [
  ...PROGRESS_DIRS.map((dir) => dir.replace(/\/$/, "")),
  ".claude/worktrees",
];
const isExcluded = (path: string): boolean =>
  EXCLUDES.some((dir) => path === dir || path.startsWith(`${dir}/`));
const NULL_SHA = /^0+$/;

class Abort extends Error {
  constructor(readonly reason: ContentIdentityFailure) {
    super(reason);
  }
}

/** Runs one hardened, read-only git call within the remaining time budget. */
function run(
  cwd: string,
  args: string[],
  deadline: number,
  input?: string,
  allowFailure = false,
): string | undefined {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Abort("timeout");
  const result = spawnSync(
    "git",
    ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args],
    {
      cwd,
      encoding: "utf8",
      input,
      timeout: remaining,
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    },
  );
  if (result.error) {
    throw new Abort(
      (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? "timeout" : "git-failed",
    );
  }
  if (result.status !== 0) {
    if (allowFailure) return undefined;
    throw new Abort("git-failed");
  }
  return result.stdout;
}

interface WorkingEntry {
  mode: string;
  blob: string;
}

/** Computes the `navori-content/v1` identity of the checkout at `cwd`. Never throws. */
export function contentIdentity(
  cwd: string,
  options: ContentIdentityOptions = {},
): ContentIdentity {
  const deadline = Date.now() + (options.timeoutMs ?? CONTENT_TIMEOUT_MS);
  const maxBytes = options.maxBytes ?? CONTENT_MAX_BYTES;
  try {
    if (
      run(cwd, ["rev-parse", "--is-inside-work-tree"], deadline, undefined, true)?.trim() !== "true"
    )
      return { ok: false, reason: "not-a-checkout" };
    if (run(cwd, ["ls-files", "-u", "-z"], deadline) !== "")
      return { ok: false, reason: "unmerged-index" };
    const head = run(
      cwd,
      ["rev-parse", "--verify", "-q", "HEAD"],
      deadline,
      undefined,
      true,
    )?.trim();
    if (!head) return { ok: false, reason: "git-failed" };
    const base = options.target
      ? (run(
          cwd,
          ["rev-parse", "--verify", "-q", `origin/${options.target}`],
          deadline,
          undefined,
          true,
        )?.trim() ?? null)
      : null;

    const listed = run(
      cwd,
      [
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--deduplicate",
        "--",
        ".",
        ...EXCLUDES.map((path) => `:(exclude,literal)${path}`),
      ],
      deadline,
    );
    if (listed === undefined) return { ok: false, reason: "git-failed" };

    const files: Array<{ path: string; mode: string }> = [];
    const links: Array<{ path: string; target: string }> = [];
    let bytes = 0;
    for (const path of listed.split("\0").filter(Boolean)) {
      if (/[\r\n�]/.test(path)) return { ok: false, reason: "unsafe-path" };
      let stat;
      try {
        stat = lstatSync(join(cwd, path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // tracked, deleted from the working tree
        return { ok: false, reason: "git-failed" };
      }
      if (stat.isSymbolicLink()) links.push({ path, target: readlinkSync(join(cwd, path)) });
      else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > maxBytes) return { ok: false, reason: "too-large" };
        files.push({ path, mode: stat.mode & 0o111 ? "100755" : "100644" });
      }
    }

    const working = new Map<string, WorkingEntry>();
    if (files.length > 0) {
      // `./` keeps a leading `"` from being read as a quoted path by --stdin-paths.
      const shas = run(
        cwd,
        ["hash-object", "--no-filters", "--stdin-paths"],
        deadline,
        `${files.map((f) => `./${f.path}`).join("\n")}\n`,
      )
        ?.split("\n")
        .filter(Boolean);
      if (!shas || shas.length !== files.length) return { ok: false, reason: "git-failed" };
      files.forEach((f, i) => working.set(f.path, { mode: f.mode, blob: shas[i] as string }));
    }
    for (const link of links) {
      const blob = run(
        cwd,
        ["hash-object", "--no-filters", "--stdin"],
        deadline,
        link.target,
      )?.trim();
      if (!blob) return { ok: false, reason: "git-failed" };
      working.set(link.path, { mode: "120000", blob });
    }

    const body = [...working.entries()]
      .map(([path, entry]) => ({
        path,
        bytes: Buffer.from(path),
        line: `${entry.mode} ${entry.blob}\t${path}\0`,
      }))
      .sort((a, b) => Buffer.compare(a.bytes, b.bytes))
      .map((entry) => entry.line)
      .join("");
    const fingerprint = createHash("sha256").update(`${CONTENT_ALG}\n${body}`).digest("hex");

    const staged = run(
      cwd,
      ["diff-index", "--cached", "--raw", "-z", "--no-renames", head],
      deadline,
    );
    if (staged === undefined) return { ok: false, reason: "git-failed" };
    return {
      ok: true,
      alg: CONTENT_ALG,
      fingerprint,
      base,
      head,
      indexDiverges: diverges(staged, working),
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Abort ? error.reason : "git-failed" };
  }
}

/** Parses `diff-index --raw -z` (`:om nm osha nsha S\0path\0`) and compares staged blobs to the working tree. */
function diverges(raw: string, working: Map<string, WorkingEntry>): boolean {
  const parts = raw.split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = (parts[i] ?? "").split(" ");
    const stagedBlob = meta[3] ?? "";
    const path = parts[i + 1] ?? "";
    if (meta[0] === ":160000" || meta[1] === "160000" || isExcluded(path)) continue; // gitlinks and state dirs are not hashed
    const live = working.get(path);
    if (NULL_SHA.test(stagedBlob) ? live !== undefined : live?.blob !== stagedBlob) return true;
  }
  return false;
}
