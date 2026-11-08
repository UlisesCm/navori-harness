/**
 * Slice state of the master plan v2 (spec 0063), derived on every read from
 * git marks and the acceptance log. Read-only: nothing here writes.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readConfig } from "../config/config.ts";
import { type Plan, type PlanAcceptance, parsePlan } from "./plan.ts";

export type SliceState = "pendiente" | "en curso" | "integrado" | "aceptado";

export interface SliceStatus {
  id: string;
  outcome: string;
  spec: string;
  state: SliceState;
  /** Reached the target branch but not the acceptance branch. */
  noEnv: boolean;
  /** Open tasks from rejections since the last acceptance. */
  notes: string[];
  evidence?: string;
}

export interface PlanState {
  acceptance: PlanAcceptance;
  slices: SliceStatus[];
  /** Slices that count against the WIP limit. */
  counted: string[];
  decisions: { id: string; text: string; approved: boolean }[];
  warnings: string[];
}

export class PlanStateError extends Error {}

export const LOG_BRANCH = "navori/acceptance";
export const LOG_FILE = "acceptance.jsonl";

export const LogEntrySchema = z.object({
  id: z.string().regex(/^[SD]\d+$/),
  verdict: z.enum(["accepted", "rejected"]),
  at: z.string(),
  env: z.string(),
  commit: z.string(),
  by: z.literal("user"),
  evidence: z.string().optional(),
  notes: z.array(z.string()).optional(),
});
export type LogEntry = z.infer<typeof LogEntrySchema>;

const planFile = (specsDir: string): string => join(specsDir, "_plan", "PLAN.md");

export function planPath(cwd: string): string {
  const configFile = join(cwd, "navori.config.json");
  const specsDir = existsSync(configFile)
    ? (readConfig(configFile).sdd?.specsDir ?? "specs")
    : "specs";
  return join(cwd, planFile(specsDir));
}

/**
 * PLAN.md as committed at `ref`, `null` when the file is absent there. The path
 * comes from the `navori.config.json` at `ref` too: the working tree's config
 * is as PR-controlled as its PLAN.md. `ref` was already resolved by `remoteRef`,
 * so a failed `git show` means the path is absent there.
 */
export function readPlanAt(cwd: string, ref: string): Plan | null {
  let specsDir = "specs";
  const config = git(cwd, ["show", `${ref}:navori.config.json`]);
  if (config !== null) {
    try {
      const dir = (JSON.parse(config) as { sdd?: { specsDir?: unknown } }).sdd?.specsDir;
      if (typeof dir === "string" && dir !== "") specsDir = dir;
    } catch {
      throw new PlanStateError(`navori.config.json de ${ref} no es JSON válido`);
    }
  }
  const text = git(cwd, ["show", `${ref}:${planFile(specsDir).split("\\").join("/")}`]);
  return text === null ? null : parsePlan(text);
}

export function readPlan(cwd: string): Plan {
  return parsePlan(readFileSync(planPath(cwd), "utf8"));
}

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Runs git in `cwd` without the repo-redirecting env vars a hook may leak. */
export function gitRun(cwd: string, args: string[], timeout = 15_000, input?: string): GitResult {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[key];
  const r = spawnSync("git", args, {
    cwd,
    env,
    input,
    encoding: "utf8",
    timeout,
    maxBuffer: 64 << 20,
  });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** stdout of a successful git command, `null` when it fails. */
export function git(cwd: string, args: string[], timeout = 15_000): string | null {
  const r = gitRun(cwd, args, timeout);
  return r.ok ? r.stdout : null;
}

/** Slice IDs a commit message carries: `Slice: S<n>`, `[S<n>]` or `slice/S<n>-` in the subject. */
export function marksOf(message: string): string[] {
  const subject = message.split("\n", 1)[0] ?? "";
  const ids = [
    ...[...message.matchAll(/^\s*(?:[*-]\s*)?Slice:\s*(S\d+)\s*$/gim)].map((m) => m[1]),
    ...[...subject.matchAll(/\[(S\d+)\]/gi)].map((m) => m[1]),
    ...[...subject.matchAll(/\bslice\/(S\d+)-/gi)].map((m) => m[1]),
  ];
  return [...new Set(ids.filter((id): id is string => Boolean(id)).map((id) => id.toUpperCase()))];
}

/** Slice IDs marked in the commits of `range` (any `git log` revision arguments). */
function marksIn(cwd: string, range: string[]): Set<string> {
  return new Set(firstMarked(cwd, range).keys());
}

/** Oldest commit time (epoch seconds) of each slice marked in `range`. */
function firstMarked(cwd: string, range: string[]): Map<string, number> {
  const out = git(cwd, ["log", "--format=%ct%x1f%B%x1e", ...range]);
  if (out === null) throw new PlanStateError(`git log ${range.join(" ")} failed`);
  const first = new Map<string, number>();
  for (const record of out.split("\x1e")) {
    const [time = "", message = ""] = record.trimStart().split("\x1f");
    for (const id of marksOf(message))
      first.set(id, Math.min(Number(time), first.get(id) ?? Infinity));
  }
  return first;
}

const MAX_DAYS = 3;

function remoteRef(cwd: string, branch: string): string {
  const ref = `origin/${branch}`;
  if (git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) === null) {
    throw new PlanStateError(
      `no puedo resolver ${ref}: corre \`git fetch origin ${branch}\` (en CI, checkout con fetch-depth: 0)`,
    );
  }
  return ref;
}

