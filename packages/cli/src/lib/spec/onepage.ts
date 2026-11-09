/**
 * Structural check of a one-page `spec.md` (one vertical slice): required
 * sections, step/task caps and the word limit. Pure — text in, result out.
 * Headings match in Spanish or English; behavior-vs-implementation checks are
 * heuristic warnings, never errors.
 */
import type { FindingSeverity } from "./check.ts";

/** Hard cap on the whole file, counted like `wc -w`. */
export const MAX_WORDS = 1200;
/** Cap on numbered steps in the acceptance script. */
export const MAX_STEPS = 10;
/** Cap on items in the Tasks section. */
export const MAX_TASKS = 8;

export type OnePageRule =
  | "missing-section"
  | "too-long"
  | "steps-count"
  | "tasks-count"
  | "empty-outcome"
  | "missing-state"
  | "task-implementation";

export interface OnePageFinding {
  rule: OnePageRule;
  severity: FindingSeverity;
  /** Section or item the finding refers to. */
  where: string;
  message: string;
  /** 1-based line in the file, when the finding points at one. */
  line?: number;
}

export interface OnePageCheck {
  ok: boolean;
  words: number;
  findings: OnePageFinding[];
}

type SectionKey =
  | "outcome"
  | "acceptance"
  | "rules"
  | "states"
  | "environment"
  | "outOfScope"
  | "tasks";

/** Required sections in template order, with their normalized es/en heading prefixes. */
const SECTIONS: ReadonlyArray<{ key: SectionKey; label: string; aliases: readonly string[] }> = [
  { key: "outcome", label: "Outcome", aliases: ["outcome", "resultado"] },
  {
    key: "acceptance",
    label: "Acceptance script",
    aliases: ["acceptance script", "guion de aceptacion"],
  },
  { key: "rules", label: "Applicable rules", aliases: ["applicable rules", "reglas aplicables"] },
  { key: "states", label: "States", aliases: ["states", "estados"] },
  {
    key: "environment",
    label: "Environment and data",
    aliases: ["environment and data", "entorno y datos"],
  },
  { key: "outOfScope", label: "Out of scope", aliases: ["out of scope", "fuera de alcance"] },
  { key: "tasks", label: "Tasks", aliases: ["tasks", "tareas"] },
];

/** States the States section must mention; one warning per missing one. */
const STATES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "empty", pattern: /empty|vac[ií]o/i },
  { name: "error", pattern: /error/i },
  { name: "offline", pattern: /offline|sin conexi[oó]n/i },
  { name: "no permission", pattern: /permission|permiso/i },
];

interface Section {
  key: SectionKey;
  /** 1-based line of the heading. */
  line: number;
  /** Body lines paired with their 1-based line numbers. */
  body: Array<{ text: string; line: number }>;
}

function normalize(heading: string): string {
  return heading.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

function matchSection(heading: string): SectionKey | undefined {
  const norm = normalize(heading);
  return SECTIONS.find((s) =>
    s.aliases.some((a) => norm === a || norm.startsWith(`${a} `) || norm.startsWith(`${a}(`)),
  )?.key;
}

/** Splits the file into recognized `## ` sections, ignoring headings inside fenced code. */
function parseSections(text: string): Section[] {
  const sections: Section[] = [];
  let current: Section | undefined;
  let fence = false;
  text.split("\n").forEach((raw, index) => {
    const line = index + 1;
    if (/^\s*(```|~~~)/.test(raw)) fence = !fence;
    const heading = !fence ? /^## +(.+?)\s*$/.exec(raw) : null;
    if (heading) {
      const key = matchSection(heading[1] ?? "");
      current = key ? { key, line, body: [] } : undefined;
      if (current) sections.push(current);
      return;
    }
    current?.body.push({ text: raw, line });
  });
  return sections;
}

const STEP = /^\d+\. /;
const TASK = /^(?:\d+\. |- (?:\[[ xX]\] )?)/;

function implementationSmell(text: string): string | undefined {
  if (/\b\d+\.\d+\.\d+\b|@\d/.test(text)) return "a version";
  if (text.split(/\s+/).some((t) => t.includes("/") && /\.[A-Za-z0-9]+/.test(t))) {
    return "a file path";
  }
  if (/\w+\([^)]*\)/.test(text)) return "a function signature";
  return undefined;
}

/**
 * Validates a one-page spec. Errors: a missing section, more than
 * {@link MAX_WORDS} words, 0 or more than {@link MAX_STEPS} acceptance steps,
 * 0 or more than {@link MAX_TASKS} tasks, an empty outcome. Warnings: states
 * not mentioned and tasks that read as implementation.
 */
export function checkOnePageSpec(text: string): OnePageCheck {
  const findings: OnePageFinding[] = [];
  const trimmed = text.trim();
  const words = trimmed === "" ? 0 : trimmed.split(/\s+/).length;
  const sections = parseSections(text);
  const byKey = new Map<SectionKey, Section>();
  for (const s of sections) if (!byKey.has(s.key)) byKey.set(s.key, s);

  for (const s of SECTIONS) {
    if (!byKey.has(s.key)) {
      findings.push({
        rule: "missing-section",
        severity: "error",
        where: s.label,
        message: `missing section "## ${s.label}" (or its Spanish heading)`,
      });
    }
  }
  if (words > MAX_WORDS) {
    findings.push({
      rule: "too-long",
      severity: "error",
      where: "spec.md",
      message: `${words} words exceeds the ${MAX_WORDS}-word limit`,
    });
  }

  const outcome = byKey.get("outcome");
  if (outcome && !outcome.body.some((b) => b.text.trim() !== "")) {
    findings.push({
      rule: "empty-outcome",
      severity: "error",
      where: "Outcome",
      message: "the outcome section has no text",
      line: outcome.line,
    });
  }

  const acceptance = byKey.get("acceptance");
  if (acceptance) {
    const steps = acceptance.body.filter((b) => STEP.test(b.text)).length;
    if (steps === 0 || steps > MAX_STEPS) {
      findings.push({
        rule: "steps-count",
        severity: "error",
        where: "Acceptance script",
        message: `${steps} numbered steps; expected 1 to ${MAX_STEPS}`,
        line: acceptance.line,
      });
    }
  }

  const states = byKey.get("states");
  if (states) {
    const stateText = states.body.map((b) => b.text).join("\n");
    for (const state of STATES) {
      if (!state.pattern.test(stateText)) {
        findings.push({
          rule: "missing-state",
          severity: "warning",
          where: "States",
          message: `the States section does not mention "${state.name}" (use "n/a — <why>" if it cannot happen)`,
          line: states.line,
        });
      }
    }
  }

  const tasks = byKey.get("tasks");
  if (tasks) {
    const items = tasks.body.filter((b) => TASK.test(b.text));
    if (items.length === 0 || items.length > MAX_TASKS) {
      findings.push({
        rule: "tasks-count",
        severity: "error",
        where: "Tasks",
        message: `${items.length} tasks; expected 1 to ${MAX_TASKS}`,
        line: tasks.line,
      });
    }
    for (const item of items) {
      const smell = implementationSmell(item.text.replace(TASK, ""));
      if (smell) {
        findings.push({
          rule: "task-implementation",
          severity: "warning",
          where: "Tasks",
          message: `task mentions ${smell}; describe the outcome, not the implementation`,
          line: item.line,
        });
      }
    }
  }

  return { ok: !findings.some((f) => f.severity === "error"), words, findings };
}
