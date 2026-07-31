---
name: jest
description: Use when testing React Native/Expo apps or the Medusa backend — jest-expo preset, transformIgnorePatterns, jest.mock hoisting, medusaIntegrationTestRunner.
type: reference
---

# Jest — conventions

## When to use this skill

When the code under test is **React Native / Expo** (the mobile app) or the **Medusa backend** — those two run on Jest, not Vitest. Reach for the right preset/runner: `jest-expo` for RN/Expo, `medusaIntegrationTestRunner`/`moduleIntegrationTestRunner` from `@medusajs/test-utils` for Medusa. Everything else in the stack uses Vitest; do not introduce Jest into a Vitest project.

## The pattern

Preset-driven config, `jest.mock` at the top, RN queries via `@testing-library/react-native`.

```js
// jest.config.js (Expo) — the preset alone is often enough
module.exports = {
  preset: 'jest-expo',
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native)',
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

Medusa boots a real framework + test DB:

```ts
import { medusaIntegrationTestRunner } from '@medusajs/test-utils';

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    it('lists posts', async () => {
      const res = await api.get('/store/posts');
      expect(res.status).toBe(200);
    });
  },
});
```

## Gotchas that bite

- **`SyntaxError: Unexpected token 'export'` from node_modules** is the RN classic: an untranspiled ESM package. Whitelist the offender in `transformIgnorePatterns` (`node_modules/(?!(pkg)/)`), never transform all of `node_modules`; pnpm/Bun prepend `.pnpm`/`.bun`.
- **`jest.mock` is hoisted above imports** like `vi.mock`. The factory can't close over later variables — declare mock fns inside it, or `jest.mock('m'); const m = jest.mocked(require('m'))`.
- **jest-native is deprecated.** RNTL v12.4+ ships built-in matchers (`toBeOnTheScreen`/`toBeVisible`/`toHaveTextContent`) — no `@testing-library/jest-native`, no `extend-expect`. Older RNTL: add `@testing-library/jest-native/extend-expect` to `setupFilesAfterEnv`.
- **Wrong runner for Medusa.** A plain `it` calling the service fails on the missing DI container. Single-module tests use `moduleIntegrationTestRunner<Service>({ moduleName, moduleModels, resolve, testSuite })`. Both need `testEnvironment: 'node'`, an `@swc/jest` transform, and `--runInBand --forceExit`.
- **State leaks between tests.** Set `clearMocks: true` (call history); add `resetMocks: true` only when a mock's implementation must not carry over.
- **Fake timers + animations.** RN animations and `setTimeout` UI need `jest.useFakeTimers()` + `act(() => jest.advanceTimersByTime(ms))`, or updates never flush.

## Hard rules

1. Use the preset/runner for the target: `jest-expo` for RN/Expo, `@medusajs/test-utils` runners for Medusa.
2. Fix RN "unexpected token" via a targeted `transformIgnorePatterns` whitelist — never blanket-transform `node_modules`.
3. `jest.mock` at top level; keep factories self-contained (hoisting).
4. Query RN trees with `@testing-library/react-native` matchers, not `.props`.
5. `clearMocks: true` in config; add `resetMocks` only when implementations must not persist.

## Quick table

| Target | Preset / runner |
|---|---|
| React Native / Expo | `preset: 'jest-expo'` |
| Medusa API + full app | `medusaIntegrationTestRunner` |
| Medusa single module | `moduleIntegrationTestRunner` |
| RN matchers | built-in (RNTL ≥ 12.4) |
| ESM in node_modules | whitelist in `transformIgnorePatterns` |

## Before declaring done

- Correct preset/runner (RN vs Medusa); no blanket node_modules transform.
- Mocks hoisted safely and cleared between tests; RN matchers available.
- Medusa tests boot the runner (`testEnvironment: 'node'`), not the bare service.
- `{{qualityGate.fast}}` green.