const isAncestor = (cwd: string, sha: string, ref: string): boolean =>
  sha !== "" && git(cwd, ["merge-base", "--is-ancestor", sha, ref]) !== null;

/** Parses the lines of an `acceptance.jsonl`. */
export function parseLog(lines: string[]): LogEntry[] {
  return lines
    .filter((line) => line.trim() !== "")
    .map((line) => LogEntrySchema.parse(JSON.parse(line)));
}

/** Log entries: the local branch (unpublished verdicts included), else the remote one. */
export function readLog(cwd: string): LogEntry[] {
  for (const ref of [LOG_BRANCH, `origin/${LOG_BRANCH}`]) {
    const text = git(cwd, ["show", `${ref}:${LOG_FILE}`]);
    if (text !== null) return parseLog(text.split("\n"));
  }
  return [];
}

/** Best-effort fetch of the two plan branches; offline keeps the local refs with a warning. */
function fetchPlanBranches(cwd: string, acceptance: PlanAcceptance): string | null {
  const ok = git(cwd, ["fetch", "--quiet", "origin", acceptance.branch, acceptance.target], 30_000);
  return ok === null ? "sin conexión: uso las refs locales de origin, quizá desactualizadas" : null;
}

export interface ReadOptions {
  /** `true`: fetch and warn when offline; `"required"`: a failed fetch fails closed (`check`). */
  fetch?: boolean | "required";
  /** Verdicts to use instead of the log refs (`accept` validates against the merged log). */
  log?: LogEntry[];
  /** Plan to derive the state from instead of the working tree's (`check --incoming` passes the base's). */
  plan?: Plan;
}

/** Marks outside a shallow history would vanish and turn the WIP green, so refuse it. */
function assertFullHistory(cwd: string): void {
  if (git(cwd, ["rev-parse", "--is-shallow-repository"])?.trim() === "true") {
    throw new PlanStateError(
      "clon superficial: el estado necesita toda la historia (`git fetch --unshallow`; en CI, fetch-depth: 0)",
    );
  }
}

