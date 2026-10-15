/**
 * `navori plan gate` — the TypeScript half of the `PreToolUse(Agent)` hook
 * (spec 0032, R16/R17/R19). The `.sh` wrapper is a thin passthrough: it
 * resolves the `navori` binary and forwards the hook's stdin payload here
 * unchanged. Kept out of shell so the JSON/regex/hashing logic is testable
 * directly, the same split `session-start-context.sh` and its TS-driven
 * partials already use.
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  checkoutRoot,
  resolveStateRoot,
  stateArtifactPath,
  type StateRoot,
} from "../primitives/state-root.ts";
import { z } from "zod";
import { readConfig, type NavoriConfig } from "../config/config.ts";
import { classify } from "./classify.ts";
import { checkWorkplan, formatCheckResult } from "./check.ts";
import type { Workplan } from "./schema.ts";
import { appendCliEvent, hasAuditTarget, outcomeFeatureKey } from "../audit/cli-event.ts";
import { locateSpecDir } from "../spec/locate.ts";
import { parseTasks } from "../spec/tasks.ts";
import {
  acknowledgeEscalation,
  consumeEscalation,
  escalationBinding,
  readPlanSnapshot,
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

/** Loosely parses the hook payload — a malformed/foreign shape reads as "no
 * fields present", which the caller treats as "not our concern" (allow), not
 * as a crash. A hard gate must never break the tool call it cannot recognize. */
function parsePayload(raw: unknown): AgentHookPayload {
  if (!isRecord(raw)) return {};
  const toolInput = isRecord(raw.tool_input) ? raw.tool_input : undefined;
  const codexAgentType =
    typeof toolInput?.agent_type === "string" ? toolInput.agent_type : undefined;
  return {
    cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
    sessionId: typeof raw.session_id === "string" ? raw.session_id : undefined,
    toolUseId:
      typeof raw.tool_use_id === "string" && SPAWN_ID.test(raw.tool_use_id)
        ? raw.tool_use_id
        : undefined,
    tool_input: toolInput
      ? {
          subagentType:
            codexAgentType ??
            (typeof toolInput.subagent_type === "string" ? toolInput.subagent_type : undefined),
          prompt:
            (typeof toolInput.message === "string" ? toolInput.message : undefined) ??
            (typeof toolInput.prompt === "string" ? toolInput.prompt : undefined),
          codex: codexAgentType !== undefined,
        }
      : undefined,
  };
}

function deny(reason: string): PlanGateResult {
  return { decision: "deny", reason };
}

const ALLOW: PlanGateResult = { decision: "allow" };

const WORKPLAN_LINE = /^workplan:\s*(\S+)/;
const NIVEL0_LINE = /^nivel-0:\s*(\S+)/;
const SPEC_LINE = /^spec:\s*([a-z0-9][a-z0-9._-]*)\s+E([1-9][0-9]*)\s+M([1-9][0-9]*)$/;

/** A Fernet token (what Codex's V2 `spawn_agent` sends in place of `message`). */
const ENCRYPTED_MESSAGE = /^gAAAAA[A-Za-z0-9_=-]*$/;

/** How long a dispatch file stays valid after `createdAt` (spec 0041 R9, OQ2). */
export const DISPATCH_TTL_MS = 10 * 60 * 1000;
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
});
export type Dispatch = z.infer<typeof DispatchSchema>;

const DISPATCH_FIX =
  "the orchestrator must write `.navori/state/handoffs/dispatch_<feature>.json` " +
  '({"feature","opening":"workplan: <feature>","createdAt":<ISO now>}) right before ' +
  "spawning the implementer, and keep exactly one fresh dispatch (TTL 10 min)";

/**
 * Reads the opening line of the single fresh dispatch file. The feature cannot
 * be taken from the (encrypted) message, so the rule is: exactly ONE valid,
 * non-stale dispatch file may exist; zero, several or any malformed one denies
 * rather than guessing. Returns the opening line plus the file to consume.
 */
function readDispatch(
  cwd: string,
  now: number,
): { opening: string; file: string; feature: string; snapshot: PlanSnapshot } | { reason: string } {
  const root = resolveStateRoot({
    cwd,
    feature: "dispatch",
    dir: DISPATCH_DIR,
  });
  const names = existsSync(root.path)
    ? readdirSync(root.path).filter((n) => DISPATCH_FILE.test(n))
    : [];
  const fresh: {
    opening: string;
    file: string;
    feature: string;
    snapshot: PlanSnapshot;
  }[] = [];
  let stale = 0;
  for (const name of names) {
    const file = stateArtifactPath(root, name);
    let parsed: Dispatch;
    const snapshot = readPlanSnapshot(file);
    try {
      parsed = DispatchSchema.parse(JSON.parse(snapshot.content ?? ""));
    } catch {
      return { reason: `${file} is malformed — ${DISPATCH_FIX}.` };
    }
    if (parsed.feature !== DISPATCH_FILE.exec(name)![1]) {
      return {
        reason: `${file}: "feature" does not match the file name — ${DISPATCH_FIX}.`,
      };
    }
    if (now - Date.parse(parsed.createdAt) > DISPATCH_TTL_MS) {
      stale++;
      continue;
    }
    fresh.push({
      opening: parsed.opening,
      file,
      feature: parsed.feature,
      snapshot,
    });
  }
  if (fresh.length === 1) return fresh[0]!;
  if (fresh.length > 1) {
    return {
      reason: `${fresh.length} fresh dispatch files exist, the gate will not guess which one — ${DISPATCH_FIX}.`,
    };
  }
  return {
    reason:
      (stale > 0
        ? `the dispatch file is stale (older than 10 min) — `
        : "the spawn message is encrypted and no dispatch file exists — ") + `${DISPATCH_FIX}.`,
  };
}

