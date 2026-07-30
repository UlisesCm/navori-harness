import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { NavoriConfig } from "../../lib/config.ts";
import type { LoadedPlugin, PluginHookEntry } from "../../lib/plugins.ts";
import { getCoreRoot, readBundledCoreVersion } from "../../lib/bundled-assets.ts";
import { interpolate } from "../../lib/interpolate.ts";
import { deepMerge } from "./deep-merge.ts";

/**
 * Build the final `.claude/settings.json` object the engine adapter will
 * write. Pure (no file writes); returns a plain object so the caller can
 * JSON.stringify it once.
 *
 * Layering (deep-merged in order):
 *   1. settings-base.json from @navori/core (interpolated with coreVersion).
 *      Ships permissions.allow (read-only git + file inspection + the native
 *      Read/Glob/Grep tools, so trivial reads don't prompt), .ask
 *      (destructive-but-legit) and .deny (catastrophic, no-legit-use) rules.
 *   1b. Defensive guard PreToolUse(Bash) hook — always registered, references
 *      `$CLAUDE_PROJECT_DIR/.claude/hooks/guard-destructive.sh`. The absolute
 *      `$CLAUDE_PROJECT_DIR` anchor (not a cwd-relative path) is what lets the
 *      hook resolve when the Bash cwd is a git worktree without its own
 *      `.claude/`. Exit 2 precedes permission rules.
 *   2. Quality-gate PreToolUse hook, only if `config.qualityGate.fast` is
 *      set. The hook entry references
 *      `$CLAUDE_PROJECT_DIR/.claude/hooks/quality-gate-pre-commit.sh`
 *      (rendered separately by the file pipeline).
 *   2b. SessionStart(startup|resume|compact) hook — always registered. References
 *      `$CLAUDE_PROJECT_DIR/.claude/hooks/session-start-context.sh`; injects the
 *      live harness context (branch/commits/current.md) so resume is deterministic.
 *   2c. Lifecycle hooks (N1) — all advisory, never blocking. SubagentStop
 *      (handoff validator) and PreCompact (session-summary reminder) always
 *      registered; Stop (verify-before-done reminder) only when
 *      `config.hooks.verifyOnStop` is set.
 *   3. For each enabled plugin: `settingsFragment` and `hooks[]` translated
 *      from the flat manifest shape into Claude Code's nested
 *      `hooks.<Event>[].{matcher, hooks[]}` shape.
 *
 * Arrays concat-dedupe via `deepMerge`, so the same hook contributed twice
 * (or shipped by two plugins) collapses to one entry.
 */

const QG_HOOK_DEST = ".claude/hooks/quality-gate-pre-commit.sh";
const GUARD_HOOK_DEST = ".claude/hooks/guard-destructive.sh";
const SESSION_START_HOOK_DEST = ".claude/hooks/session-start-context.sh";
const SUBAGENT_STOP_HOOK_DEST = ".claude/hooks/subagent-stop-handoff.sh";
const PRECOMPACT_HOOK_DEST = ".claude/hooks/precompact-session-summary.sh";
const STOP_HOOK_DEST = ".claude/hooks/stop-verify-reminder.sh";
const SETTINGS_BASE_REL = "core-assets/settings/settings-base.json";

