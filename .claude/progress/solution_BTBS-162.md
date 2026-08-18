# Solution — BTBS-162

**Verdict:** CONCERNS
**Signals:** new shared abstraction (data-fetching/caching layer), state-ownership change (who is canonical for `sessions`/`coachees`/`user`/etc.), cross-cutting migration (25+ call sites across 15+ files), hard-to-reverse dependency choice (react-query vs RTK Query vs no new dep).
**Post-challenge:** a fresh-context `researcher` falsification pass (`.claude/progress/solution_review_BTBS-162.md`) found and I independently re-verified a real BLOCKER — a reachability finding was inverted — plus 3 CONCERNS. All are folded into this revision; see "Challenge findings applied" at the end.

## Problem

Reads that should be cached hit the network every time a component mounts,
because there is no shared cache/dedup layer — every consumer calls
`useFetchAndLoad().callEndpoint(...)` independently. The real problem is not
"we lack react-query"; it's **request de-duplication across independent
mount points that read the same data**, for two structurally different
shapes of consumer:

1. **Redux-owned, imperatively-triggered reads** (`sessions`): 13 call sites
   call `refreshSessions()` from event handlers/effects; the result is
   `dispatch`ed into `state.user.sessions`, and *other* components
   (`CoachCalendar.jsx:122`, `NextSession.jsx:415-416`,
   `useEvaluationAggregates.ts:43`, `useSessionHydration.ts:44`,
   `App.tsx:178-202`) read that Redux state directly, never the return value
   of `refreshSessions()`. Redux is the actual owner today.
2. **Component-local reads** (`focusAreas`, `coachees-by-id`, `workingHours`):
   each caller stores the response in its own `useState`, no Redux
   involvement. These looked like the clean, ticket-literal `useQuery`
   case at first read — the challenge (below) showed only `focusAreas`
   actually is; `coachees-by-id` turned out to be dead code and
   `workingHours` turned out to share a Context, not local state. See
   "Chosen solution" for the corrected split.

## What already exists

- `src/hooks/useFetchAndLoad.ts:14-85` — per-component `callEndpoint`
  wrapper (loading flag + abort tracking). Confirmed reusable as a
  `queryFn` body: it's a plain async function returning `{data, status}`.
  Not shared across instances (new one per `useFetchAndLoad()` call), so it
  does not itself solve dedup — but nothing about it blocks wrapping it.
