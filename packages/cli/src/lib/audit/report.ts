import { createHash } from "node:crypto";
import { type HarnessCatalog, barredMcpTokens, reaches } from "./harness.ts";
import {
  type AgentRun,
  type AuditReport,
  type HookEvent,
  type InjectedContext,
  type RepoRow,
  type SessionAudit,
  type SkillSource,
  type SkillTally,
  type TokenTotals,
  type MetricEvidence,
  type MetricPopulation,
  type NullableMeasurements,
  type PublishedAuditReport,
  type CodexUsageComponent,
  type CodexResponseFact,
  type AuditReadBudget,
  createAuditReadBudget,
  retainAuditFact,
  addTokens,
  emptyTokens,
  recorderWindow,
} from "./model.ts";
import { joinOutcomes, outcomeKinds } from "./outcomes.ts";
import { redactExample } from "./parse.ts";
import {
  ACTIVATION_TRIGGERS,
  minerMetricKey,
  harnessRegime,
  hookMisfires,
  reviewerGateLifecycle,
  unusedManagedCandidates,
  type Lang,
} from "./signals.ts";

/** Explicit per-generation opt-in; the CLI must validate a private file first. */
export interface AuditPublicationOptions {
  includeHumanContent?: boolean;
}

/**
 * Field names published ONLY inside the `outcomes` subtree (spec 0042 T9b).
 * Scoped on purpose: these generic names must not change publication
 * behavior anywhere else in the report.
 */
const PUBLIC_OUTCOME_FIELDS = new Set<string>([
  "outcomes",
  "tasks",
  "feature",
  "episodes",
  "boundary",
  "leftCensored",
  "reviews",
  "rounds",
  "approved",
  "correlated",
  "uncorrelatedByReason",
  "receipts",
  "observations",
  "ok",
  "fresh",
  "stale",
  "findings",
  "error",
  "unstable",
  "accepted",
  "acceptedAtMs",
  "provenance",
  "hosts",
  "duplicates",
  "open",
  "ambiguous",
]);
/** Closed label values published only inside the `outcomes` subtree. */
const PUBLIC_OUTCOME_LABELS = new Set<string>([
  "receipt-outcome",
  "ok",
  "findings",
  "error",
  "known",
  "ambiguous",
  "changed-after-review",
  "changed-during-review",
  "missing",
  "invalid",
  "unknown-algorithm",
  "unavailable",
]);
/** The only availability keys that name an outcomes join. */
const PUBLIC_OUTCOME_AVAILABILITY = new Set(["outcomes.review", "outcomes.receipt"]);
const PUBLIC_AUDIT_FIELDS = new Set<string>([
  "activeMs",
  "activityAvailability",
  "actor",
  "adapter",
  "agentDurationMs",
  "agentId",
  "agentType",
  "agentWallClockMs",
  "agents",
  "at",
  "attributedOutputTokens",
  "attributedRecords",
  "audited",
  "automatic",
  "availability",
  "availabilityByAgentType",
  "blindMinutes",
  "browsed",
  "budget",
  "byAgentType",
  "byModel",
  "bySource",
  "bytesRead",
  "cacheCreation",
  "cacheRead",
  "capturedAt",
  "ccVersions",
  "chars",
  "checkout",
  "classifierExemptBash",
  "classifierExemptBashByMode",
  "cliEvents",
  "cliVersion",
  "codex",
  "compactions",
  "completeLines",
  "contextPeak",
  "contributors",
  "count",
  "coverage",
  "coveredPercent",
  "description",
  "diagnostics",
  "durationMs",
  "editMiss",
  "eligible",
  "endReason",
  "endedAt",
  "event",
  "events",
  "evidence",
  "fields",
  "firstTs",
  "frictionEvents",
  "from",
  "generatedAt",
  "generatedBy",
  "gitBranch",
  "handle",
  "harnessBlock",
  "health",
  "hookEvents",
  "hookLogFrom",
  "host",
  "hostSkills",
  "human",
  "id",
  "identity",
  "incompleteTail",
  "inherited",
  "initialPrompt",
  "input",
  "invalid",
  "invalidUtf8",
  "invoked",
  "kind",
  "lastTs",
  "limits",
  "lines",
  "linesRead",
  "location",
  "malformedJson",
  "maxLineBytes",
  "mcpBarredTokens",
  "mcpCalls",
  "mcpInjectedContext",
  "mcpReach",
  "model",
  "models",
  "ms",
  "name",
  "navori",
  "navoriAtStop",
  "normalizationLoss",
  "normalizedOmissions",
  "observed",
  "observedArtifactWrites",
  "observedAt",
  "omitted",
  "omittedFacts",
  "omittedLowerBound",
  "orchestrator",
  "orphanSessions",
  "otelFrom",
  "other",
  "outcome",
  "output",
  "outputTokens",
  "overlapsWith",
  "oversizedLines",
  "ownWindow",
  "ownerAgentId",
  "ownerAgentType",
  "ownerKey",
  "parseErrors",
  "partial",
  "pathsPerReport",
  "permissionDenied",
  "permissionModes",
  "permissions",
  "phase",
  "policy",
  "prompts",
  "prs",
  "range",
  "rangeMetrics",
  "rangeSignals",
  "reading",
  "reason",
  "records",
  "relation",
  "repo",
  "repos",
  "retainedFacts",
  "retainedObjects",
  "retainedPaths",
  "retainedSessions",
  "rollout",
  "schemaVersion",
  "sealed",
  "sessionEntries",
  "sessionId",
  "sessions",
  "severity",
  "shellFailure",
  "shellReads",
  "shellWrites",
  "signals",
  "skillAttributionRecords",
  "skills",
  "skillsDiscarded",
  "skillsRead",
  "slug",
  "source",
  "sourceHeaderFingerprint",
  "sourceStatus",
  "sourceVersion",
  "sources",
  "spawnDepth",
  "startedAt",
  "startupTokens",
  "state",
  "status",
  "stoppedEarly",
  "summary",
  "thinking",
  "timestampBytes",
  "to",
  "tokens",
  "tool",
  "toolCalls",
  "toolCounts",
  "toolCountsByMode",
  "toolErrorTypes",
  "toolErrors",
  "toolResultBytes",
  "toolUnavailable",
  "toolUseId",
  "total",
  "totals",
  "truncated",
  "ts",
  "tsMs",
  "turnLimitHit",
  "turns",
  "unavailable",
  "unsupported",
  "usage",
  "usageAvailability",
  "validRecords",
  "values",
  "verdict",
  "wallClockMs",
  "from",
  "to",
  "limits",
  "maxLineBytes",
  "eventsPerSession",
  "sessionsPerReport",
  "pathsPerReport",
  "factsPerReport",
  "technicalBytes",
  "timestampBytes",
  "pathBytes",
  "normalizedFactBytes",
]);
const PUBLIC_TECHNICAL_LABELS = new Set([
  "review-outcome",
  "approved",
  "changes-requested",
  "orchestrator",
  "main-thread",
  "implementer",
  "reviewer",
  "architect",
  "auditor",
  "scout",
  "scribe",
  "publisher",
  "explorer",
  "worker",
  "researcher",
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Agent",
  "Task",
  "Skill",
  "WebFetch",
  "WebSearch",
  "NotebookEdit",
  "exec_command",
  "exec",
  "apply_patch",
  "spawn_agent",
  "wait",
  "send_input",
  "claude",
  "codex",
  "core",
  "engram",
  "codegraph",
  "tgrep",
  "semgrep",
  "jscpd",
  "config",
  "hook",
  "user_permanent",
  "user_temporary",
  "user_reject",
  "user_abort",
  "observed",
  "partial",
  "unavailable",
  "unsupported",
  "invalid",
  "not-observed",
  "malformed",
  "live-tail",
  "ownership-unknown",
  "unsealed",
  "unsupported-component",
  "empty-population",
  "incomplete-enumeration",
  "identity-conflict",
  "transcript",
  "rollout",
  "audit-log",
  "otlp",
  "host-metadata",
  "aggregate",
  "claude-transcript",
  "codex-rollout",
  "missing",
  "unreadable",
  "unsafe",
  "changed",
  "allow",
  "ask",
  "block",
  "deny",
  "skip",
  "noop",
  "clean",
  "dirty",
  "inject",
  "repeat",
  "hard",
  "advisory",
  "unknown",
  "other",
  "clear",
  "logout",
  "prompt_input_exit",
  "bypass_permissions_disabled",
  "unspecified",
  "PreToolUse",
  "PostToolUse",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "UserPromptSubmit",
  "PreCompact",
  "APPROVED",
  "CHANGES_REQUESTED",
  "high",
  "medium",
  "low",
  "critical",
  "warning",
  "info",
  "auto",
  "plan",
  "default",
  "acceptEdits",
  "bypassPermissions",
  "dontAsk",
  "user",
  "typed",
  "queued",
  "parsed",
  "measured",
  "observed-only",
  "native-write",
  "native-edit",
  "native-notebook-edit",
  "success",
  "failed",
  "repo-relative",
  "outside-workspace",
  "redacted",
  "guard-destructive",
  "check-semgrep",
  "subagent-stop-handoff",
  "model-advisor",
  "managed-drift-watch",
  "bash-outcome-watch",
  "plan-update-evidence",
  "playwright",
  "structural-search",
  "skill-tool",
  "skill-md",
  "attribution",
  "mem_save",
  "mem_search",
  "mem_get_observation",
  "mem_context",
  "mem_session_start",
  "mem_session_end",
  "mem_session_summary",
  "mem_save_prompt",
  "accept",
  "reject",
  "advise",
]);
const PUBLIC_MAP_FIELDS = new Set([
  "models",
  "toolCounts",
  "toolCountsByMode",
  "classifierExemptBashByMode",
  "mcpCalls",
  "mcpReach",
  "mcpBarredTokens",
  "mcpInjectedContext",
  "permissionModes",
  "toolErrorTypes",
  "bySource",
  "byAgentType",
  "byModel",
  "availabilityByAgentType",
  "availability",
  "rangeMetrics",
  "toolCalls",
  "toolResultBytes",
]);
const PUBLIC_SOURCE_FIELDS = new Set([
  "transcript",
  "rollout",
  "audit-log",
  "otlp",
  "host-metadata",
]);

