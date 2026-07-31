---
name: playwright
description: Use when writing browser E2E tests with Playwright — @playwright/test runner, web-first assertions with auto-wait, role locators, projects, traces on failure.
type: reference
---

# Playwright — conventions

## When to use this skill

When writing end-to-end browser tests that drive a real page (storefront, dashboard, Medusa e2e). Playwright is E2E only — it complements, never replaces, the Vitest/Jest unit suite. Its defining feature is **auto-waiting, web-first assertions**: `await expect(locator).toBeVisible()` retries until the condition holds or times out, so you never sleep manually.

## The pattern

`test`/`expect` from `@playwright/test`, role/text locators, awaited web-first assertions.

```ts
import { test, expect } from '@playwright/test';

test('user can log in', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('ada@x.com');
  await page.getByLabel('Password').fill('secret');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard/);
});
```

## Gotchas that bite

- **The `expect` is Playwright's, not the runner's.** Import `test` and `expect` from `@playwright/test`. Pulling in Vitest/Jest `expect` loses auto-retry and every web-first matcher.
- **`waitForTimeout` is a code smell.** Never sleep a fixed number of ms. Use web-first assertions (`toBeVisible`, `toHaveText`, `toHaveURL`) or `locator.waitFor()`; they retry until ready and kill flake.
- **Assert on the locator, not a captured value.** `await expect(locator).toHaveText('x')` re-queries and retries; `expect(await locator.textContent()).toBe('x')` reads once and flakes. Keep `await` on `expect`, not inside it.
- **Tests must be isolated.** Each test gets a fresh `page`/context; don't share auth or state through module scope. Reuse login via `storageState`/a fixture, not a global variable, so parallel workers don't collide.
- **Multi-browser lives in `projects`.** Chromium/Firefox/WebKit are `projects` in `playwright.config.ts`, not `if` branches in the test. Same test, matrixed by config.
- **Debug with artifacts, not console.log.** Set `trace: 'on-first-retry'` and `screenshot: 'only-on-failure'` in config; open the trace viewer instead of littering logs.

## Hard rules

1. Import `test`/`expect` from `@playwright/test`; never the unit runner's `expect`.
2. Use web-first assertions and `locator.waitFor()`; `waitForTimeout` is banned.
3. `await expect(locator)...` — assert on the live locator, not a captured value.
4. Keep tests independent; share auth via `storageState`/fixtures, not globals.
5. Matrix browsers through `projects`; enable trace + screenshot on failure.

## Quick table

| Goal | API |
|---|---|
| Find by role | `page.getByRole('button', { name: 'Save' })` |
| Find by label | `page.getByLabel('Email')` |
| Assert visible | `await expect(locator).toBeVisible()` |
| Assert URL | `await expect(page).toHaveURL(/x/)` |
| Multi-browser | `projects` in config |
| Failure debug | `trace: 'on-first-retry'` |

## Before declaring done

- All waits are web-first assertions or `waitFor`; zero `waitForTimeout`.
- `test`/`expect` imported from `@playwright/test`; tests run isolated in parallel.
- Trace + screenshot on failure configured; browsers matrixed via `projects`.
- `{{qualityGate.fast}}` green.
