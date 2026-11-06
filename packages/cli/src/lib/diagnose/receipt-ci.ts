import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { isUnderProgressDir } from "../primitives/progress-dirs.ts";
import { checkReceipt, type ReceiptOptions, type ReceiptResult } from "./receipt.ts";

/** What `qualityGate.ci` declares (see `QualityGateCiSchema`). */
export interface CiGateConfig {
  workflow: string;
  jobs: string[];
  label?: string | undefined;
  untrustedPaths: string[];
  hookPaths: string[];
  hooksCommand: string;
}

export type CiStatus = "ok" | "no-evidence" | "refused" | "error";

export interface CiResult {
  status: CiStatus;
  reason: string;
  runId: number | null;
  runAttempt: number | null;
  headSha: string | null;
  /** The configured jobs with the conclusion found; `null` = missing from the run. */
  jobs: Array<{ name: string; conclusion: string | null }>;
  untrusted: string[];
  hooks: { paths: string[]; ran: boolean; exitCode: number | null };
}

export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Set when the program could not be spawned at all (e.g. `gh` not installed). */
  error?: string;
}

/** The only door to `gh`, `git` and the hooks command: tests inject a fake, so they never touch the network. */
export type Exec = (
  command: "gh" | "git" | "sh",
  args: readonly string[],
  cwd: string,
) => ExecResult;

export interface ReceiptCiDeps {
  exec: Exec;
  check: (options: ReceiptOptions) => { exitCode: number; result: ReceiptResult };
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface ReceiptCiOptions {
  receipt: ReceiptOptions;
  ci: CiGateConfig;
  pr: number;
  /** Maximum time to wait for a pending run; 0 = one-shot. */
  waitMs: number;
  pollMs?: number;
}

/** Default wait for a pending run: the full suite takes ~10 min. */
export const DEFAULT_CI_WAIT_MS = 20 * 60 * 1000;
const DEFAULT_POLL_MS = 30 * 1000;

export const realExec: Exec = (command, args, cwd) => {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error.message } : {}),
  };
};

const realDeps: ReceiptCiDeps = {
  exec: realExec,
  check: checkReceipt,
  now: () => Date.now(),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
};

/** `*` stays inside a path segment, `**` crosses them. */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else out += "[^/]*";
    } else out += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

