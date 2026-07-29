---
name: axios
description: Use when touching HTTP calls to APIs — Axios patterns in TS: central instance, interceptors, typed responses, error handling, and cancellation.
type: reference
---

# Axios — conventions

## When to use this skill

When making an HTTP call to an API: creating a client endpoint, adding auth, mapping errors, or cancelling a request. Axios is wired **once** into a central instance with interceptors — components/services import that instance, not raw `axios` with the URL hand-written on every call.

## The pattern

One instance per API (baseURL + interceptors), typed functions on top; never `axios.get(fullUrl)` scattered around:

```ts
export const api = axios.create({
  baseURL: import.meta.env.VITE_APP_NEXUS_URL,
  timeout: 15_000,
});

api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (error) => Promise.reject(normalizeError(error)),  // a single error shape
);

// Typed service: the generic is the DATA TYPE, not the envelope.
export const getSession = (id: string) =>
  api.get<Session>(`/sessions/${id}`).then((r) => r.data);
```

## Gotchas that bite

- **`api.get<T>()` types `response.data`, not the whole response.** The `T` describes `data`; Axios wraps it in `{ data, status, headers }`. Return `r.data` from the service so the caller sees `Session`, not `AxiosResponse<Session>`.
- **One instance with `baseURL`, not the full URL per call.** Centralize host/timeout/headers. Repeating `axios.get('https://…/sessions')` scatters the config and breaks when switching environments.
- **Auth/refresh/logging in interceptors, not copied into every request.** The token goes in a `request.use`; the 401→refresh and error mapping go in `response.use`. No hand-written `headers: { Authorization }` on each endpoint.
- **`axios.isAxiosError(err)` before reading `err.response`.** In the `catch`, `err` is `unknown`. Without the type guard, `err.response.data` blows up on network errors (where `response` is `undefined` and only `err.request` exists).
- **A network error is NOT an HTTP error.** Timeout/DNS/offline carry no `response`. Distinguish `err.response` (the server replied with 4xx/5xx) from `err.request` (it never arrived) to give the right message.
- **Cancel in-flight requests with `AbortController`.** In effects/search-as-you-type pass `{ signal: controller.signal }` and abort on cleanup; without it, a stale response overwrites a newer one (race).
- **4xx/5xx already reject the promise.** Don't check `res.status` in the `.then`; the error flow lives in `catch`/the interceptor. Only `validateStatus` changes that rule, and you rarely need it.

## Hard rules

1. All HTTP goes through the central instance with `baseURL` + interceptors; no raw `axios` with a full URL floating loose.
2. Auth, refresh, and error normalization in interceptors, once.
3. Typed services with `api.get<Data>(...)` that return `.data`; the generic is the data, not the envelope.
4. In `catch`, `axios.isAxiosError` before touching `.response`; distinguish network error from HTTP error.
5. Cancellable requests (`AbortController`) where races can happen.

## Before declaring done

- The call uses the central instance; no absolute URLs or repeated auth headers.
- Typed responses returning `.data`; errors handled with `isAxiosError` and a single shape.
- Competing requests are cancelled on cleanup.
- `{{qualityGate.fast}}` green.
