---
name: keystone-rest
description: REST/Express endpoints over Keystone 6 — the controller validates input with Zod safeParse and delegates to a service that uses context.sudo().db. Use when creating or touching a route, a controller or a REST service.
type: reference
---

# Keystone REST — thin controller, service holds the logic

Keystone exposes GraphQL, but a backend usually also mounts REST/Express routes (via `extendExpressApp` or its own router) for webhooks, integrations and custom endpoints. The rule: the **controller** only speaks HTTP; the **data logic lives in a service** that uses Keystone's `context`.

## When to use this skill

When creating or touching a REST route, its controller or the service behind it; or when debugging an endpoint that validates poorly, over-filters or leaks internals.

## The pattern

```ts
// controller — HTTP ONLY: validate the edge and delegate. Never business logic here.
export async function createReport(req: Request, res: Response) {
  const parsed = CreateReportSchema.safeParse(req.body); // safeParse, NEVER parse
  if (!parsed.success) return sendError(res, "Invalid input", 422);
  const report = await reportService.create(parsed.data, req.context);
  return sendSuccess(res, { data: report }, 201);
}

// service — the logic; receives context, not (req, res). context.sudo().db, not context.db.
export const reportService = {
  /** Creates a Report applying business rules (not the session's access). */
  async create(input: CreateReportInput, context: Context) {
    return context.sudo().db.Report.createOne({ data: input });
  },
};
```

## Hard rules

1. **`safeParse`, never `parse`.** HTTP input is hostile: validate it with the Zod schema and respond 4xx on failure; an uncaught exception leaks as a 500.
2. **Thin controller.** The controller doesn't access the DB nor implement rules: it parses, delegates to the service, formats the response. All testable logic lives in the service.
3. **The service receives `context`, not `req`/`res`.** That way it's tested without HTTP and reused from another controller, a hook or a job. Inside, use `context.sudo().db` (see `keystone-access` for why `sudo`).
4. **Errors without internals.** Never return stacktraces, SQL or library messages to the client; log the detail and respond with a bounded message and its code.
5. **Consistent responses.** Success and error both go through a single formatter (a `sendSuccess`/`sendError` or equivalent), not loose `res.json` in every controller.

## Before declaring the change "done"

- No controller calls `.parse(` on HTTP input (search for it: it must be `safeParse`).
- No controller uses `context.db.` directly — the logic is in a service with `context.sudo().db`.
- The new/touched service has unit tests (receives a mocked `context`; see `keystone-testing`).
