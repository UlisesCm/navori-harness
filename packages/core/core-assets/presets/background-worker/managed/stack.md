## Stack — Background worker (jobs + queues)

Background process in Node/TS whose job is to **process jobs and messages**, not serve HTTP. Typical flow: a scheduler (`agenda` / `bullmq` / `node-cron`) fires jobs on a schedule, and/or a queue consumer (`amqplib` / `bullmq` / `kafkajs`) reacts to messages. Each handler does its work (send email, push, recompute, sync) and reports success/failure to the jobs infrastructure.

Even if the repo has `express` in its deps, it **exposes no business endpoints** — at most a `/health` for the orchestrator. If you're asked to add a "route", confirm: it's almost always a new job or consumer, not an endpoint.

Golden rules:
- **Idempotency**: a job/message can be delivered more than once. Every handler must be safe to re-run (deduplication keys, upserts, check state before acting).
- **Graceful shutdown**: on `SIGTERM`/`SIGINT`, stop taking new work, wait for in-flight jobs to finish (with a timeout) and close connections (DB, broker) before exiting. Never kill a job mid-way without re-queuing it.
- **Explicit errors**: a failure is retried with backoff or sent to a dead-letter; never swallowed silently. Logging goes through the structured `Logger`, never `console.log`.
- **No `process.env`** outside the config module.

Apply the skills according to the layer you touch:
- `worker-lifecycle` — bootstrap, graceful shutdown, healthcheck, no business HTTP.
- `job-scheduling` — define/schedule jobs (agenda/bullmq), idempotency, retries with backoff.
- `queue-consumers` — consume messages (amqplib/bullmq), `ack`/`nack`, dead-letter, backpressure.

Logging and the ticket/PR flow are covered by the base harness (agents `leader`, `implementer`, `reviewer`, `commit-pr-pilot` and the core skills).
