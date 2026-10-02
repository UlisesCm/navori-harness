import { ENGINES } from "../../lib/config/schema.ts";
import { CODEX_HOOK_REGISTRATIONS } from "../codex/hook-registrations.ts";

/** A valid engine id — the same union `NavoriConfigSchema.engines` accepts. */
export type EngineId = (typeof ENGINES)[number];

/**
 * One documented gap between an engine's render and full Claude parity. The
 * `reason` is required BY THE TYPE (not by convention): an object literal
 * missing it fails to compile, so a surface can never be listed without
 * saying why it's missing.
 */
export interface UnsupportedSurface {
  /** Short id of what the engine does not render, e.g. "defensive-hooks". */
  readonly surface: string;
  /** Why this engine can't or doesn't render that surface. */
  readonly reason: string;
}

/**
 * Spec 0033 D5 (R20–R23): the harness controls this registry declares, one
 * union closed over every control at least one engine enforces or could. A
 * new control not added here has no home to be declared in for any engine.
 */
export type ControlId =
  | "plan-gate"
  | "master-plan"
  | "markdown-ownership"
  | "handoff-shape"
  | "handoff-consumer"
  | "analytic-write-tools"
  | "local-skill-discovery"
  | "acceptance-evidence"
  | "compact-advice"
  | "general-purpose-confirm";

/** The `navori.config.json` flag that turns a control's condition on, if any. */
export type ControlCondition = "planTiers" | "masterPlan" | "scribeOwnsMarkdown" | "localSkills";

/**
 * What `control-inventory.test.ts` (R22) reads off the actual render to
 * confirm a declared state. Each kind names exactly what "the control fired"
 * looks like on disk, so the test never has to guess.
 */
export type RenderEvidence =
  | {
      readonly kind: "hook";
      readonly script: string;
      readonly event: string;
      readonly matcher: string;
    }
  | { readonly kind: "native-skill-root" }
  | { readonly kind: "local-skill-pointer" }
  | { readonly kind: "extension-tool"; readonly path: string; readonly tool: string };

/**
 * One control's declared state for one engine. `enforced` requires `evidence`
 * BY THE TYPE — an object literal with `state: "enforced"` and no `evidence`
 * fails to compile, the same mechanism `UnsupportedSurface.reason` already
 * uses for a required field (R20).
 */
export type ControlDeclaration =
  | { readonly state: "enforced"; readonly reason: string; readonly evidence: RenderEvidence }
  | { readonly state: "advisory"; readonly reason: string; readonly evidence?: RenderEvidence }
  | { readonly state: "unsupported"; readonly reason: string };

/** Static description of a control, independent of any one engine. */
export interface ControlDefinition {
  readonly description: string;
  /** Flag that gates whether the control is currently relevant. Absent means
   *  the control always applies, regardless of config. */
  readonly condition?: ControlCondition;
  /** Hook script basenames (under `.claude/hooks/` or `.codex/hooks/`) this
   *  control's `enforced`/`advisory` evidence can point to. Empty when the
   *  control's evidence is never a hook (e.g. `local-skill-discovery`). */
  readonly hookScripts: readonly string[];
}

/**
 * The single, engine-independent description of each control (R20). Per-
 * engine state lives in `ENGINE_CAPABILITIES[engine].controls`, below.
 */
