/**
 * `navori plan gate` — the TypeScript half of the `PreToolUse(Agent)` hook
 * (spec 0032, R16/R17/R19). The `.sh` wrapper is a thin passthrough: it
 * resolves the `navori` binary and forwards the hook's stdin payload here
 * unchanged. Kept out of shell so the JSON/regex/hashing logic is testable
 * directly, the same split `session-start-context.sh` and its TS-driven
 * partials already use.
 */
import {
  existsSync,
  linkSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import {
  checkoutRoot,
  resolveStateRoot,
  stateArtifactPath,
  type StateRoot,
} from "../primitives/state-root.ts";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { readConfig, type NavoriConfig } from "../config/config.ts";
import { classify, matchesCriticalPaths, normalizeRepoPath } from "./classify.ts";
import { checkWorkplan, formatCheckResult } from "./check.ts";
import { parseExpected } from "./expected.ts";
import type { Workplan } from "./schema.ts";
import { appendCliEvent, hasAuditTarget, outcomeFeatureKey } from "../audit/cli-event.ts";
import { locateSpecDir } from "../spec/locate.ts";
import { NON_IMPLEMENTER_ROLES } from "../../engines/shared/roster.ts";
import { parseTasks } from "../spec/tasks.ts";
import {
  acknowledgeEscalation,
  consumeEscalation,
  continueEscalation,
  inspectEscalation,
  escalationBinding,
  readPlanSnapshot,
  readRejectionHistory,
  type ContinuationRequest,
  type EscalationInspection,
  recordRejections,
  requireAcknowledgement,
  snapshotsMatch,
  type EscalationBinding,
  type PlanSnapshot,
} from "./escalation.ts";

interface RecoveryContext {
  opening: string;
  files: PlanSnapshot[];
  binding?: EscalationBinding;
  acknowledging?: boolean;
  inspecting?: boolean;
}

/** What an allowed `workplan: <feature>` spawn tells the audit log (spec 0042 T10a). */
export interface GateDispatch {
  feature: string;
  cwd: string;
  codex: boolean;
  /** The hook payload's `session_id`, when it carries one. */
  sessionId?: string;
  /** The `Agent` call's `tool_use_id`, when it is a bounded id. */
  spawn?: string;
}

export interface PlanGateResult {
  decision: "allow" | "deny";
  /** Only set on `deny` — names the skill to load and the command to run (R16). */
  reason?: string;
  /** Only set on an `allow` resolved from a `workplan:` or `spec:` opening line. */
  dispatch?: GateDispatch;
}

const SPAWN_ID = /^[A-Za-z0-9_-]{1,256}$/;

/**
 * The subset of the `Agent`/`spawn_agent` `PreToolUse` payload this gate
 * reads, for either engine (https://code.claude.com/docs/en/hooks, section
 * "Agent"; spec 0035, codex-research.md: `spawn_agent`'s `tool_input` carries
 * `agent_type` and `message` where Claude's carries `subagent_type` and
 * `prompt`). Every other field either host sends is ignored.
 */
interface AgentHookPayload {
  cwd?: string;
  sessionId?: string;
  toolUseId?: string;
  tool_input?: {
    subagentType?: string;
    prompt?: string;
    /** True for a Codex `spawn_agent` call (`agent_type` present, no `subagent_type`). */
    codex: boolean;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** What `navori plan gate` passes when stdin is not valid JSON. */
export const UNREADABLE_PAYLOAD: unique symbol = Symbol("unreadable-payload");

/** `parsePayload` outcome: a usable payload, or the problem that makes it unreadable (R4). */
type ParsedPayload = { ok: true; payload: AgentHookPayload } | { ok: false; problem: string };

/**
 * Normalizes a spawn role for comparison: no whitespace, lowercase, without a
 * `<plugin>:` prefix (R3). `" Navori:Implementer "` becomes `implementer`.
 */
export function normalizeRole(role: string): string {
  return role
    .replace(/\s+/g, "")
    .toLowerCase()
    .replace(/^[^:]*:/, "");
}

/**
 * Whether a spawn is gated as an implementer (R3). Claude: the normalized
 * `subagent_type` is `implementer` (no type is `general-purpose`, which passes).
 * Codex: fail-closed, anything whose normalized role is missing or outside
 * {@link NON_IMPLEMENTER_ROLES} (`default`, `worker`, unknown roles).
 */
export function isImplementerSpawn(role: string | undefined, codex: boolean): boolean {
  const normalized = normalizeRole(role ?? "");
  return codex ? !NON_IMPLEMENTER_ROLES.includes(normalized) : normalized === "implementer";
}

/** Options for {@link evaluatePlanGate}. */
export interface PlanGateOptions {
  /**
   * Treat the spawn as Codex even without `agent_type`. Set from
   * `NAVORI_HOOK_ENGINE=codex`, which the Codex copy of `plan-gate.sh` exports;
   * an old hook copy lacks it and falls back to "`agent_type` is present".
   */
  codex?: boolean;
}

/**
 * Parses the hook payload. Only a non-object root or a missing/non-object
 * `tool_input` is a `problem`; any field with a non-string type is treated as
 * absent (a null Codex V2 `message` must not deny every spawn).
 */
function parsePayload(raw: unknown, forceCodex: boolean): ParsedPayload {
  if (raw === UNREADABLE_PAYLOAD) return { ok: false, problem: "payload is not valid JSON" };
  if (!isRecord(raw)) return { ok: false, problem: "payload is not a JSON object" };
  if (!isRecord(raw.tool_input)) return { ok: false, problem: "payload has no tool_input object" };
  const toolInput = raw.tool_input;
  const codexAgentType =
    typeof toolInput.agent_type === "string" ? toolInput.agent_type : undefined;
  return {
    ok: true,
    payload: {
      cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
      sessionId: typeof raw.session_id === "string" ? raw.session_id : undefined,
      toolUseId:
        typeof raw.tool_use_id === "string" && SPAWN_ID.test(raw.tool_use_id)
          ? raw.tool_use_id
          : undefined,
      tool_input: {
        subagentType:
          codexAgentType ??
          (typeof toolInput.subagent_type === "string" ? toolInput.subagent_type : undefined),
        prompt:
          (typeof toolInput.message === "string" ? toolInput.message : undefined) ??
          (typeof toolInput.prompt === "string" ? toolInput.prompt : undefined),
        codex: forceCodex || codexAgentType !== undefined,
      },
    },
  };
}

/**
 * Resolves the Git toplevel from `cwd` so a subdirectory gets the same
 * decision as the root (R2). Never throws: outside a checkout it is `cwd`.
 */
export function configRoot(cwd: string): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  const top = result.error || result.status !== 0 ? "" : result.stdout.trim();
  return top === "" ? cwd : top;
}

function deny(reason: string): PlanGateResult {
  return { decision: "deny", reason };
}

const ALLOW: PlanGateResult = { decision: "allow" };

const WORKPLAN_LINE = /^workplan:\s*(\S+)/;
const NIVEL0_LINE = /^nivel-0:\s*(\S+)(?:\s+(.*))?$/;
const FEATURE_SLUG = /^[a-z0-9][a-z0-9._-]*$/;
const SPEC_LINE = /^spec:\s*([a-z0-9][a-z0-9._-]*)\s+E([1-9][0-9]*)\s+M([1-9][0-9]*)$/;

/** A Fernet token (what Codex's V2 `spawn_agent` sends in place of `message`). */
const ENCRYPTED_MESSAGE = /^gAAAAA[A-Za-z0-9_=-]*$/;

/** How long a dispatch file stays valid after `createdAt` (spec 0041 R9, OQ2). */
export const DISPATCH_TTL_MS = 10 * 60 * 1000;

/** Clock skew tolerated for a `createdAt` ahead of now; beyond it the dispatch is stale (R7). */
const DISPATCH_FUTURE_SKEW_MS = 60 * 1000;

interface DispatchHit {
  opening: string;
  file: string;
  feature: string;
  /** Exact bytes evaluated, compared against the claimed file. */
  raw: string;
}
const DISPATCH_DIR = ".navori/state/handoffs";
const DISPATCH_FILE = /^dispatch_([a-z0-9][a-z0-9._-]*)\.json$/;

/**
 * Contract of `.navori/state/handoffs/dispatch_<feature>.json`, written by the
 * Codex orchestrator right before it spawns the `implementer` (spec 0041 R9).
 * Codex V2 encrypts the spawn `message`, so the gate cannot read the opening
 * line from the payload and reads it from here instead.
 */
export const DispatchSchema = z.object({
  feature: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  /** The encargo's first line: `workplan:`, `nivel-0:` or `spec:`. */
  opening: z.string().min(1),
  /**
   * ISO-8601 timestamp; the file is stale `DISPATCH_TTL_MS` after it. Offsets and
   * fractional seconds are accepted because the Codex orchestrator writes its own
   * file (smoke S4d: `2026-10-03T20:27:54.004865+00:00`), not only `...Z`.
   */
  createdAt: z.string().datetime({ offset: true }),
  /**
   * The Codex session that wrote the marker (`$CODEX_SESSION_ID`, else
   * `$CODEX_THREAD_ID`; #1331). Optional: an unstamped marker keeps the legacy,
   * directory-wide rule. Other sessions' stamped markers are never consumed.
   */
  sessionId: z.string().regex(SPAWN_ID).optional(),
});
export type Dispatch = z.infer<typeof DispatchSchema>;

/**
 * The payload session id when it is a bounded id, else `undefined` (legacy,
 * unscoped dispatch rule). The single source for the marker selection and the
 * audit context, so both always agree on what counts as "this session" (#1331).
 */
function boundedSessionId(sessionId: string | undefined): string | undefined {
  return sessionId !== undefined && SPAWN_ID.test(sessionId) ? sessionId : undefined;
}

/** In-band instruction on a dispatch deny; prints the id the gate expects so the orchestrator can self-correct. */
function dispatchFix(sessionId?: string): string {
  return (
    "the orchestrator must write `.navori/state/handoffs/dispatch_<feature>.json` " +
    '({"feature","opening":"workplan: <feature>","createdAt":<ISO now>,"sessionId":<this session\'s id>}) right before ' +
    "spawning the implementer, and keep exactly one fresh dispatch per session (TTL 10 min)" +
    (sessionId
      ? `; this session's id is \`${sessionId}\`: write it as \`sessionId\` in dispatch_<feature>.json`
      : "")
  );
}

/**
 * One dispatch per spawn (R7): claims `file` by renaming it to a dot-prefixed name
 * (which DISPATCH_FILE never matches), so of several parallel hooks only one wins.
 * Returns the deny reason, or `undefined` when the claim succeeded with the same
 * bytes that were evaluated. Fail-closed on any error.
 */
export function claimDispatch(
  file: string,
  raw: string,
  now: number,
  consume: (unchanged: () => boolean) => void = () => {},
): string | undefined {
  // TODO(recovery): crashes can retain private claims; add diagnosis if manual cleanup becomes frequent.
  const claimPath = join(
    dirname(file),
    `.${basename(file)}.claim-${process.pid}-${now}-${randomUUID()}`,
  );
  try {
    renameSync(file, claimPath);
  } catch (cause: unknown) {
    return (cause as NodeJS.ErrnoException).code === "ENOENT"
      ? "dispatch already claimed by a concurrent spawn."
      : `dispatch could not be claimed (${cause instanceof Error ? cause.message : "rename failed"}).`;
  }
  const unchanged = (): boolean => {
    try {
      return readPlanSnapshot(claimPath).content === raw;
    } catch {
      return false;
    }
  };
  try {
    if (!unchanged()) return "dispatch changed during evaluation; rewrite it and retry.";
    consume(unchanged);
    return unchanged() ? undefined : "dispatch changed during consumption; attempt stays spent.";
  } finally {
    // Only the selected marker's bytes may be deleted. Anything else (another
    // session rewrote the public name between read and claim, #1331) goes back to
    // its public name when free (link fails on EEXIST, never overwrites); if the
    // name is taken, the dot-prefixed claim stays on disk rather than being lost.
    if (unchanged()) {
      rmSync(claimPath, { force: true });
    } else {
      try {
        linkSync(claimPath, file);
        rmSync(claimPath, { force: true });
      } catch {
        // Public name occupied or claim unreadable: keep the claim file.
      }
    }
  }
}

/**
 * Reads the opening line of the single fresh dispatch file. The feature cannot
 * be taken from the (encrypted) message, so the rule is: exactly ONE valid,
 * non-stale dispatch file may exist; zero, several or any malformed one denies
 * rather than guessing. Returns the opening line plus the file to consume.
 *
 * With a bounded payload `sessionId` (#1331) selection is per session: the one
 * fresh marker stamped with it; other sessions' stamped markers are skipped and
 * never touched. Residuals, same as before the fix: a lone unstamped marker may
 * be consumed by any session (transition), an unstamped marker is ignored when
 * one stamped marker exists (mixed stamping relaxes "one at a time"), and a
 * corrupt marker with no recoverable session id still blocks every session.
 */
function readDispatch(
  cwd: string,
  now: number,
  sessionId?: string,
): DispatchHit | { reason: string } {
  const fix = dispatchFix(sessionId);
  const root = resolveStateRoot({ cwd, feature: "dispatch", dir: DISPATCH_DIR });
  const names = existsSync(root.path)
    ? readdirSync(root.path).filter((n) => DISPATCH_FILE.test(n))
    : [];
  const fresh: DispatchHit[] = [];
  const own: DispatchHit[] = [];
  const unscoped: DispatchHit[] = [];
  /** Names of other sessions' markers that were skipped (never read for `opening`, never claimed). */
  const skipped: string[] = [];
  let otherFresh = 0;
  let stale = 0;
  for (const name of names) {
    const file = stateArtifactPath(root, name);
    const snapshot = readPlanSnapshot(file);
    let json: unknown;
    try {
      json = JSON.parse(snapshot.content ?? "");
    } catch {
      json = undefined;
    }
    // With a payload session, a marker provably stamped by ANOTHER session is
    // invisible: even if corrupt or stale it must not block this one (#1331).
    // An unattributable corrupt marker still falls through to the deny below.
    if (sessionId !== undefined && isRecord(json)) {
      const stamp = json.sessionId;
      if (typeof stamp === "string" && SPAWN_ID.test(stamp) && stamp !== sessionId) {
        skipped.push(name);
        const other = DispatchSchema.safeParse(json);
        if (other.success) {
          const otherAge = now - Date.parse(other.data.createdAt);
          if (otherAge <= DISPATCH_TTL_MS && -otherAge <= DISPATCH_FUTURE_SKEW_MS) otherFresh++;
        }
        continue;
      }
    }
    let parsed: Dispatch;
    try {
      parsed = DispatchSchema.parse(json);
    } catch {
      return { reason: `${file} is malformed — ${fix}.` };
    }
    if (parsed.feature !== DISPATCH_FILE.exec(name)![1]) {
      return {
        reason: `${file}: "feature" does not match the file name — ${fix}.`,
      };
    }
    const age = now - Date.parse(parsed.createdAt);
    if (age > DISPATCH_TTL_MS || -age > DISPATCH_FUTURE_SKEW_MS) {
      stale++;
      continue;
    }
    const hit: DispatchHit = {
      opening: parsed.opening,
      file,
      feature: parsed.feature,
      raw: snapshot.content!,
    };
    fresh.push(hit);
    if (sessionId !== undefined) (parsed.sessionId === undefined ? unscoped : own).push(hit);
  }
  const ambiguous = (n: number, scope: string): { reason: string } => ({
    reason: `${n} fresh dispatch files exist${scope}, the gate will not guess which one — ${fix}.`,
  });
  if (sessionId === undefined) {
    // Legacy rule (payload without a bounded session id): every fresh marker counts.
    if (fresh.length === 1) return fresh[0]!;
    if (fresh.length > 1) return ambiguous(fresh.length, "");
  } else {
    if (own.length === 1) return own[0]!;
    if (own.length > 1) return ambiguous(own.length, " for this session");
    // Transitional fallback: no stamped marker of ours; accept only a lone,
    // unstamped marker with nothing else fresh in the directory (never weaker than the legacy rule).
    if (unscoped.length === 1 && otherFresh === 0) return unscoped[0]!;
    if (unscoped.length > 0) {
      return {
        reason:
          `no dispatch file for this session (${sessionId}) can be selected: ` +
          `${unscoped.length} unstamped and ${otherFresh} other-session fresh dispatch files exist, the gate will not guess` +
          (skipped.length > 0 ? ` (skipped other-session markers: ${skipped.join(", ")})` : "") +
          ` — ${fix}.`,
      };
    }
  }
  return {
    reason:
      (stale > 0
        ? `the dispatch file is stale (older than 10 min) — `
        : `the spawn message is encrypted and no dispatch file exists${sessionId ? " for this session" : ""}` +
          (skipped.length > 0 ? ` (skipped other-session markers: ${skipped.join(", ")})` : "") +
          " — ") + `${fix}.`,
  };
}

const NO_OPENING_LINE_REASON =
  "the encargo does not open with `workplan: <feature>`, `nivel-0: <path> <feature>` or `spec: <spec> E<n> M<n>` — " +
  "load skill `plan-simple` (level 1) or `plan-advanced` (level 2) and produce a " +
  "workplan, or confirm a level-0 exemption with `navori plan classify <feature>`.";

/** Rejections on record after the last `reset` line, plus their timestamps. */
export interface RejectionCount {
  count: number;
  /** `ts` of each counted rejection, oldest first. */
  timestamps: string[];
}

/**
 * R19/R9: append a fresh `CHANGES_REQUESTED` verdict to the append-only gate log
 * and return the DISTINCT rejections on record after the last `reset` line.
 * `review_<feature>.md` may be rewritten or have milestone sections appended, so
 * rejections are counted via this side log (deduped by whole-file hash across the
 * WHOLE history, so the review that motivated a reset is not recounted) instead
 * of counting files. A rejection is recorded only when the LAST
 * `**Final verdict:**` in the file is `CHANGES_REQUESTED`.
 */
export function recordAndCountRejections(root: StateRoot, feature: string): RejectionCount {
  const { activeTimestamps: timestamps } = recordRejections(root, feature);
  return { count: timestamps.length, timestamps };
}

/**
 * R8/R9: after two recorded rejections, the next dispatch needs the next
 * level's artifacts. At level 0/1 the cap renews by pairs: `solution_*` and its
 * challenge must be newer than the rejection that closed the latest pair
 * (number `2·⌊n/2⌋`). At level >= 2 it escalates to the user.
 */
function evaluateEscalation(
  root: StateRoot,
  feature: string,
  level: number,
  context: RecoveryContext,
): PlanGateResult | null {
  const history = context.inspecting
    ? readRejectionHistory(root, feature)
    : recordRejections(root, feature);
  if (context.inspecting) {
    const review = history.files[1]!.content ?? "";
    if (
      [...review.matchAll(/\*\*Final verdict:\*\*\s*([A-Z_]+)/g)].at(-1)?.[1] ===
      "CHANGES_REQUESTED"
    ) {
      // Inspection cannot append a rejection or bind an incomplete history.
      if (!history.hashes.includes(createHash("sha256").update(review).digest("hex")))
        throw new Error("current review rejection is unrecorded; use the normal gate first");
    }
  }
  const { activeTimestamps: timestamps } = history;
  const rejections = timestamps.length;
  if (rejections < 2) return null;

  if (level >= 2) {
    context.binding = escalationBinding(
      root,
      feature,
      level,
      context.opening,
      history,
      context.files,
    );
    if (!context.acknowledging) {
      try {
        requireAcknowledgement(context.binding);
      } catch (cause: unknown) {
        throw new Error(
          `${cause instanceof Error ? cause.message : "escalation acknowledgement required"}; ` +
            `escalate to the user: navori plan escalation-reset ${feature} --approved-by user ` +
            '--reason "<why>", or navori plan acknowledge for one bound attempt',
        );
      }
    }
    return ALLOW;
  }

  const pairTs = Date.parse(timestamps[2 * Math.floor(rejections / 2) - 1] ?? "");
  const fresh = (path: string): boolean =>
    existsSync(path) && (Number.isNaN(pairTs) || statSync(path).mtimeMs >= pairTs);
  const solutionPath = stateArtifactPath(root, `solution_${feature}.md`);
  const solutionReviewPath = stateArtifactPath(root, `solution_review_${feature}.md`);
  if (!fresh(solutionPath) || !fresh(solutionReviewPath)) {
    return deny(
      `feature "${feature}" has ${rejections} recorded CHANGES_REQUESTED — produce a NEW ` +
        `solution_${feature}.md and its challenge (solution_review_${feature}.md), written after ` +
        "the latest rejection pair, before the next dispatch, skill `plan-advanced`.",
    );
  }
  return null;
}

const NIVEL0_FORM = "`nivel-0: <path>[,<path>] <feature> | verify: `<cmd>` → <expected>`";

/**
 * The `verify:` clause of a `nivel-0:` line (R28): a code span of N backticks
 * (a `|` or `→` inside does not break it), a `→`/`->` separator and a non-empty,
 * structured or free-text `<expected>`. It validates syntax, not the criterion's substance.
 */
const VERIFY_CLAUSE = /^verify:\s+(`+)(.+?)\1\s+(?:→|->)\s+(\S.*)$/;

/** Whether the rendered doctrine still shows the old one-token `nivel-0:` form. */
function doctrineIsStale(cwd: string): boolean {
  return ["CLAUDE.md", "AGENTS.md"].some((name) => {
    try {
      return readFileSync(join(cwd, name), "utf-8").includes("`nivel-0: <path>`");
    } catch {
      return false;
    }
  });
}

/**
 * `nivel-0: <path>[,<path>] <feature> | verify: `<cmd>` → <expected>` (R6, R8, R28). The path list is one
 * comma-separated token; `<feature>` indexes the rejection count. The gate only
 * verifies the declared paths, not the real diff.
 */
function evaluateNivel0(
  cwd: string,
  config: NavoriConfig,
  rawPath: string,
  rawFeature: string | undefined,
  dispatchFeature: string | undefined,
): PlanGateResult {
  const tail = rawFeature ?? "";
  const bar = tail.indexOf("|");
  const feature = (bar === -1 ? tail : tail.slice(0, bar)).trim();
  const verifyClause = bar === -1 ? undefined : tail.slice(bar + 1).trim();
  if (!FEATURE_SLUG.test(feature)) {
    return deny(
      `\`nivel-0:\` needs a feature — open with ${NIVEL0_FORM}.` +
        (doctrineIsStale(cwd)
          ? " The rendered doctrine is outdated: run `navori render --apply`."
          : ""),
    );
  }
  if (dispatchFeature !== undefined && dispatchFeature !== feature) {
    return deny(
      `dispatch feature "${dispatchFeature}" does not match nivel-0 feature "${feature}".`,
    );
  }
  const verify = verifyClause === undefined ? null : VERIFY_CLAUSE.exec(verifyClause);
  if (verify === null || verify[2]!.trim() === "") {
    return deny(
      `\`nivel-0:\` needs a verification criterion (R28) — open with ${NIVEL0_FORM}; ` +
        "`<expected>` may be structured or free text and must not be empty.",
    );
  }
  const expected = parseExpected(verify[3]!);
  if (expected.kind === "invalid") {
    return deny(`\`nivel-0:\` invalid structured expected — ${expected.reason}.`);
  }
  let root: StateRoot;
  try {
    root = resolveStateRoot({ cwd, feature });
  } catch (cause: unknown) {
    return deny(cause instanceof Error ? cause.message : "unsafe state root");
  }
  if (existsSync(stateArtifactPath(root, `workplan_${feature}.json`))) {
    return deny(
      `feature "${feature}" already has a workplan — open with \`workplan: ${feature}\`, not nivel-0.`,
    );
  }

  const files = rawPath.split(",").filter((f) => f.length > 0);
  if (files.length === 0) return deny(`\`nivel-0:\` has no path — open with ${NIVEL0_FORM}.`);
  const unsafe = files.find((f) => {
    const n = normalizeRepoPath(f);
    return n.absolute || n.escapes;
  });
  if (unsafe !== undefined) {
    return deny(
      `\`nivel-0:\` path "${unsafe}" is absolute or climbs out with \`..\` — use repo-relative paths.`,
    );
  }
  const criticalPaths = config.project?.criticalPaths ?? [];
  if (matchesCriticalPaths(files, criticalPaths)) {
    return deny(
      `\`nivel-0: ${rawPath}\` touches a critical path (project.criticalPaths) — level 0 is not ` +
        "allowed; run `navori plan classify <feature>` and produce a workplan.",
    );
  }
  const result = classify({
    files,
    criticalPaths: config.project?.criticalPaths,
    localSkillIds: config.project?.localSkills,
  });
  if (result.level !== 0) {
    return deny(
      `\`nivel-0: ${rawPath}\` is not confirmed by classify (computed level ${result.level}, ` +
        `score ${result.score}) — run \`navori plan classify <feature>\`, then produce a workplan ` +
        "with skill `plan-simple` (level 1) or `plan-advanced` (level 2).",
    );
  }
  try {
    return (
      evaluateEscalation(root, feature, 0, {
        opening: `nivel-0: ${rawPath} ${feature}`,
        files: [],
      }) ?? ALLOW
    );
  } catch (cause: unknown) {
    return deny(cause instanceof Error ? cause.message : "unsafe rejection history");
  }
}

