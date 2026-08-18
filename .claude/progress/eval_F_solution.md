# Solution — eval_F (workspace: string → workspace: string[])

**Verdict:** READY
**Signals:** schema change to a checked-in source-of-truth file (`navori.config.json`), touches 5+ call sites across 4 commands + doctor's drift/link checks, has a real merge/precedence decision (defaults from N workspaces), hard-to-reverse once repos adopt the new shape.

**Challenge round:** ran (`researcher`, fresh context) — `.claude/progress/solution_review_eval_F.md`. It flagged 2 findings as BLOCKER: the plugin-merge precedence was self-contradictory as originally written, and `workspace link`'s auto-write/mismatch logic wasn't actually redesigned for a list. Both were genuine defects **in this artifact**, not open product questions — neither needed the user's input to resolve, so both are corrected in place below (§ Chosen solution 3 and 5) rather than escalated. Its 3 CONCERN findings (generated JSON schema drift-guard, `doctor --json`'s breaking shape change, the interactive wizard prompt's missing `validate()`) are folded into the relevant sections below. Full findings and file:line evidence in the review file; nothing in it survived as an unresolved blocker.

## Problem

`navori.config.json`'s `workspace` field is a single kebab-case string (`packages/cli/src/lib/schema.ts:273-276`) naming one entry in the machine-local registry (`~/.navori/workspaces/<name>/workspace.json`). A repo used by two teams (each with its own workspace, e.g. `product` and `data`) can only declare one, so it inherits policy defaults from only one team and is invisible to the other's tooling (drift checks, `workspace render`, doctor's link check).

The behavior that must change: a repo's config must be able to name **N** workspaces, and every consumer that today reads `config.workspace` as a single name must instead treat it as a list — most importantly the `init`-time defaults cascade (bake defaults merged from all N, not just one).

## What already exists

Multi-workspace membership is **not a new concept** in navori — it already exists at the machine-local registry layer and is already handled by one command family:

- `lib/dominio.ts:274-294` (`resolveWorkspacesForCwd`) walks every workspace manifest in the registry and returns **all** whose `repos[]` contains the cwd — the doc comment says explicitly: *"A repo can belong to more than one workspace, so this returns all matches."*
- `commands/dominio.ts:22-32` (`resolveTarget`) already has a disambiguation UX for that case: 0 matches → error asking to register; **>1 matches → error asking for `--workspace <name>`** (`lib/i18n.ts:2512`: *"This directory belongs to several workspaces (…). Specify --workspace \<name\>."*).
- `workspace add-repo`/`workspace link` (`commands/workspace.ts`) already let a repo be registered under any number of independent workspace manifests — nothing in `linkRepoToWorkspace` (`lib/workspace.ts:240-277`) restricts a repo path to one workspace.

So the registry already supports N-membership and even has copy for it. **Why that isn't enough on its own:** the registry is explicitly machine-local and does not travel with the repo (`lib/registry.ts:19`, `lib/workspace.ts:234`: *"is machine-local and never travels with the repo (#76)"*). `navori.config.json`'s `workspace` field exists precisely so a teammate who clones the repo fresh (empty registry) has a checked-in breadcrumb telling them which workspace(s) to `workspace link` back into, and so `doctor`/`init` can act without a machine-wide registry scan. That reasoning applies identically to N workspaces — relying on the registry alone for the *list* would silently lose the second/third membership for anyone who clones fresh, regressing the exact portability guarantee `config.workspace` was added for. So the fix has to reach `navori.config.json`'s schema, not just the registry-consuming commands.

The **asymmetric cascade** (`lib/workspace-defaults.ts:1-27`, decision #231) is the other load-bearing fact: workspace defaults are read in exactly one place — `commands/init.ts` — and baked into the repo's config at init time; `render`/`sync`/`update` never re-open the workspace manifest. A later policy change on the workspace doesn't retroactively update already-initialized repos (deliberate — the checked-in config is the reproducible source of truth). This ticket doesn't touch that asymmetry; it only changes what init bakes *from* (N manifests instead of 1).

Direct consumers of the singular `config.workspace` field today (all need to become list-aware):

| File | Use |
|---|---|
| `commands/init.ts:198-335,389` | Reads `args.workspace` (the `--workspace` CLI flag, not the persisted config field) to load the named workspace and cascade its `defaults`; **writes** the result into `config.workspace` (line 317/705) (**the ticket's actual ask** is this cascade — the diff here is in `args` parsing/shape, not a `readConfig`-then-branch change) |
| `commands/workspace.ts:376,401-408` (`link`) | Default name when none given; auto-writes `workspace` on first link; warns on mismatch |
| `commands/configure.ts:354-403` (`workspace` subcommand) | Sets/removes the association |
| `commands/doctor.ts:232,930-953` (`scanWorkspaceLink`) | Warns when the repo isn't registered in its declared workspace |
| `lib/workspace-drift.ts:174-208` (`scanWorkspaceDrift`) | Compares config vs. that workspace's `defaults` and vs. sibling repos |

`commands/ticket.ts` and `commands/dominio.ts` use `args.workspace` (an explicit CLI flag naming which workspace's tickets/Dominio to operate on) — unrelated to `config.workspace` and already correctly N-membership-aware via the registry. No change needed there.

## Constraints

- `navori.config.json` is the portable, git-tracked source of truth; the change must keep existing single-workspace configs (`"workspace": "bonum"`) valid with no forced migration (same tolerance policy as every other schema evolution in this file — see `tolerantEnumArray`/`preserveForwardCompatEnums` for the established idiom).
- The asymmetric cascade (defaults baked only at init) is out of scope to relitigate — this ticket rides on top of it, doesn't replace it.
- `doctor` must degrade per-workspace, not all-or-nothing: one missing/unregistered workspace among N must not hide findings about the others.

## Approaches

**A. Pluralize the field itself: `workspace: string | z.array(string)` (normalize on read, don't force the on-disk shape).**
Every consumer switches from `config.workspace` to a new `workspaceList(config)` helper that normalizes `string | string[] | undefined → string[]`. Single-workspace configs never change shape on disk (no migration). Cost: every one of the 5 call sites above needs a small edit (loop instead of single value), and `init`/`configure`'s CLI surface needs to accept more than one name (repeatable flag or comma-separated — this repo already has a comma-separated precedent for a list-valued default, `applyDefault`'s `engines` key in `lib/workspace-defaults.ts:74-79`).
Reversal cost: low — a repo can go back to a single string at any time; the union type keeps reading it.

**B. Introduce a new field (e.g. top-level `workspaces: string[]`) and deprecate `workspace`.**
Cleaner single-shape type (no union to normalize), but: (1) collides in name with the *already-existing, unrelated* `monorepo.workspaces[]` (pnpm/turbo sub-packages, `lib/schema.ts:87-91`) — `workspaces` at the top level would mean something completely different from `monorepo.workspaces`, a real trap for anyone reading or grepping the config; (2) forces a rename migration on top of the type change (every existing config's `workspace` key becomes dead/deprecated, needs its own `warnDroppedEnums`-style soft-warning machinery) — strictly more churn than A for the same outcome.
Reversal cost: higher — once two field names both exist and some fraction of configs use each, collapsing back to one is an extra migration.

**C. Don't touch the schema; resolve multi-membership purely from the machine-local registry (reuse `resolveWorkspacesForCwd`), same as `dominio` already does.**
Rejected in "What already exists" above: it would drop the portability the field exists for — a teammate cloning fresh has no checked-in breadcrumb for memberships 2..N, only membership 1 (if even that, since the registry is empty on a fresh clone regardless). A tempting rescue — a `navori workspace link --from-config` reconciliation command that re-derives registry membership from something checked-in — doesn't actually save this approach: the only checked-in source such a command could read from is `config.workspace` itself (`workspace link`'s existing default-name logic already does exactly this, `commands/workspace.ts:376`), so making it name more than one workspace requires the field to already be a list — the same schema change C claims to avoid. A second checked-in artifact just to carry the list would be a worse version of the same idea, not an alternative to it.

**Chosen: A.** Smallest surface change, no forced rewrite of existing configs, reuses an in-file precedent (comma-separated list parsing) instead of inventing new CLI syntax, and avoids the `monorepo.workspaces` name collision entirely.

## Chosen solution

1. **Schema** (`lib/schema.ts`): `workspace: z.union([KEBAB_STRING, z.array(KEBAB_STRING).min(1)]).optional()`. No forward-compat "drop unknown" dance is needed here (unlike the tolerant-enum fields) — nothing is lossy, so no `preserveForwardCompatEnums`-style wrapper is required.
2. **Helper** (`lib/workspace.ts` or `lib/config.ts`): `workspaceList(config): string[]` — `Array.isArray(w) ? w : w ? [w] : []`. Every consumer below reads through this instead of `config.workspace` directly.
3. **Init defaults cascade** (`commands/init.ts`): accept the workspace flag repeatably (or comma-separated, matching `applyDefault`'s `engines` convention — note that convention is for a workspace's own engine-*id* list, not workspace *names*; the comma-split mechanism is reusable, the domain isn't the same field) and load each named workspace, failing fast (same as today's single-name behavior) if any named workspace doesn't exist. **Merge precedence — the actual design decision the ticket glosses over, stated as an explicit algorithm (not a spread-order metaphor, which the challenge round showed is easy to get backwards):**
   - Scalars (`branchBase`, `prTarget`, `commits`, `language`): **first-listed workspace that declares the key wins.** Same left-to-right `??` cascade already used in this exact function (`wsDefaults?.branchBase ?? detected.branchBase ?? "main"`, `init.ts:240`), extended to `ws[0].branchBase ?? ws[1].branchBase ?? … ?? detected.branchBase ?? "main"`.
   - `engines`: **union** of every listed workspace's `engines` array (no data loss — a repo declared in two workspaces' engine lists should get both, not silently drop one).
   - `plugins`: merge key-wise, **first-listed workspace wins per individual plugin id.** Implemented by folding in **reverse** list order so a later `Object.assign`/spread of an earlier (higher-precedence) workspace's entries overwrites a former one's — e.g. `Object.assign({}, ...[...names].reverse().map((n) => loadWorkspace(n)?.defaults.plugins ?? {}))`. (Spelled out explicitly because the file's own existing `{...ALWAYS_ON_PLUGINS, ...extraPlugins, ...wsPlugins}` spread at `init.ts:268` reads left-to-right = **last**-wins — the opposite convention — so this new fold must NOT be described as "mirroring" that idiom; it deliberately inverts it to keep first-wins consistent across scalars and plugins alike.)
   This is a genuine, user-visible policy choice ("list your workspaces in priority order") — documented in the field's schema comment and the `init` help text, not hidden. Test coverage must include two workspaces declaring the **same plugin id with conflicting `enabled`** (the one case that actually distinguishes first-wins from last-wins — a "both present" union check does not).
4. **`configure workspace`**: reuse the comma-separated convention (`"team-infra,team-product"` sets the full list; empty removes it) instead of inventing add/remove subcommands — smallest CLI surface change, consistent with `applyDefault`'s comma-split mechanism.
5. **`workspace link`**: two branches, both list-aware —
   - No explicit name given: loop `linkRepoToWorkspace` over every name in `workspaceList(config)` (already idempotent per-call), instead of requiring one name to be "the" default.
   - Explicit name given: if it's already a member of `workspaceList(config)`, this is a no-op re-link (nothing to warn about). If it is **not** yet a member, **append** it to the list and persist — replacing today's `!config.workspace` / `config.workspace !== name` checks (§ Boundaries & contracts explains why those two specific checks silently misbehave under the array type: `!arr` is always false for a non-empty array, and `arr !== name` is always true for an array compared to a string, regardless of membership). The old "mismatch" warning existed to protect a single-value invariant that a list no longer has — "not yet in the list" replaces "disagrees with the one true value," which is a simplification, not just a port.
6. **`doctor`**: `scanWorkspaceLink`/`scanWorkspaceDrift` iterate `workspaceList(config)` and return an array of per-workspace results instead of one; a missing/unregistered workspace among N reports for that one only, the others still get checked. This is a breaking shape change for `navori doctor --json`'s `workspaceLink`/`workspaceDrift` fields (object-or-null → array) — no consumer of either field exists in this repo's own CI/scripts today (checked), but any external script (e.g. in a Bonum repo) reading `report.workspaceLink.kind` would silently get `undefined` instead of erroring. Call this out explicitly in the PR description / CHANGELOG rather than trying to preserve a dual shape — a debug/status JSON field carrying two shapes forever is worse than a documented one-time break, and this codebase already treats config/JSON shape evolution as expected-with-a-warning rather than permanently backward compatible (see `lib/config.ts`'s `warnDroppedEnums`/`warnRemovedProgressKeys`).

## Boundaries & contracts

- `workspaceList()` is the single normalization point; no other file should branch on `Array.isArray(config.workspace)` directly (keeps the union type from leaking into 6 different call sites' control flow).
- `scanWorkspaceLink`/`scanWorkspaceDrift`'s return types change from a single optional value to an array — every caller (`doctor.ts` render/print logic) must switch from "if present, print one line" to "for each item, print a line". Internally this is contained to `doctor.ts` + `workspace-drift.ts` + their tests, but both fields are also spread verbatim into `navori doctor --json`'s output (`doctor.ts:125,150,194,208`) — that JSON shape is the one truly external-facing contract change (see § Chosen solution 6).
- `commands/workspace.ts`'s `link` subcommand's two `config.workspace` checks (`!config.workspace` at line 401, `config.workspace !== name` at line 407) must be replaced with membership checks (`workspaceList(config).includes(name)`), not left as-is — under the array type, `!config.workspace` is always `false` for a populated (`.min(1)`) array and `config.workspace !== name` is always `true` for an array compared to a string, so the literal old checks would silently misfire on every invocation for any multi-workspace repo (spurious "mismatch" warning even when correctly linked). See § Chosen solution 5.

## Failure modes

- One of N named workspaces doesn't exist in the registry at `init` time → fail fast before writing the config (same as today's single-name behavior), naming which one.
- One of N named workspaces' manifest becomes unreadable/missing later (machine-local drift) → `scanWorkspaceLink` reports `workspace-missing` for that one only; the other N-1 are still checked and can still report clean or drifted.
- Duplicate names in the list (`["bonum","bonum"]`) → harmless: defaults-merge of an identical value is a no-op, `linkRepoToWorkspace` is idempotent. Not worth a dedupe transform in the schema.
- Two workspaces disagree on a scalar default → resolved deterministically by list order (see precedence rule above), not silently or randomly.

## Migration & compatibility

- Existing configs with `"workspace": "bonum"` keep validating and behaving identically (single-element case of every merge rule above is a no-op).
- `init`/`configure` write a plain string when exactly one workspace is named (matches today's on-disk shape, zero diff for the overwhelmingly common single-workspace case) and an array only when N>1 — a conservative choice recorded as an assumption below, not a hard requirement of the schema (either shape parses).
- No `navori migrations`-style backfill is needed (that command handles `init --replace` file backups, unrelated to config schema evolution) and no automatic rewrite of already-initialized repos — consistent with the existing asymmetric-cascade design (#231), which this ticket does not change.
- The checked-in, generated JSON Schema (`apps/website/public/schema/navori.config.v1.json`, produced from `NavoriConfigSchema` by `packages/cli/scripts/gen-schemas.mjs`) currently declares `workspace` as a plain `{"type":"string",...}`. Its drift guard (`packages/cli/src/lib/__tests__/schema-publish.test.ts`) does a byte-exact comparison against the live schema — changing `lib/schema.ts`'s `workspace` field **will fail that test** until `pnpm gen:schemas` is re-run as part of this change. Mechanical, but must be an explicit step, not discovered by a red CI run.

## Testing strategy

- `lib/__tests__/schema.test.ts`: `workspace` parses a bare string (back-compat), parses a non-empty array of kebab-case names, rejects `[]` and a non-kebab entry — covers the schema change itself.
- `lib/__tests__/workspace-defaults.test.ts` / an init-focused test: defaults merged from 2 workspaces with a deliberately conflicting scalar (`branchBase`) resolve to the first-listed workspace's value; `engines` from both are present (union); **and** both workspaces declare the *same* plugin id with opposite `enabled` values, resolving to the first-listed workspace's value — this last case is the one that actually distinguishes first-wins from last-wins (a "both present" check alone would pass under either precedence and hide a reversed merge). Covers the actual ticket ask (inherit from all) and the precedence rule (§ Chosen solution 3), the thing the challenge round found most likely to ship backwards.
- `lib/__tests__/workspace-drift.test.ts` + `commands/__tests__/workspace-link-doctor.test.ts`: a config with 2 workspace names where only one is registered/linked reports the link issue for that one only, and drift is checked independently against each — covers the failure mode above (partial degradation, not all-or-nothing).
- `commands/__tests__/*` (configure/workspace commands): `configure workspace "a,b"` round-trips to an array of 2; `workspace link` with no explicit name links the repo into every declared workspace — covers the CLI surface change.

## NOT in scope

- Renaming the field to `workspaces` — rejected in Approaches (B) for the `monorepo.workspaces` name collision and the extra migration it would force; deferred indefinitely, not just for this ticket.
- Retroactively re-baking defaults into already-initialized repos when a workspace's policy changes — this is the pre-existing, deliberately-not-auto-applied asymmetry (#231); this ticket only changes what gets baked *from* at init time, not *when*.
- Any change to `ticket.ts`/`dominio.ts` — both already resolve N-membership correctly via the registry (`resolveWorkspacesForCwd`) and are unaffected by `config.workspace`'s shape.
- Upgrading `init`'s interactive wizard's free-text workspace prompt (`init.ts:450-458`) to a **multiselect** UI — a nicety on top of this change, not required for it; can be a fast-follow. This is narrower than it sounds: the prompt still needs one **required, in-scope** line — a `validate()` (mirroring the `name` prompt's pattern two fields up) that splits on comma and checks each segment against the kebab regex, so a user who reasonably types the same `"a,b"` syntax `configure workspace` teaches doesn't hit a raw, unvalidated schema-parse crash on `writeConfig`. Today the prompt has no `validate()` at all (`if (trimmed) workspace = trimmed;`) — that gap is a correctness fix this change introduces the need for, not a UX upgrade to defer.
- A conflict-resolution UI warning when two workspaces disagree on a scalar default (e.g. printing "branchBase differs between A and B, used A") — worth adding but not blocking; the deterministic precedence rule alone satisfies the ticket.

## Open questions

- **[assumed]** Write a plain string when only one workspace is named, an array only for N>1 (§ Migration & compatibility) — conservative, zero-diff default for the common case; either shape is valid so this is reversible without a schema change if the team prefers always-array for consistency.
- **[assumed]** First-listed workspace wins on scalar conflicts, and plugins are folded to match that same first-wins rule per key (§ Chosen solution 3) — chosen to match this exact function's existing `??`-cascade idiom for scalars and to keep one precedence rule instead of two. The alternative (last-listed wins everywhere, matching `mergedPlugins`'s own left-to-right spread idiom two lines away) is equally defensible and cheap to flip since this is a one-time bake, not a persisted invariant — but whichever is chosen, it must be implemented as an explicit, tested rule (not inferred from spread order), per the challenge round's finding that the two idioms already coexist in this file with opposite precedence.
- **[human]** CLI syntax for passing N workspace names to `init` — repeatable `--workspace` flag vs. comma-separated string (`applyDefault`'s existing convention for `engines`). Both are cheap; whoever implements should pick one and match `configure workspace`'s syntax for consistency (§ Chosen solution 4 assumes comma-separated for both, to keep the two commands' surface identical).
