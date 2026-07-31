---
name: vitest
description: Use when writing or fixing unit/integration tests with Vitest — describe/it/expect, vi.mock hoisting, jsdom vs node env, coverage, fake timers.
type: reference
---

# Vitest — conventions

## When to use this skill

When authoring or debugging unit/integration tests run by Vitest: asserting behavior, mocking modules with `vi`, choosing an environment, or fixing flaky async/timer tests. Vitest is the default runner for everything that is NOT React Native or the Medusa backend (those use Jest). It shares Jest's `expect` surface, but the mock API lives on `vi`, and `vi.mock` is hoisted above imports — the source of most confusion.

## The pattern

Arrange–act–assert, one behavior per `it`, mock at the module boundary, `await` every async assertion.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getUser } from './user-service';
import { db } from './db';

vi.mock('./db', () => ({ db: { findUser: vi.fn() } }));

beforeEach(() => vi.clearAllMocks());

describe('getUser', () => {
  it('returns the mapped user', async () => {
    vi.mocked(db.findUser).mockResolvedValue({ id: 1, name: 'Ada' });
    await expect(getUser(1)).resolves.toMatchObject({ id: 1, name: 'Ada' });
  });
});
```

## Gotchas that bite

- **`vi.mock` is hoisted above imports.** It runs before any `import`, so the factory cannot reference file-scope variables. To share a mock fn, create it in `vi.hoisted`: `const { send } = vi.hoisted(() => ({ send: vi.fn() }))`.
- **Wrong `environment` = `document is not defined` or a slow suite.** Set `environment: 'jsdom'` (or `'happy-dom'`) for DOM tests, `'node'` for backend. Override per file with `// @vitest-environment jsdom`.
- **Unawaited async assertions pass silently.** `expect(p).resolves.toBe(x)` without `await`/`return` yields a false green. Always `await expect(...).resolves` / `.rejects`.
- **Fake timers must be paired.** `vi.useFakeTimers()` in setup, `vi.useRealTimers()` in teardown; advance with `await vi.advanceTimersByTimeAsync(1000)`, or timer callbacks never flush.
- **`clearAllMocks` ≠ `resetAllMocks` ≠ `restoreAllMocks`.** `clear` wipes call history, `reset` also drops implementations, `restore` returns spies to the original. Prefer `clearAllMocks` in `beforeEach`; use `restore` only for `vi.spyOn`.
- **Snapshots rot.** Reserve them for small, stable output; never snapshot a whole component tree or an object with dates/ids — assert the fields that matter with `toMatchObject`.

## Hard rules

1. Mock modules with `vi.mock` at the top level; share fns via `vi.hoisted`, never a bare outer variable.
2. `await` (or `return`) every `.resolves`/`.rejects` and every async timer advance.
3. Pick `environment` deliberately: `jsdom`/`happy-dom` for DOM, `node` for backend logic.
4. Reset state in `beforeEach` (`clearAllMocks`); restore only what you spied on.
5. Coverage via `@vitest/coverage-v8` by default; assert behavior, not a line-count target.

## Quick table

| Need | Use |
|---|---|
| Mock a module | `vi.mock('./m', () => ({ db: vi.fn() }))` |
| Share a mock fn into a factory | `vi.hoisted(() => ({ fn: vi.fn() }))` |
| DOM component test | `environment: 'jsdom'` |
| Async assert | `await expect(p).resolves.toBe(x)` |
| Advance timers | `await vi.advanceTimersByTimeAsync(ms)` |

## Before declaring done

- Every async assertion is awaited; no unhandled-rejection warnings in the run.
- Mocks reset between tests; environment matches the code under test (DOM vs node).
- No sprawling snapshots; assertions target real values.
- `{{qualityGate.fast}}` green.
