import { type HarnessCatalog, barredMcpTokens, reaches } from "./harness.ts";
import {
  type AgentRun,
  type AuditReport,
  type HookEvent,
  type SessionAudit,
  type SkillSource,
  type SkillTally,
  type TokenTotals,
  addTokens,
  emptyTokens,
  recorderWindow,
} from "./model.ts";
import type { Lang } from "./signals.ts";

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
 * Tokens that were actually purchased for a session. The ONE definition.
 *
 * `cache_read` is deliberately excluded: it accumulates per turn (every turn
 * re-reads the whole cached context) and reaches hundreds of millions, which
 * would drown every other figure while representing re-reads of context
 * already paid for. It is reported separately, with that caveat stated.
 *
 * `thinking` is excluded for the opposite reason — it is already IN `output`,
 * not a fourth addend. Measured over the 1028 assistant messages of transcript
 * `4935c4d7` (CC 2.1.236): `output_tokens_details.thinking_tokens <=
 * output_tokens` in 100% of them. Exported because the command's terminal
 * summary used to carry its own arithmetic and added thinking on top, so one
 * run printed two different "billable" totals — in a tool whose product IS the
 * number (finding A3).
 */
export function billable(t: TokenTotals): number {
  return t.input + t.output + t.cacheCreation;
}

function sessionTokens(s: SessionAudit): TokenTotals {
  return s.agents.reduce((acc, a) => addTokens(acc, a.tokens), s.orchestrator.tokens);
}

/** The headline table: where the tokens went, by concept. */
function spendBreakdown(s: SessionAudit, lang: Lang): string {
  const total = sessionTokens(s);
  const startup =
    s.agents.reduce((sum, a) => sum + a.startupTokens, 0) + s.orchestrator.startupTokens;
  const reasoning = total.output;
  const billed = billable(total);
  const rest = Math.max(0, billed - startup - reasoning);

  const rows = [
    [t(lang, "arranque de agentes", "agent startup"), startup],
    // The row always summed `total.output` alone; only the label claimed a sum
    // with `thinking`, which is a subset of output and would be counted twice.
    [t(lang, "razonamiento (output)", "reasoning (output)"), reasoning],
    [t(lang, "contexto de trabajo", "working context"), rest],
  ] as const;

  const lines = rows.map(
    ([label, n]) =>
      `  ${String(label).padEnd(36)} ${k(n).padStart(7)}  ${pct(n, billed).padStart(4)}`,
  );

  return [
    t(lang, `TOTAL facturable ${k(billed)} tokens`, `BILLABLE TOTAL ${k(billed)} tokens`),
    ...lines,
    "",
    t(
      lang,
      `  cache_read acumulado: ${k(total.cacheRead)} — relectura de contexto ya cacheado, se reporta aparte porque se acumula en cada turno y no es gasto nuevo.`,
      `  accumulated cache_read: ${k(total.cacheRead)} — re-reads of already-cached context, reported separately because it accrues every turn and is not new spend.`,
    ),
  ].join("\n");
}

