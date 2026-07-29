---
name: turbo-workspaces
description: Use when navigating or operating a Turborepo + pnpm monorepo — running scoped tasks, adding deps to the right workspace, sharing code without coupling. Applies before touching turbo.json, pnpm-workspace.yaml, or moving deps.
type: reference
---

# Turborepo + pnpm — monorepo operation

## When to use this skill

Before: running build/test/lint tasks, adding or moving a dependency, creating a new workspace, or editing `turbo.json` / `pnpm-workspace.yaml`. In a monorepo, "where" a change lives matters as much as "what" changes.

## Running tasks (always scoped)

```bash
# One task in ONE workspace (by package name or by path)
pnpm turbo run build --filter=@scope/backend
pnpm turbo run test --filter=./apps/storefront

# One workspace and everything that depends on it (downstream)
pnpm turbo run build --filter=@scope/backend...

# Only what's affected by your diff vs a base
pnpm turbo run test --filter='...[origin/main]'
```

Rule: don't run the whole pipeline (`turbo run build`) if you only touched one app. Turbo caches, but log noise and startup time still cost. Leave the global run for CI.

## Adding dependencies (to the right workspace)

```bash
# Dep for a specific app — NOT at the root
pnpm add zod --filter @scope/backend

# Monorepo tooling dep (turbo, changesets, prettier) — that one does go at the root
pnpm add -Dw turbo
```

- A product lib (`stripe`, `@tanstack/react-query`, …) goes in the `package.json` of the app that imports it. If it lands at the root, that app's harness doesn't "see" it and its skill isn't materialized where it belongs.
- Consuming a sibling workspace is declared explicitly: `"@scope/ui": "workspace:*"` in the consumer's `package.json`. Never via `import '../../ui/src/...'`.

## Sharing code without coupling

- Code used by ≥2 apps → extract it to a `packages/*` with its own `package.json` and preset (`navori scan` detects it as a new workspace).
- Cross-app types/utilities also go in a `packages/*`, not in `apps/*`. An app is never a dependency of another app.

## turbo.json — the essentials

- Each `task` declares its `dependsOn` (`^build` = build deps first) and its `outputs` (for caching). A mis-declared output = a cache that doesn't invalidate or doesn't cache at all.
- Before editing the pipeline, check the effect with `pnpm turbo run <task> --dry-run` (lists what would run and from which cache) before actually running it.
