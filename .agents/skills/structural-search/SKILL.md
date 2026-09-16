---
name: structural-search
description: Use when locating something in code before reading it (a symbol, syntactic shape, structural relation, refactor site) — bounded reading, a native-search fallback, and ast-grep for AST shapes. Not the entry point for relationships or impact: that's Code discovery routing's structural provider.
metadata:
  type: reference
  # 600 y no 500 (spec 0020, R4): recibió el reparto shell/nativo y la medición de los
  # 835 round-trips del clasificador, que salieron de `operaciones-seguras`. Se cambia
  # costo por sesión por costo por uso: el bloque always-on adelgaza y esto se paga al
  # usarse. Subido a 650 (#824): la doctrina de "silent skipping" — un canal caído no
  # es cero resultados — no cabía en el margen que quedaba.
  maxWords: 650
  # El techo del archivo COMPUESTO, que es lo que el agente carga (#683): hoy solo el
  # núcleo (650) más 50 de margen para lo que el render interpola dentro del bloque
  # managed. Un plugin que inyecte su propia rung aquí tiene que SUBIR este techo en
  # el mismo cambio — ese es el punto: el presupuesto compuesto se negocia una vez,
  # no se descubre cuando el agente ya paga el archivo entero. El `maxWords` de arriba
  # sigue siendo el presupuesto de ESTE asset y su razonamiento.
  maxWordsComposed: 700
---

<!-- navori:managed id="structural-search-base" hash="c94d052d" version="0.8.7" source="@navori/core" -->
# structural-search — bounded reading and AST shapes

Read the minimum correct amount: confirm the region before opening it, and use `ast-grep` only for genuine syntactic shapes — it is not a call-graph.

## When to reach for this skill

Apply Code discovery routing (project instructions) first to pick the right lane. Come here when routing lands you on one of these:

- The structural provider is unavailable, disabled, or already answered and you only need to open the confirming span.
- You're searching for a syntactic shape (a function signature, a hook call, a component prop pattern), not a relationship or a literal string.
- You need a multi-site structural refactor (rewrite the same shape across files).

This is not a replacement ladder for routing: relationships, definitions and impact go to the structural provider; literal text, regex, comments and config go to native search.

## Bounded reading

1. Start narrow: a file, directory or type you already have from routing or from the task itself.
2. Ask first for files (`Grep` files mode) or `file:line` with at most two lines of context — never a bare full-file read as a first move.
3. Dedup hits before reading.
4. Open only the span that confirms the hypothesis.

## Fallback: native search

Native `Grep`/`Glob` are pre-approved and read-only — the default lane for a literal token (name, import, config key, error string) or a filename/path pattern. Shell `rg`/`find` are for what those tools don't cover (git history, FS metadata like `-size`/`-mtime`); `find` isn't pre-approved because `-exec`/`-delete` make it non-read-only, so the prompt there is a safety net, not a nuisance.

**Silent skipping**: an unavailable fallback (no structural provider, no `ast-grep`) is not zero matches. Report the outage instead of folding it into "nothing found" — every optional piece here already states its own fallback (native search covers the absence of a structural provider; targeted `Grep` covers the absence of `ast-grep`), so a new one should too.

## ast-grep for AST shapes

`ast-grep` is the canonical binary for syntactic patterns — it matches shape, not text. Spell it out in full:

```bash
ast-grep -p 'async function $N($$$) { $$$ }' -l ts src/
ast-grep -p 'useAuth($$$)' -l tsx apps/
```

Homebrew also installs it as `sg`, and that alias is deliberately NOT pre-approved: on Linux `sg` is shadow-utils — `sg <group> -c "<command>"` runs an arbitrary command, so allowlisting it would bypass the whole permission layer.

To rewrite, first test the pattern without `--rewrite`, limit paths/language and review the diff before applying. It finds occurrences of a shape; it does not resolve call graphs or cross-file relationships — that question belongs to the structural provider under Code discovery routing. If `ast-grep` isn't installed, fall back to `Grep` and targeted reading: don't invent its syntax and don't block the task.

## Limits

- Don't read whole files by reflex.
- Don't run wide grep without scope.
- Don't use regex as AST.
- If the search consumes ~15% of the context, stop: reduce scope or act on the available evidence.
- Don't set up LSP/Serena — the structural provider covers relationships, `ast-grep` covers shapes.
<!-- /navori:managed id="structural-search-base" -->

## The project's structural patterns

<!-- user: document here proven ast-grep patterns, frequent languages and paths. Save reusable patterns; don't paste results nor current lines. -->
