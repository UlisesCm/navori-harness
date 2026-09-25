---
name: react-email
description: Use when writing or editing an email template with @react-email/components, rendering one to HTML/plain text, previewing it, or sending it through Resend. Applies to repos already on React Email + Resend. Not for in-app UI components (a different render target/component set) and not for i18n keys themselves (the i18n skill/catalog).
metadata:
  type: reference
---

# React Email 1 + Resend

Written for `@react-email/components` 1 and `resend` 6. Check both majors in `package.json` first — `render()`'s options and Resend's `send()` response shape are the parts most likely to move.

## Templates

- A template is a plain React component built from `@react-email/components` (`Html`, `Head`, `Body`, `Container`, `Section`, `Heading`, `Text`, `Button`, `Img`, `Link`, `Hr`, `Row`, `Column`, `Preview`, `Font`, `Tailwind`). `Preview` sets the inbox preview text — always include it, it's shown before opening.
- **i18n**: every piece of copy is a **prop**, never hardcoded. The caller (already holding the resolved locale) passes translated strings in; the template never imports a catalog or picks a language.
- Inline `style={{ ... }}` is the safe default for email-client compatibility; the `<Tailwind>` wrapper accepts utility classes but still compiles to inline styles at render time — email clients don't reliably support `<style>` blocks.

## Rendering

- `render(element, options)` (re-exported from `@react-email/render`) returns `Promise<string>` of HTML.
- `render(element, { plainText: true })` returns the plain-text version — send HTML and plain-text bodies together, not HTML alone.
- Keep a thin wrapper (e.g. `renderEmail(element)`) around `render` in the package that owns templates, so previews/tests/the sender don't import `@react-email/components` directly.

## Sending with Resend

- `new Resend(apiKey)` then `resend.emails.send({ from, to, subject, react: <Element /> })` — passing `react` renders internally; no need to call `render()` first.
- **The SDK does not throw on failure.** `send()` resolves to `{ data, error }`: `data` set and `error: null` on success; `data: null` and `error` (`{ message, name }`) set on failure. Always check `error` explicitly — an unchecked `await send(...)` that "resolves" can still have failed.
- Pass an **idempotency key** via the second argument's `idempotencyKey` (sent as `Idempotency-Key`) for any send that could be retried (a webhook handler, a queue consumer) — without it, a retry after a timeout can double-send.
- Inject the API key into whatever builds the `Resend` client — never read `process.env` from inside a shared templates/rendering package; only the app/worker entrypoint owns its own env.

## Testing and previewing

- Render each template in a test and assert on the HTML string (`toContain` on distinguishing copy/values) rather than snapshotting full HTML — full snapshots break on unrelated markup churn from a dependency bump.
- For a visual check, render with representative props and write the HTML to a local file, or use whatever preview tooling the repo already has — don't add a new preview dependency for a one-off look.

## Before declaring done

Copy and check off:

- [ ] Every user-facing string in the template is a prop, not hardcoded.
- [ ] `error` from `resend.emails.send()` is checked and surfaced, never silently swallowed.
- [ ] A send that can be retried carries an `idempotencyKey`.
- [ ] The API key is injected, not read from `process.env` inside the templates/render package.
- [ ] `{{qualityGate.fast}}` green.

If any item fails, fix it and re-run the whole list.

<!-- navori:user-section -->
## This repo's templates (your domain)

<!-- user: add here what only applies to THIS repo. Suggestions:
     - Where templates live and the package that wraps render()/send().
     - The From address(es) and domain verification status.
     - Any brand-specific layout components shared across templates.
-->
