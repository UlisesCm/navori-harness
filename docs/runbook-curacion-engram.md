> [English](runbook-curacion-engram.md) | [Español](runbook-curacion-engram.es.md) | [简体中文](runbook-curacion-engram.zh-CN.md)

# Runbook — curating the engram corpus (#761, decision 1)

> **This document does not mutate anything.** It is the written procedure for an operation that does mutate:
> `~/.engram/engram.db`, the user's personal store, which lives outside this repository, outside git,
> with no diff and no undo. Reading it all costs less than restoring an `export`.
>
> All figures were measured **2026-09-13 at 21:04 CST** against `engram v1.20.0`. The corpus is live:
> **these figures drift**. The final section explains how to measure them again.

## Why this document exists

[#761](https://github.com/UlisesCm/navori-harness/issues/761) packages two user decisions. **Decision 2** — `researcher` and `explorer` with memory — **was already made and delivered** in `4dd7a78` (#768), whose body literally says *"Decision 2 de #761"*. It is closed with evidence at the end of this document.

**Decision 1** — the corpus-curation pass — remains open, and **a PR cannot make it**. There is no repository file to change: it is a database mutation that no reviewer sees and no `git revert` can recover.

This runbook is the deliverable that can go in a PR: it turns an open decision into an **informed yes/no**. It includes the measured state, an ordered procedure from lowest to highest risk, and safeguards written where evidence says they are needed.

**This had already been written once.** `specs/0005-search-efficiency-layer/design.md:137` labeled the same operation **"One-time personal-store hygiene (action, not a navori feature)"**, and `:206` left it as an explicit open decision: *"Run the one-time personal-store hygiene (§5.3) now, separately from the plan?"*. #761 decision 1 **is that same question, rediscovered by another path months later**. This document exists to prevent a third rediscovery.

---

## ⛔ What must not be run blindly

Two commands in this family cause damage with syntax one might type reflexively. They come first because reading order matters more than logical order.

### Trap 1 — `engram projects consolidate --all` merges different repositories

Run on **2026-09-13 21:04 CST**, `engram projects consolidate --all --dry-run` proposed **7 groups**. **Group 4 is destructive**:

| group 4 — would be merged into `navori-harness` | obs |
|---|---:|
| `alertaciudadana` | 1 |
| `alertaciudadana_app` | 237 |
| `alertaciudadana_backend` | 227 |
| `alertaciudadana_backend_audit` | 1 |
| `navori` | 14 |
| `navori-ab-smoke2` | 0 |
| `navori-dashboard-template` | 96 |
| `navori-health` | 104 |
| **total absorbed** | **680** |

**680 observations from genuinely different repositories would collapse into `navori-harness`** (which has 681), mixing the memory of two unrelated products into this one. **Group 5** puts `reports-server-bonum` (38 obs) into `notifications-server` (60).

**Interactive mode is not safe by default either:** when run without `--all` from the repository root, the command detects `navori-harness` and offers to merge `navori` (14 obs) and `navori-health` (104 obs) into it. Both are different codebases. The correct answer to that prompt was `none`, and that is what was chosen.

**Rule: `--all` is prohibited.** Use only manually verified groups, through the interactive prompt, selecting explicit numbers. The legitimate groups in today's dry run — all with 0–3 obs on the side being absorbed — are:

- `bonum-services-sessions` (1) → `services-sessions` (12)
- `poker-2` (3) → `poker` (3)
- `codex-spike` (0) + `codex-spike2` (0)
- `.g-p-683086de…-previous-dcdb38aa…` (1) → `g-p-683086de…` (3)
- `alertaciudadana` (1) and `alertaciudadana_backend_audit` (1) → **their real repository**

That last item has a wrinkle to notice: `alertaciudadana` and `alertaciudadana_backend_audit` should be consolidated, but **group 4 sends them to `navori-harness`, not their repository**. Accepting the group to get the legitimate items also gets the disaster. Handle those separately, from the directory of the repository that should remain canonical.

One group is proposed by the dry run and **must not be accepted even though it is small**: group 2 merges `con-harness` (4 obs) with `sin-harness` (0 obs). Those names are the two arms of a comparison; merging them erases exactly the distinction that makes them useful. Verify before touching it.

### Trap 2 — `engram export --help` writes the export to a file named `--help`

`engram export` takes its destination as a **positional argument** and has no help flag. Therefore, `engram export --help` **does not print help: it writes the full export to a file named `--help`**. Measured size: **9.9 MB**, mode `-rw-r--r--` (644), containing all **1,798** `user_prompts` rows in plaintext.

Run from a repository, this leaves the file **inside a git working tree**, one `git add -A` away from being committed forever.

Two rules follow:

1. **Never write the backup inside a repository.** Put it outside every working tree (for example, under `~/`) and run `git status` afterward to confirm nothing landed in a repository.
2. **Use `engram help`** (or `engram --help`) to discover `engram` flags. It prints complete help for every subcommand and **writes nothing**. `engram help <subcommand>` is also safe, though it ignores the argument and prints the same global help.

`engram <subcommand> -h` **is not a reliable route**: it works for some commands (`engram doctor -h` prints real usage) and not others (`engram stats -h` ignores the flag and simply runs `stats`). For subcommands whose first argument is positional — `export`, `import`, `save`, `search`, `delete` — `-h` may be interpreted as the argument: the effect depends on the subcommand and only `export` writes a file, but none of these is a safe way to ask for help. **Do not try it there.**

---

## Corpus state, measured

Measurement from **2026-09-13 21:04 CST**, using `sqlite3 -readonly` on `~/.engram/engram.db`. Only counts and keys were read; no `observations.content` or `user_prompts.content` left the database.

**The numbers drift, and quickly.** The live observations for `navori-harness` took five values during the #760 cycle: 670 → 674 → 675 → 676 → **681**. Re-measure every number below before acting on it.

### `navori-harness` — 681 live observations

| type | obs | % |
|---|---:|---:|
| `manual` (no curated type) | 217 | **32%** |
| `session_summary` | 132 | **19%** |
| `decision` | 96 | 14% |
| `project` | 60 | 9% |
| `discovery` | 48 | 7% |
| `architecture` | 39 | 6% |
| `bugfix` | 37 | 5% |
| `config` | 10 | 1% |
| `pattern` | 7 | 1% |
| `bug` | 6 | 1% |
| `learning` | 5 | <1% |
| `solution` · `bug_fix` | 4 each | <1% |
| `task` · `reference` · `convention` | 3 each | <1% |
| `preference` · `feedback` | 2 each | <1% |
| `research` · `progress` · `incident` | 1 each | <1% |

The **durable** types (`decision` + `architecture` + `convention` + `pattern`) total **145 = 21%**. In other words, one in five writes is what the protocol describes as the goal, and nearly one third of the corpus is `manual`, the default type.

### Gaps

| signal | navori-harness | % of live corpus |
|---|---:|---:|
| missing `title` | **352** | 52% |
| missing `topic_key` | **437** | 64% |
| `revision_count > 1` | 47 | 7% |
| soft-deleted | 0 | — |
| has `review_after` | 99 | 15% |
| overdue `review_after` | 0 | — |

Of the 352 observations missing `title`, **64 are durable** (`decision` 41, `architecture` 23). That is the highest-value slice for step 1: those are the ones someone will want to find in six months, and today they can only be distinguished by opening them one by one.

### The `type` vocabulary is fragmented

`bugfix` (37) + `bug` (6) + `bug_fix` (4) are **the same concept under three keys**. Across the entire database: `bugfix` 311, `bug` 45, `bug_fix` 9. While this persists, `mem_search --type bugfix` misses **10 of 47 in `navori-harness` (21%)** and **54 of 365 across the database (15%)**.

### `engram doctor` reports `blocked`

```
engram doctor --json --project navori-harness
```

→ `"status": "blocked"`, 4 checks, 3 ok, **1 blocked**:

```
sync_mutation_required_fields — sync_mutation_payload_missing_required_fields
  observation payload missing required fields: title
  evidence: {"entity":"observation","entity_key":"obs-c08da4feeb4afbdd",
             "missing_fields":["title"],"op":"upsert","project":"navori-harness",
             "seq":15579,"target_key":"cloud"}
```

This is observation **#2756** (`discovery`, live, without a title). Inspect it with
`engram doctor --project navori-harness --check sync_mutation_required_fields`.

It is the same symptom as the 352 observations without titles, one level down: a queued sync mutation is missing a field. **Be careful with the promise:** titling the corpus removes the *class* of cause; whether it also clears this specific mutation (`seq` 15579) has not been verified. `doctor` itself names its next step as `engram cloud upgrade doctor --project navori-harness` — a command that **does not appear in `engram help`** (the documented `cloud` subcommands are `status`, `enroll`, `config`, and `serve`). Confirm it before running it.

### `embedding IS NOT NULL` ⇒ **0 rows**, but semantic scan does not depend on them

Neither `navori-harness` nor the entire database (2,964 live observations) has any embeddings. **That does not disable `engram conflicts scan --semantic`**: this path uses the LLM runner configured through `ENGRAM_AGENT_CLI`, not the `embedding` column.

Verified **2026-09-14 14:05 CST** with `ENGRAM_AGENT_CLI=claude`, `--dry-run`, `--max-semantic 10`, concurrency 1, and a 20-second timeout per call: it inspected 689 observations, found 3 candidates, judged 1, skipped 2, and reported 0 semantic errors; `inserted: 0` and `dry_run: true`. The run took several minutes, and discovery emitted three FTS5 errors for content the parser could not convert into a query, but it finished with exit 0. It is a real source of candidates, not an instant or exhaustive operation.

Relationships persisted before that run came from judgment: `engram conflicts stats --project navori-harness` reported 9 judged relationships (6 `not_conflict`, 3 `related`) among 131 rows in `memory_relations` across the whole database. The `--dry-run` added none.

### Global context

`engram stats` and `engram projects list`, in the same run: **2,964** live observations · **1,162** sessions · **1,798** prompts · **37** projects. Across the entire database, **1,241** observations have no `title` (42%).

---

## Procedure

Ordered from lowest to highest risk. **Authorize each step separately**: steps 1 and 2 are inexpensive and reversible; steps 3 and 4 require care. “Yes to 1 and 2, the rest later” is a complete answer and probably the best first run.

### Step 0 — backup, non-negotiable

```
engram export ~/engram-backup-2026-09-13.json
```

Verified: exit 0; prints `Exported to <path>` and three counts (`Sessions` / `Observations` / `Prompts`). The artifact contains `version`, `exported_at`, `sessions`, `observations`, and **`prompts`**.

Three things go with this command:

- **Outside every repository.** See trap 2. After running it, check `git status` in any working tree you are standing in.
- **Immediately `chmod 600`.** The file is created as `-rw-r--r--` (644) and contains all 1,798 prompts in plaintext. It has the same exposure as the original database.
- **Restore with `engram import <file>`**, documented by `engram help`. It was not tested in this run. To test it, use **`ENGRAM_DATA_DIR`**, which takes a directory and makes the binary open `<directory>/engram.db`; `ENGRAM_DB` does not exist and is silently ignored. Before importing, create a private temporary directory and require `stats` to show that path and zero observations:



```sh
  restore_dir="$(mktemp -d "${TMPDIR:-/tmp}/engram-restore.XXXXXX")"
  chmod 700 "$restore_dir"
  ENGRAM_DATA_DIR="$restore_dir" engram stats
  # Only if Database points to "$restore_dir/engram.db" and Observations is 0:
  ENGRAM_DATA_DIR="$restore_dir" engram import ~/engram-backup-2026-09-13.json


```

  Do not point `ENGRAM_DATA_DIR` at `~/.engram` or continue if `stats` shows the real store.

### Step 1 — title observations missing `title`

**Risk: none.** This only adds data: `mem_update(id, title)` does not change `content`, `type`, or `topic_key`.

There are 352 candidates in `navori-harness`. Start with the **64 durable** ones (`decision` 41, `architecture` 23), the ones a future `mem_search` will need to distinguish by title.

Write a title **as the claim itself, not as a topic label**: search results lead with it, so a vague title forces someone to open the full observation just to learn what it is about.

This is also the step that addresses the cause of `doctor`'s `blocked` status. Run `doctor` again afterward to see whether the finding is gone or whether its own suggested next step is needed.

### Step 2 — normalize the `type` vocabulary

**Risk: low.** Reversible and mechanical: use `mem_update` to change `bug` → `bugfix` and `bug_fix` → `bugfix`. There are 10 observations in `navori-harness` and 54 across the whole database.

Benefit: `mem_search --type bugfix` stops lying. Decide first whether the scope is only `navori-harness` or all 37 projects. The criterion is the same either way; the volume is not.

Other orphan types (`solution` 4, `task` 3, `progress` 1, `incident` 1, `project` 60) **are not automatically included in this step**: `project` with 60 rows is not a typo; it is deliberate usage that must be understood before rewriting.

### Step 3 — merge semantic duplicates

**Risk: medium. Agent judgment, one pair at a time.** No bulk run here.

Start with the two confirmed pairs, verified live in this run:

| ids | type | topic_key |
|---|---|---|
| **2901** / **2902** | `discovery` / `manual` | `routing/tool-routing-audit` / `navori-audit-tool-routing-2026-09` |
| **2903** / **2904** | `discovery` / `manual` | `audit/skill-attribution` / `navori-skill-attribution-2026-09` |

**Why SQL does not find these, and this is the important part of the runbook:** `navori-harness` has **0 `topic_key` values with more than one live row** and **0 repeated `normalized_hash` values**. Zero. Yet the four observations above are two pairs about the same facts. Each pair differs in both `type` *and* `topic_key` — one key uses the `<area>/<slug>` convention, the other embeds the month — so no deterministic rule groups them. **A script cannot find this; an agent reading title and content can.** `specs/0005-search-efficiency-layer/design.md:129-130` had already decided the same thing: *"This requires judgment → agent, not a mechanical hook (a script does not know what is 'important')."*

`engram conflicts scan --project navori-harness --dry-run --semantic` is documented by `engram help` and **does propose candidates even with 0 embeddings**: it uses the runner specified by `ENGRAM_AGENT_CLI`. The measured run above found 3 and judged 1. Its result remains a proposal to review before applying. The command summary does not print the pairs, so that run cannot establish whether it included the two confirmed pairs in this table.

The actual merge is: consolidate the content under **one** observation with a `topic_key` that follows the convention, and soft-delete the other observation (step 4).

### Step 4 — prune volatile snapshots

**Risk: highest. This is the only step that deletes.**

- **Soft-delete, the default for `engram delete <obs_id>`. NEVER use `--hard`.** `--hard` has no undo, and the corpus currently has **0 soft-deleted** observations, so the trash is empty and available.
- **Never delete a `decision` or `architecture`.** This is not a preference; it is required by the protocol rendered by this harness — `packages/plugins/engram/managed/engram-protocol.md:11`: *"Never aggressive deletion, never delete a durable decision"*.
- Legitimate candidates: one-off measurements, PR status, run results — things already covered by that session's `session_summary`. `mem_review(action: list)` lists items past `review_after`; today that is **0 of 99**, so it supplies no candidates yet and selection is manual.
- `engram delete <obs_id>` was not run in this measurement. It is documented by `engram help`.

### Authorization summary

| step | what it does | reversible | can be authorized alone |
|---|---|---|---|
| 0 | `engram export` | n/a | required, not optional |
| 1 | title 352 observations | yes (`mem_update`) | yes |
| 2 | normalize `type` | yes (`mem_update`) | yes |
| 3 | merge duplicates | yes, if deletion is soft | yes, but requires judgment per pair |
| 4 | prune volatile items | yes, if soft-deleted | yes |

---

## Diagnosis: always read-only, without text

**The rule:** `sqlite3 -readonly` with `COUNT` / `GROUP BY`, or `engram stats` / `engram doctor --json`. **Never `SELECT content`. Never query the `user_prompts` table.** All measurements in this document follow this rule.

### Why this rule exists

`~/.engram/engram.db` stores **about 1,798 user prompts in plaintext** and has permissions **`-rw-r--r--` (644, world-readable)**. Verified with `stat -f "%Sp %z %N" ~/.engram/engram.db` (20.5 MB) and a `COUNT(*)` on `user_prompts`. The accompanying `engram.db-wal` is another 4.3 MB with the same permissions.

The tilde in that count is not laziness: `COUNT(*)` returned **1,797**, and `engram stats`, one minute later in the same run, returned **1,798**. The corpus grows while you measure it — that is why each figure in this document includes its timestamp.

This is **the same kind of exposure that open decision B6 identifies for `~/.navori/audits`** — `.claude/progress/audit_deep_navori-audit.md:18`, labeled in `progress/current.md:153-154` as *"B6 (prompts travel in plaintext in the log)"* — but **one level higher and at greater volume**: B6 covers an opt-in per-session log; this is the entire always-on store.

**B6 is still unanswered** (*"privacy note in the report, 600 permissions, or nothing?"*, `.claude/progress/audit_deep_navori-audit.md:126`). This finding adds another question: whatever the answer is for `~/.navori/audits`, decide whether it also applies to `~/.engram/engram.db` and the `.json` produced by step 0.

### The precedent that already follows the rule

`scripts/py/mine-topic-keys.py` — delivered in **PR [#784](https://github.com/UlisesCm/navori-harness/pull/784)**, merged 2026-09-14 — is the tool that already reads this same database under these same rules, and is a template:

- It opens the database with URI **`mode=ro`**, not a promise in a comment: *"that this script emits no INSERT is a property of the code, not the channel. The URI makes it a property of the channel"*.
- It declares **one table and five columns** as constants used to construct the `SELECT`: `observations` × (`topic_key`, `type`, `revision_count`, `project`, `created_at`). None is user text.
- Its test (`packages/cli/src/lib/__tests__/mine-topic-keys.test.ts`) verifies this instead of merely claiming it: *"does not read observation bodies or the prompts table"* asserts the source **does not contain** `user_prompts` or `content`, and *"really opens the DB read-only: an INSERT is rejected"* checks against a real database.

Any new diagnostic query must meet this bar.

---

## What NOT to do, and why

The two ideas below reappear whenever someone looks at this problem directly. They are written down with their refutations so next time costs a paragraph, not an audit.

### No: a versioned curation script in navori

The tempting shape is `scripts/curate-engram.py`, read-only by default, with `--apply` as opt-in. It loses for four reasons, each sufficient on its own:

1. **It reimplements another product's tooling.** `engram v1.20.0` already provides `delete [--hard]`, `delete project`, `projects consolidate [--all] [--dry-run]`, `conflicts scan [--dry-run] [--apply] [--semantic]`, `doctor --json`, `stats`, `export`, and `import`. A copy in this repository drifts at the next binary release — and there is already evidence: `specs/0005` named an `engram prune` command that **does not exist** in the v1.20.0 command surface.
2. **It would cross a boundary that is clean today.** Navori has **0 accesses** to `~/.engram/engram.db` from `packages/cli/src/`, `packages/core/`, and `scripts/`; coupling to engram ends at `packages/plugins/engram/plugin.json`, which installs the binary, registers the MCP server, and renders doctrine. **The store belongs to the plugin, not navori.** This would be navori's first code that opens another product's store.
3. **It cannot do the part that matters.** The two duplicate pairs in step 3 have different `topic_key` values and different `normalized_hash` values — measured: 0 and 0. A semantic duplicate is **invisible to every deterministic rule**.
4. **It was already decided.** `specs/0005-search-efficiency-layer/design.md:129-130`: *"This requires judgment → agent, not a mechanical hook"*.

The only thing a script could contribute — a candidate list for missing titles, unusual types, and overdue `review_after` — **is already covered by three existing surfaces**: `engram doctor --json`, `engram conflicts scan --dry-run --semantic`, and `mem_review(action: list)`. The semantic scan did produce candidates in this measurement, but took several minutes; it is a deliberate curation tool, not a cheap check for every closeout.

### No: a `/curate-memory` skill

`specs/0005:171` left it optional. Today it loses for two reasons:

1. **The doctrine has already shipped.** `packages/plugins/engram/managed/engram-protocol.md:11` says exactly what curation is and when to do it: *"Curation at close: in the SAME turn as the summary… Consolidate duplicates under their `topic_key`, promote what's durable, and delete only volatile observations…"*. That block is always on: it travels in `CLAUDE.md` to every agent and subagent.
2. **The doctrine moratorium applies here.** `specs/0025-disparadores-de-skill/design.md:234-239`: *"the mechanism does not add new prose to `CLAUDE.md`, but **re-delivers prose that is already there**. A mechanism whose content copies an always-on block pays for the body twice"*. A curation skill would be exactly that.

**If curation does not happen, it is not because text is missing: it is because no run happened.** That is the whole argument, and why the #761 deliverable is this runbook, not a skill.

---

## Decision 2, closed with evidence

`4dd7a78` (#768, 2026-09-13) — *"feat(agents): researcher and explorer read memory, and only read it"* — changed 9 files, +105/−11. It gave both agents **`mem_search` + `mem_get_observation` and no writer**. Verified in the tree on 2026-09-13:

| what | where |
|---|---|
| All 4 assets, `tools:` with the two readers and zero writers | `.claude/agents/researcher.md:4` · `.claude/agents/explorer.md:4` · `packages/core/core-assets/agents/researcher.md:4` · `packages/core/core-assets/agents/explorer.md:4` |
| Read-only toolset clause in the always-on block | `packages/plugins/engram/managed/engram-protocol.md:3` — *"If your `tools:` lists a reader (`mem_search`, `mem_get_observation`) and no writer, the pre-flight below is the whole block"* |
| Regression protection | `packages/cli/src/lib/__tests__/mcp-capability-wiring.test.ts:298` — `describe("researcher and explorer read memory, and only read it (#761)")`, with `WRITE_TOOLS` at `:302` and failure text *"reverses a deliberate decision — take it to the issue, not to this line"* at `:341` |

The two `.claude/` assets also include `mcp__codegraph__codegraph_explore` (exact tool, not a family wildcard, since #838), which is not part of this decision.

**Do not relitigate it.** The only remaining work for decision 2 is issue housekeeping: edit #761's body or close that half citing `4dd7a78`. While it stays as it is, the next reader will re-audit a decision already made — exactly what happened to produce this document.

---

## How to measure again

Everything above comes from read-only commands. Refresh the figures before deciding:

```
# 1. Overall state — read-only, no text
engram stats
engram projects list
engram doctor --json --project navori-harness
engram doctor --project navori-harness --check sync_mutation_required_fields
engram conflicts stats --project navori-harness

# 2. Corpus counts (sqlite3 -readonly, COUNT/GROUP BY only)
sqlite3 -readonly ~/.engram/engram.db \
  "SELECT COUNT(*) FROM observations WHERE project='navori-harness' AND deleted_at IS NULL;"
sqlite3 -readonly ~/.engram/engram.db \
  "SELECT type, COUNT(*) FROM observations WHERE project='navori-harness' AND deleted_at IS NULL
   GROUP BY type ORDER BY COUNT(*) DESC;"
sqlite3 -readonly ~/.engram/engram.db \
  "SELECT COUNT(*) FROM observations WHERE project='navori-harness' AND deleted_at IS NULL
   AND (title IS NULL OR title='');"
sqlite3 -readonly ~/.engram/engram.db \
  "SELECT COUNT(*) FROM observations WHERE deleted_at IS NULL AND embedding IS NOT NULL;"

# 3. Consolidation groups — dry run, NEVER without --dry-run
engram projects consolidate --all --dry-run

# 4. Store permissions
stat -f "%Sp %z %N" ~/.engram/engram.db ~/.engram/engram.db-wal
```

All were verified on 2026-09-13 21:04 CST using `engram v1.20.0` and `sqlite3 3.50.6`. **None mutates anything**, including the `--dry-run` in step 3 — but that command without `--dry-run` does, so do not type it partially.

## References

- `.claude/progress/audit_ticket_761.md` — the audit that produced this runbook, with full `file:line` evidence.
- `specs/0005-search-efficiency-layer/design.md` §5.2 (`:116-135`), §5.3 (`:137-148`), §9 (`:199-206`).
- `specs/0025-disparadores-de-skill/design.md:234-239` — the doctrine moratorium.
- `packages/plugins/engram/managed/engram-protocol.md` — the protocol rendered into `CLAUDE.md`.
- [#761](https://github.com/UlisesCm/navori-harness/issues/761) · [#728](https://github.com/UlisesCm/navori-harness/issues/728) · [#768](https://github.com/UlisesCm/navori-harness/pull/768) · [#784](https://github.com/UlisesCm/navori-harness/pull/784)
