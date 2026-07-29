---
name: bullmq
description: Use when creating/touching a job or worker, or enqueueing async work — jobs and queues with BullMQ over Redis: Queue/Worker/QueueEvents, idempotent jobs, retries with backoff, concurrency, and graceful shutdown.
type: reference
---

# BullMQ — jobs & queues

BullMQ moves heavy or deferred work out of the request: a **producer** enqueues (`Queue.add`) and a **worker** (a separate process) handles it. The connection is Redis (`ioredis`). Producer and worker live in different processes and share only the queue name.

## When to use this skill

When creating a new queue or job, touching the worker, enqueueing work from a handler/hook, or debugging jobs that hang, retry in a loop, or get lost.

## The pattern

```ts
// Producer (in a request/hook): enqueue and respond fast, do NOT await the result.
await queue.add("send-welcome", { userId }, {
  attempts: 3,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: 1000,   // don't let Redis grow unbounded
  removeOnFail: 5000,
});

// Worker (separate process): one responsibility per worker/queue.
const worker = new Worker("emails", async (job) => {
  // idempotent: running the same job twice must not duplicate effects
  return sendEmail(job.data);
}, { connection, concurrency: 5 });
```

## Hard rules

1. **Idempotent jobs.** A job can be retried or delivered twice. Use a deterministic id (`jobId`) or an "already processed" guard for non-repeatable effects (charges, emails, critical mutations).
2. **`attempts` + `backoff` always.** A job with no retries dies on the first transient error; one with no backoff hammers the failing resource. Exponential by default.
3. **The producer does NOT await the result.** Enqueue and respond; the job's value is consumed via events (`QueueEvents`) or by re-reading state, not by blocking the request.
4. **`removeOnComplete`/`removeOnFail`.** Without limits, Redis fills up with old jobs. Always bound them.
5. **Graceful shutdown.** On `SIGTERM`/`SIGINT`, `await worker.close()` before exiting so you don't kill a job mid-run. A worker that doesn't close cleanly leaves jobs stuck in `active`.
6. **Errors that should retry → throw; permanent errors → don't.** An invalid input isn't fixed by retrying: validate before enqueueing or mark the job as failed without retry (`attempts: 1` or a non-recoverable error).
7. **One responsibility per worker.** Don't cram several kinds of unrelated work into a single `Worker` with `if job.name`; split them by queue.

## Gotchas that bite

- **The ioredis `connection` for BullMQ needs `maxRetriesPerRequest: null`** — otherwise BullMQ throws on reconnect.
- **High `concurrency` isn't free**: every concurrent job opens connections/CPU. Raise it with measurement, not by default.
- **A "lost" job** is almost always: the worker isn't running, it points to another queue/Redis, or it crashed without `removeOnFail` and stayed in `failed`. Check the job's state before assuming a logic bug.
- **Delayed/repeatable jobs** live in Redis: changing a repeatable's pattern doesn't delete the old one — clean it up explicitly.

## Before declaring done

- The job is idempotent (or has a duplicate guard) and defines `attempts` + `backoff`.
- The worker closes on `SIGTERM`/`SIGINT` (`worker.close()`).
- `removeOnComplete`/`removeOnFail` bounded; the `connection` uses `maxRetriesPerRequest: null`.
- The producer doesn't block the request waiting for the job.
- `{{qualityGate.fast}}` green.
