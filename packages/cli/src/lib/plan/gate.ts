/**
 * `navori plan gate` — the TypeScript half of the `PreToolUse(Agent)` hook
 * (spec 0032, R16/R17/R19). The `.sh` wrapper is a thin passthrough: it
 * resolves the `navori` binary and forwards the hook's stdin payload here
 * unchanged. Kept out of shell so the JSON/regex/hashing logic is testable
 * directly, the same split `session-start-context.sh` and its TS-driven
 * partials already use.
 */
import { existsSync, readFileSync, appendFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  checkoutRoot,
  ensureStateDirectory,
  resolveStateRoot,
  stateArtifactPath,
  type StateRoot,
} from "../primitives/state-root.ts";
import { createHash } from "node:crypto";
import { z } from "zod";
import { readConfig, type NavoriConfig } from "../config/config.ts";
import { classify } from "./classify.ts";
import { checkWorkplan, formatCheckResult } from "./check.ts";
import type { Workplan } from "./schema.ts";

export interface PlanGateResult {
  decision: "allow" | "deny";
  /** Only set on `deny` — names the skill to load and the command to run (R16). */
  reason?: string;
}

/**
 * The subset of the `Agent`/`spawn_agent` `PreToolUse` payload this gate
 * reads, for either engine (https://code.claude.com/docs/en/hooks, section
 * "Agent"; spec 0035, codex-research.md: `spawn_agent`'s `tool_input` carries
 * `agent_type` and `message` where Claude's carries `subagent_type` and
 * `prompt`). Every other field either host sends is ignored.
 */
