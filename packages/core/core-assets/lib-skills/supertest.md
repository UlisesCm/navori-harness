---
name: supertest
description: Use when integration-testing HTTP APIs — supertest against an Express/Medusa app without binding a port, status/body/header assertions, auth headers.
type: reference
---

# Supertest — conventions

## When to use this skill

When integration-testing an HTTP API — hitting real routes end to end through the app's middleware stack, but without a running server or network. Pass the **app object** (not a URL) to `request()`; supertest binds an ephemeral port for the call and tears it down. Pair it with the project's runner: Vitest on the Bun backend, Jest on Medusa. It tests the app, not a deployed service.

## The pattern

`request(app)`, chain the HTTP verb + path, assert status inline then body with `async/await`.

```ts
import request from 'supertest';
import { app } from '../src/app';

describe('POST /users', () => {
  it('creates a user and returns 201', async () => {
    const res = await request(app)
      .post('/users')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'ada@x.com', name: 'Ada' })
      .expect('Content-Type', /json/)
      .expect(201);

    expect(res.body).toMatchObject({ email: 'ada@x.com' });
  });
});
```

## Gotchas that bite

- **Pass the app, not a URL.** `request(app)` lets supertest manage the port; `request('http://localhost:3000')` couples the test to a manually-started server and defeats isolation.
- **Don't `listen()` yourself.** Export the app instance separately from the `app.listen()` bootstrap. If the entry file both creates and starts the server, tests leak an open port — split creation from startup.
- **`await` the request or lose the failure.** A forgotten `await`/`return` on `request(...).expect(...)` makes an assertion failure surface as an unhandled rejection after the test already reported green.
- **`.expect(200)` vs `expect(res.body)`.** `.expect()` (supertest) checks status/headers inline; deep body assertions belong to the runner's `expect` on `res.body`. Confusing them (`.expect(res.body.id)`) silently checks nothing useful.
- **Auth is just a header.** Set tokens with `.set('Authorization', ...)`; there is no session magic. For multi-step cookie flows use `request.agent(app)` to persist cookies across calls.
- **Assert body shape, not the whole object.** Use `toMatchObject`/specific fields; snapshotting `res.body` breaks on every timestamp/id and creates noise.

## Hard rules

1. `request(app)` with the app instance — never a live URL/port.
2. Export the app separately from `listen()`; tests never bind a real port.
3. `await` (or `return`) every `request(...)` chain.
4. Status/headers via `.expect(...)`; body via the runner's `expect(res.body)`.
5. Auth via `.set('Authorization', ...)`; multi-step cookie flows via `request.agent(app)`.

## Quick table

| Goal | API |
|---|---|
| Call a route | `request(app).get('/x')` |
| Assert status | `.expect(200)` |
| Assert content type | `.expect('Content-Type', /json/)` |
| Send JSON body | `.send({ email: 'a@x.com' })` |
| Auth header | `.set('Authorization', 'Bearer …')` |
| Persist cookies | `request.agent(app)` |

## Before declaring done

- `request(app)` (no live port); app export split from `listen()`.
- Every request chain awaited; status via `.expect`, body via the runner's `expect`.
- Body assertions target fields, not full-object snapshots.
- `{{qualityGate.fast}}` green.
