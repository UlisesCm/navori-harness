import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { type HarnessCatalog, barredMcpTokens } from "./harness.ts";
import type { AgentRun, GateExecution, SessionAudit, Signal } from "./model.ts";
import { GATE_HOOK_NAMES, correlateGateExecutions, gateHandle, recorderWindow } from "./model.ts";
import { compareSemver } from "../primitives/semver.ts";
import { RETIRED_AGENTS } from "../../engines/shared/roster.ts";
import { MAIN_THREAD_ONLY_HOOKS } from "../../engines/shared/harness-plan.ts";
import { ORCHESTRATOR_OWNER } from "./parse.ts";
import { roleAliases, skillAliases } from "../assets/activation-aliases.ts";
import { countNonTrivial } from "../diagnose/source-classify.ts";

/**
 * Findings, as pure functions over one parsed session plus the harness it ran
 * under. Every signal must be defensible from data on disk — no guesses.
 *
 * The governing rule, set by the harness owner: report what costs TOKENS.
 * Hook latency, quality gates running, and routing decisions all cost seconds
 * rather than context, so they are deliberately absent.
 */

export type Lang = "es" | "en";

/** Current roster ids whose role never mutates shared state. */
const CURRENT_READ_ONLY_AGENTS = new Set(["scout", "auditor"]);

/**
 * Read-only agent types: candidates to run in parallel, never conflicting.
 *
 * Built from `CURRENT_READ_ONLY_AGENTS` plus every `RETIRED_AGENTS` entry
 * whose `successor` folded into one of them (spec 0026 T17, R43/R44): a
 * historical transcript naming `researcher`/`explorer`/`ticket-audit` must
 * keep the SAME classification its successor (`scout`/`auditor`) has today,
 * or re-auditing an old session would silently change its findings. Before
 * this it was a hand-copied literal set that never gained `scout` when the
 * roster renamed `explorer`/`researcher` into it (#821) — a fresh session
 * with `scout` runs would have missed `serial-fanout` entirely.
 */
const READ_ONLY_AGENTS = new Set([
  ...CURRENT_READ_ONLY_AGENTS,
  ...RETIRED_AGENTS.filter(
    (retired) => retired.successor !== null && CURRENT_READ_ONLY_AGENTS.has(retired.successor),
  ).map((retired) => retired.id),
]);

/** A gap under this between two runs means they could have been simultaneous. */
const SERIAL_GAP_MS = 5 * 60 * 1000;

/** Above this share of total tokens, agent startup is worth flagging. */
const STARTUP_SHARE_WARN = 0.25;

/** Unparseable lines above this ratio suggest the transcript format moved. */
const PARSE_ERROR_WARN = 0.01;

/**
 * Above this share of the session's tool calls, friction is a pattern rather
 * than the harness doing its job once or twice (#929).
 *
 * `frictionEvents / total tool calls` — the total is already on every card
 * (`toolCounts`), so the rate costs nothing new to compute. Measured directly
 * on this repo's own history: parsing every transcript under
 * `~/.claude/projects/<navori-harness>` (97 sessions with at least one tool
 * call) and keeping the 57 with >=50 calls to damp single-event noise, the
 * friction rate sits at p50 0.3%, p90 1.5%, p95 1.8%, max 3.2%. 2% sits just
 * above the p90–p95 band: it flags the worst slice of real sessions without
 * firing on the routine handful of blocks any session accumulates.
 */
const FRICTION_RATE_WARN = 0.02;

/**
 * Below this many tool calls, `FRICTION_RATE_WARN` cannot tell a real pattern
 * from one blocked call landing in a tiny session (#929) — the same role
 * `TOOL_MIX_MIN_READS` plays for the read lane. Sized so a SINGLE friction
 * event alone cannot cross the warn line: 1/60 = 1.7%, under 2%.
 */
const FRICTION_MIN_SAMPLE = 60;

/**
 * Above this share of the session's tool calls, tool errors are a pattern
 * rather than the routine noise of a session that ran a lot of tools (#929) —
 * same defect `unreachable-instructions` had before #926: `total >= 20` grew
 * with volume, not with degradation, so a session that did twice the work at
 * an identical error rate crossed to `warn` for having worked more.
 *
 * Same corpus and method as `FRICTION_RATE_WARN`: on the 57 sessions with
 * >=50 tool calls, the error rate sits at p50 1.4%, p90 4.2%, p95 5.5%, max
 * 10.3%. 5% sits in that p90–p95 band.
 */
const TOOL_ERROR_RATE_WARN = 0.05;

/**
 * Below this many tool calls the error rate is an accident: a single failed
 * command already reads 4% (1/25), still short of `TOOL_ERROR_RATE_WARN`, so
 * one flaky command cannot warn on its own — it takes a real second one.
 */
const TOOL_ERROR_MIN_SAMPLE = 25;

/** Sum of a tool-call histogram, the shared denominator for the two rates
 *  above — the same `toolCounts` field every card already carries. */
function totalToolCalls(counts: Record<string, number>): number {
  return Object.values(counts).reduce((n, c) => n + c, 0);
}

function pick(lang: Lang, es: string, en: string): string {
  return lang === "es" ? es : en;
}

function k(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/**
 * Above this many wasted tokens PER ARRANQUE — `wasted / affected`, the
 * average cost of the SAME barred-agent-type defect across however many times
 * it ran — the finding is `high`; below it, `warn`.
 *
 * Crossed on the unit cost, not the session total (#926): the previous
 * version summed every run of a barred agent type and crossed 2000 purely
 * because a productive day ran it more times, so the identical per-startup
 * defect swung from `warn` to `high` with no change in severity. The total is
 * still real and still printed (`tokens: wasted` below, and the summary text)
 * — it only stopped deciding severity.
 *
 * The cut is set against the one real number this repo has measured:
 * `publisher` barred from one MCP-dependent section costs 731 tok/arranque,
 * and that MUST stay `warn` no matter how many times it runs in a session —
 * that is exactly the case #926 reports as broken. Doubling it (~1500) is the
 * point where a single startup is blind to two sections that size, or to one
 * twice as costly: a defect big enough to earn the top severity on its own,
 * without needing a second run to get there.
 */
const UNREACHABLE_HIGH_TOKENS = 1500;

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
    // An agent declaring `omitClaudeMd` never loads the CLAUDE.md sections
    // this signal crosses against `tools:` — it cannot be barred from
    // instructions it was never handed (#926).
    if (declared?.omitClaudeMd) continue;
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
  // The severity axis: the cost of the defect at ONE startup, not the sum a
  // session's run count happens to accumulate (#926 Parte A). `wasted` keeps
  // deciding `tokens` and the printed total below.
  const wastedPerRun = affected > 0 ? wasted / affected : 0;
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
      severity: wastedPerRun >= UNREACHABLE_HIGH_TOKENS ? "high" : "warn",
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

  // The CLAUDE.md layers this catalog actually read (#926 Parte B): the
  // repo's own file plus the machine-scoped global, when one exists.
  const globalTokens = cat.globalClaudeMd?.tokens ?? 0;
  const hierarchyTokens = cat.claudeMdTokens + globalTokens;
  const globalTitles = (cat.globalClaudeMd?.sections ?? []).map((s) => s.title);
  const globalClause =
    globalTokens > 0
      ? pick(
          lang,
          ` + ~${k(globalTokens)} del global (~/.claude/CLAUDE.md; secciones: ${globalTitles.join(", ")} — solo tamaño y títulos, nunca el cuerpo)`,
          ` + ~${k(globalTokens)} from the global (~/.claude/CLAUDE.md; sections: ${globalTitles.join(", ")} — size and titles only, never the body)`,
        )
      : "";
  const notObserved = cat.notObserved ?? [];
  const notObservedClause =
    notObserved.length > 0
      ? pick(
          lang,
          ` No observado: ${notObserved.join(", ")}.`,
          ` Not observed: ${notObserved.join(", ")}.`,
        )
      : "";
  // Agents that declare `omitClaudeMd` never pay this hierarchy at all
  // (#926), so folding their startup into the same average overstates what
  // they actually loaded — say so rather than let the number imply otherwise.
  const omitCount = session.agents.filter(
    (a) => cat.agents.find((d) => d.name === a.agentType)?.omitClaudeMd,
  ).length;
  const omitClause =
    omitCount > 0
      ? pick(
          lang,
          ` ${omitCount} agente(s) declaran omitClaudeMd y no pagan esta jerarquía; el promedio los sobreestima.`,
          ` ${omitCount} agent(s) declare omitClaudeMd and pay none of this hierarchy; the average overstates them.`,
        )
      : "";

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
          `De esos ${k(avg)} tok medios, la jerarquía de CLAUDE.md aporta ~${k(hierarchyTokens)}: ~${k(cat.claudeMdTokens)} del CLAUDE.md de este repo${globalClause}.` +
          `${notObservedClause}${omitClause} ` +
          `El contenido del contexto inicial no queda en el transcript, solo su tamaño.`,
        `cache_creation of each agent's first message: system prompt + CLAUDE.md hierarchy + definition + git status. ` +
          `Of those ~${k(avg)} tok on average, the CLAUDE.md hierarchy contributes ~${k(hierarchyTokens)}: ~${k(cat.claudeMdTokens)} from this repo's CLAUDE.md${globalClause}.` +
          `${notObservedClause}${omitClause} ` +
          `The initial context's content is not persisted in the transcript, only its size.`,
      ),
    },
  ];
}

