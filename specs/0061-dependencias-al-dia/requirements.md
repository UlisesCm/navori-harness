# Dependencies up to date — Requirements

## Context

The monorepo toolchain, dependencies and CI actions are one to four majors behind (snapshot 2026-10-26 from `bun outdated` and the actions' latest releases). The user asked to bring everything to the latest version in one PR to `dev`, with Node 26.12.1 for local development and the whole CI on Node 24, while the published CLI keeps accepting Node ≥22.12.

## Requirements (EARS)

- **R1** — Local development SHALL pin Node 26.12.1 in `.nvmrc`, and every CI job SHALL run on Node 24 (`node-version: 24`); the toolchain SHALL pin Bun 1.4.4 (root `packageManager`, every CI `bun-version`).
- **R2** — The root `engines.node` SHALL stay `>=24` and the published `navori` package SHALL keep `engines.node` at `>=22.12`.
- **R3** — Every dependency and devDependency of the root, `packages/cli`, `packages/core` and `apps/website` SHALL resolve to its latest published version, except `@types/node`, which SHALL track the latest release of major 24 so typecheck rejects APIs the CI runtime lacks; `bun outdated --recursive` SHALL report only that held package.
- **R4** — WHEN an upgraded major (citty, @clack/prompts, astro, @ast-grep/cli, Pi packages) changes an API the repo uses, the repo SHALL adopt the new API so every registered CLI command, interactive prompt, ast-grep rule, Pi integration and website page keeps its current observable behavior.
- **R5** — Every GitHub Action in `.github/workflows` SHALL reference the commit SHA of its latest release, with the trailing comment naming that release, and the workflows SHALL keep their current jobs and outputs.
- **R6** — WHEN an upgraded linter or formatter (oxlint, oxfmt) introduces new findings or formatting, the repo SHALL fix the findings or format the code, and SHALL NOT disable a rule without a recorded reason.
- **R7** — The upgrade SHALL leave `bun check` and the full CI plan green, and SHALL NOT raise the published CLI bundle size above the `check:size` budget.

## Exclusions

New dependencies, replacing a library with another, refactors unrelated to an upgrade, npm publication, the Rust migration branches (`migration/rust`), and raising the CLI's minimum Node.
