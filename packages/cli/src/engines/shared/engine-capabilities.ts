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

export const ENGINE_CAPABILITIES: Readonly<Record<EngineId, EngineCapabilities>> = Object.freeze({
  claude: {
    id: "claude",
    label: "Claude Code",
    ownsAgentsMd: false,
    unsupportedSurfaces: [],
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
  },
  "agents-md": {
    id: "agents-md",
    label: "AGENTS.md",
    ownsAgentsMd: true,
    unsupportedSurfaces: PROSE_ENGINE_UNSUPPORTED_SURFACES,
  },
  cursor: {
    id: "cursor",
    label: "Cursor",
    ownsAgentsMd: false,
    unsupportedSurfaces: PROSE_ENGINE_UNSUPPORTED_SURFACES,
  },
  copilot: {
    id: "copilot",
    label: "GitHub Copilot",
    ownsAgentsMd: false,
    unsupportedSurfaces: PROSE_ENGINE_UNSUPPORTED_SURFACES,
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
