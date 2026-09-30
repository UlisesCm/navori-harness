/**
 * Checks shared by `checks.ts` (MASTER.md) and `ux.ts` (UX.md): section presence
 * against a template header list, and `D<n>` citation existence. Extracted so
 * the two documents validate identically without duplicated code.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { masterDirPath } from "./stages.ts";
import { splitTemplateSections } from "./templates.ts";

export type CheckFailure = string;

export const DECISION_HEADING = /^D(\d+)$/;

/** Validates that `content` has every heading in `expected`, each with a
 * non-empty body (a body that is exactly `<noAplica marker> <razón>` counts as
 * non-empty on purpose — R21). `noAplica` is the language-resolved marker
 * (`No aplica:` / `Not applicable:`), never a hardcoded literal. */
export function validateSections(
  content: string,
  expected: readonly string[],
  label: string,
  noAplica: string,
): CheckFailure[] {
  const sections = new Map(splitTemplateSections(content).map((s) => [s.heading, s] as const));
  const failures: CheckFailure[] = [];
  for (const heading of expected) {
    const section = sections.get(heading);
    if (!section) {
      failures.push(`${label}: falta la sección "## ${heading}"`);
      continue;
    }
    if (section.body.trim().length === 0) {
      failures.push(`${label}: la sección "## ${heading}" está vacía`);
      continue;
    }
    // Plain string search, not a dynamic RegExp built from `noAplica` — the
    // marker is a fixed, non-attacker-controlled literal from `markers.ts`,
    // but semgrep's detect-non-literal-regexp rule flags any `new RegExp(var)`
    // regardless, so this stays literal-free by design.
    const noAplicaLine = section.body
      .split("\n")
      .find((line) => line.trimStart().startsWith(noAplica));
    if (
      noAplicaLine &&
      noAplicaLine.slice(noAplicaLine.indexOf(noAplica) + noAplica.length).trim().length === 0
    ) {
      failures.push(`${label}: "## ${heading}" dice "${noAplica}" sin razón`);
    }
  }
  return failures;
}

/**
 * Every `D<n>` (or `NN-slug/D<n>`) cited in `content` must exist in the stage's
 * own `DECISIONS.md` (or the named closed stage's).
 */
export function checkDecisionCitations(
  content: string,
  label: string,
  ctx: { cwd: string; specsDir: string; stagePath: string },
): CheckFailure[] {
  const failures: CheckFailure[] = [];
  const decisionIdsCited = new Set<string>();
  for (const match of content.matchAll(/(?:\b(\d{2}-[a-z0-9-]+)\/)?\bD(\d+)\b/g)) {
    decisionIdsCited.add(match[1] ? `${match[1]}/D${match[2]}` : `D${match[2]}`);
  }
  const localPath = join(ctx.stagePath, "DECISIONS.md");
  const localDecisions = existsSync(localPath) ? readFileSync(localPath, "utf8") : "";
  const localIds = new Set(
    splitTemplateSections(localDecisions)
      .filter((s) => DECISION_HEADING.test(s.heading))
      .map((s) => s.heading),
  );
  for (const cited of decisionIdsCited) {
    if (!cited.includes("/")) {
      if (!localIds.has(cited))
        failures.push(`${label}: cita ${cited}, que no existe en DECISIONS.md`);
      continue;
    }
    const [stageDir, id] = cited.split("/");
    const otherDecisions = join(masterDirPath(ctx.cwd, ctx.specsDir), stageDir!, "DECISIONS.md");
    if (!existsSync(otherDecisions)) {
      failures.push(`${label}: cita ${cited}, y ${stageDir}/DECISIONS.md no existe`);
      continue;
    }
    const otherIds = new Set(
      splitTemplateSections(readFileSync(otherDecisions, "utf8"))
        .filter((s) => DECISION_HEADING.test(s.heading))
        .map((s) => s.heading),
    );
    if (!otherIds.has(id!)) failures.push(`${label}: cita ${cited}, que no existe`);
  }

  return failures;
}