export const CONTROL_DEFINITIONS: Readonly<Record<ControlId, ControlDefinition>> = Object.freeze({
  "plan-gate": {
    description: "Blocks dispatching a subagent whose task isn't covered by the workplan.",
    condition: "planTiers",
    hookScripts: ["plan-gate.sh"],
  },
  "master-plan": {
    description: "Injects master-plan context when a Claude Code session starts.",
    condition: "masterPlan",
    hookScripts: ["master-plan-context.sh"],
  },
  "markdown-ownership": {
    description: "Blocks the implementer from writing Markdown when the scribe owns it.",
    condition: "scribeOwnsMarkdown",
    hookScripts: ["implementer-no-markdown.sh"],
  },
  "handoff-shape": {
    description: "Flags an `impl_<feature>.json` missing a required key at subagent stop.",
    hookScripts: ["subagent-stop-handoff.sh"],
  },
  "handoff-consumer": {
    description:
      "Validates an existing implementation handoff before dispatching its scribe or reviewer consumer.",
    hookScripts: [],
  },
  "analytic-write-tools": {
    description:
      "Declares the write-capable tools/sandbox the analytic roles (auditor, scout, reviewer, architect) get.",
    hookScripts: [],
  },
  "local-skill-discovery": {
    description: "Makes a `project.localSkills` id discoverable by this engine's host.",
    condition: "localSkills",
    hookScripts: [],
  },
  "acceptance-evidence": {
    description:
      "Requires recorded host evidence of a criterion's run before `navori plan update` accepts `cumplido`.",
    hookScripts: [],
  },
  "compact-advice": {
    description:
      "Advises saving the session summary and using /compact or /clear when the main thread's context passes `harness.compactAdviceTokens` after a publisher dispatch.",
    hookScripts: [],
  },
  "general-purpose-confirm": {
    description:
      "Asks for confirmation before dispatching `general-purpose`, naming the scout as the read-only alternative.",
    hookScripts: ["general-purpose-confirm.sh"],
  },
});

/** The four analytic roles R23 requires visibility into, across every engine. */
export type AnalyticRole = "auditor" | "scout" | "reviewer" | "architect";

/**
 * Claude tools whose presence in an agent's `tools:` frontmatter lets it
 * write. Order matches the literal set D5 names in `design.md` — filtering an
 * agent's own `tools:` list against this (in the AGENT's order, not this
 * one's) is what `analyticWriteTools.claude` below and `control-inventory.
 * test.ts` both compute (R23).
 */
export const WRITE_CAPABLE_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Bash",
]);

/** Frozen capability record for one engine. */
export interface EngineCapabilities {
  readonly id: EngineId;
  readonly label: string;
  /**
   * Whether this engine is the one that owns writing `AGENTS.md` at the repo
   * root. Only one engine may own it at a time — `render.ts` uses this to
   * skip a redundant `agents-md` render when `codex` is also configured
   * (see `packages/cli/src/commands/render.ts`, `renderNonClaudeEngines`).
   */
  readonly ownsAgentsMd: boolean;
  /**
   * Surfaces this engine does not materialize, each with why. An engine with
   * full parity (today, only `claude`) declares `[]` explicitly rather than
   * omitting the field, so "no gaps" is a stated fact, not an oversight.
   */
  readonly unsupportedSurfaces: readonly UnsupportedSurface[];
  /**
   * This engine's declared state for every `ControlId` (R20). A `Record` over
   * the closed union means forgetting a control for an engine is a compile
   * error, the same guarantee `unsupportedSurfaces.reason` gives per-entry.
   */
  readonly controls: Readonly<Record<ControlId, ControlDeclaration>>;
  /**
   * Effective write-capable tools/sandbox per analytic role, as this engine
   * actually renders them (R23). `[]` for engines that render no agents at
   * all (the prose engines). This spec only declares them — F08 (reducing
   * privileges) is explicitly out of scope.
   */
  readonly analyticWriteTools: Readonly<Record<AnalyticRole, readonly string[]>>;
}

/**
 * Frozen, per-engine capability registry (#821). Single place that declares
 * what each engine does NOT render and why — before this, that knowledge was
 * scattered across comments (`engines/codex/compat.ts`, `engines/shared/
 * prose-harness.ts`) and a test-only diff set (`engine-parity.test.ts`'s
 * `AGENT_KNOWN_DIFFS`), never a queryable object.
 *
 * `validateEngineCapabilities` (called once below, at module load) throws if
 * this registry and `ENGINES` (`lib/schema.ts`) ever diverge — a new engine
 * added to one without the other fails at import time, not silently at
 * runtime months later.
 *
 * Content is deliberately narrow: only `ownsAgentsMd` and
 * `unsupportedSurfaces`, the two axes with a real consumer today.
 * `guidedReady` (an ECC-inspired "safe for a guided wizard" flag) was scoped
 * out of #821 — navori's `init`/`configure` present all five engines in one
 * flat multiselect, with no guided/advanced distinction to gate on. Adding
 * that axis now would be data with no reader.
 */
