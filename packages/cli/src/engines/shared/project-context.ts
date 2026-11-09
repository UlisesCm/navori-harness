import { type NavoriConfig } from "../../lib/config/config.ts";
import { tc, type Lang } from "../../lib/i18n.ts";
import { sanitizeProjectValue } from "../../lib/render/interpolate.ts";

/**
 * Turn the init questionnaire answers (project.* posture, review rigor,
 * architecture rule, critical areas, tests policy) into ACTIVE rules the
 * agents follow — not user-section hints. Returns null when nothing is set so
 * the block is stripped rather than rendered empty.
 *
 * Shared by Claude's `contexto-proyecto` block in CLAUDE.md and Pi's AGENTS.md:
 * risk routing needs the critical areas on every engine that orchestrates.
 */
export function buildContextoProyectoBody(config: NavoriConfig, lang: Lang): string | null {
  // Read straight off the schema type: an `?? {}` fallback would widen `proj`
  // to a union with `{}` and lose every declared key.
  const proj = config.project;
  const t = tc(lang).blocks.projectContext;
  const rows: string[] = [];

  const posture = proj?.posture;
  if (posture === "greenfield") {
    rows.push(t.stageGreenfield);
  } else if (posture === "production") {
    rows.push(t.stageProduction);
  } else if (posture === "migration") {
    rows.push(t.stageMigration);
  }

  const migrations = proj?.libraryMigrations ?? [];
  for (const m of migrations) {
    // project.* is untrusted config (checked-in, editable via PR) landing inside
    // a trusted managed block — sanitize so it can't inject doctrine or forge a
    // marker to corrupt the region (#198).
    const domain = sanitizeProjectValue(m.domain);
    const preferred = sanitizeProjectValue(m.preferred);
    const legacy = sanitizeProjectValue(m.legacy);
    rows.push(t.migrationRow(domain, preferred, legacy));
  }

  const rigor = proj?.reviewRigor;
  if (rigor === "strict") {
    rows.push(t.rigorStrict);
  } else if (rigor === "pragmatic") {
    rows.push(t.rigorPragmatic);
  }

  const arch = sanitizeProjectValue(proj?.architectureRule ?? "");
  if (arch) {
    rows.push(t.architecture(arch));
  }

  const critical = (proj?.criticalAreas ?? [])
    .map((c) => sanitizeProjectValue(c))
    .filter((c) => c !== "");
  if (critical.length > 0) {
    rows.push(t.criticalAreas(critical.join(", ")));
  }

  const tests = proj?.testsForNewCode;
  if (tests === "always") {
    rows.push(t.testsAlways);
  } else if (tests === "when-applicable") {
    rows.push(t.testsWhenApplicable);
  } else if (tests === "none") {
    rows.push(t.testsNone);
  }

  // #529: the exclusion only means something next to a policy that demands
  // tests. Under `none` there is nothing to carve out, and printing it there
  // would read as a second, contradictory rule.
  if (tests === "always" || tests === "when-applicable") {
    const excluded = (proj?.testsExclude ?? [])
      .map((e) => sanitizeProjectValue(e))
      .filter((e) => e !== "");
    if (excluded.length > 0) rows.push(t.testsExclude(excluded.join(", ")));
  }

  if (rows.length === 0) return null;

  return [t.heading, "", t.intro, "", ...rows, ""].join("\n");
}
