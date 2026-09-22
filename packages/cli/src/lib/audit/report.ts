import { type HarnessCatalog, barredMcpTokens, reaches } from "./harness.ts";
import {
  type AgentRun,
  type AuditReport,
  type HookEvent,
  type InjectedContext,
  type SessionAudit,
  type SkillSource,
  type SkillTally,
  type TokenTotals,
  addTokens,
  emptyTokens,
  recorderWindow,
} from "./model.ts";
import { harnessRegime, hookMisfires, reviewerGateLifecycle, type Lang } from "./signals.ts";

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
  const cards = [orchestratorCard(s, lang)];
  cards.push(
    ...[...s.agents]
      .sort((a, b) => weightedTokens(b.tokens, b.model) - weightedTokens(a.tokens, a.model))
      .map((a) => agentCard(a, s.hookLogFrom, lang, s.agents.length)),
  );
  return cards.join("\n\n");
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
    `${model ? `${model} · ` : ""}${minutes(s.wallClockMs)} · ${s.prompts.typed + s.prompts.queued} ${t(lang, "mensajes del usuario", "user messages")}`,
    "",
    `  ${t(lang, "arranque", "startup").padEnd(14)}${k(o.startupTokens)}`,
    ...reasoningRows(o.tokens, lang),
    `  ${t(lang, "contexto", "context").padEnd(14)}${k(context)}`,
    `  ${"cache_read".padEnd(14)}${k(o.tokens.cacheRead)}${perCall ? ` (${perCall}/tool call)` : ""}`,
    "",
    `  ${t(lang, "skills", "skills").padEnd(LABEL)}${o.skills.length > 0 ? o.skills.map((sk) => sk.slug).join(", ") : t(lang, "—", "—")}`,
    `  ${t(lang, "tools", "tools").padEnd(LABEL)}${toolsLine(o.toolCounts)}`,
    `  ${"mcp".padEnd(LABEL)}${orchestratorMcp(o.mcpCalls, o.mcpInjectedContext ?? {}, lang)}`,
    `  ${"hooks".padEnd(LABEL)}${orchestratorHooksLine(s, lang)}`,
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
  rows.push(`  ${"hooks".padEnd(LABEL)}${agentHooksLine(a, hookLogFrom, lang, agentCount)}`);
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
    const cur = by.get(e.name) ?? { ms: [], blocked: 0, phases: new Set<string>() };
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
    // ` ` as the separator, never a raw NUL: same reason as `gateHandle`.
    const key = `${e.toolUseId} ${e.phase}`;
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
      `${r.records || "—"} | ${r.outputTokens ? k(r.outputTokens) : "—"} |`,
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
      "Sesiones en que cada skill hizo algo. **invocada** = alguien la pidió (tool `Skill`, o el host lo declaró) · **heredada** = una corrida trabajó bajo ella sin pedirla (tramo atribuido) · **solo abierta** = se leyó el archivo y nada más, que no es uso.",
      "Sessions in which each skill did something. **invoked** = somebody asked for it (the `Skill` tool, or the host declared it) · **inherited** = a run worked under it without asking (attributed span) · **only opened** = its file was read and nothing else, which is not use.",
    ),
    "",
    ...header,
    ...body,
    "",
    deadLine,
  ];
}

