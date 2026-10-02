import type { NavoriConfig } from "../../lib/config/config.ts";
import type { LoadedPlugin } from "../../lib/config/plugins.ts";
import { OVERLAP_ROWS, isNativeOn, type OverlapRow } from "../shared/native-overlap.ts";
import { pluginScriptCollisions } from "../shared/plugin-scripts.ts";
import { compareSemver } from "../../lib/primitives/semver.ts";

/**
 * Spec 0035 D1 — the single table that decides which Claude hook scripts
 * Codex registers, with what event/matcher, and which ones it can't. Replaces
 * the hand-written registration blocks `build-config-toml.ts` used to own
 * directly: every row here is either `registration` (Codex has an equivalent)
 * or `unsupported` (with the reason `ENGINE_CAPABILITIES.codex.
 * unsupportedSurfaces` names), never both, never neither — enforced by the
 * union type below.
 *
 * ORDER IS PART OF THE CONTRACT. Codex's `trusted_hash` approval key
 * (`event:groupIndex:handlerIndex`) is positional: the index of a
 * `[[hooks.<Event>]]` block is its position among the OTHER blocks of that
 * same event, in render order. The four rows already shipped
 * (`guard-destructive`, `comment-draft-confirm`, `quality-gate-pre-commit`,
 * `model-advisor`) MUST stay first, in this exact order, so a repo that
 * already approved them keeps `Trusted` after a re-render — see
 * `render-codex.test.ts`'s pinned-hash test. Every row added after them is a
 * NEW group that lands `Untrusted` until `navori codex trust` approves it,
 * never renumbers an existing one.
 */
export interface CodexHookRegistration {
  /** Codex TOML event name, e.g. "PreToolUse". */
  readonly event: string;
  /** Regex matcher Codex evaluates against the tool name, if any. */
  readonly matcher?: string;
  readonly timeout: number;
  readonly statusMessage?: string;
  /** Minimum Codex version this event/matcher pair is known to fire on. */
  readonly minVersion: string;
  /** Extra CLI argument appended after the script path. */
  readonly args?: string;
  /** Registered only when this returns true; always registered when absent. */
  readonly when?: (config: NavoriConfig) => boolean;
}

export interface CodexHookRow {
  /** Hook script id, without extension — matches `<id>.sh` on both engines. */
  readonly script: string;
  readonly registration?: CodexHookRegistration;
  /** Set when Codex has no usable equivalent; `registration` is absent. */
  readonly unsupported?: string;
}

