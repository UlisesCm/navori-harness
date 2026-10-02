import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { NavoriConfig } from "../../lib/config/config.ts";
import type { LoadedPlugin, PluginHookEntry } from "../../lib/config/plugins.ts";
import { getCoreRoot, readCliVersion } from "../../lib/render/bundled-assets.ts";
import { interpolate } from "../../lib/render/interpolate.ts";
import { isAgentEnabled } from "../shared/harness-assets.ts";
import { resolveHarnessPlan } from "../shared/harness-plan.ts";
import { filterInventory, type FilteredInventory } from "../shared/native-overlap.ts";
import { collectShellPermissionRules } from "../shared/permission-rules.ts";
import { deepMerge } from "./deep-merge.ts";

/**
 * Build the final `.claude/settings.json` object the engine adapter will
 * write. Pure (no file writes); returns a plain object so the caller can
 * JSON.stringify it once.
 *
 * Layering (deep-merged in order):
 *   1. settings-base.json from @navori/core (interpolated with cliVersion).
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
 *      The base also blanks Claude Code's `attribution` (commit trailer, PR
 *      footer, session link): artifacts carry no AI reference. A user can
 *      override it in their own `.claude/settings.local.json`, but the managed
 *      rule in CLAUDE.md (formato-respuesta) still forbids it.
 *   1b. Defensive guard PreToolUse(Bash) hook — always registered, references
 *      `$CLAUDE_PROJECT_DIR/.claude/hooks/guard-destructive.sh`. The absolute
 *      `$CLAUDE_PROJECT_DIR` anchor (not a cwd-relative path) is what lets the
 *      hook resolve when the Bash cwd is a git worktree without its own
 *      `.claude/`. Exit 2 precedes permission rules.
 *   1c. `implementer-no-markdown` PreToolUse(`Bash|Edit|Write|NotebookEdit`)
 *      hook (spec 0030, R3/R4/R13) — registered only when
 *      `harness.scribeOwnsMarkdown` is `true` (default `false`), exit 2.
 *      Blocks the `implementer` (identified by the payload's `agent_type`)
 *      from writing `.md`/`.mdx`; every other agent and the main thread pass
 *      untouched.
 *   1d. `subagent-no-background` PreToolUse(`Bash|Monitor`) hook (#1003) —
 *      always registered, like the guard: a universal invariant, not a
 *      configurable feature. Blocks a `Bash` call with
 *      `tool_input.run_in_background: true` or any `Monitor` call, but only
 *      when the payload's `agent_id` is present (any subagent); the main
 *      thread — where backgrounding a gate that outlives the Bash timeout is
 *      the documented legitimate path — passes untouched. Exit 2.
 *   2. Quality-gate PreToolUse hook, only if `config.qualityGate.fast` is
 *      set. The hook entry references
 *      `$CLAUDE_PROJECT_DIR/.claude/hooks/quality-gate-pre-commit.sh`
 *      (rendered separately by the file pipeline).
 *   2b. SessionStart(startup|resume|clear|compact|fork) hook — always
 *      registered, on ALL FIVE documented sources. References
 *      `$CLAUDE_PROJECT_DIR/.claude/hooks/session-start-context.sh`; injects the
 *      live harness context (branch/commits/current.md) so resume is deterministic.
 *   2c. Lifecycle hooks (N1) — all advisory, never blocking. The handoff
 *      validator is registered on PostToolUse(`Agent|Task`), the event whose
 *      `additionalContext` reaches the PARENT session (#774); Stop
 *      (verify-before-done reminder) only when `config.hooks.verifyOnStop` is
 *      set.
 *   3. For each enabled plugin: `settingsFragment` and `hooks[]` translated
 *      from the flat manifest shape into Claude Code's nested
 *      `hooks.<Event>[].{matcher, hooks[]}` shape.
 *
 * Arrays concat-dedupe via `deepMerge`, so the same hook contributed twice
 * (or shipped by two plugins) collapses to one entry.
 */

