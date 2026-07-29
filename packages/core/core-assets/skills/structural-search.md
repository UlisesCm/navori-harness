---
name: structural-search
description: Use when locating something in code before reading it (a symbol, syntactic shape, structural relation, refactor site) — find the right region and open only the confirmed span instead of reading whole files; escalate from engram to Grep to ast-grep per the trigger.
type: reference
---

# structural-search — read the minimum correct amount

Find the right region first and open only the confirmed span. Precision tools verify a hypothesis; they don't form it.

## Ladder Rung 0–2

### Rung 0 — orientation (only if the repo has persistent memory)

If this repo has persistent memory (the engram plugin is enabled), consult it first for durable questions: where a module lives, entry points, layers, conventions and decisions. Use the result as a **scope hypothesis**, never as a source of truth for lines, signatures or call sites.

Confirm every pointer with a cheap search. If the code contradicts memory, correct the observation immediately. Save structural pointers, not volatile snapshots. Without persistent memory, skip this rung and start at Rung 1.

### Rung 1 — text with Grep/ripgrep (default)

Use it when you know a literal token: name, import, config key, error string.

1. Start narrow: file, directory or type obtained in Rung 0.
2. Ask first for files (`rg -l`) or `file:line` with at most two lines of context.
3. Dedup before reading.
4. Open only the span that confirms the hit.

Escalate to Rung 2 only if one of these happens:

- zero results after two reasonable patterns;
- the results are pure noise;
- you're writing regex to approximate syntax;
- you need a multi-site structural refactor.

### Rung 2 — structure with ast-grep

Use `sg` or `ast-grep` for AST shapes:

```bash
sg -p 'async function $N($$$) { $$$ }' -l ts src/
ast-grep -p 'useAuth($$$)' -l tsx apps/
```

To rewrite, first test the pattern without `--rewrite`, limit paths/language and review the diff before applying. A literal name is still Rung 1; a conceptual question goes back to Rung 0.

If neither binary exists, fall back to Grep and targeted reading: **don't block the task** nor invent ast-grep syntax.

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

<!-- user: document here proven sg/ast-grep patterns, frequent languages and paths. Save reusable patterns; don't paste results nor current lines. -->
