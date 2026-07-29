---
name: stripe
description: Use when creating charges, checkout, subscriptions, or Stripe webhook handlers — Stripe payments integration: API selection (Checkout/Payment/Setup Intents), restricted keys, idempotency, and webhook verification.
type: reference
---

# Stripe — the canonical pattern

Aligned with the official `stripe-best-practices` skill. The server rules: charge logic and the `sk_`/`rk_` keys live in the backend; the client only touches the publishable key.

## When to use this skill

When creating a charge, checkout, subscriptions, or a Stripe webhook handler.

## Which API to use

| Case | API |
|---|---|
| One-time on-session payment | **Checkout Session** |
| Your own embedded form | Checkout Session + **Payment Element** |
| Save a payment method (without charging) | **Setup Intent** |
| Subscriptions / recurring | **Billing** + Checkout Session |
| Marketplace / platform | **Accounts v2** (`/v2/core/accounts`) |
| Taxes (IVA/VAT/GST) | **Stripe Tax** + Registrations API |

**Never use the Charges API** (legacy): if you run into it, migrate to Checkout Session or Payment Intent — don't add features to it.

## Key security

Three types: **publishable** (`pk_`, client), **secret** (`sk_`, server), and **restricted** (`rk_`, server with narrowed scope). Prefer **`rk_` over `sk_`**. Keys go in env vars; the `sk_`/`rk_` **never** enters the client bundle.

## The pattern (server-side)

```ts
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-06-24.dahlia', // pin the latest; don't leave the account default
});

// idempotencyKey: retrying the same request does NOT create a second charge.
const session = await stripe.checkout.sessions.create(
  {
    mode: 'payment',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${base}/ok?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/cancel`,
    // No payment_method_types: leave the Dashboard's dynamic payment methods.
  },
  { idempotencyKey: `checkout:${orderId}` },
);
```

## Webhooks

The real state arrives via webhook, not via the `success_url`. **Always** verify the signature and make it idempotent:

```ts
// rawBody = the raw body, NOT the parsed JSON (the body-parser breaks the signature).
const event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET!);
if (await alreadyProcessed(event.id)) return res.sendStatus(200); // the event.id can repeat
```

Respond `2xx` fast; the heavy work goes to a queue.

## Gotchas that bite

- **A fixed `payment_method_types`** turns off the Dashboard's dynamic payment methods. Omit it (only exception: Terminal → `['card_present']`); to restrict, use `payment_method_configurations` or `excluded_payment_method_types`.
- **`automatic_tax: { enabled: true }` without an active tax registration** charges **zero** tax while looking enabled — the most common and silent bug. Verify the registration first.
- **Amounts in the smallest unit and as integers** (cents: $10.00 → `1000`). Never floats.

## Hard rules

1. Charge logic and `sk_`/`rk_` keys only on the server (env vars); the client only with `pk_`. Prefer `rk_` over `sk_`.
2. `apiVersion` pinned to the latest; no implicit default.
3. Charges API forbidden in new code.
4. `idempotencyKey` on every creation request that moves money.
5. Webhooks: signature verified with `rawBody` + handler idempotent by `event.id`.
6. No `payment_method_types` except Terminal.

## Before declaring done

- No `sk_`/`rk_` left in the client or the repo.
- Every charge carries an `idempotencyKey`; the payment is confirmed by webhook (signature + idempotent), not by the redirect.
- If there are taxes: active tax registration verified.
- `{{qualityGate.fast}}` green.
