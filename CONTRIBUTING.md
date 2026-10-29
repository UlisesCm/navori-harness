> [English](CONTRIBUTING.md) | [Español](CONTRIBUTING.es.md) | [简体中文](CONTRIBUTING.zh-CN.md)

# How to contribute to navori

**Read [`docs/DIRECTION.md`](./docs/DIRECTION.md) first.** It is the source of truth for navori's purpose, goals, non-goals, and invariants. It applies to people and AI agents alike. If an idea conflicts with an invariant or reopens a non-goal, create or update a spec in `specs/` before changing code; do not introduce it through an isolated PR.

## Before coding

1. Read `docs/DIRECTION.md`, then `docs/architecture.md` (how rendering works and its five layers), and the spec or specs for the area you plan to change (`specs/000X-*.md`). Respect each spec's `Status` (`proposed` / `planning only — NO implementar` / `EJECUTADA`) and **verify it against the code**, which is the more current source. Several specs were written before implementation and still show their original intent in the header: 0001 and 0002 say `proposed` although their content is in production, and eleven specs have no status yet. A quick look at the code and `git log` reveals the actual state; anything still awaiting a decision is marked unambiguously as `planning only — NO implementar hasta aprobación`.
2. **Before writing, identify the layer where your change will have the greatest effect** — see [`docs/EXTENDING.md`](./docs/EXTENDING.md). There are five destinations, ordered from least to most expensive; the least expensive is often the most effective. If a skill already covers the topic, adding to it (its user section or `injectInto`) gets the guidance there sooner and uses an authority already in place. That guide also gives four questions that make a proposal stronger; answer them and your PR will be much easier to review.
3. Ask yourself: Is this the simplest solution? Will it be readable in six months? Does it follow the existing pattern? Simplicity over cleverness.

## Install dependencies

Run `bun install` from the repository root. The root `package.json` declares `"trustedDependencies": ["esbuild", "sharp"]`; without this, Bun ignores their postinstall scripts (previously, pnpm reported an error instead of a warning). Both dependencies need those scripts: esbuild downloads the native binary that Vitest depends on, and sharp compiles against libvips for the Astro site. They are listed explicitly and committed so a fresh clone can install without anyone having to approve anything manually.

## Quality gate (required before closing changes to `packages/cli`)

There are two levels:

- **Fast** — the versioned pre-commit hook (`bun hooks:install`) runs `bun check:fast` (format, jscpd, ast-grep, lint, typecheck), without tests. `qualityGate.fast` is `bun run check:fast`, so the agents' commit hook (`quality-gate-pre-commit.sh`, a PreToolUse hook on `git commit`) runs the same chain as the versioned pre-commit hook. The CI `fast` job, which runs on `dev` and on PRs to `dev`, also runs `check:dup` and `check:ast`, without tests.
- **Full** — `bun check`, described below. This is what the CI `quality` job runs for PRs to `main` and pushes to `main`; a failure fails the PR. It is the only level that runs tests and coverage.