/**
 * `agents-md`, `cursor` and `copilot` are the three "prose" engines: they
 * share one render path (`engines/shared/prose-harness.ts`) that projects the
 * same harness context into a single managed markdown file, dropping the
 * SAME Claude-only concerns (documented in that file's module comment). The
 * gap list is genuinely identical across the three — factored out once so it
 * isn't three copies to keep in sync.
 */
const PROSE_ENGINE_UNSUPPORTED_SURFACES: readonly UnsupportedSurface[] = [
  {
    surface: "per-agent-model",
    reason:
      "Claude-only concern dropped for every prose target (engines/shared/prose-harness.ts): " +
      "config.models.* has no equivalent in a single prose file.",
  },
  {
    surface: "defensive-hooks",
    reason:
      "Prose engines render no hooks at all; the defensive/quality-gate hooks are " +
      "Claude Code infrastructure the prose format can't express (engines/shared/prose-harness.ts).",
  },
  {
    surface: "permission-rules",
    reason:
      "settings.json permission rules have no prose equivalent (engines/shared/prose-harness.ts).",
  },
  {
    surface: "subagent-orchestration",
    reason:
      "The subagent orchestration block assumes Claude Code's Task tool, unavailable " +
      "to prose engines (engines/shared/prose-harness.ts).",
  },
  {
    surface: "plugin-blocks",
    reason:
      "Plugin blocks (e.g. engram) assume Claude Code infrastructure the prose " +
      "targets don't have, so they're skipped (engines/shared/prose-harness.ts).",
  },
];

/**
 * Spec 0035 D1 — `CODEX_HOOK_REGISTRATIONS` is the single source for which
 * Claude hooks Codex has no usable equivalent for. Derived, not hand-copied,
 * so the reason string in `ENGINE_CAPABILITIES.codex.unsupportedSurfaces`
 * never drifts from the one `engine-parity.test.ts` checks against the table.
 */
const CODEX_HOOK_UNSUPPORTED_SURFACES: readonly UnsupportedSurface[] =
  CODEX_HOOK_REGISTRATIONS.filter((row) => typeof row.unsupported === "string").map((row) => ({
    surface: row.script,
    reason: row.unsupported as string,
  }));

/**
 * Every analytic role declares the same `tools:`/sandbox today, so one shared
 * record covers all four — same rationale as `PROSE_ENGINE_UNSUPPORTED_
 * SURFACES` above. Literal values, not derived from the asset files: this
 * registry is the declaration `control-inventory.test.ts` (R22/R23) checks
 * against the actual render, so it must not read the thing it's verifying.
 */
const ANALYTIC_ROLES: readonly AnalyticRole[] = ["auditor", "scout", "reviewer", "architect"];

function sameForEveryRole(
  tools: readonly string[],
): Readonly<Record<AnalyticRole, readonly string[]>> {
  return Object.freeze(
    Object.fromEntries(ANALYTIC_ROLES.map((role) => [role, tools])) as Record<
      AnalyticRole,
      readonly string[]
    >,
  );
}

/** claude: `Read, Glob, Grep, Bash, Write[, …]` for all four roles today —
 *  intersected with `WRITE_CAPABLE_TOOLS`, in the AGENT's own tools: order. */
const CLAUDE_ANALYTIC_WRITE_TOOLS = sameForEveryRole(["Bash", "Write"]);

/** codex: no per-role `sandbox_mode` line for any of the four (roster's
 *  `workspace-write` is omitted by the renderer), so the effective mode is
 *  `.codex/config.toml`'s default (`build-config-toml.ts`). */
