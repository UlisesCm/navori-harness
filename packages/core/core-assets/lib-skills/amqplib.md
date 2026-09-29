---
name: amqplib
description: Use when creating/touching a RabbitMQ publisher or consumer with amqplib — connections, channels, exchanges/queues, acks, prefetch, dead-lettering, reconnection, and graceful shutdown.
metadata:
  type: reference
---

# amqplib — RabbitMQ messaging

With amqplib a **producer** publishes to an exchange and a **consumer** (usually another process or service) consumes from a queue. They share only the exchange, queue and routing-key names. Both amqplib 0.10.x and 2.x are in use across repos; everything here is version-neutral.

## When to use this skill

When creating a new publisher or consumer, touching channel or ack logic, or debugging messages that are lost, redelivered in a loop, or stuck unacked.

## The pattern

```ts
import amqp from "amqplib";

const conn = await amqp.connect(process.env.AMQP_URL!);

// Consumer: a plain channel, prefetch BEFORE consume, explicit ack/nack.
const ch = await conn.createChannel();
await ch.assertExchange("<exchange-name>", "topic", { durable: true });
await ch.assertQueue("<queue-name>", { durable: true });
await ch.bindQueue("<queue-name>", "<exchange-name>", "<routing-key>");
await ch.prefetch(10);
const { consumerTag } = await ch.consume("<queue-name>", async (msg) => {
  if (!msg) return; // consumer cancelled by the broker
  try {
    await handleMessage(JSON.parse(msg.content.toString())); // pure function
    ch.ack(msg);
  } catch {
    ch.nack(msg, false, false); // requeue=false -> dead-letter, no infinite loop
  }
});

// Publisher: a confirm channel, persistent messages, await the confirm.
const pub = await conn.createConfirmChannel();
await pub.assertExchange("<exchange-name>", "topic", { durable: true });
pub.publish("<exchange-name>", "<routing-key>", Buffer.from(JSON.stringify(payload)), {
  persistent: true,
});
await pub.waitForConfirms();

// Reconnection: handle 'error' and 'close', then retry with exponential backoff,
// re-asserting the topology and re-consuming after each reconnect.
conn.on("error", (err) => logger.error({ err }, "amqp connection error"));
conn.on("close", () => scheduleReconnect()); // exponential backoff
ch.on("error", (err) => logger.error({ err }, "amqp channel error"));
ch.on("close", () => scheduleReconnect());
```

Callback API (`amqplib/callback_api`, used by `notifications--server`): same concepts, node-style callbacks. Check `err` in every callback.

```ts
import amqp from "amqplib/callback_api";

amqp.connect(url, (err, conn) => {
  if (err) return handleError(err);
  conn.createChannel((err, ch) => {
    if (err) return handleError(err);
    ch.assertQueue("<queue-name>", { durable: true });
    ch.prefetch(10);
    ch.consume("<queue-name>", (msg) => {
      if (!msg) return;
      // ...handle, then ch.ack(msg) or ch.nack(msg, false, false)
    });
  });
});
```

## Hard rules

1. **Durable topology + persistent messages.** `durable: true` on exchanges and queues and `persistent: true` on publish; otherwise a broker restart loses them.
2. **`prefetch(n)` before `consume`.** Without it the broker floods the consumer with unacked messages.
3. **Explicit `ack`/`nack`, exactly once.** Never ack twice and never ack on a closed channel: a double-ack closes the channel with `PRECONDITION_FAILED`.
4. **Poison messages go to a dead-letter exchange** (`x-dead-letter-exchange`, optionally `x-dead-letter-routing-key`), not to `nack` with `requeue=true` in an infinite loop.
5. **Idempotent consumers.** Delivery is at-least-once and redelivery happens; a message processed twice must not duplicate effects.
6. **Handle connection/channel `error` and `close`** with reconnection and backoff, and re-assert topology and re-consume after reconnecting. Publishers use a `ConfirmChannel` and await confirms for messages that must not be lost.
7. **Graceful shutdown.** On `SIGTERM`/`SIGINT`: `channel.cancel(consumerTag)`, wait for in-flight handlers to finish, then close the channel, then close the connection.

## Gotchas that bite

- **An unhandled `error` event** on a connection or channel crashes the process. Always attach handlers.
- **A channel closes on any channel-level error.** Recreate the channel object; never reuse it.
- **Re-asserting a queue with different arguments** fails with `PRECONDITION_FAILED`. Changing arguments means a new queue or a deliberate migration.
- **Unacked messages are redelivered** when the channel closes.
- **One channel per consumer/publisher role**, not shared across unrelated concerns.

## Testing a consumer

Extract the handler as a pure function and unit-test that. Test the wiring with an integration test against a real broker (e.g. a RabbitMQ testcontainer) rather than mocking amqplib.

The inter-service queue contract (who publishes/consumes what, exchange/queue/routing-key names, payload schemas) belongs in the workspace Dominio, not in this skill.

## Before declaring done

- Exchanges/queues are durable and messages are persistent.
- `prefetch` is set before `consume`.
- Every path acks or nacks exactly once.
- Dead-letter is configured for poison messages.
- The consumer is idempotent.
- `error`/`close` handlers reconnect with backoff.
- Graceful shutdown is implemented.
- `{{qualityGate.fast}}` green.

<!-- navori:user-section -->
## This repo's exchanges and queues (your domain)

<!-- user: add here what only applies to THIS repo. Suggestions:
     - The exchanges and queues that exist (<exchange-name>, <queue-name>), their routing keys, and who publishes/consumes each.
     - The dead-letter exchange and retry policy per queue.
     - Which consumers must be idempotent because messages can be delivered twice.
     - Where consumers run and how they reconnect/deploy.
-->
