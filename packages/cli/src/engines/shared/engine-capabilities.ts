import { ENGINES } from "../../lib/config/schema.ts";

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
  | "markdown-ownership"
  | "handoff-shape"
  | "handoff-consumer"
  | "analytic-write-tools"
  | "local-skill-discovery";

/** The `navori.config.json` flag that turns a control's condition on, if any. */
export type ControlCondition = "planTiers" | "scribeOwnsMarkdown" | "localSkills";

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
  | { readonly kind: "local-skill-pointer" };

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
      "Validates a handoff (`navori handoff check`) before the orchestrator or scribe act on it.",
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

/** codex: no per-role `sandbox_mode` line for any of the four (all `sandbox:
 *  "workspace-write"` in roster.ts), so the effective mode is `.codex/
 *  config.toml`'s default (`build-config-toml.ts`). */
const CODEX_ANALYTIC_WRITE_TOOLS = sameForEveryRole(["sandbox:workspace-write"]);

/** Prose engines render no agents at all. */
const PROSE_ANALYTIC_WRITE_TOOLS = sameForEveryRole([]);

/**
 * The three prose engines (`agents-md`, `cursor`, `copilot`) share one render
 * path and, with it, an identical control table — same rationale as
 * `PROSE_ENGINE_UNSUPPORTED_SURFACES` above.
 */
const PROSE_CONTROLS: Readonly<Record<ControlId, ControlDeclaration>> = Object.freeze({
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
});

export const ENGINE_CAPABILITIES: Readonly<Record<EngineId, EngineCapabilities>> = Object.freeze({
  claude: {
    id: "claude",
    label: "Claude Code",
    ownsAgentsMd: false,
    unsupportedSurfaces: [],
    controls: {
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
          "`navori handoff check` is invoked by prose (orquestacion.md, scribe.md), not by a hook.",
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
    ],
    controls: {
      "plan-gate": {
        state: "advisory",
        reason:
          "The asset is rendered without registering a hook in .codex/config.toml " +
          "(build-config-toml.ts); the reviewer's own `classify` check verifies it after the fact.",
      },
      "markdown-ownership": {
        state: "advisory",
        reason:
          "The contract is stated in prose (implementer.md, via AGENTS.md); .codex/config.toml " +
          "registers no matching hook.",
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
          "`navori handoff check` is invoked by prose (orquestacion.md, scribe.md), not by a hook.",
      },
      "analytic-write-tools": {
        state: "advisory",
        reason:
          '`sandbox_mode = "workspace-write"` plus prose instructions; the sandbox itself allows ' +
          "writes broadly.",
      },
      "local-skill-discovery": {
        state: "enforced",
        reason: "The generated pointer at .agents/skills/<id>/SKILL.md (classifyLocalSkills).",
        evidence: { kind: "local-skill-pointer" },
      },
    },
    analyticWriteTools: CODEX_ANALYTIC_WRITE_TOOLS,
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