export const CODEX_HOOK_REGISTRATIONS: readonly CodexHookRow[] = [
  // The four already-shipped registrations — order, matcher, timeout and
  // statusMessage must not move (see the module doc above).
  {
    script: "guard-destructive",
    registration: {
      event: "PreToolUse",
      matcher: "^Bash$",
      timeout: 30,
      statusMessage: "Checking destructive command policy",
      minVersion: "0.129.0",
    },
  },
  {
    script: "comment-draft-confirm",
    registration: {
      event: "PreToolUse",
      matcher: "^Bash$",
      timeout: 10,
      statusMessage: "Checking for an unconfirmed comment/review draft",
      minVersion: "0.129.0",
    },
  },
  {
    script: "quality-gate-pre-commit",
    registration: {
      event: "PreToolUse",
      matcher: "^Bash$",
      timeout: 600,
      statusMessage: "Running pre-commit quality gate",
      minVersion: "0.129.0",
      when: (config) => Boolean(config.qualityGate?.fast),
    },
  },
  {
    script: "model-advisor",
    registration: {
      event: "SessionStart",
      timeout: 10,
      statusMessage: "navori: model advisor",
      minVersion: "0.129.0",
      args: "codex-session-start",
    },
  },
  // Newly registered by spec 0035 Lote A — always AFTER the four above.
  {
    script: "session-start-context",
    registration: {
      event: "SessionStart",
      matcher: "startup|resume|clear|compact|fork",
      timeout: 15,
      statusMessage: "navori: session context",
      minVersion: "0.133.0",
    },
  },
  {
    script: "plan-gate",
    unsupported:
      "Codex 0.158.0 sends delegation through PreToolUse as collaborationspawn_agent. " +
      "A default spawn (message/task_name only) has no typed agent role; an explicit " +
      "agent_type spawn exposes the typed role in Pre (observed in T9 corrida 2), " +
      "recorded only as a reopening input for L06/T17. The workplan opening is still not " +
      "verifiably readable and a blanket deny prevented child creation, so this hook " +
      "stays advisory with no registration.",
  },
  {
    script: "implementer-no-markdown",
    registration: {
      event: "PreToolUse",
      matcher: "^(Bash|apply_patch)$",
      timeout: 10,
      statusMessage: "navori: implementer-no-markdown",
      minVersion: "0.134.0",
      when: (config) => Boolean(config.harness?.scribeOwnsMarkdown),
    },
  },
  {
    script: "managed-drift-watch",
    registration: {
      event: "PostToolUse",
      matcher: "^(Bash|apply_patch)$",
      timeout: 10,
      statusMessage: "navori: managed-block drift",
      minVersion: "0.129.0",
    },
  },
  {
    script: "routing-watch",
    registration: {
      event: "PostToolUse",
      matcher: "^(Bash|apply_patch|spawn_agent)$",
      timeout: 10,
      statusMessage: "navori: routing check",
      minVersion: "0.135.0",
    },
  },
  {
    script: "subagent-stop-handoff",
    registration: {
      event: "SubagentStop",
      args: "codex",
      timeout: 15,
      statusMessage: "navori: handoff check",
      minVersion: "0.133.0",
    },
  },
  {
    script: "audit-mode-trigger",
    registration: {
      event: "UserPromptSubmit",
      timeout: 10,
      statusMessage: "navori: audit-mode",
      minVersion: "0.129.0",
    },
  },
  {
    script: "audit-mode-close",
    registration: {
      event: "SessionEnd",
      timeout: 3,
      statusMessage: "navori: audit-mode close",
      minVersion: "0.145.0",
    },
  },
  {
    // D6: Codex caps SessionEnd at 3s, too tight for `git worktree` cleanup —
    // moved to the NEXT session's SessionStart(startup) instead.
    script: "worktree-reclaim",
    registration: {
      event: "SessionStart",
      matcher: "startup",
      timeout: 30,
      statusMessage: "navori: reclaim worktrees",
      minVersion: "0.133.0",
    },
  },
  {
    script: "stop-verify-reminder",
    registration: {
      event: "Stop",
      args: "codex",
      timeout: 15,
      statusMessage: "navori: verify-before-done",
      minVersion: "0.129.0",
      when: (config) => Boolean(config.hooks?.verifyOnStop),
    },
  },
  {
    // D4: Codex hooks can't emit `ask` — the confirmation moves to a
    // `.codex/rules/navori.rules` `prompt` rule instead (spec 0035 Lote C).
    script: "pr-publisher-confirm",
    unsupported:
      "Codex hooks cannot emit `ask` (permissionDecision is dropped and the call proceeds); " +
      "the confirmation moves to a `.codex/rules/navori.rules` prompt rule (D4, Lote C).",
  },
  {
    script: "subagent-no-background",
    unsupported:
      "Codex has no `Monitor` tool, and unified_exec strips background-execution fields " +
      "from the PreToolUse payload, so no hook can distinguish a backgrounded command (D1).",
  },
  {
    // Spec 0034 ships the master plan for Claude first; Codex is phase 2 (#1088).
    script: "master-accept-confirm",
    unsupported:
      "The master plan is Claude-only until its Codex phase (spec 0034, #1088); " +
      "Codex hooks also cannot emit the `ask` this confirmation needs (D4).",
  },
  {
    // Spec 0039 R40: Claude-only, like the other `ask` confirmations.
    script: "general-purpose-confirm",
    unsupported:
      "Codex hooks cannot emit `ask` (permissionDecision is dropped and the call proceeds), " +
      "and Codex has no typed `general-purpose` subagent to confirm (spec 0039 R40).",
  },
  {
    script: "master-plan-context",
    unsupported:
      "The master plan is Claude-only until its Codex phase (spec 0034, #1088), " +
      "so Codex renders no master-plan skill for this context to point at.",
  },
];

/** One Codex hook ready to serialize into `.codex/config.toml`. */
export interface ResolvedCodexHook {
  readonly script: string;
  readonly event: string;
  readonly matcher?: string;
  readonly timeout: number;
  readonly statusMessage?: string;
  readonly args?: string;
  readonly pluginId?: string;
  readonly pluginHookOrdinal?: number;
  readonly scriptPath?: string;
}

