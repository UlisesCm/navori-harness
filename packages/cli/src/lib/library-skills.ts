/**
 * Library skills — modular skills injected by dependency detection, orthogonal
 * to presets. A repo earns a skill when it ships the matching dependency,
 * independent of which preset it uses: a Vite SPA and a Nest API both get
 * `socketio` when they depend on socket.io. Detection is ADDITIVE — every match
 * is returned, with no mutual exclusion (unlike the old zod-XOR-joi validator
 * flag this mechanism supersedes).
 *
 * Bodies live in core-assets/lib-skills/<id>.md and are materialized by the
 * claude engine, deduped by destination against the core + preset skills so a
 * preset that already ships a skill always wins.
 */

export interface LibrarySkill {
  /** Skill id — also the asset filename (`lib-skills/<id>.md`) and dest basename. */
  id: string;
  /** Dependency names that activate this skill; any single match is enough. */
  deps: ReadonlyArray<string>;
  /** Human label for the skills index ("— library (detected)"). */
  label: string;
}

/**
 * Registry of library skills in display order. Detection scans the repo's
 * resolved dependency names (package.json / pyproject) against each `deps`.
 */
export const LIBRARY_SKILLS: ReadonlyArray<LibrarySkill> = [
  {
    id: "react-router",
    deps: ["react-router-dom", "react-router"],
    label: "React Router",
  },
  { id: "axios", deps: ["axios"], label: "Axios HTTP" },
  { id: "socketio", deps: ["socket.io", "socket.io-client"], label: "Socket.IO realtime" },
  { id: "redux-toolkit", deps: ["@reduxjs/toolkit", "redux"], label: "Redux Toolkit" },
  {
    id: "tanstack-query",
    deps: ["@tanstack/react-query", "vue-query", "solid-query"],
    label: "TanStack Query",
  },
  { id: "react-hook-form", deps: ["react-hook-form"], label: "React Hook Form" },
  {
    id: "mantine-form",
    deps: ["@mantine/form", "mantine-form-zod-resolver"],
    label: "Mantine Form",
  },
  { id: "mongoose", deps: ["mongoose", "@nestjs/mongoose"], label: "Mongoose ODM" },
  { id: "zod-validation", deps: ["zod"], label: "Zod validation" },
  { id: "winston-logging", deps: ["winston"], label: "Winston logging" },
  {
    id: "stripe",
    deps: ["stripe", "@stripe/stripe-js", "@stripe/react-stripe-js"],
    label: "Stripe payments",
  },
  { id: "apollo-client", deps: ["@apollo/client"], label: "Apollo Client" },
  { id: "zustand", deps: ["zustand"], label: "Zustand" },
  { id: "tamagui", deps: ["tamagui", "@tamagui/core"], label: "Tamagui" },
  { id: "bullmq", deps: ["bullmq"], label: "BullMQ jobs & queues" },
];

/**
 * Library-skill ids that USED to ship but were removed from the registry —
 * legacy libs navori no longer teaches (their guidance now lives only as the
 * legacy side of a MIGRATION_PAIRS rule). `render` prunes their stale managed
 * file from repos that were rendered before the removal, but only files that
 * carry navori's own marker — a user's hand-written skill of the same name is
 * left untouched. Append here whenever a library skill is retired.
 */
export const REMOVED_LIB_SKILLS: ReadonlyArray<string> = ["formik", "joi-validation"];

const BY_ID: ReadonlyMap<string, LibrarySkill> = new Map(LIBRARY_SKILLS.map((s) => [s.id, s]));

/**
 * Absolute floor of source files that must IMPORT the PREFERRED side of a
 * migration before the "migrate away" rule fires. Below it the target is barely
 * adopted — likely an incidental peer dep, not the repo's real destination —
 * and flagging it misleads reviewers (issue #86). Adoption never gates library
 * SKILLS: a declared+present tracked dep always earns its skill (a mongoose
 * backend of two files still wants mongoose guidance). Counts are migrations-only.
 */
export const MIN_ADOPTION_FILES = 3;

/**
 * For a migration, the preferred (target) side must be imported in at least
 * this fraction of the legacy side's files. Guards against flagging a pair
 * whose "preferred" is an incidental peer dep — e.g. `dayjs` pulled in by
 * `@mantine/dates` (3 files) while the legacy `moment` has 23 and the real
 * modernization target (`luxon`) isn't even in the pair. Without the ratio the
 * rule renders backwards from the repo's de-facto standard (issue #86).
 */
export const MIN_PREFERRED_RATIO = 0.5;

/**
 * Every dependency name referenced by MIGRATION_PAIRS — the exact set whose
 * import counts drive the dominance gate. Callers scan the project tree for just
 * these names (bounding the work) and hand the counts to `detectMigrations`.
 * Library skills are presence-only, so their deps are not scanned.
 */
export function migrationDepNames(): string[] {
  const names = new Set<string>();
  for (const pair of MIGRATION_PAIRS) {
    for (const d of pair.legacy) names.add(d);
    for (const d of pair.preferred) names.add(d);
  }
  return [...names];
}

/**
 * Detect which library skills apply for the repo's dependency names. Additive
 * and order-stable (registry order): returns the id of every skill whose `deps`
 * intersect `deps`. No exclusivity — a repo can match many at once.
 *
 * Presence-only by design: a declared+present tracked dep ALWAYS earns its
 * skill, regardless of how many files import it. Usage counts weigh migrations
 * (which side is the de-facto standard), not whether a lib is worth teaching —
 * a two-file mongoose backend still wants the mongoose skill (issue #92).
 */