const CODEX_ANALYTIC_WRITE_TOOLS = sameForEveryRole(["sandbox:danger-full-access"]);

/** Prose engines render no agents at all. */
const PROSE_ANALYTIC_WRITE_TOOLS = sameForEveryRole([]);

/**
 * The three prose engines (`agents-md`, `cursor`, `copilot`) share one render
 * path and, with it, an identical control table — same rationale as
 * `PROSE_ENGINE_UNSUPPORTED_SURFACES` above.
 */
const PROSE_CONTROLS: Readonly<Record<ControlId, ControlDeclaration>> = Object.freeze({
  "master-plan": {
    state: "unsupported",
    reason: "fase 2 de la spec 0034: la skill no se renderiza y no hay hook de arranque",
  },
  "plan-gate": {
    state: "unsupported",
    reason:
      "Prose engines render no Task/Agent tool to intercept a subagent dispatch " +
      "(unsupportedSurfaces: subagent-orchestration).",
  },
  "markdown-ownership": {
    state: "unsupported",
    reason: "Prose engines render no hooks at all (unsupportedSurfaces: defensive-hooks).",
  },
  "handoff-shape": {
    state: "unsupported",
    reason: "Prose engines render no hooks at all (unsupportedSurfaces: defensive-hooks).",
  },
  "handoff-consumer": {
    state: "unsupported",
    reason:
      "No orchestrator or scribe agent is rendered to invoke `navori handoff check` " +
      "(unsupportedSurfaces: subagent-orchestration).",
  },
  "analytic-write-tools": {
    state: "unsupported",
    reason: "No agents are rendered at all for these engines.",
  },
  "local-skill-discovery": {
    // Spec 0033 challenge finding (T11): design.md D5 describes an advisory
    // row in the prose skill index, but `buildSkillsSection` (prose-harness.ts)
    // calls `buildSkillRows` WITHOUT the `localSkills` argument, so a
    // `project.localSkills` id never reaches these three engines' rendered
    // file at all today. Declaring the actual render, not the design intent
    // (control-inventory.test.ts asserts this against the render) — reported
    // to the orchestrator as a design/render discrepancy, not fixed here.
    state: "unsupported",
    reason:
      "buildSkillsSection (prose-harness.ts) never passes project.localSkills to " +
      "buildSkillRows, so the id never reaches the rendered file.",
  },
  "acceptance-evidence": {
    state: "unsupported",
    reason: "Prose engines render no hooks, so no Bash run is ever recorded as evidence.",
  },
  "compact-advice": {
    state: "unsupported",
    reason: "Prose engines render no hooks, so no context-size advice is ever injected.",
  },
  "general-purpose-confirm": {
    state: "unsupported",
    reason: "Prose engines render no hooks (unsupportedSurfaces: defensive-hooks).",
  },
});

