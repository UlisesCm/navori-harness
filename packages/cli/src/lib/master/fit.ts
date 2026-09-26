import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCheckContext } from "./checks.ts";
import { splitTemplateSections } from "./templates.ts";

export interface FitCriterion {
  id: string;
  value: number | boolean;
  threshold: number | boolean;
  pass: boolean;
}

export interface FitResult {
  verifiable: FitCriterion[];
  allVerifiablePass: boolean;
  judgment: ["J1", "J2", "J3"];
}

const COUNT_CRITERIA = [
  { id: "V1", headings: ["Capacidades", "Capabilities"], threshold: 8 },
  { id: "V2", headings: ["Actores", "Actors"], threshold: 3 },
  { id: "V3", headings: ["Integraciones externas", "External integrations"], threshold: 1 },
  { id: "V4", headings: ["Entidades de datos", "Data entities"], threshold: 5 },
  { id: "V5", headings: ["Superficies", "Surfaces"], threshold: 1 },
] as const;

function bullets(body: string): number {
  return body.split(/\r?\n/).filter((line) => /^\s*[-*] \S/.test(line)).length;
}

/** Count D9's mechanical criteria; J1–J3 remain human judgment. */
export function evaluateFit(digest: string, codebase: string): FitResult {
  const sections = new Map(
    splitTemplateSections(digest).map((section) => [section.heading, section.body]),
  );
  const verifiable: FitCriterion[] = COUNT_CRITERIA.map(({ id, headings, threshold }) => {
    const heading = headings.find((candidate) => sections.has(candidate));
    const value = heading ? bullets(sections.get(heading) ?? "") : 0;
    return {
      id,
      value,
      threshold,
      pass: Boolean(heading) && (id === "V5" ? value === threshold : value <= threshold),
    };
  });
  const stack =
    splitTemplateSections(codebase).find((section) => /^Stack$/i.test(section.heading))?.body ?? "";
  const defined =
    stack.trim().length > 0 &&
    !/(?:\[DECISI[OÓ]N\]|decisi[oó]n abierta|open decision|por definir|to be decided|TBD)/i.test(
      stack,
    );
  verifiable.push({ id: "V6", value: defined, threshold: true, pass: defined });
  const findings = sections.get("Hallazgos") ?? sections.get("Findings") ?? "";
  const decisions = findings
    .split(/\r?\n/)
    .filter((line) => /^\s*[-*] .*\[DECISI[OÓ]N\]/i.test(line)).length;
  verifiable.push({ id: "V7", value: decisions, threshold: 2, pass: decisions <= 2 });
  return {
    verifiable,
    allVerifiablePass: verifiable.every((criterion) => criterion.pass),
    judgment: ["J1", "J2", "J3"],
  };
}

/** Read the active stage's inputs without changing stage state. */
export function checkFit(cwd: string): FitResult {
  const ctx = buildCheckContext(cwd);
  const digest = join(ctx.stagePath, "context", "DIGEST.md");
  const codebase = join(ctx.stagePath, "context", "CODEBASE.md");
  for (const path of [digest, codebase]) if (!existsSync(path)) throw new Error(`missing ${path}`);
  return evaluateFit(readFileSync(digest, "utf8"), readFileSync(codebase, "utf8"));
}