export function detectLibrarySkills(deps: ReadonlyArray<string>): string[] {
  const present = new Set(deps);
  return LIBRARY_SKILLS.filter((s) => s.deps.some((d) => present.has(d))).map((s) => s.id);
}

/** Look up a library skill by id, or null when the id is unknown. */
export function librarySkillById(id: string): LibrarySkill | null {
  return BY_ID.get(id) ?? null;
}

/**
 * A known dependency migration: a legacy library being replaced by a preferred
 * one. When BOTH sides are present in a repo's deps, navori emits an active
 * "prefer the new, freeze the legacy" rule in the project-context block so
 * agents stop writing new code against the legacy lib. Detection is on raw dep
 * names — independent of whether either side ships a skill. A legacy lib alone
 * (no successor present) is NOT flagged: without a target there's no migration.
 */
export interface MigrationPair {
  /** Legacy dependency name(s); any present marks the legacy side. */
  legacy: ReadonlyArray<string>;
  /** Preferred dependency name(s); any present marks the target side. */
  preferred: ReadonlyArray<string>;
  /** Domain prefix for the rendered rule ("Fechas", "Forms", …). */
  domain: string;
}

/**
 * Registry of known migrations. Kept deliberately small and high-confidence:
 * each pair is a legacy lib the ecosystem has clearly moved off of, paired with
 * the current standard. Cross-preset, like LIBRARY_SKILLS.
 */
export const MIGRATION_PAIRS: ReadonlyArray<MigrationPair> = [
  { legacy: ["moment"], preferred: ["dayjs", "date-fns"], domain: "Fechas" },
  { legacy: ["formik"], preferred: ["react-hook-form"], domain: "Forms" },
  { legacy: ["joi", "@hapi/joi"], preferred: ["zod"], domain: "Validación" },
  { legacy: ["yup"], preferred: ["zod"], domain: "Validación" },
  { legacy: ["redux"], preferred: ["@reduxjs/toolkit"], domain: "State" },
  { legacy: ["antd"], preferred: ["@mantine/core"], domain: "UI" },
  { legacy: ["@chakra-ui/react"], preferred: ["@mantine/core"], domain: "UI" },
];

/** An active migration in a specific repo: the legacy + preferred deps actually
 * present. Persisted to `project.libraryMigrations` and rendered as a rule. */
export interface ActiveMigration {
  /** The legacy dep actually present in the repo. */
  legacy: string;
  /** The preferred dep(s) actually present, joined for display. */
  preferred: string;
  /** Domain prefix for the rendered rule. */
  domain: string;
}

/**
 * Detect active migrations for a repo's dependency names: a pair is active only
 * when a legacy dep AND at least one preferred dep are both present. Order-stable
 * (registry order). Names the specific deps found so the rendered rule is exact.
 *
 * When per-dep import `counts` are supplied, presence is not enough — the pair
 * must also pass a DOMINANCE gate so we don't flag a "migration" whose preferred
 * side is an incidental peer dep while the repo's real standard is a lib not in
 * the pair (issue #86). The gate keys off SCAN TRUSTWORTHINESS, not the
 * preferred count: when the legacy side was actually seen in code
 * (`legacyUsed > 0`) the scan is reliable, so the preferred side must clear an
 * absolute floor (`MIN_ADOPTION_FILES`) AND a share of the legacy usage
 * (`MIN_PREFERRED_RATIO`) — and `preferredUsed === 0` then counts as evidence of
 * NON-use, suppressing the rule (a widely-used `moment` with a zero-import
 * `dayjs` peer dep is not a migration). The benefit of the doubt — falling back
 * to presence — applies only when nothing was scanned: no `counts`, or a legacy
 * side with zero observed imports (empty / unscannable repo). This keeps the
 * gate monotonic: less adoption never yields more flagging.
 * With several preferred candidates present, they're ordered by usage so the
 * dominant one leads the rendered rule instead of the first in the registry.
 */
export function detectMigrations(
  deps: ReadonlyArray<string>,
  counts?: ReadonlyMap<string, number>,
): ActiveMigration[] {
  const present = new Set(deps);
  const out: ActiveMigration[] = [];
  for (const pair of MIGRATION_PAIRS) {
    const legacyHit = pair.legacy.find((d) => present.has(d));
    const preferredHits = pair.preferred.filter((d) => present.has(d));
    if (!legacyHit || preferredHits.length === 0) continue;

    let preferred = preferredHits;
    if (counts) {
      const usage = (d: string) => counts.get(d) ?? 0;
      const preferredUsed = preferredHits.reduce((n, d) => n + usage(d), 0);
      const legacyUsed = pair.legacy.reduce((n, d) => n + usage(d), 0);
      // A trustworthy scan is one that actually observed the legacy in code.
      // Then a sparse (or zero) preferred side is real evidence of non-adoption
      // and the rule is suppressed. A zero-usage legacy means we scanned nothing
      // meaningful → fall back to presence (benefit of the doubt).
      if (legacyUsed > 0) {
        if (preferredUsed < MIN_ADOPTION_FILES) continue;
        if (preferredUsed < legacyUsed * MIN_PREFERRED_RATIO) continue;
      }
      // Lead with the dominant candidate; ties keep registry order (stable sort).
      preferred = [...preferredHits].sort((a, b) => usage(b) - usage(a));
    }

    out.push({ legacy: legacyHit, preferred: preferred.join(" / "), domain: pair.domain });
  }
  return out;
}