/** Declared but never loaded in this session — dead weight in every context. */
function deadCatalog(session: SessionAudit, cat: HarnessCatalog, lang: Lang): Signal[] {
  const out: Signal[] = [];

  // "Used" is not one fact but two, and merging them made this signal report the
  // weaker one (#725, A5). `skillsRead` carries every slug however it was
  // detected, and `skill-md` — the file having been OPENED — is 92 of the 135
  // detections across the audited park. One session detected thirteen skills
  // and all thirteen were that: it would have reported almost nothing unused
  // while invoking none of them. An auditor reading the catalog is the limit
  // case, and it is not hypothetical: it is what this repo's own sessions do.
  //
  // So the question the number answers is now INVOCATION (the `Skill` tool, the
  // host's own declaration, or an attributed span), and what was merely opened
  // is reported next to it instead of inside it.
  const runs = [session.orchestrator, ...session.agents];
  const invoked = new Set([
    ...runs.flatMap((r) => r.skills.filter((sk) => sk.source !== "skill-md").map((sk) => sk.slug)),
    // A host-declared skill the parser could not pin to ONE run lands only on
    // the session (`applyHostSkills` refuses to guess between two `researcher`s
    // and leaves it there). Nothing read it back, which was harmless while the
    // headline was "went unused" — but reading "never invoked" off a set that
    // omits the host's own statement would contradict the strongest source the
    // audit has.
    ...session.hostSkills.map((sk) => sk.slug),
  ]);
  const browsed = new Set(
    runs.flatMap((r) => r.skills.filter((sk) => sk.source === "skill-md").map((sk) => sk.slug)),
  );
  const unused = cat.skills.filter((s) => !invoked.has(s));
  if (unused.length > 0 && cat.skills.length > 0) {
    // Split by provenance (#607): the two halves lead to different decisions —
    // the user owns theirs, the preset ships navori's — and one merged list of
    // 35 names asks the reader to sort it out by hand.
    const managed = new Set(cat.managedSkills ?? []);
    const own = unused.filter((s) => !managed.has(s));
    const fromNavori = unused.filter((s) => managed.has(s));
    const part = (label: string, list: string[]): string =>
      list.length > 0 ? `${label} (${list.length}): ${list.join(", ")}` : "";
    // Of the never-invoked ones, the ones whose FILE was opened are a different
    // case from the ones nothing ever touched: one says the skill was within
    // reach and did not get used, the other that it was never in play at all.
    const onlyBrowsed = unused.filter((s) => browsed.has(s));
    const browsedLine =
      onlyBrowsed.length > 0
        ? "\n" +
          pick(
            lang,
            `de esas, ${onlyBrowsed.length} sí se abrieron como archivo pero nunca se invocaron: ${onlyBrowsed.join(", ")}`,
            `of those, ${onlyBrowsed.length} had their file opened but were never invoked: ${onlyBrowsed.join(", ")}`,
          )
        : "";

    const evidence = [
      part(pick(lang, "tuyas", "yours"), own),
      part(pick(lang, "de navori", "navori's"), fromNavori),
    ]
      .filter(Boolean)
      .join(" · ");

    // "Unused" is a FLOOR whenever the host marked no record with a skill
    // (#725). The two facts print identically otherwise — a release that
    // renames or drops `attributionSkill` would read as a harness nobody uses,
    // and the transcript format is documented as internal and free to change on
    // any release. So the caveat is attached to the number, not left to the
    // reader: the instrument says when it was blind.
    const attributed =
      session.orchestrator.skillAttributionRecords +
      session.agents.reduce((sum, a) => sum + a.skillAttributionRecords, 0);
    const caveat =
      attributed === 0
        ? pick(
            lang,
            " · el host no atribuyó ningún mensaje a una skill en esta sesión, así que este conteo es un piso: una skill aplicada sin invocarse no deja rastro aquí",
            " · the host attributed no message to a skill in this session, so this count is a floor: a skill applied without being invoked leaves no trace here",
          )
        : "";

    out.push({
      kind: "unused-skills",
      severity: "info",
      summary: pick(
        lang,
        `${unused.length} de ${cat.skills.length} skills declaradas nunca se invocaron`,
        `${unused.length} of ${cat.skills.length} declared skills were never invoked`,
      ),
      evidence: `${evidence || unused.join(", ")}${browsedLine}${caveat}`,
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

/**
 * The same command over and over: rework paid in full tokens each time.
 *
 * `top[0]![1] >= 10` stayed an absolute count, deliberately (#929). It has
 * the same shape of bias `friction`/`tool-errors` had — a longer session could
 * in principle pad the count of its single most-repeated command — but unlike
 * those two, whose totals are a SUM across every distinct block/error in the
 * session, this counts repeats of ONE literal command, and volume does not
 * drive that the same way. Measured on this repo's own 97-session history:
 * only 2 sessions ever had a command repeat 3+ times at all (the floor
 * `repeatedCommands` already applies), and the largest one — 1037 tool calls,
 * the biggest session in the corpus — topped out at 4 repeats of its most
 * common command, nowhere near the 10 that trips `warn`. A rate would need a
 * denominator and a sample floor for a signal that real sessions do not push
 * anywhere near its threshold by volume alone; the absolute count already does
 * the job the data shows it needs to do.
 */
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

/**
 * Blocks and denials that landed in a model's context, so they cost tokens.
 *
 * Severity is decided on the RATE over the session's tool calls, not the raw
 * sum (#929): a session with double the tool calls accumulates double the
 * blocks at an identical rate, and the old `total >= 20` read that as having
 * gotten worse rather than having worked more. The total is still real and
 * still what the summary reports — only the severity axis moved.
 */
function friction(session: SessionAudit, lang: Lang): Signal[] {
  const cards = [session.orchestrator, ...session.agents];
  const total = cards.reduce((s, c) => s + c.frictionEvents, 0);
  if (total === 0) return [];
  const toolTotal = cards.reduce((s, c) => s + totalToolCalls(c.toolCounts), 0);
  const rate = toolTotal > 0 ? total / toolTotal : 0;
  const severity = toolTotal >= FRICTION_MIN_SAMPLE && rate >= FRICTION_RATE_WARN ? "warn" : "info";
  return [
    {
      kind: "friction",
      severity,
      summary: pick(
        lang,
        `${total} bloqueos de hook o denegaciones de permiso llegaron al contexto`,
        `${total} hook blocks or permission denials reached the context`,
      ),
      evidence: pick(
        lang,
        `Cada bloqueo entra al contexto del agente y cuesta tokens. ${total} de ${toolTotal} tool calls (${(rate * 100).toFixed(1)}%). Límite conocido: las aprobaciones manuales exitosas NO son distinguibles de una tool pre-aprobada.`,
        `Each block enters the agent's context and costs tokens. ${total} of ${toolTotal} tool calls (${(rate * 100).toFixed(1)}%). Known limit: successful manual approvals are NOT distinguishable from a pre-approved tool.`,
      ),
    },
  ];
}

/**
 * Tool errors that are NOT the harness refusing something — the classes the
 * friction count used to visit and discard (#686).
 *
 * Reported separately from `friction` because the two say different things: a
 * block is the harness working as designed, while a failed command is the agent
 * getting it wrong and paying context to find out. Across this repo's
 * transcripts the second was 89 of 117 discarded errors, and worth exactly zero
 * until now.
 *
 * Severity is decided on the RATE over the session's tool calls, not the raw
 * sum (#929) — the same fix #926 applied to `unreachable-instructions`, and
 * the function's own name (a "rate" whose severity ignored the denominator)
 * is what gave the bug away. The total is still what the summary reports.
 */
function toolErrorRate(session: SessionAudit, lang: Lang): Signal[] {
  const cards = [session.orchestrator, ...session.agents];
  const sum = (k: "shellFailure" | "toolUnavailable" | "editMiss" | "other"): number =>
    cards.reduce((n, c) => n + c.toolErrors[k], 0);

  const shellFailure = sum("shellFailure");
  const toolUnavailable = sum("toolUnavailable");
  const editMiss = sum("editMiss");
  const other = sum("other");
  const total = shellFailure + toolUnavailable + editMiss + other;
  if (total === 0) return [];

  const toolTotal = cards.reduce((s, c) => s + totalToolCalls(c.toolCounts), 0);
  const rate = toolTotal > 0 ? total / toolTotal : 0;
  const severity =
    toolTotal >= TOOL_ERROR_MIN_SAMPLE && rate >= TOOL_ERROR_RATE_WARN ? "warn" : "info";

  const parts: string[] = [];
  if (shellFailure) parts.push(pick(lang, `${shellFailure} shell`, `${shellFailure} shell`));
  if (toolUnavailable)
    parts.push(
      pick(lang, `${toolUnavailable} tool no disponible`, `${toolUnavailable} tool unavailable`),
    );
  if (editMiss) parts.push(pick(lang, `${editMiss} edit sin match`, `${editMiss} edit miss`));
  if (other) parts.push(pick(lang, `${other} otros`, `${other} other`));

  return [
    {
      kind: "tool-errors",
      severity,
      summary: pick(
        lang,
        `${total} errores de tool llegaron al contexto (${parts.join(", ")})`,
        `${total} tool errors reached the context (${parts.join(", ")})`,
      ),
      evidence: pick(
        lang,
        `Cada error entra al contexto y cuesta tokens. ${total} de ${toolTotal} tool calls (${(rate * 100).toFixed(1)}%). Los de shell son la clase grande: un agente que falla comandos está haciendo rework que \`repeatedCommands\` solo ve si además repite el comando idéntico 3+ veces.`,
        `Each error enters the context and costs tokens. ${total} of ${toolTotal} tool calls (${(rate * 100).toFixed(1)}%). Shell failures are the big class: an agent failing commands is doing rework that \`repeatedCommands\` only sees when it also repeats the identical command 3+ times.`,
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
 *
 * THE COUNT IS AN UPPER BOUND, and says so (#723). What it no longer charges
 * for is the part that can be PROVEN free: the host's built-in read-only set
 * runs with no prompt in every mode, ahead of the classifier in its decision
 * order, so `isClassifierExemptCommand` subtracts those calls per mode segment
 * (#730). The bound holds because that predicate is conservative — it clears
 * only what it can defend.
 *
 * What stays uncountable is the narrow `allow` rules, which the host also
 * resolves before the classifier, and three verified facts say why no version
 * of this report can subtract them:
 *  - the OTel channel cannot answer it. `tool_decision.source` has no value for
 *    "the classifier approved": a controlled canary of two binaries covered by
 *    no rule anywhere and absent from the read-only set — the only possible
 *    approver being the classifier — was recorded as `source: "config"`, the
 *    same string an `allow` rule produces;
 *  - re-implementing the host's matcher would also have to model auto mode
 *    SUSPENDING part of the repo's own rules (blanket `Bash(*)`, wildcarded
 *    interpreters, package-manager run rules), which is why that route yields a
 *    different figure that is just as false;
 *  - and the allow list is repo state AT REPORT TIME, not what the session ran
 *    under.
 */
function classifierRoundTrips(session: SessionAudit, lang: Lang): Signal[] {
  const autoBash = session.orchestrator.toolCountsByMode.auto?.Bash ?? 0;
  if (autoBash === 0) return [];

  const modes = Object.keys(session.permissionModes);
  const autoOnly = modes.length === 1 && modes[0] === "auto";
  const agentBash = session.agents.reduce((sum, a) => sum + (a.toolCounts.Bash ?? 0), 0);
  // Only the auto segment's exempt calls, and only the subagents' when the
  // session never left auto — the same attribution rule the totals follow.
  const autoExempt = session.orchestrator.classifierExemptBashByMode?.auto ?? 0;
  const agentExempt = session.agents.reduce((sum, a) => sum + (a.classifierExemptBash ?? 0), 0);
  const exempt = autoOnly ? autoExempt + agentExempt : autoExempt;
  const total = (autoOnly ? autoBash + agentBash : autoBash) - exempt;
  // Every command proved free is not a finding: the same criterion as the
  // `autoBash === 0` above, applied to what is left after the discount.
  if (total <= 0) return [];

  const share = pick(
    lang,
    autoOnly
      ? `${autoBash} del orquestador y ${agentBash} de subagentes (la sesión nunca salió de auto, así que sus comandos también cuentan), menos ${exempt} que el set read-only integrado del host resuelve sin prompt en cualquier modo y, por tanto, antes del clasificador. Lo que queda sigue siendo un TECHO, no un total: las reglas 'allow' estrechas también se resuelven antes que el clasificador, así que cada comando cubierto por una tampoco pagó nada.`
      : `${autoBash} del orquestador, contados solo en los tramos en modo auto de una sesión que usó ${modes.length} modos (${modes.join(", ")}), menos ${exempt} exentos por el set read-only integrado del host en esos mismos tramos. Los ${agentBash} comandos de subagentes quedan fuera: su transcript no declara modo, así que atribuirlos sería inventar. Lo que queda sigue siendo un TECHO: las reglas 'allow' estrechas también se resuelven antes que el clasificador.`,
    autoOnly
      ? `${autoBash} from the orchestrator and ${agentBash} from subagents (the session never left auto, so theirs count too), minus ${exempt} that the host's built-in read-only set runs with no prompt in every mode, and therefore ahead of the classifier. What remains is still a CEILING, not a total: narrow 'allow' rules also resolve before the classifier, so every command covered by one paid nothing either.`
      : `${autoBash} from the orchestrator, counted only across the auto stretches of a session that used ${modes.length} modes (${modes.join(", ")}), minus ${exempt} exempted by the host's built-in read-only set within those same stretches. The ${agentBash} subagent commands are excluded: their transcript declares no mode, so attributing them would be invention. What remains is still a CEILING: narrow 'allow' rules also resolve before the classifier.`,
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
        `${share} El descuento es seguro porque solo cubre comandos cuyos segmentos encabezan TODOS con un binario de ese set documentado (ls, cat, head, grep, wc, stat, cd…), y la lista usada aquí es a propósito más corta que la del host: \`find\` queda fuera porque cambia de naturaleza con sus flags (\`-exec\` ejecuta, \`-delete\` borra). Ante cualquier duda —redirección, sustitución de comando, 'cd' junto a 'git', un binario fuera del set— el comando se sigue contando. Lo que impide un total exacto son las reglas 'allow', no las lecturas, y no hay forma de descontarlas: en modo auto el host SUSPENDE las 'allow' de intérprete comodín (\`Bash(python3 *)\`) y de package-manager run (\`Bash(pnpm test:*)\`), así que reimplementar su matcher daría una cifra distinta e igual de falsa. Cada viaje restante se paga ANTES de ejecutar el comando, con una porción del transcript. Las lecturas, las ediciones dentro del workspace y las llamadas MCP con regla 'allow' no pagan ese viaje. Lo que más lo baja es cambiar de vía —\`Grep\`/\`Read\` nativos y MCP resuelven en ~0.08–0.13s contra ~0.20s (p75 1.83s) de una búsqueda por shell—; para lo que de verdad deba ser shell, agrupar (\`a && b\`) y acotar.`,
        `${share} The discount is safe because it only covers commands whose segments ALL lead with a binary from that documented set (ls, cat, head, grep, wc, stat, cd…), and the list used here is deliberately shorter than the host's: \`find\` is left out because its flags change what it is (\`-exec\` runs, \`-delete\` removes). At any doubt — a redirect, a command substitution, 'cd' next to 'git', a binary outside the set — the command keeps being counted. What blocks an exact total is the 'allow' rules, not the reads, and there is no way to subtract them: in auto mode the host SUSPENDS the wildcarded-interpreter (\`Bash(python3 *)\`) and package-manager-run (\`Bash(pnpm test:*)\`) allow rules, so re-implementing its matcher would yield a different figure that is just as false. Each remaining trip is paid BEFORE the command runs, carrying a slice of the transcript. Reads, in-workspace edits and MCP calls covered by an 'allow' rule pay no such trip. What lowers it most is switching lane — native \`Grep\`/\`Read\` and MCP answer in ~0.08–0.13s against ~0.20s (p75 1.83s) for the same search through the shell; for whatever must stay shell, batch (\`a && b\`) and scope it.`,
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
 * goes engram → native Grep/Glob → shell, and nothing measured
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
/**
 * R5 of spec 0020 — did the routing ladder actually fire, and did delegation
 * follow?
 *
 * `routing-watch` injects its note at most once per session, and an injected
 * note is invisible to any later reading of the transcript. So the hook records
 * the emission in the audit log (`verdict: "notify"`), and this is what turns
 * that line into an answer.
 *
 * Two states, and the second is the one worth naming: the note fired AND the
 * session still ended with zero subagents. That is not a hook failure — the
 * note is advisory by design, and inline is sometimes right — but it is the
 * measurement the spec exists to produce, and it has to be visible rather than
 * inferred from a log nobody opens.
 */
function routingNotice(session: SessionAudit, lang: Lang): Signal[] {
  const notices = [
    ...session.orchestrator.hookEvents,
    ...session.agents.flatMap((a) => a.hookEvents),
  ].filter((e) => e.name === "routing-watch" && e.verdict === "notify");
  if (notices.length === 0) return [];

  const detail = notices[0]?.reason ?? "";
  const delegated = session.agents.length;
  if (delegated > 0) {
    return [
      {
        kind: "routing-notice",
        severity: "info",
        summary: pick(
          lang,
          `El aviso de ruteo salió y la sesión delegó (${delegated} subagente${delegated === 1 ? "" : "s"})`,
          `The routing note fired and the session delegated (${delegated} subagent${delegated === 1 ? "" : "s"})`,
        ),
        evidence: detail,
      },
    ];
  }
  return [
    {
      kind: "routing-notice",
      severity: "warn",
      summary: pick(
        lang,
        "El aviso de ruteo salió y la sesión terminó sin delegar",
        "The routing note fired and the session ended without delegating",
      ),
      evidence: pick(
        lang,
        `${detail}. El aviso es consultivo: inline puede ser lo correcto —el host puede haberlo vedado, o el cambio ser mecánico—, pero entonces la razón debería estar escrita en la sesión. Esta línea existe para que la decisión sea contable, no para reprocharla.`,
        `${detail}. The note is advisory: inline can be right — the host may have ruled delegation out, or the change may be mechanical — but then the reason belongs in the session. This line exists to make the decision countable, not to scold it.`,
      ),
    },
  ];
}

/**
 * Did the sessions in this range run under the harness the repo has TODAY? (#778)
 *
 * `report.ts` has printed the per-session `rendered/cli` pair for releases, and
 * nothing ever evaluated it — `model.ts` even documents that `rendered ≠ cli`
 * "is itself a finding" without emitting one. That gap has a measured price: a
 * repo was audited for two weeks on "1,495 searches with tgrep at 0.3%" while
 * its logs said 8 sessions with no version recorded and 3 on 0.7.x, against a
 * repo whose harness read 0.8.6. Not one of the measured sessions had the plugin
 * whose adoption was being measured. Every number in that report was true and
 * described a harness that no longer existed.
 *
 * This is that check, over data the pipeline already had. RANGE-level because
 * the defect is: the aggregate figures — tokens, skills, routing — sum sessions
 * from different regimes, and a per-session note cannot say that about a total.
 *
 * `high` only when NO session ran the current harness: that is the state that
 * invalidates the aggregates outright. A range that merely straddles an upgrade
 * is `warn` — normal, and still worth knowing before reading a trend off it.
 */
export function harnessRegime(
  sessions: SessionAudit[],
  harnessVersion: string | null,
  lang: Lang,
): Signal[] {
  if (sessions.length === 0) return [];

  const unknown: SessionAudit[] = [];
  const older = new Map<string, number>();
  const cliDrift: string[] = [];
  let current = 0;

  for (const s of sessions) {
    const { rendered, cli } = s.navori;
    // The CLI moved without a `render`: the machine had one version and the
    // session ran under another. Counted independently of the age question —
    // a session can be current AND have been marked by a newer binary.
    if (rendered !== null && cli !== null && rendered !== cli) {
      cliDrift.push(`${s.sessionId.slice(0, 8)} (${rendered} / CLI ${cli})`);
    }
    if (rendered === null) {
      unknown.push(s);
      continue;
    }
    if (compareSemver(rendered, harnessVersion) === -1) {
      older.set(rendered, (older.get(rendered) ?? 0) + 1);
      continue;
    }
    current++;
  }

  const offRegime = unknown.length + [...older.values()].reduce((n, v) => n + v, 0);
  if (offRegime === 0 && cliDrift.length === 0) return [];

  const olderRows = [...older.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([version, n]) => `${version} ×${n}`)
    .join(", ");
  const today = harnessVersion ?? pick(lang, "desconocido", "unknown");
  const parts: string[] = [];
  if (unknown.length > 0) {
    parts.push(
      pick(
        lang,
        `${unknown.length} sin versión registrada (marcadas antes de que el campo existiera)`,
        `${unknown.length} with no version recorded (marked before the field existed)`,
      ),
    );
  }
  if (olderRows) {
    parts.push(
      pick(lang, `en versiones anteriores: ${olderRows}`, `on older versions: ${olderRows}`),
    );
  }
  if (cliDrift.length > 0) {
    parts.push(
      pick(
        lang,
        `${cliDrift.length} con rendered ≠ cli (el binario se actualizó sin correr 'render'): ${cliDrift.join(", ")}`,
        `${cliDrift.length} with rendered ≠ cli (the binary was updated without a 'render'): ${cliDrift.join(", ")}`,
      ),
    );
  }

  return [
    {
      kind: "harness-regime",
      // Nothing ran the harness this repo has now: the aggregates below do not
      // describe it at all, which is a different claim from "the range spans an
      // upgrade" and has to read differently.
      severity: offRegime === sessions.length && sessions.length > 0 ? "high" : "warn",
      summary: pick(
        lang,
        `${offRegime} de ${sessions.length} sesiones del rango corrieron bajo un harness distinto del que este repo tiene hoy (${today})`,
        `${offRegime} of ${sessions.length} sessions in the range ran under a harness other than the one this repo has today (${today})`,
      ),
      evidence: pick(
        lang,
        `${parts.join("; ")}. ${current} sesión(es) corrieron el harness actual. Las cifras agregadas de este reporte —tokens, skills, ruteo, permisos— suman sesiones de regímenes distintos, así que una adopción baja puede estar describiendo un harness que ya no está en disco: un plugin agregado después de esas sesiones no podía usarse en ellas. Acota el rango a las sesiones bajo el harness actual antes de leer una tendencia.`,
        `${parts.join("; ")}. ${current} session(s) ran the current harness. This report's aggregate figures — tokens, skills, routing, permissions — sum sessions from different regimes, so a low adoption number may be describing a harness that is no longer on disk: a plugin added after those sessions could not have been used in them. Narrow the range to the sessions under the current harness before reading a trend off it.`,
      ),
    },
  ];
}

/**
 * A gate that never delivered a verdict, by either of the two signatures a kill
 * can leave (#776, #797):
 *
 *  - `gate-started` with no matching allow/block. The start marker is written
 *    just before the scan, so a sealed session missing the terminal record is
 *    evidence of an interrupted gate — never a guess from unrelated hooks that
 *    also run for every Bash call. This is the SIGKILL signature: no handler
 *    can observe that signal, so absence is all there is.
 *  - `gate-killed`, written by the signal handler itself. Under a handled
 *    signal the EXIT trap DOES run, with `$?` == 0, and used to record `allow`
 *    — a false green that satisfied the check above and disarmed this very
 *    finding. Both signatures are needed because the host's docs never say
 *    which signal it cancels with.
 */
function abandonedQualityGates(session: SessionAudit, lang: Lang): Signal[] {
  if (!session.sealed) return [];

  const events = [
    ...session.orchestrator.hookEvents,
    ...session.agents.flatMap((agent) => agent.hookEvents),
  ].filter((event) => GATE_HOOK_NAMES.has(event.name));
  const terminal = new Set(
    events
      .filter(
        (event) =>
          (event.verdict === "allow" || event.verdict === "block") && event.toolUseId !== undefined,
      )
      .map(gateHandle),
  );
  // Keyed, not counted: a killed run leaves BOTH a `gate-started` and a
  // `gate-killed` for the same invocation, and one interrupted gate must be
  // reported once.
  const abandoned = new Map<string, { name: string; toolUseId: string; killed: boolean }>();
  for (const event of events) {
    if (!event.toolUseId) continue;
    if (event.verdict !== "gate-started" && event.verdict !== "gate-killed") continue;
    if (terminal.has(gateHandle(event))) continue;
    const previous = abandoned.get(gateHandle(event));
    abandoned.set(gateHandle(event), {
      name: event.name,
      toolUseId: event.toolUseId,
      killed: event.verdict === "gate-killed" || (previous?.killed ?? false),
    });
  }
  if (abandoned.size === 0) return [];

  const entries = [...abandoned.values()];
  const ids = entries.map((entry) => `${entry.name} (${entry.toolUseId})`).join(", ");
  const killed = entries.filter((entry) => entry.killed).length;
  // The two signatures read differently and the evidence has to say which one
  // fired: `gate-killed` is a recorded cancellation, the bare start is an
  // inference from an absence.
  const split = pick(
    lang,
    `${killed} con cancelación registrada (gate-killed) y ${entries.length - killed} con inicio sin veredicto.`,
    `${killed} with a recorded cancellation (gate-killed) and ${entries.length - killed} with a start and no verdict.`,
  );
  return [
    {
      kind: "quality-gate-aborted",
      severity: "high",
      summary: pick(
        lang,
        `${entries.length} quality gate${entries.length === 1 ? " posiblemente murió" : "s posiblemente murieron"} por timeout`,
        `${entries.length} quality gate${entries.length === 1 ? " may have timed out" : "s may have timed out"}`,
      ),
      evidence: pick(
        lang,
        `El gate no registró allow/block antes de sellarse la sesión (${ids}). ${split} El host cancela el hook al agotar su timeout y el commit puede continuar sin un veredicto del gate.`,
        `The gate recorded no allow/block before the session sealed (${ids}). ${split} The host cancels the hook when it reaches its timeout, so the commit may continue without a gate verdict.`,
      ),
    },
  ];
}

export function detectSignals(
  session: SessionAudit,
  catalog: HarnessCatalog,
  lang: Lang,
): Signal[] {
  if (session.availability && session.availability.tools?.state !== "observed")
    return [...recorderCoverage(session, lang), ...abandonedQualityGates(session, lang)];
  const measuredUsage =
    !session.availability ||
    [session.availability, ...session.agents.map((a) => a.availability ?? {})].every((evidence) =>
      [
        "tokens.input",
        "tokens.output",
        "tokens.cacheRead",
        "tokens.cacheCreation",
        "startupTokens",
      ].every((key) => evidence[key]?.state === "observed"),
    );
  const order = { high: 0, warn: 1, info: 2 } as const;
  return [
    ...(measuredUsage ? unreachableInstructions(session, catalog, lang) : []),
    ...(measuredUsage ? startupOverhead(session, catalog, lang) : []),
    ...rework(session, lang),
    ...(measuredUsage ? reviewCycles(session, lang) : []),
    ...(!session.availability ||
    session.agents.every((a) => a.availability?.durationMs?.state === "observed")
      ? serialFanout(session, lang)
      : []),
    ...friction(session, lang),
    ...toolErrorRate(session, lang),
    ...deadCatalog(session, catalog, lang),
    ...permissionContext(session, lang),
    ...classifierRoundTrips(session, lang),
    ...toolMix(session, lang),
    ...formatDrift(session, lang),
    ...recorderCoverage(session, lang),
    ...routingNotice(session, lang),
    ...abandonedQualityGates(session, lang),
  ].sort((a, b) => order[a.severity] - order[b.severity]);
}

/** Agent types R53's single-owner contract governs: the ones the harness
 *  instructs to run `{{qualityGate.full}}` themselves. */
const GATE_OWNER_TYPES = new Set(["reviewer", "implementer"]);

/** Milliseconds, formatted as seconds — `signals.ts` has no dependency on
 *  `report.ts`'s `minutes()` and shouldn't grow one just for this. */
function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Reviewer/implementer gate lifecycle (R53, R54 of spec 0026): correlates
 * every session's `GateExecution`s to their owner and reports the shape a
 * single-owner-contract violation would leave — duplicate or unknown
 * handles, overlapping reviewer runs — plus duration/wait totals once there
 * is enough data to say anything about them.
 *
 * RANGE-level, like `harnessRegime`: a duplicate or a duration figure is a
 * statement about the whole audited range, not about one session in
 * isolation, and R54's own sample-size floor (>=10 completed gates over >=3
 * distinct git branches) can only be evaluated by looking across sessions.
 *
 * This is a report, never a guard: it reads the transcript after the fact and
 * states what happened. It does not claim to prevent a tool call, and no
 * caller should read it as having done so.
 */
export function reviewerGateLifecycle(sessions: SessionAudit[], lang: Lang): Signal[] {
  const executions: GateExecution[] = sessions.flatMap((s) => correlateGateExecutions(s));
  const owned = executions.filter(
    (e) => e.ownerAgentType !== null && GATE_OWNER_TYPES.has(e.ownerAgentType),
  );
  const out: Signal[] = [];

  const duplicates = owned.filter((e) => e.outcome === "duplicate");
  if (duplicates.length > 0) {
    out.push({
      kind: "reviewer-gate-duplicate",
      severity: "high",
      summary: pick(
        lang,
        `${duplicates.length} ejecución(es) del gate de reviewer/implementer registraron más de un veredicto terminal`,
        `${duplicates.length} reviewer/implementer gate execution(s) recorded more than one terminal verdict`,
      ),
      evidence: pick(
        lang,
        `Detectado por handle repetido (mismo hook + tool_use_id) con 2+ eventos allow/block: ${duplicates.map((e) => e.handle.split("\u0000")[0]).join(", ")}. Esto REPORTA el hallazgo; ningún detector de esta auditoría bloquea ni previene la tool call que lo produjo.`,
        `Detected by a repeated handle (same hook + tool_use_id) with 2+ allow/block events: ${duplicates.map((e) => e.handle.split("\u0000")[0]).join(", ")}. This REPORTS the finding; no detector in this audit blocks or prevents the tool call that produced it.`,
      ),
    });
  }

  const unknown = executions.filter((e) => e.outcome === "unknown");
  if (unknown.length > 0) {
    out.push({
      kind: "reviewer-gate-unknown-handle",
      severity: "warn",
      summary: pick(
        lang,
        `${unknown.length} evento(s) de gate sin tool_use_id: no se pueden correlacionar a un owner`,
        `${unknown.length} gate event(s) with no tool_use_id: they cannot be correlated to an owner`,
      ),
      evidence: pick(
        lang,
        "Registrados antes de que el payload incluyera tool_use_id, o por un hook que no lo propagó. No se les asigna un owner adivinado — se cuentan como dato faltante, no como cero.",
        "Recorded before the payload carried tool_use_id, or by a hook that didn't propagate it. No owner is guessed for them — counted as missing data, not as zero.",
      ),
    });
  }

  // The direct, observable shape a single-owner violation (R53) leaves: two
  // reviewer processes alive over the same span. Reuses `overlapsWith`
  // (already computed from each run's [startedAt, endedAt] window) rather
  // than re-deriving overlap here.
  const reviewerRuns = sessions.flatMap((s) => s.agents.filter((a) => a.agentType === "reviewer"));
  const reviewerIds = new Set(reviewerRuns.map((a) => a.agentId));
  const overlapping = reviewerRuns.filter((a) => a.overlapsWith.some((id) => reviewerIds.has(id)));
  if (overlapping.length > 0) {
    out.push({
      kind: "reviewer-gate-overlap",
      severity: "high",
      summary: pick(
        lang,
        `${overlapping.length} corrida(s) de reviewer se solaparon en el tiempo — posible violación de single-owner`,
        `${overlapping.length} reviewer run(s) overlapped in time — a possible single-owner violation`,
      ),
      evidence: overlapping.map((a) => a.agentId.slice(0, 8)).join(", "),
    });
  }

  const timeouts = owned.filter((e) => e.outcome === "timeout");
  if (timeouts.length > 0) {
    out.push({
      kind: "reviewer-gate-timeout",
      severity: "high",
      summary: pick(
        lang,
        `${timeouts.length} ejecución(es) del gate de reviewer/implementer terminaron sin veredicto (timeout)`,
        `${timeouts.length} reviewer/implementer gate execution(s) ended with no verdict (timeout)`,
      ),
      evidence: pick(
        lang,
        "Un timeout nunca equivale a éxito; el reporte no asume exit 0 para estas ejecuciones.",
        "A timeout never equals success; the report does not assume exit 0 for these executions.",
      ),
    });
  }

  // R54's own floor: below it, a latency conclusion is not drawn — it is
  // reported as inconclusive, never printed as a stable figure and never
  // treated as zero.
  const MIN_COMPLETED_GATES = 10;
  const MIN_DIFF_UNITS = 3;
  const completedBySession = sessions.map((session) => ({
    session,
    gates: correlateGateExecutions(session).filter(
      (e) =>
        e.ownerAgentType !== null &&
        GATE_OWNER_TYPES.has(e.ownerAgentType) &&
        e.outcome === "completed" &&
        e.durationMs !== null,
    ),
  }));
  const completed = completedBySession.flatMap(({ gates }) => gates);
  const sampledSessions = completedBySession
    .filter(({ gates }) => gates.length > 0)
    .map(({ session }) => session);
  // The audit has no independent diff identity — no (base, head) pair survives
  // past the ephemeral receipt (deleted by the publisher after commit; see
  // spec 0026 R54 amendment) — so a distinct git branch is used as the
  // observable proxy for "an independent unit of work". Two sessions on the
  // same branch are the same review cycle (implementer, then reviewer, then
  // implementer again); sessions on different branches are assumed
  // independent. This undercounts trunk-based work (everything lands on the
  // same branch, e.g. `main`) and long-lived branches carrying several
  // unrelated changes — both collapse to fewer units than reality, which can
  // only make the floor harder to reach, never easier. A missing gitBranch is
  // bucketed under one shared "unknown" key rather than counted per session,
  // for the same reason: undercounting here is safe, overcounting is not.
  const knownBranches = new Set(
    sampledSessions.filter((s) => s.gitBranch !== null).map((s) => s.gitBranch),
  );
  const hasUnknownBranch = sampledSessions.some((s) => s.gitBranch === null);
  const diffUnits = knownBranches.size + (hasUnknownBranch ? 1 : 0);
  if (completed.length >= MIN_COMPLETED_GATES && diffUnits >= MIN_DIFF_UNITS) {
    const gateMs = completed.reduce((sum, e) => sum + (e.durationMs ?? 0), 0);
    const reviewerRunsBySession = completedBySession.map(({ session, gates }) => {
      const ownerIds = new Set(
        gates.filter((gate) => gate.ownerAgentType === "reviewer").map((gate) => gate.ownerAgentId),
      );
      return session.agents.filter(
        (agent) => agent.agentType === "reviewer" && ownerIds.has(agent.agentId),
      );
    });
    const sampledReviewerRuns = reviewerRunsBySession.flat();
    if (sampledReviewerRuns.length === 0) {
      out.push({
        kind: "reviewer-gate-duration",
        severity: "info",
        summary: pick(
          lang,
          `Latencia de reviewer no disponible (${completed.length} gates completados sobre ${diffUnits} rama(s); ninguno tiene una corrida de reviewer correlacionada)`,
          `Reviewer latency unavailable (${completed.length} completed gates over ${diffUnits} branch(es); none has a correlated reviewer run)`,
        ),
        evidence: pick(
          lang,
          "Las ejecuciones de gate sin owner reviewer verificable no se imputan como duración ni espera de reviewer.",
          "Gate executions without a verifiable reviewer owner are not imputed as reviewer duration or wait.",
        ),
      });
      return out;
    }
    const reviewerMs = sampledReviewerRuns.reduce((sum, a) => sum + a.durationMs, 0);
    // "Espera": the gap between one reviewer run ending and the next one
    // starting, within the same session — a re-review cycle waiting on
    // whatever came between them. Negative gaps (overlap) are excluded, not
    // clamped to zero, since they are already reported above as overlap.
    let waitMs = 0;
    for (const correlatedRuns of reviewerRunsBySession) {
      const runs = correlatedRuns.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      for (let i = 1; i < runs.length; i++) {
        const gap = Date.parse(runs[i]!.startedAt) - Date.parse(runs[i - 1]!.endedAt);
        if (Number.isFinite(gap) && gap > 0) waitMs += gap;
      }
    }
    out.push({
      kind: "reviewer-gate-duration",
      severity: "info",
      summary: pick(
        lang,
        `${completed.length} gates completados sobre ${diffUnits} rama(s): ${seconds(gateMs)} de gate, ${seconds(reviewerMs)} de reviewer, ${seconds(waitMs)} de espera entre re-reviews`,
        `${completed.length} completed gates over ${diffUnits} branch(es): ${seconds(gateMs)} gate, ${seconds(reviewerMs)} reviewer, ${seconds(waitMs)} waiting between re-reviews`,
      ),
      evidence: pick(
        lang,
        `${sampledReviewerRuns.length} corrida(s) de reviewer con gate completado propio, ${completed.length} ejecuciones de gate correlacionadas a reviewer/implementer. La rama de git es la unidad usada como proxy de "diff"; corridas sin gate completado propio no aportan duración ni espera. El umbral mínimo de R54 (>=${MIN_COMPLETED_GATES} gates sobre >=${MIN_DIFF_UNITS} ramas de git distintas) ya se cumplió.`,
        `${sampledReviewerRuns.length} reviewer run(s) with their own completed gate, ${completed.length} gate executions correlated to reviewer/implementer. Git branch is the proxy for "diff"; runs without their own completed gate add neither duration nor wait. R54's minimum (>=${MIN_COMPLETED_GATES} gates over >=${MIN_DIFF_UNITS} distinct git branches) is met.`,
      ),
    });
  } else if (reviewerRuns.length > 0 || owned.length > 0) {
    // Silent when there is no reviewer/gate activity at all (nothing to say,
    // same convention as every other detector in this file); vocal but
    // explicitly inconclusive once there is SOME activity below the floor —
    // that is the case R54 says must not read as zero.
    out.push({
      kind: "reviewer-gate-duration",
      severity: "info",
      summary: pick(
        lang,
        `Datos insuficientes para un criterio de latencia de reviewer/gate (${completed.length} gates completados sobre ${diffUnits} rama(s); el mínimo de R54 es ${MIN_COMPLETED_GATES} sobre ${MIN_DIFF_UNITS})`,
        `Not enough data for a reviewer/gate latency criterion (${completed.length} completed gates over ${diffUnits} branch(es); R54's minimum is ${MIN_COMPLETED_GATES} over ${MIN_DIFF_UNITS})`,
      ),
      evidence: pick(
        lang,
        "Tratado como inconcluso, no como cero: la falta de datos no habilita ninguna conclusión de latencia.",
        "Treated as inconclusive, not as zero: missing data enables no latency conclusion.",
      ),
    });
  }

  return out;
}

/**
 * Hooks that fired where they cannot do anything (#924).
 *
 * Both hosts run tool hooks inside subagents, so every `PreToolUse` of every
 * delegated agent spawns the whole matching set. For a hook declared
 * `mainThreadOnly` that spawn produces nothing by the hook's own code — and it
 * is not a rounding error: over this repo's store 80% of all hook firings come
 * from subagents, `model-advisor` alone at 3,649 of its 4,679.
 *
 * RANGE-level on purpose, like `harnessRegime`. One session shows a handful of
 * firings and reads as noise; the shape only exists across the range, and the
 * card of each agent already prints its own list.
 *
 * WHAT IT DOES NOT CLAIM: latency. Removing one hook from `PreToolUse` buys
 * roughly the gap to the next-slowest hook of the same event (~3ms measured),
 * because they all start at once — the whole point of the per-event toll in
 * `report.ts`. The cost here is a process spawn per tool call, and the summary
 * says so rather than letting a reader convert firings into seconds. #922 was
 * argued on latency grounds this instrument no longer supports.
 *
 * SILENCE, NEVER ZERO, when the store cannot answer. Only events that CARRY an
 * `agentId` are counted: Claude Code documents the field on subagent tool
 * events, Codex documents it on `SubagentStart`/`SubagentStop` and not on the
 * tool phases (`codex-hook-parallelism`). Counting the absence as
 * main-thread would publish "0 misfires" about a host whose logs never say.
 * Attribution by time window — which `ownerOf` legitimately uses for OTHER
 * purposes — is exactly what must not decide a finding.
 *
 * Plugin hooks are out of reach: their `mainThreadOnly` lives in a manifest the
 * audit does not read, so only the core declaration is evaluated.
 */
export function hookMisfires(sessions: SessionAudit[], lang: Lang): Signal[] {
  const inSubagent = new Map<string, number>();
  const total = new Map<string, number>();
  const withOwner = new Map<string, number>();

  for (const session of sessions) {
    const events = [
      ...session.orchestrator.hookEvents,
      ...session.agents.flatMap((a) => a.hookEvents),
    ];
    for (const e of events) {
      if (!MAIN_THREAD_ONLY_HOOKS.has(e.name)) continue;
      total.set(e.name, (total.get(e.name) ?? 0) + 1);
      if (!e.agentId) continue;
      withOwner.set(e.name, (withOwner.get(e.name) ?? 0) + 1);
      if (e.agentId === ORCHESTRATOR_OWNER) continue;
      inSubagent.set(e.name, (inSubagent.get(e.name) ?? 0) + 1);
    }
  }

  return [...inSubagent.entries()]
    .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    .map(([name, misfired]) => {
      const fired = total.get(name) ?? misfired;
      const attributed = withOwner.get(name) ?? misfired;
      const share = Math.round((misfired / attributed) * 100);
      return {
        kind: "hook-misfire",
        severity: "info" as const,
        summary: pick(
          lang,
          `${name}: ${misfired} de ${attributed} disparos ocurrieron dentro de un subagente (${share}%), donde el hook está declarado main-thread-only y no puede hacer nada`,
          `${name}: ${misfired} of ${attributed} firings happened inside a subagent (${share}%), where the hook is declared main-thread-only and can do nothing`,
        ),
        evidence: pick(
          lang,
          `${fired} disparos registrados en el rango, ${attributed} con dueño declarado por el host. El costo es un spawn por tool call, NO latencia: los hooks de un evento arrancan en paralelo, así que retirar uno ahorra la diferencia con el siguiente más lento (ver "peaje por evento"). La declaración vive en MAIN_THREAD_ONLY_HOOKS (engines/shared/harness-plan.ts) y se exige que el propio script pruebe la inercia. Los disparos sin agentId no se cuentan en ningún lado: hay hosts que no documentan el campo en las fases de tool.`,
          `${fired} firings recorded over the range, ${attributed} with an owner the host declared. The cost is one spawn per tool call, NOT latency: an event's hooks start in parallel, so dropping one saves the gap to the next-slowest (see "per-event toll"). The declaration lives in MAIN_THREAD_ONLY_HOOKS (engines/shared/harness-plan.ts) and requires the hook's own script to prove the inertness. Firings with no agentId count on neither side: some hosts do not document the field on tool phases.`,
        ),
      };
    });
}

/**
 * Managed skills and agents nobody used across the range, each with the number
 * of sessions the verdict rests on (R47).
 *
 * Only what navori SHIPS is a candidate: the marker is the witness, so a skill
 * or agent the user wrote never appears — the decision to drop it is theirs, not
 * a finding. "Candidate" is the word on purpose: zero use over N sessions is a
 * reason to look, and N is what lets the reader judge whether it is a reason.
 *
 * Sessions without a transcript (Codex) are excluded from N by the caller: they
 * carry no skill or agent evidence, so counting them would dilute the measure.
 */
export function unusedManagedCandidates(
  input: {
    sessionsConsidered: number;
    managedSkills: readonly string[];
    usedSkills: ReadonlySet<string>;
    managedAgents: readonly string[];
    usedAgents: ReadonlySet<string>;
  },
  lang: Lang,
): Signal[] {
  if (input.sessionsConsidered === 0) return [];
  const skills = input.managedSkills.filter((s) => !input.usedSkills.has(s));
  const agents = input.managedAgents.filter((a) => !input.usedAgents.has(a));
  const total = skills.length + agents.length;
  if (total === 0) return [];

  const parts = [
    skills.length > 0 ? `skills (${skills.length}): ${skills.join(", ")}` : "",
    agents.length > 0
      ? `${pick(lang, "agentes", "agents")} (${agents.length}): ${agents.join(", ")}`
      : "",
  ].filter(Boolean);
  return [
    {
      kind: "unused-managed-candidates",
      severity: "info",
      summary: pick(
        lang,
        `${total} skills o agentes managed sin uso en ${input.sessionsConsidered} sesiones: candidatos a revisión`,
        `${total} managed skills or agents unused over ${input.sessionsConsidered} sessions: review candidates`,
      ),
      evidence: parts.join(" · "),
    },
  ];
}

// ─── Search routing and activation on opportunities (spec 0039 R67) ─────────
//
// Ports of `mine-search-routing.py` and `mine-activation.py`, the first deleted
// with this change, the second kept in `scripts/py/` until its phase 2 is ported. Both read the host's raw
// transcripts, not the parsed `SessionAudit`: what they classify is the Bash
// command text, which the parsed model deliberately never keeps. The text is
// consumed here and only COUNTS leave — never a command, never an example.
//
// Parity with the scripts is pinned in `routing-parity.test.ts`. Differences
// that were left on purpose are named where they occur.

type Json = Record<string, unknown>;

function isJson(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Python's `str(x.get(k, dflt))` for the shapes a transcript can carry. */
function pyStr(v: unknown, dflt: string): string {
  if (v === undefined) return dflt;
  if (v === null) return "None";
  return typeof v === "string" ? v : String(v);
}

/** Every non-empty line of a JSONL file as parsed JSON, `null` for a line that
 *  does not parse. A missing or unreadable file yields `undefined`. */
function readJsonl(path: string): Array<unknown> | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
  const out: unknown[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      out.push(null);
    }
  }
  return out;
}

/**
 * Python's `shlex.split` (POSIX mode, no comments): quotes group, a backslash
 * escapes the next character (inside double quotes only `"` and `\`), and an
 * unterminated quote or trailing backslash throws — the caller falls back to a
 * whitespace split, exactly as the script does.
 */
export function shlexSplit(input: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let inToken = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(cur);
        cur = "";
        inToken = false;
      }
      i++;
    } else if (ch === "'") {
      const end = input.indexOf("'", i + 1);
      if (end === -1) throw new Error("No closing quotation");
      cur += input.slice(i + 1, end);
      inToken = true;
      i = end + 1;
    } else if (ch === '"') {
      inToken = true;
      i++;
      for (;;) {
        if (i >= input.length) throw new Error("No closing quotation");
        const c = input[i] as string;
        if (c === '"') {
          i++;
          break;
        }
        if (c === "\\") {
          const next = input[i + 1];
          if (next === undefined) throw new Error("No closing quotation");
          cur += next === '"' || next === "\\" ? next : `\\${next}`;
          i += 2;
        } else {
          cur += c;
          i++;
        }
      }
    } else if (ch === "\\") {
      const next = input[i + 1];
      if (next === undefined) throw new Error("No escaped character");
      cur += next;
      inToken = true;
      i += 2;
    } else {
      cur += ch;
      inToken = true;
      i++;
    }
  }
  if (inToken) tokens.push(cur);
  return tokens;
}

const SEARCH_WRAPPER = "tgrep-search.sh";
const SEARCH_VERBS: readonly string[] = ["grep", "egrep", "fgrep", "rg"];
const CODEGRAPH_TOOL = "mcp__codegraph__codegraph_explore";
const SEARCH_SPLIT = /(\|\||\||&&|;|\n)/;
const REDIR = /^([0-9]?>>?|&>|<|[0-9]?>&)/;
const REDIR_BARE = /^([0-9]?>>?|&>|<|[0-9]?>&[0-9]?)$/;

/** Routes that enter the #661 quotient: `(wrapper + nativo) / total`. */
const SCORED_ROUTES = ["wrapper", "nativo", "shell"] as const;
/** The v2 routes against their escape denominator (search-v2 §9.5, D19). */
const V2_ROUTES = ["tgrep-v2", "codegraph-v2"] as const;
const ESCAPE_ROUTES = ["nativo", "shell", "git-grep"] as const;

/** Every counter `mineSearchRouting` publishes, zeros included. */
export const SEARCH_ROUTES = [
  "wrapper",
  "nativo",
  "shell",
  "filtro",
  "extraccion",
  "git-grep",
  "indirecta",
  "tgrep-v2",
  "codegraph-v2",
  "bloqueado",
  "malformado",
  "no_disponible",
] as const;

export type SearchCounts = Record<string, number>;

function bump(counts: SearchCounts, key: string, by = 1): void {
  counts[key] = (counts[key] ?? 0) + by;
}

/**
 * The route of ONE shell segment that invokes grep/rg, or null when it does
 * not. `pipedInto` is what separates filtering from searching: `grep -n foo`
 * is an extraction from stdin after a pipe and a repo search at line start.
 */
export function classifySearchSegment(seg: string, pipedInto: boolean): string | null {
  let toks: string[];
  try {
    toks = shlexSplit(seg);
  } catch {
    // Unbalanced quotes: a strange command must be counted badly, not vanish.
    toks = seg.split(/\s+/).filter(Boolean);
  }
  const head = toks[0];
  if (head === undefined) return null;

  if (head === "tgrep") return toks[1] === "search" ? "tgrep-v2" : null;

  if (head === "git") {
    let i = 1;
    while (i < toks.length && (toks[i] as string).startsWith("-")) {
      const hasValue =
        !(toks[i] as string).includes("=") &&
        i + 1 < toks.length &&
        !(toks[i + 1] as string).startsWith("-");
      i += hasValue ? 2 : 1;
    }
    return i < toks.length && toks[i] === "grep" ? "git-grep" : null;
  }

  if (head === "xargs" || head === "find") {
    return toks.slice(1).some((t) => SEARCH_VERBS.includes(t)) ? "indirecta" : null;
  }

  if (!SEARCH_VERBS.includes(head)) return null;
  if (pipedInto) return "filtro";

  const flags: string[] = [];
  const operands: string[] = [];
  let skipNext = false;
  for (const t of toks.slice(1)) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (REDIR.test(t)) {
      skipNext = REDIR_BARE.test(t);
      continue;
    }
    (t.startsWith("-") ? flags : operands).push(t);
  }
  const recursive =
    head === "rg" || flags.some((f) => /^-[a-zA-Z]*[rR]/.test(f) || f === "--recursive");
  const targets = operands.length > 1 ? operands.slice(1) : [];
  const dirTarget = targets.some(
    (t) =>
      t.endsWith("/") || t === "." || t === ".." || (t.includes("/") && !/\.[A-Za-z0-9]+$/.test(t)),
  );
  if (recursive || dirTarget || targets.length === 0) return "shell";
  return "extraccion";
}

/** Every grep/rg invocation of one Bash command, by route. Counts per SEGMENT:
 *  `a && grep -rn x && grep -rn y` is two searches. */
export function classifySearchCommand(command: string): SearchCounts {
  const out: SearchCounts = {};
  if (command.includes(SEARCH_WRAPPER)) {
    out.wrapper = 1;
    return out;
  }
  // A line continuation does not separate commands; unjoined, it splits a
  // quoted pattern in half and the tail reads as a targetless recursive search.
  const joined = command.replace(/\\\n/g, " ");
  let piped = false;
  for (const part of joined.split(SEARCH_SPLIT)) {
    if (part === "|") {
      piped = true;
      continue;
    }
    if (part === "||" || part === "&&" || part === ";" || part === "\n") {
      piped = false;
      continue;
    }
    const route = classifySearchSegment(part.trim(), piped);
    if (route) bump(out, route);
  }
  return out;
}

/** Subagent transcripts of ONE session: `<project>/<session>/subagents/agent-*.jsonl`. */
function subagentTranscripts(mainPath: string, sessionId: string): string[] {
  const dir = join(dirname(mainPath), sessionId, "subagents");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith("agent-") && f.endsWith(".jsonl"))
    .sort()
    .map((f) => join(dir, f));
}

/**
 * Counts the searches of ONE transcript (main thread or subagent).
 *
 * `skipSidechain` drops `isSidechain` records on the main thread: the host
 * repeats them there AND writes them under `subagents/`, so counting both
 * passes would double every subagent search.
 *
 * Two passes, as in the script: a command the guard blocked never RAN but its
 * `tool_use` is in the transcript, so it would count as `shell` while its retry
 * counted again. The verdict is read from the transcript itself (`tool_result`
 * with `is_error` and the guard's text).
 */
function scanSearchTranscript(path: string, counts: SearchCounts, skipSidechain: boolean): void {
  const pending = new Map<unknown, string>();
  const blocked = new Set<unknown>();
  for (const entry of readJsonl(path) ?? []) {
    if (entry === null) {
      bump(counts, "malformado");
      continue;
    }
    if (!isJson(entry)) continue;
    if (skipSidechain && entry.isSidechain) continue;
    const msg = entry.message;
    if (!isJson(msg) || !Array.isArray(msg.content)) continue;
    for (const block of msg.content as unknown[]) {
      if (!isJson(block)) continue;
      if (block.type === "tool_use") {
        if (block.name === "Grep") bump(counts, "nativo");
        else if (block.name === CODEGRAPH_TOOL) bump(counts, "codegraph-v2");
        else if (block.name === "Bash") {
          const command = isJson(block.input) ? block.input.command : undefined;
          if (typeof command === "string") pending.set(block.id, command);
        }
      } else if (block.type === "tool_result") {
        // BOTH conditions: content that merely QUOTES the string (a guard file
        // read in-session) would otherwise count reads as blocks.
        if (!block.is_error) continue;
        if ((JSON.stringify(block.content) ?? "").includes("BLOCKED by guard-")) {
          blocked.add(block.tool_use_id);
        }
      }
    }
  }
  for (const [id, command] of pending) {
    if (blocked.has(id)) {
      bump(counts, "bloqueado");
      continue;
    }
    for (const [route, n] of Object.entries(classifySearchCommand(command))) bump(counts, route, n);
  }
}

/** A marked session as the miners need it: its id and where its transcript is. */
export interface MinedSession {
  sessionId: string;
  /** Resolved transcript, or null when it could not be located. */
  transcript: string | null;
  /** Working directory recorded when audit-mode was armed. */
  cwd?: string | null;
}

/**
 * Search routing over a set of audited sessions (R67, `mine-search-routing.py`).
 *
 * A session without a transcript counts as `no_disponible`, which is NOT a
 * zero: a rotated transcript and a session with no searches must not read the
 * same. Only counts are returned.
 */
export function mineSearchRouting(sessions: readonly MinedSession[]): SearchCounts {
  const counts: SearchCounts = {};
  for (const s of sessions) {
    if (!s.transcript || !existsSync(s.transcript)) {
      bump(counts, "no_disponible");
      continue;
    }
    scanSearchTranscript(s.transcript, counts, true);
    for (const sub of subagentTranscripts(s.transcript, s.sessionId)) {
      scanSearchTranscript(sub, counts, false);
    }
  }
  return counts;
}

// ─── codegraph projectPath vs. session cwd (spec 0039 R32, over R64's data) ──

/** Calls to `codegraph_explore` and the ones whose `projectPath` is not the cwd. */
export interface CodegraphPathStats {
  calls: number;
  mismatched: number;
  /** Distinct offending paths, capped: the evidence, never a command. */
  paths: string[];
}

const MAX_MISMATCH_PATHS = 3;

const trimSlash = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/**
 * A `codegraph_explore` call is a mismatch when it passes a `projectPath` that
 * is not the working directory of the record that issued it. Strict equality
 * on purpose: another worktree nests INSIDE the repo root, so "is inside cwd"
 * would hide exactly the case this exists to catch. A call without
 * `projectPath` is not a mismatch (the server defaults to its own root), and a
 * record without a cwd falls back to the session's.
 */
export function mineCodegraphProjectPaths(sessions: readonly MinedSession[]): CodegraphPathStats {
  const stats: CodegraphPathStats = { calls: 0, mismatched: 0, paths: [] };
  for (const s of sessions) {
    if (!s.transcript || !existsSync(s.transcript)) continue;
    const files = [s.transcript, ...subagentTranscripts(s.transcript, s.sessionId)];
    for (const [i, file] of files.entries()) {
      for (const entry of readJsonl(file) ?? []) {
        // Same dedupe rule as scanSearchTranscript: the host repeats sidechain
        // records on the main thread AND under `subagents/`.
        if (!isJson(entry) || (i === 0 && entry.isSidechain)) continue;
        const msg = entry.message;
        if (!isJson(msg) || !Array.isArray(msg.content)) continue;
        const cwd = typeof entry.cwd === "string" ? entry.cwd : (s.cwd ?? null);
        for (const block of msg.content as unknown[]) {
          if (!isJson(block) || block.type !== "tool_use" || block.name !== CODEGRAPH_TOOL)
            continue;
          stats.calls++;
          const target = isJson(block.input) ? block.input.projectPath : undefined;
          if (typeof target !== "string" || cwd === null) continue;
          if (trimSlash(target) === trimSlash(cwd)) continue;
          stats.mismatched++;
          if (stats.paths.length < MAX_MISMATCH_PATHS && !stats.paths.includes(target)) {
            stats.paths.push(target);
          }
        }
      }
    }
  }
  return stats;
}

/** The `codegraph-projectpath-mismatch` signal; empty when every call matched. */
export function codegraphProjectPathMismatch(stats: CodegraphPathStats, lang: Lang): Signal[] {
  if (stats.mismatched === 0) return [];
  return [
    {
      kind: "codegraph-projectpath-mismatch",
      severity: "warn",
      summary: pick(
        lang,
        `${stats.mismatched} de ${stats.calls} llamadas a codegraph usaron un projectPath distinto del cwd`,
        `${stats.mismatched} of ${stats.calls} codegraph calls used a projectPath different from the cwd`,
      ),
      evidence: pick(
        lang,
        `Consultan el índice de otro checkout (p. ej. otro worktree): ${stats.paths.join(", ")}.`,
        `They query another checkout's index (e.g. another worktree): ${stats.paths.join(", ")}.`,
      ),
    },
  ];
}

/** Flat metrics of the projectPath check, next to the search routing ones. */
export function flattenCodegraphPaths(stats: CodegraphPathStats): Record<string, number> {
  return { "codegraph.calls": stats.calls, "codegraph.projectpath.mismatch": stats.mismatched };
}

function pct(part: number, total: number): number | null {
  return total === 0 ? null : Math.round((1000 * part) / total) / 10;
}

/** Flat metrics of the routing counts: every route, plus the two quotients. */
export function flattenSearchRouting(counts: SearchCounts): Record<string, number | null> {
  const m: Record<string, number | null> = {};
  for (const route of SEARCH_ROUTES) m[`search.${route}`] = counts[route] ?? 0;
  const c = (k: string): number => counts[k] ?? 0;
  // `good%` = (wrapper + nativo) / scored, the figure #661 measures. Pipes and
  // extractions stay OUT: a pipe can never become the wrapper, so counting it
  // would set an unreachable ceiling.
  m["search.good.pct"] = pct(
    c("wrapper") + c("nativo"),
    SCORED_ROUTES.reduce((n, k) => n + c(k), 0),
  );
  const v2 = V2_ROUTES.reduce((n, k) => n + c(k), 0);
  m["search.v2.pct"] = pct(v2, v2 + ESCAPE_ROUTES.reduce((n, k) => n + c(k), 0));
  return m;
}

// ── Activation on opportunities (`mine-activation.py`, phase 1) ─────────────

/** Triggers in the script's order. `label` is the script's own name for it. */
export const ACTIVATION_TRIGGERS = [
  { id: "implementer", label: "implementer" },
  { id: "verify-before-done", label: "verify-before-done" },
  { id: "debug-error", label: "debug-error" },
  { id: "pr-review", label: "pr → review-diff/pilot" },
  { id: "reviewer", label: "reviewer" },
  { id: "loop-back-debug", label: "loop-back-debug" },
] as const;

const VERIFY_CMD =
  /\b(pnpm|npm|yarn|bun)\s+(run\s+)?(test|lint|typecheck|type-check|build|check)|\bvitest\b|\bjest\b|\btsc\b|\bpytest\b|\bruff\b|\beslint\b|\bbiome\b|test:coverage|gh pr checks|gh run/i;
// Python's `\b` is Unicode-aware, and after `✅` (a non-word character) it only
// matches before a word character — a quirk kept so the figures stay identical.
const DONE_CLAIM =
  /(^|\s)(?:(?:listo|hecho|terminado|completado|queda listo|todo (?:en )?verde)(?![\p{L}\p{N}_])|✅(?=[\p{L}\p{N}_]))/iu;
const ERROR_LINE = /(error TS\d+|^\s*Error:|\bFAIL\b|error\[E\d+\]|Traceback)/m;
const PR_CMD = /(?:^|&&\s*|;\s*)gh pr create/;
const COMMIT_CMD = /git commit/;
const CD_PREFIX = /^\s*cd\s+("[^"]*"|\S+)\s*&&\s*/;
const HOOK_BLOCK = /PreToolUse:|PostToolUse:|hook error/;
const DENIED = /requested permissions|user doesn't want|denied|rejected/i;

interface ActTool {
  name: string;
  input: Json;
  error: boolean;
  out: string;
}
interface ActTurn {
  user: string;
  tools: ActTool[];
  assistant: string[];
}

function textOf(msg: Json): string {
  const c = msg.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return (c as unknown[])
    .filter((b): b is Json => isJson(b) && b.type === "text")
    .map((b) => (typeof b.text === "string" ? b.text : ""))
    .join("\n");
}

/** Main-thread turns of one transcript; each tool call carries its `is_error`. */
function parseActivationTurns(path: string): ActTurn[] {
  const turns: ActTurn[] = [];
  let cur: ActTurn | null = null;
  const pending = new Map<unknown, ActTool>();
  for (const d of readJsonl(path) ?? []) {
    if (!isJson(d) || d.isSidechain) continue;
    const msg: Json = isJson(d.message) ? d.message : {};
    const c = msg.content;
    if (d.type === "user") {
      const blocks = Array.isArray(c) ? (c as unknown[]) : [];
      const results = blocks.filter((b): b is Json => isJson(b) && b.type === "tool_result");
      if (results.length > 0) {
        for (const b of results) {
          const tu = pending.get(b.tool_use_id);
          if (!tu) continue;
          tu.error = Boolean(b.is_error);
          // Truncated only when it is not a string, as in the script.
          tu.out =
            typeof b.content === "string"
              ? b.content
              : (JSON.stringify(b.content) ?? "null").slice(0, 8000);
        }
        continue;
      }
      const txt = textOf(msg);
      if (txt.trim()) {
        cur = { user: txt, tools: [], assistant: [] };
        turns.push(cur);
      }
    } else if (d.type === "assistant" && cur !== null && Array.isArray(c)) {
      for (const b of c as unknown[]) {
        if (!isJson(b)) continue;
        if (b.type === "tool_use") {
          const rec: ActTool = {
            name: pyStr(b.name, "None"),
            input: isJson(b.input) ? b.input : {},
            error: false,
            out: "",
          };
          cur.tools.push(rec);
          pending.set(b.id, rec);
        } else if (b.type === "text") {
          cur.assistant.push(typeof b.text === "string" ? b.text : "");
        }
      }
    }
  }
  return turns;
}

function isDebuggable(x: ActTool): boolean {
  if (!x.error) return false;
  if (HOOK_BLOCK.test(x.out.slice(0, 200)) || DENIED.test(x.out.slice(0, 300))) return false;
  return VERIFY_CMD.test(pyStr(x.input.command, "")) || ERROR_LINE.test(x.out);
}

/** Command signature: the leading `cd … &&` dropped, first four tokens. */
function commandSig(cmd: string): string {
  return cmd.replace(CD_PREFIX, "").split(/\s+/).filter(Boolean).slice(0, 4).join(" ");
}

/** Activation counts for a range. Only counts — no command, no example. */
export interface ActivationStats {
  /** Sessions whose transcript was analysed / located nowhere. */
  sessions: number;
  unavailable: number;
  opp: Record<string, number>;
  hit: Record<string, number>;
  /** Skill/Agent invocations the user did not name (`auto`) vs named (`asked`). */
  auto: Record<string, number>;
  asked: Record<string, number>;
  /** Sessions with >= 3 opportunities, bucketed by their own activation rate. */
  buckets: Record<"0%" | "1-24%" | "25-74%" | "75-100%", number>;
  graded: number;
}

const MIN_OPP = 3;

/**
 * Activation over opportunities (R67, `mine-activation.py`).
 *
 * Every figure is APPROXIMATE by construction, and the script says so: an
 * opportunity is a heuristic over the main thread, and any turn in which the
 * agent was used counts as one (`got` implies opportunity). That is why the
 * activation rate is never published alone — `flattenRangeMetrics` puts the
 * main thread's share of Edit/Write next to it.
 *
 * Not ported, deliberately: the script's phase 2 (plan tiers, spec 0032 R32),
 * the per-session table, `attributionSkill` inheritance inside subagents (the
 * report's skill tally already reads it) and the examples list, which carried
 * command text.
 */
export function mineActivation(sessions: readonly MinedSession[]): ActivationStats {
  const roles = roleAliases();
  const skills = skillAliases();
  const canonRole = (n: string): string => roles[n] ?? n;
  const canonSkill = (n: string): string => skills[n] ?? n;
  const stats: ActivationStats = {
    sessions: 0,
    unavailable: 0,
    opp: {},
    hit: {},
    auto: {},
    asked: {},
    buckets: { "0%": 0, "1-24%": 0, "25-74%": 0, "75-100%": 0 },
    graded: 0,
  };

  for (const s of sessions) {
    if (!s.transcript || !existsSync(s.transcript)) {
      stats.unavailable += 1;
      continue;
    }
    stats.sessions += 1;
    const turns = parseActivationTurns(s.transcript);
    const root = s.cwd ?? "";
    const opp: Record<string, number> = {};
    const hit: Record<string, number> = {};
    const failedOnce = new Set<string>();

    for (const t of turns) {
      const u = t.user.toLowerCase();
      const cmds = t.tools
        .filter((x) => x.name === "Bash")
        .map((x) => pyStr(x.input.command, ""))
        .join(" ; ");
      const usedSkill = new Set(
        t.tools.filter((x) => x.name === "Skill").map((x) => canonSkill(pyStr(x.input.skill, ""))),
      );
      const usedAgent = new Set(
        t.tools
          .filter((x) => x.name === "Agent" || x.name === "Task")
          .map((x) => canonRole(pyStr(x.input.subagent_type, ""))),
      );
      for (const x of t.tools) {
        if (x.name === "Skill") {
          const n = canonSkill(pyStr(x.input.skill, "?"));
          bump(u.includes(n) ? stats.asked : stats.auto, n);
        } else if (x.name === "Agent" || x.name === "Task") {
          const n = canonRole(pyStr(x.input.subagent_type, "?"));
          bump(u.includes(n) ? stats.asked : stats.auto, n);
        }
      }

      const mark = (id: string, cond: boolean, agent?: string, skill?: string): void => {
        // `got` implies opportunity: when work is delegated it happens in the
        // sidechain and `cond` (which looks at the main thread) is blind to it.
        const got =
          (agent !== undefined && usedAgent.has(agent)) ||
          (skill !== undefined && usedSkill.has(skill));
        if (!cond && !got) return;
        bump(opp, id);
        if (got) bump(hit, id);
      };

      const written = t.tools
        .filter((x) => (x.name === "Edit" || x.name === "Write") && x.input.file_path)
        .map((x) => pyStr(x.input.file_path, ""));
      const touched = new Set(countNonTrivial(written, root).counted);
      mark("implementer", touched.size >= 2, "implementer");

      const final = t.assistant.join("\n").slice(-1500);
      mark(
        "verify-before-done",
        touched.size > 0 && DONE_CLAIM.test(final) && !VERIFY_CMD.test(cmds),
        undefined,
        "verify-before-done",
      );
      mark("debug-error", t.tools.some(isDebuggable), undefined, "debug-failure");
      mark("pr-review", PR_CMD.test(cmds), "publisher", "review-diff");
      mark("reviewer", touched.size > 0 && COMMIT_CMD.test(cmds), "reviewer");

      for (const x of t.tools) {
        if (x.name !== "Bash" || !x.error) continue;
        const k = commandSig(pyStr(x.input.command, ""));
        if (k.length < 6) continue;
        if (failedOnce.has(k)) mark("loop-back-debug", true, undefined, "debug-failure");
        failedOnce.add(k);
      }
    }

    for (const [id, n] of Object.entries(opp)) bump(stats.opp, id, n);
    for (const [id, n] of Object.entries(hit)) bump(stats.hit, id, n);
    const o = Object.values(opp).reduce((a, b) => a + b, 0);
    const h = Object.values(hit).reduce((a, b) => a + b, 0);
    if (o >= MIN_OPP) {
      stats.graded += 1;
      const rate = (100 * h) / o;
      stats.buckets[rate === 0 ? "0%" : rate < 25 ? "1-24%" : rate < 75 ? "25-74%" : "75-100%"] +=
        1;
    }
  }
  return stats;
}

/** Flat metrics of the activation stats. The rate is floored to a whole
 *  percent, as the script prints it. */
export function flattenActivation(stats: ActivationStats): Record<string, number | null> {
  const m: Record<string, number | null> = {
    "activation.sessions": stats.sessions,
    "activation.sessions.unavailable": stats.unavailable,
    "activation.sessions.graded": stats.graded,
  };
  let to = 0;
  let th = 0;
  for (const { id } of ACTIVATION_TRIGGERS) {
    const o = stats.opp[id] ?? 0;
    const h = stats.hit[id] ?? 0;
    to += o;
    th += h;
    m[`activation.${id}.opportunities`] = o;
    m[`activation.${id}.hits`] = h;
    m[`activation.${id}.pct`] = o === 0 ? null : Math.floor((100 * h) / o);
  }
  m["activation.total.opportunities"] = to;
  m["activation.total.hits"] = th;
  m["activation.total.pct"] = to === 0 ? null : Math.floor((100 * th) / to);
  for (const [bucket, n] of Object.entries(stats.buckets)) m[`activation.bucket.${bucket}`] = n;
  for (const [name, n] of Object.entries(stats.auto)) m[`activation.invoked.auto.${name}`] = n;
  for (const [name, n] of Object.entries(stats.asked)) m[`activation.invoked.asked.${name}`] = n;
  return m;
}