export function readPlanState(cwd: string, options: ReadOptions = {}): PlanState {
  const plan = options.plan ?? readPlan(cwd);
  const { acceptance } = plan;
  const warnings: string[] = [];
  if (options.fetch) {
    const offline = fetchPlanBranches(cwd, acceptance);
    if (offline && options.fetch === "required")
      throw new PlanStateError(`fetch de origin falló: ${offline}`);
    if (offline) warnings.push(offline);
  }
  assertFullHistory(cwd);
  const accRef = remoteRef(cwd, acceptance.branch);
  const targetRef = remoteRef(cwd, acceptance.target);
  const inAcc = marksIn(cwd, [accRef]);
  const inTarget = marksIn(cwd, [targetRef]);
  const anywhere = firstMarked(cwd, ["--all"]);
  for (const slice of plan.slices) {
    if (slice.commit && git(cwd, ["cat-file", "-e", `${slice.commit}^{commit}`]) === null) {
      throw new PlanStateError(
        `${slice.id}: el Commit ${slice.commit} del índice no existe en este repo`,
      );
    }
    if (isAncestor(cwd, slice.commit, accRef)) inAcc.add(slice.id);
    if (isAncestor(cwd, slice.commit, targetRef)) inTarget.add(slice.id);
  }

  const log = options.log ?? readLog(cwd);
  const last = new Map<string, LogEntry>();
  const notes = new Map<string, string[]>();
  for (const entry of log) {
    last.set(entry.id, entry);
    if (entry.verdict === "accepted") notes.delete(entry.id);
    else notes.set(entry.id, [...(notes.get(entry.id) ?? []), ...(entry.notes ?? [])]);
  }
  const accepted = (id: string): boolean => last.get(id)?.verdict === "accepted";
  // A rejection stays in force until a marked commit of the slice reaches the
  // acceptance branch after it. A verdict commit that is unknown or no longer
  // an ancestor (rewritten branch) keeps it in force: the range would be wrong.
  const reworked = (id: string, since: string): boolean => {
    if (isAncestor(cwd, since, accRef)) return marksIn(cwd, [`${since}..${accRef}`]).has(id);
    warnings.push(
      `${id}: el commit del rechazo no está en ${accRef}; el rechazo sigue vigente (recházalo de nuevo)`,
    );
    return false;
  };

  const slices = plan.slices.map((slice): SliceStatus => {
    const verdict = last.get(slice.id);
    const integrated = inAcc.has(slice.id);
    let state: SliceState = "pendiente";
    if (accepted(slice.id)) state = "aceptado";
    else if (integrated && (verdict?.verdict !== "rejected" || reworked(slice.id, verdict.commit)))
      state = "integrado";
    else if (integrated || inTarget.has(slice.id) || anywhere.has(slice.id)) state = "en curso";
    const days = Math.floor((Date.now() / 1000 - (anywhere.get(slice.id) ?? Infinity)) / 86_400);
    if (!integrated && days > MAX_DAYS)
      warnings.push(`${slice.id}: ${days} días sin integrarse (meta ≤${MAX_DAYS})`);
    if (
      state === "aceptado" &&
      verdict &&
      marksIn(cwd, [`${verdict.commit}..${accRef}`]).has(slice.id)
    ) {
      warnings.push(`${slice.id}: commits marcados después de aceptar; no se reabre`);
    }
    return {
      id: slice.id,
      outcome: slice.outcome,
      spec: slice.spec,
      state,
      noEnv: inTarget.has(slice.id) && !integrated,
      notes: notes.get(slice.id) ?? [],
      ...(verdict?.evidence ? { evidence: verdict.evidence } : {}),
    };
  });

  const planned = new Set(plan.slices.map((s) => s.id));
  for (const id of new Set([...inAcc, ...inTarget])) {
    if (!planned.has(id)) warnings.push(`${id}: commits marcados, pero no está en el índice`);
  }
  const counted = [...new Set([...inAcc, ...inTarget])].filter((id) => !accepted(id)).sort();
  const decisions = plan.decisions.map((d) => ({ ...d, approved: accepted(d.id) }));
  return { acceptance, slices, counted, decisions, warnings };
}

export interface IncomingResult {
  ok: boolean;
  /** Slices the PR brings: marked commits over the base, its branch name and its title. */
  incoming: string[];
  /** Incoming slices that do not count yet. */
  newSlices: string[];
  counted: string[];
  limit: number;
  /** Base branch the plan was read from. */
  base: string;
  /** `origin/<base>` has no PLAN.md: there is no WIP to apply. */
  noPlan?: boolean;
  /** The branch is `slice/<id>-…` but the title lacks `[<id>]`. */
  titleMissing?: string;
}

/**
 * WIP gate of a PR (spec 0063): fails when the slices the PR brings add a new
 * one and the count would pass the limit. The plan is read from `origin/<base>`,
 * never from the working tree (a PR checkout controls its own PLAN.md). The
 * branch name and the title count as marks (a squash merge keeps only the
 * title, a merge commit the branch). Unmarked work never fails.
 */
export function checkIncoming(
  cwd: string,
  ref: string,
  base: string,
  options: ReadOptions & { branch?: string; title?: string } = {},
): IncomingResult {
  const baseName = base;
  if (options.fetch) {
    const fetched = git(cwd, ["fetch", "--quiet", "origin", baseName], 30_000);
    if (fetched === null && options.fetch === "required")
      throw new PlanStateError(`fetch de origin falló: no pude traer ${baseName}`);
  }
  const baseRef = remoteRef(cwd, baseName);
  const plan = readPlanAt(cwd, baseRef);
  const empty = { incoming: [], newSlices: [], counted: [], limit: 0, base: baseName };
  if (!plan) return { ...empty, ok: true, noPlan: true };
  const sliceBranch = /^slice\/(S\d+)-/i.exec(options.branch ?? "")?.[1]?.toUpperCase();
  const titleMarks = marksOf(options.title ?? "");
  const limit = plan.acceptance.wip;
  if (sliceBranch && options.title !== undefined && !titleMarks.includes(sliceBranch))
    return { ...empty, ok: false, limit, titleMissing: sliceBranch };
  const state = readPlanState(cwd, { ...options, plan });
  const incoming = [
    ...new Set([
      ...marksIn(cwd, [`${baseRef}..${ref}`]),
      ...titleMarks,
      ...(sliceBranch ? [sliceBranch] : []),
    ]),
  ].sort();
  const newSlices = incoming.filter(
    (id) =>
      !state.counted.includes(id) &&
      !state.slices.some((s) => s.id === id && s.state === "aceptado"),
  );
  const ok = newSlices.length === 0 || state.counted.length + newSlices.length <= limit;
  return { ok, incoming, newSlices, counted: state.counted, limit, base: baseName };
}
