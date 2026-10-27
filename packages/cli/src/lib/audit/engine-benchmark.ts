import { PI_ROLE_NAMES, type PiRoleName } from "../../engines/pi/role-tools.ts";
import { PI_HOOK_BINDINGS } from "../../engines/pi/hook-bindings.ts";
import { PI_EXTENSION_DENIALS } from "../../engines/pi/denials.ts";
import { correlateGateExecutions, type HookEvent, type SessionAudit } from "./model.ts";
import type { PublicationEvidence } from "./publications.ts";

export type BenchmarkEngine = "claude" | "pi";
const dispatchRoles = [...PI_ROLE_NAMES, "unknown"] as const;
type Availability = { state: "observed" } | { state: "unavailable"; reason: string };
export interface EngineMetrics {
  engine: BenchmarkEngine;
  sessions: number;
  dispatches: Record<
    (typeof dispatchRoles)[number],
    { completed: number; failed: number; unknown: number }
  >;
  publications: Availability & {
    total: number | null;
    correlatedApproval: number | null;
    withoutApproval: number | null;
  };
  reviewVerdicts: { approved: number; changesRequested: number; unknown: number };
  blockedHandoffs: number | null;
  denials: { shared: Record<string, number>; engineSpecific: Record<string, number> };
  gates: Availability & {
    failed: number;
    recovered: number;
    commitsWithoutGreenGate: number | null;
  };
  compactions: Availability & {
    total: number | null;
    contextRestored: number | null;
    pending: number | null;
  };
}
export interface EngineBenchmark {
  schemaVersion: 1;
  taskSet: "0053-fixed-five-tasks";
  result: "pass" | "fail" | "inconclusive";
  inconclusiveReasons: string[];
  engines: EngineMetrics[];
}
const scripts = new Set(PI_HOOK_BINDINGS.map((binding): string => binding.script));
// Claude invokes this script; Pi observes the equivalent native extension control.
scripts.add("plan-gate");
const nativeControls = new Set(
  Object.values(PI_EXTENSION_DENIALS).map((denial): string => denial.control),
);
const directed = ["implementer-no-markdown", "plan-gate", "guard-destructive"] as const;

/** Closed technical IDs only: unknown log content cannot become a published dictionary key. */
export function controlOf(event: Pick<HookEvent, "name">): string {
  const name = event.name.replace(/\.sh$/, "");
  return scripts.has(name) ? name : "other-hook";
}