interface AgentHookPayload {
  cwd?: string;
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
  /** The encargo's first line: `workplan: <feature>` or `nivel-0: <path>`. */
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
): { opening: string; file: string } | { reason: string } {
  const root = resolveStateRoot({ cwd, feature: "dispatch", dir: DISPATCH_DIR });
  const names = existsSync(root.path)
    ? readdirSync(root.path).filter((n) => DISPATCH_FILE.test(n))
    : [];
  const fresh: { opening: string; file: string }[] = [];
  let stale = 0;
  for (const name of names) {
    const file = stateArtifactPath(root, name);
    let parsed: Dispatch;
    try {
      parsed = DispatchSchema.parse(JSON.parse(readFileSync(file, "utf-8")));
    } catch {
      return { reason: `${file} is malformed — ${DISPATCH_FIX}.` };
    }
    if (parsed.feature !== DISPATCH_FILE.exec(name)![1]) {
      return { reason: `${file}: "feature" does not match the file name — ${DISPATCH_FIX}.` };
    }
    if (now - Date.parse(parsed.createdAt) > DISPATCH_TTL_MS) {
      stale++;
      continue;
    }
    fresh.push({ opening: parsed.opening, file });
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
  "the encargo does not open with `workplan: <feature>` or `nivel-0: <path>` — " +
  "load skill `plan-simple` (level 1) or `plan-advanced` (level 2) and produce a " +
  "workplan, or confirm a level-0 exemption with `navori plan classify <feature>`.";

/**
 * R19: append a fresh `CHANGES_REQUESTED` verdict to the append-only gate log
 * and return how many DISTINCT rejections are on record. `review_<feature>.md`
 * is overwritten on every review cycle, so counting rejections requires this
 * side log instead of counting files.
 */
function recordAndCountRejections(root: StateRoot, feature: string): number {
  const reviewPath = stateArtifactPath(root, `review_${feature}.md`);
  const logPath = stateArtifactPath(root, `workplan_${feature}.gate.jsonl`);

  const lines = existsSync(logPath)
    ? readFileSync(logPath, "utf-8")
        .split("\n")
        .filter((l) => l.trim() !== "")
    : [];
  const seenHashes = new Set(
    lines.flatMap((line) => {
      try {
        const entry = JSON.parse(line) as { reviewHash?: unknown };
        return typeof entry.reviewHash === "string" ? [entry.reviewHash] : [];
      } catch {
        return [];
      }
    }),
  );

  if (existsSync(reviewPath)) {
    const content = readFileSync(reviewPath, "utf-8");
    if (/\*\*Final verdict:\*\*\s*CHANGES_REQUESTED/.test(content)) {
      const reviewHash = createHash("sha256").update(content).digest("hex");
      if (!seenHashes.has(reviewHash)) {
        seenHashes.add(reviewHash);
        const entry = { ts: new Date().toISOString(), reviewHash, verdict: "CHANGES_REQUESTED" };
        ensureStateDirectory(root);
        appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
      }
    }
  }

  return seenHashes.size;
}

/** R19: after two recorded rejections, the third dispatch needs the next
 * level's artifacts — never a plain re-dispatch of the same level. */
function evaluateEscalation(
  root: StateRoot,
  feature: string,
  level: number,
): PlanGateResult | null {
  const rejections = recordAndCountRejections(root, feature);
  if (rejections < 2) return null;

  if (level >= 2) {
    return deny(
      `feature "${feature}" has ${rejections} recorded CHANGES_REQUESTED at level ${level} — ` +
        "escalate to the user instead of a third dispatch (orchestrator.md's cap).",
    );
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

function evaluateWorkplan(root: StateRoot, feature: string): PlanGateResult {
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
    raw = JSON.parse(readFileSync(workplanPath, "utf-8"));
  } catch (cause) {
    return deny(
      `${workplanPath} is not valid JSON (${cause instanceof Error ? cause.message : String(cause)}) ` +
        `— fix it and run \`navori plan check ${feature}\`.`,
    );
  }

  const result = checkWorkplan(raw);
  if (!result.ok) {
    return deny(
      `\`navori plan check ${feature}\` fails:\n${formatCheckResult(result)}\n` +
        "Fix it, then re-run `navori plan check " +
        feature +
        "` — skill `plan-simple`/`plan-advanced`.",
    );
  }

  const level = (raw as Pick<Workplan, "level">).level;
  return evaluateEscalation(root, feature, level) ?? ALLOW;
}

/**
 * Core decision (R16/R17/R19). Pure with respect to its inputs besides the
 * gate-log append (a deliberate, idempotent side effect — see
 * `recordAndCountRejections`). Never throws: an unexpected payload shape or a
 * config that fails to parse falls back to `allow` rather than blocking a
 * tool call the gate cannot make sense of.
 */
export function evaluatePlanGate(rawPayload: unknown, now: number = Date.now()): PlanGateResult {
  const payload = parsePayload(rawPayload);
  if (payload.tool_input?.subagentType !== "implementer") return ALLOW;

  const cwd = payload.cwd ?? process.cwd();
  let config: NavoriConfig;
  try {
    config = readConfig(join(cwd, "navori.config.json"));
  } catch {
    return ALLOW; // no config to read `harness.planTiers` from — nothing to gate
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
  // Codex V2: the message is encrypted (or absent), so the opening line comes
  // from the orchestrator's dispatch file. A readable message keeps the V1 path.
  if (payload.tool_input.codex && (firstLine === "" || ENCRYPTED_MESSAGE.test(firstLine))) {
    try {
      const dispatch = readDispatch(cwd, now);
      if ("reason" in dispatch) return deny(dispatch.reason);
      firstLine = dispatch.opening.split("\n")[0]!.trim();
      consume = dispatch.file;
    } catch (cause: unknown) {
      return deny(cause instanceof Error ? cause.message : "unsafe state root");
    }
  }
  const workplanMatch = WORKPLAN_LINE.exec(firstLine);
  const nivel0Match = NIVEL0_LINE.exec(firstLine);

  if (!workplanMatch && !nivel0Match) return deny(NO_OPENING_LINE_REASON);
  let result: PlanGateResult;
  if (nivel0Match) {
    result = evaluateNivel0(cwd, config, nivel0Match[1]!);
  } else {
    try {
      result = evaluateWorkplan(
        resolveStateRoot({ cwd, feature: workplanMatch![1]! }),
        workplanMatch![1]!,
      );
    } catch (cause: unknown) {
      return deny(cause instanceof Error ? cause.message : "unsafe state root");
    }
  }
  // One dispatch per spawn: an allowed spawn consumes its dispatch file.
  if (consume && result.decision === "allow") rmSync(consume, { force: true });
  return result;
}