/** Escape literal path bytes inside the double-quoted Bash command. */
function bashDoubleQuotedLiteral(value: string): string {
  return value.replace(/[\\"$`]/g, "\\$&");
}

/**
 * The bash command `.codex/config.toml` registers for `hook`. Single source
 * for the render (`buildCodexConfigToml`) and for trust (`codexHookHash`):
 * Codex hashes this exact string, so any divergence would leave every hook
 * `Modified` right after approval. `wsSubpath` is "" at the repo root and a
 * POSIX subpath (e.g. "apps/backend") in a workspace, because
 * `git rev-parse --show-toplevel` always resolves to the root (#279).
 */
export function codexHookCommand(hook: ResolvedCodexHook, wsSubpath = ""): string {
  const suffix = `${wsSubpath ? `/${wsSubpath}` : ""}/${hook.scriptPath ?? `.codex/hooks/${hook.script}.sh`}`;
  return `bash "$(git rev-parse --show-toplevel)${bashDoubleQuotedLiteral(suffix)}"${hook.args ? ` ${hook.args}` : ""}`;
}

/** Exact, fail-closed translation of the bundled plugin hook grammar. */
export function resolvePluginCodexHooks(plugins: readonly LoadedPlugin[]): {
  hooks: ResolvedCodexHook[];
  warnings: string[];
} {
  const hooks: ResolvedCodexHook[] = [];
  const warnings: string[] = [];
  const collisions = pluginScriptCollisions(plugins);
  for (const dest of collisions)
    warnings.push(
      `Destino .codex/scripts/${dest} declarado varias veces; scripts y hooks omitidos.`,
    );
  for (const plugin of [...plugins].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))) {
    for (const [ordinal, hook] of (plugin.manifest.hooks ?? []).entries()) {
      const match = /^bash "\$CLAUDE_PROJECT_DIR\/\.claude\/scripts\/([^"\n]+)"$/.exec(
        hook.command,
      );
      const dest = match?.[1];
      const script = plugin.scriptAssets.find((item) => item.dest === dest);
      if (
        hook.event !== "PreToolUse" ||
        hook.matcher !== "Bash" ||
        !script ||
        collisions.has(script.dest)
      ) {
        warnings.push(
          `Plugin '${plugin.manifest.id}' hook ${ordinal}: forma no traducible para Codex; registro omitido.`,
        );
        continue;
      }
      hooks.push({
        script: script.dest,
        scriptPath: `.codex/scripts/${script.dest}`,
        pluginId: plugin.manifest.id,
        pluginHookOrdinal: ordinal,
        event: "PreToolUse",
        matcher: "^Bash$",
        timeout: hook.timeout ?? 600,
        statusMessage: hook.statusMessage,
      });
    }
  }
  return { hooks, warnings };
}

/**
 * The Codex hook groups to register for `config`, in stable render order
 * (table order — see the module doc's ordering contract).
 */
export function resolveCodexHooks(
  config: NavoriConfig,
  plugins: readonly LoadedPlugin[] = [],
  overlapRows: readonly OverlapRow[] = OVERLAP_ROWS,
): ResolvedCodexHook[] {
  const resolved: ResolvedCodexHook[] = [];
  // Spec 0039 D1: same predicate `filterInventory` uses, so a hook (or plugin)
  // the matrix marks native on Codex is neither written nor registered.
  const livePlugins = plugins.filter(
    (plugin) => !isNativeOn("codex", "plugin", plugin.manifest.id, overlapRows),
  );
  for (const row of CODEX_HOOK_REGISTRATIONS) {
    if (!row.registration) continue;
    if (isNativeOn("codex", "hook", row.script, overlapRows)) continue;
    if (row.registration.when && !row.registration.when(config)) continue;
    const { when: _when, minVersion: _minVersion, ...rest } = row.registration;
    resolved.push({ script: row.script, ...rest });
  }
  return [...resolved, ...resolvePluginCodexHooks(livePlugins).hooks];
}

/**
 * Minimum Codex version required by the registration table (R18) — the max
 * `minVersion` across every row Codex actually registers (unsupported rows
 * don't count; they're never written to `.codex/config.toml`). Static: a
 * feature toggle being off doesn't lower the floor a rendered `config.toml`
 * with that toggle later ON would need, so this deliberately ignores `when`.
 */
export function minCodexVersion(): string {
  let max = "0.0.0";
  for (const row of CODEX_HOOK_REGISTRATIONS) {
    if (!row.registration) continue;
    if ((compareSemver(row.registration.minVersion, max) ?? 0) > 0) {
      max = row.registration.minVersion;
    }
  }
  return max;
}
