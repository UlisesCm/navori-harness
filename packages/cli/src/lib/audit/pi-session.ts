/**
 * Pi session adapter for `navori audit` (spec 0047 R12).
 *
 * Reads the parent Pi session JSONL and keeps ONLY counts, names, ids, timestamps and token
 * usage: prompts, assistant text, tool arguments and tool output are never retained. Children
 * come from `navori_subagent` tool results (their `details.role` and native `usage`); a child
 * without `usage` is reported as unavailable, never as zero.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readAuditJsonl } from "./paths.ts";
import {
  type AgentRun,
  type AuditLogView,
  type AuditReadBudget,
  type MetricEvidence,
  type SessionAudit,
  type SourceHealth,
  createAuditReadBudget,
  emptyOrchestrator,
  emptyPermissionDecisions,
  emptyTokens,
  emptyToolErrors,
  retainAuditFact,
} from "./model.ts";
import { attachHookEvents } from "./parse.ts";
import { PI_ROLE_NAMES } from "../../engines/pi/role-tools.ts";

const SESSION_ID = /^[A-Za-z0-9_-]{1,256}$/;
const NAME = /^[A-Za-z0-9_.:-]{1,64}$/;
const ROLES: ReadonlySet<string> = new Set(PI_ROLE_NAMES);
const MAX_DIRS = 5_000;
const MAX_CHILDREN = 1_000;
const TOKEN_KEYS = ["input", "output", "cacheRead", "cacheCreation", "thinking"] as const;

/** Directories Pi writes sessions to: the documented override first, then the default root. */
export function piSessionRoots(): string[] {
  const override = process.env.PI_CODING_AGENT_SESSION_DIR?.trim();
  return [...(override ? [override] : []), join(homedir(), ".pi", "agent", "sessions")];
}

/** First record of a Pi session file, or null when unreadable or not a session header. */
function readHeader(file: string): { id: string; cwd: string | null } | null {
  let header: { id: string; cwd: string | null } | null = null;
  try {
    readAuditJsonl(file, (value) => {
      const rec = value as Record<string, unknown> | null;
      if (rec && rec.type === "session" && typeof rec.id === "string")
        header = { id: rec.id, cwd: typeof rec.cwd === "string" ? rec.cwd : null };
      return false;
    });
  } catch {
    return null;
  }
  return header;
}

/** Locate `<ts>_<sessionId>.jsonl` one directory below a session root (Pi encodes the cwd as the folder). */
export function resolvePiSession(sessionId: string): string | null {
  if (!SESSION_ID.test(sessionId)) return null;
  const suffix = `_${sessionId}.jsonl`;
  for (const root of piSessionRoots()) {
    if (!existsSync(root)) continue;
    try {
      for (const dir of readdirSync(root).slice(0, MAX_DIRS)) {
        const folder = join(root, dir);
        let files: string[];
        try {
          files = readdirSync(folder);
        } catch {
          continue;
        }
        const hit = files.find((file) => file.endsWith(suffix));
        if (hit) return join(folder, hit);
      }
    } catch {
      /* unreadable root: try the next one */
    }
  }
  return null;
}

/** Verified only when the header names this session and, if known, the marked cwd. */
export function inspectPiSession(
  file: string | null,
  sessionId: string,
  cwd: string | null,
): "verified" | "missing" | "wrong-format" | "identity-conflict" {
  if (!file) return "missing";
  const header = readHeader(file);
  if (!header) return "wrong-format";
  return header.id !== sessionId || (cwd && header.cwd && header.cwd !== cwd)
    ? "identity-conflict"
    : "verified";
}

/** A finite non-negative number, else null. */
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** Pi `Usage` onto the shared token shape; null when no counter is a valid number (absent is not zero). */
function tokensOf(usage: unknown): ReturnType<typeof emptyTokens> | null {
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const input = count(u.input);
  const output = count(u.output);
  if (input === null || output === null) return null;
  return {
    input,
    output,
    cacheRead: count(u.cacheRead) ?? 0,
    cacheCreation: count(u.cacheWrite) ?? 0,
    thinking: count(u.reasoning) ?? 0,
  };
}