/** Unknown labels are opaque categories, never short arbitrary user strings. */
function publicLabel(value: string, inOutcomes = false): string {
  if (PUBLIC_TECHNICAL_LABELS.has(value)) return value;
  if (inOutcomes && PUBLIC_OUTCOME_LABELS.has(value)) return value;
  if (/^unknown-[a-f0-9]{12}$/.test(value)) return value;
  if (
    /^(?:claude-(?:opus|sonnet|haiku|fable|mythos)-[0-9](?:-[0-9])?(?:-\d{8})?|gpt-[0-9](?:\.[0-9])?(?:-(?:sol|astra|luna|mini|nano))?|o[1-9](?:-mini)?|plugin:(?:engram|codegraph|tgrep|semgrep|jscpd))$/.test(
      value,
    )
  )
    return value;
  return `unknown-${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

/** Metric keys have a fixed vocabulary; unrecognized segments become opaque. */
function publicMapKey(value: string, family: string, inOutcomes = false): string {
  if (family !== "rangeMetrics" && family !== "availability") return publicLabel(value, inOutcomes);
  if (value === "coverage.pct") return value;
  if (family === "availability" && PUBLIC_OUTCOME_AVAILABILITY.has(value)) return value;
  if (value.startsWith("mining.") && minerMetricKey(value)) return value;
  const [activation, trigger, measurement, extra] = value.split(".");
  if (
    activation === "activation" &&
    extra === undefined &&
    (trigger === "total" || ACTIVATION_TRIGGERS.some(({ id }) => id === trigger)) &&
    ["opportunities", "hits", "pct"].includes(measurement ?? "")
  )
    return value;
  const vocabulary = new Set(
    "tokens input output cacheRead cacheCreation thinking tools hooks wallClockMs activeMs startupTokens session sessions agent launches web fetch turns compactions turnLimitHits resultBytes calls callsMain callsAgents p50 p90 n observed partial eligible unavailable unsupported invalid coverage activation search edits codegraph mechanism codex execWrappers skill outputTokens perBashCall blocks fires tollMs tollEvents ungroupedFires bashCalls bashTranscriptCalls bashCoveragePct mainPct".split(
      " ",
    ),
  );
  return value
    .split(".")
    .map((part: string) =>
      vocabulary.has(part) || PUBLIC_AUDIT_FIELDS.has(part) ? part : publicLabel(part),
    )
    .join(".");
}

/** Construct only allowlisted fields/values; raw objects are never spread into publication. */
function metadataPublication(
  value: AuditReport,
  options: AuditPublicationOptions = {},
): AuditReport {
  const seen = new WeakSet<object>();
  const project = (input: unknown, key: string, parent: string, inOutcomes = false): unknown => {
    if (["captured", "ratio"].includes(key))
      return parent === "coverage" &&
        (input === null || (typeof input === "number" && Number.isFinite(input)))
        ? input
        : undefined;
    if (
      typeof input === "number" ||
      typeof input === "boolean" ||
      input === null ||
      input === undefined
    )
      return input;
    if (typeof input === "string") {
      if (
        (key === "initialPrompt" && parent === "sessions") ||
        (key === "description" && parent === "agents")
      )
        return options.includeHumanContent ? redactExample(input).slice(0, 300) : "";
      if (["summary", "evidence"].includes(key))
        return "Metadata-only finding; human details withheld.";
      if (["gitBranch", "cwd"].includes(key)) return null;
      if (["sessionId", "agentId", "toolUseId", "actor"].includes(key))
        return /^[A-Za-z0-9_-]{1,256}$/.test(input) ? input : "unknown";
      if (
        [
          "startedAt",
          "endedAt",
          "generatedAt",
          "capturedAt",
          "at",
          "from",
          "to",
          "hookLogFrom",
          "otelFrom",
        ].includes(key)
      )
        return /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(input) ? input : "";
      if (["version", "rendered", "cli", "sourceVersion", "ccVersions"].includes(key))
        return /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(input) ? input : "unknown";
      if (key === "generatedBy")
        return /^navori@\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(input)
          ? input
          : "navori@unknown";
      if (key === "path")
        return parent === "location" &&
          ["navori.config.json", "AGENTS.md", "CLAUDE.md"].includes(input)
          ? input
          : "redacted";
      return publicLabel(input, inOutcomes);
    }
    if (Array.isArray(input))
      return input.map((item: unknown) => project(item, key, parent, inOutcomes));
    if (typeof input !== "object") return undefined;
    if (seen.has(input)) return input;
    seen.add(input);
    const out = input as Record<string, unknown>;
    const dynamic =
      PUBLIC_MAP_FIELDS.has(key) ||
      (inOutcomes && key === "uncorrelatedByReason") ||
      parent === "mcpCalls" ||
      parent === "toolCountsByMode" ||
      parent === "availabilityByAgentType";
    for (const [child, item] of Object.entries(input)) {
      delete out[child];
      const childInOutcomes = inOutcomes || (key === "" && child === "outcomes");
      if (["ownerKey", "sourceHeaderFingerprint", "sourcePath", "identity"].includes(child))
        continue;
      if (["responses", "activity", "blockedCommands", "repeatedCommands"].includes(child)) {
        out[child] = Array.isArray(item) ? [] : {};
        continue;
      }
      const providerField =
        ["usage", "usageAvailability"].includes(key) &&
        [
          "inputTotal",
          "ordinaryInput",
          "cacheRead",
          "cacheWrite",
          "output",
          "reasoning",
          "totalTokens",
        ].includes(child);
      const locationField = key === "location" && child === "path";
      const contextField =
        (key === "coverage" && ["captured", "ratio"].includes(child)) ||
        (key === "sources" && PUBLIC_SOURCE_FIELDS.has(child)) ||
        ((key === "navori" || key === "navoriAtStop") && ["rendered", "cli"].includes(child)) ||
        (key === "prompts" && ["typed", "queued", "queuedSystem"].includes(child));
      if (
        !dynamic &&
        !PUBLIC_AUDIT_FIELDS.has(child) &&
        !(childInOutcomes && PUBLIC_OUTCOME_FIELDS.has(child)) &&
        !providerField &&
        !locationField &&
        !contextField
      )
        continue;
      const projected = project(item, child, key, childInOutcomes);
      if (projected !== undefined)
        out[
          dynamic
            ? publicMapKey(
                child,
                parent === "availabilityByAgentType" ? "availability" : key,
                inOutcomes,
              )
            : child
        ] = projected;
    }
    // Required empty maps remain useful to historical renderers; their content
    // is deliberately absent, not an authorization to serialize scripts.
    if ("repeatedCommands" in input) out.repeatedCommands = {};
    if ("blockedCommands" in input) out.blockedCommands = {};
    if ("responses" in input) out.responses = [];
    if ("activity" in input) out.activity = [];
    return out;
  };
  const copy = structuredClone(value);
  project(copy, "", "");
  return copy;
}

/**
 * Renders a parsed audit into its two derived artifacts.
 *
 * Both are regenerable from the append-only session log plus the transcript,
 * so neither is ever mutated in place — a report that looks wrong is fixed by
 * re-running the generator, never by editing the file.
 */

function k(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  return `${Math.round((part / whole) * 100)}%`;
}

function minutes(ms: number): string {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

function t(lang: Lang, es: string, en: string): string {
  return lang === "es" ? es : en;
}

/**
 * `output` tokens cost 5x an input token across the whole pricing table,
 * retired models included — verified 2026-09-22 against
 * https://platform.claude.com/docs/en/about-claude/pricing.
 */
const OUTPUT_MULTIPLIER = 5;

/**
 * Cache-write multiplier applied to `TokenTotals.cacheCreation`.
 *
 * Approximation, declared: the pricing table splits cache writes by TTL — 5
 * minutes at 1.25x, 1 hour at 2x — but `cache_creation_input_tokens` (and so
 * `TokenTotals.cacheCreation`) sums both without saying which TTL was used.
 * Using 1.25x UNDERSTATES any session that used 1h caching; there is no field
 * on the transcript's `usage` block to split them without re-parsing for a TTL
 * hint it does not carry today.
 */
const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * Cache-read multiplier, the standard rate the pricing docs state for "all
 * other models" — verified 2026-09-22.
 */
const CACHE_READ_MULTIPLIER_DEFAULT = 0.1;

/**
 * Per-model cache-read multiplier overrides (verified 2026-09-22): Claude
 * Fable 5.1 and Claude Mythos 5.1 bill cache hits at 0.025x, Claude Opus 5.5
 * at 0.05x. Matched by substring against the model id Claude Code stamps on
 * the transcript, because navori has no catalog mapping ids to the docs'
 * marketing names. An id that matches none of these falls back to the
 * default rather than guessing.
 */
const CACHE_READ_MULTIPLIER_OVERRIDES: Record<string, number> = {
  "fable-5-1": 0.025,
  "mythos-5-1": 0.025,
  "opus-5-5": 0.05,
};

function cacheReadMultiplier(model: string | null): number {
  if (!model) return CACHE_READ_MULTIPLIER_DEFAULT;
  const id = model.toLowerCase();
  for (const [needle, mult] of Object.entries(CACHE_READ_MULTIPLIER_OVERRIDES)) {
    if (id.includes(needle)) return mult;
  }
  return CACHE_READ_MULTIPLIER_DEFAULT;
}

/**
 * Tokens weighted into input-token equivalents. NOT a dollar figure and NOT a
 * price table — the multipliers are the pricing table's stable RATIOS, which
 * outlive an actual price change.
 *
 * The previous `billable()` excluded `cache_read` entirely: unweighted, it
 * reaches hundreds of millions on a long session and would drown every other
 * figure in the same table. That made the number wrong instead of merely
 * loud — `cache_read` is real, billed spend at (usually) 0.1x an input token,
 * never "not new spend". Weighting it down to its real proportion is what
 * lets it stay in the headline instead of being read separately with a caveat
 * that was not true.
 *
 * `thinking` stays excluded for the same reason it always was — it is already
 * IN `output`, not a fourth addend. Measured over the 1028 assistant messages
 * of transcript `4935c4d7` (CC 2.1.236): `output_tokens_details.thinking_tokens
 * <= output_tokens` in 100% of them.
 *
 * NOT modeled: `inference_geo: "us"` (1.1x on every counter) and fast mode
 * (doubles Opus 5's base rate) — neither is exposed on the transcript's usage
 * block today, so there is nothing to key an override on.
 */
export function weightedTokens(t: TokenTotals, model: string | null): number {
  return (
    t.input +
    t.output * OUTPUT_MULTIPLIER +
    t.cacheCreation * CACHE_WRITE_MULTIPLIER +
    t.cacheRead * cacheReadMultiplier(model)
  );
}

/**
 * `input + output + cacheCreation`, excluding `cache_read` — the OLD
 * `billable()` formula, kept private and renamed because it now serves a
 * different job: it is the basis for the raw "where did the tokens go"
 * breakdown (`spendBreakdown`, the per-card "context" row), not a headline
 * cost figure. Weighting changes the scale of `output` and `cacheCreation`
 * against `input`, so subtracting a weighted total from a raw `startupTokens`
 * or a raw `output` would silently misattribute the remainder.
 */
function rawSpend(t: TokenTotals): number {
  return t.input + t.output + t.cacheCreation;
}

/**
 * Every tool call across the orchestrator and every subagent — the
 * denominator for `cache_read`'s normalized figure (see `spendBreakdown` and
 * `agentCard`). Chosen over "turns" because the model exposes tool-call
 * counts (`toolCounts`) directly; a turn count would require re-parsing the
 * transcript for something not already captured.
 */
function toolCallCount(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

/**
 * The model whose messages dominate a session, for weighting an aggregate
 * that spans the orchestrator and every subagent.
 *
 * Approximation, declared: of the four multipliers, only `cache_read` varies
 * by model in the verified table (input/output/cache-write are uniform across
 * the whole range), and only for three rare models. Picking the busiest model
 * mis-weights `cache_read` alone, and only on a session that mixed one of
 * those with anything else — a narrow, stated blind spot rather than a silent
 * one.
 */
function topModelOf(models: Record<string, number>): string | null {
  const top = Object.entries(models).sort(([, x], [, y]) => y - x)[0];
  return top?.[0] ?? null;
}

function dominantModel(s: SessionAudit): string | null {
  const counts: Record<string, number> = { ...s.orchestrator.models };
  for (const a of s.agents) {
    if (a.model) counts[a.model] = (counts[a.model] ?? 0) + 1;
  }
  return topModelOf(counts);
}

function sessionTokens(s: SessionAudit): TokenTotals {
  return s.agents.reduce((acc, a) => addTokens(acc, a.tokens), s.orchestrator.tokens);
}

/** The headline table: where the tokens went, by concept. */
function spendBreakdown(s: SessionAudit, lang: Lang): string {
  const total = sessionTokens(s);
  const model = dominantModel(s);
  const startup =
    s.agents.reduce((sum, a) => sum + a.startupTokens, 0) + s.orchestrator.startupTokens;
  const reasoning = total.output;
  const raw = rawSpend(total);
  const rest = Math.max(0, raw - startup - reasoning);
  const weighted = weightedTokens(total, model);
  const cacheReadWeighted = total.cacheRead * cacheReadMultiplier(model);
  const toolCalls =
    toolCallCount(s.orchestrator.toolCounts) +
    s.agents.reduce((sum, a) => sum + toolCallCount(a.toolCounts), 0);
  const perCall = toolCalls > 0 ? Math.round(total.cacheRead / toolCalls) : null;

  const rows = [
    [t(lang, "arranque de agentes", "agent startup"), startup],
    // The row always summed `total.output` alone; only the label claimed a sum
    // with `thinking`, which is a subset of output and would be counted twice.
    [t(lang, "razonamiento (output)", "reasoning (output)"), reasoning],
    [t(lang, "contexto de trabajo", "working context"), rest],
  ] as const;

  const lines = rows.map(
    ([label, n]) => `  ${String(label).padEnd(36)} ${k(n).padStart(7)}  ${pct(n, raw).padStart(4)}`,
  );

  return [
    t(
      lang,
      `TOTAL ${k(raw)} tokens (${k(weighted)} ponderados, equivalentes a input)`,
      `TOTAL ${k(raw)} tokens (${k(weighted)} weighted, input-token equivalents)`,
    ),
    ...lines,
    "",
    t(
      lang,
      `  cache_read: ${k(total.cacheRead)} bruto → ${k(cacheReadWeighted)} ponderado (${pct(cacheReadWeighted, weighted)} del total ponderado) — se cobra a este agente a ${cacheReadMultiplier(model)}× input, no es gasto nulo.${perCall !== null ? ` ${k(perCall)}/tool call.` : ""}`,
      `  cache_read: ${k(total.cacheRead)} raw → ${k(cacheReadWeighted)} weighted (${pct(cacheReadWeighted, weighted)} of the weighted total) — billed at ${cacheReadMultiplier(model)}x input, not zero-cost.${perCall !== null ? ` ${k(perCall)}/tool call.` : ""}`,
    ),
  ].join("\n");
}

function agentTimeline(s: SessionAudit, lang: Lang): string {
  if (s.agents.length === 0) return t(lang, "(sin subagentes)", "(no subagents)");
  const top = [...s.agents]
    .sort((a, b) => weightedTokens(b.tokens, b.model) - weightedTokens(a.tokens, a.model))
    .slice(0, 15);
  const lines = top.map((a) => {
    const time = a.startedAt.slice(11, 16);
    const par = a.overlapsWith.length > 0 ? "∥" : " ";
    const verdict = a.verdict === "CHANGES_REQUESTED" ? " ⟲" : "";
    return `  ${time} ${par} ${a.agentType.padEnd(16)} ${minutes(a.durationMs).padStart(5)} ${k(weightedTokens(a.tokens, a.model)).padStart(7)}${verdict}  ${a.description.slice(0, 44)}`;
  });
  const omitted = s.agents.length - top.length;
  if (omitted > 0) {
    lines.push(t(lang, `  … y ${omitted} agentes más`, `  … and ${omitted} more agents`));
  }
  return lines.join("\n");
}

/**
 * One card per subagent — the report's main view (spec 0013, R8).
 *
 * Everything here was ALREADY captured; the previous report rendered one line
 * per agent and discarded the rest, which is why "what did this implementer
 * actually work with" had no answer despite the data sitting in the JSON.
 */

/**
 * Wall-clock the subagents actually occupied, merging overlapping windows.
 *
 * Five auditors of 20 minutes launched together cost 30 minutes of clock, not
 * 100. Reporting only the sum describes time nobody spent — and parallel fan-out
 * is the harness's main lever, so overstating its cost argues against the thing
 * that works.
 */
function wallClockOf(agents: AgentRun[]): number {
  const windows = agents
    .map((a) => [Date.parse(a.startedAt), Date.parse(a.endedAt)] as const)
    .filter(([from, to]) => Number.isFinite(from) && Number.isFinite(to) && to >= from)
    .sort((x, y) => x[0] - y[0]);
  if (windows.length === 0) return 0;

  let total = 0;
  let [openFrom, openTo] = windows[0] as readonly [number, number];
  for (const [from, to] of windows.slice(1)) {
    if (from <= openTo) {
      // Overlapping (or touching): extend the open window instead of adding it.
      openTo = Math.max(openTo, to);
      continue;
    }
    total += openTo - openFrom;
    [openFrom, openTo] = [from, to];
  }
  return total + (openTo - openFrom);
}

function agentCards(s: SessionAudit, lang: Lang): string {
  // The orchestrator gets a card too, and FIRST: it is where most of a session
  // happens, and every hook event that could not be attributed to a subagent
  // lands on it. Without this, a session with one subagent showed 340 hook
  // events and hid the orchestrator's 187.
  const cards = [
    completeCardEvidence(s.availability, false)
      ? orchestratorCard(s, lang)
      : componentTable({
          run: s.orchestrator,
          evidence: s.availability ?? {},
          type: MAIN_THREAD,
        }),
  ];
  cards.push(
    ...[...s.agents]
      .sort((a, b) => weightedTokens(b.tokens, b.model) - weightedTokens(a.tokens, a.model))
      .map((a) =>
        completeCardEvidence(a.availability, true)
          ? agentCard(a, s.hookLogFrom, lang, s.agents.length)
          : componentTable({
              run: a,
              evidence: a.availability ?? {},
              type: a.agentType,
            }),
      ),
  );
  return cards.join("\n\n");
}

/** Legacy cards combine components, so only complete evidence can certify them. */
function completeCardEvidence(
  evidence: Record<string, MetricEvidence> | undefined,
  duration: boolean,
): boolean {
  return [
    "tools",
    "tokens.input",
    "tokens.output",
    "tokens.cacheRead",
    "tokens.cacheCreation",
    "tokens.thinking",
    "startupTokens",
    ...(duration ? ["durationMs"] : []),
  ].every((key) => evidence?.[key]?.state === "observed");
}

/** Retain each measured component without inventing a combined spend or duration. */
function componentTable(unit: MeasurementRun): string {
  const rows = ["| Run / component | Value | State | Reason |", "|---|---|---|---|"];
  for (const key of Object.keys(unit.run.tokens) as Array<keyof TokenTotals>) {
    const evidence = runEvidence(unit, `tokens.${key}`);
    rows.push(
      `| ${unit.type} / tokens.${key} | ${measurable(evidence) ? unit.run.tokens[key] : "unavailable"} | ${evidence.state} | ${evidence.reason ?? "—"} |`,
    );
  }
  for (const key of ["startupTokens", "durationMs"] as const) {
    const evidence = runEvidence(unit, key);
    const value =
      key === "startupTokens"
        ? unit.run.startupTokens
        : "durationMs" in unit.run
          ? unit.run.durationMs
          : null;
    rows.push(
      `| ${unit.type} / ${key} | ${measurable(evidence) ? value : "unavailable"} | ${evidence.state} | ${evidence.reason ?? "—"} |`,
    );
  }
  return rows.join("\n");
}

/**
 * The session's own run, in the same shape as a subagent's card.
 *
 * It has no `agentType`, `model` or `description` — it is not spawned — so the
 * header names the session instead, and the rest is identical on purpose: the
 * reader should not have to learn a second layout to answer the same question.
 */
/**
 * The orchestrator's model(s), formatted for the head of its card.
 *
 * One id renders bare, like a subagent's. Several render with their message
 * counts — `/model` mid-session is legal, and "which one" is then the wrong
 * question: what the reader needs is how the spend splits. Empty string when
 * the transcript declared no model, so the caller drops the segment instead of
 * printing a label with nothing after it.
 */
function modelsLabel(models: Record<string, number>): string {
  const entries = Object.entries(models).sort(([, a], [, b]) => b - a);
  if (entries.length === 0) return "";
  if (entries.length === 1) return entries[0]?.[0] ?? "";
  return entries.map(([id, n]) => `${id}:${n}`).join(", ");
}

/**
 * The reasoning line of a card, plus the thinking sub-line when there is one.
 *
 * `reasoning` is `output`, full stop. Both cards used to print
 * `output + thinking`, which counts every thinking token twice: thinking is a
 * SUBSET of output, measured over the 1028 assistant messages of transcript
 * `4935c4d7` (CC 2.1.236) — `thinking_tokens <= output_tokens` in 100% of them.
 * The double count also understated `context` by the same amount, since
 * context is whatever the raw total has LEFT after startup and reasoning.
 *
 * So thinking is rendered as an informative breakdown of the line above it,
 * never as an addend — and only when there is some, because a card that
 * announces "0 thinking" is noise.
 */
function reasoningRows(tokens: TokenTotals, lang: Lang): string[] {
  const rows = [`  ${t(lang, "razonamiento", "reasoning").padEnd(14)}${k(tokens.output)}`];
  if (tokens.thinking > 0) {
    // Indented to the value column of the block (the same 14 its labels pad
    // to), so it reads as a detail of the line above and not as a fourth row.
    rows.push(
      `  ${" ".repeat(14)}${t(lang, `de los cuales ~${k(tokens.thinking)} thinking`, `of which ~${k(tokens.thinking)} thinking`)}`,
    );
  }
  return rows;
}

function orchestratorCard(s: SessionAudit, lang: Lang): string {
  const o = s.orchestrator;
  const context = Math.max(0, rawSpend(o.tokens) - o.startupTokens - o.tokens.output);
  const model = modelsLabel(o.models ?? {});
  const calls = toolCallCount(o.toolCounts);
  const perCall = calls > 0 ? k(Math.round(o.tokens.cacheRead / calls)) : null;
  const rows = [
    `${model ? `${model} · ` : ""}${measurable(s.availability?.wallClockMs) ? minutes(s.wallClockMs) : "unavailable"} · ${s.prompts.typed + s.prompts.queued} ${t(lang, "mensajes del usuario", "user messages")}`,
    "",
    `  ${t(lang, "arranque", "startup").padEnd(14)}${k(o.startupTokens)}`,
    ...reasoningRows(o.tokens, lang),
    `  ${t(lang, "contexto", "context").padEnd(14)}${k(context)}`,
    `  ${"cache_read".padEnd(14)}${k(o.tokens.cacheRead)}${perCall ? ` (${perCall}/tool call)` : ""}`,
    "",
    `  ${t(lang, "skills", "skills").padEnd(LABEL)}${o.skills.length > 0 ? o.skills.map((sk) => sk.slug).join(", ") : t(lang, "—", "—")}`,
    `  ${t(lang, "tools", "tools").padEnd(LABEL)}${toolsLine(o.toolCounts)}`,
    `  ${"mcp".padEnd(LABEL)}${orchestratorMcp(o.mcpCalls, o.mcpInjectedContext ?? {}, lang)}`,
    `  ${"hooks".padEnd(LABEL)}${measurable(s.availability?.hooks) ? orchestratorHooksLine(s, lang) : "unavailable"}`,
    ...modeRows(s, lang),
  ];
  const head = `### ${t(lang, "orquestador", "orchestrator")} · "${s.initialPrompt.slice(0, 60)}"`;
  return `${head}\n\n\`\`\`\n${rows.join("\n")}\n\`\`\``;
}

/**
 * The orchestrator's hooks, and the window they were counted over.
 *
 * A subagent that ran before the recorder existed shows an empty list, and
 * `agentHooksLine` says so. The orchestrator's case is worse, because it is not
 * empty: it spans the WHOLE session, so a recorder that started late leaves it
 * with real counts drawn from part of the run — `guard-destructive 212×` next to
 * 298 Bash calls, with nothing saying 86 fired before the log existed (#559).
 * A truncated total printed like a total is the one thing the card must not do,
 * and it is worse alongside subagent cards that DO declare their gap: the reader
 * concludes this one is complete.
 */
function orchestratorHooksLine(s: SessionAudit, lang: Lang): string {
  const events = hooksLine(s.orchestrator.hookEvents, lang, s.agents.length);
  const window = recorderWindow(s);
  // A gap that rounds away is not a caveat. Announcing "partial … covers 100%"
  // in one breath contradicts itself, and a reader who sees a warning that
  // walks itself back learns to skim the next one (#559 follow-up).
  if (!window || window.coveredPercent >= 100) return events;
  const at = window.from.slice(11, 19);
  const note = t(
    lang,
    `parcial · el recorder cubre ${window.coveredPercent}% de la sesión, desde ${at}Z (${window.blindMinutes} min sin registrar)`,
    `partial · the recorder covers ${window.coveredPercent}% of the session, from ${at}Z (${window.blindMinutes} min unrecorded)`,
  );
  if (s.orchestrator.hookEvents.length === 0) return note;
  return `${events}\n  ${" ".repeat(LABEL)}${note}`;
}

/**
 * The tool histogram split by permission mode (#584), when the session used
 * more than one.
 *
 * A session that switches modes had ONE histogram and a note saying which mode
 * dominated — which describes no moment of it. The modes are not
 * interchangeable: `auto` tells the model to work through the shell and charges
 * a classifier round-trip for all but the commands its built-in read-only set
 * resolves on its own (#730), `plan` forbids writing outright. Reading
 * "Bash 217" without knowing which mode it happened under answers nothing.
 *
 * Silent for a single-mode session: the card above already IS that histogram,
 * and repeating it under a heading would be noise.
 */
function modeRows(s: SessionAudit, lang: Lang): string[] {
  const byMode = Object.entries(s.orchestrator.toolCountsByMode ?? {});
  if (byMode.length < 2) return [];
  const order = new Map(Object.entries(s.permissionModes).map(([m, n]) => [m, n] as const));
  // Busiest mode first — the one whose numbers the reader is most likely to be
  // reasoning about — with the undeclared bucket last whatever its size.
  const sorted = byMode.sort(([a], [b]) => (order.get(b) ?? -1) - (order.get(a) ?? -1));
  return [
    "",
    `  ${t(lang, "por modo", "by mode").padEnd(LABEL)}${t(lang, "solo el hilo principal", "main thread only")}`,
    ...sorted.map(
      ([mode, counts]) => `  ${" ".repeat(LABEL)}${mode.padEnd(16)}${toolsLine(counts)}`,
    ),
  ];
}

/**
 * Engram writes the closing protocol REQUIRES, as opposed to content an agent
 * chose to keep (#728).
 *
 * `mem_session_summary` is the ceremony every session owes at close, and
 * `mem_save_prompt` is mechanical capture of what the human typed. Neither is
 * a judgement about what was worth remembering, so summing them with `mem_save`
 * produces a write count that measures compliance and gets read as hoarding:
 * across this machine's transcripts the summary alone is 240 of 1,024 writes.
 */
const ENGRAM_CEREMONY_WRITES = new Set(["mem_session_summary", "mem_save_prompt"]);

/** Engram writes that persist something the agent decided to keep. */
const ENGRAM_CONTENT_WRITES = new Set(["mem_save", "mem_update"]);

/** Engram reads the agent ASKED for — the half `mcpInjectedContext` completes. */
const ENGRAM_REQUESTED_READS = new Set([
  "mem_search",
  "mem_context",
  "mem_get_observation",
  "mem_timeline",
]);

function tally(ops: Record<string, number>, names: Set<string>): number {
  return Object.entries(ops).reduce((sum, [op, n]) => (names.has(op) ? sum + n : sum), 0);
}

/**
 * The two lines that stop `mem_save` vs `mem_search` from being read as a
 * verdict on how engram is used (#728).
 *
 * A raw side-by-side of those counters invites one reading — "it writes four
 * times more than it reads, so it is a diary" — and both halves of it are
 * artifacts of what the counters happen to cover. Writes include a ceremony the
 * protocol demands; reads exclude the largest read of the session, which
 * arrives as injected context and makes no call at all. So the split is stated
 * here rather than left for the reader to reconstruct.
 *
 * Deliberately NOT a sum: these lines break down the detail above them and are
 * not meant to add up to the server's call total, because operations that are
 * neither (`mem_judge`, `mem_pin`) belong to neither bucket and are already
 * listed, verbatim, one line up.
 *
 * Orchestrator-only. A subagent gets no `SessionStart`, so the read half has
 * nothing to say about it, and an agent card that printed "0 injected" would be
 * reporting an absence that was never possible.
 */