/** Runs shared plan validation/escalation, with delivery identity required for SDD. */
function evaluateWorkplan(
  root: StateRoot,
  feature: string,
  context: RecoveryContext,
  spec: boolean = false,
): PlanGateResult {
  const workplanPath = stateArtifactPath(root, `workplan_${feature}.json`);
  if (!existsSync(workplanPath)) {
    return deny(
      `no workplan at ${workplanPath} — write the draft and run \`navori plan render ${feature}\` ` +
        "then `navori plan check " +
        feature +
        "`, skill `plan-simple` (level 1) or `plan-advanced` (level 2).",
    );
  }

  let raw: unknown;
  try {
    const snapshot = readPlanSnapshot(workplanPath);
    raw = JSON.parse(snapshot.content ?? "");
    context.files.push(snapshot);
  } catch (cause) {
    return deny(
      `${workplanPath} is not valid JSON (${cause instanceof Error ? cause.message : String(cause)}) ` +
        `— fix it and run \`navori plan check ${feature}\`.`,
    );
  }

  const result = checkWorkplan(raw, { cwd: root.cwd, feature });
  if (!result.ok) {
    return deny(
      `\`navori plan check ${feature}\` fails:\n${formatCheckResult(result)}\n` +
        "Fix it, then re-run `navori plan check " +
        feature +
        "` — skill `plan-simple`/`plan-advanced`.",
    );
  }

  const level = (raw as Pick<Workplan, "level">).level;
  if (spec && (level !== 3 || (raw as Pick<Workplan, "feature">).feature !== feature)) {
    return deny(`spec dispatch requires workplan feature "${feature}" and level 3.`);
  }
  if ((raw as Pick<Workplan, "feature">).feature !== feature)
    return deny("workplan feature does not match opening");
  return evaluateEscalation(root, feature, level, context) ?? ALLOW;
}

