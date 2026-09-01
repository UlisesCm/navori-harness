import type { DeclaredAgent, HarnessCatalog } from "./harness.ts";
import {
  type AgentRun,
  type AuditReport,
  type HookEvent,
  type SessionAudit,
  type TokenTotals,
  addTokens,
  emptyTokens,
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
 * Tokens that were actually purchased for a session.
 *
 * `cache_read` is deliberately excluded: it accumulates per turn (every turn
 * re-reads the whole cached context) and reaches hundreds of millions, which
 * would drown every other figure while representing re-reads of context
 * already paid for. It is reported separately, with that caveat stated.
 */
function billable(t: TokenTotals): number {
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
    [t(lang, "razonamiento (output + thinking)", "reasoning (output + thinking)"), reasoning],
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
      .map((a) => agentCard(a, s.hookLogFrom, lang)),
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
function orchestratorCard(s: SessionAudit, lang: Lang): string {
  const o = s.orchestrator;
  const reasoning = o.tokens.output + o.tokens.thinking;
  const context = Math.max(0, billable(o.tokens) - o.startupTokens - reasoning);
  const rows = [
    `${minutes(s.wallClockMs)} · ${s.prompts.typed + s.prompts.queued} ${t(lang, "mensajes del usuario", "user messages")}`,
    "",
    `  ${t(lang, "arranque", "startup").padEnd(14)}${k(o.startupTokens)}`,
    `  ${t(lang, "razonamiento", "reasoning").padEnd(14)}${k(reasoning)}`,
    `  ${t(lang, "contexto", "context").padEnd(14)}${k(context)}`,
    `  ${"cache_read".padEnd(14)}${k(o.tokens.cacheRead)}`,
    "",
    `  ${t(lang, "skills", "skills").padEnd(LABEL)}${o.skills.length > 0 ? o.skills.map((sk) => sk.slug).join(", ") : t(lang, "—", "—")}`,
    `  ${t(lang, "tools", "tools").padEnd(LABEL)}${toolsLine(o.toolCounts)}`,
    `  ${"mcp".padEnd(LABEL)}${orchestratorMcp(o.mcpCalls, lang)}`,
    `  ${"hooks".padEnd(LABEL)}${hooksLine(o.hookEvents, lang)}`,
  ];
  const head = `### ${t(lang, "orquestador", "orchestrator")} · "${s.initialPrompt.slice(0, 60)}"`;
  return `${head}\n\n\`\`\`\n${rows.join("\n")}\n\`\`\``;
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

function agentCard(a: AgentRun, hookLogFrom: string | null, lang: Lang): string {
  const head = `### ${a.agentType} · "${a.description}"`;
  const reasoning = a.tokens.output + a.tokens.thinking;
  const context = Math.max(0, billable(a.tokens) - a.startupTokens - reasoning);

  const rows: string[] = [
    `${a.model ?? "?"} · ${minutes(a.durationMs)}${a.overlapsWith.length > 0 ? t(lang, ` · en paralelo con ${a.overlapsWith.length}`, ` · in parallel with ${a.overlapsWith.length}`) : ""}`,
    "",
    `  ${t(lang, "arranque", "startup").padEnd(14)}${k(a.startupTokens)}`,
    `  ${t(lang, "razonamiento", "reasoning").padEnd(14)}${k(reasoning)}`,
    `  ${t(lang, "contexto", "context").padEnd(14)}${k(context)}`,
    `  ${"cache_read".padEnd(14)}${k(a.tokens.cacheRead)}`,
    "",
  ];

  // 11, not 9: `veredicto` is itself nine characters, so `padEnd(9)` left it
  // glued to its value (`veredictoCHANGES_REQUESTED`).
  rows.push(`  ${t(lang, "skills", "skills").padEnd(LABEL)}${skillsLine(a, lang)}`);
  rows.push(`  ${t(lang, "tools", "tools").padEnd(LABEL)}${toolsLine(a.toolCounts)}`);
  rows.push(`  ${"mcp".padEnd(LABEL)}${mcpLines(a, lang)}`);
  rows.push(`  ${"hooks".padEnd(LABEL)}${agentHooksLine(a, hookLogFrom, lang)}`);
  if (a.verdict) rows.push(`  ${t(lang, "veredicto", "verdict").padEnd(LABEL)}${a.verdict}`);

  return `${head}\n\n\`\`\`\n${rows.join("\n")}\n\`\`\``;
}

function skillsLine(a: AgentRun, lang: Lang): string {
  if (a.skills.length === 0 && a.skillsDiscarded === 0) return t(lang, "—", "—");
  const used = a.skills
    .map(
      (sk) =>
        `${sk.slug} (${sk.source === "skill-tool" ? t(lang, "tool Skill", "Skill tool") : t(lang, "SKILL.md leído", "SKILL.md read")})`,
    )
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

/** Whether an agent's declared `tools:` lets it reach ONE server. A blanket
 *  `mcp__codegraph__*` grants codegraph and nothing else; an absent `tools:`
 *  inherits everything. */
function reaches(declared: DeclaredAgent | undefined, server: string): boolean {
  if (!declared || declared.tools === null) return true;
  return declared.tools.some(
    (tool) => tool === "*" || tool === `mcp__${server}__*` || tool.startsWith(`mcp__${server}__`),
  );
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
function agentHooksLine(a: AgentRun, hookLogFrom: string | null, lang: Lang): string {
  if (a.hookEvents.length > 0 || !hookLogFrom) return hooksLine(a.hookEvents, lang);
  const from = Date.parse(hookLogFrom);
  const ended = Date.parse(a.endedAt);
  if (!Number.isFinite(from) || !Number.isFinite(ended) || ended >= from) {
    return hooksLine(a.hookEvents, lang);
  }
  const at = hookLogFrom.slice(11, 19);
  return t(
    lang,
    `sin registro · el recorder arrancó a las ${at}Z`,
    `not recorded · the recorder started at ${at}Z`,
  );
}

function hooksLine(events: HookEvent[], lang: Lang): string {
  if (events.length === 0) return t(lang, "—", "—");
  const by = new Map<string, { n: number; ms: number; blocked: number }>();
  for (const e of events) {
    const cur = by.get(e.name) ?? { n: 0, ms: 0, blocked: 0 };
    by.set(e.name, {
      n: cur.n + 1,
      ms: cur.ms + e.ms,
      blocked: cur.blocked + (e.verdict === "block" ? 1 : 0),
    });
  }
  return (
    [...by.entries()]
      // Slowest first: the point of recording `ms` is finding the hook that costs
      // seconds on every tool call.
      .sort((x, y) => y[1].ms - x[1].ms)
      .map(
        ([name, v]) =>
          `${name} ${v.n}× ${(v.ms / 1000).toFixed(1)}s${v.blocked > 0 ? t(lang, ` · ${v.blocked} bloqueos`, ` · ${v.blocked} blocked`) : ""}`,
      )
      .join(`\n  ${" ".repeat(LABEL)}`)
  );
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

/** Human-facing report, in the repo's configured language. */
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
        `${t(lang, "permisos", "permissions")} ${modes || "—"}` +
        (s.prs.length > 0 ? ` · PRs ${s.prs.join(", ")}` : ""),
    );

    // #489 — state what the session log could and could not see. A message
    // written while the agent works never fires `UserPromptSubmit`, so the log
    // is blind to it by construction; the transcript is not. Saying so beats a
    // silently partial count in a report whose whole point is attribution.
    const { typed, queued } = s.prompts;
    out.push(
      "",
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
          ),
    );

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

    out.push("", `### ${t(lang, "Por tipo de agente", "By agent type")}`, "", "```");
    out.push(byAgentType(s));
    out.push("```");

    const skills = [
      ...new Set([...s.orchestrator.skillsRead, ...s.agents.flatMap((a) => a.skillsRead)]),
    ];
    out.push("", `### Skills`, "");
    out.push(
      skills.length > 0 ? skills.join(", ") : t(lang, "(ninguna detectada)", "(none detected)"),
    );
    out.push("");
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
export function renderJson(report: AuditReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** Aggregates parsed sessions into the report envelope. */
export function buildReport(
  sessions: SessionAudit[],
  opts: { repo: string; version: string; catalog: HarnessCatalog },
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
  // pays for instructions it is structurally unable to follow. Same measurement
  // the `unreachable-instructions` signal reports for the session, attributed
  // per agent.
  const mcpSectionTokens = new Map<string, number>();
  for (const section of opts.catalog.sections) {
    for (const server of section.requiresMcp) {
      mcpSectionTokens.set(server, (mcpSectionTokens.get(server) ?? 0) + section.tokens);
    }
  }
  for (const sess of sessions) {
    for (const a of sess.agents) {
      const declared = opts.catalog.agents.find((d) => d.name === a.agentType);
      for (const server of opts.catalog.mcpFamilies) {
        const canReach = reaches(declared, server);
        a.mcpReach[server] = canReach;
        if (!canReach) {
          const wasted = mcpSectionTokens.get(server) ?? 0;
          if (wasted > 0) a.mcpBarredTokens[server] = wasted;
        }
      }
    }
  }

  const stamps = sessions
    .flatMap((s) => [s.startedAt, s.endedAt])
    .filter(Boolean)
    .sort();

  return {
    schemaVersion: 2,
    generatedBy: `navori@${opts.version}`,
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
      byModel,
      agentDurationMs: sessions.reduce(
        (sum, sess) => sum + sess.agents.reduce((n, a) => n + a.durationMs, 0),
        0,
      ),
      agentWallClockMs: sessions.reduce((sum, sess) => sum + wallClockOf(sess.agents), 0),
    },
    signals: sessions.flatMap((s) => s.signals),
  };
}
