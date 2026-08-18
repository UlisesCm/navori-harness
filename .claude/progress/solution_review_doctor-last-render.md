# Solution review — doctor: warn when a repo hasn't been re-rendered in a while

Adversarial falsification pass over `.claude/progress/eval_E_solution.md`. Read-only; no
verdict issued here (that's the author's/orchestrator's call).

## Findings

### BLOCKER — Approach B's model (`render --all` / `workspace render`) kills the ENTIRE batch on one corrupted repo config, contradicting the "small diff, proven pattern" framing

The artifact recommends building `doctor --all`/`workspace doctor` by "reusing
`renderRepoRows`'s exact shape" (render.ts:891-985) and calling it a small, low-risk diff
because the pattern is already proven by `render --all`/`workspace render`. Tracing the actual
call chain shows the pattern is NOT robust to the one failure mode the ticket's own scenario
guarantees will eventually happen across 21 registered repos: a present-but-invalid
`navori.config.json` in exactly one of them.

- `renderRepoRows` (`packages/cli/src/commands/render.ts:891-967`) does guard the "path
  doesn't exist" case gracefully — `if (!existsSync(repo.path))` at line 897 pushes a
  `"missing"` row and `continue`s, never touching config. That part of the artifact's claim
  holds.
- But for a path that DOES exist, it calls `runRender(repo.path, ...)` (line 908) inside a
  `try/catch` (907-964) that can only catch *thrown* JS exceptions.
- `runRender` (`render.ts:162-227`), after its own `existsSync(configPath)` early return,
  calls `const config = readConfigOrExit(configPath);` at **render.ts:226**.
- `readConfigOrExit` (`packages/cli/src/lib/cli-config.ts:13-30`) does NOT throw on a
  `ConfigError` (invalid JSON / failed Zod schema validation) or `NavoriError` — it prints via
  `p.cancel` and calls **`process.exit(1)`** (lines 18-22, 25-26). `process.exit()` terminates
  the Node process immediately; it is not catchable by the surrounding `try/catch` in
  `renderRepoRows`, and execution never returns to the loop.
- `workspace render <name>` (`commands/workspace.ts:538`) calls the exact same
  `renderRepoRows`, so it has identical exposure.

Net effect verified by tracing the code (not run live): **today**, `navori render --all` (and
`workspace render <name>`) will abort the whole invocation — reporting nothing for the
remaining repos — the moment it reaches one registered repo whose `navori.config.json` is
malformed JSON or fails schema validation, even though every other repo in the list is fine.
This is precisely the scenario the task asked to probe ("what happens when doctor --all hits
... a repo whose navori.config.json is corrupted") and the artifact never checked it — it cites
this exact code region as evidence the approach is cheap and low-risk without verifying that
the region already handles partial failure correctly. It doesn't, for this specific case.

This matters more for B than it would for a one-off script: B's entire value proposition is
"see the health of N repos in one shot without opening each one." A design that regresses to
"one bad config silently hides the other 20 reports" is arguably worse than the status quo the
ticket complains about (manual per-repo `doctor` at least degrades one repo at a time). The
design's "Boundaries & contracts" section is silent on per-repo error isolation for a
`doctor --all`/`workspace doctor` implementation — an implementer copying the cited pattern
literally (e.g. reaching for `readConfigOrExit` for convenience, since it's already imported in
that file) would reproduce the bug in the new command too. `computeHealthVerdict`/
`scanManagedDrift` themselves don't load config (they take an already-parsed `config` object),
so the batch loop needs its OWN per-repo config loading — and that loading needs to mirror
single-repo `doctor.ts:78-103`'s try/catch-without-exit `ConfigError` handling (turn it into an
"error"/"corrupted" row and continue), not `readConfigOrExit`. This is a real, fixable gap, but
it is currently unaddressed by the design and disproves the "no hidden complications" claim for
this specific axis the task asked about.

**Evidence:**
- `packages/cli/src/commands/render.ts:897-905` — missing-path case handled gracefully (fine).
- `packages/cli/src/commands/render.ts:907-908` — `try { const result = runRender(repo.path, ...) }`.
- `packages/cli/src/commands/render.ts:226` — `const config = readConfigOrExit(configPath);` inside `runRender`.
- `packages/cli/src/lib/cli-config.ts:13-30` — `readConfigOrExit` calls `process.exit(1)` on `ConfigError`/`NavoriError`, not a throw.
- `packages/cli/src/commands/workspace.ts:538` — `workspace render <name>` reuses the same `renderRepoRows`, same exposure.
- Contrast: `packages/cli/src/commands/doctor.ts:78-103` — single-repo `doctor`'s own config
  loading (`readConfig` + local `try/catch` + `process.exit` only after handling THAT repo) is
  the correct per-repo-isolated pattern; it is not what B's cited reuse target uses internally.

---

### NOTE — Two of the artifact's `docs/DIRECTION.md` line citations are off by several lines (content is verbatim-accurate)

- Artifact's "what already exists" #6 cites `DIRECTION.md:28` for "el config checked-in es la
  única fuente de verdad" — actual line is **`docs/DIRECTION.md:34`** (confirmed via grep +
  read). Quote text itself is verbatim correct.
