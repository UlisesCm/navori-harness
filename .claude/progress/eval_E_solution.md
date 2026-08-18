# Solution — doctor: warn when a repo hasn't been re-rendered in a while

**Verdict:** BLOCKED
**Signals:** ticket names the mechanism ("guardar la fecha del último render") instead of the
behavior; new persisted state; touches the doctor/render/registry contract shared by 21
repos; genuine ≥2 approaches with materially different cost/reversal — a scope fork the
ticket author should pick, not one I should assume.

## Problem

Stated symptom: some of Ulises's ~19 (registry currently has 21) navori repos fall a full
harness version behind and nobody notices until someone opens `doctor` in that specific repo
for an unrelated reason.

Restated as behavior: **there is no low-friction way to check "which of my registered repos
have drift or a hard health issue right now" without opening `doctor` once per repo.** The
ticket's proposed remedy (persist a last-render timestamp, warn past 60 days inside
single-repo `doctor`) is one possible fix for that; it is not the only one, and — as detailed
below — it doesn't actually close the discoverability gap it's meant to close.

## What already exists

1. **Drift is already computed exactly, live, at zero storage cost** —
   `packages/cli/src/lib/health.ts:354-379` (`scanManagedDrift`) compares every managed
   marker's `version=` attribute (stamped by render, `health.ts:24-47` `MarkerInfo`/
   `listMarkers`) against `readCliVersion()` — the CLI version installed on the machine
   running `doctor` *right now*. This is not a proxy: it's the literal answer to "how far
   behind is this repo," including which blocks and from/to which version
   (`doctor.ts:344-362` formats it). `doctor.ts:641-670` (`computeHealthVerdict`) folds this
   together with missing plugins, corrupted settings, missing invariants and duplicate
   markers into a single `ok` verdict shared with `status`.
2. **No timestamp of any kind is tracked anywhere.** `MarkerInfo` (`health.ts:24-29`) carries
   `id/hash/version/source` only. A repo-wide grep for `lastRender|renderedAt|timestamp` in
   `packages/cli/src` (excluding tests) returns nothing. This part of the ticket's premise is
   correct: the data literally doesn't exist today.
3. **A "check N repos in one shot" mechanism already exists, one layer over.**
   `packages/cli/src/commands/render.ts:891-985` (`renderRepoRows` / `rollupRenderRows` /
   `reportRepoRenderRows`) iterates a list of repos and rolls up per-repo render status
   (created/updated/conflict/unchanged) into one report. It already backs two entry points:
   `render --all` (`render.ts:1051-1144`, reads the global registry) and
   `workspace render <name>` (`workspace.ts:499-551`, reads one workspace's `repos[]`). Run
   *without* `--apply` (the default) it's pure preview — read-only, no different in kind from
   what `doctor` does for one repo. There is no `doctor --all` / `workspace doctor` sibling:
   `doctor`'s `args` block (`doctor.ts:45-52`) only has `cwd`/`json`/`strict` — single repo
   only, and it evaluates the fuller `computeHealthVerdict` (missing plugins, corrupted
   settings, etc.), which `render --all` does not.
4. **The registry this would iterate is already populated with exactly the repos in
   question.** `~/.navori/registry.json` on this machine lists 21 repos, matching the
   ticket's "~19" — the plumbing isn't hypothetical, it's sitting there unused for this
   purpose.
5. **The current, actual workaround for "check N repos" is manual, per-repo `doctor`.**
   Session memory records "*ROLLOUT a los 15 repos Bonum COMPLETADO (2026-07-22, 15/15
   doctor.ok)*" — i.e., the existing practice for auditing the fleet is opening `doctor` in
   each repo by hand. That's precisely the toil a batch command removes; a passive field
   inside single-repo `doctor` does not.