const QG_HOOK_DEST = ".claude/hooks/quality-gate-pre-commit.sh";
const GUARD_HOOK_DEST = ".claude/hooks/guard-destructive.sh";
const IMPLEMENTER_NO_MD_HOOK_DEST = ".claude/hooks/implementer-no-markdown.sh";
const SUBAGENT_NO_BACKGROUND_HOOK_DEST = ".claude/hooks/subagent-no-background.sh";
const PLAN_GATE_HOOK_DEST = ".claude/hooks/plan-gate.sh";
const MASTER_PLAN_CONTEXT_HOOK_DEST = ".claude/hooks/master-plan-context.sh";
const MASTER_ACCEPT_CONFIRM_HOOK_DEST = ".claude/hooks/master-accept-confirm.sh";
const SESSION_START_HOOK_DEST = ".claude/hooks/session-start-context.sh";
const MODEL_ADVISOR_HOOK_DEST = ".claude/hooks/model-advisor.sh";
const AUDIT_TRIGGER_HOOK_DEST = ".claude/hooks/audit-mode-trigger.sh";
const AUDIT_CLOSE_HOOK_DEST = ".claude/hooks/audit-mode-close.sh";
const SUBAGENT_STOP_HOOK_DEST = ".claude/hooks/subagent-stop-handoff.sh";
const MANAGED_DRIFT_HOOK_DEST = ".claude/hooks/managed-drift-watch.sh";
const ROUTING_WATCH_HOOK_DEST = ".claude/hooks/routing-watch.sh";
const BASH_OUTCOME_WATCH_HOOK_DEST = ".claude/hooks/bash-outcome-watch.sh";
const PR_PUBLISHER_HOOK_DEST = ".claude/hooks/pr-publisher-confirm.sh";
const GENERAL_PURPOSE_HOOK_DEST = ".claude/hooks/general-purpose-confirm.sh";
const COMMENT_DRAFT_HOOK_DEST = ".claude/hooks/comment-draft-confirm.sh";
const WORKTREE_RECLAIM_HOOK_DEST = ".claude/hooks/worktree-reclaim.sh";
const STOP_HOOK_DEST = ".claude/hooks/stop-verify-reminder.sh";
const SETTINGS_BASE_REL = "core-assets/settings/settings-base.json";

/**
 * The command `settings.json` registers for a hook script: parse-check it with
 * `bash -n`, then `exec` it exactly as `bash "<path>" <args>` did before, so
 * `$0`, stdin and the exit code reach the script unchanged.
 *
 * Why the check: a script bash cannot parse — a merge or rebase that leaves
 * conflict markers in `.claude/hooks/`, the self-hosted case — makes bash exit
 * 2, and exit 2 is Claude Code's BLOCK signal. Every PreToolUse hook then
 * blocks Bash/Edit/Write, so the agent cannot even run the `git rebase --abort`
 * that would fix it, and a Stop hook exiting 2 forces the turn to continue,
 * which loops the session. The fallback depends on the event:
 *   - PreToolUse: `ask` with the reason — fail-safe (a broken guard never waves
 *     a command through) without bricking the session; the human approves the
 *     repair. Same posture as #1117's "no verdict → ask".
 *   - Every other event: a stderr notice and exit 1, a non-blocking error.
 *
 * The parse check costs ~3ms on the largest hook (guard-destructive, ~1.4k
 * lines). The command is POSIX sh, and zsh-safe (#391).
 */
export function claudeHookCommand(event: string, scriptRel: string, args?: string): string {
  const run = `f="$CLAUDE_PROJECT_DIR/${scriptRel}"; bash -n "$f" 2>/dev/null && exec bash "$f"${args ? ` ${args}` : ""}; `;
  const reason = `navori: ${scriptRel} cannot be parsed (merge/rebase conflict?): abort or resolve it, then navori render --apply`;
  if (event === "PreToolUse") {
    const decision = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: reason,
      },
    });
    return `${run}printf '%s\\n' '${decision}'`;
  }
  return `${run}echo '${reason}' >&2; exit 1`;
}

/** `bash "$CLAUDE_PROJECT_DIR/<path>" [args]`, the plugin manifest's command shape. */
const PLAIN_HOOK_COMMAND_RE = /^bash "\$CLAUDE_PROJECT_DIR\/([^"\n]+)"(?: ([^\n]+))?$/;

