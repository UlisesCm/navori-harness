---
name: jest
description: Use when testing React Native/Expo apps or the Medusa backend — jest-expo preset, transformIgnorePatterns, jest.mock hoisting, medusaIntegrationTestRunner.
type: reference
---

# Jest — conventions

## When to use this skill

When the code under test is **React Native / Expo** (the mobile app) or the **Medusa backend** — those two run on Jest, not Vitest. Reach for the right preset/runner: `jest-expo` for RN/Expo, `medusaIntegrationTestRunner`/`moduleIntegrationTestRunner` from `@medusajs/test-utils` for Medusa modules and API routes. Everything else in the stack uses Vitest; do not introduce Jest into a Vitest project.

## The pattern

Preset-driven config, `jest.mock` at the top, RN queries via `@testing-library/react-native`.

```ts
// jest.config.js (mobile)
module.exports = {
  preset: 'jest-expo',
  setupFilesAfterEnv: ['@testing-library/jest-native/extend-expect'],
  transformIgnorePatterns: [
    'node_modules/(?!(jest-)?react-native|@react-native|expo(nent)?|@expo|@react-navigation)',
  ],
};
```

```tsx
import { render, screen, fireEvent } from '@testing-library/react-native';
import { LoginScreen } from './LoginScreen';

jest.mock('./auth-api', () => ({ login: jest.fn() }));

it('shows an error on empty submit', () => {
  render(<LoginScreen />);
  fireEvent.press(screen.getByText('Sign in'));
  expect(screen.getByText('Email is required')).toBeOnTheScreen();
});
```

## Gotchas that bite

- **`SyntaxError: Unexpected token 'export'` from node_modules** is the RN classic: an untranspiled ESM package. Fix it by whitelisting the offender in `transformIgnorePatterns` (`node_modules/(?!(package)/)`), never by transforming all of `node_modules`.
- **`jest.mock` is hoisted above imports** just like `vi.mock`. The factory cannot close over later variables — declare mock fns inside the factory, or use `jest.mock('m'); const m = jest.mocked(require('m'))`.
- **Wrong runner for the repo.** Medusa backend tests need `medusaIntegrationTestRunner` (it boots the framework + a test DB); a plain `it` calling the service directly fails on the missing DI container.
- **Missing native matchers.** Without `@testing-library/jest-native` (or RN 0.71+'s built-in matchers), `toBeOnTheScreen`/`toBeVisible`/`toHaveTextContent` don't exist and reads decay into brittle `.props` pokes.
- **State leaks between tests.** Set `clearMocks: true` (call history) and, when a mock's implementation must not carry over, `resetMocks: true`. Don't hand-clear in every file.
- **Fake timers + Expo/animations.** RN animations and `setTimeout`-driven UI need `jest.useFakeTimers()` plus `act(() => jest.advanceTimersByTime(ms))`, or updates never flush.

## Hard rules

1. Use the preset for the target: `jest-expo` for RN/Expo, `@medusajs/test-utils` runners for Medusa.
2. Fix RN "unexpected token" via a targeted `transformIgnorePatterns` whitelist — never blanket-transform `node_modules`.
3. `jest.mock` at top level; keep factories self-contained (hoisting).
4. Query RN trees with `@testing-library/react-native` + jest-native matchers, not by inspecting `.props`.
5. `clearMocks: true` in config; add `resetMocks` only when implementations must not persist.

## Quick table

| Target | Preset / runner |
|---|---|
| React Native / Expo | `preset: 'jest-expo'` |
| Medusa API + module | `medusaIntegrationTestRunner` |
| Medusa single module | `moduleIntegrationTestRunner` |
| RN matchers | `@testing-library/jest-native` |
| ESM in node_modules | whitelist in `transformIgnorePatterns` |

## Before declaring done

- Correct preset/runner for the target (RN vs Medusa); no blanket node_modules transform.
- Mocks hoisted safely and cleared between tests; native matchers loaded.
- Medusa integration tests actually boot the test runner, not the bare service.
- `{{qualityGate.fast}}` green.
