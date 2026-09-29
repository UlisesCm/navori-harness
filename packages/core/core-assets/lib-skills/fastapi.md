---
name: fastapi
description: Use when building or fixing FastAPI endpoints with Pydantic v2 — APIRouter, Depends, request/response models, exception handlers, lifespan, async vs sync, pydantic-settings, TestClient.
metadata:
  type: reference
---

# FastAPI + Pydantic v2 — conventions

## When to use this skill

When adding or debugging FastAPI routes, dependencies, Pydantic models, startup/shutdown resources, or API tests. Pydantic v2 names apply (`model_validate`, `model_dump`, `model_config`); v1 names (`.dict()`, `class Config`) are legacy.

## The pattern

One `APIRouter` per resource, typed request and response models, shared resources via `Depends`, and an explicit status code.

```python
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field

router = APIRouter(prefix="/users", tags=["users"])

class UserIn(BaseModel):
    email: str
    age: int = Field(ge=0)

class UserOut(UserIn):
    model_config = ConfigDict(from_attributes=True)
    id: int

@router.post("", response_model=UserOut, status_code=status.HTTP_201_CREATED)
async def create_user(body: UserIn, repo: Repo = Depends(get_repo)) -> UserOut:
    if await repo.exists(body.email):
        raise HTTPException(status.HTTP_409_CONFLICT, "email taken")
    return UserOut.model_validate(await repo.create(body))
```

## Gotchas that bite

- **Blocking calls in `async def` freeze the event loop.** Use `def` for blocking work (FastAPI runs it in a threadpool) or an async client; never `requests`, `time.sleep`, or a sync DB driver inside `async def`.
- **Return a separate response model.** `response_model` filters output, so password hashes and internal fields stay out; never reuse the input model.
- **Startup and shutdown go in `lifespan`**, not the deprecated `@app.on_event`: `FastAPI(lifespan=lifespan)` with an `@asynccontextmanager` that yields once.
- **`Depends` is per request, cached within it.** Put the DB session or current user there; use `yield` dependencies for cleanup.
- **Validation errors are 422 by default.** Map domain errors with `@app.exception_handler(MyError)`; raise `HTTPException` only for HTTP-level failures.
- **Config via `pydantic-settings`.** `class Settings(BaseSettings)` reads env vars; build it once and inject it with `Depends`, never hardcode secrets or URLs.

## Hard rules

1. Type every parameter and return; declare `response_model` (or a return annotation) and `status_code` on each route.
2. Split routers by resource and mount them with `app.include_router`.
3. No blocking I/O in `async def`.
4. Resources with a lifetime (clients, pools) live in `lifespan`.
5. Test with `TestClient(app)` (or `httpx.AsyncClient` with `ASGITransport` for async) and swap collaborators via `app.dependency_overrides[dep] = fake`; clear it after each test.

## Quick table

| Need | Use |
|---|---|
| Group routes | `APIRouter(prefix=..., tags=[...])` |
| Share a resource | `Depends(get_x)` |
| Validate to a model | `Model.model_validate(data)` |
| Serialize | `model.model_dump()` |
| Domain error to HTTP | `@app.exception_handler(Err)` |
| Startup/shutdown | `lifespan=` context manager |

## Before declaring done

- Every route has typed input/output models and an explicit status code.
- No blocking call inside an `async def`; no secrets in code.
- Tests cover the happy path and one 4xx, with overrides cleared.
- `{{qualityGate.fast}}` green.

<!-- navori:user-section -->
## This repo's API (your domain)

<!-- user: add here what only applies to THIS repo. Suggestions:
     - Where routers, schemas and dependencies live.
     - Auth scheme and the dependency that enforces it.
     - Error-response shape and the shared exception handlers.
     - Settings/env variables the service requires.
-->
