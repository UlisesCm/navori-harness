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
  { id: "formik", deps: ["formik"], label: "Formik forms" },
  { id: "mongoose", deps: ["mongoose", "@nestjs/mongoose"], label: "Mongoose ODM" },
  { id: "zod-validation", deps: ["zod"], label: "Zod validation" },
  { id: "joi-validation", deps: ["joi", "@hapi/joi"], label: "Joi validation" },
];

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
