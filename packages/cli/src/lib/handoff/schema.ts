/**
 * Zod schema for `impl_<feature>.json` (spec 0033, D3/R13) — the single
 * definition every consumer of the implementer's handoff parses against:
 * `lib/handoff/check.ts` (this CLI), `subagent-stop-handoff.sh` (advisory
 * hook, mirrors `REQUIRED_IMPL_KEYS` by hand since a shell hook cannot import
 * this module) and `implementer.md` (prose contract).
 */
import { z } from "zod";

/**
 * The keys `subagent-stop-handoff.sh` already required before this spec.
 * Exported so a test can pin parity between this array and the hook's own
 * hardcoded list — the two must never drift (T8).
 */
export const REQUIRED_IMPL_KEYS = [
  "feature",
  "status",
  "worktree",
  "branch",
  "commits",
  "filesTouched",
  "verification",
  "markdownRequests",
] as const;

/** A 40-hex `git rev-parse HEAD`. */
const GIT_SHA = /^[0-9a-f]{40}$/;

export const MarkdownRequestSchema = z.object({
  path: z.string().min(1),
  intent: z.string().min(1),
  evidence: z.string().min(1),
});

export const VerificationSchema = z
  .object({
    command: z.string().min(1),
    exitCode: z.number().int(),
    summary: z.string().min(1),
  })
  // Some acceptance-command evidence carries extra fields (e.g. `A<n>`
  // acceptance runs) — the shape below is the minimum, not the ceiling.
  .passthrough();

/**
 * The single schema for `impl_<feature>.json`. `head` (R13) is expected, not
 * required: the checker reports its absence as a warning, never a failure,
 * so a handoff written before navori added this field never breaks the
 * chain (see Migration in design.md). `acceptance` (spec 0032) stays
 * optional for the same reason.
 */
export const ImplHandoffSchema = z
  .object({
    feature: z.string().min(1),
    status: z.enum(["DONE", "BLOCKED"]),
    worktree: z.string().min(1),
    branch: z.string().min(1),
    commits: z.array(z.string()),
    filesTouched: z.array(z.string()),
    verification: VerificationSchema,
    markdownRequests: z.array(MarkdownRequestSchema),
    rootCause: z.string().optional(),
    blockers: z.array(z.string()).default([]),
    head: z.string().regex(GIT_SHA, "head must be a 40-hex git sha").optional(),
    acceptance: z.array(z.unknown()).optional(),
  })
  .passthrough();

export type ImplHandoff = z.infer<typeof ImplHandoffSchema>;
export type MarkdownRequest = z.infer<typeof MarkdownRequestSchema>;
