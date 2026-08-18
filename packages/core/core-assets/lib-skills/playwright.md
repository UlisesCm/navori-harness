---
name: playwright
description: Use when writing browser E2E tests with Playwright — @playwright/test runner, web-first assertions with auto-wait, role locators, projects, traces on failure.
type: reference
---

# Playwright — conventions

## When to use this skill

When writing end-to-end browser tests that drive a real page (storefront, dashboard, Medusa e2e). Playwright is E2E only — it complements, never replaces, the Vitest/Jest unit suite. Two official pillars: **test user-visible behavior** (what the page renders, not CSS classes) and **web-first, auto-waiting assertions** — `await expect(locator).toBeVisible()` retries until the condition holds or times out, so you never sleep.

## The pattern

`test`/`expect` from `@playwright/test`, role/label locators, awaited web-first assertions.

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
- **Prefer user-facing locators.** Official order: `getByRole` → `getByLabel` → `getByPlaceholder` → `getByText`. Drop to `getByTestId` only when nothing user-visible works; never CSS/XPath. Narrow with `.filter({ hasText })`.
- **Tests must be isolated.** Each test gets a fresh `page`/context; don't share auth or state through module scope. Reuse login via `storageState`/a fixture. Mock external calls with `page.route()`; don't hit servers you don't control.
- **Multi-browser lives in `projects`.** Chromium/Firefox/WebKit are `projects` in `playwright.config.ts`, not `if` branches. Same test, matrixed by config.
- **Debug with artifacts, not console.log.** Set `trace: 'on-first-retry'` and `screenshot: 'only-on-failure'`; open the trace viewer. To scaffold or heal tests, use the official agents (`npx playwright init-agents`) and MCP (`@playwright/mcp`).

## Hard rules

1. Import `test`/`expect` from `@playwright/test`; never the unit runner's `expect`.
2. Assert user-visible behavior with web-first assertions and `locator.waitFor()`; `waitForTimeout` is banned.
3. `await expect(locator)...` — assert on the live locator, not a captured value.
4. Prefer role/label locators; `getByTestId` is the fallback, CSS/XPath the last resort.
5. Keep tests independent; share auth via `storageState`/fixtures, mock third parties, matrix browsers through `projects` with trace + screenshot on failure.

## Quick table

| Goal | API |
|---|---|
| Find by role | `page.getByRole('button', { name: 'Save' })` |
| Find by label | `page.getByLabel('Email')` |
| Fallback locator | `page.getByTestId('cart')` |
| Assert visible | `await expect(locator).toBeVisible()` |
| Assert URL | `await expect(page).toHaveURL(/x/)` |
| Multi-browser | `projects` in config |
| Failure debug | `trace: 'on-first-retry'` |

## Before declaring done

- All waits are web-first assertions or `waitFor`; zero `waitForTimeout`.
- `test`/`expect` imported from `@playwright/test`; tests run isolated in parallel; external calls mocked.
- Locators are user-facing (role/label first); trace + screenshot on failure; browsers matrixed via `projects`.
- `{{qualityGate.fast}}` green.

<!-- navori:user-section -->
## This repo's E2E suite (your domain)

<!-- user: add here what only applies to THIS repo. Suggestions:
     - The base environment: URL, how the app is started, required seed data.
     - How authentication is solved (storageState, fixtures) so specs don't log in one by one.
     - The selector convention (data-testid or roles) and which one wins.
     - Which specs block CI and which are informational.
-->