export function buildClaudeSettings(
  config: NavoriConfig,
  plugins: LoadedPlugin[],
): Record<string, unknown> {
  const basePath = resolve(getCoreRoot(), SETTINGS_BASE_REL);
  const baseRaw = readFileSync(basePath, "utf-8");
  const baseInterp = interpolate(baseRaw, config, {
    extraVars: { coreVersion: readBundledCoreVersion() },
  });
  let settings = JSON.parse(baseInterp) as Record<string, unknown>;

  // The leader role is embodied by the main agent (not spawned as a subagent), so
  // its effort tier can't take effect via agent frontmatter — it drives the
  // session-wide default through settings.json `effortLevel`. Each subagent then
  // overrides it with its own frontmatter `effort`. `max` is valid per-agent but
  // NOT accepted in settings.json, so it's skipped here (session default stands).
  const leaderEffort = config.effort?.leader;
  if (leaderEffort && leaderEffort !== "max") {
    settings = deepMerge(settings, { effortLevel: leaderEffort });
  }

  // Defensive guard hook — always registered (unlike the quality gate, it has
  // no config dependency). Exit 2 here precedes permission rules, so it's the
  // hard backstop for destructive patterns static deny globs can't catch.
  settings = deepMerge(settings, {
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: `bash "$CLAUDE_PROJECT_DIR/${GUARD_HOOK_DEST}"`,
              timeout: 10,
              statusMessage: "navori: guard-destructive",
            },
          ],
        },
      ],
    },
  });

  if (config.qualityGate?.fast) {
    settings = deepMerge(settings, {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: `bash "$CLAUDE_PROJECT_DIR/${QG_HOOK_DEST}"`,
                timeout: 180,
                statusMessage: "navori: quality-gate fast",
              },
            ],
          },
        ],
      },
    });
  }

  // SessionStart context hook — always registered (no config dependency, like
  // the guard). Injects the live harness context (branch, recent commits,
  // progress/current.md) at session start/resume/post-compact so resuming is
  // deterministic. Claude-only: Codex lifecycle hooks are still experimental,
  // so the asset renders under .codex/hooks/ but is not wired there yet.
  settings = deepMerge(settings, {
    hooks: {
      SessionStart: [
        {
          matcher: "startup|resume|compact",
          hooks: [
            {
              type: "command",
              command: `bash "$CLAUDE_PROJECT_DIR/${SESSION_START_HOOK_DEST}"`,
              timeout: 15,
              statusMessage: "navori: session context",
            },
          ],
        },
      ],
    },
  });

  // Lifecycle hooks (N1) — all advisory (systemMessage / additionalContext),
  // never `decision: block`. SubagentStop + PreCompact are always registered
  // (no config dependency, like the guard/session-start above): SubagentStop
  // flags empty/broken `impl_*`/`review_*` handoffs; PreCompact reminds the
  // model to persist a session summary before compaction drops turn detail.
  // Stop is opt-in (`config.hooks.verifyOnStop`) below. Claude-only: Codex
  // lifecycle hooks are still experimental, so the assets render under
  // .codex/hooks/ but aren't wired there yet (same as session-start).
  settings = deepMerge(settings, {
    hooks: {
      SubagentStop: [
        {
          hooks: [
            {
              type: "command",
              command: `bash "$CLAUDE_PROJECT_DIR/${SUBAGENT_STOP_HOOK_DEST}"`,
              timeout: 15,
              statusMessage: "navori: handoff check",
            },
          ],
        },
      ],
      PreCompact: [
        {
          matcher: "manual|auto",
          hooks: [
            {
              type: "command",
              command: `bash "$CLAUDE_PROJECT_DIR/${PRECOMPACT_HOOK_DEST}"`,
              timeout: 15,
              statusMessage: "navori: pre-compact summary",
            },
          ],
        },
      ],
    },
  });

  // Stop verify-before-done reminder — OPT-IN (noisy per-turn on a dirty tree),
  // gated on config exactly like the quality-gate hook. Advisory only.
  if (config.hooks?.verifyOnStop) {
    settings = deepMerge(settings, {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: `bash "$CLAUDE_PROJECT_DIR/${STOP_HOOK_DEST}"`,
                timeout: 15,
                statusMessage: "navori: verify-before-done",
              },
            ],
          },
        ],
      },
    });
  }

  for (const plugin of plugins) {
    const fragment = plugin.manifest.settingsFragment;
    if (fragment && typeof fragment === "object" && !Array.isArray(fragment)) {
      settings = deepMerge(settings, fragment as Record<string, unknown>);
    }
    if (plugin.manifest.hooks && plugin.manifest.hooks.length > 0) {
      settings = deepMerge(settings, {
        hooks: pluginHooksToClaudeShape(plugin.manifest.hooks),
      });
    }
  }

  // Pre-approve the exact commands this repo's quality gate runs plus the
  // package-manager dev-loop scripts, so `pnpm test` / `pnpm build` / the gate
  // itself and `git commit` stop prompting on every run. Safe by construction:
  // each rule is a boundary-enforcing prefix (`…:*`), Claude Code won't
  // auto-approve a compound like `pnpm build && rm -rf x` from a prefix rule,
  // and the guard-destructive hook (exit 2) still precedes permission checks.
  const derivedAllow = deriveQualityGateAllow(config);
  if (derivedAllow.length > 0) {
    settings = deepMerge(settings, { permissions: { allow: derivedAllow } });
  }

  // The guard (1b), quality-gate (2) and plugin hooks each deep-merge their own
  // `{matcher:"Bash", hooks:[...]}`, which concat into redundant matcher buckets
  // (e.g. two `matcher:"Bash"` entries → a Bash command pays two matcher
  // evaluations). Collapse buckets sharing an event+matcher into one so Claude
  // sees a single bucket per matcher — same intent as pluginHooksToClaudeShape,
  // now across all layers.
  return coalesceHookMatchers(settings);
}

const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);
// Sequencers navori's quality gate uses to join steps. Bare pipes are excluded:
// a `| tee`/`| grep` tail is part of one logical step, not a command to allow.
const GATE_SEQUENCERS = /\s*(?:&&|\|\||;)\s*/;
// A gate step is only safe to pre-approve as a permission rule (#197) if it is
// made of "quiet" tokens: word chars plus the punctuation a package-manager
// invocation legitimately uses (space, `@ . / : = -`). Anything else — a bare
// pipe, redirect, `$`, backtick, quote, paren, `&` — means the step could smuggle
// a second command through a rule that Claude Code would then auto-approve, so we
// refuse to derive an allow rule from it (the step still runs; it just prompts).
const SAFE_GATE_STEP = /^[\w @.:/=-]+$/;

