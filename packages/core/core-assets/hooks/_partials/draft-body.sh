# Draft reader shared by every hook that shows the user WHAT is about to be published
# (`comment-draft-confirm`, and the Pi copy of `pr-publisher-confirm`, spec 0048 D5/R5).
# Inlined at render time (see lib/render/hook-includes.ts). Pure reading: it decides which
# file or inline text carries the body and renders a bounded preview; the JSON that speaks to
# the host stays in each script (partials never carry host output vocabulary).
#
# Needs, from the caller: `cmd`, `nv_kind` (gh-comment, gh-review, gh-issue-create, gh-pr-open,
# gh-api-graphql, gh-api-rest, acli-create, acli-update), `nv_label`, `NV_FALLBACK_REASON`, and
# `nv_have_jq` / `nv_have_node` (0 or 1). Defines only functions; nothing runs until
# `navori_draft_body` is called.
#
# `navori_draft_body` sets, as globals (the callers read them after the call):
#   nv_body_source  none | inline | gql-text | file
#   nv_reason       the text the user reads before confirming
#   nv_body_path    the body file named by the command, when there is one
#   nv_bound_file   every file the preview was read from, so a caller can bind the approval to
#                   its content (empty when the preview came from the command itself)

# --- Locate the flag value for a small set of alternatives (`-F|--body-file`,
# `--body-adf`, `--input`, …). Reads the WHOLE $cmd, so it only ever targets a
# flag whose VALUE is a file path — never a body carried inline in the command,
# which the codebase's own compound-command splitters (`gate-trigger.sh`) do
# not respect quoting for either; a file path does not contain `;`/`|`/`&&` in
# practice, so this stays safe where the inline case (never read this way)
# would not be.
nv_flag_value() {
  local text="$1" flags="$2" raw
  raw=$(printf '%s' "$text" | grep -oE "(^|[[:space:]])(${flags})(=|[[:space:]]+)('[^']*'|\"[^\"]*\"|[^[:space:]]+)" | head -1) || true
  [ -n "$raw" ] || return 0
  printf '%s' "$raw" | sed -E "s/^[[:space:]]*(${flags})(=|[[:space:]]+)//; s/^['\"]//; s/['\"]\$//"
}

