/**
 * What the HOST does — written down once, with the source next to each line.
 *
 * #647. Five defects of 2026-09-09/10 share one signature: the doctrine navori
 * ships asserted something the host does not do, and nothing noticed. In three
 * of them navori's own code ALSO acted on the false claim, which is what made
 * them invisible — the system was coherent with itself and wrong about the
 * world. The repo already checks prose against reality three ways
 * (`hook-claims-vs-scripts`, `cited-paths-exist`, `check-asset-commands`), and
 * all three compare an asset against something navori itself produces. None of
 * them can catch a claim about the host, because the host is outside the render.
 *
 * This file is the missing half: the one place where a host behavior is
 * recorded. It is deliberately NOT a re-implementation of the official
 * documentation — that would be a copy that desynchronizes, which is the very
 * error the issue denounces one level up. Each entry is one sentence about
 * BEHAVIOR, its `source` quotes or names where that came from, and `enforcedBy`
 * names who would catch a regression. An entry nobody enforces has to say so:
 * writing it down is worth something on its own, and pretending otherwise is
 * how the next false claim gets in.
 *
 * How to use it: when an asset (or a comment, or a design decision) is about to
 * depend on host behavior, look for it here. If it isn't here, measure it and
 * add it with the evidence. Never restate a contract in prose somewhere else —
 * cite this file, and the drift has one place to be fixed.
 */

/** One behavior of the host that navori's doctrine or code depends on. */
export interface HostContract {
  /** Stable id, referenced from tests and prose. */
  readonly id: string;
  /** What the host actually does. One sentence, stated as behavior. */
  readonly claim: string;
  /**
   * Where the claim comes from: a quote from the host's docs, or the
   * measurement that established it. Never a paraphrase of a paraphrase.
   */
  readonly source: string;
  /** The defect that made this expensive to learn — the receipt. */
  readonly provedBy: string;
  /**
   * Who catches a regression, or why nothing does. A contract with no
   * enforcement is still worth recording, but it must admit it.
   */
  readonly enforcedBy: string;
}

