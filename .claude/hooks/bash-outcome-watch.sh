# navori:managed start id="bash-outcome-watch-base" hash="2874b09e" version="0.11.2" source="@navori/core"
#!/usr/bin/env bash
# PostToolUseFailure(Bash) advisory. The shared state helper also handles reset
# from routing-watch on a successful PostToolUse(Bash).
set -uo pipefail
# Shared hook boilerplate — inlined into each hook at render time (see the
# include directive in the source scripts + lib/render/hook-includes.ts). Single source
# of truth for the sibling gate scripts; DO NOT copy this body back into a hook
# by hand (that is the drift #225/#261 removed).
#
# PreToolUse(Bash) passes the tool input on stdin. Read one field out of it
# WITHOUT hard-depending on jq (NOT preinstalled on macOS): try jq, then node
# (Claude Code's own runtime), then a best-effort sed unwrap on the leaf key.
# Nothing extracted → empty output, and each caller decides what that means (the
# gate scripts scan defensively; guard-destructive waves the command through).
#
# $1 is a dotted path written HERE, never user input — the payload is the data.
# Generic on purpose: `.cwd` feeds the worktree resolver of #454 through the
# SAME hardened cascade instead of a second copy of it.
#
# The sed fallback reads a JSON string through its first unescaped quote. JSON
# object member order is not a host contract: `command` can precede `cwd`, so a
# greedy capture to the last quote would swallow the rest of the payload when
# neither jq nor node is available.
# `${payload-$(cat)}` (unset test, not `:-`) rather than an unconditional
# `payload=$(cat)`: a caller that already captured stdin itself (spec 0035 —
# `managed-drift-watch.sh` needs the audit recorder's session_id/cwd even on
# tool names this hook does not otherwise read) keeps that value, empty or
# not, instead of this partial re-reading an already-drained pipe and
# clobbering it with "".
payload=${payload-$(cat)}
payload_field() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$payload" | jq -r ".$1 // empty" 2>/dev/null && return 0
  fi
  if command -v node >/dev/null 2>&1; then
    printf '%s' "$payload" | node -e 'let s="";const p=process.argv[1].split(".");process.stdin.on("data",c=>s+=c).on("end",()=>{try{let v=JSON.parse(s);for(const k of p)v=v?.[k];process.stdout.write(String(v??""))}catch{}})' "$1" 2>/dev/null && return 0
  fi
  printf '%s' "$payload" | sed -nE "s/.*\"${1##*.}\"[[:space:]]*:[[:space:]]*\"(([^\"\\]|\\.)*)\".*/\\1/p"
}
extract_cmd() {
  payload_field tool_input.command
}
# NOT called here on purpose. `payload_field` may spawn a process, and
# `routing-watch.sh` — which includes this partial and runs after EVERY tool call
# in every session — never reads `cmd`. Each consumer that wants it calls
# `extract_cmd` itself, at the point where it already knows it needs it.
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

# The agent a spawn call TARGETS, never the one that makes the call (spec 0041
# H16). Claude: `tool_input.subagent_type`. Codex PreToolUse/PostToolUse of a
# spawn: `tool_input.agent_type` only — the top-level `agent_type` there is the
# CALLER's. On `SubagentStop` the top-level `agent_type` IS the finishing
# subagent, so that event reads it instead.
nv_spawn_target_type() {
  if [ "$nv_engine" = codex ]; then
    case "$(payload_field hook_event_name)" in
      SubagentStop) payload_field agent_type ;;
      *) payload_field tool_input.agent_type ;;
    esac
  else
    payload_field tool_input.subagent_type
  fi
}

# The agent RUNNING the current event: the top-level `agent_type`, which the
# host adds only inside a subagent (empty on the main thread). Never confuse it
# with `nv_spawn_target_type` (H16). `nv_subagent_type` above keeps its legacy
# mixed behaviour for existing hooks; new code uses these two helpers.
nv_event_agent_type() {
  payload_field agent_type
}

