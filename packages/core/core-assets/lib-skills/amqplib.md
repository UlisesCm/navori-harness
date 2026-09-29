---
name: amqplib
description: Use when creating/touching a RabbitMQ publisher or consumer with amqplib — connections, channels, exchanges/queues, acks, prefetch, dead-lettering, reconnection, and graceful shutdown.
metadata:
  type: reference
---

# amqplib — RabbitMQ messaging

A **producer** publishes to an exchange; a **consumer** (usually another service) consumes from a queue, sharing only names.

## When to use this skill

Creating a publisher or consumer, touching ack logic, or debugging lost, looping or stuck-unacked messages.

## The pattern

```ts
import amqp from "amqplib";

let closing = false; // set true at the start of graceful shutdown
const conn = await amqp.connect(process.env.AMQP_URL!);

// Consumer: prefetch BEFORE consume, explicit ack/nack.
const ch = await conn.createChannel();
await ch.assertExchange("<exchange-name>", "topic", { durable: true });
await ch.assertExchange("<dlx-name>", "topic", { durable: true });
await ch.assertQueue("<queue-name>", {
  durable: true,
  arguments: { "x-dead-letter-exchange": "<dlx-name>" }, // nack(requeue=false) dead-letters here
});
await ch.bindQueue("<queue-name>", "<exchange-name>", "<routing-key>");
await ch.prefetch(10);
const { consumerTag } = await ch.consume("<queue-name>", async (msg) => {
  if (!msg) return; // cancelled by the broker
  try {
    await handleMessage(JSON.parse(msg.content.toString())); // pure function
    ch.ack(msg);
  } catch {
    ch.nack(msg, false, false); // no requeue loop
  }
});

// Publisher: confirm channel, persistent messages, await the confirm.
const pub = await conn.createConfirmChannel();
pub.publish("<exchange-name>", "<routing-key>", Buffer.from(JSON.stringify(payload)), {
  persistent: true,
});
await pub.waitForConfirms();

// Reconnect from ONE place: the connection 'close' handler, only if unexpected.
conn.on("error", (err) => logger.error({ err }, "amqp connection error"));
conn.on("close", () => {
  if (!closing) scheduleReconnect(); // backoff, re-assert topology, re-consume
});
ch.on("error", (err) => logger.error({ err }, "amqp channel error"));
```

## Hard rules

1. **Durable topology, persistent messages.** `durable: true` on exchanges and queues, `persistent: true` on publish.
2. **`prefetch(n)` before `consume`,** or the broker floods the consumer.
3. **Explicit `ack`/`nack`, exactly once.** A double-ack or ack on a closed channel closes it with `PRECONDITION_FAILED`.
4. **Poison messages go to a dead-letter exchange** (`x-dead-letter-exchange`, optionally `x-dead-letter-routing-key`) declared on the queue; never `nack` with `requeue=true` in a loop.
5. **Idempotent consumers.** Delivery is at-least-once; processing twice must not duplicate effects.
6. **Handle `error` and `close`.** Reconnect with backoff only from the connection `close` handler and only when `closing` is unset, then re-assert topology and re-consume. Unroutable publishes are confirmed then dropped unless `mandatory` is set.
7. **Graceful shutdown.** On `SIGTERM`/`SIGINT` set `closing = true`, `channel.cancel(consumerTag)`, wait for in-flight handlers, then close channel and connection.

## Gotchas that bite

- **An unhandled `error` event** crashes the process.
- **A channel closes on any channel-level error.** Recreate it; never reuse it.
- **Re-asserting a queue with different arguments** fails with `PRECONDITION_FAILED`.
- **Unacked messages are redelivered** when the channel closes.
- **One channel per role.**

## Testing a consumer

Unit-test the handler as a pure function. Test the wiring against a real broker (e.g. a RabbitMQ testcontainer), not a mocked amqplib.

The inter-service queue contract (who publishes/consumes what, names, payloads) belongs in the workspace Dominio, not here.

## Before declaring done

- Topology durable, messages persistent, `prefetch` before `consume`.
- Every path acks or nacks exactly once; dead-letter configured.
- Consumer idempotent.
- Reconnect only on unexpected connection `close`; graceful shutdown implemented.
- `{{qualityGate.fast}}` green.

<!-- navori:user-section -->
## This repo's exchanges and queues (your domain)

<!-- user: add here what only applies to THIS repo. Suggestions:
     - The exchanges and queues that exist (<exchange-name>, <queue-name>), their routing keys, and who publishes/consumes each.
     - The dead-letter exchange and retry policy per queue.
     - Which consumers must be idempotent because messages can be delivered twice.
     - Where consumers run and how they reconnect/deploy.
-->
