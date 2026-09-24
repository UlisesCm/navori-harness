/**
 * Deterministic Markdown render for a workplan (R11) and the pure state
 * transitions `navori plan update` applies before re-rendering (R12).
 *
 * "Deterministic" means the same `Workplan` value renders to the same bytes
 * every time — no timestamps, no random ids, no locale-dependent formatting.
 * Nothing else writes `workplan_<feature>.md` by hand (R11).
 */
import type { AcceptanceCriterion, ProgressStatus, Workplan } from "./schema.ts";

function heading(text: string): string {
  return `## ${text}`;
}

function renderAcceptance(
  acceptance: readonly AcceptanceCriterion[],
  progress: Workplan["progress"],
): string {
  return acceptance
    .map((a) => {
      const status: ProgressStatus = progress[a.id] ?? "pendiente";
      return [
        `- **${a.id}** (${status}) — ${a.description}`,
        `  - command: \`${a.command}\``,
        `  - expected: ${a.expected}`,
      ].join("\n");
    })
    .join("\n");
}

function renderList(items: readonly string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- (none)";
}

function renderFiles(files: Workplan["files"]): string {
  return files.length > 0
    ? files.map((f) => `- ${f.path}${f.new ? " (new)" : ""}`).join("\n")
    : "- (none)";
}

function renderDecisions(decisions: Workplan["decisions"]): string {
  return decisions.length > 0
    ? decisions.map((d) => `- ${d.date} — ${d.text}`).join("\n")
    : "- (none)";
}

function renderClassification(plan: Workplan): string {
  const { score, level, signals } = plan.classification;
  const breakdown = signals.length > 0 ? signals.join(", ") : "(no signals)";
  return `Complexity: ${score}/10 · Level: ${level}\nSignals: ${breakdown}`;
}

function renderPhases(phases: NonNullable<Workplan["phases"]>): string {
  return phases
    .map((phase) => `- **${phase.name}** — ${phase.acceptance.join(", ") || "(no acceptance)"}`)
    .join("\n");
}

function renderRisks(risks: NonNullable<Workplan["risks"]>): string {
  return risks.map((r) => `- ${r.risk} — rollback: ${r.rollback}`).join("\n");
}

/** Renders the workplan's Markdown, byte-identical for the same input (R11). */
export function renderWorkplan(plan: Workplan): string {
  const sections: string[] = [
    `# Workplan — ${plan.feature}`,
    "",
    heading("Clasificación"),
    renderClassification(plan),
    "",
    heading("Objetivo"),
    plan.objective,
    "",
    heading("Criterios"),
    renderAcceptance(plan.acceptance, plan.progress),
    "",
    heading("Fuera de alcance"),
    renderList(plan.outOfScope),
    "",
    heading("Archivos"),
    renderFiles(plan.files),
    "",
    heading("Decisiones"),
    renderDecisions(plan.decisions),
  ];

  if (plan.level >= 2) {
    sections.push("", heading("Solución"));
    sections.push(
      plan.solution ? `${plan.solution.path} — verdict: ${plan.solution.verdict}` : "- (none)",
    );
    sections.push("", heading("Fases"));
    sections.push(plan.phases && plan.phases.length > 0 ? renderPhases(plan.phases) : "- (none)");
    sections.push("", heading("Riesgos y rollback"));
    sections.push(plan.risks && plan.risks.length > 0 ? renderRisks(plan.risks) : "- (none)");
  }

  return `${sections.join("\n")}\n`;
}

/** A single mutation `navori plan update` applies to the JSON before
 * re-rendering (R12). Kept as a discriminated union rather than free-form
 * partial merges: an update either changes ONE criterion's status or appends
 * ONE decision, never both, so a caller can't accidentally clobber a sibling
 * field it didn't mean to touch. */
export type WorkplanUpdate =
  | { kind: "progress"; id: string; status: ProgressStatus }
  | { kind: "decision"; text: string; date: string };

/** Applies one update to a workplan and returns a new, still-valid value.
 * Pure — callers own reading/writing the JSON file. */
export function applyWorkplanUpdate(plan: Workplan, update: WorkplanUpdate): Workplan {
  if (update.kind === "progress") {
    if (!plan.acceptance.some((a) => a.id === update.id)) {
      throw new Error(`unknown acceptance id: ${update.id}`);
    }
    return { ...plan, progress: { ...plan.progress, [update.id]: update.status } };
  }
  return { ...plan, decisions: [...plan.decisions, { text: update.text, date: update.date }] };
}