function engramRows(
  ops: Record<string, number>,
  injected: InjectedContext | undefined,
  lang: Lang,
): string[] {
  const content = tally(ops, ENGRAM_CONTENT_WRITES);
  const ceremony = tally(ops, ENGRAM_CEREMONY_WRITES);
  const requested = tally(ops, ENGRAM_REQUESTED_READS);
  // Indented to the column where each server's figures start, so both read as
  // a breakdown of the line above and not as two more servers.
  const pad = " ".repeat(11);
  const rows: string[] = [];

  if (content + ceremony > 0) {
    // Named, never assumed: the ceremony bucket holds more than one operation,
    // and a line that says `mem_session_summary` when the calls were
    // `mem_save_prompt` is the same class of defect as the count it replaces.
    const which = [...ENGRAM_CEREMONY_WRITES].filter((op) => (ops[op] ?? 0) > 0).join(", ");
    rows.push(
      pad +
        (ceremony > 0
          ? t(
              lang,
              `escrituras  ${content} de contenido + ${ceremony} de ceremonia (${which}, que el protocolo de cierre exige)`,
              `writes      ${content} content + ${ceremony} ceremony (${which}, required by the closing protocol)`,
            )
          : t(
              lang,
              `escrituras  ${content}, ninguna de ceremonia`,
              `writes      ${content}, none of them ceremony`,
            )),
    );
  }

  if (requested > 0 || injected) {
    rows.push(
      pad +
        (injected
          ? t(
              lang,
              `lecturas    ${requested} pedidas + ${injected.count} inyectadas por el hook SessionStart (~${k(injected.chars)} car), que no son llamadas y ningún conteo de mem_search ve`,
              `reads       ${requested} requested + ${injected.count} injected by the SessionStart hook (~${k(injected.chars)} chars), which are not calls and no mem_search count sees`,
            )
          : t(
              lang,
              `lecturas    ${requested} pedidas · el transcript no registra inyección de contexto por SessionStart`,
              `reads       ${requested} requested · the transcript records no SessionStart context injection`,
            )),
    );
  }

  return rows;
}

/** The orchestrator inherits every tool, so there is no allowlist to cross. */
function orchestratorMcp(
  calls: Record<string, Record<string, number>>,
  injectedByServer: Record<string, InjectedContext>,
  lang: Lang,
): string {
  // Injections come from the union, not from `calls`: a session handed 8k
  // characters of memory that then never called engram would otherwise print no
  // engram line at all — the exact read this card exists to surface.
  const servers = [...new Set([...Object.keys(calls), ...Object.keys(injectedByServer)])].sort();
  if (servers.length === 0) return t(lang, "—", "—");
  const lines: string[] = [];
  for (const server of servers) {
    const ops = calls[server] ?? {};
    const total = Object.values(ops).reduce((sum, n) => sum + n, 0);
    const detail = Object.entries(ops)
      .sort((x, y) => y[1] - x[1])
      .map(([op, n]) => `${op} ${n}`)
      .join(", ");
    lines.push(
      total > 0
        ? `${server.padEnd(11)}${total} (${detail})`
        : `${server.padEnd(11)}${t(lang, "0 llamadas", "0 calls")}`,
    );
    if (server === "engram") lines.push(...engramRows(ops, injectedByServer[server], lang));
  }
  return lines.join(`\n  ${" ".repeat(LABEL)}`);
}

/** Width of a card's label column. Must exceed the longest label. */
const LABEL = 11;

function agentCard(
  a: AgentRun,
  hookLogFrom: string | null,
  lang: Lang,
  agentCount: number,
): string {
  const head = `### ${a.agentType} · "${a.description}"`;
  const context = Math.max(0, rawSpend(a.tokens) - a.startupTokens - a.tokens.output);
  const calls = toolCallCount(a.toolCounts);
  const perCall = calls > 0 ? k(Math.round(a.tokens.cacheRead / calls)) : null;

  const rows: string[] = [
    `${a.model ?? "?"} · ${minutes(a.durationMs)}${a.overlapsWith.length > 0 ? t(lang, ` · en paralelo con ${a.overlapsWith.length}`, ` · in parallel with ${a.overlapsWith.length}`) : ""}`,
    "",
    `  ${t(lang, "arranque", "startup").padEnd(14)}${k(a.startupTokens)}`,
    ...reasoningRows(a.tokens, lang),
    `  ${t(lang, "contexto", "context").padEnd(14)}${k(context)}`,
    `  ${"cache_read".padEnd(14)}${k(a.tokens.cacheRead)}${perCall ? ` (${perCall}/tool call)` : ""}`,
    "",
  ];

  // 11, not 9: `veredicto` is itself nine characters, so `padEnd(9)` left it
  // glued to its value (`veredictoCHANGES_REQUESTED`).
  rows.push(`  ${t(lang, "skills", "skills").padEnd(LABEL)}${skillsLine(a, lang)}`);
  rows.push(`  ${t(lang, "tools", "tools").padEnd(LABEL)}${toolsLine(a.toolCounts)}`);
  rows.push(`  ${"mcp".padEnd(LABEL)}${mcpLines(a, lang)}`);
  rows.push(
    `  ${"hooks".padEnd(LABEL)}${measurable(a.availability?.hooks) ? agentHooksLine(a, hookLogFrom, lang, agentCount) : "unavailable"}`,
  );
  if (a.verdict) rows.push(`  ${t(lang, "veredicto", "verdict").padEnd(LABEL)}${a.verdict}`);

  return `${head}\n\n\`\`\`\n${rows.join("\n")}\n\`\`\``;
}

/**
 * The label for each `SkillSource`.
 *
 * A ternary covered two of what were three values, so `host` — the ONE source
 * that is not an inference — printed with the label of the weakest one (#725,
 * B1). It was latent only because the OTel channel it comes from has never
 * carried a real event. Exhaustive now, so the next source added has to answer
 * this question at the compiler rather than inherit the wrong answer.
 */
function skillSourceLabel(source: SkillSource, lang: Lang): string {
  switch (source) {
    case "host":
      return t(lang, "declarada por el host", "declared by the host");
    case "skill-tool":
      return t(lang, "tool Skill", "Skill tool");
    case "attribution":
      return t(lang, "tramo atribuido", "attributed span");
    case "skill-md":
      return t(lang, "SKILL.md leído", "SKILL.md read");
  }
}

function skillsLine(a: AgentRun, lang: Lang): string {
  if (a.skills.length === 0 && a.skillsDiscarded === 0) return t(lang, "—", "—");
  const used = a.skills
    .map((sk) => {
      // The span is what attribution adds over every other source: not "it was
      // invoked" but "this much work happened under it, and it cost this much".
      const span =
        sk.attributedRecords !== undefined
          ? `, ${sk.attributedRecords} ${t(lang, "msj", "msg")}` +
            (sk.attributedOutputTokens ? ` / ${k(sk.attributedOutputTokens)} tok` : "")
          : "";
      return `${sk.slug} (${skillSourceLabel(sk.source, lang)}${span})`;
    })
    .join(", ");
  // The discard is stated, never silent: it is the difference between "used no
  // skills" and "walked past eleven of them while listing the index".
  const dropped =
    a.skillsDiscarded > 0
      ? t(
          lang,
          ` · ${a.skillsDiscarded} descartadas (vistas al listar el índice)`,
          ` · ${a.skillsDiscarded} discarded (seen while listing the index)`,
        )
      : "";
  return `${used || t(lang, "—", "—")}${dropped}`;
}

function toolsLine(counts: Record<string, number>): string {
  const entries = Object.entries(counts)
    // MCP tools have their own line; repeating them here would double-count.
    .filter(([name]) => !name.startsWith("mcp__"))
    .sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "—";
  return entries.map(([name, n]) => `${name} ${n}`).join(" · ");
}

/**
 * MCP per server, crossed with what the agent was ALLOWED to reach (R19/R20).
 *
 * An empty `mcp` line is ambiguous on its own — it cannot distinguish an agent
 * that did not need engram from one whose `tools:` never let it near engram
 * while `CLAUDE.md` charged it for the instructions anyway.
 */
function mcpLines(a: AgentRun, lang: Lang): string {
  const servers = new Set([...Object.keys(a.mcpCalls), ...Object.keys(a.mcpReach)]);
  if (servers.size === 0) return t(lang, "—", "—");

  const lines: string[] = [];
  for (const server of [...servers].sort()) {
    const ops = a.mcpCalls[server];
    if (ops) {
      const detail = Object.entries(ops)
        .sort((x, y) => y[1] - x[1])
        .map(([op, n]) => `${op} ${n}`)
        .join(", ");
      const total = Object.values(ops).reduce((sum, n) => sum + n, 0);
      lines.push(`${server.padEnd(11)}${total} (${detail})`);
      continue;
    }
    lines.push(
      `${server.padEnd(11)}${
        a.mcpReach[server] !== false
          ? t(lang, "disponible · 0 llamadas", "available · 0 calls")
          : t(lang, "⚠ vedado por su tools:", "⚠ barred by its tools:") +
            barredCost(a, server, lang)
      }`,
    );
  }
  return lines.join(`\n  ${" ".repeat(LABEL)}`);
}

/** What a barred agent paid, in its startup, for instructions it cannot follow. */
function barredCost(a: AgentRun, server: string, lang: Lang): string {
  const wasted = a.mcpBarredTokens[server];
  if (!wasted) return "";
  return t(
    lang,
    ` · ${k(wasted)} tok de instrucciones inejecutables`,
    ` · ${k(wasted)} tok of unexecutable instructions`,
  );
}

/**
 * An agent's hooks, with the one distinction the raw list cannot make.
 *
 * An empty list means "this agent ran no hooks" ONLY if the recorder was
 * already running when it did. A harness rendered or updated mid-session
 * starts recording later than the session starts, and every agent that
 * finished before that instant shows an empty list for a reason that has
 * nothing to do with hooks — in the reference session the first nine agents
 * of nineteen looked hook-free because the recorder landed an hour in.
 */
function agentHooksLine(
  a: AgentRun,
  hookLogFrom: string | null,
  lang: Lang,
  agentCount: number,
): string {
  if (a.hookEvents.length > 0 || !hookLogFrom) return hooksLine(a.hookEvents, lang, agentCount);
  const from = Date.parse(hookLogFrom);
  const ended = Date.parse(a.endedAt);
  if (!Number.isFinite(from) || !Number.isFinite(ended) || ended >= from) {
    return hooksLine(a.hookEvents, lang, agentCount);
  }
  const at = hookLogFrom.slice(11, 19);
  return t(
    lang,
    `sin registro · el recorder arrancó a las ${at}Z`,
    `not recorded · the recorder started at ${at}Z`,
  );
}

/**
 * Runs slower than this are the hook DOING ITS JOB, not the hook's overhead.
 *
 * The gate hooks fire on every Bash call but act only on a commit, so their
 * timings are bimodal by construction: hundreds of sub-100ms exits plus a
 * handful of multi-second scans. One measured session: `check-semgrep` at
 * 902× / 191.2s reads as 212ms of tax per shell command, when the truth is
 * 876 runs costing 49.6s and 26 real scans costing 141.6s. One second is far
 * above every observed pass-through and far below every observed scan.
 */
const HOOK_WORK_MS = 1000;

/** Middle value — the tax an ADDITIONAL command would actually pay. The mean is
 *  the wrong statistic for a bimodal distribution, and it is the one that made
 *  the constant floor look four times bigger than it is. */
function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid];
  if (hi === undefined) return 0;
  if (sorted.length % 2 === 1) return hi;
  const lo = sorted[mid - 1] ?? hi;
  return Math.round((lo + hi) / 2);
}

/**
 * The phase whose firing count is NOT a count of subagents (#693).
 *
 * `SubagentStop` fires in the parent once a child has already died, and the
 * host sends a FRESH `agent_id` on every firing: 112 distinct ids for 117
 * firings in the reference session, 102 of them matching nothing under
 * `~/.claude`. `ownerOf` already handles that correctly — an id that names
 * nobody is invalid data, not missing data, so the event goes to the
 * orchestrator instead of inventing an owner (#669).
 *
 * The attribution was right; the PRESENTATION was not. `subagent-stop-handoff
 * 112×` next to a header saying 4 agents invites exactly one conclusion, and it
 * is the wrong one — it cost a whole investigation (#673, refuted in #694)
 * before anyone questioned the label. If it fooled the person who wrote the
 * parser, it will fool an operator, and delegation is the metric this harness
 * exists to move.
 */
const HOST_FIRED_PHASE = "SubagentStop";

function hooksLine(events: HookEvent[], lang: Lang, agentCount: number): string {
  // `gate-started` is a durable timeout witness, not a completed hook run. It
  // shares the invocation with allow/block and would otherwise double-count the
  // gate while adding only the pre-eval milliseconds to its timing.
  const completed = events.filter((event) => event.verdict !== "gate-started");
  if (completed.length === 0) return t(lang, "—", "—");
  const by = new Map<string, { ms: number[]; blocked: number; phases: Set<string> }>();
  for (const e of completed) {
    const cur = by.get(e.name) ?? {
      ms: [],
      blocked: 0,
      phases: new Set<string>(),
    };
    cur.ms.push(e.ms);
    cur.blocked += e.verdict === "block" ? 1 : 0;
    cur.phases.add(e.phase);
    by.set(e.name, cur);
  }
  const rows = [...by.entries()]
    // Slowest first: the point of recording `ms` is finding the hook that costs
    // seconds on every tool call.
    .sort((x, y) => sumMs(y[1].ms) - sumMs(x[1].ms))
    .map(([name, v]) => {
      const total = sumMs(v.ms);
      const work = v.ms.filter((ms) => ms > HOOK_WORK_MS);
      const p50 = median([...v.ms].sort((a, b) => a - b));
      const blocked =
        v.blocked > 0 ? t(lang, ` · ${v.blocked} bloqueos`, ` · ${v.blocked} blocked`) : "";
      // The split only appears when there is something to split. A hook that
      // never ran long — the always-on ones — is honestly described by its
      // total, and an unconditional parenthesis saying "0 runs" is noise.
      const split =
        work.length > 0
          ? t(
              lang,
              ` · ${work.length} corridas >1s = ${(sumMs(work) / 1000).toFixed(1)}s`,
              ` · ${work.length} runs >1s = ${(sumMs(work) / 1000).toFixed(1)}s`,
            )
          : "";
      // Keyed on the PHASE and not on the hook's name: the name is a navori
      // asset that can be renamed, while the phase is the host's contract.
      const hostFired =
        v.phases.size === 1 && v.phases.has(HOST_FIRED_PHASE)
          ? t(
              lang,
              ` · disparos del host, no subagentes (agentes: ${agentCount})`,
              ` · host firings, not subagents (agents: ${agentCount})`,
            )
          : "";
      return `${name} ${v.ms.length}× ${(total / 1000).toFixed(1)}s · ${t(lang, "mediana", "median")} ${p50}ms${split}${blocked}${hostFired}`;
    });
  rows.push(...tollRows(completed, lang));
  return rows.join(`\n  ${" ".repeat(LABEL)}`);
}

/** `ms` under a second, seconds above it: `75631ms` is a number nobody reads. */
function msLabel(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
}

/** Largest `ms` of a group, 0 for an empty one. */
function maxMs(events: HookEvent[]): number {
  return events.reduce((top, e) => (e.ms > top ? e.ms : top), 0);
}

/**
 * The hooks that raced on ONE host event, grouped.
 *
 * Keyed on `toolUseId` + `phase`, and both halves are load-bearing. The id
 * alone would merge a `PreToolUse` with the `PostToolUse` of the same tool
 * call, which are sequential and whose costs the session really did add up.
 *
 * An event with no `toolUseId` becomes its own group, so its cost is counted
 * whole. That is not a fallback, it is the correct answer: the ONLY events
 * without one are `SessionStart`/`SessionEnd` (measured over this repo's audit
 * store: 91 of 23,084, all of them lifecycle phases), and Claude Code gives
 * every `SessionEnd` hook a SHARED 1.5-second budget — there the sum is the
 * statistic that describes what the session waited. Keying on the id means the
 * exception falls out instead of being coded.
 */
function tollGroups(events: HookEvent[]): HookEvent[][] {
  const byHostEvent = new Map<string, HookEvent[]>();
  const ungrouped: HookEvent[][] = [];
  for (const e of events) {
    if (!e.toolUseId) {
      ungrouped.push([e]);
      continue;
    }
    // `\u0000` as the separator, never a raw NUL: same reason as `gateHandle`.
    const key = `${e.toolUseId}\u0000${e.phase}`;
    const group = byHostEvent.get(key);
    if (group) group.push(e);
    else byHostEvent.set(key, [e]);
  }
  return [...byHostEvent.values(), ...ungrouped];
}

/**
 * What the hooks of this block actually cost the session, per host event.
 *
 * #924. The rows above are one per hook name, and there is no arithmetic
 * BETWEEN them — so a reader who adds the column gets the sum of hooks that ran
 * AT THE SAME TIME. Both hosts launch every matching hook of an event at once
 * (`claude-hook-parallelism`, `codex-hook-parallelism` in `host-contracts.ts`),
 * so what the session waited for is the SLOWEST of each event, not their sum.
 * Measured over this repo's own 23,084 recorded hook runs: the column adds up
 * to 1,564.3s where the blocking cost is 928.1s — 1.69×, +636.2s of time
 * nobody spent. It is the same defect `wallClockOf` already fixes for agent
 * durations, on the axis nobody had applied it to.
 *
 * Both figures ship, and neither replaces the other: the total is still the
 * honest answer to "how much work did this hook do" (see `HOOK_WORK_MS`), and
 * the toll is the honest answer to "how much did waiting for hooks cost".
 *
 * Silent when nothing ever raced: with one hook per event the toll IS the
 * total, and printing it twice teaches the reader to skim the next line.
 */
function tollRows(completed: HookEvent[], lang: Lang): string[] {
  const groups = tollGroups(completed);
  const contended = groups.filter((g) => g.length > 1);
  if (contended.length === 0) return [];

  const tolls = groups.map(maxMs);
  const toll = sumMs(tolls);
  const naive = sumMs(completed.map((e) => e.ms));
  const p50 = median([...tolls].sort((a, b) => a - b));

  // The pacemaker is COMPUTED, never assumed: the issue that opened #924 named
  // the wrong hook from a glance at the medians, and the measurement inverted
  // it. Counted over contended events only — a hook that is alone on its event
  // is not racing anyone, so calling it the fastest or the slowest says nothing.
  const wins = new Map<string, number>();
  for (const group of contended) {
    const lead = group.reduce((top, e) => (e.ms > top.ms ? e : top));
    wins.set(lead.name, (wins.get(lead.name) ?? 0) + 1);
  }
  const leader = [...wins.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0];

  const rows = [
    t(
      lang,
      `peaje por evento: ${msLabel(toll)} en ${groups.length} eventos · mediana ${p50}ms · las filas de arriba suman ${msLabel(naive)}, con ${contended.length} eventos de hooks en paralelo`,
      `per-event toll: ${msLabel(toll)} over ${groups.length} events · median ${p50}ms · the rows above add up to ${msLabel(naive)}, with ${contended.length} events of parallel hooks`,
    ),
  ];
  if (!leader) return rows;
  const [pacemaker, led] = leader;
  // Counterfactual, not a subtraction of its total: removing the pacemaker
  // promotes the second-slowest of each event it led, and on the events it did
  // not lead it changes nothing. This is the number that tells an operator
  // whether retiring a hook buys latency — over this repo's store it is 75.6s
  // of a 928.1s toll, against the 271.1s its own column advertises.
  const without = sumMs(groups.map((g) => maxMs(g.filter((e) => e.name !== pacemaker))));
  rows.push(
    t(
      lang,
      `marca el paso ${pacemaker} en ${led} de ${contended.length} · retirarlo bajaría el peaje ${msLabel(toll - without)}`,
      `${pacemaker} sets the pace on ${led} of ${contended.length} · dropping it would cut the toll by ${msLabel(toll - without)}`,
    ),
  );
  return rows;
}