/** Validates exact delivery/milestone membership before the common workplan gate. */
function evaluateSpec(
  root: StateRoot,
  config: NavoriConfig,
  spec: string,
  delivery: string,
  milestone: string,
  feature: string,
  context: RecoveryContext,
): PlanGateResult {
  const location = locateSpecDir(root.cwd, config.sdd?.specsDir ?? "specs", spec);
  if (!location.ok) return deny(location.why);
  const tasksPath = join(location.dir, "tasks.md");
  const snapshot = readPlanSnapshot(tasksPath);
  const tasks = parseTasks(snapshot.content ?? "");
  context.files.push(snapshot);
  if (
    tasks.format !== "deliveries" ||
    tasks.malformed.length > 0 ||
    tasks.orphanTasks.length > 0 ||
    tasks.orphanCriteria.length > 0
  ) {
    return deny(`${tasksPath} must use deliveries without malformed or orphan items.`);
  }
  const deliveries = tasks.deliveries.filter((entry) => entry.id === delivery);
  if (deliveries.length !== 1) {
    return deny(`${tasksPath} must contain exactly one ${delivery} delivery.`);
  }
  if (deliveries[0]!.milestones.filter((entry) => entry.id === milestone).length !== 1) {
    return deny(`${tasksPath} must contain exactly one ${milestone} milestone in ${delivery}.`);
  }
  return evaluateWorkplan(root, feature, context, true);
}

