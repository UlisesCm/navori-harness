## Stack — FastAPI (Python)

HTTP backend on FastAPI in Python. Requests flow through layers: `router → schema (pydantic) → dependency → service → data layer → response model`. Routers stay thin: parse the request, call a service, return a response model. Business logic lives in services. Errors propagate via `HTTPException` or a registered domain exception handler. Logging goes through the `logging` module, never `print`.

Golden rule: no `print`; no `os.environ` outside the settings module (pydantic settings). Validation ALWAYS happens at the boundary with pydantic models, and every route declares its `response_model`. Shared resources (DB sessions, clients, auth) come through `Depends`, not module globals. Apply the `fastapi` skill when you touch routers or dependencies; pytest guidance is injected only if the repo declares pytest.

A ticket's work follows the phase table in the `resolve-ticket` skill, run by the orchestrator; this stack adds no phase of its own.