nv_looks_like_json() {
  local t="${1#"${1%%[![:space:]]*}"}"
  case "$t" in
    "{"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Reads a bounded prefix of $1 into $nv_body_content. Returns 1 (never aborts
# under `set -e` — always called from an `if`/`||`) when the path is not a
# readable regular file, which is what R12 means by "cannot read the body".
nv_read_body() {
  # NOT named `path`: that identifier is zsh's special array aliased to
  # `$PATH` (`man zshparam`), so a plain `local path=…` silently collapses the
  # function's own command lookup to whatever was assigned — every builtin
  # call after it (here, `head`) then fails with "command not found". Caught
  # by the bash×zsh differential suite (#391), same class as the `$'\n'` and
  # unquoted-`for` pitfalls the shared partials already document.
  local nv_target="$1"
  [ -n "$nv_target" ] && [ "$nv_target" != "-" ] && [ -f "$nv_target" ] && [ -r "$nv_target" ] || return 1
  nv_body_content=$(head -c 200000 -- "$nv_target" 2>/dev/null) || return 1
  return 0
}

# ADF (Atlassian Document Format) is a JSON tree; only its `text` leaves are
# shown, and `query` (GraphQL's OWN document) is never treated as one — R11.
nv_adf_text_from_file() {
  if [ "$nv_have_jq" = 1 ]; then
    jq -r '[.. | .text? // empty] | join(" ")' "$1" 2>/dev/null
    return 0
  fi
  node -e '
const fs = require("fs");
try {
  const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const out = [];
  const walk = (n) => {
    if (n && typeof n === "object") {
      if (typeof n.text === "string") out.push(n.text);
      for (const k in n) walk(n[k]);
    }
  };
  walk(data);
  process.stdout.write(out.join(" "));
} catch (e) {
  /* leave stdout empty; the caller falls back to the raw file content */
}
' "$1" 2>/dev/null
  return 0
}

nv_gql_body_from_input() {
  if [ "$nv_have_jq" = 1 ]; then
    jq -r '(.variables.body // .body // empty)' "$1" 2>/dev/null
    return 0
  fi
  node -e '
const fs = require("fs");
try {
  const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const b = (d.variables && d.variables.body) || d.body || "";
  process.stdout.write(String(b));
} catch (e) {}
' "$1" 2>/dev/null
  return 0
}

# Caps a preview at 1,500 characters, with the count of what was cut — R11.
nv_truncate() {
  local text="$1" max=1500 len=${#1}
  if [ "$len" -gt "$max" ]; then
    # `$max`, NOT the bare name: zsh's `${text:0:max}` reads `max` as the
    # START of a history-modifier list (`:m…`) instead of a length variable —
    # `unrecognized modifier 'm'` — where bash resolves it as arithmetic. The
    # `$`-prefixed form is unambiguous, and identical, in both shells.
    printf '%s\n[+%d caracteres omitidos]' "${text:0:$max}" "$((len - max))"
  else
    printf '%s' "$text"
  fi
}

navori_draft_body() {
  nv_body_source="none"
  nv_body_path=""
  nv_bound_file=""
  nv_sniff_adf=0
  nv_force_adf=0

  case "$nv_kind" in
    gh-comment | gh-review | gh-issue-create | gh-pr-open)
      nv_body_path=$(nv_flag_value "$cmd" '-F|--body-file')
      if [ -n "$nv_body_path" ] && [ "$nv_body_path" != "-" ]; then
        nv_body_source="file"
      elif printf '%s' "$cmd" | grep -qE '(^|[[:space:]])(-b|--body)([[:space:]=]|$)'; then
        nv_body_source="inline"
      fi
      ;;
    gh-api-graphql)
      nv_body_path=$(printf '%s' "$cmd" | grep -oE -- '-F[[:space:]]+body=@[^[:space:]]+' | head -1 | sed -E 's/^-F[[:space:]]+body=@//') || true
      if [ -n "$nv_body_path" ]; then
        nv_body_source="file"
      elif printf '%s' "$cmd" | grep -qE -- '-f[[:space:]]+body=[^[:space:]]+'; then
        nv_body_source="inline"
      else
        nv_input=$(nv_flag_value "$cmd" '--input')
        if [ -n "$nv_input" ] && [ "$nv_input" != "-" ] && nv_read_body "$nv_input"; then
          nv_gql_text=$(nv_gql_body_from_input "$nv_input")
          if [ -n "$nv_gql_text" ]; then
            nv_body_source="gql-text"
            nv_bound_file="$nv_input"
          fi
        fi
      fi
      ;;
    gh-api-rest)
      nv_body_path=$(nv_flag_value "$cmd" '--input')
      if [ -z "$nv_body_path" ]; then
        nv_body_path=$(printf '%s' "$cmd" | grep -oE -- '-F[[:space:]]+[A-Za-z0-9_]+=@[^[:space:]]+' | head -1 | sed -E 's/^-F[[:space:]]+[A-Za-z0-9_]+=@//') || true
      fi
      if [ -n "$nv_body_path" ] && [ "$nv_body_path" != "-" ]; then
        nv_body_source="file"
      fi
      ;;
    acli-create)
      nv_body_path=$(nv_flag_value "$cmd" '-F|--body-file')
      if [ -n "$nv_body_path" ]; then
        nv_body_source="file"
        nv_sniff_adf=1
      elif printf '%s' "$cmd" | grep -qE '(^|[[:space:]])(-b|--body)([[:space:]=]|$)'; then
        nv_body_source="inline"
      fi
      ;;
    acli-update)
      nv_body_path=$(nv_flag_value "$cmd" '--body-adf')
      if [ -n "$nv_body_path" ]; then
        nv_body_source="file"
        nv_force_adf=1
      else
        nv_body_path=$(nv_flag_value "$cmd" '-F|--body-file')
        if [ -n "$nv_body_path" ]; then
          nv_body_source="file"
          nv_sniff_adf=1
        elif printf '%s' "$cmd" | grep -qE '(^|[[:space:]])(-b|--body)([[:space:]=]|$)'; then
          nv_body_source="inline"
        fi
      fi
      ;;
  esac

  nv_reason=""
  case "$nv_body_source" in
    inline)
      # R11: never re-derive the value (it might carry `;`/`|`/newlines the
      # compound-command scan above does not respect quoting for); the reason
      # just points back at the command the host already shows the user.
      nv_reason="[navori] this call publishes $nv_label. Its body is inline in the command above — review it there before confirming."
      ;;
    gql-text)
      nv_preview=$(nv_truncate "$nv_gql_text")
      nv_reason="[navori] this call publishes $nv_label. \`body\` variable:

$nv_preview"
      ;;
    file)
      nv_bound_file="$nv_body_path"
      if nv_read_body "$nv_body_path"; then
        nv_text="$nv_body_content"
        if [ "$nv_force_adf" = 1 ] || { [ "$nv_sniff_adf" = 1 ] && nv_looks_like_json "$nv_body_content"; }; then
          nv_adf_text=$(nv_adf_text_from_file "$nv_body_path")
          [ -n "$nv_adf_text" ] && nv_text="$nv_adf_text"
        fi
        nv_preview=$(nv_truncate "$nv_text")
        nv_reason="[navori] this call publishes $nv_label from file '$nv_body_path':

$nv_preview"
      else
        nv_reason="$NV_FALLBACK_REASON"
      fi
      ;;
    *)
      nv_reason="$NV_FALLBACK_REASON"
      ;;
  esac
}