function sumMs(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function byAgentType(s: SessionAudit): string {
  const by = new Map<string, { n: number; tok: number; startup: number }>();
  for (const a of s.agents) {
    const cur = by.get(a.agentType) ?? { n: 0, tok: 0, startup: 0 };
    by.set(a.agentType, {
      n: cur.n + 1,
      tok: cur.tok + weightedTokens(a.tokens, a.model),
      startup: cur.startup + a.startupTokens,
    });
  }
  return [...by.entries()]
    .sort((a, b) => b[1].tok - a[1].tok)
    .map(
      ([type, v]) =>
        `  ${type.padEnd(18)} ${String(v.n).padStart(3)}x  ${k(v.tok).padStart(7)}  (${k(v.startup)} ${"startup"})`,
    )
    .join("\n");
}

/**
 * The navori that ran the session — NOT the one that wrote this report.
 *
 * The report header states the generator; this states the harness. Conflating
 * them made every comparison across an upgrade unreadable, because a report
 * regenerated after the upgrade stamped the new version onto the old sessions.
 *
 * A session marked before the field existed says `?`: unknown is a legitimate
 * answer here and the only honest one, since nothing on disk today can prove
 * what was rendered then.
 */
function sessionNavori(s: SessionAudit, lang: Lang): string {
  const { rendered, cli } = s.navori;
  if (!rendered && !cli) return t(lang, "? (sesión previa al registro)", "? (session predates it)");
  const pair = (r: string | null, c: string | null): string =>
    r === null ? `? · CLI ${c ?? "?"}` : r === c ? r : `${r} (CLI ${c ?? "?"})`;
  const at = s.navoriAtStop;
  // A harness that moved mid-session gets both readings joined by an arrow. It
  // is not a formatting nicety: attributing the whole run to the version it
  // STARTED on is what made a rollout merged 26 minutes in invisible, in the
  // very report meant to compare versions.
  if (at) return `${pair(rendered, cli)} → ${pair(at.rendered, at.cli)}`;
  // Same number is the normal case and needs no parenthesis. A different one
  // means the CLI moved without a `render`, so the session ran on an older
  // harness than the machine had — worth stating where it is discovered.
  return pair(rendered, cli);
}

/**
 * Minutes of silence after which a session is treated as over, sealed or not.
 *
 * A session that ends normally now seals itself — the `SessionEnd` hook writes
 * `session-end` and the parser reads it — but "unsealed" still cannot mean
 * "running". Two classes of log never get a seal at all: a run killed with its
 * log mid-write, and one whose close hook took a fail-open exit (no `jq`, an
 * empty payload, a log that was not there). Neither ever gains one afterwards,
 * so reading an absent seal as "running" would warn on them forever. Recent
 * activity is the evidence that the figures will still move; the missing seal
 * alone is not.
 */
const LIVE_WINDOW_MIN = 30;

/**
 * Is this session still being written to when the report is built?
 *
 * Both halves are required: an unsealed log is only suspicious while the
 * transcript is still growing. What it prevents is real — the same session
 * audited three hours apart reported 154 vs 184 Bash calls and 2 vs 4 PRs,
 * both times as a total.
 */
function stillRunning(s: SessionAudit, generatedAt: string): boolean {
  if (s.sealed || !s.endedAt) return false;
  const idleMin = (Date.parse(generatedAt) - Date.parse(s.endedAt)) / 60000;
  return Number.isFinite(idleMin) && idleMin >= 0 && idleMin < LIVE_WINDOW_MIN;
}

/**
 * Findings about the range itself, printed before anything they qualify (#778).
 *
 * Same row shape as the per-session findings so a reader recognizes it, and a
 * different heading so nobody attributes it to a session: the whole claim is
 * that it is true of the TOTALS.
 */
function rangeSignalSection(report: AuditReport, lang: Lang): string[] {
  if (report.rangeSignals.length === 0) return [];
  const out = ["", "---", "", `## ${t(lang, "Hallazgos del rango", "Range findings")}`, ""];
  for (const sig of report.rangeSignals) {
    const tag = sig.severity === "high" ? "ALTO" : sig.severity === "warn" ? "MEDIO" : "INFO";
    out.push(`- **[${tag}] ${sig.kind}** — ${sig.summary}`);
    out.push(`  <br>${sig.evidence.split("\n").join("<br>")}`);
  }
  return out;
}

/** Human-facing report, in the repo's configured language. */
/**
 * Skill use across the whole range, before the per-session sections (#725, A5).
 *
 * It goes FIRST because it is the question being asked. "Are the skills being
 * used" is asked of a park; the report answered per session, so the park answer
 * was assembled by hand once and became a moratorium. Reading it off N session
 * sections is the work this table removes.
 */
function skillRangeSection(report: AuditReport, lang: Lang): string[] {
  const rows = report.totals.skills;
  if (rows.length === 0) return [];

  const header = [
    `| ${t(lang, "skill", "skill")} | ${t(lang, "invocada", "invoked")} | ${t(lang, "heredada", "inherited")} | ${t(lang, "solo abierta", "only opened")} | ${t(lang, "msj", "msg")} | tokens |`,
    "|---|---:|---:|---:|---:|---:|",
  ];
  const body = rows.map(
    (r) =>
      `| \`${r.slug}\` | ${r.invoked || "—"} | ${r.inherited || "—"} | ${r.browsed || "—"} | ` +
      `${r.records || "—"} | ${measurable(report.availability?.[`skill.${r.slug}.outputTokens`]) ? k(r.outputTokens) : "unavailable"} |`,
  );

  const dead = rows.filter((r) => r.invoked === 0 && r.inherited === 0);
  const deadLine =
    dead.length > 0
      ? t(
          lang,
          `**${dead.length} de ${rows.length}** no se invocaron ni se heredaron en todo el rango.`,
          `**${dead.length} of ${rows.length}** were neither invoked nor inherited in the whole range.`,
        )
      : t(lang, "Todas se usaron al menos una vez.", "Every one was used at least once.");

  return [
    "",
    "---",
    "",
    `## ${t(lang, "Skills en el rango", "Skills over the range")}`,
    "",
    // The three columns are counted in SESSIONS and never added up: they are
    // different evidence, and a single "used" number is what made the previous
    // measurement report a skill as used because somebody opened its file.
    t(
      lang,
      "Sesiones por skill. **invocada** = solicitada vía `Skill` o declarada por host · **heredada** = trabajo sin solicitarla (tramo atribuido) · **solo abierta** = archivo leído, sin uso.",
      "Sessions per skill. **invoked** = requested via `Skill` or host-declared · **inherited** = work without requesting it (attributed span) · **only opened** = file read, no use.",
    ),
    "",
    ...header,
    ...body,
    "",
    deadLine,
  ];
}

/** Nearest-rank quantile; `null` for no data — unavailable, never zero. */
function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? null;
}

/** The orchestrator's row in `byAgentType` and in every `agent.*` key. */
const MAIN_THREAD = "main-thread";

/** Examples kept per blocking rule (R66). */
const EXAMPLES_PER_RULE = 3;
/** A rule's reason becomes part of a metric key: cut so it stays a label. */
const RULE_KEY_MAX = 80;

type Run = AgentRun | SessionAudit["orchestrator"];

interface AgentStat {
  sessions: number;
  launches: number;
  turns: number[];
  /** Runs whose transcript could say whether the limit was hit. */
  limitMeasured: number;
  turnLimitHits: number;
  fetch: number;
  search: number;
  contextPeaks: number[];
  /** Cache read of each run (R43 baseline); one entry per launch. */
  cacheReads: number[];
  /** Null when no session could measure compactions (main thread only). */
  compactions: number | null;
}

interface ToolStat {
  calls: number;
  callsMain: number;
  callsAgents: number;
  resultBytes: number[];
}

interface RuleStat {
  count: number;
  examples: string[];
  /** From the first event of the rule that carried one. */
  kind?: string;
}

interface HookStat {
  fires: number;
  ms: number;
  blocks: Map<string, RuleStat>;
}

/** Every range aggregate, structured: `rangeMetrics` flattens it and the range
 *  sections render it, so neither recomputes what the other shows. */
interface RangeStats {
  sessions: { total: number; transcript: number; codex: number };
  codexExecWrappers: number | null;
  agents: Map<string, AgentStat>;
  /** Cache read of each whole session (orchestrator + its agents), R43. */
  sessionCacheReads: number[];
  tools: Map<string, ToolStat>;
  hooks: {
    byHook: Map<string, HookStat>;
    fires: number;
    ms: number;
    /** Toll only for host events with a reliable invocation id; null means unavailable. */
    tollMs: number | null;
    tollEvents: number;
    ungroupedFires: number;
    bashCalls: number;
    bashTranscriptCalls: number | null;
    bashCoveragePct: number | null;
    perBashCall: number | null;
    perBashCallP90: number | null;
  };
  /** name → verdict → count, over hook events and CLI events alike (R70). */
  mechanism: Map<string, Map<string, number>>;
}

function emptyAgentStat(): AgentStat {
  return {
    sessions: 0,
    launches: 0,
    turns: [],
    limitMeasured: 0,
    turnLimitHits: 0,
    fetch: 0,
    search: 0,
    contextPeaks: [],
    cacheReads: [],
    compactions: null,
  };
}

function getOrSet<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  const cur = map.get(key) ?? make();
  map.set(key, cur);
  return cur;
}

function addAgentRun(stat: AgentStat, run: Run, evidence?: Record<string, MetricEvidence>): void {
  stat.fetch += run.toolCounts.WebFetch ?? 0;
  stat.search += run.toolCounts.WebSearch ?? 0;
  if ((evidence?.turns ?? evidence?.tools)?.state === "observed" && typeof run.turns === "number")
    stat.turns.push(run.turns);
  if (
    runEvidence({ run, evidence: evidence ?? {}, type: "" }, "contextPeak").state === "observed" &&
    typeof run.contextPeak === "number"
  )
    stat.contextPeaks.push(run.contextPeak);
  if (evidence?.["tokens.cacheRead"]?.state === "observed")
    stat.cacheReads.push(run.tokens.cacheRead);
}

/**
 * Computes every range aggregate ONCE (spec 0039 D10).
 *
 * Sessions without a transcript (Codex, R71) contribute their hooks and
 * mechanism verdicts and NOTHING else: adding their empty tool counts or turn
 * lists would turn "unavailable" into "zero", which is the misreading R71
 * forbids.
 */
function rangeStats(sessions: SessionAudit[], declaredAgents: readonly string[]): RangeStats {
  const withTranscript = sessions.filter(
    (s) => s.unavailable !== "transcript" && s.availability?.tools?.state === "observed",
  );
  const codexSessions = sessions.filter((s) => s.host === "codex");
  const codexExecWrappers = codexSessions.every((s) => s.availability?.tools?.state === "observed")
    ? codexSessions.reduce(
        (count, s) =>
          count + (s.rollout?.status === "parsed" ? (s.rollout.toolCalls.exec ?? 0) : 0),
        0,
      )
    : null;
  const agents = new Map<string, AgentStat>();
  const tools = new Map<string, ToolStat>();
  const tool = (name: string): ToolStat =>
    getOrSet(tools, name, () => ({
      calls: 0,
      callsMain: 0,
      callsAgents: 0,
      resultBytes: [],
    }));

  // Every declared agent has a row, including the ones that never ran (R46).
  for (const name of declaredAgents) getOrSet(agents, name, emptyAgentStat);

  if (withTranscript.length > 0) {
    const main = getOrSet(agents, MAIN_THREAD, emptyAgentStat);
    main.sessions = withTranscript.length;
    main.launches = withTranscript.length;
    for (const s of withTranscript) {
      addAgentRun(main, s.orchestrator, s.availability);
      if (typeof s.orchestrator.compactions === "number") {
        main.compactions = (main.compactions ?? 0) + s.orchestrator.compactions;
      }
    }
  }
  for (const session of codexSessions) {
    if (
      !["turns", "tools", "tokens.cacheRead"].some(
        (key) => session.availability?.[key]?.state === "observed",
      )
    )
      continue;
    const main = getOrSet(agents, MAIN_THREAD, emptyAgentStat);
    addAgentRun(main, session.orchestrator, session.availability);
  }

  for (const s of sessions) {
    const seen = new Set<string>();
    for (const a of s.agents) {
      if (
        a.availability?.tools?.state !== "observed" &&
        a.availability?.turns?.state !== "observed"
      )
        continue;
      const stat = getOrSet(agents, a.agentType, emptyAgentStat);
      stat.launches += 1;
      if (!seen.has(a.agentType)) {
        seen.add(a.agentType);
        stat.sessions += 1;
      }
      addAgentRun(stat, a, a.availability);
      if (typeof a.turnLimitHit === "boolean") {
        stat.limitMeasured += 1;
        if (a.turnLimitHit) stat.turnLimitHits += 1;
      }
    }
    const runs: Array<{ run: Run; main: boolean }> = [
      { run: s.orchestrator, main: true },
      ...s.agents.map((run) => ({ run, main: false })),
    ];
    for (const { run, main } of runs) {
      if (main && s.availability?.tools?.state !== "observed") continue;
      if (!main && "availability" in run && run.availability?.tools?.state !== "observed") continue;
      for (const [name, n] of Object.entries(run.toolCounts)) {
        const t = tool(name);
        t.calls += n;
        if (main) t.callsMain += n;
        else t.callsAgents += n;
      }
      for (const [name, sizes] of Object.entries(run.toolResultBytes ?? {})) {
        tool(name).resultBytes.push(...sizes);
      }
    }
  }

  const byHook = new Map<string, HookStat>();
  const mechanism = new Map<string, Map<string, number>>();
  const count = (name: string, verdict: string): void => {
    const row = getOrSet(mechanism, name, () => new Map<string, number>());
    row.set(verdict, (row.get(verdict) ?? 0) + 1);
  };
  const perBash = new Map<string, Set<string>>();
  const claudeHookBash = new Set<string>();
  const tolls: number[] = [];
  let ungroupedFires = 0;
  let fires = 0;
  let ms = 0;

  for (const s of sessions) {
    if (!measurable(s.availability?.hooks)) continue;
    const runs: Run[] = [s.orchestrator, ...s.agents];
    for (const run of runs) {
      const measured = run.hookEvents.filter((e) => e.verdict !== "gate-started");
      tolls.push(...tollGroups(measured.filter((e) => e.toolUseId)).map(maxMs));
      ungroupedFires += measured.filter((e) => !e.toolUseId).length;
      for (const e of run.hookEvents) {
        // `gate-started` is the first half of one execution, not a second fire
        // and not an outcome: it is neither counted nor tabulated.
        if (e.verdict === "gate-started") continue;
        count(e.name, e.verdict);
        const hook = getOrSet(byHook, e.name, () => ({
          fires: 0,
          ms: 0,
          blocks: new Map<string, RuleStat>(),
        }));
        hook.fires += 1;
        hook.ms += e.ms;
        fires += 1;
        ms += e.ms;
        if (e.tool === "Bash" && e.toolUseId && s.availability?.hooks?.state === "observed") {
          getOrSet(perBash, `${s.sessionId}\u0000${e.toolUseId}`, () => new Set<string>()).add(
            `${e.name}\u0000${e.phase}`,
          );
          if (s.host !== "codex" && s.unavailable !== "transcript") {
            claudeHookBash.add(`${s.sessionId}\u0000${e.toolUseId}`);
          }
        }
        if (e.verdict === "block") {
          const rule = getOrSet(
            hook.blocks,
            (e.reason ?? "(no reason)").slice(0, RULE_KEY_MAX),
            () => ({ count: 0, examples: [] }),
          );
          rule.count += 1;
          if (e.kind && !rule.kind) rule.kind = e.kind;
          const command = e.toolUseId ? run.blockedCommands?.[e.toolUseId] : undefined;
          // Redacted again on the way out: a model built by a different writer
          // must not be able to carry a raw command into the report.
          if (command && rule.examples.length < EXAMPLES_PER_RULE) {
            rule.examples.push(redactExample(command));
          }
        }
      }
    }
    // `*-outcome` events are task outcomes (spec 0042 D5), not hook/CLI decisions.
    for (const e of s.cliEvents ?? []) if (!e.name.endsWith("-outcome")) count(e.name, e.verdict);
  }

  const perCall = [...perBash.values()].map((set) => set.size);
  const bashTranscriptCalls = withTranscript.reduce(
    (count, s) =>
      count +
      (s.orchestrator.toolCounts.Bash ?? 0) +
      s.agents.reduce((agentCount, a) => agentCount + (a.toolCounts.Bash ?? 0), 0),
    0,
  );
  return {
    sessions: {
      total: sessions.length,
      transcript: withTranscript.length,
      codex: codexSessions.length,
    },
    codexExecWrappers,
    agents,
    sessionCacheReads: withTranscript
      .filter(
        (s) =>
          s.availability?.["tokens.cacheRead"]?.state === "observed" &&
          s.agents.every((a) => a.availability?.["tokens.cacheRead"]?.state === "observed"),
      )
      .map(
        (s) =>
          s.orchestrator.tokens.cacheRead + s.agents.reduce((n, a) => n + a.tokens.cacheRead, 0),
      ),
    tools,
    hooks: {
      byHook,
      fires,
      ms,
      tollMs: tolls.length > 0 ? sumMs(tolls) : null,
      tollEvents: tolls.length,
      ungroupedFires,
      bashCalls: perBash.size,
      bashTranscriptCalls: withTranscript.length > 0 ? bashTranscriptCalls : null,
      bashCoveragePct:
        bashTranscriptCalls > 0
          ? Math.round((1000 * claudeHookBash.size) / bashTranscriptCalls) / 10
          : null,
      perBashCall:
        perCall.length === 0
          ? null
          : Math.round((perCall.reduce((a, b) => a + b, 0) / perCall.length) * 100) / 100,
      perBashCallP90: quantile(perCall, 0.9),
    },
    mechanism,
  };
}

/**
 * Flattens the range aggregates into `rangeMetrics` (D10). `null` marks a value
 * no session could measure — a range of only Codex sessions has no
 * `agent.main-thread.turns.p90`, and publishing 0 would be a false number.
 * Blocked-command examples are deliberately absent: free text never goes here.
 */