/**
 * Resolve the repo's package manager: the persisted `config.packageManager`
 * (written by init/update — the source of truth), falling back to the runner
 * token of `qualityGate.fast` for configs written before the field existed.
 */
function resolvePackageManager(config: NavoriConfig): string | null {
  if (config.packageManager) return config.packageManager;
  const first = config.qualityGate?.fast?.trim().split(/\s+/)[0];
  return first && PACKAGE_MANAGERS.has(first) ? first : null;
}

/**
 * Permission allow-rules derived from the repo's own quality gate + package
 * manager. Two sources: (1) the exact commands the gate runs (split on shell
 * sequencers), so the gate stops prompting; (2) the `<pm> run <script>` dev-loop
 * (build/test/lint/typecheck/format), since `build` in particular is rarely in
 * the gate yet run constantly. Prefix rules use `…:*` (word-boundary wildcard).
 *
 * SECURITY (#197): `navori.config.json` is editable via PR, so a gate string is
 * NOT trusted. A step only becomes a pre-approved rule when it is led by a known
 * package manager AND is metacharacter-free (SAFE_GATE_STEP) — otherwise a
 * `curl …|bash` gate would survive GATE_SEQUENCERS (which doesn't split a bare
 * pipe) as one step and get auto-approved. Rejected steps still run; they just
 * don't get a standing allow rule.
 */
function deriveQualityGateAllow(config: NavoriConfig): string[] {
  const rules = new Set<string>();
  for (const gate of [config.qualityGate?.fast, config.qualityGate?.full]) {
    if (!gate) continue;
    for (const step of gate.split(GATE_SEQUENCERS)) {
      const cmd = step.trim();
      if (!cmd) continue;
      const runner = cmd.split(/\s+/)[0];
      if (!PACKAGE_MANAGERS.has(runner) || !SAFE_GATE_STEP.test(cmd)) continue;
      rules.add(`Bash(${cmd}:*)`);
    }
  }
  const pm = resolvePackageManager(config);
  if (pm) {
    for (const script of ["build", "test", "lint", "typecheck", "format"]) {
      rules.add(`Bash(${pm} run ${script}:*)`);
    }
  }
  return [...rules];
}

/**
 * Merge hook entries that share an event + matcher into a single bucket,
 * deduping identical hook commands. Non-standard entries (no `hooks[]` array)
 * pass through untouched. Order is preserved by first appearance.
 */
function coalesceHookMatchers(settings: Record<string, unknown>): Record<string, unknown> {
  const hooks = settings.hooks;
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) return settings;

  const coalesced: Record<string, unknown> = {};
  for (const [event, entries] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(entries)) {
      coalesced[event] = entries;
      continue;
    }
    const buckets: Array<{ matcher?: string; hooks: unknown[] }> = [];
    const passthrough: unknown[] = [];
    for (const entry of entries) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        !Array.isArray((entry as { hooks?: unknown }).hooks)
      ) {
        passthrough.push(entry);
        continue;
      }
      const e = entry as { matcher?: string; hooks: unknown[] };
      const existing = buckets.find((b) => b.matcher === e.matcher);
      if (existing) {
        const seen = new Set(existing.hooks.map((h) => JSON.stringify(h)));
        for (const h of e.hooks) {
          if (!seen.has(JSON.stringify(h))) existing.hooks.push(h);
        }
      } else {
        buckets.push({
          ...(e.matcher !== undefined ? { matcher: e.matcher } : {}),
          hooks: [...e.hooks],
        });
      }
    }
    coalesced[event] = [...buckets, ...passthrough];
  }
  return { ...settings, hooks: coalesced };
}

/**
 * Translate the flat plugin-manifest hook entries to Claude Code's nested
 * structure. Entries sharing an event + matcher are grouped under one
 * outer object so Claude doesn't see redundant matcher buckets.
 */
function pluginHooksToClaudeShape(
  entries: PluginHookEntry[],
): Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>> {
  const grouped: Record<
    string,
    Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>
  > = {};
  for (const h of entries) {
    const inner: Record<string, unknown> = { type: "command", command: h.command };
    if (h.timeout !== undefined) inner.timeout = h.timeout;
    if (h.statusMessage !== undefined) inner.statusMessage = h.statusMessage;

    const eventBucket = (grouped[h.event] ??= []);
    let matcherEntry = eventBucket.find((e) => e.matcher === h.matcher);
    if (!matcherEntry) {
      matcherEntry = h.matcher !== undefined ? { matcher: h.matcher, hooks: [] } : { hooks: [] };
      eventBucket.push(matcherEntry);
    }
    matcherEntry.hooks.push(inner);
  }
  return grouped;
}
