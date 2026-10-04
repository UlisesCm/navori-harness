import type { NavoriConfig } from "../../lib/config/config.ts";
import type { LoadedPlugin } from "../../lib/config/plugins.ts";
import { minCodexVersion as minVerifiedCodexVersion } from "../shared/codex-parity.ts";
import { OVERLAP_ROWS, isNativeOn, type OverlapRow } from "../shared/native-overlap.ts";
import { pluginScriptCollisions } from "../shared/plugin-scripts.ts";
import { compareSemver } from "../../lib/primitives/semver.ts";

/**
 * Spec 0035 D1 — the single table that decides which Claude hook scripts
 * Codex registers, with what event/matcher, and which ones it can't. Replaces
 * the hand-written registration blocks `build-config-toml.ts` used to own
 * directly: every row here either carries a `registration` (Codex has an
 * equivalent) or has none, and then its `hook:<script>` row in `CODEX_PARITY`
 * is `limite-codex` with the reason `ENGINE_CAPABILITIES.codex.
 * unsupportedSurfaces` names — `native-overlap.test.ts` keeps the two in step.
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
  /**
   * Emitted AFTER the plugin hook groups (spec 0041 D8). Plugin hooks are
   * PreToolUse groups numbered by position, so a core row that lands between
   * the core rows and the plugin ones would renumber every already-approved
   * plugin hook and silently un-trust it. A late row is a new group at the tail.
   */
  readonly late?: true;
}

