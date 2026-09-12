---
name: structural-search
description: Use when locating something in code before reading it (a symbol, syntactic shape, structural relation, refactor site) — find the right region and open only the confirmed span instead of reading whole files; escalate from engram to Grep to ast-grep per the trigger.
type: reference
# 600 y no 500 (spec 0020, R4): recibió el reparto shell/nativo y la medición de los
# 835 round-trips del clasificador, que salieron de `operaciones-seguras`. Misma razón
# que en `tgrep-rung`: se cambia costo por sesión por costo por uso.
maxWords: 600
# El techo del archivo COMPUESTO, que es lo que el agente carga (#683): 600 del
# núcleo + 200 de `codegraph-rung` + 550 de `tgrep-rung` = 1350, más 50 de margen
# para lo que el render interpola dentro del bloque managed. El `maxWords` de
# arriba sigue siendo el presupuesto de ESTE asset y su razonamiento: que un
# plugin le agregue una rung no debe borrarlo.
maxWordsComposed: 1400
---

# structural-search — read the minimum correct amount

Find the right region first and open only the confirmed span. Precision tools verify a hypothesis; they don't form it.

## Ladder Rung 0–2

### Rung 0 — orientation (only if the repo has persistent memory)

If this repo has persistent memory (the engram plugin is enabled), consult it first for durable questions: where a module lives, entry points, layers, conventions and decisions. Use the result as a **scope hypothesis**, never as a source of truth for lines, signatures or call sites.

Confirm every pointer with a cheap search. If the code contradicts memory, correct the observation immediately. Save structural pointers, not volatile snapshots. Without persistent memory, skip this rung and start at Rung 1.

### Rung 1 — text with Grep/ripgrep (default)

Use it when you know a literal token: name, import, config key, error string.

Native `Grep` first — it IS ripgrep, pre-approved, ~0.08s vs ~0.20s (p75 1.83s) by shell. In auto mode the shell also pays a classifier round-trip unless a narrow allow rule covers that exact command; those resolve before the classifier. Shell `rg` is the fallback (git history, context flags), not the default.

1. Start narrow: file, directory or type obtained in Rung 0.
2. Ask first for files (`Grep` files mode; `rg -l` via shell) or `file:line` with at most two lines of context.
3. Dedup before reading.
4. Open only the span that confirms the hit.

**The shell is for what those tools don't cover** — FS metadata (`-size`, `-mtime`, permissions). `find` isn't pre-approved on purpose: with `-exec`/`-delete` it isn't purely read-only, so the prompt there is the right safety net rather than a nuisance. And when a command genuinely must be shell, the shape that costs is MANY small ones — a measured session spent 835 classifier round-trips, so `cmd1 && cmd2` in a single call beats two calls.

Escalate to Rung 2 only if one of these happens:

- zero results after two reasonable patterns;
- the results are pure noise;
- you're writing regex to approximate syntax;
- you need a multi-site structural refactor.

### Rung 2 — structure with ast-grep

`ast-grep` is the canonical binary for AST shapes — spell it out in full:

```bash
ast-grep -p 'async function $N($$$) { $$$ }' -l ts src/
ast-grep -p 'useAuth($$$)' -l tsx apps/
```

Homebrew also installs it as `sg`, and that alias is deliberately NOT pre-approved: on Linux `sg` is shadow-utils — `sg <group> -c "<command>"` runs an arbitrary command, so allowlisting it would bypass the whole permission layer. Type `ast-grep`.

To rewrite, first test the pattern without `--rewrite`, limit paths/language and review the diff before applying. A literal name is still Rung 1; a conceptual question goes back to Rung 0.

If it isn't installed, fall back to Grep and targeted reading: **don't block the task** nor invent ast-grep syntax.

## Quick map

| Need | Rung |
|---|---:|
| Where an adapter or convention lives | 0 |
| Known import, symbol or message | 1 |
| Hooks/components with a concrete shape | 2 |
| Multi-site codemod | 2 |
| Cross-file semantics with types | manual read of the confirmed span |

## Limits

- Don't read whole files by reflex.
- Don't run wide grep without scope.
- Don't use regex as AST.
- If the search consumes ~15% of the context, stop: reduce scope or act on the available evidence.
- Don't set up LSP/Serena; this harness ends at Rung 2.

<!-- navori:user-section -->
## The project's structural patterns

<!-- user: document here proven ast-grep patterns, frequent languages and paths. Save reusable patterns; don't paste results nor current lines. -->
