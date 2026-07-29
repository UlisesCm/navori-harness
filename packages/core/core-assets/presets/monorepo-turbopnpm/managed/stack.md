## Stack — Monorepo (Turborepo + pnpm)

This directory is the **root of a monorepo**: it orchestrates, it doesn't host product. The real code lives in the workspaces (`apps/*`, `packages/*`), and **each workspace has its own harness** (its `CLAUDE.md` + `.claude/`) with its stack's preset. The map of live workspaces is in the "## Monorepo — root" block.

Golden rule: **route the work to the owning workspace**. A product change is made from its app's `CLAUDE.md`, not from here. The root is only touched for cross-cutting concerns: `turbo.json`, `pnpm-workspace.yaml`, base tsconfig/eslint, CI scripts, shared deps.

- **Scoped tasks, not global ones.** Run per workspace with Turbo's filter: `pnpm turbo run <task> --filter=<workspace>` (or `--filter=./apps/<x>`). Avoid running the whole pipeline when you only touched one app.
- **Don't cross imports between workspaces via relative paths** (`../../other-app`). Consume a sibling by its package name with the `workspace:*` protocol; if it's not a publishable package, the code probably belongs in a shared `packages/*`.
- **The dep goes in the `package.json` of the workspace that uses it**, not in the root. Root deps are only monorepo tooling (turbo, changesets, shared linters).

Before touching `turbo.json`, `pnpm-workspace.yaml` or moving deps between workspaces, apply the `turbo-workspaces` skill.
