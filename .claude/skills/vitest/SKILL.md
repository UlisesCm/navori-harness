---
name: vitest
description: Use when writing or fixing unit/integration tests with Vitest — describe/it/expect, vi.mock hoisting, jsdom vs node env, coverage, fake timers.
type: reference
---

<!-- navori:managed id="vitest" hash="2279bc63" version="0.6.3" source="@navori/core" -->
# Vitest — conventions

## When to use this skill

When authoring or debugging Vitest unit/integration tests: asserting behavior, mocking with `vi`, choosing an environment, or fixing flaky async/timer tests. It shares Jest's `expect` surface, but the mock API lives on `vi`, and `vi.mock` is hoisted above imports. If the repo also ships Jest, don't cross them: each runner keeps its own config.

## The pattern

Arrange–act–assert, one behavior per `it`, mock at the module boundary, `await` every async assertion. Prefer the `import()` form of `vi.mock`.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getUser } from './user-service';
import { db } from './db';

vi.mock(import('./db'), () => ({ db: { findUser: vi.fn() } }));

beforeEach(() => vi.clearAllMocks());

describe('getUser', () => {
  it('returns the mapped user', async () => {
    vi.mocked(db.findUser).mockResolvedValue({ id: 1, name: 'Ada' });
    await expect(getUser(1)).resolves.toMatchObject({ id: 1, name: 'Ada' });
  });
});
```

## Gotchas that bite

- **`vi.mock` is hoisted above imports.** It runs before any `import`, so the factory cannot reference file-scope variables, and `vi` must come from `vitest`. Share a fn via `vi.hoisted`: `const { send } = vi.hoisted(() => ({ send: vi.fn() }))`.
- **Wrong `environment` = `document is not defined` or a slow suite.** Default is `node`; use `environment: 'jsdom'` (or `'happy-dom'`) for DOM, or `// @vitest-environment jsdom` per file.
- **Unawaited async assertions pass silently.** `expect(p).resolves.toBe(x)` without `await`/`return` is a false green. Always `await expect(...).resolves` / `.rejects`.
- **Fake timers must be paired.** `vi.useFakeTimers()` in setup, `vi.useRealTimers()` in teardown; advance with `await vi.advanceTimersByTimeAsync(ms)`, or callbacks never flush.
- **`clearAllMocks` ≠ `resetAllMocks` ≠ `restoreAllMocks`.** `clear` wipes call history; `reset` also restores the `vi.fn(impl)` implementation; `restore` reverts `vi.spyOn` spies only, not automocks. Prefer `clearAllMocks` in `beforeEach`.
- **Snapshots rot.** Reserve for small, stable output; never a whole component tree or an object with dates/ids — assert the fields that matter with `toMatchObject`.

## Hard rules

1. Run with `vitest run` (or `--no-watch`) so it exits under CI and agents.
2. Mock at top level; share fns via `vi.hoisted`, never a bare outer variable.
3. `await` (or `return`) every `.resolves`/`.rejects` and every async timer advance.
4. Pick `environment`: `jsdom`/`happy-dom` for DOM, `node` for backend.
5. Reset between tests (`clearAllMocks` or `clearMocks: true`); restore only what you spied on.
6. Coverage via `@vitest/coverage-v8` (install it); v4 dropped `coverage.all`, so set `coverage.include`. Assert behavior, not a line target.

## Quick table

| Need | Use |
|---|---|
| Mock a module | `vi.mock(import('./m'), () => ({ db: vi.fn() }))` |
| Share a mock fn into a factory | `vi.hoisted(() => ({ fn: vi.fn() }))` |
| DOM component test | `environment: 'jsdom'` |
| Async assert | `await expect(p).resolves.toBe(x)` |
| Advance timers | `await vi.advanceTimersByTimeAsync(ms)` |

## Before declaring done

- Every async assertion is awaited; no unhandled-rejection warnings.
- Mocks reset between tests; environment matches the code under test (DOM vs node).
- No sprawling snapshots; assertions target real values.
- `cd packages/cli && pnpm lint` green.
<!-- /navori:managed id="vitest" -->
