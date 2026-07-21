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
  { id: "socketio", deps: ["socket.io", "socket.io-client"], label: "Socket.IO realtime" },
  { id: "redux-toolkit", deps: ["@reduxjs/toolkit", "redux"], label: "Redux Toolkit" },
  {
    id: "tanstack-query",
    deps: ["@tanstack/react-query", "vue-query", "solid-query"],
    label: "TanStack Query",
  },
  { id: "react-hook-form", deps: ["react-hook-form"], label: "React Hook Form" },
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
 * Detect which library skills apply for the repo's dependency names. Additive
 * and order-stable (registry order): returns the id of every skill whose `deps`
 * intersect `deps`. No exclusivity — a repo can match many at once.
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
  { legacy: ["redux"], preferred: ["@reduxjs/toolkit"], domain: "State" },
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
 */
export function detectMigrations(deps: ReadonlyArray<string>): ActiveMigration[] {
  const present = new Set(deps);
  const out: ActiveMigration[] = [];
  for (const pair of MIGRATION_PAIRS) {
    const legacyHit = pair.legacy.find((d) => present.has(d));
    const preferredHits = pair.preferred.filter((d) => present.has(d));
    if (legacyHit && preferredHits.length > 0) {
      out.push({ legacy: legacyHit, preferred: preferredHits.join(" / "), domain: pair.domain });
    }
  }
  return out;
}
