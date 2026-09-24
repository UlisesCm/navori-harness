/**
 * `navori handoff check` (spec 0033 D3, R14-R17, R24) — validates the
 * implementer's handoff before the orchestrator dispatches the next role, or
 * before the scribe edits/commits. One function, two depths: `consumer:
 * "orchestrator"` only needs exists/parse/feature (R14, R15); `consumer:
 * "scribe"` also needs the checkout, the rama and every
 * `markdownRequests[].path` (R16).
 *
 * Exit-code contract (mirrors `receipt`): `ok` -> 0, `findings` -> 2 (a
 * validation failed), `error` -> 1 (git or I/O broke, never a validation
 * outcome — see design.md, Contracts).
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { ImplHandoffSchema, type MarkdownRequest } from "./schema.ts";
import { isUnderProgressDir } from "../primitives/progress-dirs.ts";

export type HandoffConsumer = "orchestrator" | "scribe";
export type HandoffStatus = "ok" | "findings" | "error";
export type FailureCheck = "exists" | "parse" | "feature" | "worktree" | "branch" | "path";
export type WarningCheck = "head" | "legacy-md";

export interface HandoffFinding {
  check: FailureCheck;
  detail: string;
}
export interface HandoffWarning {
  check: WarningCheck;
  detail: string;
}

export interface HandoffCheckResult {
  formatVersion: 1;
  feature: string;
  consumer: HandoffConsumer;
  status: HandoffStatus;
  failures: HandoffFinding[];
  warnings: HandoffWarning[];
  worktree: string | null;
  branch: string | null;
}

export interface HandoffCheckOptions {
  cwd: string;
  dir: string;
  feature: string;
  consumer: HandoffConsumer;
  /** `harness.scribeOwnsMarkdown === false` (R24): validate
   * `impl_<feature>.md` instead of the JSON handoff, tied to the feature
   * only by the file name; R16 (worktree/branch/path) does not apply. */
  legacyMarkdown?: boolean;
}

/** `^[a-z0-9][a-z0-9._-]*$` — the same slug shape a feature/branch name
 * follows elsewhere in the CLI. Rejected before it ever forms a path, so a
 * hostile feature argument (`../../etc`) never reaches `resolve`. */
const FEATURE_SLUG = /^[a-z0-9][a-z0-9._-]*$/;

function empty(feature: string, consumer: HandoffConsumer): HandoffCheckResult {
  return {
    formatVersion: 1,
    feature,
    consumer,
    status: "ok",
    failures: [],
    warnings: [],
    worktree: null,
    branch: null,
  };
}

function git(cwd: string, args: string[]): string | null {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** R16's path rule, applied to one `markdownRequests[].path`. Every branch
 * reports the same `check: "path"` — the detail names which rule failed. */
function validateRequestPath(worktree: string, path: string): string | null {
  if (isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) || path.includes("\\")) {
    return `markdownRequests path "${path}" must be relative to the repo (no absolute path, no drive letter, no backslash)`;
  }
  const normalized = normalize(path);
  if (normalized.split(sep).includes("..")) {
    return `markdownRequests path "${path}" escapes the repo (contains "..")`;
  }
  if (isUnderProgressDir(normalized)) {
    return `markdownRequests path "${path}" is under a session/handoff state directory`;
  }
  if (![".md", ".mdx"].includes(extname(normalized))) {
    return `markdownRequests path "${path}" must end in .md or .mdx`;
  }
  const absolute = resolve(worktree, normalized);
  const parent = dirname(absolute);
  // The parent may not exist yet (a brand-new file) — only resolve it when
  // it does, which is exactly the case a symlink escape needs (R16).
  if (existsSync(parent)) {
    const realParent = realpathOrNull(parent);
    const realWorktree = realpathOrNull(worktree);
    if (realParent === null || realWorktree === null) {
      return `markdownRequests path "${path}" could not be resolved on disk`;
    }
    const rel = relative(realWorktree, realParent);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return `markdownRequests path "${path}" escapes the repo via a symlink`;
    }
  }
  return null;
}

function checkLegacyMarkdown(options: HandoffCheckOptions): HandoffCheckResult {
  const result = empty(options.feature, options.consumer);
  result.warnings.push({
    check: "legacy-md",
    detail:
      "harness.scribeOwnsMarkdown is off; checked impl_<feature>.md instead of the JSON handoff",
  });
  const path = resolve(options.cwd, options.dir, `impl_${options.feature}.md`);
  if (!existsSync(path)) {
    result.failures.push({ check: "exists", detail: `${path} not found` });
  } else {
    const content = readFileSync(path, "utf8");
    if (!content.trim()) {
      result.failures.push({ check: "exists", detail: `${path} is empty` });
    } else if (!/^\*{0,2}status:?\*{0,2}/im.test(content)) {
      result.failures.push({ check: "parse", detail: `${path} has no "Status:" line` });
    }
  }
  result.status = result.failures.length === 0 ? "ok" : "findings";
  return result;
}