- `src/hooks/useUserUtilities.ts:34-67` — `refreshSessions()`: sequential
  (not `Promise.all`) two-endpoint fetch, adapt, `Set`-based `_id` dedupe,
  `dispatch(modifySessions(sessions))`. Called from **13 sites** (verified
  by grep, matches the ticket's count exactly): `App.tsx:206`,
  `useSessionCloseHandler.ts:141`, `Calendar.jsx:19`, `NextSession.jsx:102`,
  `ScheduleAlignmentSession.jsx:60` + its `Scheduled.jsx:29`,
  `ScheduleAppointment/Scheduled.jsx:16`,
  `SessionAlignment_item.tsx:45`, `MySessions.jsx:375`,
  `RescheduleAppointment.jsx:65` + its `Scheduled.jsx:19`,
  `CoacheeCalendar.jsx:69` + its `Scheduled.jsx:56`.
- `src/components/ModalCloseSession/useSessionCloseHandler.ts:135-141` —
  **writes directly** to `state.user.sessions` (optimistic update via
  `applyClosureToSessions`), then calls `refreshSessions()` to resync. This
  is a second write path into the same Redux slice, independent of any
  fetch — a query-cache layer must not silently miss this write.
- `@reduxjs/toolkit@^1.8.1` is already installed and ships RTK Query
  (`node_modules/@reduxjs/toolkit/dist/query` present) — a caching layer
  is available with **zero new dependency**, already wired to the existing
  `store` (`src/index.tsx:132`, `Provider store={store}`).
- `src/pages/SessionEvaluation/hooks/useSessionHydration.ts:29-31` — ADR-1
  comment: *"reuses existing getSessionByID + modifySession — no new
  thunk, no RTK Query."* A prior, explicit decision to avoid RTK Query for
  one narrow hydration path. Scope of that ADR is ambiguous (see Open
  questions) — relevant precedent, not necessarily a blanket rule.
- No existing in-repo caching/memoization utility for HTTP reads (checked;
  the only "cache" hits in `src` are chunk-reload cache-busting and an
  unrelated Jitsi token cache) — so per the skill's preference order
  (`existing pattern > small extension > new abstraction`), this is
  legitimately new territory, but the *smallest* new-territory option
  should still be preferred over the largest.
- **Corrected reachability finding (was inverted in the first pass, fixed
  after challenge — see "Challenge findings applied").**
  `src/pages/MyCoachees/index.tsx:2` does `import MyCoachees from
  './MyCoachees'` — an extensionless specifier, with both `MyCoachees.jsx`
  and `MyCoachees.tsx` present in the same directory. Vite 7.3.1 (installed
  version; no `resolve.extensions` override in `vite.config.mjs`, verified)
  resolves extensionless imports via `DEFAULT_EXTENSIONS = ['.mjs', '.js',
  '.mts', '.ts', '.jsx', '.tsx', '.json']` — **`.jsx` wins before `.tsx`**
  (confirmed by reading the exact array in the installed
  `vite/dist/node/chunks/logger.js`). So the routed page is
  **`MyCoachees.jsx` → `CoacheeStatus.jsx`**, not `MyCoachees.tsx` →
  `CoacheeStatus2`. Confirmed empirically against a fresh production build
  (`dist/`, built after both files' last edits): `dist/assets/*.js`
  contains the `.jsx` variants' unique CSS class markers
  (`MyCoachees-header`, `MyCoachees__searchbar`) and **zero** occurrences of
  `CoacheeStatus2`/`getMyCoacheesById`.
  - `CoacheeStatus.jsx:16` — `const { coachees } = useSelector((state) =>
    state.user);` — the live page reads `coachees` from **Redux**, not
    local state. `state.user.coachees` is populated by the whole-user `GET
    /user` response (`src/adapters/user.adapter.ts:238`,
    `coachees: (coachProfile.coachees || []).map(adaptPopulatedCoachee)`) —
    the live UI **never calls `getMyCoacheesById`** at all; that endpoint
    (and `MyCoachees.tsx`/`CoacheeStatus2.tsx`) is the code that's actually
    dead.
  - `CoacheeStatus.jsx:39-41` — `useEffect(() => { refreshUser(); }, [])` —
    this is the real, live source of the ticket's cited "2 `getUser`
    simultáneos" symptom: `refreshUser()` (`useUserUtilities.ts:23-31`)
    calls `GET /user` + `dispatch(modifyUser(...))`, the same whole-user
    fetch `App.tsx`'s login flow already performs once. Every "Mis
    Coachees" mount refires it. `refreshUser()` has **11 call sites**
    across 9 files (grep-verified), same shape as `refreshSessions`:
    Redux-owned (`modifyUser`), imperatively triggered, mostly
    post-mutation ("I just saved X, refetch me") plus this one
    concurrent-with-login case.

## Constraints

- React 18.2, Redux Toolkit 1.8.1 + react-redux 8.1.2, no test renderer
  (`@testing-library/react` not installed); existing test convention is
  pure-function unit tests only (`src/**/__tests__/*.test.ts`), no
  component/hook render tests anywhere in the repo.
- `state.user.sessions` has real consumers outside the `refreshSessions()`
  call chain that must keep working unchanged, or be migrated in the same
  breath — migrating them is out of the ticket's stated blast radius. The
  first pass under-counted these at "~6" (5 files); the challenge found 6
  more indirect readers (destructured off an already-selected `state.user`,
  e.g. `const { sessions } = user`) that plain grep for the literal string
  `state.user.sessions` misses: `Calendar.jsx`, `MySessions.jsx`,
  `CoacheeCalendar.jsx`, `ScheduleAppointment.jsx`,
  `RescheduleAppointment.jsx`, `ScheduleAlignmentSession.jsx` — several of
  which gate booking-eligibility/spacing logic on session freshness, not
  just display. This **does not** break Approach B's guarantee (Redux stays
  the read surface for all of them, enumerated or not), but it does mean
  the resource is mutated from more places, more often, than the first pass
  implied — relevant to the staleTime decision below.
- `state.user.coachees` has the same shape as `sessions`: Redux-owned,
  populated by the shared `refreshUser()`/`GET /user` call, read directly
  by `CoacheeStatus.jsx:16`. Any facade for `refreshUser()` must preserve
  that write path unchanged, same as `refreshSessions()`.

## Approaches

**A — Hand-rolled in-flight/staleness cache (no new dependency).**
A module-level `{promise, timestamp}` singleton inside `useUserUtilities`
that coalesces concurrent `refreshSessions()` calls and skips refetch
within a TTL. Zero new dependency, smallest possible diff.
*Tradeoff:* reinvents cache invalidation/staleTime/error-retry semantics
by hand for every one of the 4 endpoints in scope; that's exactly the kind
of undifferentiated code a caching library exists to delete. Cost of
reversal: low, but doesn't scale to `focusAreas`/`coachees`/`workingHours`
without repeating the pattern 4 times.

**B — `@tanstack/react-query` as an internal caching layer (bridge),
Redux stays canonical for `sessions`.** `refreshSessions()` keeps its exact
signature (`async () => AdaptedSession[] | undefined`) and its
`dispatch(modifySessions(...))` side effect; internally it calls
`queryClient.fetchQuery({queryKey: ['sessions', user.mongoID, user.role],
queryFn, staleTime})` instead of hitting the endpoints directly. The 13
call sites and the 6+ Redux-reading consumers need **zero changes**.
`focusAreas`/`coachees`/`workingHours` (believed at this point in the
analysis to be component-local state, no Redux entanglement) get idiomatic
`useQuery` hooks directly, matching the ticket's proposal for those three
— **revised below**, in "Chosen solution," after the challenge corrected
two of those three.
*Tradeoff:* two caches conceptually exist for `sessions` (RQ + Redux
mirror) — acceptable because RQ is not exposed as a second read surface;
it's purely the fetch/dedup engine behind the existing Redux write. Cost
of reversal: low (delete the internal `fetchQuery` call, restore direct
`await callEndpoint(...)` calls; no consumer-facing API changed).

**C — `@tanstack/react-query`, full literal migration (`refreshSessions` →
`useQuery(['sessions', userId])`, per the ticket's text).**
*Tradeoff:* the 13 call sites are imperative (event handlers/effects), not
render-time hook consumption, so most would need `queryClient.fetchQuery`
anyway — the "convert to `useQuery`" framing only cleanly fits the render
that reads the result, and today that render happens in **6 separate
Redux-selector call sites**, not at the fetch call sites. Migrating those
6 to read `useQuery`'s cache instead of `state.user.sessions` means
deciding a new state owner and touching `CoachCalendar.jsx`,
`NextSession.jsx`, `useEvaluationAggregates.ts`, `useSessionHydration.ts`,
`App.tsx`, plus reconciling `useSessionCloseHandler.ts`'s optimistic Redux
write with a query cache. Real feature, much bigger than what the ticket's
"4→1, 13 dedupe" framing implies. Cost of reversal: high once consumers
are repointed.

**D — RTK Query (`createApi`), zero new dependency, native Redux
integration.** Generates a slice + hooks wired into the existing `store`;
solves dedup/cache the same way B does but the *canonical* cache would
live inside the `@reduxjs/toolkit` runtime already in the bundle.
*Tradeoff:* still forces the same ownership decision as C for the 6 Redux
readers (RTK Query's cache is a *different* slice than the plain `user`
slice `sessions` lives in today — splitting it out is the same-sized
refactor as C, just inside Redux instead of alongside it). Also runs
against the explicit ADR-1 "no RTK Query" precedent for one adjacent file,
whose scope is ambiguous (see Open questions).

## Chosen solution

**B (bridge/facade) for every Redux- or Context-owned resource; idiomatic
`useQuery` only for the one genuinely local-state read.** This is the
failure #1 check from the skill in practice, and the challenge sharpened
where the line actually falls:

- **`sessions`** (`useUserUtilities.refreshSessions`) — bridge. 13
  imperative call sites, 11 direct/indirect Redux readers, one optimistic
  writer. Unchanged from the first pass.
- **`user`/`coachees`** (`useUserUtilities.refreshUser`) — bridge, **added
  after the challenge**. Same file, same shape as `refreshSessions`
  (Redux-owned via `modifyUser`, imperatively triggered from 11 call
  sites). This is what actually fixes the ticket's own cited symptom
  ("`CoacheeStatus.jsx:39-41` hace 2 `getUser` simultáneos") — the first
  pass misidentified that file as dead code and dropped the fix; it is
  the live code path (see "What already exists").
- **`workingHours`** (`getUserWorkingHours`, 3 call sites) — bridge, **not**
  a bare `useQuery` as the first pass proposed. The challenge found 2 of 3
  call sites (`CoachCalendar.jsx`, `WorkingHours.jsx`) write into a shared
  `CoachCalendarContext`, not independent local state, and the 3rd
  (`useCoachCalendar.ts`) is an imperative hook reused by 5 page components
  with a per-call coach id — the same "imperative multi-caller" topology
  used to justify the `sessions` bridge, not the clean case it was filed
  under. A bare `useQuery` would change all 5 consumers' refetch semantics
  and risk the `WorkingHours.jsx` edit buffer seeding from stale context.
  The bridge preserves every existing function signature and write target;
  only the network-fetch internals change.
- **`focusAreas`** (3 call sites) — idiomatic `useQuery`, unchanged from
  the first pass. This is the one case that survived the challenge exactly
  as proposed: pure component-local `useState`, GET-only endpoint (no
  mutation exists in `focusAreas.service.ts`), no Redux/Context
  entanglement, no multi-consumer imperative reuse.
- **`getMyCoacheesById`** — **dropped from scope.** Its only call site
  (`MyCoachees.tsx:40`) is unreachable code (see "What already exists");
  migrating it would ship a no-op.

Net effect: three bridges (`sessions`, `user`, `workingHours`) inside
existing hook files, zero consumer-facing signature changes, plus one
idiomatic `useQuery` hook for `focusAreas` touching its 3 call sites. No
Redux/Context consumer anywhere in the app needs to change.

Chosen over A because A still leaves `focusAreas` needing a hand-rolled
cache of its own, and doesn't compose across four resources without
repeating the pattern. Chosen over C because C bundles an unrequested,
higher-risk Redux-ownership migration (repointing 11+ Redux/Context
readers) into a caching ticket. Chosen over D because it carries the same
ownership-migration cost as C for no dependency savings that matters here
(13KB gzip is not a material concern for this app), and it runs against
the one existing ADR the repo already has on this exact class of decision.

## Boundaries & contracts

- `refreshSessions(): Promise<AdaptedSession[] | undefined>` and
  `refreshUser(): Promise<void>` — signatures and Redux side effects
  (`dispatch(modifySessions(...))` / `dispatch(modifyUser(...))`) preserved
  exactly; only the internals change. All 13 + 11 call sites and
  `useSessionCloseHandler.ts`'s write-then-refresh sequence keep working
  unmodified.
- `getWorkingHours(id)` in `CoachCalendar.jsx`, `WorkingHours.jsx`, and
  `useCoachCalendar.ts` — same treatment: internals route through
  `queryClient.fetchQuery`, the function each file calls and what it does
  with the result (`updateWorkingUI` into `CoachCalendarContext`, or local
  state in the hook) is untouched.
- New `useFocusAreas()` is the one net-new hook consumers actually adopt —
  3 call sites (`Profile.jsx:84`, `MySessions.jsx:396`,
  `FocusAreas.jsx:38`) change from `callEndpoint(getFocusAreas())` to the
  hook; no other file is touched for this resource.
- `queryKey` design: `['sessions', user.mongoID, user.role]` (role affects
  which two endpoints are hit), `['user', user.mongoID]`, `['focusAreas']`
  (global, no params), `['workingHours', <the id the endpoint was actually
  called with>]` — **not** `state.user.mongoID`: `useCoachCalendar.ts` and
  `WorkingHours.jsx`/`CoachCalendar.jsx` are sometimes called with a
  *different* coach's id (booking flows where the logged-in user is a
  coachee viewing a coach's availability) — keying by the logged-in user
  would collide two different coaches' working hours.

## Failure modes

- **Stale-serve after mutation — resolved by design, not by enumeration.**
  The first pass tried to name every "write, then refresh expecting fresh
  data" call site individually (`useSessionCloseHandler.ts`) and set a
  10-30s `staleTime`; the challenge found **5 more** call sites with the
  identical shape (all four booking `Scheduled.jsx` confirmation screens +
  `SessionAlignment_item.tsx`'s cancel flow) that a time-based `staleTime`
  would silently serve pre-mutation data to. Enumerating every such site is
  a maintenance trap — new call sites added later would silently regress.
  **Fix: `staleTime: 0` for `sessions`, `user`, and `workingHours`** (all
  three are mutated often, from many places). React Query's request
  coalescing dedupes **concurrent** calls to the same `queryKey`
  regardless of `staleTime` — that's what actually produces the ticket's
  "4→1 on Home" and "2 getUser simultáneos" wins, since those calls
  genuinely overlap in time (mount-time effects firing together). A
  sequential call minutes later (e.g. a confirmation screen after booking)
  always gets a real network round-trip, matching today's behavior exactly
  and removing the staleness risk by construction instead of by tracking
  every write site. `focusAreas` is the one resource where a long/effectively-
  infinite `staleTime` is safe, because it has no mutation endpoint at all.
- **Promise.all error semantics** (sessions only): converting the two
  sequential `await`s to `Promise.all` changes fail-fast timing (today:
  sub-call 2 doesn't even start if sub-call 1 rejects; after: both are in
  flight, first rejection wins) but the outer `catch` →
  `dispatch(modifySessions([]))` behavior is preserved either way — no
  consumer-visible change, but worth a unit test since it's an intentional
  behavior tweak the ticket explicitly asks for.
- **Empty/undefined `user.mongoID`**: `refreshSessions`/`refreshUser` have
  no internal guard today; callers guard inconsistently (`App.tsx:319`
  checks `user?.mongoID` before calling `getSessions`, others don't). Not a
  new risk from this change — preserve as-is, don't silently "fix" it as a
  drive-by.
- **In-tab user switch**: `App.tsx` subscribes to Firebase's
  `onAuthStateChanged` directly, so a different user can log in after a
  logout without a full page reload (shared-device scenario). Query keys
  are namespaced by `mongoID` so one user's data can't leak into another's
  key, but a slow in-flight fetch for the previous user resolving after
  logout, and cache entries accumulating across in-tab switches, are
  unhandled. Low risk — call `queryClient.clear()` on `resetUser()`.

## Migration & compatibility

- Add `@tanstack/react-query` to `package.json`; mount `QueryClientProvider`
  in `src/index.tsx` near the existing `Provider store={store}` (line 132).
  Call `queryClient.clear()` inside `resetUser()`'s dispatch path (or
  wherever logout is handled) to bound cache growth across in-tab user
  switches.
- `useUserUtilities.ts`: wrap `refreshSessions`'s coach/coachee branch in
  `Promise.all`, move both `refreshSessions` and `refreshUser`'s fetch
  behind `queryClient.fetchQuery({queryKey, queryFn, staleTime: 0})`, keep
  adapt+dedupe+dispatch as-is. This is the fix for the ticket's own cited
  "2 `getUser` simultáneos" symptom (`CoacheeStatus.jsx:39-41`, live code —
  see "What already exists").
- `focusAreas.service.ts` exposes GET only (verified, no write endpoint in
  the file) — safe to cache with a long/effectively-infinite `staleTime`;
  migrate `Profile.jsx:84`, `MySessions.jsx:396`,
  `Onboarding/components/FocusAreas/FocusAreas.jsx:38` to a new
  `useFocusAreas()` hook.
- `getUserWorkingHours`'s 3 call sites (`useCoachCalendar.ts:21`,
  `CoachCalendar.jsx:42`, `WorkingHours.jsx:84`) get the **bridge**
  treatment, not a bare `useQuery`: each keeps its existing
  `getWorkingHours(id)` function and write target
  (`CoachCalendarContext`/local state) unchanged; only the fetch inside
  routes through `queryClient.fetchQuery({queryKey: ['workingHours', id],
  ..., staleTime: 0})`. `WorkingHours.jsx`'s save-then-refetch
  (`saveWorkingHours` → `getWorkingHours(mongoID)`) keeps working as-is
  since `staleTime: 0` always issues a fresh request on that sequential
  call.
- `getMyCoacheesById` / `MyCoachees.tsx` / `CoacheeStatus2.tsx` — **out of
  scope**, confirmed unreachable (see NOT in scope).

## Testing strategy

- Extract `refreshSessions`'s branch+adapt+dedupe logic into a named,
  exported function (mirrors the repo's existing convention of testing
  `decide*`/`apply*` pure functions, e.g. `sessionClosure.test.ts` for
  `applyClosureToSessions`) and unit-test it with a mocked `callEndpoint`:
  overlapping `_id`s across the two sub-calls, one branch empty, one branch
  rejecting under `Promise.all` (answers the Promise.all failure-mode risk
  above).
- With `staleTime: 0` for `sessions`/`user`/`workingHours`, there is no
  per-call-site "does this one need forced invalidation" branch to test —
  the property to verify instead is that two calls issued back-to-back
  (not concurrently) both hit the network (i.e. `fetchQuery` isn't
  silently serving a cached value across sequential calls), and that two
  calls issued concurrently collapse into one request. That's a property
  of `staleTime: 0` itself, worth one focused test on the wrapped
  `refreshSessions`/`refreshUser` rather than one test per consumer.
- No new `@testing-library/react`/hook-render harness proposed — matches
  the repo's current test culture (zero component/hook render tests exist
  today); flagged as an open question below, not assumed as a requirement.
- Manual check: DevTools Network tab on Home load shows one sessions fetch
  pair (2 requests via `Promise.all`) instead of the current four.

## NOT in scope

- Migrating any Redux/Context reader of `sessions`, `coachees`, or
  `workingHours` (11 files total, see "Constraints" and "Chosen solution")
  onto React Query's cache directly — the bridges keep those stores as the
  read surface, unchanged.
- Deleting the dead code, now correctly identified as
  **`MyCoachees.tsx` + `CoacheeStatus2.tsx`** (not the `.jsx` pair, which
  is live — corrected after the challenge). Real cleanup, but a separate
  ticket; not caused by and not fixed by adding a caching layer.
- `getUserBlockSchedule` or any other endpoint not named in the ticket.
- Introducing RTK Query — evaluated as Approach D, not chosen.
- Adding a hook-rendering test harness (`@testing-library/react`) — the
  extract-and-unit-test strategy covers the identified risks without new
  test tooling.

## Open questions

- **[human]** Does the ADR-1 comment in `useSessionHydration.ts:29-31`
  ("no new thunk, no RTK Query") reflect a standing team position against
  RTK Query specifically, or was it scoped to that one hydration call?
  It's cited above as supporting evidence against Approach D — confirm
  before treating it as settled precedent rather than local context.
- **[assumed]** No other Bonum frontend (mobile app, ai-coach-frontend)
  imports `useUserUtilities` or these services directly — they live under
  this repo's local `src/hooks`/`src/services`, so blast radius is
  contained to `bonum-webapp`. Not independently re-verified across repos;
  low risk given the module paths, flagged rather than silently assumed.
- **Resolved by design during the challenge** (no longer open):
  per-resource `staleTime` — settled on `0` for `sessions`/`user`/
  `workingHours` (mutated often, concurrent-dedup is the actual win) and
  effectively-infinite for `focusAreas` (no mutation endpoint exists); see
  "Failure modes." `workingHours` cache-key collision across coaches —
  settled on keying by the id the endpoint call actually receives, not
  `state.user.mongoID`; see "Boundaries & contracts."

## Challenge findings applied

One round, fresh context (`researcher`, falsification brief), findings in
`.claude/progress/solution_review_BTBS-162.md`. I independently re-verified
the load-bearing one against the real repo (not taken on the subagent's
word) before folding it in: read `vite.config.mjs` (no `resolve.extensions`
override), read the installed `vite@7.3.1`'s `DEFAULT_EXTENSIONS` array
directly (`.jsx` before `.tsx`), and grepped the actual `dist/` production
build for both variants' unique markers — confirmed the `.jsx` pair ships,
the `.tsx` pair doesn't.

| # | Severity | Claim | Disposition |
|---|---|---|---|
| 1 | BLOCKER | `MyCoachees.jsx`/`CoacheeStatus.jsx` are live (Vite resolves `.jsx` before `.tsx`); `MyCoachees.tsx`/`CoacheeStatus2.tsx` are dead. First pass had this inverted. | **Applied.** Dropped `getMyCoacheesById` from scope; added a `refreshUser()` bridge (fixes the ticket's own cited symptom on the real code path); corrected the dead-code cleanup item. |
| 2 | CONCERN | `sessions` Redux-reader inventory undercounted (~6 claimed, 11 found). | **Applied.** Inventory corrected in "Constraints"; does not change the architecture (B is Redux-transparent regardless of reader count). |
| 3 | CONCERN | "Force invalidation" failure mode scoped to 1 call site; 5 more with the same shape exist. | **Applied — redesigned, not patched.** Replaced per-site invalidation tracking with `staleTime: 0` for mutation-heavy resources, which removes the failure mode by construction instead of by enumeration. |
| 4 | CONCERN | `getUserWorkingHours` framed as clean local-state `useQuery`; 2/3 sites share `CoachCalendarContext`, 3rd has multi-caller imperative topology. | **Applied.** Switched to the bridge pattern (same as `sessions`/`user`), not a bare `useQuery`. |
| 5 | NOTE | No cross-real-user cache collision for `sessions`, but no cache cleanup on in-tab logout. | **Applied.** Added `queryClient.clear()` on `resetUser()` to "Migration & compatibility." |
| 6 | NOTE | `workingHours` key must use the endpoint's argument id, not `state.user.mongoID`, or it collides across coaches in booking flows. | **Applied.** Made explicit in "Boundaries & contracts." |
| 7 | NOTE | Approach-comparison weighting gap for `getMyCoacheesById`, mooted by #1. | **Moot** — that endpoint is out of scope after #1. |

The `sessions` bridge (Approach B's core) survived the challenge unchanged.
No second challenge round — per the skill, one round only once findings are
accepted.
