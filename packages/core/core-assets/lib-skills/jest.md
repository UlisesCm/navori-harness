---
name: jest
description: Use when writing or fixing tests with Jest — config and transforms, jest.mock hoisting, clearMocks, fake timers, and the jest-expo preset for React Native.
type: reference
---

# Jest — conventions

## When to use this skill

When adding or fixing a Jest test, or when the suite fails for reasons that have nothing to do with the assertion: an untransformed module, a mock that didn't apply, state leaking between tests. If the repo also ships Vitest, don't cross them: each runner keeps its own projects.

## The pattern

Config driven by preset/environment, mocks at the top level, queries through Testing Library:

```js
// jest.config.js
module.exports = {
  testEnvironment: 'node',        // 'jsdom' for anything touching the DOM
  clearMocks: true,               // call history reset between tests
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
};
```

```tsx
jest.mock('./auth-api', () => ({ login: jest.fn() }));  // hoisted above the imports

it('shows an error on empty submit', () => {
  render(<LoginForm />);
  fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
  expect(screen.getByText(/email is required/i)).toBeInTheDocument();
});
```

## Gotchas that bite

- **`jest.mock` is hoisted above the imports.** Its factory cannot close over a variable declared later — `ReferenceError: Cannot access '…' before initialization`. Declare the mock functions inside the factory, or resolve them afterwards with `jest.mocked()`.
- **`SyntaxError: Unexpected token 'export'` from node_modules** is an untranspiled ESM package. Whitelist the offender in `transformIgnorePatterns` (`node_modules/(?!(pkg)/)`); never blanket-transform `node_modules` — the suite slows to a crawl. With pnpm/Bun the path includes `.pnpm`/`.bun`.
- **State leaks between tests.** `clearMocks: true` resets call history; `resetMocks` also drops implementations (only when they must not persist) and `restoreMocks` undoes the spies. Choosing wrong makes tests pass only in a given order.
- **Wrong `testEnvironment`.** `node` has no `document`; `jsdom` has no real network or timers. Set it per project (or with a `@jest-environment` docblock), not globally when the repo has both kinds.
- **Fake timers without flushing.** `jest.useFakeTimers()` freezes time, but the pending updates need `act(() => jest.advanceTimersByTime(ms))` to reach the component. Without it, nothing changes and the test asserts the initial state.
- **`--watch` hides the real failure.** Running the full suite (`--ci`) surfaces the ordering and shared-state problems that watch mode masks.

### React Native / Expo

- `preset: 'jest-expo'` handles the transform and the RN mocks; a hand-rolled config almost always breaks on the first native module.
- `@testing-library/jest-native` is deprecated: RNTL ≥ 12.4 ships the matchers (`toBeOnTheScreen`, `toBeVisible`) built in. Don't add `extend-expect` on a modern version.
- RN animations need fake timers plus `act` to flush.

## Hard rules

1. `jest.mock` at top level, with self-contained factories (hoisting).
2. A targeted `transformIgnorePatterns` whitelist — never blanket-transform `node_modules`.
3. `clearMocks: true`; `resetMocks`/`restoreMocks` only where they're needed.
4. `testEnvironment` matching what the test touches.
5. Query through Testing Library, not by inspecting props or internals.

## Before declaring done

- The suite passes with `--ci` (full run), not just in watch mode.
- No test depends on another's order or state.
- Mocks apply (no "hoisting" ReferenceError) and are cleared.
- `{{qualityGate.fast}}` green.

<!-- navori:user-section -->
## This repo's tests (your domain)

<!-- user: add here what only applies to THIS repo. Suggestions:
     - Where tests live and the naming convention.
     - Setup files and what they preload (providers, matchers, polyfills).
     - What is mocked by convention (network, clock, native modules) and what is never mocked.
     - Coverage the repo requires and which areas are exempt.
-->
