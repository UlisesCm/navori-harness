/**
 * Single source of truth for the Pi child roles (spec 0048 D9, R14): the tool allowlist and the
 * per-role deadline. Both `index.ts` (rendered `.pi/agents/*.md`) and the extension source import it.
 */
export const PI_ROLE_NAMES = [
  "scout",
  "implementer",
  "reviewer",
  "scribe",
  "auditor",
  "architect",
] as const;

export type PiRoleName = (typeof PI_ROLE_NAMES)[number];

/**
 * Roles Pi renders as `.pi/agents/<role>.md` (with `tools: []`) for the PARENT session to follow,
 * never dispatched as children: a child cannot approve `gh pr create`, which needs the parent's
 * confirmation (#1496). They stay navori-owned for render, prune and audit classification.
 */
export const PI_PARENT_ROLES = ["publisher"] as const;

export type PiParentRoleName = (typeof PI_PARENT_ROLES)[number];

/** Whether `role` is a parent role (rendered for the parent session, never a child). */
export function isPiParentRole(role: string): role is PiParentRoleName {
  return (PI_PARENT_ROLES as readonly string[]).includes(role);
}

/** Whether `role` is a dispatchable Pi child role. */
export function isPiChildRole(role: string): role is PiRoleName {
  return (PI_ROLE_NAMES as readonly string[]).includes(role);
}

/** Tools a Pi child may be given, per role. */
export const PI_ROLE_TOOLS: Readonly<Record<PiRoleName, readonly string[]>> = {
  scout: ["read", "grep", "find", "ls", "write"],
  // Its git commit runs the quality gate (R4).
  implementer: ["read", "grep", "find", "ls", "bash", "edit", "write"],
  reviewer: ["read", "grep", "find", "ls", "bash", "write"],
  // Admitted only with harness.scribeOwnsMarkdown; its Bash runs its own handoff preflight.
  scribe: ["read", "grep", "find", "ls", "bash", "edit", "write"],
  auditor: ["read", "grep", "find", "ls", "bash", "write"],
  // Nested dispatch (`Agent(scout, scribe)`) is excluded on Pi via `navori:if-not onPi`.
  architect: ["read", "grep", "find", "ls", "bash", "write"],
};

/** Gate timeout (600 s) every child role with bash must outlive. */
export const PI_GATE_TIMEOUT_MS = 600_000;

const MINUTE_MS = 60_000;

/** Child deadline per role; the gate runs inside it (F10), so every role with bash exceeds gate + 10 min. */
export const PI_ROLE_TIMEOUT_MS: Readonly<Record<PiRoleName, number>> = {
  scout: 10 * MINUTE_MS,
  scribe: 20 * MINUTE_MS,
  reviewer: 20 * MINUTE_MS,
  auditor: 20 * MINUTE_MS,
  architect: 20 * MINUTE_MS,
  implementer: 30 * MINUTE_MS,
};
