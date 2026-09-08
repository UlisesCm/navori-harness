import { type HarnessCatalog, barredMcpTokens } from "./harness.ts";
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
 * Above this many wasted tokens the finding is `high`; below it, `warn`.
 *
 * The per-server crossing makes the signal fire on cases the old boolean could
 * not see, and some are small — one `ticket-audit` barred from codegraph costs
 * 337 tokens. Real, worth printing, not worth the severity reserved for the
 * thousands a whole session of barred agents burns. A signal that shouts at
 * every magnitude stops being read.
 */
const UNREACHABLE_HIGH_TOKENS = 2000;

/**
 * Instructions the harness ships to agents that cannot possibly follow them.
 *
 * `tools:` is an allowlist covering MCP servers too, so an agent declaring an
 * explicit list without `mcp__` entries can never call those tools — yet it
 * still receives the full CLAUDE.md hierarchy telling it to. The cost is real
 * and recurring: those sections are re-paid on every agent's startup context.
 *
 * Crossed PER SERVER, not per agent. The previous version asked `hasMcp` — true
 * if the agent reached ANY server — so a `researcher` with engram but without
 * codegraph counted as sighted, and the codegraph section it could not run
 * disappeared from the finding. Measured on 13 real sessions that hid 2k tokens
 * inside a session the signal DID fire on, and missed another one entirely: 17
 * agents, a `researcher` barred from engram, `0 hallazgos altos` (#605).
 */