# True for the spawn tool: Codex V1 `spawn_agent`, or any V2 name that ends in
# `spawn_agent` (V2 flattens the namespace into the tool name).
nv_is_spawn_tool() {
  case "$(payload_field tool_name)" in
    *spawn_agent) return 0 ;;
    *) return 1 ;;
  esac
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
# Shared Bash-outcome helpers (spec 0039 R6/R7, carry-over 0038 D1) — inlined at
# render time. Defines functions only: nothing runs on include, so a hook that
# carries this partial pays parse time and no process.
#
# Depends on `payload`/`payload_field` (`extract-cmd`) and `nv_project_dir` /
# `nv_progress_dir` (`hook-input`); include both in the same script.
#
# THE SUCCESS LANE. The host runs a criterion's `command` in its own Bash tool;
# `PostToolUse` fires only on success, so this lane's very firing is the success
# signal. It appends ONE line per matching pending criterion to
# `<state dir>/workplan_<feature>.evidence.jsonl`, which `plan update` compares
# against the criterion and the current tree (`lib/plan/evidence.ts`). It never
# runs the criterion's command and never writes anything but that line.
#
# FAIL-OPEN, NO PARTIAL LINE. Every path returns 0. The line is built entirely in
# memory and written by a single `printf >>` as the LAST step, so a kill at any
# earlier point (the tree fingerprint is the slow part) leaves no line at all and
# `plan update` rejects with "no run recorded".
#
# FAST PATH, BUILTINS ONLY. `acceptance-index` (rewritten by the CLI) holds
# `<command JSON-escaped>\t<feature>\t<A<n>>\t<state dir>` per pending
# criterion. The command is matched as the EXACT JSON string value of
# `"command"` in the raw payload — no decoding, no normalization, no process.
# A `tool_response` cannot forge a match: inside it every quote is `\"`.

# Git with the repo-controlled code paths neutralized (invariant 9): fsmonitor is
# a command git runs on index refresh, hooksPath redirects hooks. Same flags as
# `GIT_HARDENING` in `lib/plan/evidence.ts`.
navori_git() {
  git -c core.fsmonitor=false -c core.hooksPath=/dev/null "$@"
}

# Content hash of the whole working tree — the SAME procedure as
# `fingerprintTree` in `lib/plan/evidence.ts`, which `plan update` re-runs to
# compare (change one, change both): no `git add` (filters/fsmonitor), blobs by
# `hash-object --no-filters`, a scratch index, `write-tree`. Prints the tree hash
# or returns 1. Exec bit is `[ -x ]` where the TypeScript side tests
# `mode & 0o111`; they differ only for a file executable by group/other but not
# by its owner, which then fails safe (plan update asks for a rerun).
navori_tree_fingerprint() {
  (
    cd "$1" 2>/dev/null || exit 1
    scratch=$(navori_git rev-parse --path-format=absolute --git-path navori-fp-index 2>/dev/null) || exit 1
    [ -n "$scratch" ] || exit 1
    [ ! -e "$scratch.lock" ] || exit 1
    work=$(mktemp -d "${TMPDIR:-/tmp}/navori-fp.XXXXXX" 2>/dev/null) || exit 1
    trap 'rm -f "$work"/list "$work"/files "$work"/links "$work"/paths "$work"/shas; rmdir "$work" 2>/dev/null' EXIT
    navori_git ls-files -z --cached --others --exclude-standard --deduplicate -- . \
      ':(exclude).navori/state' ':(exclude).claude/progress' ':(exclude).codex/progress' \
      ':(exclude).claude/worktrees' > "$work/list" 2>/dev/null || exit 1
    : > "$work/links"
    while IFS= read -r -d '' p; do
      case "$p" in *$'\n'*) exit 1 ;; esac
      if [ -L "$p" ]; then
        target=$(readlink "./$p") || exit 1
        sha=$(printf '%s' "$target" | navori_git hash-object -w --no-filters --stdin 2>/dev/null) || exit 1
        [ -n "$sha" ] || exit 1
        printf '120000 %s\t%s\n' "$sha" "$p" >&3
      elif [ -f "$p" ]; then
        if [ -x "$p" ]; then mode=100755; else mode=100644; fi
        printf '%s\t%s\n' "$mode" "$p"
      fi
    done < "$work/list" > "$work/files" 3>> "$work/links"
    if [ -s "$work/files" ]; then
      cut -f2- "$work/files" > "$work/paths"
      navori_git hash-object -w --no-filters --stdin-paths < "$work/paths" > "$work/shas" 2>/dev/null || exit 1
      [ "$(wc -l < "$work/paths" | tr -d ' ')" = "$(wc -l < "$work/shas" | tr -d ' ')" ] || exit 1
      awk -F'\t' 'NR==FNR { m[FNR]=$1; p[FNR]=substr($0, index($0, "\t")+1); next } { printf "%s %s\t%s\n", m[FNR], $0, p[FNR] }' \
        "$work/files" "$work/shas" >> "$work/links" || exit 1
    fi
    export GIT_INDEX_FILE=$scratch
    navori_git read-tree --empty >/dev/null 2>&1 || exit 1
    if [ -s "$work/links" ]; then
      tr '\n' '\0' < "$work/links" | navori_git update-index --add -z --index-info >/dev/null 2>&1 || exit 1
    fi
    navori_git write-tree 2>/dev/null
  )
}