1. **Run `bun check` from the monorepo root.** It is an alias for `qualityGate.full` in `navori.config.json`, the **only place** where the gate is defined. The managed blocks in `CLAUDE.md` and the command used by the `publisher` are generated from that configuration. Do not copy the gate into this or any other file: duplicate definitions drift out of sync. That has already happened (`repo-config-gate.test.ts` exists for this reason; see the end of this section).

   Watch out for these details:
   - **Use `bun run test:coverage`, not `bun test`.** It runs the same suite plus `check-coverage-floor.mjs`, which checks the threshold and catches stale entries in `KNOWN_ZERO` (modules navori ships without tests). Running only `bun test` misses this check; it has already caused a red CI run while the gate passed.
   - **`bun run format:check` (oxfmt) does not run under `packages/cli`**; it runs at the root and is the step most often forgotten. Fix formatting with `bun run format`.
   - **`blame.ignoreRevsFile`**: configure it with `git config blame.ignoreRevsFile .git-blame-ignore-revs` so `git blame` skips bulk-formatting commits (for example, the oxfmt migration, #889) listed in the root `.git-blame-ignore-revs`. Add a commit there **only after it lands on `main`** (through a `dev` → `main` PR that uses a merge commit), never in the same ticket PR that is squash-merged to `dev`: the squash rewrites the SHA, so the entry is no longer an ancestor of `main` (#986, #1004). As part of the gate, `bun run check:blame-ignore` requires both conditions for each entry: the commit is an ancestor of `origin/main`, and its diff is mechanical.
   - **Two gates running the same `test:coverage` against the same working tree** (two agents in one local session, not separate worktrees) will collide while writing to `packages/cli/coverage/` (#909). Isolate a run by exporting `NAVORI_COVERAGE_DIR=coverage-<algo único>` before the command. `vitest.config.ts` and `check-coverage-floor.mjs` read the same variable and fall back to `coverage`; leave the default unchanged for CI and the normal gate.

   - **Test temporary files are cleaned up per file.** Before each spec is imported, it receives an isolated directory with its own `HOME` and backups; the directory is removed after that file's local hooks finish. This also runs on every watch cycle and with configs that load only `setupFiles`. Environment values are restored afterward. The hook allows 30 seconds for slow deletions and waits 1 second for direct child processes; a full disk can still exhaust that allowance. The `dist` lock directory uses `NAVORI_TEST_COORDINATION_BASE`, which child processes inherit and which stays stable while `TMPDIR`/`TMP`/`TEMP` changes for fixtures.
   - To keep fixtures and reports generated during an investigation, run with `NAVORI_KEEP_TEST_ARTIFACTS=1`. Without it, reports generated by `test:coverage` are also deleted when Vitest or the coverage floor fails. If you set `NAVORI_COVERAGE_DIR`, that directory is yours and is always preserved. When cleanup retains evidence—for diagnosis, an active direct child, or an interruption—the output gives the exact path. The `HOME` guard test preserves that file's directory.

     Lifecycle cleanup covers standard Vitest workers and Node/Bun child processes that inherit the environment. Process tracking uses an experimental Node channel for direct children; it does not guarantee cleanup of detached grandchildren, processes that remove the environment, or custom configs that omit both `setupFiles` and `globalSetup`. Temporary assignments made while importing the config or its own setup files occur before isolation. `SIGKILL` or a restart prevents cleanup and path reporting. There is no historical sweep, quota, or maximum disk-size guarantee.

   **Local prechecks: oxlint + jscpd 5.4.0 + ast-grep 0.45.3**; the latter two are root devDependencies pinned to exact versions. `check:dup` scans the entire repo against the versioned `.jscpd-baseline.json`. It is silent on success; on failure, it reruns in verbose mode and marks new findings as `[NEW]`. `check:dup:baseline` runs `jscpd --update-baseline`. `check:ast` runs `ast-grep test --skip-snapshot-tests && ast-grep scan` (rules in `ast-grep/rules`, tests in `ast-grep/rule-tests`, config in `sgconfig.yml`). A missing tool is an error; it is never skipped. The scripts call `./node_modules/.bin/jscpd` and `./node_modules/.bin/ast-grep` explicitly, so they fail without `bun install` even if global binaries are available. `report/` (jscpd's JSON reporter output) is in `.gitignore`.

   The order of `qualityGate.full` (`bun check`) is: format:check, lint, typecheck, check:dup, check:ast, check:links, check:render, check:assets, check:doc-budgets, check:blame-ignore, check:size, test:coverage. `check:scoped` is the same without test:coverage; `check:fast` (pre-commit) runs format:check, check:dup, check:ast, lint, typecheck.

   **Duplication baseline.** It has 22 fingerprints, and a test caps it with `DUP_BASELINE_CEILING = 22`. Regenerate it (`bun run check:dup:baseline`) only when a formatting change or jscpd upgrade moves an existing clone, and justify the change in the PR. When removing a clone, regenerate the baseline and lower the ceiling (ratchet). Tests are scanned too.

   **Suppressions.** The only allowed forms are `// ast-grep-ignore: <rule-id>` (an ignore without an ID fails `no-bare-ast-grep-ignore`) and `// any justified: <razón>` immediately above the statement; the latter suppresses only `no-unjustified-double-cast` (`as unknown as`), **not** oxlint's `no-explicit-any`. When a line is suppressed for both tools (currently in `packages/cli/src/lib/gate/run.ts` and `packages/cli/src/commands/add.ts`), put `// ast-grep-ignore: no-shell-exec` above the call and `// nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true` at the end of its first line, plus `// prettier-ignore` so oxfmt does not move that comment. Keep both comments: the `semgrep` job on `main` still reads `nosemgrep`. ast-grep rules: no-shell-exec, no-unjustified-double-cast, no-explicit-any (in directories oxlint does not lint: `apps/website/src`, `scripts`, `packages/core`, `packages/plugins`, `.pi/extensions`), no-bare-ast-grep-ignore, no-bash-eval. Known gaps: ast-grep does not cover `.astro`, `.mjs`, `.py`, or almost all `.sh` files (except no-bash-eval); semgrep covers them only on `main`.

   **CI and semgrep.** The `quality` job (`main`) and `fast` job (`dev`) run `check:dup` and `check:ast`. The `semgrep` job runs only on `main` (pushes and PRs to `main`): it uses the official Docker image pinned by digest, `p/default`, a diff scan with `--baseline-commit` and `--error` (which blocks only new findings), and uploads SARIF to code scanning. All workflow actions are pinned to SHAs, as required by a test. This repo no longer uses navori's jscpd/semgrep plugins; the product still distributes them.

2. **If you changed anything that feeds rendering**, run `bun run check:render` from the root. This repo is self-hosted: `.claude/` and `CLAUDE.md` are output from `navori render`, so the PR must include a mirror re-render (`bun run render:apply` from the root, exactly `bun run --filter navori build && node packages/cli/dist/index.js render --apply`) or the `quality` job will fail (#421). **The build in that chain is not optional.** Without it, rendering compares against assets from the last build instead of your working tree; it reports `unchanged`, and `--apply` can revert the mirror. The alias prevents running only part of the sequence. Any of these four changes requires a re-render:
   - **Core assets**: `packages/core/core-assets/**`.
   - **Plugin assets**: `packages/plugins/*/{managed,scripts,skills,hooks}/**` and the `plugin.json` that declares them. The build packages them just like core assets (`packages/cli/scripts/copy-assets.mjs`), and they render blocks in `CLAUDE.md` and files under `.claude/`. **This is how #429 slipped through**: it changed a plugin asset, not a core asset, and the mirror was out of date for a day.
   - **A version bump in `packages/cli/package.json`**: each managed-block marker stamps `readCliVersion()`, so a version bump makes the **entire** mirror stale. In the measured 0.6.0 → 0.6.1 change, **30 files** were `updated`, including 16 `CLAUDE.md` blocks. A `chore(release)` commit is **not** an exception; see "Releases" in `README.md`.
   - **This repo's `navori.config.json`**, which defines what gets rendered.

   The check rebuilds before rendering on purpose: `dist/assets/` is a build-time copy of core and plugin assets. Rendering with an old `dist` compares against the previous assets and can pass silently.

   Two rules tend to become clear only after they have caused trouble (#435):

   - **A re-render becomes stale when the base moves.** After any rebase or merge of `dev`, run `bun run render:apply` again. Your mirror was generated from the earlier assets; if another asset PR landed in the meantime, your mirror is already stale. This happened three times in a row while #421 was being built.
   - **Never resolve a conflict inside a managed block by hand.** Take the version from the base and regenerate with `bun run render:apply`. Each block has a `hash` of its own content. Editing it by hand marks it as *user-modified*, so `render --apply` **stops overwriting it** and reports `user-modified-skipped`; that drift can then only be fixed with `navori sync`. This is an easy trap: when Git reports a conflict, the instinct is to edit it, but here that turns a one-command fix into a need to understand the marker model.

3. **If step 2 applied changes, the golden snapshot of the rendered tree changes too.** Regenerate it with `cd packages/cli && bun run test:golden` (~1 s) and **read the diff** before committing it. There are five fixtures, one per engine, at `packages/cli/src/engines/__tests__/__golden__/<engine>.snap`. They exist because the roughly 11 wiring tests check individual tokens, so no one sees the full output (#394). If you cannot explain a change in that diff, investigate it; do not flatten it away with `-u` as noise.

   One step-2 trigger does **not** affect the golden snapshot: a version bump. The snapshot normalizes the marker's `version=` and `hash=`, so a version bump changes 30 mirror files and **zero** golden lines. This is intentional: without that normalization, every release would invalidate the snapshot and it would stop providing useful signal.

`repo-config-gate.test.ts` checks the gate against `ci.yml` in **both** directions: if the workflow gains a step the gate does not declare, or the gate gains a step CI does not run, the suite fails and identifies it. Exceptions are kept in two maps, `EXEMPT_FROM_LOCAL_GATE` and `EXEMPT_FROM_CI`; every entry requires a reason, and both maps are checked for stale entries. The current exceptions are:

- **`check:assets:ci`** (in `EXEMPT_FROM_LOCAL_GATE`): it is the same check as `check:assets` with `--strict`. Strict mode depends on tags that CI intentionally provides and a fresh clone does not have, so the local gate would fail for an environmental reason rather than a code issue.
- **`check:assets`** (in `EXEMPT_FROM_CI`): CI runs its stricter superset, `check:assets:ci`.

For **doc-only** changes (.md), `bun run lint` and `bun run format:check` are enough; the full suite is not needed.
**"Doc-only" means repo documentation, not assets.** A `.md` file under `packages/core/core-assets/` or `packages/plugins/*/` is a source for the rendered harness, so it triggers steps 2 and 3 (the mirror and golden snapshot) regardless of its extension.

## Local development cycle

- **`bun run test:affected`** runs only the tests reached by the changes against the merge base with
  `dev`, including uncommitted changes and deletions. It is an iteration shortcut, not sign-off:
  closing (`bun check`) and CI run the full suite. Changes to Vitest config, `tsconfig*`,
  `package.json`, the lockfile, or `bunfig.toml`, and a missing merge base, run everything.
- **`bun run bench:tests`** and **`bun run bench:hooks`** write per-file duration and per-hook cost
  to `.navori/state/bench/` (the median of `--runs`, 3 by default), and record `loadavg`. A measurement
  under load is not useful for comparison.
- **Per-file budget:** `packages/cli/test-budget.json` sets `defaultMs` (20 s) for each test;
  `exceptions[]` raises it for a specific file, and every exception requires a `reason`.
  `check-test-budget.mjs --report` fails when a file exceeds its budget. CI applies it in the
  `quality` job with `NAVORI_TEST_BUDGET_FACTOR=2`.
- **`navori gate probe`** returns 0 when a cached green matches these exact bytes, and 1 otherwise.
  It never runs the gate. Pre-commit uses it (`navori gate probe --clean`) to skip
  `qualityGate.fast` on a hit; a hit never replaces a verdict.
- **`NAVORI_TEST_WORKERS`** (a positive integer) sets Vitest's worker count. Without it, the count is
  `min(CPUs - 1, 4, file-descriptor budget)`.

## Rust migration branch (`navori-rust` local)

Only on `migration/rust` ([spec 0057](specs/0057-migracion-rust/requirements.md)); `dev` and npm
stay TypeScript-only.

- **Install next to the TS CLI:** `cargo install --path crates/navori-cli --locked` installs
  `navori-rust` and never replaces `navori` (`command -v navori` keeps its path).
  `navori-rust --version` reports the internal prerelease `0.13.0-rust.<n>`.
- **Delegation:** a subcommand missing from `crates/ported.json` goes to the TS CLI (`NAVORI_TS_CLI`,
  then this checkout's `packages/cli/dist`, then `navori` in `PATH`). Run `bun run build` first.
- **Native commands:** `render` in preview runs natively on a Claude-only root without
  workspaces, with `--cwd`, `--dry-run` and `--json`, and only without color (a non-TTY stdout,
  no `FORCE_COLOR`, and `CI` only with `NO_COLOR`); anything else delegates before printing. Its provenance line reads
  `core: (embedded)`, and native commands skip the update notice until spec 0060.
- **Native hooks:** a hook in `ported.json` runs natively only where `navori-rust` is in `PATH`;
  otherwise the rendered shell runs. `NAVORI_HOOK_IMPL=shell` forces the shell and
  `NAVORI_HOOK_IMPL=rust` forces native evaluation, failing instead of deferring. Shadow
  observations land in `.navori/state/rust-shadow/` (`navori tools rust-shadow report`).
- **Sync with `dev`:** merge, never rebase. Branch from `origin/migration/rust`, run
  `git merge origin/dev` and open the PR against `migration/rust`. CI `freshness` fails when a
  first-parent `dev` commit older than 7 days is missing.
- **Checks:** `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`,
  `cargo test --workspace`, `bun run oracle:rust` and `node scripts/js/rust-manifest-check.mjs`.

## Prose budget: what is capped and what is only reported

All prose navori sends lives in each session's resident context, so it grows cumulatively: each session that learns something adds it, and nothing prunes it. There are **two startup surfaces**, deliberately treated differently.

| Surface | Who writes it | Capped? | Who monitors it |
|---|---|---|---|
| Managed assets (`core-assets/managed/`, `presets/*/managed/`, `plugins/*/managed/`) | navori | **Yes**, per file | `bun run check:doc-budgets` in the gate |
| Computed blocks (`contexto-proyecto`, `agentes-disponibles`) | navori, from consumer configuration | **Yes**, using `base + k · filas` | `navori doctor` (reports only) |
| Consumer-owned prose outside markers | The repository owner | **No, never** | Reported only |
| `.claude/context/*.md` | navori | **Not yet** (#919) | `navori doctor` (reports only) |
| `AGENTS.md` (engine prose) | navori | **No** — reported against the host's cap | `navori doctor` (yellow warning from 80%) |

The caps live in one place: `packages/cli/src/lib/assets/doc-budgets.ts`. It is under `src/lib/`, not in a JSON file under `scripts/`, because npm publishes `["dist", "README.md"]`. `doctor` must read the same values inside a consumer's repo, which is possible only if they are in the bundle. Policy: every cap has **at least 5% headroom** above the measured value, and any increase must be justified by the change requesting it. Setting a cap to the exact passing value is how `CLAUDE.md` reached 2548/2550.

Three decisions may not be obvious:

- **Consumer prose is not capped.** navori has no standing to cap another repo's `CLAUDE.md`. This repo itself has 536 words of owner-written prose versus 1771 managed words. Report the amounts separately ("X yours, Y navori's") and stop there.
- **Computed blocks cannot have a constant cap.** `contexto-proyecto` is 54 words here and 335 in `bonum-dashboard`—6.2 times as much—only because that repo declares more `project.*` entries, which is the intended use of the tool. The `k` is deliberately generous: the block accounts for the cost of each config entry instead of penalizing repos for having them.
- **The `doctor` report does not change `ok` or fail `--strict`.** There are 30 repos in the global registry; making the report affect the verdict would turn them red on the day of a bump because of legitimate prose. `render` also does not print a fixed informational line: it warns only when a cap is crossed in that run.

One metric detail matters when reading a number: **blocks without a cap are excluded from the comparison**. A block navori does not budget (typically a removed block still present in an old file) adds words to the total but contributes zero to the cap. Including it in the ratio would report excess invented by the metric. In the actual `CLAUDE.md` for `bonum-webapp`, `engram-protocol` (497) plus `codegraph-protocol` (255) accounted for **752 of 1207** reported excess words, or 62%. They are counted separately and named on their own line, not hidden.

The prose surface (`AGENTS.md`, shared by `codex`, `agents-md`, `cursor`, and `copilot`) is measured in **bytes**, not words, because the only limit there belongs to the host. Codex concatenates files from the root downward and **stops adding files** when it reaches `project_doc_max_bytes` (32 KiB by default), without warning. No word cap detects that silent truncation. navori reports only its own contribution: the chain also includes the user's `~/.codex/AGENTS.md` and nested `AGENTS.md` files, so the measurement is a **lower bound**. It is not measured block by block either: `AGENTS.md` renders as one `navori-agents` block, and a per-block report would say `ceiling 0, overBy 0`—a line that could never fail. Per-block diagnostics would change the marker topology of an already deployed file, a critical area, and require a separate spec.

The distinction that determines what to do about a warning is: **"your file is large" is not the same as "your file is stale."** A `CLAUDE.md` rendered by an older version can contain blocks that have since shrunk. In `bonum-webapp`, `navori render --apply` removes 1175 words (−37%) without requiring an owner decision. That is why `doctor` reports staleness first: it is the only fix that requires no decision.

One last number in the report is worth remembering when writing managed prose: **each subagent reloads `CLAUDE.md` and the project rules from scratch** into its own context (Claude Code, "What loads at startup"; only `omitClaudeMd` prevents this). There is no fixed multiplier—the ticket determines how many agents run—but an implementer→reviewer→publisher cycle loads that file once per agent, in addition to the main session. **This is a Claude-specific fact, not portable across engines**: a Codex subagent starts from its own agent file with required `developer_instructions`, so the report omits this line when `engines` does not include `claude`.

## Hook partials and their behavior test

Partials in `core-assets/hooks/_partials/` are included in hooks with `# navori:include <nombre>`. A partial earns its place only if a **core** hook includes it, and it is trusted only while a test that runs that hook names it. [hook-includes.test.ts](packages/cli/src/lib/render/__tests__/hook-includes.test.ts) checks both conditions mechanically:

- A new partial needs a core consumer or an entry in `PLUGIN_ONLY_PENDING_REMOVAL`. That list is only for partials whose sole consumer is a plugin; remove the entry along with the plugin.
- Every partial not on that list needs a row in `PARTIAL_BEHAVIOUR_TESTS`, with `{ hook, file, title }`: `hook` is the core hook that includes it, `file` is the test that exercises its behavior, and `title` is the exact test name, which must appear literally in `file`. The file must also name the hook.
- A row with no corresponding partial (a stale row) also fails.

So a new partial without a behavior test fails the suite; it does not pass silently.

## Commits and PRs

- Commits: Conventional, Mexican Spanish, atomic (`feat|fix|chore|docs(scope): mensaje`).
- Start each ticket on a new branch based on `dev`, and open a PR to `dev` (CI runs format, lint, and typecheck, but not tests). Merge `dev` into `main` through a PR using a merge commit, not squash; that PR must pass the full gate.
- Do not commit the local harness (`CLAUDE.md`, `.claude/`) in a `/bonum` repo.
