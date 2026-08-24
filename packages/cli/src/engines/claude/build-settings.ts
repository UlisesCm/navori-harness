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
 *      Its allow list closes with the PURE-FILTER class — `tr`/`comm`/`column`/
 *      `echo`/`printf`/`command -v`/`shasum`/`md5`/`bash -n` — siblings of the
 *      `wc`/`cut`/`grep`/`jq` already there (#403). The membership test is
 *      strict: the command writes to STDOUT ONLY, so no argv can make it write
 *      a file or exec. That is why the class stops where it does:
 *        - `awk` stays OUT: it has `system()`, i.e. arbitrary exec. It reads
 *          like a filter and is not one.
 *        - `sort` (`-o <file>`) and `uniq` (2nd positional = output file) write
 *          an arbitrary file through argv; they were REMOVED from this list by
 *          a security review (e49e9a2) and must not come back.
 *        - `sed` stays out in every form. A prefix rule cannot exclude an inner
 *          flag, so `Bash(sed -n:*)` would also pre-approve `sed -n -i …`,
 *          an in-place write to any file.
 *        - `bash -n` is in because `-n` is noexec (parse-only, and it still
 *          applies to `-c`); it is emphatically NOT `bash -c`.
 *      The hard boundary the class must never cross: `bash -c`, `node -e`,
 *      `python3 -c`, `perl`, `curl`/network are never allowlisted anywhere in
 *      the managed fragment. Allowing them is equivalent to turning the
 *      permission system off, so that prompt is the correct friction. Tests pin
 *      every one of these decisions.
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
// A gate step that only changes directory: `cd` plus exactly ONE operand. Paired
// with SAFE_GATE_STEP (which forbids `$`, backticks, quotes, `~`), so the operand
// is a literal path — `cd $(curl …)` never reaches here.
const CD_STEP = /^cd\s+\S+$/;

/**
 * Resolve the repo's package manager: the persisted `config.packageManager`
 * (written by init/update — the source of truth), falling back to the runner
 * token of a `qualityGate.fast` step for configs written before the field
 * existed. The fallback scans every step, not just the first (#403): a gate that
 * opens with `cd packages/cli && pnpm lint` used to resolve the runner as `cd`
 * and give up, so a monorepo — exactly the shape that needs the dev-loop rules —
 * got none.
 */
function resolvePackageManager(config: NavoriConfig): string | null {
  if (config.packageManager) return config.packageManager;
  for (const step of config.qualityGate?.fast?.split(GATE_SEQUENCERS) ?? []) {
    // `split` always yields at least one element; `?? ""` is unreachable and
    // is never a package manager anyway.
    const runner = step.trim().split(/\s+/)[0] ?? "";
    if (PACKAGE_MANAGERS.has(runner)) return runner;
  }
  return null;
}

/**
 * The allow rule a single gate step earns, or `null` when the step is not safe
 * to pre-approve. Two shapes qualify:
 *
 *   - `<pm> …`   → prefix rule `Bash(<step>:*)`, so flags/paths may follow.
 *   - `cd <dir>` → EXACT rule `Bash(cd <dir>)`, no wildcard: `cd` takes one
 *     operand, so `:*` would only widen the match for nothing.
 */
function gateStepRule(step: string): string | null {
  if (!SAFE_GATE_STEP.test(step)) return null;
  if (PACKAGE_MANAGERS.has(step.split(/\s+/)[0] ?? "")) return `Bash(${step}:*)`;
  return CD_STEP.test(step) ? `Bash(${step})` : null;
}

/**
 * Permission allow-rules derived from the repo's own quality gate + package
 * manager. Three sources:
 *
 *   1. Every step of the gate (split on shell sequencers) — see `gateStepRule`.
 *      Claude Code splits a compound command and checks each sub-command
 *      separately, which is exactly why the gate kept prompting (#403): the rule
 *      for `pnpm test` was there, but `cd packages/cli` matched nothing, so
 *      `cd packages/cli && pnpm test` prompted on every run. The measured cost of
 *      that friction was the agent learning to wrap commands in `bash -c '…'` to
 *      dodge it — opaque to the guard hook, i.e. strictly worse than allowing the
 *      direct form.
 *   2. The gate string itself as an EXACT rule (no `:*`), covering the compound
 *      as typed — but only when EVERY step earned a rule of its own, so a gate
 *      with one hostile step contributes nothing at all.
 *   3. The `<pm> run <script>` dev-loop (build/test/lint/typecheck/format), since
 *      `build` in particular is rarely in the gate yet run constantly.
 *
 * SECURITY (#197, #403): `navori.config.json` is editable via PR, so a gate
 * string is NOT trusted — it is a value to validate, never a template to expand.
 * A step becomes a rule only when it is metacharacter-free (SAFE_GATE_STEP) AND
 * matches a known-inert shape; otherwise a `curl …|bash` gate would survive
 * GATE_SEQUENCERS (which doesn't split a bare pipe) as one step and get
 * auto-approved. Rejected steps still run; they just don't get a standing rule.
 * Note the asymmetry that keeps this closed: the only wildcard rule comes from a
 * package-manager step, and every rule emitted for a shape we did not fully
 * constrain is exact-match.
 */
function deriveQualityGateAllow(config: NavoriConfig): string[] {
  const rules = new Set<string>();
  for (const gate of [config.qualityGate?.fast, config.qualityGate?.full]) {
    if (!gate?.trim()) continue;
    const steps = gate.split(GATE_SEQUENCERS).map((s) => s.trim());
    const stepRules = steps.map((step) => (step ? gateStepRule(step) : null));
    for (const rule of stepRules) {
      if (rule) rules.add(rule);
    }
    // The compound as the user actually types it. Reconstructed from nothing —
    // it is the raw gate, trimmed — so it stays byte-identical to what CLAUDE.md
    // tells the agent to run; safe because every step that composes it passed
    // validation and the rule carries no wildcard.
    if (steps.length > 1 && stepRules.every((rule) => rule !== null)) {
      rules.add(`Bash(${gate.trim()})`);
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
