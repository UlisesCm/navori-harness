---
name: stripe
description: Integración de pagos con Stripe — selección de API (Checkout/Payment/Setup Intents), claves restringidas, idempotencia y verificación de webhooks. Aplica al crear cobros, checkout, suscripciones o handlers de webhook de Stripe.
type: reference
---

# Stripe — el patrón canónico

Alineado con la skill oficial `stripe-best-practices`. El server manda: la lógica de cobro y las claves `sk_`/`rk_` viven en el backend; el cliente solo toca la publishable key.

## Cuándo usar este skill

Al crear un cobro, checkout, suscripciones, o un handler de webhook de Stripe.

## Qué API usar

| Caso | API |
|---|---|
| Pago único on-session | **Checkout Session** |
| Form propio embebido | Checkout Session + **Payment Element** |
| Guardar método de pago (sin cobrar) | **Setup Intent** |
| Suscripciones / recurrente | **Billing** + Checkout Session |
| Marketplace / plataforma | **Accounts v2** (`/v2/core/accounts`) |
| Impuestos (IVA/VAT/GST) | **Stripe Tax** + Registrations API |

**Nunca uses la Charges API** (legacy): si te topas con ella, migra a Checkout Session o Payment Intent — no le agregues features.

## Seguridad de claves

Tres tipos: **publishable** (`pk_`, cliente), **secret** (`sk_`, server) y **restricted** (`rk_`, server con scope acotado). Prefiere **`rk_` sobre `sk_`**. Las claves van en env vars; la `sk_`/`rk_` **jamás** entra al bundle del cliente.

## El patrón (server-side)

```ts
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-06-24.dahlia', // fija la última; no dejes el default de la cuenta
});

// idempotencyKey: reintentar la misma request NO crea un segundo cobro.
const session = await stripe.checkout.sessions.create(
  {
    mode: 'payment',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${base}/ok?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/cancel`,
    // Sin payment_method_types: deja los dynamic payment methods del Dashboard.
  },
  { idempotencyKey: `checkout:${orderId}` },
);
```

## Webhooks

El estado real llega por webhook, no por el `success_url`. Verifica **siempre** la firma y hazlo idempotente:

```ts
// rawBody = cuerpo crudo, NO el JSON parseado (el body-parser rompe la firma).
const event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET!);
if (await alreadyProcessed(event.id)) return res.sendStatus(200); // el event.id puede repetirse
```

Responde `2xx` rápido; el trabajo pesado va a una cola.

## Gotchas que muerden

- **`payment_method_types` fijo** apaga los dynamic payment methods del Dashboard. Omítelo (única excepción: Terminal → `['card_present']`); para restringir usa `payment_method_configurations` o `excluded_payment_method_types`.
- **`automatic_tax: { enabled: true }` sin registro fiscal activo** cobra **cero** impuesto pareciendo habilitado — el error más común y silencioso. Verifica el registro antes.
- **Montos en la unidad mínima y enteros** (centavos: $10.00 → `1000`). Nunca floats.

## Reglas duras

1. Cobro y claves `sk_`/`rk_` solo en el server (env vars); el cliente solo con `pk_`. Prefiere `rk_` sobre `sk_`.
2. `apiVersion` fija a la última; nada de default implícito.
3. Charges API prohibida en código nuevo.
4. `idempotencyKey` en toda request de creación que mueva dinero.
5. Webhooks: firma verificada con `rawBody` + handler idempotente por `event.id`.
6. Sin `payment_method_types` salvo Terminal.

## Antes de declarar listo

- Ninguna `sk_`/`rk_` quedó en el cliente ni en el repo.
- Cada cobro lleva `idempotencyKey`; el pago se confirma por webhook (firma + idempotente), no por el redirect.
- Si hay impuestos: registro fiscal activo verificado.
- `{{qualityGate.fast}}` en verde.