# Escapes backslash and double quote for a JSON string value; prints it.
navori_json_str() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  printf '%s' "$s"
}

# Repeat-failure state is shared by the PostToolUseFailure watcher and the
# existing success lane. A successful Bash call only pays for Node when its
# session already has a failure-state file; ordinary calls use builtins only.
#
# `action` is `reset`/`failure` (Claude: the event says which) or `codex`
# (spec 0041 T12: Codex fires PostToolUse on failure too, so the OUTCOME is read
# from the rollout, `$2` = its path, `$3` = the call's `tool_use_id`).
navori_bash_failure_state() {
  local action=$1 sid=${CLAUDE_CODE_SESSION_ID:-} dir file
  if [ "$action" = codex ]; then
    navori_plain_field session_id
    sid=$navori_field
  fi
  case "$sid" in "" | *[!A-Za-z0-9._-]*) return 0 ;; esac
  [ -n "${nv_project_dir:-}" ] || return 0
  dir=$nv_project_dir/.navori/state/hooks/bash-outcome-watch
  file=$dir/$sid
  if [ "$action" = reset ]; then
    [ -f "$file" ] && [ ! -L "$file" ] || return 0
  fi
  command -v node >/dev/null 2>&1 || return 0
  NV_BASH_OUTCOME_ACTION=$action NV_BASH_OUTCOME_DIR=$dir NV_BASH_OUTCOME_FILE=$file \
    NV_BASH_OUTCOME_SID=$sid NV_BASH_OUTCOME_TRANSCRIPT=${2:-} NV_BASH_OUTCOME_TOOL_USE=${3:-} \
    NV_BASH_OUTCOME_ROOT=$nv_project_dir node -e '
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const env = process.env;
// Codex outcome (spec 0041 T12): the exit code of THIS call lives in the rollout
// record `event_msg`/`item_completed` whose `item.id` is the `tool_use_id` of the call
// (probe V4). Bounded to the tail of the file; only `exit_code` is read, never
// the output fields. Anything missing or unreadable -> null -> silence.
const codexExit = () => {
  const max = 1048576;
  const fd = fs.openSync(env.NV_BASH_OUTCOME_TRANSCRIPT, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, max);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes(env.NV_BASH_OUTCOME_TOOL_USE) || !line.includes("item_completed")) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const item = record?.payload?.item;
      if (record?.type !== "event_msg" || record?.payload?.type !== "item_completed") continue;
      if (item?.type !== "CommandExecution" || item?.id !== env.NV_BASH_OUTCOME_TOOL_USE) continue;
      return Number.isInteger(item.exit_code) ? item.exit_code : null;
    }
    return null;
  } finally { fs.closeSync(fd); }
};
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(input);
    if (payload.tool_name !== "Bash" || payload.session_id !== env.NV_BASH_OUTCOME_SID) return;
    if (payload.is_interrupt === true || payload.tool_response?.is_interrupt === true) return;
    const command = payload.tool_input?.command;
    const cwd = payload.cwd;
    if (typeof command !== "string" || !command.trim() || typeof cwd !== "string" || !cwd) return;
    const agent = typeof payload.agent_id === "string" ? payload.agent_id : "";
    let action = env.NV_BASH_OUTCOME_ACTION;
    let exitCode = null;
    if (action === "codex") {
      exitCode = codexExit();
      if (exitCode === null) return;
      action = exitCode === 0 ? "reset" : "failure";
    }
    const key = digest(JSON.stringify([command.trim().replace(/\s+/g, " "), cwd, agent]));
    const root = path.resolve(env.NV_BASH_OUTCOME_ROOT);
    const dir = env.NV_BASH_OUTCOME_DIR;
    const file = env.NV_BASH_OUTCOME_FILE;
    if (dir !== path.join(root, ".navori/state/hooks/bash-outcome-watch")) return;
    for (const component of [root, path.join(root, ".navori"), path.join(root, ".navori/state"), path.join(root, ".navori/state/hooks"), dir]) {
      if (fs.existsSync(component)) {
        if (!fs.lstatSync(component).isDirectory() || fs.lstatSync(component).isSymbolicLink()) return;
      } else if (action === "failure") {
        fs.mkdirSync(component);
      } else return;
    }
    if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())) return;
    let rows = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    if (!Array.isArray(rows) || rows.some((row) => typeof row.key !== "string" || typeof row.sig !== "string" || typeof row.count !== "number" || typeof row.epoch !== "number")) return;
    if (action === "reset") {
      const next = rows.filter((row) => row.key !== key);
      if (next.length === rows.length) return;
      rows = next;
    } else {
      const error = exitCode === null ? payload.error : "";
      if (typeof error !== "string") return;
      const match = exitCode === null ? /exit code\s+(\d+)/i.exec(error) : [null, String(exitCode)];
      if (!match) return;
      const code = match[1];
      const escapedRoot = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const home = env.HOME ? env.HOME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : null;
      const body = error.replace(/^.*exit code\s+\d+.*\r?\n?/im, "")
        .replace(/\x1b\[[0-9;]*m/g, "")
        .replace(new RegExp(escapedRoot, "g"), "<root>")
        .replace(home ? new RegExp(home, "g") : /\b(?!x)x\b/g, "~")
        .replace(/(?:\/tmp|\/private\/tmp|\/var\/folders)\/[^\s:]+/g, "<tmp>")
        .replace(/\b\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?Z?\b/g, "<t>")
        .replace(/\b\d\d:\d\d:\d\d(?:\.\d+)?\b/g, "<t>")
        .replace(/\b\d+(?:\.\d+)?\s?(?:ms|seconds?|minutes?)\b/gi, "<d>")
        .replace(/\b[0-9a-f]{8,}\b/gi, "<h>")
        .split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 20).join("\n");
      if (!body && exitCode === null) return;
      const sig = digest(code + "\n" + body);
      const previous = rows.find((row) => row.key === key);
      const count = previous?.sig === sig ? Math.min(previous.count + 1, 3) : 1;
      const notified = previous?.sig === sig && previous.notified === true;
      rows = rows.filter((row) => row.key !== key);
      rows.push({ key, sig, count, notified: notified || count === 3, epoch: Date.now() });
      if (count === 3 && !notified) {
        const first = body.split("\n")[0].slice(0, 100);
        const note = `navori: el comando ${command.trim().slice(0, 100)} falló 3 veces con la misma firma (exit ${code}${first ? ": " + first : ""}). Cambia de enfoque con debug-failure o escala al usuario. Si el rojo es intencional, ignora esta nota.`;
        var output = note.slice(0, 400);
      }
    }
    rows.sort((a, b) => b.epoch - a.epoch);
    rows = rows.slice(0, 50);
    const temp = file + "." + process.pid + ".tmp";
    fs.writeFileSync(temp, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, file);
    if (output) process.stdout.write(output + "\n");
  } catch { /* advisory: never change the tool result */ }
});
' <<< "$payload" 2>/dev/null || true
  return 0
}