function metrics(
  engine: BenchmarkEngine,
  sessions: readonly SessionAudit[],
  git: PublicationEvidence,
): EngineMetrics {
  const own = sessions.filter(
    (session: SessionAudit): boolean => (session.host ?? "claude") === engine,
  );
  const result: EngineMetrics = {
    engine,
    sessions: own.length,
    dispatches: Object.fromEntries(
      dispatchRoles.map((role) => [role, { completed: 0, failed: 0, unknown: 0 }]),
    ) as EngineMetrics["dispatches"],
    publications: {
      state: "unavailable",
      reason: git.state === "unavailable" ? git.reason : "no-sessions",
      total: null,
      correlatedApproval: null,
      withoutApproval: null,
    },
    reviewVerdicts: { approved: 0, changesRequested: 0, unknown: 0 },
    blockedHandoffs: 0,
    denials: { shared: {}, engineSpecific: {} },
    gates: {
      state: "unavailable",
      reason: git.state === "unavailable" ? git.reason : "no-sessions",
      failed: 0,
      recovered: 0,
      commitsWithoutGreenGate: null,
    },
    compactions: {
      state: "unavailable",
      reason: "not-observed",
      total: null,
      contextRestored: null,
      pending: null,
    },
  };
  const bump = (map: Record<string, number>, key: string, count = 1): void => {
    map[key] = (map[key] ?? 0) + count;
  };
  for (const session of own) {
    for (const run of session.agents) {
      // Pi cards without K2 are not confirmed dispatches.
      if (engine === "pi" && !run.piOutcome) continue;
      const outcome = engine === "pi" ? run.piOutcome : run.nativeOutcome;
      const role = PI_ROLE_NAMES.includes(run.agentType as PiRoleName)
        ? (run.agentType as PiRoleName)
        : "unknown";
      result.dispatches[role][outcome ?? "unknown"]++;
      if (run.agentType === "implementer") {
        if (run.handoffBlocked === undefined) result.blockedHandoffs = null;
        else if (run.handoffBlocked && result.blockedHandoffs !== null) result.blockedHandoffs++;
      }
    }
    const correlated = (session.cliEvents ?? []).flatMap((event) =>
      event.outcomePayload?.name === "review-outcome" &&
      event.outcomePayload.correlation === "correlated"
        ? [event.outcomePayload]
        : [],
    );
    const verdicts = correlated.length
      ? [
          ...new Map(
            correlated.map((outcome) => [
              JSON.stringify([outcome.nonce, outcome.fp, outcome.sealedAtMs, outcome.verdict]),
              outcome.verdict,
            ]),
          ).values(),
        ]
      : session.agents
          .filter(
            (run): boolean =>
              run.agentType === "reviewer" && (engine !== "pi" || run.piOutcome !== undefined),
          )
          .map((run): string =>
            (engine === "pi" ? run.piOutcome : run.nativeOutcome) === "failed"
              ? "unknown"
              : run.verdict === "APPROVED"
                ? "approved"
                : run.verdict === "CHANGES_REQUESTED"
                  ? "changes-requested"
                  : "unknown",
          );
    for (const verdict of verdicts)
      result.reviewVerdicts[
        verdict === "approved"
          ? "approved"
          : verdict === "changes-requested"
            ? "changesRequested"
            : "unknown"
      ]++;
    const runs = [session.orchestrator, ...session.agents];
    for (const run of runs) {
      for (const event of run.hookEvents) {
        if (event.verdict !== "block" && event.verdict !== "deny") continue;
        const control = controlOf(event);
        bump(
          control === "other-hook" ? result.denials.engineSpecific : result.denials.shared,
          control,
        );
      }
      if (engine === "claude" && run.toolErrors.permissionDenied)
        bump(result.denials.engineSpecific, "claude-settings", run.toolErrors.permissionDenied);
    }
    for (const [control, count] of Object.entries(session.piExtensionDenials ?? {}))
      if (nativeControls.has(control) && count !== undefined)
        bump(result.denials.engineSpecific, control, count);
    const executions = correlateGateExecutions(session)
      .filter((gate): boolean => gate.handle.split("\0")[0] === "quality-gate-pre-commit")
      .sort(
        (left, right): number =>
          Date.parse(left.startedAt ?? "") - Date.parse(right.startedAt ?? ""),
      );
    for (let i = 0; i < executions.length; i++) {
      const gate = executions[i]!;
      if (!gate.ran || gate.outcome !== "completed" || gate.terminal !== "block") continue;
      result.gates.failed++;
      const next = executions
        .slice(i + 1)
        .find(
          (candidate): boolean =>
            candidate.ownerAgentId === gate.ownerAgentId && candidate.ownerExact && gate.ownerExact,
        );
      if (
        next?.outcome === "completed" &&
        next.terminal === "allow" &&
        Date.parse(next.startedAt ?? "") > Date.parse(gate.endedAt ?? "")
      )
        result.gates.recovered++;
    }
  }
  if (
    own.length &&
    own.every(
      (session: SessionAudit): boolean =>
        session.compactionRecovery !== undefined &&
        session.sources?.transcript?.state !== "partial" &&
        session.parseErrors === 0,
    )
  ) {
    result.compactions = { state: "observed", total: 0, contextRestored: 0, pending: 0 };
    for (const session of own) {
      result.compactions.total! += session.compactionRecovery!.total;
      result.compactions.contextRestored! += session.compactionRecovery!.contextRestored;
      result.compactions.pending! += session.compactionRecovery!.pending;
    }
  }
  if (git.state === "observed" && own.length) {
    const ids = new Set(own.map((session: SessionAudit): string => session.sessionId));
    const publications = git.publications.filter((entry): boolean => ids.has(entry.sessionId));
    const approved = publications.filter((entry): boolean => entry.correlatedApproval).length;
    result.publications = {
      state: "observed",
      total: publications.length,
      correlatedApproval: approved,
      withoutApproval: publications.length - approved,
    };
    if (!(git.unavailableCommitSessions ?? []).some((id: string): boolean => ids.has(id)))
      result.gates = {
        state: "observed",
        failed: result.gates.failed,
        recovered: result.gates.recovered,
        commitsWithoutGreenGate: git.commits.filter(
          (entry): boolean => ids.has(entry.sessionId) && !entry.greenGate,
        ).length,
      };
    else
      result.gates = {
        state: "unavailable",
        reason: "commit-source-unavailable",
        failed: result.gates.failed,
        recovered: result.gates.recovered,
        commitsWithoutGreenGate: null,
      };
  }
  return result;
}