- Artifact's "what already exists" #7 cites `docs/DIRECTION.md:80` for "Features grandes
  nuevas cuando el pendiente es endurecer lo existente. Prioridad: calidad > tokens >
  velocidad." — actual line is **`docs/DIRECTION.md:55-56`** (confirmed via grep + read).
  Content is verbatim correct, and it's actually a stronger anchor than the artifact implies:
  it's listed as an explicit **non-goal** bullet in DIRECTION.md's non-goals section, not a
  loose background principle.

Doesn't affect the design's reasoning — just a citation-accuracy slip worth a quick fix given
the artifact's own evidentiary bar ("no cite, no finding").

---

### NOTE — Gitignored/uncommitted Bonum harness does NOT break Approach B's per-repo check (hypothesis in the task brief is falsified)

Traced every function `computeHealthVerdict` calls (`scanCorruptedSettings`,
`scanMissingInvariants`, `scanMissingPresetFiles`, `scanCodexHealth`, `scanDuplicateMarkers` —
all in `packages/cli/src/commands/doctor.ts`) plus `scanManagedDrift` itself
(`packages/cli/src/lib/health.ts`): **none of them call git** (no `execFileSync`/`git` usage
anywhere in `health.ts`; confirmed by grep). They are pure filesystem reads (marker comments,
JSON parsing, preset resolution). So whether `.claude/CLAUDE.md` is git-tracked or gitignored
(as it is in Bonum repos per this repo's own `CLAUDE.md`) is irrelevant to these two exact
functions — they'd behave identically either way.

This is also empirically corroborated: user memory records a full Bonum-fleet rollout
("*ROLLOUT a los 15 repos Bonum COMPLETADO (2026-07-22, 15/15 doctor.ok)*") that already ran
single-repo `doctor` — which internally calls the same `computeHealthVerdict` — successfully
against exactly this gitignored-harness shape.

For completeness: other doctor scans NOT proposed for B's per-repo call DO explicitly guard on
git (`scanGitHygiene`, `doctor.ts:1294-1295`, `if (!isGitWorkTree(cwd)) return null;`) — but
B's design only calls `computeHealthVerdict` + `scanManagedDrift`, not `scanGitHygiene`, so this
is moot unless the "hard issues" set is broadened later.

**Evidence:**
- `packages/cli/src/lib/health.ts` — no `execFileSync`/git references (grep, empty result).
- `packages/cli/src/commands/doctor.ts:703-712, 977-989, 805-825, 1138-1152` — `computeHealthVerdict`'s sub-scans, all filesystem-only.
- `packages/cli/src/commands/doctor.ts:1294-1295` — contrast: `scanGitHygiene` DOES guard on `isGitWorkTree`, but isn't part of B's proposed per-repo call.

---

### NOTE — Monorepo-workspaces-per-repo complication is already resolved internally; not a hidden cost for B

`scanManagedDrift` (`packages/cli/src/lib/health.ts:354-378`) and `scanMissingInvariants`
(part of `computeHealthVerdict`, `packages/cli/src/commands/doctor.ts:977-989`) both already
loop over `config.monorepo?.workspaces` internally and fold workspace-level results into the
single per-repo return value. A `doctor --all` loop calling `computeHealthVerdict(cwd, config)`
+ `scanManagedDrift(cwd, config)` once per registered repo therefore needs no extra
monorepo-aware plumbing of its own — this specific "hidden complication" the task asked about
does not materialize. This part of the artifact's "small diff" framing holds up.

---

### NOTE — i18n/lang differences across repos also not a hidden cost; render.ts already sidesteps it by precedent

`renderAllRepos`/`reportRepoRenderRows`/`summarizeRenderEntries`
(`packages/cli/src/commands/render.ts:872-884, 994-1044`) already use hardcoded English
row/summary labels ("preview", "created", "up-to-date", etc.) regardless of each individual
repo's own `language:` config — no per-repo `tc(lang)` localization happens at the batch level
today. A `doctor --all` modeled the same way would trivially follow the same precedent. Not a
hidden complication; just needs to match the existing convention (worth a one-line note in the
design if it's ever written up further, but not a gap that breaks anything).

---

### NOTE — "B strictly dominates A" is not actually true; evidence supports BLOCKED being a genuine fork, not over-caution

Checked whether the human-input gate is manufactured caution on a MEDIO ticket. It isn't: the
artifact's own Approach B cost bullet and Approach C rationale already concede that B never
produces the literal "days since last render" number, and that this number answers a
genuinely different question (repo *neglect* — nobody has touched it in months) than version
*drift* (a repo can show 0 drift purely because navori hasn't shipped anything new since the
last render, independent of how long ago that was). A ticket author who specifically wants to
catch "nobody has looked at this repo in months" even when it's at 0 drift would NOT be served
by B alone. This is a real, non-hypothetical scope fork that static code reading legitimately
can't resolve on its own — it supports treating this as BLOCKED-worthy rather than over-caution
on a MEDIO ticket. (Reporting the evidence only; the READY/CONCERNS/BLOCKED call is the
author's/orchestrator's, per instructions.)

---

### NOTE — All four requested factual-claim checks pass verification

1. **No timestamp/lastRender state anywhere in `packages/cli/src`** — confirmed via
   `grep -RniE "lastRender|renderedAt|timestamp|lastRun"` (excluding tests): only hits are in
   `lib/migrate.ts`, `lib/backup.ts`, `commands/backup.ts`, `commands/migrations.ts` — all
   *backup-snapshot* and *migration-folder* timestamps, unrelated to render/doctor state.
   `MarkerInfo` (`packages/cli/src/lib/health.ts:24-29`) confirmed to carry only
   `id/hash/version/source`, no timestamp field.
2. **`scanManagedDrift` compares against the live installed CLI version** — confirmed:
   `packages/cli/src/lib/health.ts:359` (`const naviVersion = readCliVersion();`) inside
   `scanManagedDrift` (354-379); `readCliVersion`
   (`packages/cli/src/lib/bundled-assets.ts:76-92`) reads the running navori's own
   `package.json` version. `doctor.ts:344-362` confirmed to format `fromVersion → toVersion`
   per drifted marker, exactly as claimed.
3. **`doctor` has no `--all` flag; `render --all`/`workspace render` do the described
   iteration+roll-up** — confirmed: `doctor.ts`'s `args` block (lines 45-52) has only
   `cwd`/`json`/`strict`. `renderRepoRows`/`rollupRenderRows`/`reportRepoRenderRows`
   (`render.ts:891-1044`) and `renderAllRepos` (`render.ts:1051-1144`) confirmed to do exactly
   the repo-list-iterate + roll-up described. `workspace.ts:499-550`'s `renderSubCommand`
   confirmed to reuse the same `renderRepoRows`.
4. **`writeConfig` never called from `render.ts`** — confirmed via
   `grep -rn "writeConfig(" packages/cli/src`: call sites are exactly `scan.ts:77`,
   `preset.ts:98`, `workspace.ts:405`, `add.ts:163`, `init.ts:315,703`, `remove.ts:80,106`,
   `configure.ts:49`, `update.ts:454` — matches the artifact's list precisely; `render.ts` has
   zero occurrences.

Also confirmed independently: `~/.navori/registry.json` on this machine has exactly 21 repo
entries (matches artifact's count); `.github/workflows/ci.yml` and a repo-wide search for
`schedule:`/cron references confirm there is no existing periodic/scheduled mechanism in this
repo that runs `doctor` across the fleet — the artifact's claim that nothing already does this
today holds.

## What I did NOT look at (scope boundary)

- Did not check whether other navori commands (`status`, `sync`) have their own `--all`
  siblings that might set additional precedent beyond `render --all`/`workspace render`.
- Did not check test coverage for `renderRepoRows`/`readConfigOrExit` to see whether the
  corrupted-config-mid-batch scenario above is exercised by any existing test (a quick
  `grep -rn "readConfigOrExit\|ConfigError" packages/cli/src/commands/render.test.ts` type
  check would confirm whether this is a known-untested gap or actually covered and I mis-traced
  something — I traced the source only, did not run the suite).
- Did not evaluate Approach A's "separate state file vs. config.json field" storage-location
  sub-decision in depth (the design already defers it and I don't think that changes any
  finding above).
