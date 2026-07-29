---
name: winston-logging
description: Use when adding logs or auditing a bug's traces — logging with winston: Logger.error/warn/info/debug, correct levels, actionable messages with context, no console.log.
type: reference
---

# Winston Logging — repo patterns

The repo's `Logger` (winston, typically in `infrastructure/`) fully replaces `console`. It writes to console and file in dev, console only in prod.

## When to use this skill

When adding logs to a controller, job, or service, choosing the right level, auditing a bug's traces, or cleaning up inherited `console.log`.

## The pattern

```ts
import Logger from '../../infrastructure/core/Logger';

try {
  const created = await Resource.create(dto);
  Logger.info(`[resource:create] ${created._id} owner ${dto.owner}`);
} catch (err) {
  Logger.error(`Failed to create Resource`, err);
  throw err; // re-throw → the global middleware maps it to InternalError
}
```

With `format.errors({ stack: true })` (typical config), passing an `Error` logs the stack on its own. Prefix with `[<scope>:<verb>]` (`[job:sendReminder]`, `[email:welcome]`) so it's grep-friendly.

If your framework already centralizes async errors (`asyncHandler` in Express, exception filters in Nest, global error middleware), do NOT duplicate try/catch in every handler. Add it only to log extra context, map a specific error (e.g. `MongoServerError` 11000 → `BadRequestError`), or do cleanup before the re-throw.

## Gotchas that bite

- **`Logger.debug` doesn't print in prod** when `logLevel = isDev ? 'debug' : 'info'`. Perfect for diagnostics you don't want to expose; useless if you expected to see it in prod.
- **`JSON.stringify(req)` blows up**: Requests are huge and have circular refs. Log only what you need.

## Hard rules

1. `Logger` always, never `console.log/error/warn`. Delete temporary `console.log` before committing.
2. Correct level: `error` (caught/critical), `warn` (recoverable but notable), `info` (domain event: job, login, email), `debug` (dev only).
3. Actionable messages: include IDs and context, not just "Error"/"Failed".
4. Don't spam — one `info` per request is noise; reserve it for events.
5. Re-throw (`throw err`) after `Logger.error` when the flow needs it; the caller must learn about the failure.
6. Never log secrets (tokens, passwords) or a full `JSON.stringify(req)`. No swallowing `catch (e) {}`.

## Quick table

| Situation | Level |
|---|---|
| Caught error or critical event | `Logger.error(err)` |
| Recoverable but notable | `Logger.warn(msg)` |
| Domain event (job, login, email) | `Logger.info(msg)` |
| Development diagnostics | `Logger.debug(msg)` |

## Before declaring done

- No new `console.log` left; temporary ones deleted.
- Every log uses the right level and carries actionable IDs/context.
- Caught errors re-throw when the flow needs it.
- No secrets or full `JSON.stringify(req)` logged.
- `{{qualityGate.fast}}` green.