export const ENGINE_CAPABILITIES: Readonly<Record<EngineId, EngineCapabilities>> = Object.freeze({
  claude: {
    id: "claude",
    label: "Claude Code",
    ownsAgentsMd: false,
    unsupportedSurfaces: [],
    controls: {
      "master-plan": {
        state: "enforced",
        reason: "harness.masterPlan registers the SessionStart hook (build-settings.ts).",
        evidence: {
          kind: "hook",
          script: "master-plan-context.sh",
          event: "SessionStart",
          matcher: "startup|resume|clear|compact|fork",
        },
      },
      "plan-gate": {
        state: "enforced",
        reason: "harness.planTiers registers the PreToolUse(Agent) hook (build-settings.ts).",
        evidence: { kind: "hook", script: "plan-gate.sh", event: "PreToolUse", matcher: "Agent" },
      },
      "markdown-ownership": {
        state: "enforced",
        reason:
          "harness.scribeOwnsMarkdown registers the PreToolUse(Bash|Edit|Write|NotebookEdit) " +
          "hook (build-settings.ts).",
        evidence: {
          kind: "hook",
          script: "implementer-no-markdown.sh",
          event: "PreToolUse",
          matcher: "Bash|Edit|Write|NotebookEdit",
        },
      },
      "handoff-shape": {
        state: "advisory",
        reason:
          "The PostToolUse(Agent|Task) hook is registered unconditionally, but it never blocks " +
          "(spec 0033 D3): advisory by design.",
        evidence: {
          kind: "hook",
          script: "subagent-stop-handoff.sh",
          event: "PostToolUse",
          matcher: "Agent|Task",
        },
      },
      "handoff-consumer": {
        state: "advisory",
        reason:
          "Orchestration prose calls `navori handoff check` before scribe/reviewer consume an existing impl handoff; no hook enforces it.",
      },
      "analytic-write-tools": {
        state: "advisory",
        reason:
          "The `tools:` frontmatter and prose instructions declare the role's scope; nothing " +
          "blocks a Bash write outside them.",
      },
      "local-skill-discovery": {
        state: "enforced",
        reason: "`.claude/skills/<id>/` is Claude Code's native skill root.",
        evidence: { kind: "native-skill-root" },
      },
      "acceptance-evidence": {
        state: "advisory",
        reason:
          "`plan update` requires recorded evidence inside a Claude Code child session " +
          "(CLAUDE_CODE_CHILD_SESSION=1); an agent can still bypass it (spec 0039 D5). " +
          "The recording hook ships separately.",
      },
      "compact-advice": {
        state: "advisory",
        reason:
          "subagent-stop-handoff.sh adds a once-per-session note after a publisher dispatch when " +
          "the main thread's last transcript usage passes harness.compactAdviceTokens (spec 0039 R44); " +
          "it advises, never blocks.",
        evidence: {
          kind: "hook",
          script: "subagent-stop-handoff.sh",
          event: "PostToolUse",
          matcher: "Agent|Task",
        },
      },
      "general-purpose-confirm": {
        state: "enforced",
        reason:
          "The PreToolUse(Agent) hook (no `if`: `Agent(<name>)` doesn't match by name in 2.1.287, " +
          "the script filters subagent_type) is registered while the scout is enabled " +
          "(build-settings.ts); it asks, it never blocks (spec 0039 R40).",
        evidence: {
          kind: "hook",
          script: "general-purpose-confirm.sh",
          event: "PreToolUse",
          matcher: "Agent",
        },
      },
    },
    analyticWriteTools: CLAUDE_ANALYTIC_WRITE_TOOLS,
  },
  codex: {
    id: "codex",
    label: "Codex",
    ownsAgentsMd: true,
    unsupportedSurfaces: [
      {
        surface: "orchestrator-agent",
        reason:
          "The Codex engine deliberately emits no spawnable orchestrator agent — the main " +
          "Codex thread embodies the orchestrator role instead (engines/__tests__/engine-parity.test.ts, " +
          "AGENT_KNOWN_DIFFS; engines/shared/harness-plan.ts, resolveHarnessPlan's includeOrchestrator).",
      },
      {
        surface: "engine-scripts",
        reason:
          "Only the Claude engine copies plugin scripts to disk (engines/claude/index.ts " +
          "writes .claude/scripts/); nothing under engines/codex/ emits a .codex/scripts/ " +
          "mirror (engines/codex/compat.ts, CODEX_MIRRORED_DIRS).",
      },
      {
        surface: "plugin-hook-extensions",
        reason:
          "A plugin's hookExtensions sub-block (spec 0039 D6, the tgrep search lane) is injected " +
          "only into the Claude `.claude/hooks/*.sh` mirror (engines/claude/index.ts, " +
          "applyHookExtension); the Codex hook copies carry none.",
      },
      ...CODEX_HOOK_UNSUPPORTED_SURFACES,
    ],
    controls: {
      "master-plan": {
        state: "unsupported",
        reason: "fase 2 de la spec 0034: la skill no se renderiza y no hay hook de arranque",
      },
      "plan-gate": {
        state: "advisory",
        reason:
          "The workplan procedure remains in AGENTS.md, but plan-gate.sh is not " +
          "registered: Codex 0.158.0 sends collaborationspawn_agent through PreToolUse " +
          "with message/task_name but no typed agent role or verifiably readable workplan " +
          "opening. A blanket deny blocked child creation, not selective implementer gating.",
      },
      "markdown-ownership": {
        state: "enforced",
        reason:
          "harness.scribeOwnsMarkdown registers PreToolUse(^(Bash|apply_patch)$) via " +
          "CODEX_HOOK_REGISTRATIONS (hook-registrations.ts, build-config-toml.ts) — spec 0035 " +
          "supersedes spec 0033 D5 for Codex.",
        evidence: {
          kind: "hook",
          script: "implementer-no-markdown.sh",
          event: "PreToolUse",
          matcher: "^(Bash|apply_patch)$",
        },
      },
      "handoff-shape": {
        state: "advisory",
        reason:
          "The contract is stated in prose (scribe.md, via AGENTS.md); .codex/config.toml " +
          "registers no matching hook.",
      },
      "handoff-consumer": {
        state: "advisory",
        reason:
          "Orchestration prose calls `navori handoff check` before scribe/reviewer consume an existing impl handoff; no hook enforces it.",
      },
      "analytic-write-tools": {
        state: "advisory",
        reason:
          '`sandbox_mode = "danger-full-access"` plus prose instructions; no filesystem/network ' +
          "sandbox restricts writes, so the role boundary is advisory.",
      },
      "local-skill-discovery": {
        state: "enforced",
        reason: "The generated pointer at .agents/skills/<id>/SKILL.md (classifyLocalSkills).",
        evidence: { kind: "local-skill-pointer" },
      },
      "acceptance-evidence": {
        state: "unsupported",
        reason:
          "No verifiable Bash success signal: PostToolUse fires on exit != 0 too, so `plan update` " +
          "accepts cumplido as unevidenced (spec 0039 R10).",
      },
      "compact-advice": {
        state: "unsupported",
        reason:
          "Codex SubagentStop has no PostToolUse context channel and its transcript is not the " +
          "Claude usage format, so the lane is Claude-only (spec 0039 R44).",
      },
      "general-purpose-confirm": {
        state: "unsupported",
        reason:
          "Codex hooks cannot emit `ask` and it has no typed `general-purpose` subagent; " +
          "general-purpose-confirm is an unsupported row in CODEX_HOOK_REGISTRATIONS (spec 0039 R40).",
      },
    },
    analyticWriteTools: CODEX_ANALYTIC_WRITE_TOOLS,
  },
  pi: {
    id: "pi",
    label: "Pi Coding Agent",
    ownsAgentsMd: false,
    unsupportedSurfaces: [
      {
        surface: "claude-hook-parity",
        reason:
          "Pi does not run Claude/Codex hook scripts; only mapped project-extension controls apply.",
      },
      {
        surface: "additional-analytic-roles",
        reason: "Pi project extension currently supports scout, implementer, and reviewer only.",
      },
    ],
    controls: {
      "plan-gate": {
        state: "enforced",
        reason:
          "When harness.planTiers is on, the trusted Pi project extension gates only navori_subagent implementer calls; direct Pi shell/tool calls bypass it.",
        evidence: {
          kind: "extension-tool",
          path: ".pi/extensions/navori.ts",
          tool: "navori_subagent",
        },
      },
      "master-plan": {
        state: "advisory",
        reason:
          "When harness.masterPlan is on, Pi before_agent_start appends a bounded status line; this is context, not a permission boundary.",
      },
      "markdown-ownership": {
        state: "advisory",
        reason:
          "When harness.scribeOwnsMarkdown is on, Pi blocks direct edit/write Markdown in implementer children; bash and ambient process writes bypass it.",
      },
      "handoff-shape": {
        state: "unsupported",
        reason:
          "Pi has no persisted impl handoff stop validator; child result does not prove the canonical file exists.",
      },
      "handoff-consumer": {
        state: "enforced",
        reason:
          "The trusted Pi project extension checks explicit-feature reviewer navori_subagent calls only; direct shell/tool calls bypass it.",
        evidence: {
          kind: "extension-tool",
          path: ".pi/extensions/navori.ts",
          tool: "navori_subagent",
        },
      },
      "analytic-write-tools": {
        state: "advisory",
        reason:
          "Pi role tool allowlists are model-visible capabilities, not OS/filesystem/network sandboxes; scout and reviewer retain write.",
      },
      "local-skill-discovery": {
        state: "unsupported",
        reason:
          "Pi reads trusted .agents/skills natively, but the Pi renderer does not yet project project.localSkills from .claude/skills into that root.",
      },
      "acceptance-evidence": {
        state: "unsupported",
        reason:
          "Pi does not record verifiable child Bash results for acceptance criteria, so plan update cannot require host evidence before cumplido.",
      },
      "compact-advice": {
        state: "unsupported",
        reason:
          "Pi runs no navori hook scripts, so no context-size advice is injected after a publisher dispatch.",
      },
      "general-purpose-confirm": {
        state: "unsupported",
        reason:
          "Pi runs no Claude hook scripts and its navori_subagent roster has no general-purpose role to confirm.",
      },
    },
    analyticWriteTools: {
      auditor: [],
      scout: ["write"],
      reviewer: ["bash", "write"],
      architect: [],
    },
  },
  "agents-md": {
    id: "agents-md",
    label: "AGENTS.md",
    ownsAgentsMd: true,
    unsupportedSurfaces: PROSE_ENGINE_UNSUPPORTED_SURFACES,
    controls: PROSE_CONTROLS,
    analyticWriteTools: PROSE_ANALYTIC_WRITE_TOOLS,
  },
  cursor: {
    id: "cursor",
    label: "Cursor",
    ownsAgentsMd: false,
    unsupportedSurfaces: PROSE_ENGINE_UNSUPPORTED_SURFACES,
    controls: PROSE_CONTROLS,
    analyticWriteTools: PROSE_ANALYTIC_WRITE_TOOLS,
  },
  copilot: {
    id: "copilot",
    label: "GitHub Copilot",
    ownsAgentsMd: false,
    unsupportedSurfaces: PROSE_ENGINE_UNSUPPORTED_SURFACES,
    controls: PROSE_CONTROLS,
    analyticWriteTools: PROSE_ANALYTIC_WRITE_TOOLS,
  },
});

