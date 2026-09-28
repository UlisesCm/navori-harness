import type { NavoriConfig } from "../../lib/config/config.ts";
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
      "Codex delegation was observed bypassing PreToolUse even with the branch-built CLI; " +
      "plan-gate enforcement is deferred until a live negative smoke blocks child creation.",
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
];

/** One Codex hook ready to serialize into `.codex/config.toml`. */
export interface ResolvedCodexHook {
  readonly script: string;
  readonly event: string;
  readonly matcher?: string;
  readonly timeout: number;
  readonly statusMessage?: string;
  readonly args?: string;
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
  const hookBase = `$(git rev-parse --show-toplevel)${wsSubpath ? `/${wsSubpath}` : ""}/.codex/hooks`;
  return `bash "${hookBase}/${hook.script}.sh"${hook.args ? ` ${hook.args}` : ""}`;
}

/**
 * The Codex hook groups to register for `config`, in stable render order
 * (table order — see the module doc's ordering contract).
 */
export function resolveCodexHooks(config: NavoriConfig): ResolvedCodexHook[] {
  const resolved: ResolvedCodexHook[] = [];
  for (const row of CODEX_HOOK_REGISTRATIONS) {
    if (!row.registration) continue;
    if (row.registration.when && !row.registration.when(config)) continue;
    const { when: _when, minVersion: _minVersion, ...rest } = row.registration;
    resolved.push({ script: row.script, ...rest });
  }
  return resolved;
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
