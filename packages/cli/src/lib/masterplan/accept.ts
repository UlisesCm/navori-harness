/**
 * `navori master accept|reject` of the master plan v2 (spec 0063): appends the
 * user's QA verdicts to `acceptance.jsonl` on the orphan branch
 * `navori/acceptance` with git plumbing only (HEAD, index and working tree are
 * never touched), moves the local ref with compare-and-swap and pushes it.
 */
import { DEFAULT_LANG, tc, type Lang } from "../i18n.ts";
import { fail, guarded, type CommandOutput } from "./report.ts";
import {
  LOG_BRANCH,
  LOG_FILE,
  LogEntrySchema,
  PlanStateError,
  git,
  gitRun,
  parseLog,
  readPlanState,
  type LogEntry,
  type PlanState,
} from "./state.ts";

export interface VerdictOptions {
  verdict: "accepted" | "rejected";
  ids: string[];
  evidence?: string;
  notes?: string[];
  approvedBy?: string;
  /** `false` skips every fetch (offline). */
  fetch?: boolean;
  /** Output language; defaults to the CLI default. */
  lang?: Lang;
}

const LOCAL_REF = `refs/heads/${LOG_BRANCH}`;
const REMOTE_REF = `refs/remotes/origin/${LOG_BRANCH}`;

const refSha = (cwd: string, ref: string): string =>
  git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])?.trim() ?? "";

/** Lines of `acceptance.jsonl` at `sha` (none for an empty sha). */
function linesAt(cwd: string, sha: string): string[] {
  const text = sha ? git(cwd, ["show", `${sha}:${LOG_FILE}`]) : null;
  return (text ?? "").split("\n").filter((l) => l.trim() !== "");
}

/** Throws unless every id may take the verdict in `state` (the whole batch fails on one). */
function validate(state: PlanState, options: VerdictOptions, ids: string[]): void {
  const { verdict, evidence, notes = [] } = options;
  const bad = (message: string): never => {
    throw new PlanStateError(message);
  };
  if (verdict === "accepted" && notes.length) bad("--notes solo aplica a reject");
  if (verdict === "rejected" && evidence) bad("--evidence solo aplica a accept");
  if (evidence && !/^https?:\/\/\S+$/.test(evidence)) bad("--evidence debe ser una URL http(s)");
  if (verdict === "rejected" && !notes.some((n) => n.trim() !== ""))
    bad("reject requiere al menos un --notes con la tarea pendiente");
  if (ids.length === 0) bad("indica al menos un ID (S<n> o D<n>)");
  const wrong = ids.find((id) => !/^[SD]\d+$/.test(id));
  if (wrong) bad(`${wrong}: el ID debe ser S<n> o D<n>`);
  const decisions = ids.filter((id) => id.startsWith("D"));
  if (decisions.length && decisions.length < ids.length)
    bad("D<n> se acepta aparte: no lo mezcles con slices");
  if (decisions.length && verdict === "rejected") bad("una decisión no se rechaza: solo se acepta");
  if (new Set(ids).size < ids.length) bad("hay IDs repetidos");
  for (const id of ids) {
    if (id.startsWith("D")) {
      const decision = state.decisions.find((d) => d.id === id);
      if (!decision) bad(`${id} no está en las decisiones del plan`);
      else if (decision.approved) bad(`${id} ya está aceptada`);
      continue;
    }
    const slice = state.slices.find((s) => s.id === id);
    if (!slice) bad(`${id} no está en el índice`);
    else if (verdict === "accepted" && slice.state !== "integrado")
      bad(`${id} está ${slice.state}: solo se acepta un slice integrado`);
    else if (verdict === "rejected" && (slice.state === "pendiente" || slice.state === "aceptado"))
      bad(`${id} está ${slice.state}: no hay nada que rechazar`);
  }
}

interface Attempt {
  entries: LogEntry[];
  published: boolean;
  reason: string;
}

