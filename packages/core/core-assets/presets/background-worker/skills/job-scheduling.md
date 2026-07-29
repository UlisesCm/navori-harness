---
name: job-scheduling
description: Define and schedule jobs in a worker (agenda / bullmq) — idempotency, retries with backoff, concurrency. Use when creating or touching a scheduled or recurring job.
type: reference
---

# job-scheduling — idempotent, retryable jobs

A job defines **what** to do; the scheduler decides **when** and **how many times**. Since a job can run more than once (retry, double-fire), the handler must be idempotent.

## When to use this skill

When defining a new job, scheduling a recurring one, or adjusting retries/concurrency.

## The pattern (agenda)

One file per job (`<name>.job.ts`) that registers the handler; scheduling lives apart from the handler.

```ts
export function defineSyncJob(agenda: Agenda) {
  agenda.define('sync-user', { concurrency: 5, lockLifetime: 60_000 }, async (job) => {
    const { userId } = job.attrs.data as { userId: string };
    // idempotent: check state before acting
    if (await alreadySynced(userId, job.attrs.lastRunAt)) return;
    await syncUser(userId);
  });
}

// scheduling, separate from the handler:
await agenda.every('0 * * * *', 'sync-user', { userId });   // recurring
await agenda.schedule('in 5 minutes', 'sync-user', { userId }); // one-off
```

bullmq is equivalent: `new Worker(name, handler, { concurrency, connection })` + `queue.add(name, data, { attempts, backoff })`. For recurring ones use **`queue.upsertJobScheduler(id, { pattern: '0 * * * *' }, { name, data })`** — NOT the `repeat` option (deprecated in BullMQ 5); `upsert` with the same `id` updates the schedule instead of duplicating it on every deploy.

## Gotchas that bite

- **Double-fire**: two workers can pick up the same job. agenda uses `lockLifetime`; bullmq re-processes if `lockDuration` expires before it's renewed (`stalledInterval`/`maxStalledCount`). Even so, **the handler must be idempotent** — don't rely on the lock alone.
- **BullMQ: the Worker's IORedis connection MUST carry `maxRetriesPerRequest: null`**, or startup fails (error #1). And set `removeOnComplete`/`removeOnFail` (`{ age, count }`), otherwise Redis grows unbounded with old jobs.
- **Retries without backoff** hammer a downed service. Configure `attempts` + exponential `backoff`.
- **Short `lockLifetime`/`lockDuration`** + long job → the lock expires and another worker picks it up in parallel. Set it above the job's real duration.

## Hard rules

1. One job per `<name>.job.ts` file; handler separate from scheduling.
2. **Idempotent** handler: check state before mutating; use upserts/dedup keys.
3. Retries with exponential backoff and a cap (`attempts`); no infinite retry.
4. Explicit `concurrency` and `lockLifetime`, consistent with the job's duration.
5. No non-idempotent work that relies on "running exactly once".

## Before declaring done

- The handler is safe to re-run (tested by running it twice).
- Retries with backoff and cap configured.
- `{{qualityGate.fast}}` green.
