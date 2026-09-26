# Challenge — spec 0035 (paridad Codex)

Sources cited below: `codex-rs/` cloned at
`scratchpad/codex/codex-rs` (tag `rust-v0.157.0`, per the research notes) and
the repo's own `packages/core/core-assets/settings/settings-base.json`.

## 1 — CRITICAL — "sin contexto de arranque" root cause may be wrong: untrusted
projects load ZERO AGENTS.md, not just zero hooks

`core/src/agents_md.rs:64-66`:

```rust
if config.active_project.is_untrusted() {
    return Ok((!loaded.is_empty()).then_some(loaded));
}
```

An untrusted project loads **no project `AGENTS.md` at all** — this guard runs
*before* any `.codex/` hook/rule discovery gate. The Context section attributes
the `monorepo-fullstack` smoke test's missing branch/commits/`progress/current.md`
purely to "hooks sin registrar" (`session-start-context` never firing). But the
research notes also say that session *did* load `AGENTS.md`, 37 skills and 7
navori agents — so that particular session was presumably trusted, which is
consistent with the stated root cause. Even so, the design's **Failure modes**
section ("Proyecto sin confianza") only says Codex ignores `.codex/` (hooks and
rules) when untrusted — it does not mention that `AGENTS.md` itself is also
withheld pre-trust. That's a materially bigger blast radius than "the 12 extra
hooks don't fire": an untrusted repo gets *no* harness doctrine at all, not just
no live context. `navori codex trust` becomes prerequisite not just for R1-R8
hook parity but for the entire `AGENTS.md`-based instruction layer working at
all.

**Change:** amend the Failure modes bullet and R17's messaging to state
explicitly that pre-trust, Codex has neither hooks/rules **nor** `AGENTS.md`;
and add a doctor check that distinguishes "untrusted → nothing loads" from
"trusted but hook Modified/Untrusted → only that hook doesn't fire", since the
user-facing fix and severity differ.

## 2 — HIGH — subagent-no-background's `unsupported` justification is incomplete:
Codex has a real background-execution surface (`unified_exec`) the design never considers

D1 justifies `subagent-no-background` as `unsupported` because "Codex no tiene
`Monitor` y su `tool_input` de `Bash` solo trae `command`: no hay bandera de
segundo plano que inspeccionar." But `codex-rs/core/src/tools/handlers/unified_exec/`
implements a persistent-shell tool with `write_stdin.rs` explicitly handling
"background polls" (`unified_exec/write_stdin.rs:131`), and
`core/src/tools/approvals.rs:689` shows a distinct `tool_name = "unified_exec"`
surfaced to the approval/hook layer, separate from `Bash`/`apply_patch`. Since
`hooks/src/engine/discovery.rs` matches `PreToolUse` by `tool_name` via a
matcher regex (per the research notes, exact match on `|`-split names or
unanchored regex), a `PreToolUse ^unified_exec$` hook is a viable, unexplored
registration this table never evaluates. The "unsupported" reason as written is
therefore inaccurate — the tool doesn't exist for *tool_input* reasons, it's
that the design never looked for the actual background-capable tool.

**Change:** add a row to `CODEX_HOOK_REGISTRATIONS` (or `ENGINE_CAPABILITIES.codex.unsupportedSurfaces`)
that evaluates `PreToolUse ^unified_exec$` explicitly, with either (a) a real
guard equivalent to `subagent-no-background`, or (b) an honest `unsupported`
reason that says "Codex's unified_exec grants persistent/background shell
sessions to subagents and navori has no hook-level way to block that", which is
a materially different (and worse) statement than what's in the table today.

## 3 — HIGH — D5's token-stripping rule for `allow`/`ask` patterns is
underspecified and, applied literally, drops real entries from `settings-base.json`

D5 states: "El patrón se parte en tokens por espacios. Un ` *` o `:*` al final
significa 'prefijo' y se quita. Si queda un comodín... dentro de un token, la
regla no cabe como prefijo: se omite." The worked "omitted" example is
`Bash(git push --force*)`.

