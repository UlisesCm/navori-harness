> [English](README.md) | [Español](README.es.md) | [简体中文](README.zh-CN.md)

# Engines — adding a provider

An engine materializes the harness (agents, skills, hooks, and engine-specific files) in the format expected by a particular tool: `.claude/` for Claude Code, `.codex/` plus `AGENTS.md` for Codex, or `AGENTS.md`/`.cursor/`/`.github/` for prose engines.

This document is the contract for a future provider and the checklist for implementing one. It reflects Specs [0007](../../../../specs/0007-render-plan-unificado/design.md) (shared spine) and [0008](../../../../specs/0008-fase-c-claude-spine/design.md) (Claude on the spine).

## The three layers shared by every disk engine

```
resolveHarnessPlan ──▶ EngineAdapter (place*) ──▶ collectPlan ──▶ commitWrites
   (Capa 1, shared)      (Capa 2, por engine)       (Capa 3, shared, escribe una vez)
```

- **Layer 1 — `shared/harness-plan.ts`**: `resolveHarnessPlan(config, coreAssets, preset, { includeLeader })` resolves **what** to emit (agents/skills/hooks) from the config, preset, and libraries. It knows nothing about paths or formats. It is the same for every engine; the parity test (`__tests__/engine-parity.test.ts`) ensures Claude and Codex start with the same inventory.
- **Layer 2 — the engine adapter (`<engine>/adapter.ts` or inline)**: the only provider-specific layer. It maps each planned asset to a `PlacementRequest` (destination plus serialization) and declares `extraFiles` and `orphanScans`. About 80 LOC of declarative tables.
- **Layer 3 — `shared/execute-plan.ts`**: `collectPlan` (plans without writing) plus `commitWrites` (backup → atomic write → chmod → prune → report). This is shared once, so a fix to pruning, anti-rollback, or backups reaches every engine.

## The `EngineAdapter` contract (frozen in `shared/execute-plan.ts`)

```ts
interface EngineAdapter {
  id: string;
  label?: string;                                    // nombre para el mensaje de error
  placeAgent(a: PlannedAgent, ctx): PlacementRequest | null;   // null = no lo emite
  placeSkill(s: PlannedSkill, ctx): PlacementRequest | null;
  placeHook(h: PlannedHook, ctx): PlacementRequest | null;
  extraFiles(ctx): PlacementRequest[];               // settings.json / config.toml / AGENTS.md
  orphanScans(plan, ctx): OrphanScan[];              // poda de huérfanos managed
}
```