function matching(paths: readonly string[], globs: readonly string[]): string[] {
  const patterns = globs.map(globToRegExp);
  return paths.filter((path) => patterns.some((pattern) => pattern.test(path)));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/** The parsed `qualityGate` of `navori.config.json` at a git ref; `undefined` when unreadable. */
function qualityGateAt(exec: Exec, cwd: string, ref: string): unknown {
  const shown = exec("git", ["show", `${ref}:navori.config.json`], cwd);
  if (shown.status !== 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(shown.stdout);
    return (parsed as { qualityGate?: unknown } | null)?.qualityGate ?? null;
  } catch {
    return undefined;
  }
}

interface WorkflowRun {
  id: number;
  run_attempt: number;
  status: string;
  conclusion: string | null;
  head_sha: string;
}

interface JobRecord {
  name: string;
  conclusion: string | null;
}

/**
 * Conclusion of a required job; `null` = missing. GitHub reports a matrix whose `if` skipped it
 * once, unexpanded (`test`, not `test (1)`), so a missing `<base> (…)` takes `skipped` from a
 * skipped `<base>` job. Any other conclusion of `<base>` leaves it missing.
 */
function conclusionOf(found: readonly JobRecord[], name: string): string | null {
  const job = found.find((record) => record.name === name);
  if (job) return job.conclusion;
  const base = /^(.+) \(.*\)$/.exec(name)?.[1];
  const matrix = found.find((record) => record.name === base);
  return matrix?.conclusion === "skipped" ? "skipped" : null;
}

/** A run that skipped some required job and failed none ran no tests: it is no verdict either way. */
function ranNoTests(jobs: CiResult["jobs"]): boolean {
  return (
    jobs.some((job) => job.conclusion === "skipped") &&
    jobs.every((job) => job.conclusion === "success" || job.conclusion === "skipped")
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Verifies that the full-suite CI run on the exact HEAD SHA is green, so the publisher may mark
 * the PR ready (#1492). Every check must hold or there is no evidence: the caller keeps the PR
 * draft on `no-evidence` and runs the local gate on `refused`. Never writes anything.
 */
export async function verifyReceiptCi(
  options: ReceiptCiOptions,
  overrides: Partial<ReceiptCiDeps> = {},
): Promise<{ exitCode: number; result: CiResult }> {
  const deps = { ...realDeps, ...overrides };
  const { exec } = deps;
  const { ci, pr } = options;
  const cwd = options.receipt.cwd;
  const result: CiResult = {
    status: "no-evidence",
    reason: "",
    runId: null,
    runAttempt: null,
    headSha: null,
    jobs: [],
    untrusted: [],
    hooks: { paths: [], ran: false, exitCode: null },
  };
  const finish = (status: CiStatus, reason: string): { exitCode: number; result: CiResult } => {
    result.status = status;
    result.reason = reason;
    return { exitCode: status === "ok" ? 0 : status === "error" ? 1 : 2, result };
  };
  const git = (args: string[]): ExecResult => exec("git", args, cwd);
  const ghUnavailable = (run: ExecResult): string =>
    `gh unavailable or failed: ${(run.error ?? run.stderr.trim()) || `exit ${run.status}`}`;

  const head = git(["rev-parse", "HEAD"]);
  if (head.status !== 0) return finish("error", "git rev-parse HEAD failed");
  const headSha = head.stdout.trim();
  result.headSha = headSha;

  const dirty = git(["status", "--porcelain", "-z"])
    .stdout.split("\0")
    .filter((entry) => entry !== "" && !isUnderProgressDir(entry.slice(3)));
  if (dirty.length > 0) return finish("no-evidence", "working tree is not clean");

  const view = exec(
    "gh",
    ["pr", "view", String(pr), "--json", "headRefOid,isCrossRepository,baseRefName"],
    cwd,
  );
  if (view.status !== 0) return finish("no-evidence", ghUnavailable(view));
  const pull = parseJson(view.stdout) as
    | { headRefOid?: string; isCrossRepository?: boolean; baseRefName?: string }
    | undefined;
  if (!pull) return finish("no-evidence", "gh pr view returned unreadable JSON");
  if (pull.isCrossRepository !== false)
    return finish("refused", "PR comes from a fork: CI evidence of a fork is not trusted");
  if (pull.headRefOid !== headSha)
    return finish(
      "no-evidence",
      `PR head ${pull.headRefOid ?? "?"} is not local HEAD ${headSha}: push first`,
    );
  if (pull.baseRefName !== options.receipt.target)
    return finish(
      "no-evidence",
      `PR targets ${pull.baseRefName ?? "?"}, not ${options.receipt.target}`,
    );

  const receipt = deps.check({ ...options.receipt, includeConsumed: true });
  if (receipt.exitCode === 1) return finish("no-evidence", `receipt: ${receipt.result.error}`);
  if (receipt.result.uncovered.length > 0 || receipt.result.drift.length > 0)
    return finish("no-evidence", "receipt does not match HEAD (uncovered or drifted files)");
  if (receipt.result.gateKind !== "ci")
    return finish("no-evidence", "receipt was not signed with --gate-ran ci");
  if (receipt.result.stale.some((reason) => reason !== "gate"))
    return finish("no-evidence", `receipt is stale: ${receipt.result.stale.join(", ")}`);

  // A stale local ref would let an old base pass the ancestor and diff checks.
  const fetched = git(["fetch", "--quiet", "origin", options.receipt.target]);
  if (fetched.status !== 0)
    return finish("no-evidence", `cannot fetch origin/${options.receipt.target}`);
  const base = `origin/${options.receipt.target}`;
  const ancestor = git(["merge-base", "--is-ancestor", base, "HEAD"]);
  if (ancestor.status === 1)
    return finish("no-evidence", `${base} is not an ancestor of HEAD: update the branch`);
  if (ancestor.status !== 0) return finish("no-evidence", `cannot compare with ${base}`);

  const changed = git(["diff", "--name-only", "--no-renames", "-z", base, "HEAD"]);
  if (changed.status !== 0) return finish("error", "git diff failed");
  const paths = changed.stdout.split("\0").filter(Boolean);
  result.untrusted = matching(paths, ci.untrustedPaths);
  const before = canonical(qualityGateAt(exec, cwd, base));
  if (before === "undefined" || before !== canonical(qualityGateAt(exec, cwd, "HEAD")))
    result.untrusted.push("navori.config.json (qualityGate changed or unreadable)");
  if (result.untrusted.length > 0)
    return finish(
      "refused",
      "the diff touches paths CI evidence cannot vouch for: run the local full gate",
    );

  result.hooks.paths = matching(paths, ci.hookPaths);
  if (result.hooks.paths.length > 0) {
    const hooks = exec("sh", ["-c", ci.hooksCommand], cwd);
    result.hooks.ran = true;
    result.hooks.exitCode = hooks.status;
    if (hooks.status !== 0)
      return finish(
        "refused",
        `shell hooks changed and the local hooks command failed (exit ${hooks.status ?? "none"})`,
      );
  }

  /** Required jobs of one run attempt, cached across polls; a string is the `gh` failure. */
  const judged = new Map<string, CiResult["jobs"]>();
  const jobsOf = (run: WorkflowRun): CiResult["jobs"] | string => {
    const key = `${run.id}/${run.run_attempt}`;
    const cached = judged.get(key);
    if (cached) return cached;
    const listed = exec(
      "gh",
      [
        "api",
        `repos/{owner}/{repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
      ],
      cwd,
    );
    if (listed.status !== 0) return ghUnavailable(listed);
    const found = (parseJson(listed.stdout) as { jobs?: JobRecord[] } | undefined)?.jobs ?? [];
    const jobs = ci.jobs.map((name) => ({
      name,
      conclusion: conclusionOf(found, name),
    }));
    judged.set(key, jobs);
    return jobs;
  };

  const deadline = deps.now() + options.waitMs;
  const endpoint = `repos/{owner}/{repo}/actions/workflows/${basename(ci.workflow)}/runs?head_sha=${headSha}&event=pull_request&per_page=100`;
  for (;;) {
    const listed = exec("gh", ["api", endpoint], cwd);
    if (listed.status !== 0) return finish("no-evidence", ghUnavailable(listed));
    const runs = (
      (parseJson(listed.stdout) as { workflow_runs?: WorkflowRun[] } | undefined)?.workflow_runs ??
      []
    )
      .filter((run) => run.head_sha === headSha)
      .sort((a, b) => b.id - a.id || b.run_attempt - a.run_attempt)
      // Only the highest attempt of each run counts: a superseded green attempt is no evidence.
      .filter((run, index, sorted) => index === 0 || sorted[index - 1]!.id !== run.id);

    // A later run on the same SHA may skip the tests (a non-`full` label, #1564). A run whose
    // required jobs all succeeded or were skipped, with at least one skipped, ran no tests and
    // is passed over. The newest of the rest decides: red or cancelled is no evidence even
    // over an older green run, and a pending one is awaited because it may still run the tests.
    let decisive: WorkflowRun | undefined;
    for (const run of runs) {
      if (run.status === "completed" && run.conclusion !== "cancelled") {
        const jobs = jobsOf(run);
        if (typeof jobs === "string") return finish("no-evidence", jobs);
        if (ranNoTests(jobs)) continue;
      }
      decisive = run;
      break;
    }

    // Every run skipped the tests: the newest one gives the reason.
    const run = decisive ?? runs[0];
    if (run?.status === "completed") {
      result.runId = run.id;
      result.runAttempt = run.run_attempt;
      if (run.conclusion === "cancelled")
        return finish("no-evidence", "the CI run was cancelled or superseded");
      const jobs = jobsOf(run);
      if (typeof jobs === "string") return finish("no-evidence", jobs);
      result.jobs = jobs;
      const bad = jobs.filter((job) => job.conclusion !== "success");
      if (bad.length > 0)
        return finish(
          "no-evidence",
          `required jobs not green: ${bad.map((job) => `${job.name}=${job.conclusion ?? "missing"}`).join(", ")}`,
        );
      return finish("ok", `CI run ${run.id} attempt ${run.run_attempt} is green on ${headSha}`);
    }
    if (deps.now() >= deadline)
      return finish(
        "no-evidence",
        run ? "the CI run is still pending past the deadline" : "no CI run found for this SHA",
      );
    await deps.sleep(options.pollMs ?? DEFAULT_POLL_MS);
  }
}

/** One human line per outcome, for the non-JSON output. */
export function formatCi(result: CiResult): string {
  const list = result.untrusted.length
    ? `\n${result.untrusted.map((p) => `UNTRUSTED: ${p}`).join("\n")}`
    : "";
  return `${result.status}: ${result.reason}${list}`;
}
