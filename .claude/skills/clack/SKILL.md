---
name: clack
description: Use when building interactive CLI prompts with @clack/prompts — intro/outro, text/select/confirm/multiselect, spinner, isCancel, and group flows.
type: reference
---

<!-- navori:managed id="clack" hash="f97d8d12" version="0.5.0" source="@navori/core" -->
# Clack prompts — interactive CLI

## When to use this skill

When building interactive flows: prompting the user (`text`/`select`/`confirm`/`multiselect`), bracketing a session with `intro`/`outro`, showing progress with `spinner`, or bundling steps with `group`. `@clack/prompts` is the UI layer; every prompt is `await`ed and can be cancelled.

## The pattern

Bracket the flow with `intro`/`outro`. `await` each prompt, then immediately check `isCancel` — on cancel, emit `cancel(...)` and exit. Import the namespace as `p`.

```ts
import * as p from "@clack/prompts";

p.intro("navori init");

const name = await p.text({
  message: "Project name?",
  placeholder: "my-app",
  validate: (v) => (v.length === 0 ? "Required" : undefined),
});
if (p.isCancel(name)) {
  p.cancel("Cancelled.");
  process.exit(0);
}

const kind = await p.select({
  message: "Preset?",
  options: [
    { value: "spa", label: "SPA" },
    { value: "api", label: "API", hint: "backend" },
  ],
});
if (p.isCancel(kind)) {
  p.cancel("Cancelled.");
  process.exit(0);
}

p.outro("Done");
```

## Gotchas that bite

- **A prompt returns `value | symbol`.** Cancel is a symbol, not `null`. You MUST `isCancel` after every prompt — it narrows the type so `value` is usable afterward. Skip it and a cancelled `text` is treated as a string.
- **Forget the check and the flow misbehaves.** Nothing throws on cancel; handle it or downstream code runs with a symbol.
- **`spinner` needs both `start` and `stop`.** `const s = p.spinner(); s.start("…"); …; s.stop("done")` — an unstopped spinner leaves the terminal spinning; wrap work in try/finally.
- **`confirm` returns a boolean**, `multiselect` an array, `select` the chosen `value` — not the label.
- **`group` centralizes cancel.** Its `onCancel` fires if any step cancels, so per-step `isCancel` isn't needed inside a group.
- **`validate` returns a string (error) or `undefined` (ok)** — returning `""` still reads as valid.

## Hard rules

1. `intro` opens and `outro` closes every flow — matched pair.
2. `isCancel` after every standalone prompt; on cancel, `p.cancel(msg)` then `process.exit(0)`.
3. Prefer `group({...}, { onCancel })` for multi-step flows — one cancel handler, typed `results`.
4. Every `spinner().start()` has a matching `.stop()`, even on error (try/finally).
5. `select`/`multiselect` options are `{ value, label, hint? }`; consume `value`, never the label.
6. `validate` returns an error string or `undefined`; keep prompts `await`ed — they're all async.

## Quick table

| Need | Use |
|---|---|
| Free text | `await p.text({ message })` |
| One of many | `await p.select({ message, options })` |
| Several | `await p.multiselect({ message, options })` |
| Yes/no | `await p.confirm({ message })` |
| Progress | `const s = p.spinner(); s.start(); s.stop()` |
| Multi-step | `await p.group({...}, { onCancel })` |

## Before declaring done

- Every prompt is `await`ed and followed by `isCancel` (or inside a `group` with `onCancel`).
- Every spinner is stopped; `intro`/`outro` bracket the flow.
- `select`/`multiselect` consume `value`, not label.
- `cd packages/cli && pnpm lint` green.
<!-- /navori:managed id="clack" -->
