---
name: citty
description: Use when adding or editing a CLI command with citty — defineCommand, runMain, typed args (positional/string/boolean/enum), subCommands, and run/setup/cleanup hooks.
type: reference
---

<!-- navori:managed id="citty" hash="68d15811" version="0.7.2" source="@navori/core" -->
# Citty — command definitions

## When to use this skill

When adding a subcommand, declaring typed args, wiring `run`/`setup`/`cleanup`, or debugging an unparsed flag. Citty is UnJS's zero-dependency builder over Node's `util.parseArgs`; the tree is `runMain` → root `defineCommand` → `subCommands`.

## The pattern

Each command is a `defineCommand` object: `meta` for help, `args` for typed input, `run` for the body. Nest `subCommands`; run the root once with `runMain`.

```ts
import { defineCommand, runMain } from "citty";

const build = defineCommand({
  meta: { name: "build", description: "Build the project" },
  args: {
    entry: { type: "positional", required: true, description: "Entry file" },
    mode: { type: "enum", options: ["dev", "prod"], default: "dev" },
    minify: { type: "boolean", description: "Minify output" },
    out: { type: "string", alias: ["o"], valueHint: "dir" },
  },
  run({ args }) {
    // args.entry, args.mode, args.minify, args.out (kebab also → camelCase)
  },
});

const main = defineCommand({
  meta: { name: "cli", version: "1.0.0" },
  subCommands: { build },
});
runMain(main);
```

## Gotchas that bite

- **A custom `-v`/`-h` shadows the built-ins.** Citty auto-handles `--version`/`-v` and `--help`/`-h`, but declaring an arg with the same name or alias silently disables them. Don't alias `verbose` to `v`.
- **Only the run command's hooks fire.** `setup`/`cleanup` run for the executing command, not its parents — a root `setup` won't run before a subcommand. Put shared init in the leaf.
- **`cleanup` runs even on throw.** It's your `finally`; keep it idempotent and side-effect-safe.
- **Positionals take no `alias`.** Alias is for flags. A missing `required` positional throws before `run`.
- **Kebab args have two names.** `--out-dir` lands as both `args["out-dir"]` and `args.outDir`; pick one.
- **Unset optional string/enum is `undefined`, not `""`.** Give a `default` or guard before use.

## Hard rules

1. One `defineCommand` per file, exported; wire the tree in the entrypoint, `runMain` once.
2. Declare every input in `args` with an explicit `type` and `description` — never read `rawArgs` by hand.
3. `enum` args always carry `options`; give user flags a `default` so `run` never sees `undefined`.
4. Lazy-load heavy subcommands: `sub: () => import("./sub.ts").then((m) => m.default)`.
5. Side effects (fs, network) live in `run`, never at module top level — imports stay pure.
6. Use `required: true` for mandatory input; let citty throw rather than validating presence yourself.

## Quick table

| Need | Use |
|---|---|
| Named flag | `{ type: "string", alias: ["o"] }` |
| Yes/no flag | `{ type: "boolean" }` (`--no-x` negates) |
| Constrained choice | `{ type: "enum", options: [...] }` |
| Required arg | `{ type: "positional", required: true }` |
| Nested command | `subCommands: { build }` |
| Lazy subcommand | `() => import("./x.ts").then((m) => m.default)` |

## Before declaring done

- Every arg has a `type` and `description`; enums carry `options`; user flags have defaults.
- Built-in `--help`/`--version` still work (no shadowing alias).
- No side effects at import time; `cleanup` is idempotent.
- `cd packages/cli && pnpm lint` green.
<!-- /navori:managed id="citty" -->