# A plain top-level string field of the raw payload, with builtins only (no
# fork), into `navori_field`. Matches `"key":"value"` with an unescaped quote
# before the colon, which a `tool_response` cannot forge (inside it every quote is
# `\"`). Empty when absent, spaced or escaped: the caller treats that as silence.
navori_plain_field() {
  local needle="\"$1\":\"" rest
  navori_field=
  case "$payload" in *"$needle"*) ;; *) return 0 ;; esac
  rest=${payload#*"$needle"}
  navori_field=${rest%%\"*}
  case "$navori_field" in *\\*) navori_field= ;; esac
  return 0
}

# Spec 0041 T12 (R11): the Codex Bash outcome lane, run by `routing-watch.sh`
# on `PostToolUse(Bash)` under Codex. Codex fires PostToolUse on failure too, so
# the exit code is read from the rollout (`transcript_path`): a fixed-string grep
# over the BOUNDED tail finds the `item_completed` record of this `tool_use_id`.
# A success with no failure state costs no Node; everything else (a failure, or a
# success that must reset a counter) goes through `navori_bash_failure_state`,
# which parses only `exit_code`. FAIL-OPEN and silent: no rollout, no matching
# record or an unreadable one means no advice. Prints the advice, if any.
navori_bash_codex_outcome() {
  local tid tp sid line
  navori_plain_field tool_use_id
  tid=$navori_field
  navori_plain_field transcript_path
  tp=$navori_field
  navori_plain_field session_id
  sid=$navori_field
  case "$tid" in "" | *[!A-Za-z0-9._:-]*) return 0 ;; esac
  case "$sid" in "" | *[!A-Za-z0-9._-]*) return 0 ;; esac
  case "$tp" in *.jsonl) ;; *) return 0 ;; esac
  [ -f "$tp" ] && [ -r "$tp" ] || return 0
  line=$(tail -c 1048576 "$tp" 2>/dev/null | grep -F -- "$tid" 2>/dev/null | grep -F '"item_completed"' 2>/dev/null | tail -n 1)
  [ -n "$line" ] || return 0
  case "$line" in
    *'"exit_code":0,'* | *'"exit_code":0}'*)
      [ -f "${nv_project_dir:-}/.navori/state/hooks/bash-outcome-watch/$sid" ] || return 0
      ;;
  esac
  navori_bash_failure_state codex "$tp" "$tid"
  return 0
}