function add(into: ReturnType<typeof emptyTokens>, from: ReturnType<typeof emptyTokens>): void {
  for (const key of TOKEN_KEYS) into[key] += from[key];
}

const iso = (ms: unknown): string | null => {
  const n = count(ms);
  return n === null || n > 8.64e15 ? null : new Date(n).toISOString();
};

/** Parent session plus its `navori_subagent` children, as one audited session; null when the source is unusable. */
export function parsePiSession(
  sessionId: string,
  logFile: string,
  piFile: string,
  log: AuditLogView,
  budget: AuditReadBudget = createAuditReadBudget(),
): SessionAudit | null {
  const start = log.records.find((record) => record.event === "start") ?? null;
  if (!start || start.host !== "pi") return null;
  if (start.sessionId !== undefined && start.sessionId !== sessionId) return null;

  const tokens = emptyTokens();
  const models: Record<string, number> = {};
  const toolCounts: Record<string, number> = {};
  const children: Array<{
    role: string;
    spawnToolUseId?: string;
    tokens: ReturnType<typeof emptyTokens> | null;
    at: string | null;
    ms: number;
  }> = [];
  let turns = 0;
  let assistants = 0;
  let measured = 0;
  let cwd: string | null = null;
  let first: string | null = null;
  let last: string | null = null;
  const reading = readAuditJsonl(piFile, (value) => {
    if (typeof value !== "object" || value === null) return;
    const rec = value as Record<string, unknown>;
    if (rec.type === "session") {
      if (rec.id !== sessionId) return false;
      cwd = typeof rec.cwd === "string" ? rec.cwd : null;
      return;
    }
    const at =
      typeof rec.timestamp === "string" && Number.isFinite(Date.parse(rec.timestamp))
        ? new Date(rec.timestamp).toISOString()
        : null;
    if (at && (!first || at < first)) first = at;
    if (at && (!last || at > last)) last = at;
    if (rec.type === "usage") {
      const t = tokensOf(rec.usage);
      if (t) add(tokens, t);
      return;
    }
    const message = rec.type === "message" ? rec.message : null;
    if (typeof message !== "object" || message === null) return;
    const m = message as Record<string, unknown>;
    if (m.role === "assistant") {
      turns++;
      assistants++;
      const t = tokensOf(m.usage);
      if (t) {
        measured++;
        add(tokens, t);
      }
      if (typeof m.model === "string" && NAME.test(m.model))
        models[m.model] = (models[m.model] ?? 0) + 1;
    } else if (m.role === "toolResult") {
      const name = typeof m.toolName === "string" && NAME.test(m.toolName) ? m.toolName : "unknown";
      toolCounts[name] = (toolCounts[name] ?? 0) + 1;
      if (name === "navori_subagent" && children.length < MAX_CHILDREN) {
        const details = m.details as Record<string, unknown> | undefined;
        const role =
          typeof details?.role === "string" && ROLES.has(details.role) ? details.role : "unknown";
        children.push({
          role,
          // Failed/unknown tool results do not establish that a child actually spawned.
          ...(m.isError === false &&
          role !== "unknown" &&
          typeof m.toolCallId === "string" &&
          SESSION_ID.test(m.toolCallId)
            ? { spawnToolUseId: m.toolCallId }
            : {}),
          tokens: tokensOf(m.usage),
          at: iso(m.timestamp),
          ms: count(m.durationMs) ?? 0,
        });
      }
    }
  });
  // Only counters and names were retained above; reserve them once against the shared budget.
  retainAuditFact(budget, sessionId, { tokens, models, toolCounts });

  const failed = reading.sourceStatus !== "observed";
  const state: SourceHealth["state"] = failed
    ? "unavailable"
    : reading.incompleteTail || reading.malformedJson || reading.stoppedEarly
      ? "partial"
      : "observed";
  const health: SourceHealth = {
    state,
    reason: failed ? "unreadable" : state === "partial" ? "malformed" : null,
    source: "transcript",
    adapter: "pi-session",
    sourceVersion: null,
    records: reading.lines,
    validRecords: reading.completeLines - reading.malformedJson,
    parseErrors: reading.malformedJson + reading.invalidUtf8,
    incompleteTail: reading.incompleteTail,
    from: first,
    to: last,
    reading,
  };
  const evidence = (ok: boolean, partial = false): MetricEvidence => ({
    ...health,
    state:
      failed || !ok
        ? "unavailable"
        : partial || health.state !== "observed"
          ? "partial"
          : "observed",
    reason: failed
      ? "unreadable"
      : ok
        ? partial
          ? "not-observed"
          : health.reason
        : "not-observed",
  });
  const own = (ok: boolean, partial = false): Record<string, MetricEvidence> => ({
    tools: evidence(!failed),
    turns: evidence(!failed),
    models: evidence(!failed),
    ...Object.fromEntries(TOKEN_KEYS.map((key) => [`tokens.${key}`, evidence(ok, partial)])),
    startupTokens: evidence(false),
  });
  const startedAt = typeof start.ts === "string" ? start.ts : (first ?? "");
  const session: SessionAudit = {
    sessionId,
    startedAt,
    endedAt: last ?? startedAt,
    wallClockMs: first && last ? Math.max(0, Date.parse(last) - Date.parse(first)) : 0,
    initialPrompt: "",
    prompts: { typed: 0, queued: 0, queuedSystem: 0 },
    gitBranch: null,
    cwd: typeof start.cwd === "string" ? start.cwd : cwd,
    ccVersions: [],
    navori: { rendered: null, cli: null },
    navoriAtStop: null,
    sealed: false,
    endReason: null,
    permissionModes: {},
    prs: [],
    orchestrator: {
      ...emptyOrchestrator(),
      tokens,
      models,
      toolCounts,
      turns: failed ? null : turns,
      contextPeak: null,
      compactions: null,
      toolResultBytes: null,
    },
    agents: [],
    signals: [],
    hookLogFrom: null,
    otelFrom: null,
    permissions: emptyPermissionDecisions(),
    toolErrorTypes: {},
    hostSkills: [],
    host: "pi",
    parseErrors: reading.malformedJson + reading.invalidUtf8,
    linesRead: reading.lines,
    availability: {
      ...own(measured > 0, measured < assistants),
      wallClockMs: evidence(first !== null && last !== null),
    },
    sources: { transcript: health },
  };
  children.forEach((child, index) => {
    const known = child.tokens !== null;
    const ended = child.at ?? "";
    const began = child.at ? new Date(Date.parse(child.at) - child.ms).toISOString() : "";
    const run: AgentRun = {
      // Identity: parent session id + role + ordinal; a child shares the parent's worktree (session.cwd).
      agentId: `pi-${child.role}-${index + 1}`,
      ...(child.spawnToolUseId ? { spawnToolUseId: child.spawnToolUseId } : {}),
      agentType: child.role,
      model: null,
      description: "",
      startedAt: began,
      endedAt: ended,
      durationMs: child.ms,
      spawnDepth: 1,
      tokens: child.tokens ?? emptyTokens(),
      startupTokens: 0,
      overlapsWith: [],
      toolCounts: {},
      skillsRead: [],
      skills: [],
      skillsDiscarded: 0,
      skillAttributionRecords: 0,
      mcpCalls: {},
      mcpReach: {},
      mcpBarredTokens: {},
      hookEvents: [],
      frictionEvents: 0,
      toolErrors: emptyToolErrors(),
      repeatedCommands: {},
      classifierExemptBash: 0,
      verdict: null,
      availability: {
        ...Object.fromEntries(TOKEN_KEYS.map((key) => [`tokens.${key}`, evidence(known)])),
        startupTokens: evidence(false),
        tools: evidence(false),
        turns: evidence(false),
      },
    };
    session.agents.push(run);
  });
  attachHookEvents(session, logFile, log);
  return session;
}