/**
 * Build `.claude/settings.json` from `config` and the FILTERED inventory
 * (spec 0039 D1/B1): a core hook is registered only if its id is in
 * `inventory.plan.hooks`, and plugin settings/hooks come only from
 * `inventory.plugins`. The adapter passes the same inventory it wrote files
 * from, so a unit filtered out as native loses its file and its registration
 * together.
 *
 * Passing a bare `LoadedPlugin[]` is the pre-0039 form kept for existing
 * callers (tests): the inventory is derived from `config` with the full Claude
 * plan, so the conditions below alone decide. TODO(spec-0039): migrate those
 * ~60 call sites and drop the array form once nobody passes it.
 */
export function buildClaudeSettings(
  config: NavoriConfig,
  inventoryOrPlugins: FilteredInventory | LoadedPlugin[],
): Record<string, unknown> {
  const { plan, plugins } = Array.isArray(inventoryOrPlugins)
    ? legacyInventory(config, inventoryOrPlugins)
    : inventoryOrPlugins;
  const basePath = resolve(getCoreRoot(), SETTINGS_BASE_REL);
  const baseRaw = readFileSync(basePath, "utf-8");
  const baseInterp = interpolate(baseRaw, config, {
    // The CLI's release version, NOT @navori/core's static one: `$navori.version`
    // is the anti-rollback stamp `lib/removable.ts` compares before deleting a
    // generated JSON (#538), so it has to move on the same scale as a managed
    // block's `version=`. Stamping the frozen 0.0.1 made the guard vacuous.
    extraVars: { cliVersion: readCliVersion() },
  });
  let settings = JSON.parse(baseInterp) as Record<string, unknown>;

  // The orchestrator role is embodied by the main agent (not spawned as a
  // subagent), so its effort tier can't take effect via agent frontmatter — it
  // drives the session-wide default through settings.json `effortLevel`. Each
  // subagent then overrides it with its own frontmatter `effort`. `max` is
  // valid per-agent but NOT accepted in settings.json, so it's skipped here
  // (session default stands).
  const orchestratorEffort = config.effort?.orchestrator;
  if (orchestratorEffort && orchestratorEffort !== "max") {
    settings = deepMerge(settings, { effortLevel: orchestratorEffort });
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
              command: claudeHookCommand("PreToolUse", GUARD_HOOK_DEST),
              timeout: 10,
              statusMessage: "navori: guard-destructive",
            },
          ],
        },
      ],
    },
  });

  // #1003: the mechanical backstop for "a subagent does not background its
  // own work" (`implementer.md:43`, `reviewer.md:79`, `verify-before-done.md`'s
  // subagent row). Always registered, like the guard above — it is a
  // universal invariant already stated unconditionally for every harness
  // install, not tied to any optional feature. Exit 2 precedes permission
  // rules. Matcher `Bash|Monitor`: `Monitor`'s hookability as a PreToolUse
  // tool name is not confirmed by the official hooks doc, so this branch is
  // defense in depth (see the hook's own header).
  settings = deepMerge(settings, {
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash|Monitor",
          hooks: [
            {
              type: "command",
              command: claudeHookCommand("PreToolUse", SUBAGENT_NO_BACKGROUND_HOOK_DEST),
              timeout: 10,
              statusMessage: "navori: subagent-no-background",
            },
          ],
        },
      ],
    },
  });

  // Spec 0030 (#985), R3/R4/R13: the mechanical half of "the implementer does
  // not write Markdown" — registered only when `harness.scribeOwnsMarkdown`
  // is `true` (default `false`, same admission gate as spec 0031 R7). Same
  // posture as the guard above once it is on (this file, whether it blocks,
  // is the decision — an implementer that never touches `.md` never trips
  // it). Exit 2 precedes permission rules, same channel guard-destructive
  // uses.
  //
  // Matcher is `Bash|Edit|Write|NotebookEdit`, deliberately NOT `MultiEdit`
  // (retired tool name; #796's `hook-matcher-wiring.test.ts` derives coverage
  // from what the script itself declares, so a token here with nothing behind
  // it would fail there, not silently ship dead weight).
  if (config.harness?.scribeOwnsMarkdown) {
    settings = deepMerge(settings, {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash|Edit|Write|NotebookEdit",
            hooks: [
              {
                type: "command",
                command: claudeHookCommand("PreToolUse", IMPLEMENTER_NO_MD_HOOK_DEST),
                timeout: 10,
                statusMessage: "navori: implementer-no-markdown",
              },
            ],
          },
        ],
      },
    });
  }

  // Spec 0032 (#1011), R16/R30: the workplan gate — registered only when
  // `harness.planTiers` is `true` (default `false`), like the scribeOwnsMarkdown
  // hook above. Matcher `Agent` so it fires on every subagent dispatch; the
  // TypeScript half (`lib/plan/gate.ts`) is what actually restricts itself to
  // `subagent_type: "implementer"` — see that hook's own header for why the
  // filtering isn't duplicated here. Exit 2 precedes permission rules.
  if (config.harness?.planTiers) {
    settings = deepMerge(settings, {
      hooks: {
        PreToolUse: [
          {
            matcher: "Agent",
            hooks: [
              {
                type: "command",
                command: claudeHookCommand("PreToolUse", PLAN_GATE_HOOK_DEST),
                timeout: 10,
                statusMessage: "navori: plan-gate",
              },
            ],
          },
        ],
      },
    });
  }

  // Spec 0028: all three registrations are advisory-only. The hook stores only
  // session scratch state and prints the documented user-visible systemMessage
  // (on `Stop` that field never continues the turn, unlike `additionalContext`);
  // `/model` remains the user's explicit model/effort selector.
  settings = deepMerge(settings, {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: claudeHookCommand(
                "SessionStart",
                MODEL_ADVISOR_HOOK_DEST,
                "claude-session-start",
              ),
              timeout: 10,
              statusMessage: "navori: model advisor",
            },
          ],
        },
      ],
      PostModelSwitch: [
        {
          hooks: [
            {
              type: "command",
              command: claudeHookCommand(
                "PostModelSwitch",
                MODEL_ADVISOR_HOOK_DEST,
                "claude-post-model-switch",
              ),
              timeout: 10,
              statusMessage: "navori: model advisor",
            },
          ],
        },
      ],
      // Spec 0039 R27: `Stop` instead of `PreToolUse(.*)`. It costs no hook on any
      // Bash call, and the notice still arrives, at the end of the first turn.
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: claudeHookCommand("Stop", MODEL_ADVISOR_HOOK_DEST, "claude-stop"),
              timeout: 10,
              statusMessage: "navori: model advisor",
            },
          ],
        },
      ],
    },
  });

  // Keep dynamic master-plan progress separate from the bounded general
  // SessionStart context. An off flag must not register this hook (R39).
  if (config.harness?.masterPlan) {
    settings = deepMerge(settings, {
      hooks: {
        SessionStart: [
          {
            matcher: "startup|resume|clear|compact|fork",
            hooks: [
              {
                type: "command",
                command: claudeHookCommand("SessionStart", MASTER_PLAN_CONTEXT_HOOK_DEST),
                timeout: 10,
                statusMessage: "navori: master-plan context",
              },
            ],
          },
        ],
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: claudeHookCommand("PreToolUse", MASTER_ACCEPT_CONFIRM_HOOK_DEST),
                timeout: 10,
                statusMessage: "navori: master acceptance confirmation",
              },
            ],
          },
        ],
      },
    });
  }

  // Spec 0026 E1 (R10): a comment/review-publishing Bash call is raised to
  // `ask`, no matter which agent (or no agent — the main thread) issues it.
  // Always registered, like the guard above: this is not a per-agent routing
  // nudge with an owner to disable with, it is the human confirmation R10
  // requires unconditionally, so no plugin/config toggle can suppress it.
  settings = deepMerge(settings, {
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: claudeHookCommand("PreToolUse", COMMENT_DRAFT_HOOK_DEST),
              timeout: 10,
              statusMessage: "navori: comment-draft-confirm",
            },
          ],
        },
      ],
    },
  });

  // The PR-routing hook delegates to publisher, so it must disappear
  // with that configurable agent rather than leave a dead route (#769).
  if (config.harness?.publisher !== false) {
    settings = deepMerge(settings, {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: claudeHookCommand("PreToolUse", PR_PUBLISHER_HOOK_DEST),
                timeout: 10,
                statusMessage: "navori: pr-publisher-confirm",
              },
            ],
          },
        ],
      },
    });
  }

  // Spec 0039 R40: dispatching `general-purpose` is raised to `ask` naming the
  // `scout`, so it only exists while the scout does (same dependency as the PR
  // routing hook above). No `if`: `Agent(<name>)` if-conditions don't match by
  // name in Claude Code 2.1.287 (only `Agent(*)`/`Agent`/`Task` do), so the hook
  // would never fire; the script filters `tool_input.subagent_type` itself.
  if (isAgentEnabled(config, "scout")) {
    settings = deepMerge(settings, {
      hooks: {
        PreToolUse: [
          {
            matcher: "Agent",
            hooks: [
              {
                type: "command",
                command: claudeHookCommand("PreToolUse", GENERAL_PURPOSE_HOOK_DEST),
                timeout: 10,
                statusMessage: "navori: general-purpose-confirm",
              },
            ],
          },
        ],
      },
    });
  }

  // The OTel events environment (#0021, R10/R11) — the third audit source.
  //
  // Tied to `audit.mode`, not to a per-session flag, because of WHEN the host
  // reads it: the OTel environment is read when the Claude Code process starts,
  // and `--arm`'s central case (#599) is arming the session ALREADY RUNNING.
  // A flag therefore cannot turn exporting on for a live session, so the only
  // honest place for this is a declaration the repo makes before the session
  // opens.
  //
  // `opt-in` emits NOTHING: there, most sessions are not audited, and a repo
  // that audits by session must not pay an export attempt every second in the
  // ones it did not ask to record.
  //
  // Metrics and raw API bodies stay OFF — `OTEL_METRICS_EXPORTER=none` says so
  // explicitly rather than by omission, since the metrics exporter is a
  // separate signal with a separate default, and this spec reads events only.
  // The protocol and endpoint variables are the PER-SIGNAL ones (`_LOGS_`) so
  // enabling this never drags along traces or metrics for an operator who
  // already configured OTel for something else.
  if (config.audit?.mode === "always") {
    settings = deepMerge(settings, {
      env: {
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        OTEL_LOGS_EXPORTER: "otlp",
        OTEL_METRICS_EXPORTER: "none",
        OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:4318/v1/logs",
        OTEL_LOGS_EXPORT_INTERVAL: "1000",
      },
    });
  }

  // #530: the drift watcher, the first of the harness's two PostToolUse hooks
  // (the routing watcher below is the other). The guard
  // above decides by the SHAPE of the command, so it covers the write verbs
  // someone enumerated; this one ignores the command entirely and asks whether
  // the managed blocks still hash to what their markers claim — so a `python`
  // write, a `perl -i`, or a formatter surfaces too. Unconditional like the
  // guard: the freeze it detects is silent, and a defense that ships off
  // protects nobody. The "a PostToolUse hook would fire thousands of times"
  // note further down still holds for audit-mode, which does real work per
  // call; this one costs one shasum pass against a stamp file (~35ms, the
  // median of 13,692 recorded runs) unless a managed file actually changed.
  // (It was a find/mtime probe at ~10ms until that proved unreliable in CI and
  // was redesigned — see the COST section of the script's header.)
  //
  // The matcher covers every tool that can write a file, not just `Bash`
  // (#775). This script audits STATE and never reads `tool_name`, so unlike its
  // neighbours it has no `case` that could contradict a narrow registration —
  // the matcher IS the decision about when it runs, and a narrow one is
  // indistinguishable from a hook that works. Scoped to `Bash` it was blind to
  // the native lane: in `default`/`acceptEdits` an `Edit` over `CLAUDE.md`
  // broke a block's hash and nothing fired until the next shell command, if one
  // ever came. The alternative the host's doc offers for "whatever wrote it" is
  // `FileChanged`; the script's header carries why a watchlist living in
  // settings was the wrong trade here.
  //
  // This matcher is NOT free to drift from that script: it declares
  // `$COVERED_TOOLS`, and `hook-matcher-wiring.test.ts` derives from it (#796).
  // Narrowing the list below fails there, and the only green repair is to
  // change what the script says it covers.
  settings = deepMerge(settings, {
    hooks: {
      PostToolUse: [
        {
          matcher: "Bash|Edit|Write|NotebookEdit",
          hooks: [
            {
              type: "command",
              command: claudeHookCommand("PostToolUse", MANAGED_DRIFT_HOOK_DEST),
              timeout: 10,
              statusMessage: "navori: managed-block drift",
            },
          ],
        },
      ],
    },
  });

  settings = deepMerge(settings, {
    hooks: {
      PostToolUseFailure: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: claudeHookCommand("PostToolUseFailure", BASH_OUTCOME_WATCH_HOOK_DEST),
              timeout: 10,
              statusMessage: "navori: repeat failure advice",
            },
          ],
        },
      ],
    },
  });

  // Spec 0020 (R2/R3): the routing watcher. The ladder that says "4+ files →
  // delegate" ships as CLAUDE.md context, and the host's own docs say context
  // is "not enforced configuration" — measured, 12 of the 21 sessions that
  // crossed the threshold delegated nothing. This hands the model the rule at
  // the moment the edit crosses it, through `additionalContext`, once.
  //
  // The matcher is the cost control: this is the ONE hook whose question is
  // about writes and delegation, so the host filters the tools before the
  // script ever spawns. A Read or a Grep never reaches it.
  //
  // `Bash` DOES, and it took #775 to get here. The script's own `case` has
  // accepted `Bash` since #722 A4 — because a `Bash` that writes is a write,
  // and 80.4% of the park's 41,889 measured tool calls are Bash, so through the
  // native lane alone the threshold was effectively unreachable — but this
  // matcher never gained it. The host filters BEFORE spawning, so that branch
  // shipped and never once executed: the fix was inert from the commit that
  // introduced it, and the count this hook reported was the native lane only.
  // Measured across 126 sessions, connecting the lane takes threshold crossings
  // from 19 to 40 — 21 sessions (52.5%) that were invisible.
  //
  // The lane is not free, and the script earns it rather than this matcher
  // narrowing it back: `routing-watch.sh` gates the Bash lane behind a
  // fork-free write probe placed before anything that locates a stamp, so a
  // shell command that writes nothing costs exactly what a `Read` costs today.
  // `hook-matcher-wiring.test.ts` is what keeps the pair honest from here —
  // it derives the accepted tools from the script and fails if this matcher
  // stops delivering one of them.
  //
  // Advisory by construction (the script has no `exit 2` path).
  settings = deepMerge(settings, {
    hooks: {
      PostToolUse: [
        {
          matcher: "Bash|Edit|Write|NotebookEdit|Agent|Task",
          hooks: [
            {
              type: "command",
              command: claudeHookCommand(
                "PostToolUse",
                ROUTING_WATCH_HOOK_DEST,
                "claude-post-tool-use",
              ),
              // 30, not 10: the Bash success lane fingerprints the tree
              // (spec 0039 D5). Free on the normal path; it only bounds a hang.
              timeout: 30,
              statusMessage: "navori: routing check",
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
                command: claudeHookCommand("PreToolUse", QG_HOOK_DEST),
                // Command hooks fail open when Claude kills them on timeout.
                // 600s is Claude's documented default and leaves 3.8× the
                // slowest measured fast gate (158s) before it can bypass us.
                timeout: 600,
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
  // progress/current.md) whenever a session opens, so resuming is
  // deterministic. Claude-only: Codex lifecycle hooks are still experimental,
  // so the asset renders under .codex/hooks/ but is not wired there yet.
  //
  // ALL FIVE documented sources, and `clear`/`fork` are the two that were
  // missing (#774). They are not the edge cases — `/clear` ERASES the context,
  // which makes it the moment that needs the re-injection most, and a forked
  // session starts from a copy nobody re-primed. The park showed the
  // incoherence plainly: a plugin's own `SessionStart` hook registers with NO
  // matcher, so a `/clear`ed session got that plugin's notice and none of the
  // harness doctrine. The list is spelled out rather than dropped so that adding a
  // sixth source is a decision somebody makes, not one that happens.
  settings = deepMerge(settings, {
    hooks: {
      SessionStart: [
        {
          matcher: "startup|resume|clear|compact|fork",
          hooks: [
            {
              type: "command",
              command: claudeHookCommand("SessionStart", SESSION_START_HOOK_DEST),
              timeout: 15,
              statusMessage: "navori: session context",
            },
          ],
        },
      ],
    },
  });

  // Audit-mode hooks. Registered unconditionally but INERT until a session
  // opts in by phrase — and even then the trigger only ASKS Claude to confirm
  // with the user; it never activates recording on its own, so a spurious
  // phrase match costs one question and leaves nothing on disk.
  //
  // Deliberately confined to UserPromptSubmit + SessionEnd. A PostToolUse hook
  // would fire thousands of times per session; these fire once per typed
  // prompt and once at the end. Both are fail-open: any error exits 0.
  settings = deepMerge(settings, {
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: "command",
              command: claudeHookCommand("UserPromptSubmit", AUDIT_TRIGGER_HOOK_DEST),
              timeout: 10,
              statusMessage: "navori: audit-mode",
            },
          ],
        },
      ],
      SessionEnd: [
        {
          hooks: [
            {
              type: "command",
              command: claudeHookCommand("SessionEnd", AUDIT_CLOSE_HOOK_DEST),
              timeout: 10,
              statusMessage: "navori: audit-mode close",
            },
            // #527: sweep agent worktrees whose work provably survived. It
            // shares this event because the answer only exists at the end —
            // when a subagent stops its PR usually does not exist yet, so
            // nothing could prove the branch was safe to drop.
            //
            // #805: the two `timeout` values below are NOT independent lanes.
            // Per the official docs, SessionEnd hooks share a single execution
            // budget (1.5s by default) that Claude Code raises to match the
            // highest per-hook `timeout` declared here, capped at 60s — so
            // `audit-mode-close` (10) and this hook (30) share 30s TOTAL, not
            // 10+30 in series. The 30 exists to raise that shared ceiling high
            // enough for this hook's `gh` calls; `audit-mode-close` free-rides
            // on it and does not get 10 extra seconds of its own.
            {
              type: "command",
              command: claudeHookCommand("SessionEnd", WORKTREE_RECLAIM_HOOK_DEST),
              timeout: 30,
              statusMessage: "navori: reclaim worktrees",
            },
          ],
        },
      ],
    },
  });

  // The handoff validator (N1) — advisory, never `decision: block`. Always
  // registered, no config dependency, like the guard/session-start above: it
  // flags empty/broken `impl_*`/`review_*` handoffs. Stop is opt-in
  // (`config.hooks.verifyOnStop`) below. Claude-only: Codex lifecycle hooks are
  // still experimental, so the assets render under .codex/hooks/ but aren't
  // wired there yet (same as session-start).
  //
  // WHY PostToolUse(`Agent|Task`) AND NOT SubagentStop (#774). The audience of
  // this note is the LEADER — the session that consolidates the handoff — and
  // the host's doc draws the line for exactly this case: on SubagentStop the
  // `additionalContext` goes to the subagent that just stopped (it keeps it
  // running), and "to inject context into the parent session after a subagent
  // returns, use a `PostToolUse` hook on the `Agent` tool instead." Registered
  // on SubagentStop the hook could only ever reach the human, through
  // `systemMessage` ("Warning message shown to the user"), while its text asked
  // the model to act.
  //
  // The move also fixes the firing rate #560 measured: SubagentStop fired 117
  // times for 19 subagents in one session, every one of them re-reporting the
  // same handoff. A PostToolUse on the Agent tool fires exactly once per
  // return.
  //
  // `Agent|Task` and not just `Agent`: matchers are an exact list, and the tool
  // is named `Task` on the hosts that predate the rename — a one-token matcher
  // would be a hook that silently never runs on half the park.
  settings = deepMerge(settings, {
    hooks: {
      PostToolUse: [
        {
          matcher: "Agent|Task",
          hooks: [
            {
              type: "command",
              command: claudeHookCommand("PostToolUse", SUBAGENT_STOP_HOOK_DEST),
              timeout: 15,
              statusMessage: "navori: handoff check",
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
                command: claudeHookCommand("Stop", STOP_HOOK_DEST),
                timeout: 15,
                statusMessage: "navori: verify-before-done",
              },
            ],
          },
        ],
      },
    });
  }

  settings = dropUnregisteredCoreHooks(settings, new Set(plan.hooks.map((hook) => hook.id)));

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

  // Spec 0035 D5/T6 (R9): the final `permissions.allow`/`.ask`/`.deny` triple
  // comes from `collectShellPermissionRules`, the single source Codex's
  // `buildCodexRules` also reads — pre-approving the exact commands this
  // repo's quality gate runs plus the package-manager dev-loop scripts, so
  // `pnpm test` / `pnpm build` / the gate itself and `git commit` stop
  // prompting on every run. Safe by construction: each derived rule is a
  // boundary-enforcing prefix (`…:*`), Claude Code won't auto-approve a
  // compound like `pnpm build && rm -rf x` from a prefix rule, and the
  // guard-destructive hook (exit 2) still precedes permission checks.
  // Overwrites whatever `settings.permissions` accumulated from the base file
  // and plugin fragments above — `collectShellPermissionRules` re-derives the
  // same merge (base → plugin fragments → derived allow), byte for byte.
  const rules = collectShellPermissionRules(config, plugins);
  settings = deepMerge(settings, {
    permissions: { allow: [...rules.allow], ask: [...rules.ask], deny: [...rules.deny] },
  });

  // The guard (1b), quality-gate (2) and plugin hooks each deep-merge their own
  // `{matcher:"Bash", hooks:[...]}`, which concat into redundant matcher buckets
  // (e.g. two `matcher:"Bash"` entries → a Bash command pays two matcher
  // evaluations). Collapse buckets sharing an event+matcher into one so Claude
  // sees a single bucket per matcher — same intent as pluginHooksToClaudeShape,
  // now across all layers.
  return coalesceHookMatchers(settings);
}