/**
 * Core decision (R16/R17/R19). Pure with respect to its inputs besides the
 * gate-log append (a deliberate, idempotent side effect — see
 * `recordRejections`). Fail-closed under `planTiers`: an unreadable
 * config or payload denies; only an absent config or a non-implementer allows.
 */
export function evaluatePlanGate(
  rawPayload: unknown,
  now: number = Date.now(),
  options: PlanGateOptions = {},
): PlanGateResult {
  const parsed = parsePayload(rawPayload, options.codex === true);
  if (
    parsed.ok &&
    !isImplementerSpawn(parsed.payload.tool_input?.subagentType, parsed.payload.tool_input!.codex)
  ) {
    return ALLOW;
  }

  // The payload's cwd is honoured even when the rest of it is a `problem`.
  const rawCwd = isRecord(rawPayload) ? rawPayload.cwd : undefined;
  const cwd = typeof rawCwd === "string" && rawCwd !== "" ? rawCwd : process.cwd();
  const configPath = join(configRoot(cwd), "navori.config.json");
  if (!existsSync(configPath)) return ALLOW; // no config — nothing to gate
  let config: NavoriConfig;
  let configSnapshot: PlanSnapshot;
  try {
    configSnapshot = readPlanSnapshot(join(cwd, "navori.config.json"));
  } catch (cause: unknown) {
    return deny(cause instanceof Error ? cause.message : "unsafe configuration snapshot");
  }
  try {
    config = readConfig(configPath);
  } catch (cause: unknown) {
    return deny(
      `${cause instanceof Error ? cause.message : String(cause)} — fix navori.config.json, or ` +
        "update navori if the config is newer than the binary.",
    );
  }
  try {
    if (!snapshotsMatch([configSnapshot])) return deny("configuration changed during validation");
  } catch (cause: unknown) {
    return deny(cause instanceof Error ? cause.message : "unsafe configuration snapshot");
  }
  if (config.harness?.planTiers !== true) return ALLOW;
  try {
    checkoutRoot(cwd);
  } catch (cause: unknown) {
    return deny(cause instanceof Error ? cause.message : "unsafe checkout");
  }
  if (!parsed.ok) return deny(`the hook payload is unreadable (${parsed.problem}).`);
  const payload = parsed.payload;
  const toolInput = payload.tool_input!;

  const prompt = toolInput.prompt ?? "";
  let firstLine = (prompt.split("\n")[0] ?? "").trim();
  let consume: { file: string; raw: string } | undefined;
  let dispatchFeature: string | undefined;
  // Codex V2: the message is encrypted (or absent), so the opening line comes
  // from the orchestrator's dispatch file. A readable message keeps the V1 path.
  if (toolInput.codex && (firstLine === "" || ENCRYPTED_MESSAGE.test(firstLine))) {
    try {
      const dispatch = readDispatch(cwd, now, boundedSessionId(payload.sessionId));
      if ("reason" in dispatch) return deny(dispatch.reason);
      firstLine = dispatch.opening.split("\n")[0]!.trim();
      consume = { file: dispatch.file, raw: dispatch.raw };
      dispatchFeature = dispatch.feature;
    } catch (cause: unknown) {
      return deny(cause instanceof Error ? cause.message : "unsafe state root");
    }
  }
  const workplanMatch = WORKPLAN_LINE.exec(firstLine);
  const nivel0Match = NIVEL0_LINE.exec(firstLine);
  const specMatch = SPEC_LINE.exec(firstLine);
  const feature = specMatch ? `${specMatch[1]}-e${specMatch[2]}` : workplanMatch?.[1];

  if (!workplanMatch && !nivel0Match && !specMatch) return deny(NO_OPENING_LINE_REASON);
  const context: RecoveryContext = {
    opening: firstLine,
    files: [configSnapshot],
  };
  let result: PlanGateResult;
  if (nivel0Match) {
    result = evaluateNivel0(cwd, config, nivel0Match[1]!, nivel0Match[2], dispatchFeature);
  } else {
    try {
      const root = resolveStateRoot({ cwd, feature: feature! });
      if (specMatch) {
        if (dispatchFeature !== undefined && dispatchFeature !== feature) {
          return deny(
            `dispatch feature "${dispatchFeature}" does not match spec delivery "${feature}".`,
          );
        }
        result = evaluateSpec(
          root,
          config,
          specMatch[1]!,
          `E${specMatch[2]}`,
          `M${specMatch[3]}`,
          feature!,
          context,
        );
      } else {
        result = evaluateWorkplan(root, feature!, context);
      }
    } catch (cause: unknown) {
      return deny(cause instanceof Error ? cause.message : "unsafe state root");
    }
  }
  if (result.decision === "allow") {
    try {
      const burn = (unchanged: () => boolean): void => {
        if (context.binding) consumeEscalation(context.binding, unchanged);
      };
      if (consume) {
        const denied = claimDispatch(consume.file, consume.raw, now, burn);
        if (denied) return deny(denied);
      } else {
        burn(() => true);
      }
    } catch (cause: unknown) {
      return deny(cause instanceof Error ? cause.message : "escalation consumption failed");
    }
  }
  if (result.decision === "allow" && feature) {
    const dispatch: GateDispatch = {
      feature,
      cwd,
      codex: toolInput.codex,
      ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
      ...(payload.toolUseId ? { spawn: payload.toolUseId } : {}),
    };
    return { ...result, dispatch };
  }
  return result;
}