function flattenRangeMetrics(stats: RangeStats): Record<string, number | null> {
  const m: Record<string, number | null> = {
    "sessions.total": stats.sessions.total,
    "sessions.transcript": stats.sessions.transcript,
    "sessions.codex": stats.sessions.codex,
  };
  for (const [name, a] of stats.agents) {
    const p = `agent.${name}`;
    m[`${p}.sessions`] = a.sessions;
    m[`${p}.launches`] = a.launches;
    m[`${p}.turns.p50`] = quantile(a.turns, 0.5);
    m[`${p}.turns.p90`] = quantile(a.turns, 0.9);
    m[`${p}.web.fetch`] = a.fetch;
    m[`${p}.web.search`] = a.search;
    m[`${p}.cacheRead.p50`] = quantile(a.cacheReads, 0.5);
    m[`${p}.cacheRead.n`] = a.cacheReads.length;
    if (name === MAIN_THREAD) {
      m[`${p}.contextPeak.p50`] = quantile(a.contextPeaks, 0.5);
      m[`${p}.contextPeak.p90`] = quantile(a.contextPeaks, 0.9);
      m[`${p}.contextPeak.n`] = a.contextPeaks.length;
      m[`${p}.compactions`] = a.compactions;
    } else {
      m[`${p}.turnLimitHits`] = a.limitMeasured > 0 ? a.turnLimitHits : null;
    }
  }
  for (const [name, t] of stats.tools) {
    const p = `tool.${name}`;
    m[`${p}.calls`] = t.calls;
    m[`${p}.callsMain`] = t.callsMain;
    m[`${p}.callsAgents`] = t.callsAgents;
    m[`${p}.resultBytes.p50`] = quantile(t.resultBytes, 0.5);
    m[`${p}.resultBytes.p90`] = quantile(t.resultBytes, 0.9);
    m[`${p}.resultBytes.n`] = t.resultBytes.length;
  }
  m["session.cacheRead.p50"] = quantile(stats.sessionCacheReads, 0.5);
  m["session.cacheRead.n"] = stats.sessionCacheReads.length;
  // The main thread's share of Edit/Write. It is published beside the
  // activation rate (R67) because activation counts as an opportunity every
  // turn in which an agent was used, so alone it overstates delegation.
  const editTools = ["Edit", "Write"].map((n) => stats.tools.get(n));
  const edits = editTools.reduce((n, t) => n + (t?.calls ?? 0), 0);
  const editsMain = editTools.reduce((n, t) => n + (t?.callsMain ?? 0), 0);
  m["edits.calls"] = edits;
  m["edits.callsMain"] = editsMain;
  m["edits.mainPct"] = edits === 0 ? null : Math.round((1000 * editsMain) / edits) / 10;
  m["hooks.fires"] = stats.hooks.fires;
  m["hooks.ms"] = stats.hooks.ms;
  m["hooks.tollMs"] = stats.hooks.tollMs;
  m["hooks.tollEvents"] = stats.hooks.tollEvents;
  m["hooks.ungroupedFires"] = stats.hooks.ungroupedFires;
  m["hooks.bashCalls"] = stats.hooks.bashCalls;
  m["hooks.bashTranscriptCalls"] = stats.hooks.bashTranscriptCalls;
  m["hooks.bashCoveragePct"] = stats.hooks.bashCoveragePct;
  if (stats.sessions.codex > 0) {
    m["codex.execWrappers"] = stats.codexExecWrappers;
    m["codex.nestedToolCalls"] = null;
  }
  m["hooks.perBashCall"] = stats.hooks.perBashCall;
  m["hooks.perBashCall.p90"] = stats.hooks.perBashCallP90;
  for (const [name, h] of stats.hooks.byHook) {
    m[`hook.${name}.fires`] = h.fires;
    m[`hook.${name}.ms`] = h.ms;
    let blocks = 0;
    for (const [reason, rule] of h.blocks) {
      m[`hook.${name}.blocks.${reason}`] = rule.count;
      blocks += rule.count;
    }
    m[`hook.${name}.blocks`] = blocks;
  }
  for (const [name, row] of stats.mechanism) {
    for (const [verdict, n] of row) m[`mechanism.${name}.${verdict}`] = n;
  }
  return m;
}

/** Declared agent names recovered from `rangeMetrics`, in published order. */
function agentNamesOf(metrics: Record<string, number | null>): string[] {
  return Object.keys(metrics)
    .map((key) => /^agent\.(.+)\.sessions$/.exec(key)?.[1])
    .filter((n): n is string => n !== undefined && n !== MAIN_THREAD);
}

/** `n/d` = not available (no transcript measured it), which is not 0. */
function metric(v: number | null | undefined): string {
  return v === null || v === undefined ? "n/d" : String(v);
}

function rangeTable(header: string[], rows: string[][]): string[] {
  return [
    `| ${header.join(" | ")} |`,
    `|${header.map((_, i) => (i === 0 ? "---" : "---:")).join("|")}|`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ];
}

/** Agents per session, zeros included, plus turns, limit hits and web calls
 *  (R46, R48, R49, R65). */
function agentRangeSection(report: AuditReport, lang: Lang): string[] {
  const m = report.rangeMetrics;
  const names = [MAIN_THREAD, ...agentNamesOf(m)].filter((n) => `agent.${n}.sessions` in m);
  if (names.length === 0) return [];
  const rows = names.map((n) => {
    const p = `agent.${n}`;
    return [
      `\`${n}\``,
      metric(m[`${p}.sessions`]),
      metric(m[`${p}.launches`]),
      `${metric(m[`${p}.turns.p50`])} / ${metric(m[`${p}.turns.p90`])}`,
      n === MAIN_THREAD
        ? `${metric(m[`${p}.contextPeak.p90`])} · ${metric(m[`${p}.compactions`])}`
        : metric(m[`${p}.turnLimitHits`]),
      `${metric(m[`${p}.web.fetch`])} / ${metric(m[`${p}.web.search`])}`,
    ];
  });
  return [
    "",
    "---",
    "",
    `## ${t(lang, "Agentes en el rango", "Agents over the range")}`,
    "",
    t(
      lang,
      "Sesiones en que se lanzó cada agente declarado (los ceros cuentan). Turnos p50 / p90 por lanzamiento; para el hilo principal, pico de contexto p90 · compactaciones; para los agentes, lanzamientos cortados por el límite de turnos. `n/d` = ningún transcript lo midió.",
      "Sessions in which each declared agent was launched (zeros count). Turns p50 / p90 per launch; for the main thread, context peak p90 · compactions; for agents, launches cut by the turn limit. `n/d` = no transcript measured it.",
    ),
    "",
    ...rangeTable(
      [
        t(lang, "agente", "agent"),
        t(lang, "sesiones", "sessions"),
        t(lang, "lanzamientos", "launches"),
        t(lang, "turnos", "turns"),
        t(lang, "contexto · límite", "context · limit"),
        "WebFetch / WebSearch",
      ],
      rows,
    ),
  ];
}

/** Hooks over the range: fires, verdicts, summed time, hooks per Bash call, and
 *  the rules that blocked with redacted examples (R63, R66). */
function hookRangeSection(stats: RangeStats, lang: Lang): string[] {
  const hooks = stats.hooks;
  if (hooks.byHook.size === 0) return [];
  const verdicts = (name: string): string =>
    [...(stats.mechanism.get(name) ?? [])].map(([v, n]) => `${v} ${n}`).join(" · ");
  const rows = [...hooks.byHook]
    .sort((a, b) => b[1].fires - a[1].fires || a[0].localeCompare(b[0]))
    .map(([name, h]) => [`\`${name}\``, String(h.fires), verdicts(name), msLabel(h.ms)]);

  const out = [
    "",
    "---",
    "",
    `## ${t(lang, "Hooks en el rango", "Hooks over the range")}`,
    "",
    t(
      lang,
      `Hooks por llamada Bash: **${metric(hooks.perBashCall)}** (p90 ${metric(hooks.perBashCallP90)}, sobre ${hooks.bashCalls} llamadas con \`toolUseId\`). Trabajo ${msLabel(hooks.ms)}; peaje observable ${hooks.tollMs === null ? "n/d" : msLabel(hooks.tollMs)} en ${hooks.tollEvents} evento(s) correlacionados. ${hooks.ungroupedFires} disparos sin ID quedan fuera del peaje: cobertura incompleta. Bash con hook/transcript Claude: ${hooks.bashTranscriptCalls === null ? "n/d" : `${hooks.bashTranscriptCalls} llamadas, ${metric(hooks.bashCoveragePct)}% cubiertas`}. Codex exec: ${metric(stats.codexExecWrappers)} wrappers, no herramientas internas; llamadas anidadas n/d sin fuente estructurada.`,
      `Hooks per Bash call: **${metric(hooks.perBashCall)}** (p90 ${metric(hooks.perBashCallP90)}, over ${hooks.bashCalls} calls with a \`toolUseId\`). Work ${msLabel(hooks.ms)}; observable toll ${hooks.tollMs === null ? "n/d" : msLabel(hooks.tollMs)} over ${hooks.tollEvents} correlated event(s). ${hooks.ungroupedFires} fires without an id are excluded from toll: incomplete coverage. Claude Bash with hook/transcript: ${hooks.bashTranscriptCalls === null ? "n/d" : `${hooks.bashTranscriptCalls} calls, ${metric(hooks.bashCoveragePct)}% covered`}. Codex exec: ${metric(stats.codexExecWrappers)} wrappers, not internal tools; nested calls n/d without a structured source.`,
    ),
    "",
    ...rangeTable(
      [
        "hook",
        t(lang, "disparos", "fires"),
        t(lang, "veredictos", "verdicts"),
        t(lang, "tiempo", "time"),
      ],
      rows,
    ),
  ];

  const blocking = [...hooks.byHook].filter(([, h]) => h.blocks.size > 0);
  if (blocking.length > 0) {
    out.push("", `### ${t(lang, "Bloqueos por regla", "Blocks per rule")}`, "");
    for (const [name, h] of blocking) {
      for (const [reason, rule] of h.blocks) {
        out.push(`- \`${name}\` · ${reason} — ${rule.count}${rule.kind ? ` [${rule.kind}]` : ""}`);
        for (const ex of rule.examples) out.push(`  - \`${ex.replaceAll("`", "'")}\``);
      }
    }
  }
  return out;
}

/** Calls and result size per tool, split main thread vs subagents (R64). */
function toolRangeSection(stats: RangeStats, lang: Lang): string[] {
  if (stats.tools.size === 0) return [];
  const rows = [...stats.tools]
    .sort((a, b) => b[1].calls - a[1].calls || a[0].localeCompare(b[0]))
    .map(([name, tl]) => [
      `\`${name}\``,
      String(tl.calls),
      `${tl.callsMain} / ${tl.callsAgents}`,
      `${metric(quantile(tl.resultBytes, 0.5))} / ${metric(quantile(tl.resultBytes, 0.9))}`,
    ]);
  return [
    "",
    "---",
    "",
    `## ${t(lang, "Herramientas en el rango", "Tools over the range")}`,
    "",
    ...rangeTable(
      [
        t(lang, "herramienta", "tool"),
        t(lang, "llamadas", "calls"),
        t(lang, "principal / subagentes", "main / subagents"),
        t(lang, "resultado bytes p50 / p90", "result bytes p50 / p90"),
      ],
      rows,
    ),
  ];
}

/**
 * The frame of R70: any `name × verdict` pair the harness recorded, from hooks
 * and from CLI events, tabulated without knowing the mechanism in advance. A
 * later phase adds its mechanism's names and a fixture — never a counter.
 */
function mechanismSection(stats: RangeStats, lang: Lang): string[] {
  if (stats.mechanism.size === 0) return [];
  const verdicts = [...new Set([...stats.mechanism.values()].flatMap((r) => [...r.keys()]))].sort();
  const rows = [...stats.mechanism]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, row]) => [`\`${name}\``, ...verdicts.map((v) => String(row.get(v) ?? 0))]);
  return [
    "",
    "---",
    "",
    `## ${t(lang, "Mecanismos: nombre × veredicto", "Mechanisms: name × verdict")}`,
    "",
    ...rangeTable([t(lang, "mecanismo", "mechanism"), ...verdicts], rows),
  ];
}

/** Coverage of the period (R62) and, for `--all-repos`, one row per repo (R61). */
function coverageSection(report: AuditReport, lang: Lang): string[] {
  const m = report.rangeMetrics;
  if (!("coverage.sessions.audited" in m) && !report.repos) return [];
  const out = ["", "---", "", `## ${t(lang, "Cobertura", "Coverage")}`, ""];
  out.push(
    t(
      lang,
      `Captura de la cohorte de inicio del host: **${metric(m["coverage.sessions.captured"])} / ${metric(m["coverage.sessions.host"])}** (${metric(m["coverage.pct"])}%). Activaciones en el rango: ${metric(m["coverage.sessions.audited"])}. \`n/d\` = población no enumerable o vacía.`,
      `Capture of host-start cohort: **${metric(m["coverage.sessions.captured"])} / ${metric(m["coverage.sessions.host"])}** (${metric(m["coverage.pct"])}%). Activations during range: ${metric(m["coverage.sessions.audited"])}. \`n/d\` = unenumerable or empty population.`,
    ),
  );
  if (report.repos) {
    out.push(
      "",
      ...rangeTable(
        [
          "repo",
          t(lang, "sesiones auditadas", "audited sessions"),
          t(lang, "sesiones del host", "host sessions"),
          t(lang, "cobertura", "coverage"),
        ],
        report.repos.map((r) => [
          `\`${r.repo}\``,
          metric(r.audited),
          metric(r.host),
          metric(
            report.coverage?.find((c) => c.repo === r.repo)?.ratio == null
              ? null
              : report.coverage.find((c) => c.repo === r.repo)!.ratio! * 100,
          ),
        ]),
      ),
    );
  }
  return out;
}

/** Activation on opportunities beside the main thread's share of edits, and
 *  where the searches went (R67). */
function activationSection(report: AuditReport, lang: Lang): string[] {
  const m = report.rangeMetrics;
  const out: string[] = [];
  if ("activation.total.opportunities" in m) {
    const triggers = [
      ...new Set(Object.keys(m).map((k) => /^activation\.([^.]+)\.opportunities$/.exec(k)?.[1])),
    ].filter((id): id is string => id !== undefined && id !== "total");
    out.push(
      "",
      "---",
      "",
      `## ${t(lang, "Activación sobre oportunidades", "Activation over opportunities")}`,
      "",
      t(
        lang,
        `Ediciones (Edit/Write) hechas por el hilo principal: **${metric(m["edits.mainPct"])}%** (${metric(m["edits.callsMain"])} de ${metric(m["edits.calls"])}). Se publica junto a la activación porque la heurística cuenta como oportunidad todo turno en que se usó el agente: sola, sobrestima la delegación.`,
        `Edit/Write calls made by the main thread: **${metric(m["edits.mainPct"])}%** (${metric(m["edits.callsMain"])} of ${metric(m["edits.calls"])}). Published beside activation because the heuristic counts every turn in which the agent was used as an opportunity: alone, it overstates delegation.`,
      ),
      "",
      ...rangeTable(
        [
          t(lang, "disparador", "trigger"),
          t(lang, "oportunidades", "opportunities"),
          t(lang, "activadas", "hits"),
          "%",
        ],
        [...triggers, "total"].map((id) => [
          `\`${id}\``,
          metric(m[`activation.${id}.opportunities`]),
          metric(m[`activation.${id}.hits`]),
          metric(m[`activation.${id}.pct`]),
        ]),
      ),
    );
  }
  if ("search.wrapper" in m) {
    const routes = Object.keys(m)
      .filter((k) => k.startsWith("search.") && !k.endsWith(".pct"))
      .map((k) => k.slice("search.".length));
    out.push(
      "",
      "---",
      "",
      `## ${t(lang, "Ruteo de búsqueda", "Search routing")}`,
      "",
      t(
        lang,
        `Wrapper + nativo sobre búsquedas reales: **${metric(m["search.good.pct"])}%**. v2 (tgrep + codegraph) contra escape: **${metric(m["search.v2.pct"])}%**. Filtros (\`… | grep\`) y extracciones de archivo conocido: aparte, fuera del cociente.`,
        `Wrapper + native over real searches: **${metric(m["search.good.pct"])}%**. v2 (tgrep + codegraph) against escape: **${metric(m["search.v2.pct"])}%**. Filters (\`… | grep\`) and known-file extractions: separate, excluded from the quotient.`,
      ),
      "",
      ...rangeTable(
        [t(lang, "ruta", "route"), t(lang, "búsquedas", "searches")],
        routes.map((r) => [`\`${r}\``, metric(m[`search.${r}`])]),
      ),
    );
  }
  return out;
}

/** The range sections, in print order. */
function rangeSections(report: AuditReport, lang: Lang): string[] {
  const stats = rangeStats(report.sessions, agentNamesOf(report.rangeMetrics));
  return [
    ...coverageSection(report, lang),
    ...activationSection(report, lang),
    ...agentRangeSection(report, lang),
    ...(measurable(report.availability?.hooks) ? hookRangeSection(stats, lang) : []),
    ...(measurable(report.availability?.tools) ? toolRangeSection(stats, lang) : []),
    ...(measurable(report.availability?.hooks) ? mechanismSection(stats, lang) : []),
  ];
}

/** Use the same contributor-qualified agent count at every public boundary. */
export function projectedAgentCount(report: AuditReport): number | null {
  return measurable(population(report.sessions, "tools")) ? report.totals.agents : null;
}