/** `checkHandoff({cwd, dir, feature, consumer})` — the single validator both
 * `navori handoff check` and, from prose, the orchestrator/scribe run before
 * dispatching or writing (R14-R17, R24). Never throws: an unexpected error
 * (git absent, I/O failure) is reported as `status: "error"`, not folded
 * into `failures` — validation failures and infrastructure failures are
 * different exit codes (0/2 vs 1, design.md Contracts). */
export function checkHandoff(options: HandoffCheckOptions): HandoffCheckResult {
  try {
    if (!FEATURE_SLUG.test(options.feature)) {
      const result = empty(options.feature, options.consumer);
      result.failures.push({
        check: "feature",
        detail: `"${options.feature}" is not a valid feature slug`,
      });
      result.status = "findings";
      return result;
    }

    if (options.legacyMarkdown) return checkLegacyMarkdown(options);

    const result = empty(options.feature, options.consumer);
    const path = resolve(options.cwd, options.dir, `impl_${options.feature}.json`);
    if (!existsSync(path)) {
      result.failures.push({ check: "exists", detail: `${path} not found` });
      result.status = "findings";
      return result;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (cause: unknown) {
      result.failures.push({
        check: "parse",
        detail: `${path} does not parse as JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
      result.status = "findings";
      return result;
    }

    const parsed = ImplHandoffSchema.safeParse(raw);
    if (!parsed.success) {
      result.failures.push({
        check: "parse",
        detail: parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; "),
      });
      result.status = "findings";
      return result;
    }
    const data = parsed.data;

    if (data.feature !== options.feature) {
      result.failures.push({
        check: "feature",
        detail: `${path} belongs to feature "${data.feature}", not "${options.feature}"`,
      });
    }

    result.worktree = realpathOrNull(data.worktree) ?? data.worktree;
    result.branch = data.branch;

    if (data.head === undefined) {
      result.warnings.push({
        check: "head",
        detail: "impl_<feature>.json has no `head`; the checkout may have moved since the handoff",
      });
    } else {
      const actualHead = git(options.cwd, ["rev-parse", "HEAD"]);
      if (actualHead !== null && actualHead !== data.head) {
        result.warnings.push({
          check: "head",
          detail: `the checkout has moved since the handoff (handoff head ${data.head}, checkout head ${actualHead})`,
        });
      }
    }

    // Only past exists/parse/feature does the scribe's deeper identity check
    // run — a mismatched feature is already fatal, no point resolving git.
    if (options.consumer === "scribe" && result.failures.length === 0) {
      const toplevel = git(options.cwd, ["rev-parse", "--show-toplevel"]);
      const realToplevel = toplevel === null ? null : realpathOrNull(toplevel);
      const realWorktree = realpathOrNull(data.worktree);
      if (realToplevel === null || realWorktree === null || realToplevel !== realWorktree) {
        result.failures.push({
          check: "worktree",
          detail: `--cwd resolves to ${realToplevel ?? toplevel ?? "(unknown)"}, registered worktree is ${data.worktree}`,
        });
      }

      const currentBranch = git(options.cwd, ["branch", "--show-current"]);
      if (currentBranch === null || currentBranch !== data.branch) {
        result.failures.push({
          check: "branch",
          detail: `--cwd is on branch "${currentBranch ?? "(unknown)"}", registered branch is "${data.branch}"`,
        });
      }

      const worktreeForPaths = realWorktree ?? data.worktree;
      const pathIssues = data.markdownRequests
        .map((request: MarkdownRequest) => validateRequestPath(worktreeForPaths, request.path))
        .filter((issue): issue is string => issue !== null);
      for (const detail of pathIssues) result.failures.push({ check: "path", detail });
    }

    result.status = result.failures.length === 0 ? "ok" : "findings";
    return result;
  } catch (cause: unknown) {
    const result = empty(options.feature, options.consumer);
    result.status = "error";
    result.failures.push({
      check: "exists",
      detail: cause instanceof Error ? cause.message : "handoff check failed",
    });
    return result;
  }
}

/** Maps `HandoffCheckResult.status` to the CLI exit code (design.md
 * Contracts): `ok` -> 0, `findings` -> 2, `error` -> 1. */
export function handoffExitCode(result: HandoffCheckResult): number {
  if (result.status === "ok") return 0;
  return result.status === "error" ? 1 : 2;
}