/** Inventory for callers that only have plugins: the full Claude plan for `config`, filtered. */
function legacyInventory(config: NavoriConfig, plugins: LoadedPlugin[]): FilteredInventory {
  const plan = resolveHarnessPlan(config, resolve(getCoreRoot(), "core-assets"), null, {
    includeOrchestrator: true,
    includeClaudeOnlySkills: true,
    includeClaudeOnlyHooks: true,
  });
  return filterInventory({ plan, plugins }, "claude");
}

const CORE_HOOK_COMMAND = /\.claude\/hooks\/([a-z0-9-]+)\.sh/;

/**
 * Remove every core-hook registration whose id is not in `registered` (the
 * filtered inventory's hook ids). Core hooks live at `.claude/hooks/<id>.sh`;
 * plugin hooks live under `.claude/scripts/` and are never touched here. Done
 * as one pass over the finished core registrations, so a hook with several
 * events (model-advisor) cannot be half-removed.
 */
function dropUnregisteredCoreHooks(
  settings: Record<string, unknown>,
  registered: ReadonlySet<string>,
): Record<string, unknown> {
  const hooks = settings.hooks;
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) return settings;
  const kept: Record<string, unknown> = {};
  for (const [event, entries] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(entries)) {
      kept[event] = entries;
      continue;
    }
    const groups = entries.flatMap((entry: unknown) => {
      const inner = (entry as { hooks?: unknown } | null)?.hooks;
      if (!Array.isArray(inner)) return [entry];
      const live = inner.filter((hook: unknown) => {
        const command = (hook as { command?: unknown } | null)?.command;
        const id = typeof command === "string" ? CORE_HOOK_COMMAND.exec(command)?.[1] : undefined;
        return id === undefined || registered.has(id);
      });
      return live.length === 0 ? [] : [{ ...(entry as object), hooks: live }];
    });
    if (groups.length > 0) kept[event] = groups;
  }
  return { ...settings, hooks: kept };
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
    // A plugin script is rendered into the repo like a core hook, so it can be
    // left unparseable by the same conflict; any other command shape is the
    // plugin's own and passes through verbatim.
    const plain = PLAIN_HOOK_COMMAND_RE.exec(h.command);
    const command = plain ? claudeHookCommand(h.event, plain[1]!, plain[2]) : h.command;
    const inner: Record<string, unknown> = { type: "command", command };
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