export function renderMarkdown(
  report: AuditReport,
  lang: Lang,
  options: AuditPublicationOptions = {},
): string {
  report = metadataPublication(report, options);
  const out: string[] = [];
  out.push(`# ${t(lang, "Auditoría del harness", "Harness audit")} — ${report.repo}`);
  out.push("");
  const resource = report.sessions.flatMap((session: SessionAudit) =>
    Object.values(session.sources ?? {}).filter((source) => source?.budget || source?.reading),
  );
  if (resource.length) {
    out.push("## Resource diagnostics", "");
    for (const source of resource) {
      if (source?.budget)
        out.push(
          `- Budget: ${source.budget.retainedFacts}/${source.budget.limits.factsPerReport} facts; omitted ${source.budget.omittedFacts ?? "unknown"} (at least ${source.budget.omittedLowerBound}); ${source.budget.truncated ? "partial" : "within limits"}.`,
        );
      if (source?.reading)
        out.push(
          `- Source: ${source.reading.bytesRead} bytes; invalid UTF-8 ${source.reading.invalidUtf8}; oversized lines ${source.reading.oversizedLines}; omitted ${source.reading.omitted ?? "unknown"} (at least ${source.reading.omittedLowerBound}).`,
        );
    }
    out.push("");
  }
  if (report.schemaVersion === 11) {
    out.push("## " + t(lang, "Disponibilidad de mediciones", "Measurement availability"), "");
    out.push("| Metric | State | N observed / partial / eligible | Reason |", "|---|---|---|---|");
    for (const [name, evidence] of Object.entries(report.availability ?? {}))
      out.push(
        `| ${name} | ${evidence.state} | ${evidence.observed} / ${evidence.partial} / ${evidence.eligible} | ${evidence.reason ?? "—"} |`,
      );
    out.push("");
  }
  if (report.outcomes) {
    const { totals } = report.outcomes;
    out.push(
      "## " + t(lang, "Resultados de revisión", "Review outcomes"),
      "",
      `${totals.tasks} ${t(lang, "tareas", "tasks")} · ${totals.accepted} ${t(lang, "aceptadas localmente", "locally accepted")} · ${totals.open} ${t(lang, "abiertas (censuradas)", "open (censored)")} · ${totals.ambiguous} ${t(lang, "con frontera ambigua", "with ambiguous boundary")}`,
      "",
      "| Task | Episode | Accepted | Review rounds (approved / correlated) | Receipts (ok / stale) | Boundary |",
      "|---|---|---|---|---|---|",
    );
    for (const task of report.outcomes.tasks)
      task.episodes.forEach((episode, index) =>
        out.push(
          `| ${task.feature} | ${index + 1} | ${episode.accepted ? "yes" : "no"} | ${episode.reviews.rounds} (${episode.reviews.approved} / ${episode.reviews.correlated}) | ${episode.receipts.ok} / ${episode.receipts.stale} | ${episode.boundary}${episode.leftCensored ? ", left-censored" : ""} |`,
        ),
      );
    out.push("");
  }
  out.push(
    `${t(lang, "Rango", "Range")}: ${report.range.from} → ${report.range.to} · ` +
      `${report.totals.sessions} ${t(lang, "sesiones", "sessions")} · ` +
      `${projectedAgentCount(report) ?? "unavailable"} ${t(lang, "agentes", "agents")} · ` +
      `${t(lang, "generado por", "generated by")} ${report.generatedBy}`,
  );

  // #778: FIRST, above the skill table and every session. These findings are
  // caveats on the totals, and a caveat printed after the number it qualifies
  // has already failed — which is precisely how a report stating "0.3% with
  // tgrep" was read for two weeks without anyone noticing the sessions it
  // measured predated the plugin.
  out.push(...rangeSignalSection(report, lang));
  out.push(...skillRangeSection(report, lang));
  out.push(...rangeSections(report, lang));

  for (const s of report.sessions) {
    out.push("", "---", "");
    out.push(
      `## ${t(lang, "Sesión", "Session")} ${s.sessionId.slice(0, 8)} · ${s.startedAt.slice(0, 10)}`,
    );
    out.push("");
    if (s.host === "codex" && s.orchestrator.codex) {
      out.push(
        `${t(lang, "**Sesión Codex.**", "**Codex session.**")} Codex ${s.orchestrator.codex.sourceVersion ?? "unavailable"}`,
        "",
      );
      for (const run of [s.orchestrator, ...s.agents]) {
        const facts = run.codex;
        if (!facts) continue;
        const value = (component: CodexUsageComponent): string =>
          facts.usage[component] === null ? "unavailable" : String(facts.usage[component]);
        out.push(
          `Provider usage (${"agentId" in run ? run.agentType : MAIN_THREAD}): input ${value("inputTotal")} · ordinary input ${value("ordinaryInput")} · output ${value("output")} · total ${value("totalTokens")} · reasoning subset ${value("reasoning")}`,
          `Tools: ${
            measurable(("agentId" in run ? run.availability : s.availability)?.tools)
              ? Object.entries(run.toolCounts)
                  .map(([name, count]) => `${name}:${count}`)
                  .join(" ") || "0"
              : "unavailable"
          }`,
          `Turns: ${measurable(("agentId" in run ? run.availability : s.availability)?.turns) ? (run.turns ?? "unavailable") : "unavailable"}`,
          "",
        );
      }
      out.push(permissionsBlock(s, lang));
      continue;
    }
    if (!measurable(s.availability?.tools)) {
      if (s.host === "codex") out.push(t(lang, "**Sesión Codex.**", "**Codex session.**"), "");
      out.push("Measurements unavailable; no source-backed session totals.", "");
      out.push(permissionsBlock(s, lang));
      continue;
    }
    out.push(
      `**${t(lang, "Prompt inicial", "Initial prompt")}:** ${s.initialPrompt.slice(0, 300) || "—"}`,
    );
    out.push("");
    const modes = Object.entries(s.permissionModes)
      .sort((a, b) => b[1] - a[1])
      .map(([m, n]) => `${m}:${n}`)
      .join(" ");
    out.push(
      `${t(lang, "Duración", "Duration")} ${!measurable(s.availability?.wallClockMs) ? "unavailable" : minutes(s.wallClockMs)}${s.availability?.wallClockMs?.state === "partial" ? " (partial)" : ""} · ` +
        `branch \`${s.gitBranch ?? "—"}\` · CC ${s.ccVersions.join(", ") || "—"} · ` +
        `navori ${sessionNavori(s, lang)} · ` +
        `${t(lang, "permisos", "permissions")} ${modes || "—"}` +
        (s.prs.length > 0 ? ` · PRs ${s.prs.join(", ")}` : ""),
    );

    if (s.unavailable === "transcript") {
      out.push(
        "",
        t(
          lang,
          "**Sesión de Codex.** Solo hay log de audit: los hooks y veredictos son reales, y tokens, turnos, herramientas y contexto no están disponibles (no son cero).",
          "**Codex session.** Only the audit log exists: hooks and verdicts are real, while tokens, turns, tools and context are unavailable (not zero).",
        ),
      );
      const ro = s.rollout;
      if (ro?.status === "parsed") {
        const tools = Object.entries(ro.toolCalls)
          .sort((a, b) => b[1] - a[1])
          .map(([name, n]) => `${name}:${n}`)
          .join(" ");
        out.push(
          "",
          t(
            lang,
            `Motor: Codex ${ro.cliVersion ?? "—"} · rollout: ${ro.turns} turnos · herramientas ${tools || "—"}. Tokens y contexto siguen sin estar disponibles.`,
            `Engine: Codex ${ro.cliVersion ?? "—"} · rollout: ${ro.turns} turns · tools ${tools || "—"}. Tokens and context remain unavailable.`,
          ),
        );
      } else {
        out.push(
          "",
          t(
            lang,
            "Motor: Codex · rollout no disponible (no se encontró o no se pudo leer).",
            "Engine: Codex · rollout unavailable (not found or unreadable).",
          ),
        );
      }
    }

    if (stillRunning(s, report.generatedAt)) {
      out.push(
        "",
        t(
          lang,
          `**Sesión en curso.** Log sin sellar, actividad hace menos de ${LIVE_WINDOW_MIN} min: cifras al generar el reporte, no totales. Sella con \`navori audit --stop ${s.sessionId.slice(0, 8)}\` y repite el reporte.`,
          `**Session still running.** Unsealed log, activity under ${LIVE_WINDOW_MIN} min ago: figures at report time, not totals. Seal with \`navori audit --stop ${s.sessionId.slice(0, 8)}\` and rerun the report.`,
        ),
      );
    }

    // #489 — state what the session log could and could not see. A message
    // written while the agent works never fires `UserPromptSubmit`, so the log
    // is blind to it by construction; the transcript is not. Saying so beats a
    // silently partial count in a report whose whole point is attribution.
    const { typed, queued, queuedSystem } = s.prompts;
    const userMessages =
      queued > 0
        ? t(
            lang,
            `**Mensajes del usuario:** ${typed + queued} — ${typed} iniciaron turno; ${queued} llegaron durante el trabajo, dentro del turno y sin disparar el hook. El conteo sale del transcript, no del log.`,
            `**User messages:** ${typed + queued} — ${typed} started a turn; ${queued} arrived during work, inside the turn without firing the hook. Counted from the transcript, not the log.`,
          )
        : t(
            lang,
            `**Mensajes del usuario:** ${typed}, todos al inicio de un turno.`,
            `**User messages:** ${typed}, all starting a turn.`,
          );
    // The same queue carries the host's own traffic — task notifications,
    // cross-session messages — through an identical record, and counting it as
    // human is what made this figure mostly machine (finding A4). The discard
    // is stated rather than applied in silence: a number that shrinks with no
    // explanation is one nobody can audit.
    const hostQueued =
      queuedSystem > 0
        ? t(
            lang,
            ` Aparte, el host encoló ${queuedSystem} mensajes suyos (notificaciones de tareas, mensajes entre sesiones) que no cuentan como humanos.`,
            ` Separately, the host queued ${queuedSystem} messages of its own (task notifications, cross-session messages), which do not count as human.`,
          )
        : "";
    out.push("", userMessages + hostQueued);

    // #722 — the write lane, stated because it had no instrument at all.
    // `guard-destructive` rule 6 only blocks writes to MANAGED targets and the
    // read-lane ratio excludes writes on purpose (#603), so a `sed -i` over
    // ordinary source touched no layer and entered no number. Reported as a
    // count and NOT folded into a ratio: deciding what to do about it comes
    // after seeing it, and a ratio invented today would be the decision.
    const nativeWrites =
      (s.orchestrator.toolCounts.Edit ?? 0) +
      (s.orchestrator.toolCounts.Write ?? 0) +
      (s.orchestrator.toolCounts.NotebookEdit ?? 0);
    const shellWrites = s.orchestrator.shellWrites ?? 0;
    if (nativeWrites + shellWrites > 0) {
      out.push(
        "",
        t(
          lang,
          `**Escrituras del orquestador:** ${nativeWrites} nativas (Edit/Write) · ${shellWrites} por shell (\`>\`, \`sed -i\`, \`tee\`). Shell pasa por el guard solo para archivos managed. Se mide aparte del cociente de lectura.`,
          `**Orchestrator writes:** ${nativeWrites} native (Edit/Write) · ${shellWrites} through shell (\`>\`, \`sed -i\`, \`tee\`). Shell meets the guard only for managed files. Measured separately from the read-lane ratio.`,
        ),
      );
    }

    const observedWrites = s.observedArtifactWrites;
    if (observedWrites === undefined) {
      out.push(
        "",
        t(
          lang,
          "**Artifacts observados:** no disponible — esta sesión se serializó antes de que el parser conservara observaciones de Write/Edit.",
          "**Observed artifacts:** unavailable — this session was serialized before the parser retained Write/Edit observations.",
        ),
      );
    } else {
      const successful = observedWrites.filter((event) => event.outcome === "success").length;
      const failed = observedWrites.filter((event) => event.outcome === "failed").length;
      const unknown = observedWrites.length - successful - failed;
      const outside = observedWrites.filter(
        (event) => event.location.state === "outside-workspace",
      ).length;
      const redacted = observedWrites.filter((event) => event.location.state === "redacted").length;
      out.push(
        "",
        t(
          lang,
          `**Artifacts observados:** ${observedWrites.length} solicitudes nativas (éxito ${successful}, fallidas ${failed}, resultado desconocido ${unknown}); rutas fuera del workspace ${outside}, redactadas ${redacted}. Esto observa llamadas Write/Edit; no declara handoffs, feature, consumidor ni estado.`,
          `**Observed artifacts:** ${observedWrites.length} native requests (success ${successful}, failed ${failed}, outcome unknown ${unknown}); outside-workspace paths ${outside}, redacted ${redacted}. This observes Write/Edit calls; it does not declare a handoff, feature, consumer, or status.`,
        ),
      );
    }

    out.push(
      "",
      `### ${t(lang, "En qué se fueron los tokens", "Where the tokens went")}`,
      "",
      "```",
    );
    const completeUsage = measurementRuns([s]).every((unit) =>
      completeCardEvidence(unit.evidence, false),
    );
    out.push(
      completeUsage
        ? spendBreakdown(s, lang)
        : "Combined token spend unavailable; see measured components below.",
    );
    out.push("```");

    if (s.signals.length > 0) {
      out.push("", `### ${t(lang, "Hallazgos", "Findings")}`, "");
      for (const sig of s.signals) {
        const tag = sig.severity === "high" ? "ALTO" : sig.severity === "warn" ? "MEDIO" : "INFO";
        const tokens = sig.tokens ? ` (~${k(sig.tokens)} tok)` : "";
        out.push(`- **[${tag}] ${sig.kind}**${tokens} — ${sig.summary}`);
        out.push(`  <br>${sig.evidence.split("\n").join("<br>")}`);
      }
    }

    out.push("", `### ${t(lang, "Línea de tiempo", "Timeline")}`, "", "```");
    const completeTime =
      s.availability?.wallClockMs?.state === "observed" &&
      s.agents.every((a) => a.availability?.durationMs?.state === "observed");
    out.push(
      completeTime && completeUsage ? agentTimeline(s, lang) : "Timeline measurements unavailable.",
    );
    out.push("```");

    if (s.agents.length > 0 && completeTime) {
      const wall = wallClockOf(s.agents);
      const sum = s.agents.reduce((n, a) => n + a.durationMs, 0);
      out.push(
        "",
        t(
          lang,
          `Los subagentes suman **${minutes(sum)}** de trabajo en **${minutes(wall)}** de reloj: ` +
            `corrieron en paralelo, así que sumar sus duraciones describe tiempo que nadie esperó.`,
          `The subagents add up to **${minutes(sum)}** of work over **${minutes(wall)}** of clock: ` +
            `they ran in parallel, so summing their durations describes time nobody waited.`,
        ),
      );
    }

    out.push("", `### ${t(lang, "Ficha por agente", "Per-agent card")}`, "");
    out.push(agentCards(s, lang));
    out.push(
      "",
      t(
        lang,
        "> Los `ms` se miden en cada hook solo con audit-mode: incluyen el costo del propio recorder. La **mediana** estima el peaje de otro comando; el total incluye gates largos de commit, no overhead recortable. **Los totales por hook no se suman entre sí**: arrancan en paralelo; `peaje por evento` mide el más lento.",
        "> Each hook measures its `ms` only in audit-mode, including recorder cost. The **median** estimates another command's toll; totals include long commit gates, not removable overhead. **The per-hook totals do not add up**: hooks start in parallel; `per-event toll` measures the slowest.",
      ),
    );

    out.push("", `### ${t(lang, "Por tipo de agente", "By agent type")}`, "", "```");
    out.push(
      completeUsage
        ? byAgentType(s)
        : "Combined agent-type spend unavailable; see measured components above.",
    );
    out.push("```");

    out.push("", `### ${t(lang, "Decisiones de permiso", "Permission decisions")}`, "");
    out.push(permissionsBlock(s, lang));

    // #698 — the two taxonomies side by side, which is the whole point: one is
    // what navori could infer from a free-text result, the other is what the
    // host declared about the same failure. Showing both is what makes the
    // comparison possible; mapping one onto the other would have destroyed it.
    const declared = Object.entries(s.toolErrorTypes).sort((a, b) => b[1] - a[1]);
    if (declared.length > 0) {
      out.push(
        "",
        t(
          lang,
          `**Errores declarados por el host:** ${declared.map(([k, n]) => `${k} ${n}`).join(" · ")}. Son categorías del host; la taxonomía anterior infiere la primera línea y depende del formato del mensaje. No se presume equivalencia entre ambas.`,
          `**Error categories declared by the host:** ${declared.map(([k, n]) => `${k} ${n}`).join(" · ")}. These are host categories; the taxonomy above infers the first line and depends on message format. No equivalence between them is assumed.`,
        ),
      );
    }

    const skills = [
      ...new Set([...s.orchestrator.skillsRead, ...s.agents.flatMap((a) => a.skillsRead)]),
    ];
    out.push("", `### Skills`, "");
    out.push(
      skills.length > 0 ? skills.join(", ") : t(lang, "(ninguna detectada)", "(none detected)"),
    );
    out.push("");
    if (s.hostSkills.length > 0) {
      // Stated separately rather than merged into the list above: these are the
      // ones that are NOT a heuristic, and flattening the two into one line
      // would throw away the only distinction the reader needs (R13).
      out.push(
        t(
          lang,
          `**Declaradas por el host:** ${s.hostSkills.map((sk) => sk.slug).join(", ")} — el host las nombró en \`api_request\`, así que estas no son inferencia.`,
          `**Declared by the host:** ${s.hostSkills.map((sk) => sk.slug).join(", ")} — the host named them on \`api_request\`, so these are not inferred.`,
        ),
        "",
      );
    }
    out.push(
      t(
        lang,
        "> Detección aproximada: incluye la tool `Skill` y los `SKILL.md` abiertos con `cat`/`Read`, que es como se usan en la práctica.",
        "> Approximate detection: covers the `Skill` tool plus `SKILL.md` files opened with `cat`/`Read`, which is how they are used in practice.",
      ),
    );

    if (s.parseErrors > 0) {
      out.push(
        "",
        t(
          lang,
          `> ${s.parseErrors} de ${s.linesRead} líneas no se pudieron leer.`,
          `> ${s.parseErrors} of ${s.linesRead} lines could not be read.`,
        ),
      );
    }
  }

  out.push("");
  return out.join("\n");
}

/** Machine-facing artifact: the stable comparison contract. */
/**
 * The permission decisions of a session — or the statement that nobody was
 * listening (#0021, R12/R14).
 *
 * The two cases must not render alike, which is the whole reason `otelFrom`
 * is a field: "0 manual approvals" and "no third source" are opposite claims,
 * and before this the report could only ever produce the second one while
 * looking like the first.
 */
function permissionsBlock(s: SessionAudit, lang: Lang): string {
  if (!s.otelFrom || !measurable(s.availability?.permissions)) {
    return t(
      lang,
      "> **La tercera fuente no estuvo presente.** Sin receptor OTel no hay decisiones medibles, no cero aprobaciones. El transcript no distingue una aprobación de una tool pre-aprobada; solo muestra rechazos como errores de tool. Ejecuta `navori audit --collect` antes de abrir la sesión para medirlas.",
      "> **The third source was not present.** Without an OTel receiver, permission decisions are unmeasured, not zero approvals. The transcript cannot distinguish a granted prompt from a pre-approved tool; only refusals appear as tool errors. Start `navori audit --collect` before opening the session to measure them.",
    );
  }

  const bySource = Object.entries(s.permissions.bySource)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([source, n]) => `${source} ${n}`)
    .join(" · ");
  // Wider than LABEL: "automáticas" is itself 11 characters, so the shared
  // width would leave the column with no gap at all.
  const width = 14;
  const rows = [
    "```",
    `${t(lang, "humanas", "human").padEnd(width)}${s.permissions.human}`,
    `${t(lang, "automáticas", "automatic").padEnd(width)}${s.permissions.automatic}`,
    `${t(lang, "total", "total").padEnd(width)}${s.permissions.total}`,
    bySource ? `${t(lang, "por source", "by source").padEnd(width)}${bySource}` : "",
    "```",
    "",
    t(
      lang,
      `> Desde \`${s.otelFrom}\`, inicio del receptor en este log; lo anterior no se observó. "Humanas": respuestas a prompts (\`user_*\`); "automáticas": resueltas por config o hook.`,
      `> From \`${s.otelFrom}\`, receiver start in this log; earlier decisions are unobserved. "Human": prompt responses (\`user_*\`); "automatic": resolved by config or hook.`,
    ),
  ].filter((line) => line !== "");
  return rows.join("\n");
}

/** Numeric measurements become null unless their actual component contributed. */
function projectNumbers<T>(
  value: T,
  evidence: (path: string) => MetricEvidence,
  path = "",
): NullableMeasurements<T> {
  let projected: unknown = value;
  if (typeof value === "number")
    projected = Number.isFinite(value) && value >= 0 && measurable(evidence(path)) ? value : null;
  else if (Array.isArray(value))
    projected = value.map((item: unknown, index: number) =>
      projectNumbers(item, evidence, path ? `${path}.${index}` : String(index)),
    );
  else if (typeof value === "object" && value !== null)
    projected = Object.fromEntries(
      Object.entries(value).map(([key, item]: [string, unknown]) => [
        key,
        projectNumbers(item, evidence, path ? `${path}.${key}` : key),
      ]),
    );
  // The recursive transform preserves keys/strings/booleans and only widens numbers.
  return projected as NullableMeasurements<T>;
}

const TOOL_COUNTERS = new Set([
  "models",
  "toolCounts",
  "toolCountsByMode",
  "classifierExemptBashByMode",
  "shellReads",
  "shellWrites",
  "skills",
  "skillsDiscarded",
  "skillAttributionRecords",
  "mcpCalls",
  "mcpInjectedContext",
  "frictionEvents",
  "toolErrors",
  "repeatedCommands",
  "classifierExemptBash",
  "turns",
  "compactions",
  "toolResultBytes",
  "contextPeak",
  "mcpBarredTokens",
]);

/** Component resolver is closed-world: new unknown numeric fields default null. */
function runMeasurementEvidence(unit: MeasurementRun, path: string): MetricEvidence {
  const [field, component] = path.split(".");
  if (field === "tokens") return runEvidence(unit, `tokens.${component}`);
  if (field === "startupTokens") return runEvidence(unit, "startupTokens");
  if (field === "durationMs") return runEvidence(unit, "durationMs");
  if (field === "contextPeak") return runEvidence(unit, "contextPeak");
  if (field === "turns" || field === "models")
    return unit.evidence[field] ?? unit.evidence.tools ?? unknownEvidence();
  if (field === "skills" && path.endsWith(".attributedOutputTokens"))
    return runEvidence(unit, "tokens.output");
  if (field === "hookEvents") return unit.evidence.hooks ?? unknownEvidence();
  if (TOOL_COUNTERS.has(field ?? "")) return unit.evidence.tools ?? unknownEvidence();
  return unknownEvidence();
}