/** Retains an explicit user escalation decision after the normal scope validation, without dispatching. */
export function acknowledgePlanEscalation(
  cwd: string,
  feature: string,
  opening: string,
  decision: string,
  options: { inspect?: boolean; continuation?: ContinuationRequest } = {},
):
  | { status: "acknowledged" | "consumed"; feature: string; reference?: string }
  | EscalationInspection {
  if (options.inspect && (decision || options.continuation))
    throw new Error("inspect is mutually exclusive with mutation inputs");
  const root = resolveStateRoot({ cwd, feature });
  const configSnapshot = readPlanSnapshot(join(root.cwd, "navori.config.json"));
  const config = readConfig(join(root.cwd, "navori.config.json"));
  if (!snapshotsMatch([configSnapshot])) throw new Error("configuration changed during validation");
  if (config.harness?.planTiers !== true)
    throw new Error("plan tiers must be enabled for escalation acknowledgement");
  const context: RecoveryContext = {
    opening,
    files: [configSnapshot],
    acknowledging: true,
    inspecting: options.inspect,
  };
  const spec = SPEC_LINE.exec(opening);
  if (opening !== `workplan: ${feature}` && (!spec || `${spec[1]}-e${spec[2]}` !== feature))
    throw new Error("exact normal dispatch opening required");
  const result = spec
    ? evaluateSpec(root, config, spec[1]!, `E${spec[2]}`, `M${spec[3]}`, feature, context)
    : evaluateWorkplan(root, feature, context);
  if (result.decision !== "allow") throw new Error(result.reason);
  if (!context.binding)
    throw new Error("acknowledgement requires two recorded rejections at level 2 or 3");
  if (options.inspect) return inspectEscalation(context.binding);
  if (options.continuation)
    return continueEscalation(context.binding, decision, options.continuation);
  return acknowledgeEscalation(context.binding, decision);
}

