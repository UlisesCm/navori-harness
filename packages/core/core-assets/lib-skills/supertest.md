---
name: supertest
description: Use when integration-testing HTTP APIs — supertest against an Express/Medusa app without binding a port, status/body/header assertions, auth headers.
type: reference
---

# Supertest — conventions

## When to use this skill

When integration-testing an HTTP API — real routes end to end through the middleware stack, no running server or network. Pass the **app object** (or an `http.Server`) to `request()`; if it is not listening, supertest binds an ephemeral port and tears it down — no `listen()`, no port bookkeeping. Runner-agnostic (Vitest, Jest, Mocha). Tests the app, not a deployed service.

## The pattern

`request(app)`, chain verb + path, assert status/headers inline via `.expect(...)`, then the body via the runner's `expect(res.body)`.

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

- **Pass the app, not a URL.** `request(app)` lets supertest manage the port; `request('http://localhost:3000')` ties the test to a manually-started server and defeats isolation.
- **Don't `listen()` yourself.** Export the app separately from `app.listen()`. If the entry file both builds and starts the server, tests leak a port — split creation from startup.
- **The request is lazy — `await` it or nothing runs.** A chain fires only when you `await`, `return`, `.then()`, or `.end()` it. Forget all of them and the assertion never runs (false green), or the failure floats as an unhandled rejection outside the test. With `.end((err, res) => …)`, a failed `.expect(...)` returns as `err` rather than throwing — forward it.
- **`.expect(...)` vs the runner's `expect`.** `.expect()` (supertest) checks status, headers, or an exact body/regex inline, plus a custom `res => { … }` assertor; partial/deep body shape belongs to the runner's `expect(res.body)`. `.expect(res.body.id)` checks nothing.
- **Auth is just a header.** Set tokens with `.set('Authorization', …)`; no session magic. Multi-step cookie/session flows: `request.agent(app)`, which persists cookies across calls.
- **Assert body shape, not the whole object.** Use `toMatchObject`/specific fields; snapshotting `res.body` breaks on every timestamp/id and adds noise.

## Hard rules

1. `request(app)` with the app/server instance — never a live URL/port.
2. Export the app separately from `listen()`; tests never bind a real port.
3. `await` (or `return`/`.end()`) every `request(...)` chain — unawaited chains do not run.
4. Status/headers via `.expect(...)`; body shape via the runner's `expect(res.body)`.
5. Auth via `.set('Authorization', …)`; multi-step cookie flows via `request.agent(app)`.

## Quick table

| Goal | API |
|---|---|
| Call a route | `request(app).get('/x')` |
| Assert status | `.expect(200)` |
| Assert header | `.expect('Content-Type', /json/)` |
| Custom assertion | `.expect(res => { … })` |
| Send JSON body | `.send({ email: 'a@x.com' })` |
| Auth header | `.set('Authorization', 'Bearer …')` |
| Persist cookies | `request.agent(app)` |

## Before declaring done

- `request(app)`, app export split from `listen()`.
- Every chain awaited/returned; status via `.expect`, body via the runner's `expect`.
- Body assertions target fields, not snapshots.
- `{{qualityGate.fast}}` green.

<!-- navori:user-section -->
## This repo's HTTP tests (your domain)

<!-- user: add here what only applies to THIS repo. Suggestions:
     - How the app is booted for tests (real server vs. in-memory instance).
     - DB seed/teardown between tests and what must not leak across them.
     - How an authenticated request is built (token, header, helper).
     - External services that are stubbed and which ones are hit for real.
-->