# Called by `routing-watch.sh` once it knows the tool is `Bash`, and only under
# `claude-post-tool-use` (Codex fires PostToolUse on failure too, so no signal).
navori_bash_success_lane() {
  local idx=$nv_project_dir/$nv_progress_dir/acceptance-index
  [ -s "$idx" ] || return 0
  # A backgrounded call "succeeds" when it LAUNCHES, not when it finishes; an
  # interrupted one did not complete.
  case "$payload" in
    *'"run_in_background":true'* | *'"interrupted":true'*) return 0 ;;
  esac
  local c f i d hits=
  while IFS=$'\t' read -r c f i d; do
    [ -n "$c" ] || continue
    case "$payload" in
      *'"command":"'"$c"'"'[,}]*) hits="$hits$c"$'\t'"$f"$'\t'"$i"$'\t'"$d"$'\n' ;;
    esac
  done < "$idx"
  [ -n "$hits" ] || return 0

  # Slow path: exactly one criterion command ran. Everything is computed first,
  # the write is last.
  local cwd tree head wt htree dirty sid agent ts root
  cwd=$(payload_field cwd)
  [ -n "$cwd" ] || return 0
  tree=$(navori_git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || return 0
  case "$cwd$tree" in *[[:cntrl:]]*) return 0 ;; esac
  head=$(navori_git -C "$tree" rev-parse HEAD 2>/dev/null) || head=
  wt=$(navori_tree_fingerprint "$tree") || return 0
  [ -n "$wt" ] || return 0
  htree=$(navori_git -C "$tree" rev-parse 'HEAD^{tree}' 2>/dev/null) || htree=
  dirty=true
  [ "$wt" = "$htree" ] && dirty=false
  sid=$(payload_field session_id | tr -cd 'A-Za-z0-9._-')
  agent=$(payload_field agent_id | tr -cd 'A-Za-z0-9._-')
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  root=$(pwd -P 2>/dev/null) || root=$nv_project_dir

  local line extra file
  while IFS=$'\t' read -r c f i d; do
    [ -n "$f" ] || continue
    # The index is CLI-written state, but the hook is the one that opens a path
    # taken from it: slug and id shapes, an absolute directory inside this
    # project, no symlinks.
    case "$f" in *[!a-z0-9._-]* | [!a-z0-9]*) continue ;; esac
    case "$i" in
      A[0-9]*) case "${i#A}" in *[!0-9]*) continue ;; esac ;;
      *) continue ;;
    esac
    case "$d" in "$root"/* | "$nv_project_dir"/*) ;; *) continue ;; esac
    case "$d" in *[[:cntrl:]]* | */../* | */..) continue ;; esac
    [ -d "$d" ] && [ ! -L "$d" ] || continue
    file=$d/workplan_$f.evidence.jsonl
    [ ! -L "$file" ] || continue
    # `$c` is already JSON-escaped: it is the index's own field.
    extra=
    [ -z "$sid" ] || extra=$extra',"sessionId":"'$sid'"'
    [ -z "$agent" ] || extra=$extra',"agentId":"'$agent'"'
    line='{"ts":"'$ts'","feature":"'$f'","id":"'$i'","command":"'$c'","tree":"'$(navori_json_str "$tree")'","cwd":"'$(navori_json_str "$cwd")'","head":"'$head'","worktreeTree":"'$wt'","dirty":'$dirty$extra'}'
    printf '%s\n' "$line" >> "$file" 2>/dev/null || true
  done <<NAVORI_HITS