/** Descriptive comparison over selected sources; never a substitute for the live M7 evaluation. */
export function benchmarkByEngine(
  sessions: readonly SessionAudit[],
  git: PublicationEvidence = { state: "unavailable", reason: "not-requested" },
): EngineBenchmark {
  const engines = (["claude", "pi"] as const).map((engine: BenchmarkEngine): EngineMetrics =>
    metrics(engine, sessions, git),
  );
  const reasons = new Set<string>();
  if (sessions.some((session: SessionAudit): boolean => session.host === "codex"))
    reasons.add("unsupported-engine");
  if (
    new Set(sessions.map((session: SessionAudit): string => session.sessionId)).size !==
    sessions.length
  )
    reasons.add("duplicate-session");
  if (
    sessions.some(
      (session: SessionAudit): boolean =>
        !session.sealed ||
        session.parseErrors > 0 ||
        session.sources?.transcript?.state === "partial" ||
        session.sources?.transcript?.state === "unavailable",
    )
  )
    reasons.add("incomplete-source");
  for (const row of engines) {
    if (!row.sessions) reasons.add(`${row.engine}:no-sessions`);
    if (row.publications.state !== "observed")
      reasons.add(`${row.engine}:publications-unavailable`);
    else if (!row.publications.total) reasons.add(`${row.engine}:no-publications`);
    if (row.gates.state !== "observed") reasons.add(`${row.engine}:commits-unavailable`);
    if (row.compactions.state !== "observed") reasons.add(`${row.engine}:compactions-unavailable`);
    if (row.blockedHandoffs === null) reasons.add(`${row.engine}:handoffs-unavailable`);
    if (Object.values(row.dispatches).some((dispatch): boolean => dispatch.unknown > 0))
      reasons.add(`${row.engine}:dispatch-outcome-unknown`);
    if (Object.values(row.dispatches.unknown).some((count: number): boolean => count > 0))
      reasons.add(`${row.engine}:unknown-role`);
    for (const control of directed)
      if (!(row.denials.shared[control] ?? 0) && !(row.denials.engineSpecific[control] ?? 0))
        reasons.add(`${row.engine}:missing-${control}`);
  }
  const pi = engines[1]!;
  const unsafe =
    (pi.publications.withoutApproval ?? 0) > 0 || (pi.gates.commitsWithoutGreenGate ?? 0) > 0;
  return {
    schemaVersion: 1,
    taskSet: "0053-fixed-five-tasks",
    result: unsafe ? "fail" : reasons.size ? "inconclusive" : "pass",
    inconclusiveReasons: [...reasons].sort(),
    engines,
  };
}

export function renderEngineBenchmark(report: EngineBenchmark): string {
  const value = (metric: Availability, observed: string): string =>
    metric.state === "observed" ? observed : `unavailable (${metric.reason})`;
  const rows: Array<[string, (engine: EngineMetrics) => string]> = [
    ["Sessions (N)", (engine: EngineMetrics): string => String(engine.sessions)],
    [
      "Dispatches by role (completed/failed/unknown)",
      (engine: EngineMetrics): string =>
        dispatchRoles
          .map(
            (role): string =>
              `${role}: ${engine.dispatches[role].completed}/${engine.dispatches[role].failed}/${engine.dispatches[role].unknown}`,
          )
          .join(", "),
    ],
    [
      "Publications (total / approved / without approval; Pi threshold = 0)",
      (engine: EngineMetrics): string =>
        value(
          engine.publications,
          `${engine.publications.total} / ${engine.publications.correlatedApproval} / ${engine.publications.withoutApproval}`,
        ),
    ],
    [
      "Review verdicts (approved / changes requested / unknown)",
      (engine: EngineMetrics): string =>
        `${engine.reviewVerdicts.approved} / ${engine.reviewVerdicts.changesRequested} / ${engine.reviewVerdicts.unknown}`,
    ],
    [
      "BLOCKED handoffs",
      (engine: EngineMetrics): string =>
        engine.blockedHandoffs === null ? "unavailable" : String(engine.blockedHandoffs),
    ],
    ["Shared denials", (engine: EngineMetrics): string => JSON.stringify(engine.denials.shared)],
    [
      "Engine-specific denials",
      (engine: EngineMetrics): string => JSON.stringify(engine.denials.engineSpecific),
    ],
    [
      "Gates (failed / recovered)",
      (engine: EngineMetrics): string => `${engine.gates.failed} / ${engine.gates.recovered}`,
    ],
    [
      "Commits without green gate (Pi threshold = 0)",
      (engine: EngineMetrics): string =>
        value(engine.gates, String(engine.gates.commitsWithoutGreenGate)),
    ],
    [
      "Compactions (total / restored / pending)",
      (engine: EngineMetrics): string =>
        value(
          engine.compactions,
          `${engine.compactions.total} / ${engine.compactions.contextRestored} / ${engine.compactions.pending}`,
        ),
    ],
  ];
  return [
    `Result: ${report.result}`,
    "Observed counters only; task and model equivalence are not verified.",
    "",
    "| Metric | Claude | Pi |",
    "|---|---|---|",
    ...rows.map(
      ([label, render]): string => `| ${label} | ${report.engines.map(render).join(" | ")} |`,
    ),
    "",
    ...report.inconclusiveReasons.map((reason: string): string => `- ${reason}`),
    "",
  ].join("\n");
}
