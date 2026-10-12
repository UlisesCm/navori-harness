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
  "publisher",
] as const;

export type PiRoleName = (typeof PI_ROLE_NAMES)[number];

/** Tools a Pi child may be given, per role. */
export const PI_ROLE_TOOLS: Readonly<Record<PiRoleName, readonly string[]>> = {
  scout: ["read", "grep", "find", "ls", "write"],
  implementer: ["read", "grep", "find", "ls", "bash", "edit", "write"],
  reviewer: ["read", "grep", "find", "ls", "bash", "write"],
  // Admitted only with harness.scribeOwnsMarkdown; its Bash runs its own handoff preflight.
  scribe: ["read", "grep", "find", "ls", "bash", "edit", "write"],
  auditor: ["read", "grep", "find", "ls", "bash", "write"],
  // Nested dispatch (`Agent(scout, scribe)`) is excluded on Pi via `navori:if-not onPi`.
  architect: ["read", "grep", "find", "ls", "bash", "write"],
  // Publisher gating (R4-R6) lands separately (M6); until then dispatch refuses `publisher` (see checkDispatch).
  publisher: ["read", "grep", "find", "ls", "bash"],
};

/** Gate timeout (600 s) the commit/push roles must outlive. */
export const PI_GATE_TIMEOUT_MS = 600_000;

const MINUTE_MS = 60_000;

/** Child deadline per role; the gate runs inside it (F10), so implementer/publisher exceed gate + 10 min. */
export const PI_ROLE_TIMEOUT_MS: Readonly<Record<PiRoleName, number>> = {
  scout: 10 * MINUTE_MS,
  scribe: 10 * MINUTE_MS,
  reviewer: 20 * MINUTE_MS,
  auditor: 20 * MINUTE_MS,
  architect: 20 * MINUTE_MS,
  implementer: 30 * MINUTE_MS,
  publisher: 40 * MINUTE_MS,
};