export const HOST_CONTRACTS: readonly HostContract[] = [
  {
    id: "skills-load-shape",
    claim:
      "Claude Code loads a skill only as `<skills-root>/<name>/SKILL.md`. A flat " +
      "`<skills-root>/<name>.md` is never loaded, and fails silently — no warning, no error.",
    source:
      "Claude Code's 'Choose where skills load' table lists five locations (personal, " +
      "project, nested, --add-dir, plugin) and every one of them is `<skill-name>/SKILL.md`. " +
      "The flat shape belongs to `.claude/commands/`, a different feature. Corroborated by " +
      "the comparable libraries: gentle-ai's registry scans `<root>/<skill>/SKILL.md` and " +
      "obra/superpowers ships zero loose `.md` in its skills root.",
    provedBy:
      "#626 — navori's prose called the flat form valid and `resolveLocalSkillPath` " +
      "preferred it, so navori advertised in CLAUDE.md skills the host never loaded. Four " +
      "sat broken in `~/.claude/skills/` for ~3 months in silence.",
    enforcedBy:
      "`host-contracts.test.ts` sweeps assets and source for the flat literal; " +
      "`flat-skills.ts` reports it in the user's repo via doctor.",
  },
  {
    id: "agents-discovered-upward",
    claim:
      "Subagents are discovered by walking UP from the working directory, never down: a " +
      "`.claude/agents/` inside a subdirectory is unreachable from the repo root.",
    source:
      "Claude Code's Subagents doc: agents are 'discovered by walking up from the current " +
      "working directory'.",
    provedBy:
      "Spec 0018 — the monorepo render copied a full `.claude/` into every workspace. " +
      "Measured on two real monorepos: 43–48% of each workspace's harness was unreachable, " +
      "and zero sessions had ever started from inside a workspace.",
    enforcedBy:
      "Nothing detects a NEW prose claim to the contrary. Spec 0018's render trimming is " +
      "what acts on it; a text detector would have to guess which `.claude/agents/` mention " +
      "is about a nested one, and a guessing check is noise.",
  },
  {
    id: "settings-do-not-nest",
    claim:
      "`.claude/settings.json` is read at the project root only. Nested levels are not part " +
      "of the precedence chain, so a workspace's own settings file is never applied.",
    source:
      "Claude Code's Settings precedence table lists no nested level; and starting a session " +
      "inside a subdirectory reads the file from the repo root.",
    provedBy: "Spec 0018 — see `agents-discovered-upward`.",
    enforcedBy: "Nothing, for the same reason as `agents-discovered-upward`.",
  },
  {
    id: "hooks-resolve-project-dir",
    claim:
      "Every hook command runs against `$CLAUDE_PROJECT_DIR`, which resolves to the repo " +
      "root — so a hook script placed inside a workspace never runs.",
    source:
      'navori registers every hook as `bash "$CLAUDE_PROJECT_DIR/.claude/hooks/<x>.sh"` ' +
      "(`build-settings.ts`), and the host resolves that variable to the project root.",
    provedBy:
      "Spec 0018, with proof on disk: `managed-drift-watch` writes a stamp on every " +
      "PostToolUse, and after months of use both monorepos had exactly ONE stamp — the " +
      "root's. No workspace ever had one.",
    enforcedBy:
      "`cited-paths-exist` covers hooks by the runtime-probe rule (#389); the root-only " +
      "resolution itself is enforced by `build-settings.ts` being the single registrar.",
  },
  {
    id: "session-start-context-truncated",
    claim:
      "A SessionStart hook's `additionalContext` is NOT delivered whole: past a host limit " +
      "the model gets a preview of the first ~2 KB and the rest is persisted to a file the " +
      "model never opens. Exit code is 0 either way, so it fails silently.",
    source:
      "Measured across 40+ real sessions: the hook emitted 20–48 KB and the smallest " +
      "observed truncation point is 10,441 bytes. Re-measured on 2026-09-10 while closing " +
      "#648: the truncated arm receives 2,247–2,322 bytes.",
    provedBy:
      "#623 — the routing ladder that decides when to delegate reached ZERO sessions, in " +
      "every repo, from the moment spec 0015 moved it to this channel.",
    enforcedBy:
      "`session-start-budget.test.ts` pins the emitter's budget and the pointer fallback. " +
      "It covers the ONE channel navori emits through today; a second channel would need " +
      "its own budget test, not a generalization of that one.",
  },
  {
    id: "post-tool-use-additional-context",
    claim:
      "A PostToolUse hook can put text in front of the model mid-session through " +
      "`hookSpecificOutput.additionalContext`, and the host shows it to Claude. The " +
      "event fires after the tool has already run, so it can inform but never block.",
    source:
      "Claude Code's hooks reference: PostToolUse honors `additionalContext`, and " +
      '"Claude Code adds `additionalContext` as context that Claude can see and act ' +
      'on". Its payload carries `tool_name`, `tool_input`, `session_id`, `cwd` and ' +
      "`transcript_path` — everything the routing watcher reads.",
    provedBy:
      "Spec 0020 — the routing ladder reached the model at startup and delegation " +
      "still did not happen: of 48 audited sessions, 21 crossed the R2 threshold and " +
      "12 (57%) delegated nothing. Startup context loses to the turn where the " +
      "decision is actually made.",
    enforcedBy:
      "`routing-watch.test.ts` pins what the hook EMITS — that the JSON is well " +
      "formed, fires once, and never blocks. Nothing here proves the host DELIVERS " +
      "it: every assertion reads the script's stdout, which is the exact gap that " +
      "made #623 invisible for weeks. Delivery becomes checkable only with R5, which " +
      "records each notice in the audit log so the transcript can be read back.",
  },
  {
    id: "agent-description-drives-delegation",
    claim:
      "Claude Code decides which subagent to delegate to by matching the task against " +
      "each subagent's `description`. A description that says only what the agent IS " +
      "gives the host nothing to match a task against.",
    source:
      "Claude Code's subagents doc: \"Claude uses each subagent's description to " +
      'decide when to delegate tasks", and "to encourage proactive delegation, ' +
      "include phrases like 'use proactively' in your subagent's description field\". " +
      "The combined descriptions are also budgeted: past 15,000 tokens the host warns " +
      "at startup.",
    provedBy:
      "Spec 0020 — all 8 agents navori shipped described what they were and none said " +
      "when to reach for them, while all 40 skills already declared their trigger. It " +
      "was hypothesis H1 of the activation research, written down and never executed " +
      "because the investigation pivoted to the delivery channel (#623).",
    enforcedBy:
      "`agent-descriptions.test.ts` sweeps the shipped assets for the trigger form. " +
      "It is a CONVENTION check, not a semantic one — a regex cannot know whether a " +
      "sentence expresses a condition — so it asserts the only verifiable thing: that " +
      "the phrasing matches the form the host's own doc names.",
  },
  {
    id: "claude-md-adherence-threshold",
    claim:
      "CLAUDE.md is context, not enforced configuration, and its length trades against " +
      "how reliably it is followed: past roughly 200 lines the host itself reports " +
      "reduced adherence. A skill body, by contrast, loads only when used.",
    source:
      "Claude Code's memory doc: \"Claude treats them as context, not enforced " +
      'configuration"; "target under 200 lines per CLAUDE.md file. Longer files ' +
      'consume more context and reduce adherence"; and on skills, "a skill\'s body ' +
      "loads only when it's used, so long reference material costs almost nothing " +
      'until you need it".',
    provedBy:
      "Spec 0020 — navori's own rendered CLAUDE.md measured 278 lines while the " +
      "harness spent a week reinforcing that same channel to make its doctrine stick.",
    enforcedBy:
      "`claude-md-budget.test.ts` measures the RENDERED file against the threshold. " +
      "It bounds what navori ships (184 lines) and cannot bound what the user writes " +
      "in their own half of the file — a repo that crosses the line on its own prose " +
      "gets no warning today.",
  },
  {
    id: "hooks-run-inside-subagents",
    claim:
      "Tool hooks fire for a subagent's tool calls too, not only the main " +
      "conversation's — with `agent_id` (and `agent_type`) added to the payload, " +
      "present only inside a subagent. A PostToolUse hook cannot assume its event " +
      "came from the orchestrator.",
    source:
      "Claude Code's hooks reference: \"When a subagent calls a tool, tool events " +
      "such as PreToolUse and PostToolUse fire the same configured hooks as in the " +
      'main conversation", and the input gains `agent_id`/`agent_type` "present ' +
      'only when the hook fires inside a subagent call".',
    provedBy:
      "Cold review of PR #660 — routing-watch counted a delegated implementer's own " +
      "edits (same session_id, `#delegated` only lands when the Agent tool RETURNS), " +
      "so the once-per-session notice fired INTO the subagent's context and was " +
      "burned before the orchestrator could ever receive it.",
    enforcedBy:
      '`routing-watch.test.ts` ("never notifies a subagent...") drives the hook ' +
      "with an `agent_id`-carrying payload and pins that it records delegation " +
      "instead of notifying.",
  },
] as const;

/** Look up a contract by id, or null when the id is unknown. */
export function hostContract(id: string): HostContract | null {
  return HOST_CONTRACTS.find((c) => c.id === id) ?? null;
}