function agentTimeline(s: SessionAudit, lang: Lang): string {
  if (s.agents.length === 0) return t(lang, "(sin subagentes)", "(no subagents)");
  const top = [...s.agents].sort((a, b) => billable(b.tokens) - billable(a.tokens)).slice(0, 15);
  const lines = top.map((a) => {
    const time = a.startedAt.slice(11, 16);
    const par = a.overlapsWith.length > 0 ? "∥" : " ";
    const verdict = a.verdict === "CHANGES_REQUESTED" ? " ⟲" : "";
    return `  ${time} ${par} ${a.agentType.padEnd(16)} ${minutes(a.durationMs).padStart(5)} ${k(billable(a.tokens)).padStart(7)}${verdict}  ${a.description.slice(0, 44)}`;
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
      .sort((a, b) => billable(b.tokens) - billable(a.tokens))
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
 * context is whatever the billable total has LEFT after startup and reasoning.
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
  const context = Math.max(0, billable(o.tokens) - o.startupTokens - o.tokens.output);
  const model = modelsLabel(o.models ?? {});
  const rows = [
    `${model ? `${model} · ` : ""}${minutes(s.wallClockMs)} · ${s.prompts.typed + s.prompts.queued} ${t(lang, "mensajes del usuario", "user messages")}`,
    "",
    `  ${t(lang, "arranque", "startup").padEnd(14)}${k(o.startupTokens)}`,
    ...reasoningRows(o.tokens, lang),
    `  ${t(lang, "contexto", "context").padEnd(14)}${k(context)}`,
    `  ${"cache_read".padEnd(14)}${k(o.tokens.cacheRead)}`,
    "",
    `  ${t(lang, "skills", "skills").padEnd(LABEL)}${o.skills.length > 0 ? o.skills.map((sk) => sk.slug).join(", ") : t(lang, "—", "—")}`,
    `  ${t(lang, "tools", "tools").padEnd(LABEL)}${toolsLine(o.toolCounts)}`,
    `  ${"mcp".padEnd(LABEL)}${orchestratorMcp(o.mcpCalls, lang)}`,
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

/** The orchestrator inherits every tool, so there is no allowlist to cross. */
function orchestratorMcp(calls: Record<string, Record<string, number>>, lang: Lang): string {
  const servers = Object.keys(calls).sort();
  if (servers.length === 0) return t(lang, "—", "—");
  return servers
    .map((server) => {
      const ops = calls[server] ?? {};
      const total = Object.values(ops).reduce((sum, n) => sum + n, 0);
      const detail = Object.entries(ops)
        .sort((x, y) => y[1] - x[1])
        .map(([op, n]) => `${op} ${n}`)
        .join(", ");
      return `${server.padEnd(11)}${total} (${detail})`;
    })
    .join(`\n  ${" ".repeat(LABEL)}`);
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
  const context = Math.max(0, billable(a.tokens) - a.startupTokens - a.tokens.output);

  const rows: string[] = [
    `${a.model ?? "?"} · ${minutes(a.durationMs)}${a.overlapsWith.length > 0 ? t(lang, ` · en paralelo con ${a.overlapsWith.length}`, ` · in parallel with ${a.overlapsWith.length}`) : ""}`,
    "",
    `  ${t(lang, "arranque", "startup").padEnd(14)}${k(a.startupTokens)}`,
    ...reasoningRows(a.tokens, lang),
    `  ${t(lang, "contexto", "context").padEnd(14)}${k(context)}`,
    `  ${"cache_read".padEnd(14)}${k(a.tokens.cacheRead)}`,
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
  if (events.length === 0) return t(lang, "—", "—");
  const by = new Map<string, { ms: number[]; blocked: number; phases: Set<string> }>();
  for (const e of events) {
    const cur = by.get(e.name) ?? { ms: [], blocked: 0, phases: new Set<string>() };
    cur.ms.push(e.ms);
    cur.blocked += e.verdict === "block" ? 1 : 0;
    cur.phases.add(e.phase);
    by.set(e.name, cur);
  }
  return (
    [...by.entries()]
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
      })
      .join(`\n  ${" ".repeat(LABEL)}`)
  );
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
      tok: cur.tok + billable(a.tokens),
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
        "> Los `ms` de un hook los mide el hook mismo, y solo se miden con audit-mode activo: incluyen el costo del propio recorder. La **mediana** es el peaje que pagaría un comando más; el total incluye las corridas largas, que son el gate haciendo su trabajo en un commit y no overhead que se pueda recortar.",
        "> A hook's `ms` are measured by the hook itself, and only while audit-mode is on: they include the recorder's own cost. The **median** is the toll one more command would pay; the total includes the long runs, which are the gate doing its job on a commit — not overhead to trim.",
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
    schemaVersion: 6,
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
    orphanSessions: opts.orphanSessions ?? [],
  };
}
