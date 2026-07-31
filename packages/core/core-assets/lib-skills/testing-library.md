---
name: testing-library
description: Use when querying rendered UI in tests — Testing Library query priority (getByRole first), get/query/find, user-event over fireEvent, React Native variant.
type: reference
---

# Testing Library — conventions

## When to use this skill

When a test renders a component and needs to find nodes and assert on them — React, Vue, Svelte, or React Native. The whole library encodes one rule: **query the way a user perceives the UI** (role, label, text), not the way it's built (class names, component internals, test ids as a first resort). It works under both Vitest and Jest; it's the query layer, not the runner.

## The pattern

Render, query by accessible role/text via `screen`, drive interaction with `user-event`, assert with jest-dom matchers.

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginForm } from './LoginForm';

it('submits the email', async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn();
  render(<LoginForm onSubmit={onSubmit} />);

  await user.type(screen.getByRole('textbox', { name: /email/i }), 'ada@x.com');
  await user.click(screen.getByRole('button', { name: /sign in/i }));

  expect(onSubmit).toHaveBeenCalledWith({ email: 'ada@x.com' });
});
```

## Gotchas that bite

- **`getByTestId` is the last resort.** Priority: `getByRole` → `getByLabelText` (forms) → `getByPlaceholderText`/`getByText` → `getByTestId`. Reaching for a testid usually means the markup lacks an accessible name — fix the markup instead.
- **`getBy` throws, `queryBy` returns null, `findBy` awaits.** Assert presence with `getBy*`; assert **absence** only with `queryBy*` (`expect(screen.queryByText('x')).not.toBeInTheDocument()`); wait for async UI with `await findBy*` — never poll a `getBy` inside `waitFor` for something not yet rendered.
- **`fireEvent` skips real user behavior.** `user-event` fires the full event sequence (focus, keydown, input) and is async — `await user.click(...)`. Prefer it; keep `fireEvent` only for events user-event can't model (e.g. `scroll`).
- **`act` warnings mean an un-awaited update.** Almost always a missing `await` on a `user.*` call or a `findBy`. Add the `await`; don't wrap things in manual `act`.
- **jest-dom matchers must be imported.** `toBeInTheDocument`/`toBeVisible`/`toHaveValue` come from `@testing-library/jest-dom` (loaded in setup). Without it you fall back to weak truthiness checks.
- **React Native shares the same queries now.** `@testing-library/react-native` (v12.4+) supports `getByRole` (matches the `role`/`accessibilityRole` prop) with the same priority — role first, then `getByLabelText`/`getByText`, `getByTestId` last. Its matchers (`toBeOnTheScreen`, `toBeDisabled`) are built in; do not install `@testing-library/jest-native` (deprecated).

## Hard rules

1. Query by role/label/text first; `getByTestId` only when no accessible name exists.
2. `getBy` for presence, `queryBy` for absence, `findBy` (awaited) for async.
3. Prefer `user-event` (awaited) over `fireEvent`.
4. Load jest-dom matchers in setup (web); React Native's are built in.
5. Test observable behavior and output, never component internals or state.

## Quick table

| Goal | Query |
|---|---|
| Interactive element | `getByRole('button', { name: /save/i })` |
| Form field | `getByLabelText(/email/i)` |
| Assert absence | `queryByText('x')` + `.not.toBeInTheDocument()` |
| Async appearance | `await findByText('Loaded')` |
| React Native | `getByRole` (v12.4+); built-in matchers |

## Before declaring done

- Queries follow priority (role/label before testid); absence uses `queryBy`, async uses `findBy`.
- Interactions go through awaited `user-event`; no stray `act` warnings.
- jest-dom loaded (web); React Native's matchers are built in.
- `{{qualityGate.fast}}` green.
