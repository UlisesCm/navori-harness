---
name: queue-consumers
description: Consume messages from a queue in a worker (amqplib / bullmq) — ack/nack, dead-letter, prefetch/backpressure, idempotency. Use when creating or touching a queue consumer.
type: reference
---

# queue-consumers — consume without losing or duplicating

A consumer reacts to messages. The core rule: **a message is not acknowledged (`ack`) until it's processed successfully**; on failure, it's requeued or goes to dead-letter — never silently lost.

## When to use this skill

When creating a consumer, handling processing failures, or tuning prefetch / dead-letter.

## The pattern (amqplib)

```ts
await channel.prefetch(10); // backpressure: max 10 unacked at a time
await channel.consume(queue, async (msg) => {
  if (!msg) return;
  try {
    const payload = JSON.parse(msg.content.toString());
    if (await alreadyProcessed(payload.id)) { channel.ack(msg); return; } // idempotent
    await handle(payload);
    channel.ack(msg);
  } catch (err) {
    logger.error({ err }, 'consume failed');
    // requeue once; if already redelivered, send it to the DLQ (no infinite requeue)
    channel.nack(msg, false, !msg.fields.redelivered);
  }
});
```

bullmq: throwing inside the `Worker` handler requeues per `attempts`/`backoff`; once exhausted, the job stays `failed`. **`failed` is NOT a DLQ**: nobody reprocesses or alerts on its own — listen to `worker.on('failed')` / `QueueEvents`, or move to a dedicated `failed`-queue with monitoring.

## Gotchas that bite

- **`redelivered` is a poor heuristic for retries.** It fires on **any** re-delivery (including connection recovery) and only distinguishes "0 vs ≥1", not a counter; `nack` with requeue re-enqueues at the **head** → hot-loop with no backoff. The robust pattern is a **dead-letter exchange (DLX) + retry queue with TTL** (or an `x-death` header/counter), not `redelivered`.
- **Atomic dedup, not check-then-act.** `if (await alreadyProcessed(id))` is TOCTOU: with `prefetch>1` or two consumers, two deliveries both pass the check. Use `INSERT` with a unique index (catch duplicate-key) or `SET NX` in Redis.
- **Failed parse = non-retryable** → straight to DLQ, no requeue (a corrupt payload would loop forever).
- **Without `prefetch`** the consumer swallows the whole queue into memory. Set a prefetch matching the handler's duration.
- **`ack` before processing** = message loss if the handler crashes. Acknowledge **after** success.
- **Duplicate messages** are normal (redelivery). The handler must be idempotent.

## Hard rules

1. `ack` only after success; on failure, bounded retry (DLX + retry queue / counter) or dead-letter.
2. Never infinite-requeue a poison message; a failed parse goes straight to DLQ.
3. Explicit `prefetch` for backpressure.
4. **Idempotent** handler with **atomic** dedup (unique index / `SET NX`), not check-then-act.
5. Errors logged (structured), never silently swallowed.

## Before declaring done

- A message that fails is neither lost nor infinite-looped (it goes to DLQ).
- `prefetch` configured; the handler is idempotent.
- `{{qualityGate.fast}}` green.