export interface CodexHookRow {
  /** Hook script id, without extension — matches `<id>.sh` on both engines. */
  readonly script: string;
  readonly registration?: CodexHookRegistration;
  /**
   * Absent when Codex has no usable equivalent. Why not lives in the hook's
   * `limite-codex` row of `CODEX_PARITY`, not here: one reason, one place.
   */
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
    script: "bash-outcome-watch",
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
    script: "subagent-no-background",
  },
  {
    // Spec 0041 D11: Codex hooks cannot emit `ask`, so the Codex copy of the
    // script denies instead (deny-as-confirmation, like `comment-draft-confirm`),
    // decided by `$0` inside the script. Never `ask`, never an allow.
    script: "master-accept-confirm",
    registration: {
      event: "PreToolUse",
      matcher: "^Bash$",
      timeout: 10,
      statusMessage: "navori: master acceptance confirmation",
      minVersion: "0.129.0",
      when: (config) => Boolean(config.harness?.masterPlan),
      late: true,
    },
  },
  {
    // Spec 0041 R21: same SessionStart channel `session-start-context` uses.
    script: "master-plan-context",
    registration: {
      event: "SessionStart",
      matcher: "startup|resume|clear|compact|fork",
      timeout: 10,
      statusMessage: "navori: master-plan context",
      minVersion: "0.133.0",
      when: (config) => Boolean(config.harness?.masterPlan),
      late: true,
    },
  },
  {
    // Spec 0041 D5/D13, R6/R17: Codex-only (`HOOK_ENGINES`). One group, two
    // branches: `apply_patch` role containment and the subagent spawn deny. Late
    // and unconditional, and placed before the conditional `plan-gate`: the master-plan groups before it
    // are already published (#1187), so none of their indexes may shift. The `spawn_agent$` alternative is unanchored
    // on purpose: V2 flattens the namespace into the tool name.
    script: "role-guard",
    registration: {
      event: "PreToolUse",
      matcher: "^apply_patch$|spawn_agent$",
      timeout: 10,
      statusMessage: "navori: role-guard",
      minVersion: "0.134.0",
      late: true,
    },
  },
  {
    // Spec 0041 R10: a `prompt` rule does not confirm inside subagents (probe
    // V1), so the publisher's `gh pr create` is confirmed by deny-as-confirmation
    // (`case "$0"` inside the script). Never `ask`, never an approving handler.
    script: "pr-publisher-confirm",
    registration: {
      event: "PreToolUse",
      matcher: "^Bash$",
      timeout: 10,
      statusMessage: "navori: pr-publisher-confirm",
      minVersion: "0.129.0",
      late: true,
    },
  },
  {
    // Spec 0041 R10: same deny-as-confirmation. `spawn_agent$` is unanchored (V2
    // flattens the namespace into the tool name).
    script: "general-purpose-confirm",
    registration: {
      event: "PreToolUse",
      matcher: "spawn_agent$",
      timeout: 10,
      statusMessage: "navori: general-purpose-confirm",
      minVersion: "0.134.0",
      late: true,
    },
  },
  {
    // Spec 0041 R9: the LAST late row — after general-purpose-confirm — so no trust
    // index of another row moves when `harness.planTiers` toggles (it is conditional,
    // so it must trail every unconditional late row). Gates only `implementer` (child role from
    // `tool_input.agent_type`); under V2 the encrypted `message` is replaced by
    // the orchestrator's `dispatch_<feature>.json`. Matches `role-guard`'s
    // unanchored `spawn_agent$`.
    script: "plan-gate",
    registration: {
      event: "PreToolUse",
      matcher: "spawn_agent$",
      timeout: 15,
      statusMessage: "navori: plan-gate",
      minVersion: "0.134.0",
      when: (config) => Boolean(config.harness?.planTiers),
      late: true,
    },
  },
  {
    // Codex-only (`HOOK_ENGINES`): enforces Claude's per-role engram grants, which
    // Codex cannot express in an agent. Registered AFTER the conditional `plan-gate`
    // on purpose: trust keys are positional (`pre_tool_use:<idx>:0`), so placing it
    // before would shift plan-gate's already-approved index and switch it off, and
    // role-guard's matcher must never change (a new hash disables it until
    // re-approved). Accepted cost: toggling `harness.planTiers` moves this row's
    // index, so it needs one re-approval then (same for `harness.masterPlan`, whose rows precede it). The unanchored matcher also covers
    // the `mcp__plugin_engram_engram__` prefix; the script compares by tool suffix.
    script: "engram-write-guard",
    registration: {
      event: "PreToolUse",
      matcher: "mcp__engram__|mcp__plugin_engram_engram__",
      timeout: 10,
      statusMessage: "navori: engram-write-guard",
      minVersion: "0.134.0",
      late: true,
    },
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
 * (table order — see the module doc's ordering contract), then the plugin
 * hooks, then the `late` rows (spec 0041 D8).
 */
export function resolveCodexHooks(
  config: NavoriConfig,
  plugins: readonly LoadedPlugin[] = [],
  overlapRows: readonly OverlapRow[] = OVERLAP_ROWS,
): ResolvedCodexHook[] {
  const resolved: ResolvedCodexHook[] = [];
  const late: ResolvedCodexHook[] = [];
  // Spec 0039 D1: same predicate `filterInventory` uses, so a hook (or plugin)
  // the matrix marks native on Codex is neither written nor registered.
  const livePlugins = plugins.filter(
    (plugin) => !isNativeOn("codex", "plugin", plugin.manifest.id, overlapRows),
  );
  for (const row of CODEX_HOOK_REGISTRATIONS) {
    if (!row.registration) continue;
    if (isNativeOn("codex", "hook", row.script, overlapRows)) continue;
    if (row.registration.when && !row.registration.when(config)) continue;
    const { when: _when, minVersion: _minVersion, late: isLate, ...rest } = row.registration;
    (isLate ? late : resolved).push({ script: row.script, ...rest });
  }
  return [...resolved, ...resolvePluginCodexHooks(livePlugins).hooks, ...late];
}

/**
 * Minimum Codex version for a rendered harness: the max of the registration
 * table floor (R18) and the highest version the parity table was live-verified
 * at (spec 0041 R4, T20), so `doctor` and `render` read ONE floor. The table
 * floor is the max `minVersion` across every row Codex actually registers
 * (unsupported rows don't count; they're never written to `.codex/config.toml`).
 * Static: a feature toggle being off doesn't lower the floor a rendered
 * `config.toml` with that toggle later ON would need, so this deliberately
 * ignores `when`.
 */
export function minCodexVersion(): string {
  let max = minVerifiedCodexVersion();
  for (const row of CODEX_HOOK_REGISTRATIONS) {
    if (!row.registration) continue;
    if ((compareSemver(row.registration.minVersion, max) ?? 0) > 0) {
      max = row.registration.minVersion;
    }
  }
  return max;
}