The adapter does not declare what to back up: `commitWrites` derives the backup from the files it will write or delete (#405). This prevents an engine from backing up too little (for example, forgetting `.mcp.json`) or too much (for example, all of `.claude/` for a one-byte change).

This rule applies beyond engines: **every render write goes through the choke point**, including writes that do not belong to an engine. `.gitignore` (repo-level, `shared/gitignore-harness.ts`) used to write directly and was the last write that bypassed backups—the very file Navori does not create, but edits by injecting a block into a file the user already owns (#458). Route every new write through `commitWrites`; the guard in `shared/__tests__/render-writes-backed-up.test.ts` fails if you do not.

That guard has two declared limits, so the rule above is not mistaken for a broader guarantee than the code provides. It scans `src/engines/**` and `commands/render.ts`, so a new write in `src/lib/**` called by render would escape it (today, all four render write sites are within the scan). It also decides **by module**: a file that calls `commitWrites`/`createBackup` anywhere passes, even if you add a raw write nearby. The behavioral half of the same test covers only what its fixture exercises. Checking at statement level would require ast-grep.

A `PlacementRequest` is either an asset (`assetPath`, rendered by `renderManagedFile`) or a `body` already serialized by the adapter (`config.toml`, an agent `.toml`). `firstRenderSeed` seeds the header/trailer on the first render only.

## Escape hatches for what the contract does not model

- An engine with its own files (settings, scripts, or a pipeline like `CLAUDE.md`) builds them in its `render<Engine>Engine` function, merges its `pending` writes with those from `collectPlan`, and calls **one** `commitWrites`. This shares backup behavior, write ordering, and the error surface. See `claude/index.ts` as a reference (the CLAUDE.md pipeline plus Claude-only three-way reconciliation on the shared spine).
- `commitWrites` parameterizes legitimate differences: `writeLast` (which file is written last), `backupExclude` (extra engine exclusions; ephemeral files are always excluded), `engineLabel`, `removalsBestEffort`, and `skipReason` (localized skip text) in `collectPlan`.

## Spike checklist for provider #3 (the four Phase 0 unknowns)

Before writing the adapter, resolve these four questions against the real CLI (the method used in Spec 0004 §Phase 0 for Codex):

1. **Hook payload** — What does a hook receive, and through which channel (stdin/env/arg)? Which events are available (PreToolUse/SessionStart/Stop…)? Do hooks run in a sandbox?
2. **Skill discovery** — Which directory does the tool read? (Codex: `.agents/skills/<id>/SKILL.md`; Claude: `.claude/skills/<id>/SKILL.md`, directory form—Claude Code auto-discovers that form only, not a flat `<id>.md` file.)
3. **Config location** — Where does project config live, and in what format? (Claude: `.claude/settings.json`; Codex: `.codex/config.toml`.)
4. **Model map** — How does the tool name its models? Map Claude tiers (opus/sonnet/haiku) to concrete ids (see `CODEX_MODEL_BY_CLAUDE_TIER` plus the `models.codexMap` override, Spec 0007 M3). Pi has its own `models.piMap` (`provider/id`); an engine must not read another engine's model map.

## DT-2 criterion — when to factor further (the rule of three)

With two implementations, an abstraction is guesswork; with three, it can be factored against real cases. The spine (Layers 1 and 3) already exists because Codex and Claude share it. The `EngineAdapter` contract (Layer 2) is **shaped with provider #3 in hand**, not beforehand: the three-layer structure is fixed, not every signature. A divergence bug (“a fix was applied to one engine and missed in the other”) is also grounds for factoring.

## Skills in the split root (`.agents/skills/`) — sealed (Spec 0007 M7)

Codex discovers repository skills in `.agents/skills/<id>/SKILL.md`, a **cross-tool** directory: other agents that follow the `AGENTS.md`/`.agents/` convention can read them too. The rest of Codex config lives in `.codex/`.

This split (`.agents/` for skills, `.codex/` for everything else) is **sealed**: it is the free multi-provider seam. A third provider that also reads `.agents/skills/` can share skills without another render. Do not collapse it into a single engine-specific tree.

**Recommendation for destination repositories**: check in `.agents/skills/` and `.codex/` (they are managed and can be rebuilt with `navori render`, but are useful in the PR diff). If you prefer not to check them in, add them to the destination repository's `.gitignore` alongside `.claude/`—Navori does not manage the repository's `.gitignore`; that is the team's decision.

> **`.codex/hooks/` and worktrees**: unlike `.claude/`, checking in `.codex/hooks/` is not just cosmetic. If `.codex/` is gitignored or untracked, a newly created git worktree does **not** inherit it. A Codex session opened **inside** that worktree loads config relative to the project root (the worktree's `.git` marker), cannot find `.codex/config.toml`, and **does not register the hooks**—the destructive-command guard silently turns off. Codex runs hooks with the *session cwd* and exposes no project-root environment variable (equivalent to `$CLAUDE_PROJECT_DIR`), so resolving paths does not fix this. The robust defense is to **track `.codex/hooks/` in git** so it reaches each worktree and clone. `navori doctor` warns if these files are untracked (`guardNotVersioned`).

## Prose engines (agents-md / cursor / copilot) — do not use the spine

These engines share their own spine (`renderProseFile`) and are wrappers of about 40 LOC. They do not emit agents/skills/hooks as separate files; moving them to `EngineAdapter` would add churn without benefit (Spec 0007 DT-1).

Each adapter passes its `engine` (`"agents-md"`, `"cursor"`, `"copilot"`) to `renderProseFile`; this is required (#1273). It resolves the reserved condition keys `onCodex` and `onClaude` (both ignore config). `onClaude` is true only for `engine === "claude"`: `CLAUDE.md` receives the invariant plus the `intake-tickets` and `sdd` pointers, while prose engines (and Pi) retain the full text because they do not load skills.
