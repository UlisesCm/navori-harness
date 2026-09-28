# Spec 0035 D2 — the single payload adapter shared by every hook that needs an
# engine-specific value. Inlined into each hook at render time (see the
# include directive in the source scripts + lib/render/hook-includes.ts).
# Single source of truth for the Claude/Codex normalization; DO NOT copy this
# body back into a hook by hand or branch on the engine inside a hook — D2
# rejected per-script `if codex …` branches (12 copies of the same logic,
# each one a place to drift).
#
# `nv_engine` is decided by WHERE THE HOOK SCRIPT LIVES ON DISK, not by the
# payload's shape (a `turn_id`/`apply_patch` sniff breaks the day Claude ships
# a field with the same name — see design.md's "Descartado") and not by an
# env var prefix on the registered command (that would change the `command`
# string Codex hashes for `trusted_hash`, un-approving every hook a repo
# already trusted — see hook-registrations.ts's module doc). The registered
# command is always `bash ".../.codex/hooks/<script>.sh"` or
# `bash "$CLAUDE_PROJECT_DIR/.claude/hooks/<script>.sh"`. `$0` — not
# `BASH_SOURCE`, which zsh (#391: hooks run under bash AND zsh) leaves unset
# under `set -u` — is the path the invoking shell was given, and
# `comment-draft-confirm.sh` already established this exact pattern.
#
# Depends on `payload`/`payload_field` (the `extract-cmd` partial): include
# `extract-cmd` in the same script whenever this partial's helpers are used —
# `payload_field` is only CALLED here (inside functions), never at top level,
# so include order between the two partials does not matter.
case "$0" in
  *".codex/hooks/"*) nv_engine=codex ;;
  *) nv_engine=claude ;;
esac

if [ "$nv_engine" = codex ]; then
  nv_cwd=$(payload_field cwd)
  # `cwd` is the session's working dir, which may be a workspace subdir in a
  # monorepo; the project root is always the git toplevel from there. Falls
  # back to the raw cwd outside a git work tree rather than failing closed.
  nv_project_dir=$(git -C "${nv_cwd:-.}" rev-parse --show-toplevel 2>/dev/null) || nv_project_dir=${nv_cwd:-.}
else
  nv_project_dir=${CLAUDE_PROJECT_DIR:-}
fi

# Runtime handoffs have one engine-neutral home. The caller composes this
# relative path with its checkout root; legacy roots remain readable only.
nv_progress_dir=".navori/state/handoffs"

# The Claude-equivalent tool name for the CURRENT PreToolUse/PostToolUse
# payload (D2: apply_patch -> Edit, spawn_agent -> Agent, everything else
# unchanged — `mcp__…` names and `Bash` already match on both engines).
nv_tool() {
  local raw
  raw=$(payload_field tool_name)
  if [ "$nv_engine" = codex ]; then
    case "$raw" in
      apply_patch) printf 'Edit' ;;
      spawn_agent) printf 'Agent' ;;
      *) printf '%s' "$raw" ;;
    esac
  else
    printf '%s' "$raw"
  fi
}

# Paths the current tool call touches, one per line (possibly none). Claude
# carries them as `tool_input.file_path` / `tool_input.notebook_path`; Codex's
# `apply_patch` has no such field — the whole patch is `tool_input.command`,
# and the paths live in its `*** Add File:` / `*** Update File:` /
# `*** Delete File:` / `*** Move to:` headers (codex-rs's apply_patch parser).
nv_edited_paths() {
  if [ "$nv_engine" = codex ]; then
    payload_field tool_input.command | sed -nE \
      's/^\*\*\* (Add File|Update File|Delete File|Move to): (.*)$/\2/p'
  else
    local fp nb
    fp=$(payload_field tool_input.file_path)
    nb=$(payload_field tool_input.notebook_path)
    [ -n "$fp" ] && printf '%s\n' "$fp"
    [ -n "$nb" ] && printf '%s\n' "$nb"
  fi
}

# The subagent type of the current call. Claude: `tool_input.subagent_type`
# (PreToolUse Agent/Task). Codex: `tool_input.agent_type` in PreToolUse
# (spawn_agent), or the top-level `agent_type` Codex adds to SubagentStop.
nv_subagent_type() {
  if [ "$nv_engine" = codex ]; then
    local t
    t=$(payload_field tool_input.agent_type)
    [ -n "$t" ] || t=$(payload_field agent_type)
    printf '%s' "$t"
  else
    payload_field tool_input.subagent_type
  fi
}

# Deliberately NO `nv_emit_context` helper here. `hook-output-contract.test.ts`
# ("los partials no hablan con el host, solo escriben al log") holds every
# `_partials/*.sh` file to zero host-output vocabulary — a partial is inlined
# BEFORE the per-script, per-event output contract is known, so it must never
# construct `hookSpecificOutput`/`systemMessage` itself. Every hook this spec
# touches already builds its own JSON at its own call site (unchanged by D2);
# a script whose Claude/Codex registrations differ in event name (D1: e.g.
# `subagent-stop-handoff` is PostToolUse under Claude, SubagentStop under
# Codex) is unaffected in practice — Codex does not honor `additionalContext`
# on `SubagentStop` at all (codex-research.md), so `systemMessage` is what a
# human sees there regardless of which literal `hookEventName` the JSON claims.