const NO_OPENING_LINE_REASON =
  "the encargo does not open with `workplan: <feature>`, `nivel-0: <path>` or `spec: <spec> E<n> M<n>` — " +
  "load skill `plan-simple` (level 1) or `plan-advanced` (level 2) and produce a " +
  "workplan, or confirm a level-0 exemption with `navori plan classify <feature>`.";

/** R19: after two recorded rejections, the third dispatch needs the next
 * level's artifacts — never a plain re-dispatch of the same level. */
function evaluateEscalation(
  root: StateRoot,
  feature: string,
  level: number,
  context: RecoveryContext,
): PlanGateResult | null {
  const history = recordRejections(root, feature);
  const rejections = history.hashes.length;
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
    if (!context.acknowledging) requireAcknowledgement(context.binding);
    return ALLOW;
  }

  const solutionPath = stateArtifactPath(root, `solution_${feature}.md`);
  const solutionReviewPath = stateArtifactPath(root, `solution_review_${feature}.md`);
  if (!existsSync(solutionPath) || !existsSync(solutionReviewPath)) {
    return deny(
      `feature "${feature}" has ${rejections} recorded CHANGES_REQUESTED — produce ` +
        `solution_${feature}.md and its challenge (solution_review_${feature}.md) before ` +
        "the next dispatch, skill `plan-advanced`.",
    );
  }
  return null;
}

/**
 * `nivel-0: <path>` accepts a comma-separated list (no spaces, so it stays
 * one token the opening-line regex can capture) — R4's "at most one
 * non-trivial file" only means something to verify when more than one
 * candidate file is on the table.
 */
function evaluateNivel0(cwd: string, config: NavoriConfig, rawPath: string): PlanGateResult {
  const files = rawPath.split(",").filter((f) => f.length > 0);
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
  return ALLOW;
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

  const result = checkWorkplan(raw, root.cwd);
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
 * `recordRejections`). Never throws: an unexpected payload shape or a
 * config that fails to parse falls back to `allow` rather than blocking a
 * tool call the gate cannot make sense of.
 */
export function evaluatePlanGate(rawPayload: unknown, now: number = Date.now()): PlanGateResult {
  const payload = parsePayload(rawPayload);
  if (payload.tool_input?.subagentType !== "implementer") return ALLOW;

  const cwd = payload.cwd ?? process.cwd();
  let config: NavoriConfig;
  let configSnapshot: PlanSnapshot;
  try {
    configSnapshot = readPlanSnapshot(join(cwd, "navori.config.json"));
  } catch (cause: unknown) {
    return deny(cause instanceof Error ? cause.message : "unsafe configuration snapshot");
  }
  try {
    config = readConfig(join(cwd, "navori.config.json"));
  } catch {
    return ALLOW; // no config to read `harness.planTiers` from — nothing to gate
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

  const prompt = payload.tool_input.prompt ?? "";
  let firstLine = (prompt.split("\n")[0] ?? "").trim();
  let consume: string | undefined;
  let dispatchSnapshot: PlanSnapshot | undefined;
  let dispatchFeature: string | undefined;
  // Codex V2: the message is encrypted (or absent), so the opening line comes
  // from the orchestrator's dispatch file. A readable message keeps the V1 path.
  if (payload.tool_input.codex && (firstLine === "" || ENCRYPTED_MESSAGE.test(firstLine))) {
    try {
      const dispatch = readDispatch(cwd, now);
      if ("reason" in dispatch) return deny(dispatch.reason);
      firstLine = dispatch.opening.split("\n")[0]!.trim();
      consume = dispatch.file;
      dispatchSnapshot = dispatch.snapshot;
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
    result = evaluateNivel0(cwd, config, nivel0Match[1]!);
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
  // A replaced marker is never treated as the validated dispatch. Checks precede the burn.
  if (result.decision === "allow") {
    try {
      const markerUnchanged = (): boolean => {
        if (!dispatchSnapshot) return true;
        const current = readDispatch(cwd, now);
        return (
          !("reason" in current) && current.file === consume && snapshotsMatch([dispatchSnapshot])
        );
      };
      if (!markerUnchanged()) return deny("dispatch marker changed during validation");
      if (context.binding) consumeEscalation(context.binding, markerUnchanged);
      if (consume) {
        if (!markerUnchanged()) return deny("dispatch marker changed before removal");
        rmSync(consume, { force: true });
      }
    } catch (cause: unknown) {
      return deny(cause instanceof Error ? cause.message : "escalation consumption failed");
    }
  }
  if (result.decision === "allow" && feature) {
    const dispatch: GateDispatch = {
      feature,
      cwd,
      codex: payload.tool_input.codex,
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
): { status: "acknowledged" | "consumed"; feature: string } {
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
    const context = dispatch.sessionId
      ? {
          host: dispatch.codex ? ("codex" as const) : ("claude" as const),
          sessionId: dispatch.sessionId,
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
  const result = evaluatePlanGate(raw);
  if (result.decision === "deny") {
    process.stderr.write(`[navori] BLOCKED by plan-gate: ${result.reason}\n`);
    process.exitCode = 2;
    return;
  }
  if (result.dispatch) emitDispatchOutcome(result.dispatch);
}
