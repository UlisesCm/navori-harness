/**
 * `PLAN.md` of the master plan v2 (spec 0063): one page with the goal, where
 * slices are accepted, the slice index and the decisions. Pure: text in, data out.
 */
import { MAX_WORDS } from "../spec/onepage.ts";

export interface PlanAcceptance {
  env: string;
  url: string;
  /** Branch that deploys the acceptance environment. */
  branch: string;
  /** Branch slice PRs target. */
  target: string;
  wip: number;
}

export interface PlanSlice {
  id: string;
  outcome: string;
  spec: string;
  /** Integration commit of a slice built before the v2 (no marks). */
  commit: string;
}

export interface Plan {
  goal: string;
  acceptance: PlanAcceptance;
  slices: PlanSlice[];
  decisions: { id: string; text: string }[];
}

export interface PlanFinding {
  severity: "error" | "warning";
  message: string;
}

const norm = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase();

const SECTIONS = {
  goal: ["objetivo", "goal"],
  acceptance: ["aceptacion", "acceptance"],
  slices: ["slices"],
  decisions: ["decisiones", "decisions"],
} as const;

const KEYS: Record<string, keyof PlanAcceptance> = {
  entorno: "env",
  environment: "env",
  "rama de aceptacion": "branch",
  "acceptance branch": "branch",
  "rama destino": "target",
  "target branch": "target",
  wip: "wip",
};

/** Body of each `## ` section, keyed by its normalized heading. */
function sections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const block of text.split(/^## /m).slice(1)) {
    const nl = block.indexOf("\n");
    out.set(norm(nl === -1 ? block : block.slice(0, nl)), nl === -1 ? "" : block.slice(nl + 1));
  }
  return out;
}

function section(all: Map<string, string>, names: readonly string[]): string | undefined {
  for (const name of names) if (all.has(name)) return all.get(name);
  return undefined;
}

/** Data rows of the first Markdown table in `body`, keyed by normalized header. */
function tableRows(body: string): Record<string, string>[] {
  const lines = body.split("\n").filter((l) => l.trim().startsWith("|"));
  const cells = (line: string): string[] =>
    line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => c.trim());
  const header = lines[0] ? cells(lines[0]).map(norm) : [];
  return lines.slice(2).map((line) => {
    const row: Record<string, string> = {};
    cells(line).forEach((value, i) => {
      const key = header[i];
      if (key) row[key] = value;
    });
    return row;
  });
}

const pick = (row: Record<string, string>, prefixes: string[]): string => {
  const key = Object.keys(row).find((k) => prefixes.some((p) => k.startsWith(p)));
  return key ? (row[key] ?? "") : "";
};

export function parsePlan(text: string): Plan {
  const all = sections(text);
  const acceptance: PlanAcceptance = { env: "", url: "", branch: "", target: "", wip: 1 };
  for (const line of (section(all, SECTIONS.acceptance) ?? "").split("\n")) {
    const match = /^\s*[-*]\s*([^:]+):\s*(.+)$/.exec(line);
    const key = match?.[1] ? KEYS[norm(match[1])] : undefined;
    const value = match?.[2]?.trim() ?? "";
    if (key === "wip") acceptance.wip = Number.parseInt(value, 10) || 1;
    else if (key === "env") {
      acceptance.url = /https?:\/\/\S+/.exec(value)?.[0] ?? "";
      acceptance.env = value
        .replace(acceptance.url, "")
        .replace(/[\s—–-]+$/, "")
        .trim();
    } else if (key) acceptance[key] = value.replace(/`/g, "");
  }
  const slices = tableRows(section(all, SECTIONS.slices) ?? "").map((row) => ({
    id: pick(row, ["id"]).toUpperCase(),
    outcome: pick(row, ["actor", "outcome", "resultado"]),
    spec: pick(row, ["spec"]).replace(/`/g, ""),
    commit: pick(row, ["commit"]).replace(/`/g, ""),
  }));
  const decisions = tableRows(section(all, SECTIONS.decisions) ?? "").map((row) => ({
    id: pick(row, ["id"]).toUpperCase(),
    text: pick(row, ["decision"]),
  }));
  return { goal: (section(all, SECTIONS.goal) ?? "").trim(), acceptance, slices, decisions };
}

/** A slice named after a single layer ("todo el backend de pagos"). */
const HORIZONTAL =
  /\b(todo|toda|todos|solo|only|all|entire|whole)\b.*\b(backend|frontend|api|ui|base de datos|database|modelo|model|infraestructura|infrastructure|migraciones|migrations)\b/i;

export function checkPlan(text: string): PlanFinding[] {
  const findings: PlanFinding[] = [];
  const error = (message: string): void => {
    findings.push({ severity: "error", message });
  };
  const all = sections(text);
  const plan = parsePlan(text);
  if (!plan.goal) error("falta la sección Objetivo");
  if (section(all, SECTIONS.acceptance) === undefined) error("falta la sección Aceptación");
  else {
    if (!plan.acceptance.env) error("Aceptación: falta Entorno");
    if (!plan.acceptance.branch) error("Aceptación: falta Rama de aceptación");
    if (!plan.acceptance.target) error("Aceptación: falta Rama destino");
  }
  if (plan.slices.length === 0) error("Slices: índice vacío");
  const seen = new Set<string>();
  for (const slice of plan.slices) {
    if (!/^S\d+$/.test(slice.id)) error(`${slice.id || "(sin ID)"}: el ID debe ser S<n>`);
    if (seen.has(slice.id)) error(`${slice.id}: ID duplicado`);
    seen.add(slice.id);
    if (HORIZONTAL.test(slice.outcome)) error(`${slice.id}: slice horizontal (una sola capa)`);
    else if (!slice.outcome.includes("→")) error(`${slice.id}: debe ser "actor → resultado"`);
  }
  const words = text.trim().split(/\s+/).length;
  if (words > MAX_WORDS) error(`${words} palabras: el plan cabe en una página (≤${MAX_WORDS})`);
  return findings;
}