But the actual `allow` list in
`packages/core/core-assets/settings/settings-base.json` contains multiple
entries whose trailing `*` is glued to a flag/word with **no preceding space
or colon** — exactly the same shape as the design's own "omitted" example:

- `Bash(git tag -l*)` → trailing chars `l*`, no space/colon before `*`
- `Bash(git tag --list*)` → trailing chars `t*`
- `Bash(git remote -v*)` → trailing chars `v*`
- `Bash(git remote get-url*)` → trailing chars `l*`
- `Bash(git config --get*)` / `Bash(git config --list*)` → same shape
- `Bash(git -c core.quotepath=false diff*)` / `...ls-files*)` → same shape

Applying D5's literal rule ("un `' *'` o `':*'` al final") to these produces
the *same* outcome as `git push --force*`: "comodín dentro de un token" →
**omitted**, per R10. If that's really the intended behavior, roughly a third
of the current `allow` list silently loses its Codex `prefix_rule` equivalent
and falls back to Codex's `on-request` approval flow for reads that Claude
never prompts for today — a real UX regression the design doesn't mention or
budget for. If it's *not* intended (i.e., the real translator is meant to
recognize "any trailing run of `[a-zA-Z-]*\*` at the end of the whole pattern as a prefix,
not just a literal `" *"`/`":*"` suffix), then the design's own stated
algorithm is wrong and needs to be corrected before implementation, because the
Testing strategy section only promises "tabla de casos de traducción (prefijo,
comodín interno, no-Bash)" with illustrative cases, not full coverage of the
real file.

**Change:** rewrite D5's stripping rule precisely (e.g., "strip a trailing
`*` together with any immediately preceding non-space run that itself has no
internal wildcard, i.e. treat the last whitespace-delimited token as a prefix
match if it ends in `*` and has no other wildcard char") and add a golden test
that runs the translator against the **actual** `settings-base.json` file
(not just 3 curated examples), asserting the omitted/dropped set is exactly
what's intended.

## 4 — HIGH — Migration section understates the regression for already-trusted
hooks in a **critical area** (guard-destructive)

D2 changes every registered hook's command to
`NAVORI_ENGINE=codex bash "$(git rev-parse --show-toplevel)/.codex/hooks/<script>.sh"`.
`hook_hash` (`hooks/src/engine/discovery.rs:775-792`) hashes the normalized
`command` field as part of the trust identity, so this change invalidates the
`trusted_hash` of the **4 hooks that are registered and presumably already
approved today**: `guard-destructive`, `model-advisor`, `comment-draft-confirm`,
`quality-gate-pre-commit`. The Migration section says: "Los hooks sin aprobar no
corren, así que el peor caso es el de hoy: sin hooks hasta aprobar" — that
undersells it. Today's baseline for a repo that already ran `/hooks` is "these
4 hooks run and protect the repo" (per this project's own critical-areas list:
guard-destructive, anti-rollback). After this render, that protection *silently
disappears* — no crash, no exit code, just `Modified`/`Untrusted` in a status
line — until the user notices `navori codex trust`'s hint and re-runs it. That
is strictly worse than "the state of today," it's "the state of before hooks
existed for this repo," for a user who already did the work to trust them.

**Change:** either (a) keep the exact command string for the 4 hooks that are
*already* registered today (append the `NAVORI_ENGINE=codex` prefix only to the
12 *newly* registered hooks, since those have no prior trust to preserve), or
(b) make `render`/`sync`/`init` exit non-zero (not just print a hint) when a
previously-`Trusted` hook regresses to `Modified` as a direct result of the
render, so the regression can't pass silently in CI/non-interactive runs.

## 5 — MEDIUM — D9's plan to trust "cada workspace con codex" assumes a load
model Codex doesn't have for nested workspaces

