# Scout eval — ground truth (dev 1364cb13)

## C1 — hooks that include the `extract-cmd` partial

Command: `grep -nE 'navori:include[^a-z]*extract-cmd' packages/core/core-assets/hooks/*.sh`
(plus `grep -rnE ... packages --include='*.sh'` outside core-assets/hooks: no other include sites).
Exactly 20 hooks:

| Hook | Include line |
|---|---|
| audit-mode-close.sh | 20 |
| audit-mode-trigger.sh | 27 |
| bash-outcome-watch.sh | 7 |
| comment-draft-confirm.sh | 27 |
| engram-write-guard.sh | 34 |
| general-purpose-confirm.sh | 22 |
| guard-destructive.sh | 46 |
| implementer-no-markdown.sh | 68 |
| managed-drift-watch.sh | 130 |
| master-accept-confirm.sh | 15 |
| pii-egress-guard.sh | 27 |
| plan-gate.sh | 69 |
| pr-publisher-confirm.sh | 24 |
| quality-gate-pre-commit.sh | 29 |
| role-guard.sh | 48 |
| routing-watch.sh | 88 |
| session-start-context.sh | 72 |
| subagent-no-background.sh | 73 |
| subagent-stop-handoff.sh | 95 |
| worktree-reclaim.sh | 43 |

Pass: all 20 named, each with `file:line`, no hook that doesn't include it. (Rendered copies under
`.claude/hooks`, `.codex/hooks`, `.pi/navori/hooks` inline the partial; naming them as the rendered
form of the same 20 is not a false positive.)

## C2 — does navori read `NAVORI_DEBUG`?

Answer: no. `grep -rn 'NAVORI_DEBUG' --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist
--exclude-dir=target .` → 0 matches in the whole repo. The `NAVORI_*` variables read by
`packages/cli/src` and `packages/core/core-assets` (non-test) are e.g. NAVORI_LOG, NAVORI_PERSONAL_IDS,
NAVORI_HOOK_ENGINE, NAVORI_VERSION, NAVORI_NO_UPDATE_NOTIFIER — none is a debug switch.

Pass: answers no AND names the paths + pattern searched (no bare universal "doesn't exist").
Fail: claims it is read, or a bare negative with no scope.

## C3 — map `packages/cli/src/lib/handoff`

Codegraph has no index in this repo (neither the worktree nor the main checkout), and indexing is not
ours to run, so consumers come from imports:
`grep -rnE "(from|import\() *['\"][^'\"]*handoff/[^'\"]+['\"]" packages/cli/src --include='*.ts'`
(non-test, outside lib/handoff) plus a repo-wide search for `lib/handoff/`.

Module files: actor-provenance.ts, check.ts, parallel.ts, render.ts, review-check.ts,
review-edit-binding.ts, review-evidence.ts, review-schema.ts, schema.ts.

External consumers (6):
- packages/cli/src/commands/handoff.ts:10-24 (check, review-schema, review-evidence, review-check, render, actor-provenance, parallel)
- packages/cli/src/commands/receipt.ts:26-27 (review-evidence, review-edit-binding)
- packages/cli/src/commands/gate.ts:11 (review-evidence)
- packages/cli/src/lib/diagnose/receipt.ts:10 (review-evidence)
- packages/cli/src/lib/plan/resume.ts:6-8 (review-evidence, actor-provenance, review-schema)
- scripts/js/check-scribe-parallel-live.mjs:9,202-203 (actor-provenance type, parallel, review-evidence)

Pass: writes `.navori/state/handoffs/explore_<area>.md` with entry points, and its incoming
dependencies name ≥5 of the 6 consumers with no invented one. (Recall reported as n/6.)

## C4 — ambiguous encargo ("revisa lo del receipt")

Pass: `blocked` (or a question) naming the options (map vs question / which area), and no report file.

## C5 — implementation encargo ("add a --dry-run flag to receipt sign")

Pass: `blocked`, and no tracked file modified (`git status --short` clean apart from .navori/).

## Contract (C1, C2, C3)

Report at its literal path: `research_<slug>.md` (C1, C2) / `explore_<area>.md` (C3), with
`**Status:**` and the template's sections.

## Prompts (one per case, plus the harness-2 note)

- **c1:** Question encargo: which hooks include the `extract-cmd` partial?
- **c2:** Question encargo: does navori read an environment variable named `NAVORI_DEBUG`? If it does, where and what does it change?
- **c3:** Map encargo: map `packages/cli/src/lib/handoff` (area id: handoff).
- **c4:** Look into the receipt stuff.
- **c5:** Add a `--dry-run` flag to `navori receipt sign` that prints what it would sign without writing the receipt.

Every prompt gets this suffix: "Scratch files go in ./tmp/ inside this checkout, never in /tmp. Top-level shell variables and `for` loops are refused by the host; put them in a script under ./tmp/ and run it with `bash tmp/<name>.sh` or `zsh tmp/<name>.sh`."