$hits
NAVORI_HITS
  return 0
}
navori_audit_name="bash-outcome-watch"
navori_audit_phase="PostToolUseFailure"
navori_audit_begin() { :; }
navori_audit_log() { :; }
# Shared audit repository resolver (#764) — inlined into every audit hook at
# render time. A nested agent worktree lives below the repository's
# `.claude/worktrees/` directory, but its basename is an ephemeral agent id.
#
# navori_audit_repo_from_cwd <cwd> — prints the stable parent repo name.
# This only uses shell builtins before the existing `basename` call: audit hooks
# run often, so discovering the Git common directory would add an avoidable fork
# per invocation.
navori_audit_repo_from_cwd() {
  navori_audit_repo_cwd=$1
  case "$navori_audit_repo_cwd" in
    */.claude/worktrees | */.claude/worktrees/*)
      navori_audit_repo_cwd=${navori_audit_repo_cwd%%/.claude/worktrees*}
      ;;
  esac
  basename "$navori_audit_repo_cwd" 2>/dev/null
}
# Shared advisory metadata recorder. The CLI is the single private-FD writer.
# No shell redirects, human content, or fallback writes are permitted here.
# Missing CLI or failed validation leaves an observation gap, never a hook failure.
# zsh replaces $0 with the function name; preserve the enclosing script identity.
navori_audit_script=$0
navori_audit_begin() {
  navori_audit_on=0
  navori_audit_root=${NAVORI_AUDITS_ROOT:-${HOME:-}/.navori/audits}
  [ -n "${HOME:-}${NAVORI_AUDITS_ROOT:-}" ] || return 0
  [ -d "$navori_audit_root" ] || return 0
  navori_audit_on=1
  navori_audit_t0=$(navori_audit_now)
}

navori_audit_now() {
  if [ -n "${EPOCHREALTIME:-}" ]; then
    # `1756... .123456` → milliseconds, with pure parameter expansion.
    navori_audit_epoch=${EPOCHREALTIME/,/.}
    printf '%s%s' "${navori_audit_epoch%%.*}" "$(printf '%.3s' "${navori_audit_epoch#*.}")"
    return 0
  fi
  perl -MTime::HiRes=time -e 'printf "%.0f", time*1000' 2>/dev/null \
    || printf '%s' $(( $(date +%s 2>/dev/null || echo 0) * 1000 ))
}

# Resolve one exact marker before invoking the metadata writer. Startup may
# offer a repo-scoped arm candidate; the CLI authoritatively validates private
# modes, ownership and header identity before either append or spool creation.
navori_audit_record_metadata() {
  [ -n "${payload:-}" ] || return 0
  navori_audit_root=${NAVORI_AUDITS_ROOT:-${HOME:-}/.navori/audits}
  [ -n "${HOME:-}${NAVORI_AUDITS_ROOT:-}" ] || return 0
  [ -d "$navori_audit_root" ] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  navori_audit_fields=$(printf '%s' "$payload" | jq -er '
    def id: type == "string" and length > 0 and length <= 256 and test("^[A-Za-z0-9_-]+$");
    select(.session_id | id) |
    [.session_id, (if (.cwd | type) == "string" then .cwd else "" end),
     ([.agent_id, .subagent_id] | map(select(id)) | first) // "orchestrator", "."] | .[]' 2>/dev/null) || return 0
  navori_audit_session=${navori_audit_fields%%
*}
  navori_audit_rest=${navori_audit_fields#*
}
  navori_audit_cwd=${navori_audit_rest%%
*}
  navori_audit_rest=${navori_audit_rest#*
}
  navori_audit_agent=${navori_audit_rest%%
*}
  [ -n "$navori_audit_cwd" ] || navori_audit_cwd=$PWD
  navori_audit_repo=$(navori_audit_repo_from_cwd "$navori_audit_cwd") || return 0
  case "$navori_audit_repo" in "" | . | .. | *[!A-Za-z0-9_.-]*) return 0 ;; esac
  navori_audit_file=$navori_audit_root/$navori_audit_repo/session-$navori_audit_session.log
  if [ ! -f "$navori_audit_file" ] || [ -L "$navori_audit_file" ]; then
    [ "${navori_audit_phase:-}" = SessionStart ] || return 0
    navori_audit_arm=$navori_audit_root/$navori_audit_repo/.armed
    [ -f "$navori_audit_arm" ] && [ ! -L "$navori_audit_arm" ] || return 0
  fi
  command -v navori >/dev/null 2>&1 || return 0
  case "${nv_engine:-}" in
    claude | codex) navori_audit_host=$nv_engine ;;
    *) case "$navori_audit_script" in *".codex/hooks/"* | *".codex/scripts/"*) navori_audit_host=codex ;; *) navori_audit_host=claude ;; esac ;;
  esac
  # The writer assigns eventId/wireVersion before first persistence. Replay
  # keeps those identifiers; this transport never generates replacement IDs.
  printf '%s' "$1" | navori audit --record-metadata --host "$navori_audit_host" \
    --root-session "$navori_audit_session" --repo "$navori_audit_repo" \
    --root "$navori_audit_root" >/dev/null 2>&1 || :
  return 0
}

# Only closed categories and bounded technical identifiers cross this bridge.
navori_audit_log() {
  [ "${navori_audit_on:-0}" = 1 ] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  if [ "${NAVORI_AUDIT_SKIP_NOOPS:-0}" = 1 ]; then
    case "${1:-}" in skip | noop) return 0 ;; esac
  fi
  navori_audit_end=$(navori_audit_now)
  [ "$navori_audit_end" -ge 0 ] 2>/dev/null || navori_audit_end=0
  navori_audit_ms=$(( navori_audit_end - ${navori_audit_t0:-$navori_audit_end} ))
  [ "$navori_audit_ms" -ge 0 ] 2>/dev/null || navori_audit_ms=0
  navori_audit_metadata=$(printf '%s' "${payload:-}" | jq -c \
    --arg name "${navori_audit_name:-unknown}" --arg phase "${navori_audit_phase:-unknown}" \
    --arg verdict "${1:-unknown}" --arg reason "${2:-}" \
    --arg tool "${navori_audit_tool:-}" --arg source "${navori_audit_source:-core}" \
    --arg kind "${3:-}" --argjson ms "$navori_audit_ms" --argjson tsMs "$navori_audit_end" '
    def id: type == "string" and length > 0 and length <= 256 and test("^[A-Za-z0-9_-]+$");
    def technical_label: if length <= 256 and test("^[A-Za-z0-9_.:-]+$") then . else "unknown" end;
    {event:"hook",name:($name|technical_label),source:($source|technical_label),ms:$ms,tsMs:$tsMs,
     phase:(if (["PreToolUse","PostToolUse","SessionStart","SessionEnd","Stop","SubagentStart","SubagentStop","UserPromptSubmit","PreCompact"]|index($phase)) != null then $phase else "unknown" end),
     verdict:(if (["allow","ask","block","deny","skip","noop","clean","dirty","inject","repeat","partial","compact-advice","gate-started","gate-killed"]|index($verdict)) != null then $verdict else "unknown" end),
     agentId:(([.agent_id,.subagent_id]|map(select(id))|first)//"orchestrator")}
     + (if (.tool_use_id|id) then {toolUseId:.tool_use_id} else {} end)
     + (if (["Bash","Edit","Read","Write","Agent","Task","NotebookEdit"]|index($tool)) != null then {tool:$tool} else {} end)
     + (if $reason != "" then {reason:"unspecified"} else {} end)
     + (if (["hard","ask","advisory"]|index($kind)) != null then {kind:$kind} else {} end)' 2>/dev/null) || return 0
  navori_audit_record_metadata "$navori_audit_metadata"
  return 0
}
navori_audit_begin
[ -n "${nv_project_dir:-}" ] || exit 0
advice=$(navori_bash_failure_state failure)
if [ -n "$advice" ]; then
  navori_audit_log "advise" "same Bash failure reached three consecutive occurrences"
  NV_ADVICE="$advice" node -e 'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PostToolUseFailure",additionalContext:process.env.NV_ADVICE}})+"\n")' 2>/dev/null || true
fi
exit 0
# navori:managed end id="bash-outcome-watch-base"