/** One validate → write → push round on top of the freshest known log. */
function attempt(
  cwd: string,
  options: VerdictOptions,
  ids: string[],
  final: boolean,
): Attempt | "rejected" {
  const fetched =
    options.fetch === false
      ? { ok: false }
      : gitRun(
          cwd,
          ["fetch", "--quiet", "origin", `+refs/heads/${LOG_BRANCH}:${REMOTE_REF}`],
          30_000,
        );
  const remote = refSha(cwd, REMOTE_REF);
  const local = refSha(cwd, LOCAL_REF);
  const base = remote || local;
  const baseLines = linesAt(cwd, base);
  const known = new Set(baseLines);
  const unpublished = remote ? linesAt(cwd, local).filter((l) => !known.has(l)) : [];
  const merged = [...baseLines, ...unpublished];
  const state = readPlanState(cwd, {
    fetch: !final && options.fetch !== false,
    log: parseLog(merged),
  });
  validate(state, options, ids);

  const commit = refSha(cwd, `origin/${state.acceptance.branch}`);
  const at = new Date().toISOString();
  const entries = ids.map((id) =>
    LogEntrySchema.parse({
      id,
      verdict: options.verdict,
      at,
      env: state.acceptance.env,
      commit,
      by: "user",
      ...(options.evidence ? { evidence: options.evidence } : {}),
      ...(options.verdict === "rejected"
        ? { notes: (options.notes ?? []).map((n) => n.trim()).filter(Boolean) }
        : {}),
    }),
  );
  const content = `${[...merged, ...entries.map((e) => JSON.stringify(e))].join("\n")}\n`;
  const must = (args: string[], input?: string): string => {
    const r = gitRun(cwd, args, 15_000, input);
    if (!r.ok) throw new PlanStateError(`git falló: ${r.stderr.trim()}`);
    return r.stdout.trim();
  };
  const blob = must(["hash-object", "-w", "--stdin"], content);
  const tree = must(["mktree"], `100644 blob ${blob}\t${LOG_FILE}\n`);
  const message = `${options.verdict === "accepted" ? "accept" : "reject"} ${ids.join(" ")}`;
  const written = must(
    [
      ...["-c", "user.name=navori", "-c", "user.email=navori@localhost"],
      ...["commit-tree", tree, ...(base ? ["-p", base] : []), "-m", message],
    ],
    "",
  );
  // Compare-and-swap: fails closed if the local branch moved since we read it.
  must(["update-ref", LOCAL_REF, written, local]);
  const push = gitRun(
    cwd,
    ["push", "--quiet", "origin", `${written}:refs/heads/${LOG_BRANCH}`],
    30_000,
  );
  if (push.ok) return { entries, published: true, reason: "" };
  if (!final) {
    // Rebuild from scratch on the new remote base: put the local branch back.
    must(["update-ref", ...(local ? [LOCAL_REF, local, written] : ["-d", LOCAL_REF, written])]);
    return "rejected";
  }
  const detail = push.stderr.trim().split("\n").pop() ?? "";
  const reason =
    fetched.ok || remote ? detail || "push rechazado" : `sin conexión o sin remoto (${detail})`;
  return { entries, published: false, reason };
}

/** Records accept/reject verdicts for `ids`; `approvedBy` must be `user`. */
export function recordVerdicts(cwd: string, options: VerdictOptions): CommandOutput {
  return guarded(() => {
    if (options.approvedBy !== "user")
      return fail("accept/reject registran el veredicto del usuario: requieren --approved-by user");
    const ids = options.ids.map((id) => id.toUpperCase());
    // One retry when the push loses the race (the remote moved after the fetch).
    const result = attempt(cwd, options, ids, false);
    const done = result === "rejected" ? attempt(cwd, options, ids, true) : result;
    if (done === "rejected") throw new PlanStateError("no se pudo registrar el veredicto");
    const tr = tc(options.lang ?? DEFAULT_LANG).master;
    const stdout = done.entries.map(
      (e) =>
        `${tr.verdict(e.id, e.verdict === "accepted", e.at.slice(0, 10), e.commit.slice(0, 7), {
          evidence: e.evidence,
          notes: e.notes?.length,
        })}\n`,
    );
    if (done.published) stdout.push(`${tr.published(LOG_BRANCH)}\n`);
    return {
      stdout: stdout.join(""),
      stderr: done.published ? "" : `[navori] ${tr.unpublished(done.reason)}\n`,
      code: 0,
    };
  });
}