/** Publish every numeric run path through the same resolver used by its N. */
function publishRun(unit: MeasurementRun): NullableMeasurements<Run> {
  const out = projectNumbers(unit.run, (path) => runMeasurementEvidence(unit, path));
  if ("spawnDepth" in unit.run && "spawnDepth" in out) out.spawnDepth = unit.run.spawnDepth;
  if ("availability" in unit.run && "availability" in out) out.availability = unit.run.availability;
  if (!measurable(unit.evidence.tools)) {
    out.toolCounts = null;
  }
  if (unit.run.codex) {
    out.codex = {
      ...unit.run.codex,
      responses: [],
      activity: [],
      usage: { ...unit.run.codex.usage },
      usageAvailability: unit.run.codex.usageAvailability,
    };
  }
  return out;
}

/** Typed schema11 consumer boundary; internal reduction identities do not escape. */
export function publishReport(
  report: AuditReport,
  options: AuditPublicationOptions = {},
): PublishedAuditReport {
  report = metadataPublication(report, options);
  // Outcome counts are plain integers of the join, not per-run measurements:
  // they bypass the numeric nulling below and were already filtered above.
  const { outcomes } = report;
  const runs = measurementRuns(report.sessions);
  const published = projectNumbers(report, () => unknownEvidence());
  const sessions = report.sessions.map((s) => {
    const unit: MeasurementRun = {
      run: s.orchestrator,
      evidence: s.availability ?? {},
      type: MAIN_THREAD,
    };
    const out = projectNumbers(s, (path) => {
      const [field, component] = path.split(".");
      if (
        field === "rollout" &&
        component === "toolCalls" &&
        s.host === "codex" &&
        s.rollout?.status === "parsed"
      )
        return unit.evidence.tools ?? unknownEvidence();
      if (field === "wallClockMs" || field === "activeMs")
        return s.availability?.[field] ?? unknownEvidence();
      if (["permissions", "toolErrorTypes"].includes(field ?? ""))
        return s.availability?.permissions ?? unknownEvidence();
      if (field === "prompts" || field === "permissionModes")
        return s.host === "codex" ? unknownEvidence() : (unit.evidence.tools ?? unknownEvidence());
      return unknownEvidence();
    });
    out.parseErrors = s.parseErrors;
    out.linesRead = s.linesRead;
    out.prs = [...s.prs];
    out.sources = s.sources;
    out.availability = s.availability;
    out.orchestrator = publishRun(unit) as NullableMeasurements<SessionAudit["orchestrator"]>;
    out.agents = s.agents.map(
      (run) =>
        publishRun({
          run,
          evidence: run.availability ?? {},
          type: run.agentType,
        }) as NullableMeasurements<AgentRun>,
    );
    return out;
  });
  const tokenValues = (
    tokens: TokenTotals,
    populations: Record<string, MetricPopulation> | undefined,
  ): NullableMeasurements<TokenTotals> => ({
    input: measurable(populations?.["tokens.input"]) ? tokens.input : null,
    output: measurable(populations?.["tokens.output"]) ? tokens.output : null,
    cacheRead: measurable(populations?.["tokens.cacheRead"]) ? tokens.cacheRead : null,
    cacheCreation: measurable(populations?.["tokens.cacheCreation"]) ? tokens.cacheCreation : null,
    thinking: measurable(populations?.["tokens.thinking"]) ? tokens.thinking : null,
  });
  published.sessions = sessions;
  published.rangeMetrics = report.rangeMetrics;
  published.coverage = report.coverage;
  published.repos = report.repos;
  published.availabilityByAgentType = report.availabilityByAgentType;
  published.totals.sessions = report.totals.sessions;
  published.totals.agents = projectedAgentCount(report);
  published.totals.tokens = tokenValues(report.totals.tokens, report.availability);
  published.totals.startupTokens = measurable(report.availability?.startupTokens)
    ? report.totals.startupTokens
    : null;
  published.totals.byAgentType = Object.fromEntries(
    Object.entries(report.totals.byAgentType).map(([type, row]) => {
      const n = report.availabilityByAgentType?.[type];
      const selected = runs.filter((unit) => unit.type === type && measurable(unit.evidence.tools));
      return [
        type,
        {
          ...row,
          count: measurable(n?.tools) ? selected.length : null,
          sessions: measurable(n?.tools)
            ? report.sessions.filter((s) =>
                measurementRuns([s]).some(
                  (unit) => unit.type === type && measurable(unit.evidence.tools),
                ),
              ).length
            : null,
          tokens: tokenValues(row.tokens, n),
          webFetch: measurable(n?.tools)
            ? selected.reduce((sum, unit) => sum + (unit.run.toolCounts.WebFetch ?? 0), 0)
            : null,
          webSearch: measurable(n?.tools)
            ? selected.reduce((sum, unit) => sum + (unit.run.toolCounts.WebSearch ?? 0), 0)
            : null,
        },
      ];
    }),
  );
  const agentUnits = runs.filter((unit) => unit.type !== MAIN_THREAD);
  const duration = unitPopulation(agentUnits.map((unit) => runEvidence(unit, "durationMs")));
  published.totals.agentDurationMs = measurable(duration)
    ? agentUnits
        .filter((unit) => measurable(runEvidence(unit, "durationMs")))
        .reduce((sum, unit) => sum + ("durationMs" in unit.run ? unit.run.durationMs : 0), 0)
    : null;
  published.totals.agentWallClockMs =
    agentUnits.length &&
    agentUnits.every((unit) => runEvidence(unit, "durationMs").state === "observed")
      ? report.totals.agentWallClockMs
      : null;
  published.totals.byModel = Object.fromEntries(
    Object.keys(report.totals.byModel).map((model) => {
      const units = agentUnits.filter((unit) => "model" in unit.run && unit.run.model === model);
      return [
        model,
        units.some((unit) => measurable(unit.evidence.tools))
          ? units.filter((unit) => measurable(unit.evidence.tools)).length
          : null,
      ];
    }),
  );
  published.totals.skills = report.totals.skills.map((skill) =>
    projectNumbers(skill, (path) =>
      path === "outputTokens"
        ? (report.availability?.[`skill.${skill.slug}.outputTokens`] ?? unknownEvidence())
        : population(report.sessions, "tools"),
    ),
  );
  return {
    ...published,
    schemaVersion: 11,
    availability: report.availability ?? {},
    outcomes,
  };
}

/** Serialize the actual public nullable contract; historical schema10 stays intact. */
export function renderJson(report: AuditReport, options: AuditPublicationOptions = {}): string {
  return `${JSON.stringify(report.schemaVersion === 11 ? publishReport(report, options) : metadataPublication(report, options), null, 2)}\n`;
}
function measurable(evidence: MetricEvidence | undefined): boolean {
  return evidence?.state === "observed" || evidence?.state === "partial";
}

interface MeasurementRun {
  run: Run;
  evidence: Record<string, MetricEvidence>;
  type: string;
}

/** The root and each child are the same exact units used by token sums. */
function measurementRuns(sessions: readonly SessionAudit[]): MeasurementRun[] {
  return sessions.flatMap((s) => [
    { run: s.orchestrator, evidence: s.availability ?? {}, type: MAIN_THREAD },
    ...s.agents.map((run) => ({
      run,
      evidence: run.availability ?? {},
      type: run.agentType,
    })),
  ]);
}

function unknownEvidence(): MetricEvidence {
  return {
    state: "unavailable",
    reason: "not-observed",
    source: "aggregate",
    adapter: null,
    sourceVersion: null,
  };
}

/** Dependencies are qualified separately: a tool stream cannot certify usage. */
function runEvidence(unit: MeasurementRun, key: string): MetricEvidence {
  if (unit.evidence[key]) return unit.evidence[key]!;
  if (key === "contextPeak") {
    const components = ["tokens.input", "tokens.cacheRead", "tokens.cacheCreation"].map(
      (k) => unit.evidence[k] ?? unknownEvidence(),
    );
    if (!components.every(measurable)) return unknownEvidence();
    return {
      ...components[0]!,
      state: components.every((e) => e.state === "observed") ? "observed" : "partial",
      reason: components.every((e) => e.state === "observed") ? null : "not-observed",
    };
  }
  return unknownEvidence();
}

/** Population and value use identical units and an explicit contribution policy. */
function unitPopulation(
  evidence: readonly MetricEvidence[],
  policy: "measured" | "observed-only" = "measured",
): MetricPopulation {
  const out: MetricPopulation = {
    ...unknownEvidence(),
    source: "aggregate",
    eligible: evidence.length,
    observed: 0,
    partial: 0,
    unavailable: 0,
    unsupported: 0,
    invalid: 0,
    policy,
    contributors: 0,
  };
  for (const row of evidence) out[row.state]++;
  out.contributors = out.observed + (policy === "measured" ? out.partial : 0);
  if (out.contributors) {
    out.state = out.observed === out.eligible ? "observed" : "partial";
    out.reason = out.state === "observed" ? null : "not-observed";
  } else if (out.invalid) {
    out.state = "invalid";
    out.reason = "malformed";
  } else if (out.unsupported) {
    out.state = "unsupported";
    out.reason = "unsupported-component";
  }
  return out;
}

/** No contributor is not a measured zero; missing eligible units qualify totals. */
function population(sessions: readonly SessionAudit[], key: string): MetricPopulation {
  const evidence =
    key.startsWith("tokens.") || key === "startupTokens" || key === "tools"
      ? measurementRuns(sessions).map((unit) => runEvidence(unit, key))
      : sessions.map((s) => s.availability?.[key] ?? unknownEvidence());
  return unitPopulation(evidence);
}

/**
 * Skill use across the whole range, by slug (#725, A5).
 *
 * Counted per SESSION, not per detection: "in how many sessions did this skill
 * do anything" is the question a park-level reader asks, and a session that
 * opened one SKILL.md twice is not two of anything.
 *
 * The three buckets stay separate all the way to print. Merging them is how the
 * measurement broke the first time: `skillsRead` already collapsed "invoked"
 * into "its file was opened", and 92 of the park's 135 detections turned out to
 * be the second — so the signal that read it reported skills as used that
 * nobody had asked for.
 */
function tallySkills(sessions: SessionAudit[], catalog: readonly string[]): SkillTally[] {
  const by = new Map<string, SkillTally>();
  const get = (slug: string): SkillTally => {
    const cur = by.get(slug) ?? {
      slug,
      invoked: 0,
      inherited: 0,
      browsed: 0,
      records: 0,
      outputTokens: 0,
    };
    by.set(slug, cur);
    return cur;
  };

  for (const s of sessions) {
    // Per session: a slug seen on the orchestrator and on three agents is one
    // session, not four.
    const seen = new Map<string, SkillSource>();
    const rank: Record<SkillSource, number> = {
      host: 3,
      "skill-tool": 3,
      attribution: 2,
      "skill-md": 1,
    };
    for (const unit of measurementRuns([s])) {
      const run = unit.run;
      if (!measurable(unit.evidence.tools)) continue;
      for (const sk of run.skills) {
        const prev = seen.get(sk.slug);
        if (prev === undefined || rank[sk.source] > rank[prev]) seen.set(sk.slug, sk.source);
        const tally = get(sk.slug);
        tally.records += sk.attributedRecords ?? 0;
        if (measurable(runEvidence(unit, "tokens.output")))
          tally.outputTokens += sk.attributedOutputTokens ?? 0;
      }
    }
    // A host-declared skill the parser could not pin to a run lives only on the
    // session — the same omission #725/A5 closed in the `unused-skills` signal.
    for (const sk of s.hostSkills) seen.set(sk.slug, "host");

    for (const [slug, source] of seen) {
      const tally = get(slug);
      if (source === "skill-md") tally.browsed += 1;
      else if (source === "attribution") tally.inherited += 1;
      else tally.invoked += 1;
    }
  }

  // Every declared skill gets a row, including the ones that did nothing. A
  // table of only what happened cannot answer "which of my skills is dead
  // weight", which is the half of the question that decides whether a skill
  // stays in the catalog at all.
  const declared = new Set(catalog);
  for (const slug of catalog) get(slug);

  // A slug whose ONLY evidence is `skill-md` and that this repo never declared
  // is not a skill. `SKILL_PATH_RE` matches `<word>/SKILL.md` anywhere in a
  // command, so a path typed in prose, a grep pattern or another repo's preset
  // all produce one — `bare`, `buena`, `dup`, `real` and `memory` all showed up
  // that way in this repo's own range. Per session that noise was survivable
  // (the card names the session it came from); in a table that claims to list
  // the repo's skills it reads as fact.
  //
  // The filter is on EVIDENCE, not on the catalog alone: a skill that was
  // genuinely invoked or inherited keeps its row even when undeclared here,
  // because that is a real finding — something ran that this repo does not ship.
  return [...by.values()]
    .filter((r) => declared.has(r.slug) || r.invoked > 0 || r.inherited > 0)
    .sort(
      (a, b) =>
        b.invoked + b.inherited - (a.invoked + a.inherited) ||
        b.records - a.records ||
        a.slug.localeCompare(b.slug),
    );
}

/** Aggregates parsed sessions into the report envelope. */
/** One immutable provider view precedes every report reducer and projection. */
function qualifiedCodexView(
  input: readonly SessionAudit[],
  budget: AuditReadBudget,
): SessionAudit[] {
  // Clone mutable reducer shells only. Provider response/activity objects are
  // read-only inputs, shared across sibling views instead of copying history.
  const runs = new WeakMap<Run, Run>();
  const cloneRun = <T extends Run>(run: T): T => {
    const known = runs.get(run);
    if (known) return known as T;
    const copy: T = {
      ...run,
      tokens: { ...run.tokens },
      toolCounts: { ...run.toolCounts },
    };
    if ("mcpReach" in copy) copy.mcpReach = { ...copy.mcpReach };
    if ("availability" in copy) copy.availability = { ...copy.availability };
    if (run.codex)
      copy.codex = {
        ...run.codex,
        source: { ...run.codex.source },
        usage: { ...run.codex.usage },
        usageAvailability: { ...run.codex.usageAvailability },
      };
    runs.set(run, copy);
    return copy;
  };
  const sessions = input.map((session: SessionAudit): SessionAudit => ({
    ...session,
    availability: { ...session.availability },
    orchestrator: cloneRun(session.orchestrator),
    agents: session.agents.map((run: AgentRun): AgentRun => cloneRun(run)),
    rollout: session.rollout ? { ...session.rollout } : undefined,
    sources: session.sources
      ? Object.fromEntries(
          Object.entries(session.sources).map(([key, source]) => [key, { ...source }]),
        )
      : undefined,
  }));
  const components: CodexUsageComponent[] = [
    "inputTotal",
    "ordinaryInput",
    "cacheRead",
    "cacheWrite",
    "output",
    "reasoning",
    "totalTokens",
  ];
  const tokenComponents = {
    input: "ordinaryInput",
    output: "output",
    cacheRead: "cacheRead",
    cacheCreation: "cacheWrite",
    thinking: "reasoning",
  } as const;
  const responseGroups = new Map<string, CodexResponseFact[]>();
  const activityNames = new Map<string, Set<string | null>>();
  for (const session of sessions)
    for (const run of [session.orchestrator, ...session.agents]) {
      if (run.codex) {
        const facts = run.codex;
        const owned = measurable(facts.source)
          ? facts.responses.filter(
              (fact) =>
                fact.threadId === facts.threadId && fact.rootSessionId === facts.rootSessionId,
            )
          : [];
        if (measurable(facts.source) && owned.length !== facts.responses.length)
          facts.source = {
            ...facts.source,
            state: "partial",
            reason: "ownership-unknown",
          };
        facts.responses = owned;
      }
      for (const fact of run.codex?.activity ?? []) {
        const key = JSON.stringify([
          run.codex!.rootSessionId,
          run.codex!.threadId,
          fact.kind,
          fact.id,
        ]);
        if (
          !activityNames.has(key) &&
          !retainAuditFact(budget, session.sessionId, {
            kind: "activity-group",
          })
        )
          continue;
        const names = activityNames.get(key) ?? new Set<string | null>();
        if (
          !names.has(fact.name) &&
          !retainAuditFact(budget, session.sessionId, { kind: "activity-name" })
        )
          continue;
        names.add(fact.name);
        activityNames.set(key, names);
      }
      for (const fact of run.codex?.responses ?? []) {
        const key = JSON.stringify([fact.rootSessionId, fact.threadId, fact.responseId]);
        if (
          !responseGroups.has(key) &&
          !retainAuditFact(budget, session.sessionId, {
            kind: "response-group",
          })
        )
          continue;
        const copies = responseGroups.get(key) ?? [];
        if (!retainAuditFact(budget, session.sessionId, { kind: "response-copy" })) continue;
        copies.push(fact);
        responseGroups.set(key, copies);
      }
    }
  const charged = new Set<string>();
  const ownedActivity = new Set<string>();
  for (const session of sessions)
    for (const run of [session.orchestrator, ...session.agents]) {
      const facts = run.codex;
      if (!facts) continue;
      facts.usage = { ...facts.usage };
      facts.usageAvailability = { ...facts.usageAvailability };
      run.tokens = { ...run.tokens };
      const availability =
        "agentId" in run ? (run.availability ??= {}) : (session.availability ??= {});
      const rows = new Map<string, CodexResponseFact[]>();
      for (const fact of facts.responses) {
        const key = JSON.stringify([fact.rootSessionId, fact.threadId, fact.responseId]);
        if (!charged.has(key) && responseGroups.has(key)) rows.set(key, responseGroups.get(key)!);
      }
      for (const key of rows.keys()) charged.add(key);
      for (const component of components) {
        const values: number[] = [];
        let conflict = false;
        let malformed = false;
        let excluded = facts.source.state !== "observed";
        for (const copies of rows.values()) {
          const identities = new Set(
            copies.map((copy) => JSON.stringify([copy.turnId, copy.model])),
          );
          const amounts = new Set(copies.map((copy) => copy.values[component]));
          if (identities.size !== 1 || amounts.size !== 1) {
            conflict = true;
            continue;
          }
          const value = copies[0]!.values[component];
          malformed ||= copies.some((copy) => copy.evidence[component].state === "invalid");
          if (value === null) {
            excluded = true;
            continue;
          }
          values.push(value);
        }
        const sum = values.reduce((a, b) => a + b, 0);
        facts.usage[component] =
          values.length && !conflict && Number.isSafeInteger(sum) ? sum : null;
        facts.usageAvailability[component] = {
          ...facts.source,
          state:
            conflict || (malformed && !values.length)
              ? "invalid"
              : facts.usage[component] !== null
                ? excluded
                  ? "partial"
                  : "observed"
                : "unavailable",
          reason: conflict
            ? "identity-conflict"
            : malformed
              ? "malformed"
              : facts.usage[component] !== null
                ? excluded
                  ? "not-observed"
                  : null
                : "not-observed",
        };
      }
      for (const [key, component] of Object.entries(tokenComponents)) {
        run.tokens[key as keyof TokenTotals] = facts.usage[component] ?? 0;
        availability[`tokens.${key}`] = facts.usageAvailability[component];
      }
      const activity = facts.activity.filter((fact) => {
        const key = JSON.stringify([facts.rootSessionId, facts.threadId, fact.kind, fact.id]);
        if ((activityNames.get(key)?.size ?? 0) > 1) {
          const family =
            fact.kind === "tool" ? "tools" : fact.kind === "model" ? "models" : "turns";
          availability[family] = {
            ...facts.source,
            state: "invalid",
            reason: "identity-conflict",
          };
          return false;
        }
        if (!activityNames.has(key) || ownedActivity.has(key)) return false;
        ownedActivity.add(key);
        return true;
      });
      run.toolCounts = {};
      run.turns = 0;
      if ("models" in run) run.models = {};
      for (const fact of activity) {
        if (fact.kind === "tool" && fact.name)
          run.toolCounts[fact.name] = (run.toolCounts[fact.name] ?? 0) + 1;
        if (fact.kind === "turn") run.turns = (run.turns ?? 0) + 1;
        if (fact.kind === "model" && fact.name && "models" in run)
          run.models[fact.name] = (run.models[fact.name] ?? 0) + 1;
      }
      if ("agentId" in run) {
        const models = [
          ...new Set(activity.filter((fact) => fact.kind === "model").map((fact) => fact.name)),
        ];
        run.model = models.length === 1 ? models[0]! : null;
      } else if (session.rollout?.status === "parsed") {
        session.rollout.toolCalls = { ...run.toolCounts };
        session.rollout.models = { ...run.models };
        session.rollout.turns = run.turns ?? 0;
        session.rollout.responses = [];
        session.rollout.activity = [];
      }
    }
  return sessions;
}

