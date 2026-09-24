/**
 * `navori plan gate` — the TypeScript half of the `PreToolUse(Agent)` hook
 * (spec 0032, R16/R17/R19). The `.sh` wrapper is a thin passthrough: it
 * resolves the `navori` binary and forwards the hook's stdin payload here
 * unchanged. Kept out of shell so the JSON/regex/hashing logic is testable
 * directly, the same split `session-start-context.sh` and its TS-driven
 * partials already use.
 */
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readConfig, type NavoriConfig } from "../config/config.ts";
import { classify } from "./classify.ts";
import { checkWorkplan, formatCheckResult } from "./check.ts";
import type { Workplan } from "./schema.ts";

export interface PlanGateResult {
  decision: "allow" | "deny";
  /** Only set on `deny` — names the skill to load and the command to run (R16). */
  reason?: string;
}

/** The subset of the `Agent` `PreToolUse` payload this gate reads
 * (https://code.claude.com/docs/en/hooks, section "Agent"). Every other field
 * Claude Code sends is ignored. */
interface AgentHookPayload {
  cwd?: string;
  tool_input?: {
    subagent_type?: string;
    prompt?: string;
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
  return {
    cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
    tool_input: toolInput
      ? {
          subagent_type:
            typeof toolInput.subagent_type === "string" ? toolInput.subagent_type : undefined,
          prompt: typeof toolInput.prompt === "string" ? toolInput.prompt : undefined,
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

const NO_OPENING_LINE_REASON =
  "the encargo does not open with `workplan: <feature>` or `nivel-0: <path>` — " +
  "load skill `plan-simple` (level 1) or `plan-advanced` (level 2) and produce a " +
  "workplan, or confirm a level-0 exemption with `navori plan classify <feature>`.";

function progressDir(cwd: string): string {
  return join(cwd, ".claude/progress");
}

/**
 * R19: append a fresh `CHANGES_REQUESTED` verdict to the append-only gate log
 * and return how many DISTINCT rejections are on record. `review_<feature>.md`
 * is overwritten on every review cycle, so counting rejections requires this
 * side log instead of counting files.
 */
function recordAndCountRejections(cwd: string, feature: string): number {
  const reviewPath = join(progressDir(cwd), `review_${feature}.md`);
  const logPath = join(progressDir(cwd), `workplan_${feature}.gate.jsonl`);

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
        appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
      }
    }
  }

  return seenHashes.size;
}

/** R19: after two recorded rejections, the third dispatch needs the next
 * level's artifacts — never a plain re-dispatch of the same level. */
function evaluateEscalation(cwd: string, feature: string, level: number): PlanGateResult | null {
  const rejections = recordAndCountRejections(cwd, feature);
  if (rejections < 2) return null;

  if (level >= 2) {
    return deny(
      `feature "${feature}" has ${rejections} recorded CHANGES_REQUESTED at level ${level} — ` +
        "escalate to the user instead of a third dispatch (orchestrator.md's cap).",
    );
  }

  const solutionPath = join(progressDir(cwd), `solution_${feature}.md`);
  const solutionReviewPath = join(progressDir(cwd), `solution_review_${feature}.md`);
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

function evaluateWorkplan(cwd: string, feature: string): PlanGateResult {
  const workplanPath = join(progressDir(cwd), `workplan_${feature}.json`);
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
  return evaluateEscalation(cwd, feature, level) ?? ALLOW;
}

/**
 * Core decision (R16/R17/R19). Pure with respect to its inputs besides the
 * gate-log append (a deliberate, idempotent side effect — see
 * `recordAndCountRejections`). Never throws: an unexpected payload shape or a
 * config that fails to parse falls back to `allow` rather than blocking a
 * tool call the gate cannot make sense of.
 */
export function evaluatePlanGate(rawPayload: unknown): PlanGateResult {
  const payload = parsePayload(rawPayload);
  if (payload.tool_input?.subagent_type !== "implementer") return ALLOW;

  const cwd = payload.cwd ?? process.cwd();
  let config: NavoriConfig;
  try {
    config = readConfig(join(cwd, "navori.config.json"));
  } catch {
    return ALLOW; // no config to read `harness.planTiers` from — nothing to gate
  }
  if (config.harness?.planTiers !== true) return ALLOW;

  const prompt = payload.tool_input.prompt ?? "";
  const firstLine = (prompt.split("\n")[0] ?? "").trim();
  const workplanMatch = WORKPLAN_LINE.exec(firstLine);
  const nivel0Match = NIVEL0_LINE.exec(firstLine);

  if (!workplanMatch && !nivel0Match) return deny(NO_OPENING_LINE_REASON);
  if (nivel0Match) return evaluateNivel0(cwd, config, nivel0Match[1]!);
  return evaluateWorkplan(cwd, workplanMatch![1]!);
}