function unreachableInstructions(session: SessionAudit, cat: HarnessCatalog, lang: Lang): Signal[] {
  if (session.agents.length === 0) return [];

  // Per agent TYPE, since the waste is re-paid at every startup of that type.
  const perType = new Map<string, { runs: number; servers: Record<string, number> }>();
  let wasted = 0;
  for (const run of session.agents) {
    const declared = cat.agents.find((d) => d.name === run.agentType);
    const barred = barredMcpTokens(declared, cat);
    const perRun = Object.values(barred).reduce((sum, n) => sum + n, 0);
    if (perRun === 0) continue;
    wasted += perRun;
    const entry = perType.get(run.agentType) ?? { runs: 0, servers: barred };
    entry.runs++;
    perType.set(run.agentType, entry);
  }
  if (wasted === 0) return [];

  const affected = [...perType.values()].reduce((sum, e) => sum + e.runs, 0);
  const detail = [...perType.entries()]
    .map(([type, e]) => {
      const servers = Object.entries(e.servers)
        .map(([srv, tok]) => `${srv} ${k(tok)} tok`)
        .join(" + ");
      return `${type} x${e.runs} (${servers})`;
    })
    .join(", ");

  return [
    {
      kind: "unreachable-instructions",
      severity: wasted >= UNREACHABLE_HIGH_TOKENS ? "high" : "warn",
      tokens: wasted,
      summary: pick(
        lang,
        `~${k(wasted)} tokens en instrucciones que ${affected} subagentes no pueden ejecutar`,
        `~${k(wasted)} tokens of instructions ${affected} subagents cannot execute`,
      ),
      evidence: pick(
        lang,
        `Vedado por su 'tools:', que es una allowlist e incluye MCP: ${detail}. ` +
          `El costo se re-paga en cada arranque: la sección viaja en el contexto inicial del agente aunque no pueda llamar la tool.`,
        `Barred by their 'tools:', which is an allowlist and covers MCP: ${detail}. ` +
          `The cost is re-paid at every startup: the section ships in the agent's initial context whether or not it can call the tool.`,
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
    // Split by provenance (#607): the two halves lead to different decisions —
    // the user owns theirs, the preset ships navori's — and one merged list of
    // 35 names asks the reader to sort it out by hand.
    const managed = new Set(cat.managedSkills ?? []);
    const own = unused.filter((s) => !managed.has(s));
    const fromNavori = unused.filter((s) => managed.has(s));
    const part = (label: string, list: string[]): string =>
      list.length > 0 ? `${label} (${list.length}): ${list.join(", ")}` : "";
    const evidence = [
      part(pick(lang, "tuyas", "yours"), own),
      part(pick(lang, "de navori", "navori's"), fromNavori),
    ]
      .filter(Boolean)
      .join(" · ");

    out.push({
      kind: "unused-skills",
      severity: "info",
      summary: pick(
        lang,
        `${unused.length} de ${cat.skills.length} skills declaradas no se usaron`,
        `${unused.length} of ${cat.skills.length} declared skills went unused`,
      ),
      evidence: evidence || unused.join(", "),
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

/** The native file/search tools — the vía that costs no classifier round-trip
 *  and no permission prompt, because settings-base puts them in `allow`. */
const NATIVE_TOOLS = new Set(["Read", "Edit", "Write", "Glob", "Grep", "NotebookEdit"]);

/** Which of the three ways to do the same work a tool call took. `other` is
 *  everything that is neither (Task, TodoWrite, WebFetch…): counted in the
 *  total, never presented as an alternative to the other three. */
function toolLane(name: string): "shell" | "native" | "mcp" | "other" {
  if (name === "Bash") return "shell";
  if (NATIVE_TOOLS.has(name)) return "native";
  if (name.startsWith("mcp__")) return "mcp";
  return "other";
}

/** Sum the calls of one lane across a tool histogram. */
function laneTotal(counts: Record<string, number>, lane: ReturnType<typeof toolLane>): number {
  let n = 0;
  for (const [name, count] of Object.entries(counts)) {
    if (toolLane(name) === lane) n += count;
  }
  return n;
}

/**
 * What auto mode's classifier reviewed, counted in shell commands (#574).
 *
 * In auto mode a second model checks each action before it runs, and the check
 * is not uniform: reads and in-workspace edits skip it, and so does anything an
 * `allow` rule already covers — which in a navori repo includes the `mcp__*`
 * families. What is left paying a round-trip is the shell. So the count of Bash
 * calls IS the count of round-trips, and it is the one cost of auto mode that
 * never shows up in the session's own token usage: the classifier runs on its
 * own model, with its own slice of the transcript.
 *
 * Counted per MODE SEGMENT (spec 0016 T4.1), not per dominant mode. The old
 * test was "is `auto` the most frequent entry in `permissionModes`?", which
 * reported ZERO for any session where auto was a minority — precisely the mixed
 * sessions where a reader most needs to know what the auto stretch cost. The
 * per-mode histogram (#584) already attributes each main-thread call to the mode
 * in force when it ran, so the answer was already in the data.
 *
 * Subagents are the honest gap: a subagent transcript declares no mode, so its
 * Bash calls cannot be attributed to a segment. They are added only when the
 * session never left `auto` (nothing to misattribute) and reported as
 * unattributable otherwise — never folded in silently.
 *
 * No `tokens` figure on purpose. Each check sends "a portion of the transcript"
 * whose size this report cannot see, and inventing one would put a made-up
 * number next to measured ones.
 */
function classifierRoundTrips(session: SessionAudit, lang: Lang): Signal[] {
  const autoBash = session.orchestrator.toolCountsByMode.auto?.Bash ?? 0;
  if (autoBash === 0) return [];

  const modes = Object.keys(session.permissionModes);
  const autoOnly = modes.length === 1 && modes[0] === "auto";
  const agentBash = session.agents.reduce((sum, a) => sum + (a.toolCounts.Bash ?? 0), 0);
  const total = autoOnly ? autoBash + agentBash : autoBash;

  const share = pick(
    lang,
    autoOnly
      ? `${autoBash} del orquestador y ${agentBash} de subagentes (la sesión nunca salió de auto, así que sus comandos también pagaron).`
      : `${autoBash} del orquestador, contados solo en los tramos en modo auto de una sesión que usó ${modes.length} modos (${modes.join(", ")}). Los ${agentBash} comandos de subagentes quedan fuera: su transcript no declara modo, así que atribuirlos sería inventar.`,
    autoOnly
      ? `${autoBash} from the orchestrator and ${agentBash} from subagents (the session never left auto, so theirs paid too).`
      : `${autoBash} from the orchestrator, counted only across the auto stretches of a session that used ${modes.length} modes (${modes.join(", ")}). The ${agentBash} subagent commands are excluded: their transcript declares no mode, so attributing them would be invention.`,
  );

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
        `${share} Cada uno agrega un viaje al clasificador ANTES de ejecutarse, con una porción del transcript. Las lecturas, las ediciones dentro del workspace y las llamadas MCP con regla 'allow' no pagan ese viaje. Lo que más lo baja es cambiar de vía —\`Grep\`/\`Read\` nativos y MCP resuelven en ~0.08–0.13s contra ~0.20s (p75 1.83s) de una búsqueda por shell—; para lo que de verdad deba ser shell, agrupar (\`a && b\`) y acotar.`,
        `${share} Each adds a classifier round-trip BEFORE it runs, carrying a slice of the transcript. Reads, in-workspace edits and MCP calls covered by an 'allow' rule pay no such trip. What lowers it most is switching lane — native \`Grep\`/\`Read\` and MCP answer in ~0.08–0.13s against ~0.20s (p75 1.83s) for the same search through the shell; for whatever must stay shell, batch (\`a && b\`) and scope it.`,
      ),
    },
  ];
}

/**
 * Below this share of native reads, the search ladder never started.
 *
 * Measured, not chosen: across 13 audited sessions the native share of the
 * read lane is bimodal — {0, 0, 0, 2, 3, 9, 10, 13}% against {25, 26, 50, 61}%
 * — and 20% sits in the valley between the two groups. It leaves room for the
 * shell reads that have no native equivalent (FS metadata, `git show`, context
 * flags) without demanding purity.
 */
const NATIVE_READ_SHARE = 0.2;

/** Below this many shell reads the ratio is an accident, not a habit. */
const TOOL_MIX_MIN_READS = 10;

/**
 * Does the search ladder actually start? (spec 0016 T4.2.)
 *
 * The gap #576 and #583 left written down: the harness teaches a ladder that
 * goes engram/codegraph → native Grep/Glob → shell, and nothing measured
 * whether any session climbs it. The corpus behind spec 0016 found sessions at
 * 90.2% Bash with 3.0% native — and, decisively, found the same shape in
 * `default` and `acceptEdits` too. So this signal is deliberately MODE-BLIND:
 * auto makes the habit expensive (a classifier round-trip per command), it does
 * not cause it, and a signal that only fired in auto would keep confirming the
 * wrong diagnosis.
 *
 * `warn`, not `info`: unlike the round-trip count — a fact about the mode — this
 * one says the session had cheaper lanes available and did not take them.
 *
 * MEASURED ON THE READ LANE, not on the whole histogram (#603). The first
 * version divided Bash by every tool call and fired above 85%, which failed on
 * the two worst sessions of the 13 audited: both had ZERO native reads — 175
 * and 35 shell reads — and their `Edit`/`Write` calls pulled them to 83% and
 * 84%, just under the line. Writes are the ground the host concedes in auto
 * mode; keeping them in the denominator let editing work mask the read habit
 * the signal exists to catch.
 *
 * The mode-blind stance holds, with a caveat the same 13 sessions add: the
 * highest native share (61%) was the only `acceptEdits`-dominant session, while
 * inside `auto` the spread runs 0% to 50%. The mode does not explain the
 * variance on its own — but an absolute zero showed up only under `auto`.
 */
function toolMix(session: SessionAudit, lang: Lang): Signal[] {
  const counts = session.orchestrator.toolCounts;
  const shellReads = session.orchestrator.shellReads ?? 0;
  if (shellReads < TOOL_MIX_MIN_READS) return [];

  const nativeReads = (counts.Read ?? 0) + (counts.Grep ?? 0) + (counts.Glob ?? 0);
  const lane = nativeReads + shellReads;
  const share = nativeReads / lane;
  if (share >= NATIVE_READ_SHARE) return [];

  const mcp = laneTotal(counts, "mcp");
  const modes = Object.keys(session.permissionModes).join(", ") || "(sin declarar)";

  return [
    {
      kind: "tool-mix",
      severity: "warn",
      summary: pick(
        lang,
        `Solo el ${Math.round(share * 100)}% de las lecturas fue por herramienta nativa: la escalera de búsqueda no arrancó`,
        `Only ${Math.round(share * 100)}% of the reads went through a native tool: the search ladder never started`,
      ),
      evidence: pick(
        lang,
        `${nativeReads} lecturas nativas (Read/Grep/Glob) contra ${shellReads} comandos de shell que hacen ese mismo trabajo (cat, head, sed -n, grep, rg, find, ls…), sobre ${lane} lecturas en total; ${mcp} llamadas MCP. Modo(s): ${modes}. Las escrituras quedan fuera del cálculo a propósito: Edit y Write son terreno que el host ya cede, y contarlas ocultaba sesiones con CERO lecturas nativas. Esto NO es un problema de auto mode: la misma mezcla se midió en default y acceptEdits, donde el shell paga prompt humano en vez de clasificador. Las nativas y MCP están en 'allow' y resuelven en ~0.08–0.13s contra ~0.20s (p75 1.83s) de una búsqueda por shell, y cada Bash arrastra además su batería de hooks y mete su salida completa al contexto. Detección aproximada: por el binario que encabeza cada comando.`,
        `${nativeReads} native reads (Read/Grep/Glob) against ${shellReads} shell commands doing the same job (cat, head, sed -n, grep, rg, find, ls…), out of ${lane} reads in total; ${mcp} MCP calls. Mode(s): ${modes}. Writes are deliberately out of the ratio: Edit and Write are ground the host already concedes, and counting them hid sessions with ZERO native reads. This is NOT an auto-mode problem: the same mix was measured under default and acceptEdits, where the shell pays a human prompt instead of a classifier. Native tools and MCP are in 'allow' and answer in ~0.08–0.13s against ~0.20s (p75 1.83s) for the same search through the shell, and every Bash also drags its hook battery and feeds its full output back into context. Approximate detection: by the binary leading each command.`,
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
  // Coverage that rounds to 100% with nobody caught in the gap is not a
  // finding, it is the healthy case reported as if it were one.
  if (window.coveredPercent >= 100 && blind.length === 0) return [];

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
    ...toolMix(session, lang),
    ...formatDrift(session, lang),
    ...recorderCoverage(session, lang),
  ].sort((a, b) => order[a.severity] - order[b.severity]);
}
