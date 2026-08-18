---
name: react-router
description: Use when creating routes, reading params, redirecting, or protecting views — React Router (v6/v7) patterns: nested routes, loaders, navigation, params, and guards.
type: reference
---

# React Router — conventions

## When to use this skill

When touching navigation: declaring a route, reading a param, redirecting, protecting a view by role, or wiring links. React Router is the source of truth for **which URL you're on and where you're going** — don't duplicate the route in your own state or parse `window.location` by hand.

## The pattern

Nested routes with a shared layout via `<Outlet />`; navigation via hooks, not by mutating `window.location`:

```tsx
const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,           // renders <Outlet /> for the children
    children: [
      { index: true, element: <Home /> },
      { path: 'sessions/:id', element: <SessionDetail /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

function SessionDetail() {
  const { id } = useParams();                 // string | undefined, always
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  // ...
  navigate('/sessions', { replace: true });   // no manual <a href>
}
```

## Gotchas that bite

- **`useParams()` always gives `string | undefined`.** Never `number`. Convert and validate (`Number(id)`, guard) before using it as an id; a mistyped route doesn't throw, it just arrives as `undefined`.
- **Navigate imperatively with `useNavigate`, not `window.location`.** `window.location.href = …` reloads the whole SPA and drops state. To go back: `navigate(-1)`; to redirect without leaving history: `{ replace: true }`.
- **`<NavLink>` for tabs/menus, `<Link>` for the rest.** `NavLink` exposes `isActive` in `className`/`style`/children; don't reimplement "is active" by comparing `pathname` by hand.
- **Search params are the URL, not `useState`.** Filters/pagination live in `useSearchParams` so the view is linkable and survives a refresh. `setParams` replaces the ENTIRE query — clone the current one if you only change one key.
- **A protected route = a wrapper with `<Navigate>`, not a loose `if`.** `if (!user) return <Navigate to="/login" replace />;` inside a guard/layout. Redirecting from a `useEffect` flashes the private view for a frame.
- **Relative routes nest; a leading `/` makes them absolute.** Inside `sessions/:id`, `navigate('edit')` goes to `sessions/:id/edit`; `navigate('/edit')` goes to the root. It's the #1 mistake when moving a component up/down a level.

## Hard rules

1. Navigation via `useNavigate`/`<Link>`/`<NavLink>`; never `window.location` or an internal `<a href>`.
2. `useParams` is validated before use (may be `undefined`); numeric ids are converted explicitly.
3. Filter/pagination state in `useSearchParams`, not in a mirror `useState`.
4. Protected views via a guard with `<Navigate replace>`, not by `if` + effect.
5. Shared layouts with nested routes + `<Outlet />`; no repeating the chrome per page.

## Before declaring done

- No `window.location`/`<a href>` for internal navigation; links with `<Link>`/`<NavLink>`.
- Params validated; URL state (filters, tab) lives in search params.
- Protected routes redirect with `<Navigate replace>`; no flash of the private view.
- `{{qualityGate.fast}}` green.

<!-- navori:user-section -->
## This repo's routing (your domain)

<!-- user: add here what only applies to THIS repo. Suggestions:
     - The real route map: which paths exist and which layout each hangs from.
     - How a protected route is written (guard / role check) and where the redirect lands.
     - The lazy-loading convention and which routes are eager on purpose.
     - Params and their types: what travels in the URL vs. in state.
-->