export function renderMarkdown(report: AuditReport, lang: Lang): string {
  const out: string[] = [];
  out.push(`# ${t(lang, "Auditoría del harness", "Harness audit")} — ${report.repo}`);
  out.push("");
  out.push(
    `${t(lang, "Rango", "Range")}: ${report.range.from} → ${report.range.to} · ` +
      `${report.totals.sessions} ${t(lang, "sesiones", "sessions")} · ` +
      `${report.totals.agents} ${t(lang, "agentes", "agents")} · ` +
      `${t(lang, "generado por", "generated by")} ${report.generatedBy}`,
  );

  // #778: FIRST, above the skill table and every session. These findings are
  // caveats on the totals, and a caveat printed after the number it qualifies
  // has already failed — which is precisely how a report stating "0.3% with
  // tgrep" was read for two weeks without anyone noticing the sessions it
  // measured predated the plugin.
  out.push(...rangeSignalSection(report, lang));
  out.push(...skillRangeSection(report, lang));

  for (const s of report.sessions) {
    out.push("", "---", "");
    out.push(
      `## ${t(lang, "Sesión", "Session")} ${s.sessionId.slice(0, 8)} · ${s.startedAt.slice(0, 10)}`,
    );
    out.push("");
    out.push(
      `**${t(lang, "Prompt inicial", "Initial prompt")}:** ${s.initialPrompt.slice(0, 300) || "—"}`,
    );
    out.push("");
    const modes = Object.entries(s.permissionModes)
      .sort((a, b) => b[1] - a[1])
      .map(([m, n]) => `${m}:${n}`)
      .join(" ");
    out.push(
      `${t(lang, "Duración", "Duration")} ${minutes(s.wallClockMs)} · ` +
        `branch \`${s.gitBranch ?? "—"}\` · CC ${s.ccVersions.join(", ") || "—"} · ` +
        `navori ${sessionNavori(s, lang)} · ` +
        `${t(lang, "permisos", "permissions")} ${modes || "—"}` +
        (s.prs.length > 0 ? ` · PRs ${s.prs.join(", ")}` : ""),
    );

    if (stillRunning(s, report.generatedAt)) {
      out.push(
        "",
        t(
          lang,
          `**Sesión en curso.** El log no está sellado y la última actividad fue hace menos de ${LIVE_WINDOW_MIN} min: cada cifra de abajo es una foto del momento en que se generó el reporte, no un total. Séllala con \`navori audit --stop ${s.sessionId.slice(0, 8)}\` y vuelve a correrlo.`,
          `**Session still running.** The log is unsealed and the last activity was under ${LIVE_WINDOW_MIN} min ago: every figure below is a snapshot taken when the report was built, not a total. Seal it with \`navori audit --stop ${s.sessionId.slice(0, 8)}\` and run this again.`,
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
            `**Mensajes del usuario:** ${typed + queued} — ${typed} iniciaron un turno y ${queued} se escribieron mientras el agente trabajaba. Estos últimos se entregan dentro del turno en curso y NO disparan el hook, así que el log de la sesión no los ve; el conteo sale del transcript.`,
            `**User messages:** ${typed + queued} — ${typed} started a turn and ${queued} were written while the agent was working. The latter are delivered inside the running turn and do NOT fire the hook, so the session log cannot see them; this count comes from the transcript.`,
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
          `**Escrituras del orquestador:** ${nativeWrites} nativas (Edit/Write) · ${shellWrites} por shell (\`>\`, \`sed -i\`, \`tee\`). Las de shell no pasan por el guard salvo que el destino sea un archivo managed, y quedan fuera del cociente de lectura a propósito — se cuentan aquí porque esa vía no tenía instrumento.`,
          `**Orchestrator writes:** ${nativeWrites} native (Edit/Write) · ${shellWrites} through the shell (\`>\`, \`sed -i\`, \`tee\`). Shell writes only meet the guard when the target is a managed file, and they are deliberately out of the read-lane ratio — counted here because that lane had no instrument.`,
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
    out.push(spendBreakdown(s, lang));
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
    out.push(agentTimeline(s, lang));
    out.push("```");

    if (s.agents.length > 0) {
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
        "> Los `ms` de un hook los mide el hook mismo, y solo se miden con audit-mode activo: incluyen el costo del propio recorder. La **mediana** es el peaje que pagaría un comando más; el total incluye las corridas largas, que son el gate haciendo su trabajo en un commit y no overhead que se pueda recortar. **Los totales por hook no se suman entre sí**: los hooks de un mismo evento arrancan en paralelo, así que lo que la sesión esperó es el más lento de cada evento — eso es lo que dice `peaje por evento`.",
        "> A hook's `ms` are measured by the hook itself, and only while audit-mode is on: they include the recorder's own cost. The **median** is the toll one more command would pay; the total includes the long runs, which are the gate doing its job on a commit — not overhead to trim. **The per-hook totals do not add up**: the hooks of one event start in parallel, so what the session waited for is the slowest of each event — that is what `per-event toll` reports.",
      ),
    );

    out.push("", `### ${t(lang, "Por tipo de agente", "By agent type")}`, "", "```");
    out.push(byAgentType(s));
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
          `**Errores declarados por el host:** ${declared.map(([k, n]) => `${k} ${n}`).join(" · ")}. La taxonomía de arriba se infiere de la primera línea del resultado y envejece cada vez que una herramienta reescribe su mensaje; ésta es la categoría que el host mismo puso. No se mapean entre sí a propósito — inventar esa equivalencia sería la inferencia que este dato viene a quitar.`,
          `**Error categories declared by the host:** ${declared.map(([k, n]) => `${k} ${n}`).join(" · ")}. The taxonomy above is inferred from the first line of a result and ages every time a tool rewrites its message; this one is the category the host itself set. They are deliberately not mapped onto each other — inventing that equivalence is the inference this data removes.`,
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
  if (!s.otelFrom) {
    return t(
      lang,
      "> **La tercera fuente no estuvo presente.** Nadie recibía los eventos OTel de esta sesión, así que no hay decisiones de permiso que contar — que NO es lo mismo que cero aprobaciones manuales. En el transcript una aprobación concedida es indistinguible de una tool pre-aprobada; lo único observable son los rechazos, y esos ya están en los errores de tool. Para medirlas, levanta `navori audit --collect` antes de abrir la sesión.",
      "> **The third source was not present.** Nobody was receiving this session's OTel events, so there are no permission decisions to count — which is NOT the same as zero manual approvals. In the transcript a granted prompt is indistinguishable from a pre-approved tool; only refusals are observable, and those are already in the tool errors. To measure them, start `navori audit --collect` before opening the session.",
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
      `> Contadas desde \`${s.otelFrom}\`, el instante en que el receptor empezó a escribir en este log: lo anterior a esa marca no lo vio nadie. "Humanas" son las que alguien respondió en un prompt (\`user_*\`); "automáticas" las que resolvieron la config o un hook.`,
      `> Counted from \`${s.otelFrom}\`, the instant the receiver started writing into this log: anything before that mark nobody saw. "Human" are the ones somebody answered in a prompt (\`user_*\`); "automatic" the ones config or a hook resolved.`,
    ),
  ].filter((line) => line !== "");
  return rows.join("\n");
}

export function renderJson(report: AuditReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
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
    for (const run of [s.orchestrator, ...s.agents]) {
      for (const sk of run.skills) {
        const prev = seen.get(sk.slug);
        if (prev === undefined || rank[sk.source] > rank[prev]) seen.set(sk.slug, sk.source);
        const tally = get(sk.slug);
        tally.records += sk.attributedRecords ?? 0;
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
  },
): AuditReport {
  const byAgentType: AuditReport["totals"]["byAgentType"] = {};
  const byModel: Record<string, number> = {};
  let tokens = emptyTokens();
  let startupTokens = 0;
  let agents = 0;

  for (const s of sessions) {
    tokens = addTokens(tokens, sessionTokens(s));
    startupTokens += s.orchestrator.startupTokens;
    for (const a of s.agents) {
      agents++;
      startupTokens += a.startupTokens;
      const cur = byAgentType[a.agentType] ?? { count: 0, tokens: emptyTokens() };
      byAgentType[a.agentType] = { count: cur.count + 1, tokens: addTokens(cur.tokens, a.tokens) };
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

  return {
    schemaVersion: 9,
    generatedBy: `navori@${opts.version}`,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    repo: opts.repo,
    range: {
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
      skills: tallySkills(sessions, opts.catalog.skills),
      byModel,
      agentDurationMs: sessions.reduce(
        (sum, sess) => sum + sess.agents.reduce((n, a) => n + a.durationMs, 0),
        0,
      ),
      agentWallClockMs: sessions.reduce((sum, sess) => sum + wallClockOf(sess.agents), 0),
    },
    signals: sessions.flatMap((s) => s.signals),
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
    ],
    orphanSessions: opts.orphanSessions ?? [],
  };
}