6. **`navori.config.json` is mutated by many commands already, but only as an explicit,
   user-triggered write — never as an automatic byproduct of every render.**
   `writeConfig` (`config.ts:42`) is called from `init.ts`, `preset.ts`, `workspace.ts`,
   `remove.ts`, `scan.ts`, `configure.ts`, `update.ts`, `add.ts` — always in response to a
   command the user explicitly ran to change *declared* config. `render.ts` never calls
   `writeConfig` (verified: zero occurrences). Stamping a timestamp into `navori.config.json`
   on every `render` run would be a new category of write (implicit, on the hot path, on a
   file `CLAUDE.md`'s own docstring calls "checked-in ... source of truth ... `render`
   reconstruye todo desde ahí") and would add a line-level git diff to that file on every
   render, including no-op ones.
7. **`docs/DIRECTION.md:55-56`** (non-goals section — a stronger anchor than a loose
   principle): "Features grandes nuevas cuando el pendiente es endurecer lo existente.
   Prioridad: calidad > tokens > velocidad." A `doctor --all` that reuses the `render --all`
   roll-up pattern is hardening an existing pattern; inventing a new timestamp-and-threshold
   subsystem to approximate a number the tool already has exactly is closer to new surface
   for a weaker signal. ("El config checked-in es la única fuente de verdad", cited in point
   6 above, is `docs/DIRECTION.md:34`.)
8. **Pre-existing bug found while checking Approach B's viability**: the exact pattern B
   proposes to reuse (`renderRepoRows`, `render.ts:891-967`) is NOT robust to a corrupted
   repo in the batch. It calls `runRender(repo.path, ...)` (line 908) inside a
   `try/catch` (907-964), but `runRender` → `readConfigOrExit` (`render.ts:226`) →
   `process.exit(1)` on a `ConfigError`/`NavoriError` (`lib/cli-config.ts:13-30`) —
   `process.exit()` is not catchable, so **today**, `render --all` and `workspace render
   <name>` (`workspace.ts:538`, same function) silently abort the *entire* batch, reporting
   nothing for the remaining repos, the moment they reach one registered repo with malformed
   or schema-invalid `navori.config.json`. Confirmed by reading `cli-config.ts:13-30`
   directly. Single-repo `doctor.ts:78-103` gets this right (local `try/catch`, no
   `process.exit` inside the loop) — that's the pattern B's new loop needs, NOT the one in
   the file it's citing as precedent.

## Constraints

- Read-only investigation pass — no code changes in this cycle.
- navori is a local CLI, not a service: any "check this periodically without a human
  opening a terminal" behavior has to be the user's own cron/CI wiring around a navori
  command, not new always-on infrastructure inside navori itself (no non-goal explicitly
  bans this, but nothing already in the repo does it, and DIRECTION's "tool-for-self,
  harden before adding surface" bar applies).
- `navori.config.json` staying free of automatic, per-run writes is a soft invariant implied
  by "el config checked-in es la única fuente de verdad" (DIRECTION.md:34) and "render
  reconstruye todo desde ahí" (CLAUDE.md) — a field render itself rewrites on every run
  narrows that a little (config stops being purely-user-authored input) and is worth a
  deliberate decision, not a side effect of a MEDIO ticket.

## Approaches

### A — Ticket's literal ask: persist `lastRenderedAt`, warn past 60 days in single-repo `doctor`

- Needs a new place to store the timestamp: either (a) a new field in
  `navori.config.json`, which the ticket implies but which no existing command pattern does
  as an *automatic* per-run write (see "what already exists" #6), or (b) a separate state
  file (e.g. `.claude/.render-state.json`), a new small subsystem with its own read/write/
  corruption-handling code path, gitignore consideration, and no reason today to be
  git-tracked (it's derived, machine/run-local) vs. `navori.config.json` (which IS meant to
  travel with the repo) — the two options have different git-hygiene answers and that
  itself needs picking.
- Cost: threshold (60 days) is an arbitrary constant unrelated to whether the repo is
  actually behind — a repo rendered daily that's fully current would never trip it (correct,
  harmless), but a repo rendered 58 days ago right before navori shipped three releases
  would say "healthy" while `scanManagedDrift` in the very same `doctor` run already says
  "3 versions behind" a few lines down. The two signals can disagree in the same report.
- **Does not close the stated gap.** The problem is "nobody notices until they happen to
  open doctor in that repo." A field inside `doctor`'s own output has the identical
  discoverability problem as the drift warning `doctor` *already* prints today — if nobody
  runs `doctor` in repo X, they see neither the existing drift warning nor the new date
  warning. Nothing about this approach changes who looks or how often.
- Cost of reversal: low (an additive field, easy to remove/ignore later) — but "cheap to
  build and cheap to undo" is exactly why it's tempting to ship without checking whether it
  solves anything.

### B — `doctor --all` (+ `workspace doctor <name>`), mirroring the existing `render --all` roll-up

- Reuses `renderRepoRows`'s repo-iteration shape (`render.ts:891-985`): iterate a repo list
  (registry or one workspace's `repos[]`), but call `computeHealthVerdict` + `scanManagedDrift`
  per repo instead of `runRender`, and roll up `ok` / `drift count` / `hard issues` the same
  way `rollupRenderRows` already rolls up `failed/pending/conflicts/ok`. Same file, same
  general shape — **but NOT a drop-in copy**: the challenge pass (see
  `solution_review_doctor-last-render.md`) found `renderRepoRows` itself has a live bug —
  `runRender` → `readConfigOrExit` (`render.ts:226`) calls `process.exit(1)` on a bad config
  (`cli-config.ts:13-30`), which is uncatchable and today aborts the *entire*
  `render --all`/`workspace render` batch on the first corrupted repo. B's new loop MUST NOT
  copy that call; it needs its own per-repo `readConfig` + local `try/catch` (mirroring
  single-repo `doctor.ts:78-103`, which already gets this right) so one bad repo becomes an
  "error" row, not a killed batch. This is a real, fixable, but non-trivial addition to the
  "small diff" framing — see Failure modes.
- No new persisted state, no new file format, no threshold to pick or defend — it surfaces
  the exact live signal `doctor` already computes per repo, for every repo, in one command.
- Directly replaces the manual "open doctor in each of the 15-19 repos" workflow that
  memory shows is the *actual current practice* — this is the piece that was genuinely
  missing.
- Naturally schedulable: once it exists, `navori doctor --all --json` is one line to wire
  into a personal cron / CI workflow for real "notice without looking" automation — which
  neither approach A nor the status quo provides on its own.
- Cost: doesn't literally answer "how many days since last render" if that specific number
  is wanted for its own sake. The challenge pass pushed back on treating this as a minor
  gap: version drift and "nobody has touched this repo in months" are genuinely different
  questions — a repo can sit at 0 drift indefinitely simply because navori hasn't shipped
  anything new, independent of how long ago it was last rendered. B answers "is this repo
  behind right now"; it does NOT answer "has anyone looked at this repo lately," which is
  arguably closer to the literal words of the ticket title. B does not strictly dominate A.
- Cost of reversal: low — it's a read-only reporting command; nothing about it is hard to
  change later. The batch-abort bug above, however, is a real correctness cost to fix
  regardless of which approach ships (it affects `render --all`/`workspace render` today,
  independent of this ticket).

### C — Do B now; revisit A only if the raw "days since" number is still wanted afterward

- Ship B first (it reuses more of what exists and gives an exact rather than a proxied
  signal). Once fleet-wide checking is one command, re-ask whether "days since render"
  still earns its keep for the narrower "repo neglect regardless of drift" question — easy
  to bolt on later as a JSON field once B's loop exists, without having pre-committed to
  where the timestamp lives.

## Chosen solution (recommended, pending confirmation — see Open questions)

Leaning **B**: implement `doctor --all` (and `workspace doctor <name>` for parity with
`workspace render`) by extracting the repo-list-iteration + roll-up pattern already proven
in `render.ts:891-985` — with its own per-repo error-isolated config loading, NOT a copy of
`renderRepoRows`'s `runRender`/`readConfigOrExit` call, which the challenge pass showed
aborts the whole batch on one bad config. Why not A: it's cheap but doesn't fix the
diagnosed problem (per-repo passive fields aren't seen by someone who isn't looking at that
repo) and duplicates, with a strictly weaker signal, information `doctor` already has
exactly for the *drift* half of the ticket. Why this isn't a clean "B wins, ship it" call:
the challenge pass confirmed B does NOT cover the "repo neglect at 0 drift" reading of the
ticket — that gap is real, not manufactured caution.

This is a recommendation, not an implemented decision — see **Open questions** for why this
stays BLOCKED rather than READY/CONCERNS.

## Boundaries & contracts

- `doctor --all` would be read-only in all cases (no `--apply` concept — health-checking
  never writes). Its JSON shape should mirror `render --all --json`'s `{ repos: [...],
  summary: {...} }` envelope for consistency, but keyed on `ok`/`drift`/hard-issue counts
  instead of render's `written/would-write/up-to-date`.
- `workspace doctor <name>` would sit next to `workspace render <name>` in
  `workspace.ts:499-551`, reusing the same `ws.repos.map(...)` shape.

## Failure modes

- **Corrupted/schema-invalid `navori.config.json` in one registered repo must not kill the
  batch for the other 20.** Confirmed today: `renderRepoRows`'s use of `runRender` →
  `readConfigOrExit` → `process.exit(1)` (`render.ts:226`, `cli-config.ts:13-30`) is
  uncatchable and aborts `render --all`/`workspace render` entirely on the first bad repo.
  B's loop must use a local `readConfig` + `try/catch` per repo (as single-repo
  `doctor.ts:78-103` already does) and report that repo as an "error" row, continuing the
  rest. Worth flagging as a pre-existing bug in `render --all`/`workspace render`
  independent of this ticket, since it undermines the same "check my fleet in one shot"
  promise those commands already make.
- **A registry entry whose path no longer exists** is already handled gracefully by the
  pattern being reused (`render.ts:897-905`, `existsSync` guard → `"missing"` row) — no new
  work needed here, this one's fine as-is.

## NOT in scope

- Any new always-on/background process inside navori (a daemon, a watcher) — automation is
  the user's own cron/CI calling `doctor --all --json`, not new navori infrastructure.
- Deciding A's storage location (config.json field vs. separate state file) — deferred
  behind the open question below; not designed here because B may remove the need for it.
- Fixing the `render --all`/`workspace render` batch-abort bug itself — it's called out here
  because B's design must not inherit it, but fixing the existing commands is a separate,
  already-shippable bugfix independent of this ticket's scope decision.

## Open questions

- **[human] Which do you want built: A (literal per-repo date+threshold), B (`doctor
  --all`/`workspace doctor`), or C (B now, revisit A later)?** This is the actual blocker:
  implementing A as literally asked, when it doesn't close the discoverability gap the
  ticket describes and duplicates — for the drift half of the problem — an exact signal
  that already exists, means guessing that you still want it anyway (e.g. for a reason
  outside this repo — a dashboard, a Slack digest keyed off a `lastRenderedAt` JSON field —
  that read-only code research can't see). Implementing B instead, without asking, silently
  substitutes a different feature for the one the backlog ticket named, and — confirmed by
  the adversarial challenge pass (`solution_review_doctor-last-render.md`) — B genuinely
  does NOT cover "has anyone touched this repo lately regardless of drift," which is a
  legitimate, different reading of the ticket title. This isn't manufactured caution on a
  MEDIO ticket: it's a real fork that static code reading can't resolve on its own. Either
  path without a nod from you is a scope decision made without the ticket owner.
- **[repo, resolved]** If B is picked, the design must not copy `renderRepoRows`'s
  `runRender`/`readConfigOrExit` call verbatim — confirmed via `cli-config.ts:13-30` that it
  `process.exit(1)`s uncatchably on one bad repo config, aborting the whole batch. B's loop
  needs its own per-repo `try/catch` around `readConfig` (mirroring `doctor.ts:78-103`).
  Not something to ask about — just something the implementer must not miss if B is chosen.
- **[assumed]** If B is chosen: no `--apply`/write mode for `doctor --all` (health-checking
  stays read-only, same as single-repo `doctor`) — conservative default, flag if wrong.
- **[repo]** Resolved via reading, not asked: no existing `lastRender`/timestamp state
  anywhere in the codebase (grep came back empty) — the ticket's premise "no hay forma de
  saber" is accurate for a timestamp specifically, just not for drift itself.