/**
 * Throws if `ENGINE_CAPABILITIES` and `ENGINES` (`lib/schema.ts`) diverge in
 * either direction: an engine missing a registry entry, or a registry entry
 * for an id `ENGINES` no longer recognizes. Called once at module load below
 * so a divergence fails at import time — never silently at runtime.
 */
export function validateEngineCapabilities(
  registry: Readonly<Record<string, EngineCapabilities>>,
  engines: readonly string[],
): void {
  const registryIds = Object.keys(registry);
  const missingFromRegistry = engines.filter((e) => !registryIds.includes(e));
  const unknownInRegistry = registryIds.filter((id) => !engines.includes(id));
  if (missingFromRegistry.length > 0 || unknownInRegistry.length > 0) {
    const problems: string[] = [];
    if (missingFromRegistry.length > 0) {
      problems.push(`ENGINES has no registry entry for: ${missingFromRegistry.join(", ")}`);
    }
    if (unknownInRegistry.length > 0) {
      problems.push(
        `registry has an entry for an engine ENGINES doesn't recognize: ${unknownInRegistry.join(", ")}`,
      );
    }
    throw new Error(
      `engine-capabilities.ts: ENGINE_CAPABILITIES and ENGINES (lib/schema.ts) diverge — ${problems.join("; ")}`,
    );
  }
}

validateEngineCapabilities(ENGINE_CAPABILITIES, ENGINES);