export function buildReport(
  sessions: SessionAudit[],
  opts: {
    repo: string;
    version: string;
    catalog: HarnessCatalog;
    now?: Date;
    /** Marked logs whose transcript did not resolve (#675). */
    orphanSessions?: string[];
    /**
     * `$navori.version` of the harness the repo has ON DISK right now (#778).
     *
     * Read by the caller, not here, for the same reason the session's own pair
     * is stamped at `--start`: this module is pure over parsed sessions, and a
     * filesystem read hidden inside it would make the report depend on where it
     * was generated. Undefined/null is a legitimate answer (a Codex-only repo,
     * or one never rendered) and only narrows what the range finding can say.
     */
    harnessVersion?: string | null;
    /** Language the range findings are written in. Defaults to English, like
     *  every other machine-facing default here; the caller passes the repo's. */
    lang?: Lang;
    /** Declared agents that carry a navori managed marker (R47). Read by the
     *  caller, like `harnessVersion`: this module does no filesystem work. */
    managedAgents?: string[];
    /**
     * Metrics computed OUTSIDE the parsed sessions — coverage, search routing,
     * activation — merged into `rangeMetrics`. They need the filesystem or the
     * raw transcripts, which this module does not touch.
     */
    extraMetrics?: Record<string, number | null>;
    /** Closed miner-owned evidence; core/provider/coverage evidence is immutable here. */
    extraAvailability?: Record<string, MetricPopulation>;
    /** One row per audited repo, for an `--all-repos` report (R61). */
    repos?: RepoRow[];
    requestedRange?: { from: string; to: string };
    coverage?: AuditReport["coverage"];
    /** Shared bounded discovery/parser context; never an independent index. */
    readBudget?: AuditReadBudget;
  },
): AuditReport {
  const readBudget = opts.readBudget ?? createAuditReadBudget();
  sessions = qualifiedCodexView(sessions, readBudget);
  for (const session of sessions) {
    const health =
      session.sources?.rollout ?? session.sources?.transcript ?? session.sources?.["audit-log"];
    const diagnostics = {
      ...readBudget.diagnostics,
      limits: { ...readBudget.diagnostics.limits },
    };
    if (health) health.budget = diagnostics;
    else if (diagnostics.truncated) {
      session.sources ??= {};
      session.sources["host-metadata"] = {
        state: "partial",
        reason: "incomplete-enumeration",
        source: "aggregate",
        adapter: null,
        sourceVersion: null,
        records: 0,
        validRecords: 0,
        parseErrors: 0,
        incompleteTail: false,
        from: null,
        to: null,
        budget: diagnostics,
      };
    }
    if (readBudget.diagnostics.truncated) {
      for (const evidence of [
        session.availability,
        ...session.agents.map((run: AgentRun) => run.availability),
      ]) {
        if (!evidence) continue;
        for (const [key, row] of Object.entries(evidence)) {
          if (row.state === "observed")
            evidence[key] = {
              ...row,
              state: "partial",
              reason: "incomplete-enumeration",
            };
        }
      }
    }
  }
  const byAgentType: AuditReport["totals"]["byAgentType"] = {};
  const byModel: Record<string, number> = {};
  let tokens = emptyTokens();
  let startupTokens = 0;
  let agents = 0;

  const newRow = (): AuditReport["totals"]["byAgentType"][string] => ({
    count: 0,
    sessions: 0,
    tokens: emptyTokens(),
    webFetch: 0,
    webSearch: 0,
  });
  for (const s of sessions) {
    tokens = addTokens(tokens, sessionTokens(s));
    startupTokens += s.orchestrator.startupTokens;
    // The main thread is a row like any other (R48) — except for a session with
    // no transcript, whose tokens are unavailable rather than zero.
    if (
      s.unavailable !== "transcript" ||
      Object.values(s.orchestrator.codex?.usage ?? {}).some((value) => value !== null)
    ) {
      const main = (byAgentType[MAIN_THREAD] ??= newRow());
      main.count += 1;
      main.sessions += 1;
      main.tokens = addTokens(main.tokens, s.orchestrator.tokens);
      main.webFetch += s.orchestrator.toolCounts.WebFetch ?? 0;
      main.webSearch += s.orchestrator.toolCounts.WebSearch ?? 0;
    }
    const typesSeen = new Set<string>();
    for (const a of s.agents) {
      agents++;
      startupTokens += a.startupTokens;
      const cur = (byAgentType[a.agentType] ??= newRow());
      cur.count += 1;
      if (!typesSeen.has(a.agentType)) {
        typesSeen.add(a.agentType);
        cur.sessions += 1;
      }
      cur.tokens = addTokens(cur.tokens, a.tokens);
      cur.webFetch += a.toolCounts.WebFetch ?? 0;
      cur.webSearch += a.toolCounts.WebSearch ?? 0;
      if (a.model) byModel[a.model] = (byModel[a.model] ?? 0) + 1;
    }
  }

  // Resolve each agent's MCP reach ONCE, here: this is the only place that has
  // both the runs and the harness catalog.
  //
  // `barredTokens` is what turns the finding from a label into a cost (R20): the
  // CLAUDE.md sections that REQUIRE a server are shipped in every agent's
  // startup context whether or not its `tools:` can reach it, so a barred agent
  // pays for instructions it is structurally unable to follow.
  //
  // `barredMcpTokens` is shared with the `unreachable-instructions` signal so
  // the card and the finding cannot drift: this comment used to CLAIM they were
  // the same measurement while the signal ran off a coarser boolean, and the
  // two disagreed in print — a card reading "codegraph vedado · 337 tok" under
  // a session summarised as "0 alto" (#605).
  for (const sess of sessions) {
    for (const a of sess.agents) {
      const declared = opts.catalog.agents.find((d) => d.name === a.agentType);
      for (const server of opts.catalog.mcpFamilies) {
        a.mcpReach[server] = reaches(declared, server);
      }
      a.mcpBarredTokens = barredMcpTokens(declared, opts.catalog);
    }
  }

  const stamps = sessions
    .flatMap((s) => [s.startedAt, s.endedAt])
    .filter(Boolean)
    .sort();

  const skillTally = tallySkills(sessions, opts.catalog.skills);
  const stats = rangeStats(
    sessions,
    opts.catalog.agents.map((a) => a.name),
  );
  const usedAgents = new Set(
    [...stats.agents].filter(([, a]) => a.sessions > 0).map(([name]) => name),
  );
  const candidates = unusedManagedCandidates(
    {
      sessionsConsidered: stats.sessions.transcript,
      managedSkills: opts.catalog.managedSkills ?? [],
      usedSkills: new Set(skillTally.filter((r) => r.invoked + r.inherited > 0).map((r) => r.slug)),
      managedAgents: opts.managedAgents ?? [],
      usedAgents,
    },
    opts.lang ?? "en",
  );

  // Only measured per-run components participate; parser identity zeros stay
  // private when no component contributed to a public aggregate.
  tokens = emptyTokens();
  startupTokens = 0;
  for (const row of Object.values(byAgentType)) row.tokens = emptyTokens();
  for (const s of sessions) {
    for (const run of [
      {
        ...s.orchestrator,
        agentType: MAIN_THREAD,
        availability: s.availability,
      },
      ...s.agents,
    ]) {
      if (measurable(run.availability?.startupTokens)) startupTokens += run.startupTokens;
      for (const key of Object.keys(tokens) as Array<keyof TokenTotals>)
        if (measurable(run.availability?.[`tokens.${key}`])) {
          tokens[key] += run.tokens[key];
          const row = byAgentType[run.agentType];
          if (row) row.tokens[key] += run.tokens[key];
        }
    }
  }
  const rawMetrics = {
    ...flattenRangeMetrics(stats),
    ...Object.fromEntries(
      Object.entries(opts.extraMetrics ?? {}).filter(
        ([key]) => minerMetricKey(key) || key.startsWith("coverage."),
      ),
    ),
  };
  const availability = Object.fromEntries(
    [
      "tokens.input",
      "tokens.output",
      "tokens.cacheRead",
      "tokens.cacheCreation",
      "tokens.thinking",
      "startupTokens",
      "tools",
      "hooks",
      "wallClockMs",
      "activeMs",
    ].map((key) => [key, population(sessions, key)]),
  );
  for (const skill of skillTally)
    availability[`skill.${skill.slug}.outputTokens`] = unitPopulation(
      measurementRuns(sessions)
        .filter((unit) => unit.run.skills.some((row) => row.slug === skill.slug))
        .map((unit) => runEvidence(unit, "tokens.output")),
    );
  const rangeMetrics: Record<string, number | null> = {};
  for (const [key, value] of Object.entries(rawMetrics)) {
    const miner = minerMetricKey(key);
    const external =
      miner && Object.hasOwn(opts.extraMetrics ?? {}, key)
        ? opts.extraAvailability?.[key]
        : undefined;
    availability[key] =
      external ??
      (miner ? unitPopulation([]) : flatMetricPopulation(key, value, sessions, opts.coverage));
    const needsComplete =
      miner && (key.endsWith(".pct") || key.includes(".bucket.") || key.endsWith(".graded"));
    const partialZero = miner && value === 0 && availability[key].state === "partial";
    rangeMetrics[key] =
      !partialZero &&
      (!needsComplete || availability[key].state === "observed") &&
      (measurable(availability[key]) || key.endsWith(".n") || key.startsWith("sessions."))
        ? value
        : null;
  }
  // Spec 0042 T9b: a session that logged no outcome event is `unknown`, not "no review".
  const outcomeEvidence = (kind: "review" | "receipt"): MetricEvidence[] =>
    sessions.map((s) =>
      outcomeKinds(s)[kind]
        ? {
            state: "observed",
            reason: null,
            source: "audit-log",
            adapter: "audit-log",
            sourceVersion: null,
          }
        : unknownEvidence(),
    );
  availability["outcomes.review"] = unitPopulation(outcomeEvidence("review"));
  availability["outcomes.receipt"] = unitPopulation(outcomeEvidence("receipt"));
  const rangeFrom = opts.requestedRange?.from ?? stamps[0]?.slice(0, 10) ?? "";
  const rangeFromMs = rangeFrom ? Date.parse(`${rangeFrom.slice(0, 10)}T00:00:00Z`) : Number.NaN;
  const outcomes = joinOutcomes(sessions, Number.isNaN(rangeFromMs) ? null : rangeFromMs);
  const units = measurementRuns(sessions);
  const availabilityByAgentType = Object.fromEntries(
    Object.keys(byAgentType).map((type) => [
      type,
      Object.fromEntries(
        [
          "tokens.input",
          "tokens.output",
          "tokens.cacheRead",
          "tokens.cacheCreation",
          "tokens.thinking",
          "startupTokens",
          "tools",
        ].map((key) => [
          key,
          unitPopulation(
            units.filter((unit) => unit.type === type).map((unit) => runEvidence(unit, key)),
          ),
        ]),
      ),
    ]),
  );

  return {
    schemaVersion: 11,
    generatedBy: `navori@${opts.version}`,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    repo: opts.repo,
    range: opts.requestedRange ?? {
      from: stamps[0]?.slice(0, 10) ?? "",
      to: stamps[stamps.length - 1]?.slice(0, 10) ?? "",
    },
    ccVersions: [...new Set(sessions.flatMap((s) => s.ccVersions))],
    sessions,
    totals: {
      sessions: sessions.length,
      agents,
      tokens,
      startupTokens,
      byAgentType,
      skills: skillTally,
      byModel,
      agentDurationMs: sessions.reduce(
        (sum, sess) => sum + sess.agents.reduce((n, a) => n + a.durationMs, 0),
        0,
      ),
      agentWallClockMs: sessions.reduce((sum, sess) => sum + wallClockOf(sess.agents), 0),
    },
    signals: sessions
      .filter((s) => s.availability?.tools?.state === "observed")
      .flatMap((s) => s.signals),
    // #778: the caveat on everything above. Computed here rather than per
    // session because the claim it makes — "these totals mix regimes" — only
    // exists at range level.
    rangeSignals: [
      ...harnessRegime(sessions, opts.harnessVersion ?? null, opts.lang ?? "en"),
      // R53/R54 of spec 0026: reviewer/implementer gate lifecycle — duplicate
      // or unknown handles, overlapping reviewer runs, and duration/wait
      // totals once there is enough data. Range-level for the same reason
      // `harnessRegime` is: the sample-size floor is evaluated across sessions.
      ...reviewerGateLifecycle(sessions, opts.lang ?? "en"),
      // #924: a hook declared main-thread-only that fired inside a subagent.
      // Range-level because one session's handful of firings reads as noise —
      // the 80% share only exists across the range.
      ...hookMisfires(sessions, opts.lang ?? "en"),
      // R47: managed skills and agents nobody used, with the N they rest on.
      ...candidates,
    ],
    orphanSessions: opts.orphanSessions ?? [],
    rangeMetrics,
    availability,
    availabilityByAgentType,
    ...(outcomes ? { outcomes } : {}),
    ...(opts.coverage ? { coverage: opts.coverage } : {}),
    ...(opts.repos ? { repos: opts.repos } : {}),
  };
}

/** Dependencies must all be observed for a whole-run statistic. */
function dependentEvidence(values: readonly MetricEvidence[]): MetricEvidence {
  const absent = values.find((value) => !measurable(value));
  if (absent) return absent;
  const first = values[0] ?? unknownEvidence();
  return {
    ...first,
    state: values.every((value) => value.state === "observed") ? "observed" : "partial",
    reason: values.every((value) => value.state === "observed") ? null : "not-observed",
  };
}

/** Actual sample/coverage populations, not a guessed token/tool-family alias. */
function flatMetricPopulation(
  key: string,
  value: number | null,
  sessions: readonly SessionAudit[],
  coverage: AuditReport["coverage"],
): MetricPopulation {
  const units = measurementRuns(sessions);
  const diagnostic = (): MetricPopulation => ({
    ...unitPopulation([]),
    state: "observed",
    reason: null,
    contributors: 0,
  });
  if (key.startsWith("sessions.") || key.endsWith(".n")) return diagnostic();
  if (key.startsWith("coverage.")) {
    const n = coverage?.every((row) => row.host !== null)
      ? coverage.reduce((sum, row) => sum + (row.host ?? 0), 0)
      : null;
    const incomplete =
      !coverage?.length || coverage.some((row) => row.reason === "incomplete-enumeration");
    return {
      ...unitPopulation([]),
      eligible: n,
      source: "host-metadata",
      observed: n ?? 0,
      contributors: n ?? 0,
      state: value === null ? "unavailable" : incomplete ? "partial" : "observed",
      reason:
        value === null
          ? n === 0
            ? "empty-population"
            : "incomplete-enumeration"
          : incomplete
            ? "incomplete-enumeration"
            : null,
    };
  }
  const agent =
    /^agent\.(.+)\.(sessions|launches|turns\.p[59]0|cacheRead\.p50|contextPeak\.p[59]0|compactions|web\.fetch|web\.search|turnLimitHits)$/.exec(
      key,
    );
  if (agent) {
    const [, type, component] = agent;
    const selected = units.filter((unit) => unit.type === type);
    if (component === "sessions" || component === "launches")
      return unitPopulation(
        selected.length
          ? selected.map((unit) => runEvidence(unit, "tools"))
          : sessions.map((s) => s.availability?.tools ?? unknownEvidence()),
        "observed-only",
      );
    const family = component?.startsWith("cacheRead")
      ? "tokens.cacheRead"
      : component?.startsWith("contextPeak")
        ? "contextPeak"
        : component?.startsWith("turns")
          ? "turns"
          : "tools";
    const rows = selected.map((unit): MetricEvidence => {
      if (component?.startsWith("turns") && typeof unit.run.turns !== "number")
        return unknownEvidence();
      if (component?.startsWith("contextPeak") && typeof unit.run.contextPeak !== "number")
        return unknownEvidence();
      if (
        component === "compactions" &&
        (!("compactions" in unit.run) || typeof unit.run.compactions !== "number")
      )
        return unknownEvidence();
      if (
        component === "turnLimitHits" &&
        (!("turnLimitHit" in unit.run) || typeof unit.run.turnLimitHit !== "boolean")
      )
        return unknownEvidence();
      return family === "turns"
        ? (unit.evidence.turns ?? runEvidence(unit, "tools"))
        : runEvidence(unit, family);
    });
    return unitPopulation(rows, "observed-only");
  }
  if (key === "session.cacheRead.p50")
    return unitPopulation(
      sessions.map((s) =>
        dependentEvidence(
          measurementRuns([s]).map((unit) => runEvidence(unit, "tokens.cacheRead")),
        ),
      ),
      "observed-only",
    );
  if (key.startsWith("tool.")) {
    const match = /^tool\.(.+)\.(calls|callsMain|callsAgents|resultBytes\.p[59]0)$/.exec(key);
    if (!match) return unitPopulation([]);
    const [, name, component] = match;
    const selected = units
      .filter((unit) => component !== "callsMain" || unit.type === MAIN_THREAD)
      .filter((unit) => component !== "callsAgents" || unit.type !== MAIN_THREAD);
    if (component?.startsWith("resultBytes")) {
      const samples = selected.flatMap((unit) => {
        const bytes = unit.run.toolResultBytes?.[name ?? ""] ?? [];
        const missing = Math.max(0, (unit.run.toolCounts[name ?? ""] ?? 0) - bytes.length);
        return [
          ...bytes.map((byte) =>
            Number.isFinite(byte) && byte >= 0
              ? runEvidence(unit, "tools")
              : {
                  ...unknownEvidence(),
                  state: "invalid" as const,
                  reason: "malformed" as const,
                },
          ),
          ...Array.from({ length: missing }, () => unknownEvidence()),
        ];
      });
      return unitPopulation(samples, "observed-only");
    }
    return unitPopulation(
      selected.map((unit) => runEvidence(unit, "tools")),
      "observed-only",
    );
  }
  if (key.startsWith("hook") || key.startsWith("mechanism."))
    return unitPopulation(
      sessions.map((s) => s.availability?.hooks ?? unknownEvidence()),
      key.includes("perBashCall") ? "observed-only" : "measured",
    );
  if (key === "codex.execWrappers")
    return unitPopulation(
      sessions
        .filter((s) => s.host === "codex")
        .map((s) => s.availability?.tools ?? unknownEvidence()),
    );
  if (
    key.startsWith("edits.") ||
    key.startsWith("search.") ||
    key.startsWith("activation.") ||
    key.startsWith("codegraph.")
  )
    return unitPopulation(
      units.map((unit) => runEvidence(unit, "tools")),
      "observed-only",
    );
  return unitPopulation([]);
}