`config/src/loader/mod.rs:1638-1680` (`discover_project_layers`) only scans
`.codex/` in directories that are **ancestors of `cwd`, up to `project_root`
inclusive** (`dirs = cwd.ancestors().scan(... until project_root)`), plus a
separate always-loaded `$(git rev-parse --show-toplevel)/.codex/config.toml`
(the "repo" layer, `loader/mod.rs:132-133` doc comment). It does **not** walk
into descendant/sibling subdirectories to discover nested `.codex/config.toml`
files that aren't on the path from `project_root` to the actual session `cwd`.

D9 says: "para cada `.codex/config.toml` que navori generó en el repo (la raíz
y cada workspace con `codex`)" it writes trust entries — implying every
generated workspace config becomes loadable. In practice a workspace's
`.codex/config.toml` (e.g. `packages/api/.codex/config.toml`) only loads for a
session whose `cwd` is that directory or a descendant of it. A monorepo session
started at the repo root (a common pattern, and the one `services--sessions`-
style Bonum repos would likely use) never loads that nested config regardless
of trust state — `readCodexTrustState`/`doctor` would happily report it
`Trusted` while it's structurally inert for that session.

**Change:** either scope D9/R13-R17 to the root `.codex/config.toml` only
(matching the "repo" load path, which *is* always active) unless there's a
concrete workspace-cwd use case, or have `doctor`/`trust` state explicitly
"loaded only when Codex's cwd is inside `<workspace>`" per nested entry so the
status isn't misleading.

## 6 — MEDIUM — D9 hash algorithm citation is correct; note for the implementer
(not a blocker)

For completeness: `config/src/fingerprint.rs:54` (`version_for_toml`) is
genuinely the primitive `hook_hash` (`hooks/src/engine/discovery.rs:775-792`)
reuses for the final sha256 — the citation checked out contrary to my initial
suspicion that it referenced an unrelated config-fingerprint feature. The
per-hook struct (`NormalizedHookIdentity{event_name, group: MatcherGroup}`,
`config/src/hook_config.rs:154-201` for field renames) does match D9's
`{event_name, matcher?, hooks:[{type, command, timeout, async, statusMessage?}]}`
description, including the `additionalContextLimit` field only appearing when
set (`skip_serializing_if`) — none of navori's hooks are planned to set it, so
omitting it from D9's prose is harmless today. **Only risk**: if a future hook
(e.g. `session-start-context` needing more than the 2 500-token default spill
budget, see `hooks/src/output_spill.rs:12`) ever sets a custom
`additionalContextLimit`, the TS reimplementation must add that field to the
hashed struct or the golden hash breaks silently. Worth a one-line comment in
`trust.ts` rather than a design change.

## 7 — NOTE — `Bash -lc` execution confirmed, `NAVORI_ENGINE=codex` prefix is valid

`hooks/src/engine/command_runner.rs:406,440` runs hook commands via
`$SHELL -lc "<command>"` (fallback `/bin/sh -lc`), so
`NAVORI_ENGINE=codex bash ".../script.sh"` is ordinary shell syntax and will
work as intended. D2's env-var-prefix mechanism itself is sound; findings 3-4
above are about what gets hashed/omitted around it, not this part.

## 8 — NOTE — `apply_patch` tool_input shape confirmed

`core/src/tools/handlers/apply_patch.rs:462,491` and
`core/src/tools/approvals.rs:204` all construct
`tool_input: json!({ "command": <patch text> })` — D2's claim that
`apply_patch`'s patch text lives at `tool_input.command` (same field name Claude
uses for `Bash`) is correct, and the `*** Add/Update/Delete File:` / `*** Move
to:` headers D2 relies on for `nv_edited_paths` are the real hunk-header
vocabulary (`apply-patch/src/streaming_parser.rs:193-222`).

## Requirements ↔ design coverage gaps

- R10 says omitted rules get "listadas en las advertencias del render" — given
  finding 3, this could be a long list on first render for existing repos; the
  design doesn't say whether that's a blocking warning or a footer note, which
  matters for CI (`render --json` consumers) parity.
- R18 (min-version advisory) and D1's "0.145.0" derived minimum don't account
  for `unified_exec` (finding 2) potentially requiring its own minimum version
  if a guard is added later — not a defect today, just a note for whoever
  picks up finding 2.