/**
 * Logs the closed `dispatch-outcome` of an allowed spawn. Observation only:
 * every step, including the feature key and the audit-target lookup, sits
 * inside one try/catch so no failure here can change the decision the hook
 * already took (an exit other than 0/2 would turn an allow into a block).
 * Without audit context nothing beyond the cheap target lookup runs.
 */
export function emitDispatchOutcome(dispatch: GateDispatch): void {
  try {
    const sessionId = boundedSessionId(dispatch.sessionId);
    const context = sessionId
      ? {
          host: dispatch.codex ? ("codex" as const) : ("claude" as const),
          sessionId,
        }
      : undefined;
    if (!hasAuditTarget(dispatch.cwd, context)) return;
    appendCliEvent(
      dispatch.cwd,
      { name: "dispatch-outcome", verdict: "allow" },
      {
        schemaVersion: 1,
        featureKey: outcomeFeatureKey(dispatch.cwd, dispatch.feature),
        stage: "implement",
        ...(dispatch.spawn ? { spawn: dispatch.spawn } : {}),
      },
      context,
    );
  } catch {
    // Fail-open by contract.
  }
}

/**
 * The hook entry: decide, report a deny, then (on allow only) log the
 * dispatch. The emission runs after the exit code is settled and is swallowed.
 */
export function applyPlanGate(raw: unknown): void {
  const result = evaluatePlanGate(raw, Date.now(), {
    codex: process.env.NAVORI_HOOK_ENGINE === "codex",
  });
  if (result.decision === "deny") {
    process.stderr.write(`[navori] BLOCKED by plan-gate: ${result.reason}\n`);
    process.exitCode = 2;
    return;
  }
  if (result.dispatch) emitDispatchOutcome(result.dispatch);
}
