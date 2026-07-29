---
name: worker-lifecycle
description: Lifecycle of a background worker in Node/TS — bootstrap, graceful shutdown, minimal healthcheck, no business HTTP served. Use when touching process startup/shutdown or the DB/broker connection.
type: reference
---

# worker-lifecycle — start and shut down cleanly

A worker is not an HTTP server: it opens connections, registers schedulers/consumers, and must **shut down cleanly** without killing in-flight work. Its `main` orchestrates the bootstrap and a single idempotent shutdown.

## When to use this skill

When touching `index.ts`/`main.ts`, the scheduler/consumer startup, the Mongo/broker connection, or signal handling.

## The pattern

```ts
async function main() {
  const db = await connectMongo(config.mongoUri);
  const broker = await connectBroker(config.amqpUrl);
  const scheduler = startScheduler({ db });   // job-scheduling
  const consumer = startConsumer({ broker });  // queue-consumers

  const shutdown = once(async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    await consumer.stop();        // stop taking new messages
    await scheduler.stop();       // stop firing jobs
    await drainInflight(15_000);  // wait for in-flight, with timeout
    await broker.close();
    await db.close();
    process.exit(0);
  });

  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => shutdown(sig));
}
main().catch((err) => { logger.error({ err }, 'fatal on boot'); process.exit(1); });
```

`once` guarantees that two back-to-back signals don't trigger two shutdowns. Order matters: **first you stop accepting work**, then you drain in-flight, then you close connections.

Without an HTTP server there's no safety net: also register `process.on('unhandledRejection'|'uncaughtException', ...)` with structured logging + shutdown, or an uncaught promise kills the process silently. The drain timeout must be **less** than the orchestrator's `terminationGracePeriodSeconds` (30s default in K8s), or the pod gets `SIGKILL` mid-task. In BullMQ, `worker.close()` has **no** timeout of its own: bound it with a `Promise.race` against your own timeout.

## Healthcheck (if the orchestrator requires it)

A single `/health` endpoint with a minimal `http.createServer` is fine — it is **not** an API. Return `200` if the connections (DB, broker) are alive. No business routes here.

## Hard rules

1. A single shutdown point, idempotent (`once`), listening for `SIGTERM` and `SIGINT`.
2. Stop accepting work **before** draining; drain with a timeout; close connections last.
3. Never `process.exit` mid-job without requeuing it or leaving it `nack`-ed.
4. No business HTTP routes. `/health` is the only allowed endpoint.
5. Boot errors → structured log + `exit(1)`; don't start halfway.
6. Register `unhandledRejection`/`uncaughtException`; drain-timeout < orchestrator's grace period.

## Before declaring done

- `SIGTERM` shuts down cleanly: no half-dead jobs, connections closed.
- The process exposes no business endpoints.
- `{{qualityGate.fast}}` green.
