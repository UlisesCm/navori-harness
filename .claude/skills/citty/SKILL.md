---
name: citty
description: Use when adding or editing a CLI command with citty — defineCommand, runMain, typed positional/string/boolean/enum args, subCommands, `default`, and run/setup/cleanup hooks.
metadata:
  type: reference
  maxWords: 550
---

<!-- navori:managed id="citty" hash="481311c6" version="0.12.2" source="@navori/core" fmkeys="name,description,metadata" -->
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
    mode: { type: "enum", options: ["dev", "prod"], default: "dev", description: "Build mode" },
    minify: { type: "boolean", description: "Minify output" },
    out: { type: "string", alias: ["o"], valueHint: "dir" },
  },
  run({ args }) {
    console.log(args.mode, args.out ?? "dist");
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
- **A parent `run` fires after its subcommand too.** Parent `setup`/`cleanup` also wrap the child. For a fallback subcommand use `default: "list"` (it must name one of its `subCommands`; combining it with `run` throws), never a parent `run`.
- **`cleanup` runs even on throw.** It's your `finally`; keep it idempotent and side-effect-safe.
- **Positionals take no `alias`; kebab flags have two names.** `--out-dir` lands as `args["out-dir"]` and `args.outDir`; pick one. A missing `required` positional throws before `run`.
- **Unset optional string/enum is `undefined`, not `""`.** Give a `default` or guard before use.

## Hard rules

1. One `defineCommand` per file, exported; wire the tree in the entrypoint, `runMain` once.
2. Declare every input in `args` with an explicit `type` and `description` — never read `rawArgs` by hand.
3. Model a constrained choice as `type: "enum"` with `options`, not a `string` checked by hand. Repos still on citty 0.1 (no `enum`, no `default`, mri-style parser) validate in `run` and fall back in a parent `run`.
4. Lazy-load heavy subcommands: `sub: () => import("./sub.ts").then((m) => m.default)`.
5. Side effects (fs, network) live in `run`, never at module top level — imports stay pure.
6. Use `required: true` for mandatory input; let citty throw rather than validating presence yourself.

## Quick table

| Need | Use |
|---|---|
| Yes/no flag | `{ type: "boolean" }` (`--no-x` negates) |
| Constrained choice | `{ type: "enum", options: ["a", "b"] }` |
| Nested command | `subCommands: { build }` |
| Fallback subcommand | `default: "list"` beside `subCommands` |

## Before declaring done

- Every arg has a `type` and `description`; enums carry `options`; user flags have defaults.
- Built-in `--help`/`--version` still work (no shadowing alias).
- No side effects at import time; `cleanup` is idempotent.
- `bun run check:fast` green.
<!-- /navori:managed id="citty" -->

## This repo's CLI (your domain)

<!-- user: add here what only applies to THIS repo. Suggestions:
     - The commands that exist and their hierarchy.
     - The shared-flag convention (--cwd, --json, --dry-run) and what each means.
     - Exit codes and what each one signals to a CI pipeline.
     - The output format: what goes to stdout (pipeable) vs. stderr.
-->
