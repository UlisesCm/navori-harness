import type { HarnessCatalog } from "./harness.ts";
import type { AgentRun, SessionAudit, Signal } from "./model.ts";
import { recorderWindow } from "./model.ts";

/**
 * Findings, as pure functions over one parsed session plus the harness it ran
 * under. Every signal must be defensible from data on disk — no guesses.
 *
 * The governing rule, set by the harness owner: report what costs TOKENS.
 * Hook latency, quality gates running, and routing decisions all cost seconds
 * rather than context, so they are deliberately absent.
 */

export type Lang = "es" | "en";

/** Read-only agent types: candidates to run in parallel, never conflicting. */
const READ_ONLY_AGENTS = new Set(["researcher", "explorer", "ticket-audit", "auditor"]);

/** A gap under this between two runs means they could have been simultaneous. */
const SERIAL_GAP_MS = 5 * 60 * 1000;

/** Above this share of total tokens, agent startup is worth flagging. */
const STARTUP_SHARE_WARN = 0.25;

/** Unparseable lines above this ratio suggest the transcript format moved. */
const PARSE_ERROR_WARN = 0.01;

function pick(lang: Lang, es: string, en: string): string {
  return lang === "es" ? es : en;
}

function k(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/**
 * Instructions the harness ships to agents that cannot possibly follow them.
 *
 * `tools:` is an allowlist covering MCP servers too, so an agent declaring an
 * explicit list without `mcp__` entries can never call those tools — yet it
 * still receives the full CLAUDE.md hierarchy telling it to. The cost is real
 * and recurring: those sections are re-paid on every agent's startup context.
 */
function unreachableInstructions(session: SessionAudit, cat: HarnessCatalog, lang: Lang): Signal[] {
  const mcpSections = cat.sections.filter((s) => s.requiresMcp.length > 0);
  if (mcpSections.length === 0) return [];

  const blindTypes = new Set(cat.agents.filter((a) => !a.hasMcp).map((a) => a.name));
  const affected = session.agents.filter((a) => blindTypes.has(a.agentType));
  if (affected.length === 0) return [];

  const perAgent = mcpSections.reduce((sum, s) => sum + s.tokens, 0);
  const wasted = perAgent * affected.length;
  const servers = [...new Set(mcpSections.flatMap((s) => s.requiresMcp))].join(", ");

  return [
    {
      kind: "unreachable-instructions",
      severity: "high",
      tokens: wasted,
      summary: pick(
        lang,
        `~${k(wasted)} tokens en instrucciones que ${affected.length} subagentes no pueden ejecutar`,
        `~${k(wasted)} tokens of instructions ${affected.length} subagents cannot execute`,
      ),
      evidence: pick(
        lang,
        `Secciones que exigen MCP (${servers}): ${mcpSections.map((s) => `"${s.title}" ${k(s.tokens)} tok`).join(", ")}. ` +
          `Los agentes ${[...blindTypes].join(", ")} declaran 'tools:' sin entradas mcp__, que es una allowlist e incluye MCP. ` +
          `Costo = ${k(perAgent)} tok x ${affected.length} arranques.`,
        `MCP-requiring sections (${servers}): ${mcpSections.map((s) => `"${s.title}" ${k(s.tokens)} tok`).join(", ")}. ` +
          `Agents ${[...blindTypes].join(", ")} declare 'tools:' with no mcp__ entries, and that field is an allowlist covering MCP. ` +
          `Cost = ${k(perAgent)} tok x ${affected.length} startups.`,
      ),
    },
  ];
}

/** What the agents paid just to exist, before doing any work. */
function startupOverhead(session: SessionAudit, cat: HarnessCatalog, lang: Lang): Signal[] {
  const startup = session.agents.reduce((s, a) => s + a.startupTokens, 0);
  if (startup === 0) return [];
  const work = session.agents.reduce((s, a) => s + a.tokens.output + a.tokens.input, 0);
  const denominator = startup + work;
  const share = denominator > 0 ? startup / denominator : 0;
  const avg = Math.round(startup / Math.max(1, session.agents.length));

  return [
    {
      kind: "startup-overhead",
      severity: share >= STARTUP_SHARE_WARN ? "warn" : "info",
      tokens: startup,
      summary: pick(
        lang,
        `${k(startup)} tokens solo en arrancar ${session.agents.length} agentes (${k(avg)} c/u)`,
        `${k(startup)} tokens just to start ${session.agents.length} agents (${k(avg)} each)`,
      ),
      evidence: pick(
        lang,
        `cache_creation del primer mensaje de cada agente: system prompt + jerarquía de CLAUDE.md + definición + git status. ` +
          `De esos ${k(avg)} tok medios, el CLAUDE.md de este repo aporta ~${k(cat.claudeMdTokens)}. ` +
          `El contenido del contexto inicial no queda en el transcript, solo su tamaño.`,
        `cache_creation of each agent's first message: system prompt + CLAUDE.md hierarchy + definition + git status. ` +
          `Of those ~${k(avg)} tok on average, this repo's CLAUDE.md contributes ~${k(cat.claudeMdTokens)}. ` +
          `The initial context's content is not persisted in the transcript, only its size.`,
      ),
    },
  ];
}

/** Declared but never loaded in this session — dead weight in every context. */
function deadCatalog(session: SessionAudit, cat: HarnessCatalog, lang: Lang): Signal[] {
  const out: Signal[] = [];
  const usedSkills = new Set([
    ...session.orchestrator.skillsRead,
    ...session.agents.flatMap((a) => a.skillsRead),
  ]);
  const unused = cat.skills.filter((s) => !usedSkills.has(s));
  if (unused.length > 0 && cat.skills.length > 0) {
    out.push({
      kind: "unused-skills",
      severity: "info",
      summary: pick(
        lang,
        `${unused.length} de ${cat.skills.length} skills declaradas no se usaron`,
        `${unused.length} of ${cat.skills.length} declared skills went unused`,
      ),
      evidence: unused.join(", "),
    });
  }

  const usedAgents = new Set(session.agents.map((a) => a.agentType));
  const idle = cat.agents.filter((a) => !usedAgents.has(a.name)).map((a) => a.name);
  if (idle.length > 0 && cat.agents.length > 0) {
    out.push({
      kind: "unused-agents",
      severity: "info",
      summary: pick(
        lang,
        `${idle.length} de ${cat.agents.length} agentes declarados no se lanzaron`,
        `${idle.length} of ${cat.agents.length} declared agents were never spawned`,
      ),
      evidence: idle.join(", "),
    });
  }
  return out;
}

/** The same command over and over: rework paid in full tokens each time. */
function rework(session: SessionAudit, lang: Lang): Signal[] {
  const tally = new Map<string, number>();
  const merge = (rec: Record<string, number>): void => {
    for (const [cmd, n] of Object.entries(rec)) tally.set(cmd, (tally.get(cmd) ?? 0) + n);
  };
  merge(session.orchestrator.repeatedCommands);
  for (const a of session.agents) merge(a.repeatedCommands);

  const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (top.length === 0) return [];

  return [
    {
      kind: "repeated-commands",
      severity: top[0]![1] >= 10 ? "warn" : "info",
      summary: pick(
        lang,
        `${top.length} comandos repetidos 3+ veces (el más repetido, ${top[0]![1]}x)`,
        `${top.length} commands repeated 3+ times (top one ${top[0]![1]}x)`,
      ),
      evidence: top.map(([cmd, n]) => `${n}x  ${cmd}`).join("\n"),
    },
  ];
}

/** Blocks and denials that landed in a model's context, so they cost tokens. */
function friction(session: SessionAudit, lang: Lang): Signal[] {
  const total =
    session.orchestrator.frictionEvents + session.agents.reduce((s, a) => s + a.frictionEvents, 0);
  if (total === 0) return [];
  return [
    {
      kind: "friction",
      severity: total >= 20 ? "warn" : "info",
      summary: pick(
        lang,
        `${total} bloqueos de hook o denegaciones de permiso llegaron al contexto`,
        `${total} hook blocks or permission denials reached the context`,
      ),
      evidence: pick(
        lang,
        "Cada bloqueo entra al contexto del agente y cuesta tokens. Límite conocido: las aprobaciones manuales exitosas NO son distinguibles de una tool pre-aprobada.",
        "Each block enters the agent's context and costs tokens. Known limit: successful manual approvals are NOT distinguishable from a pre-approved tool.",
      ),
    },
  ];
}

/** Read-only agents that ran back-to-back when they could have overlapped. */
function serialFanout(session: SessionAudit, lang: Lang): Signal[] {
  const readOnly = session.agents
    .filter((a) => READ_ONLY_AGENTS.has(a.agentType) && a.startedAt && a.endedAt)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const pairs: Array<[AgentRun, AgentRun]> = [];
  for (let i = 1; i < readOnly.length; i++) {
    const prev = readOnly[i - 1]!;
    const cur = readOnly[i]!;
    if (cur.overlapsWith.includes(prev.agentId)) continue;
    const gap = Date.parse(cur.startedAt) - Date.parse(prev.endedAt);
    if (Number.isFinite(gap) && gap >= 0 && gap < SERIAL_GAP_MS) pairs.push([prev, cur]);
  }
  if (pairs.length === 0) return [];
  return [
    {
      kind: "serial-fanout",
      severity: "warn",
      summary: pick(
        lang,
        `${pairs.length} pares de agentes read-only corrieron en serie pudiendo ir en paralelo`,
        `${pairs.length} read-only agent pairs ran serially when they could have overlapped`,
      ),
      evidence: pairs
        .map(
          ([a, b]) =>
            `${a.agentType}(${a.agentId.slice(0, 8)}) → ${b.agentType}(${b.agentId.slice(0, 8)})`,
        )
        .join(", "),
    },
  ];
}

/** Rejected reviews mean the work was paid for more than once. */
function reviewCycles(session: SessionAudit, lang: Lang): Signal[] {
  const rejected = session.agents.filter((a) => a.verdict === "CHANGES_REQUESTED");
  if (rejected.length < 2) return [];
  const tokens = rejected.reduce((s, a) => s + a.tokens.output, 0);
  return [
    {
      kind: "review-cycles",
      severity: "warn",
      tokens,
      summary: pick(
        lang,
        `${rejected.length} revisiones pidieron cambios: el trabajo se pagó más de una vez`,
        `${rejected.length} reviews requested changes: the work was paid for more than once`,
      ),
      evidence: rejected.map((a) => `${a.agentType} ${a.agentId.slice(0, 8)}`).join(", "),
    },
  ];
}

/**
 * The permission mode in force, always reported.
 *
 * Load-bearing context rather than a defect: `auto` steers the model toward
 * Bash over Read/Grep, so a tool histogram read without it looks like the
 * agents are ignoring the harness when they are obeying the mode.
 */
function permissionContext(session: SessionAudit, lang: Lang): Signal[] {
  const modes = Object.entries(session.permissionModes).sort((a, b) => b[1] - a[1]);
  if (modes.length === 0) return [];
  const dominant = modes[0]![0];
  if (dominant !== "auto") return [];
  return [
    {
      kind: "permission-mode",
      severity: "info",
      summary: pick(
        lang,
        `Modo de permisos dominante: auto — interpreta el histograma de tools con eso en mente`,
        `Dominant permission mode: auto — read the tool histogram with that in mind`,
      ),
      evidence: pick(
        lang,
        `${modes.map(([m, n]) => `${m}:${n}`).join(", ")}. En modo auto se instruye usar Bash en vez de Read/Grep, así que un exceso de Bash NO es defecto del harness.`,
        `${modes.map(([m, n]) => `${m}:${n}`).join(", ")}. Auto mode instructs using Bash over Read/Grep, so Bash-heavy usage is NOT a harness defect.`,
      ),
    },
  ];
}

/**
 * What auto mode's classifier reviewed, counted in shell commands (#574).
 *
 * In auto mode a second model checks each action before it runs, and the check
 * is not uniform: reads and in-workspace edits skip it, and so does anything an
 * `allow` rule already covers — which in a navori repo includes the `mcp__*`
 * families. What is left paying a round-trip is the shell, and the harness
 * steers hard toward the shell in this mode. So the count of Bash calls IS the
 * count of round-trips, and it is the one cost of auto mode that never shows up
 * in the session's own token usage: the classifier runs on its own model, with
 * its own slice of the transcript.
 *
 * No `tokens` figure on purpose. Each check sends "a portion of the transcript"
 * whose size this report cannot see, and inventing one would put a made-up
 * number next to measured ones.
 */
function classifierRoundTrips(session: SessionAudit, lang: Lang): Signal[] {
  const modes = Object.entries(session.permissionModes).sort((a, b) => b[1] - a[1]);
  if (modes[0]?.[0] !== "auto") return [];

  const bashOf = (counts: Record<string, number>): number => counts.Bash ?? 0;
  const orchestrator = bashOf(session.orchestrator.toolCounts);
  const agents = session.agents.reduce((sum, a) => sum + bashOf(a.toolCounts), 0);
  const total = orchestrator + agents;
  if (total === 0) return [];

  return [
    {
      kind: "classifier-round-trips",
      severity: "info",
      summary: pick(
        lang,
        `${total} comandos de shell pasaron por el clasificador de auto mode`,
        `${total} shell commands went through auto mode's classifier`,
      ),
      evidence: pick(
        lang,
        `${orchestrator} del orquestador y ${agents} de subagentes. Cada uno agrega un viaje al clasificador ANTES de ejecutarse, con una porción del transcript. Las lecturas, las ediciones dentro del workspace y las llamadas MCP con regla 'allow' no pagan ese viaje: por eso agrupar comandos (\`a && b\`) y acotar las búsquedas es lo que baja el costo, no cambiar de herramienta.`,
        `${orchestrator} from the orchestrator and ${agents} from subagents. Each adds a classifier round-trip BEFORE it runs, carrying a slice of the transcript. Reads, in-workspace edits and MCP calls covered by an 'allow' rule pay no such trip: which is why batching commands (\`a && b\`) and scoping searches is what lowers the cost, not switching tools.`,
      ),
    },
  ];
}

/** The transcript format is internal and may move under us; say so honestly. */
function formatDrift(session: SessionAudit, lang: Lang): Signal[] {
  if (session.linesRead === 0) return [];
  const ratio = session.parseErrors / session.linesRead;
  if (ratio < PARSE_ERROR_WARN) return [];
  return [
    {
      kind: "format-drift",
      severity: "high",
      summary: pick(
        lang,
        `${session.parseErrors} de ${session.linesRead} líneas no se pudieron leer: posible cambio de formato`,
        `${session.parseErrors} of ${session.linesRead} lines were unreadable: possible format change`,
      ),
      evidence: pick(
        lang,
        `Versiones vistas: ${session.ccVersions.join(", ") || "desconocida"}. El formato del transcript es interno de Claude Code y puede cambiar en cualquier release; los números de este reporte pueden estar incompletos.`,
        `Versions seen: ${session.ccVersions.join(", ") || "unknown"}. The transcript format is internal to Claude Code and can change on any release; this report's figures may be incomplete.`,
      ),
    },
  ];
}

/**
 * How much of the session the hook recorder actually saw.
 *
 * The recorder is inlined into the managed hooks, so it only exists from the
 * moment the harness that carries it is on disk. Render or update it mid-run
 * and every hook that fired earlier ran and was never written down — which the
 * report must state, because an empty hook list is otherwise read as "the gate
 * never fired".
 *
 * The trigger is the LATE HORIZON, not the agents caught behind it (#559). A
 * recorder that starts 63 min into a session truncates every count in the
 * report even when all the subagents ran afterwards: the orchestrator spans the
 * whole session, so its histogram is short by whatever fired in that hour. The
 * signal therefore always states the fraction observed, and names the blind
 * agents only when there are some.
 */
function recorderCoverage(session: SessionAudit, lang: Lang): Signal[] {
  const window = recorderWindow(session);
  if (!window) return [];

  const from = Date.parse(window.from);
  const blind = session.agents.filter((a) => {
    const ended = Date.parse(a.endedAt);
    return Number.isFinite(ended) && ended < from;
  });

  const agentsClause = pick(
    lang,
    blind.length > 0
      ? `, y ${blind.length} de ${session.agents.length} agentes corrieron antes de que existiera`
      : "",
    blind.length > 0
      ? `, and ${blind.length} of ${session.agents.length} agents ran before it existed`
      : "",
  );

  return [
    {
      kind: "hook-log-coverage",
      severity: "info",
      summary: pick(
        lang,
        `el recorder observó ${window.coveredPercent}% de la sesión${agentsClause}`,
        `the recorder observed ${window.coveredPercent}% of the session${agentsClause}`,
      ),
      evidence: pick(
        lang,
        `El primer hook registrado es de ${window.from}, ${window.blindMinutes} min después del inicio de la sesión. ` +
          `Un harness renderizado o actualizado a mitad de sesión explica el hueco: esos hooks corrieron, pero sin el recorder que los anota. ` +
          `Todo conteo de hooks del reporte es parcial: la ficha del orquestador lo declara, y la de un agente que terminó antes dice "sin registro", no "ninguno".`,
        `The first recorded hook is from ${window.from}, ${window.blindMinutes} min after the session started. ` +
          `A harness rendered or updated mid-session explains the gap: those hooks did run, without the recorder that writes them down. ` +
          `Every hook count in the report is partial: the orchestrator's card says so, and an agent that finished earlier reads "not recorded", not "none".`,
      ),
    },
  ];
}

/** Runs every detector over one session. */
export function detectSignals(
  session: SessionAudit,
  catalog: HarnessCatalog,
  lang: Lang,
): Signal[] {
  const order = { high: 0, warn: 1, info: 2 } as const;
  return [
    ...unreachableInstructions(session, catalog, lang),
    ...startupOverhead(session, catalog, lang),
    ...rework(session, lang),
    ...reviewCycles(session, lang),
    ...serialFanout(session, lang),
    ...friction(session, lang),
    ...deadCatalog(session, catalog, lang),
    ...permissionContext(session, lang),
    ...classifierRoundTrips(session, lang),
    ...formatDrift(session, lang),
    ...recorderCoverage(session, lang),
  ].sort((a, b) => order[a.severity] - order[b.severity]);
}
