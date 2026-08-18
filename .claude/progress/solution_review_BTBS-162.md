# Solution Review — BTBS-162 (falsification pass)

Target design: `.claude/progress/solution_BTBS-162.md` (verdict: CONCERNS, Approach B).
Scope: read-only verification against `/Users/ulisescm/Documents/Dev - Docs/bonum/bonum-webapp`.

---

## BLOCKER 1 — `MyCoachees.jsx`/`CoacheeStatus.jsx` are NOT dead code; the design's reachability analysis is inverted

**Claim in the design:** "The routed entry is `pages/MyCoachees/index.tsx` → `MyCoachees.tsx` → `CoacheeStatus2`... `CoacheeStatus.jsx`'s `refreshUser()` call is unreachable from the app" (solution doc, lines 63-70). On this basis the design scopes `getMyCoacheesById` → `useQuery` at `MyCoachees.tsx:40` and drops the `.jsx` pair as "dead code, separate ticket."

**This is false.** Both `MyCoachees.jsx` and `MyCoachees.tsx` exist side by side in `src/pages/MyCoachees/`, and `index.tsx` imports the bare specifier `./MyCoachees` (no extension):

- `src/pages/MyCoachees/index.tsx:2` — `import MyCoachees from './MyCoachees';`

Vite 7.3.1 (the version installed in this repo, `package.json` `"vite": "^7.3.1"`) resolves extensionless relative imports by trying `DEFAULT_EXTENSIONS` **in array order** and returning the first file that exists on disk:

- `node_modules/.pnpm/vite@7.3.1_.../vite/dist/node/chunks/logger.js:130-137` —
  `const DEFAULT_EXTENSIONS = ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'];`
- `node_modules/.pnpm/vite@7.3.1_.../vite/dist/node/chunks/config.js:32918-32923` —
  `tryResolveRealFileWithExtensions` does `for (const ext of extensions$1) { ...; if (res) return res; }` — first match wins, no TS-vs-JS preference.

`.jsx` (index 4) is tried **before** `.tsx` (index 5). No `vite.config.mjs` override exists (`resolve.extensions` is not set — confirmed by reading `vite.config.mjs` in full). `vite-tsconfig-paths` (the only other resolve-affecting plugin) only intercepts tsconfig `paths`/alias imports, not plain relative specifiers, so it does not change this. Therefore `import MyCoachees from './MyCoachees'` resolves to **`MyCoachees.jsx`**, not `MyCoachees.tsx`.

**Empirically confirmed**, not just reasoned: the repo has a recent build artifact (`dist/`, built 2026-08-17, after both files' last edits). Searched the whole shipped bundle:

- `grep -rl "MyCoachees-header" dist/assets/*.js` → hits — that CSS class only exists in `MyCoachees.jsx` (`src/pages/MyCoachees/MyCoachees.jsx:21`).
- `grep -rl "MyCoachees__searchbar" dist/assets/*.js` → hits — that class only exists in `CoacheeStatus.jsx` (`src/pages/MyCoachees/components/CoacheeStatus/CoacheeStatus.jsx:68`).
- `grep -rl "CoacheeStatus2\|getMyCoacheesById" dist/assets/` (whole build, all chunks) → **zero hits**.

So `MyCoachees.tsx` + `CoacheeStatus2.tsx` + the `getMyCoacheesById` call at `MyCoachees.tsx:40` are **absent from the shipped bundle** — they are the actually-dead code. `MyCoachees.jsx` → `CoacheeStatus.jsx` is what real users hit.

**Why this matters for the design, not just as a standalone bug:**

- `CoacheeStatus.jsx:16` — `const { coachees } = useSelector((state) => state.user);` — the live page reads `coachees` from **Redux**, not local `useState`. This directly contradicts the design's classification of the `coachees` endpoint as "component-local state, no Redux entanglement" (design doc lines 22-25, 102-104) — that classification is true only for the dead `.tsx` path.
- `CoacheeStatus.jsx:39-41` — `useEffect(() => { refreshUser(); }, [])` — this is the live source of the "2 `getUser` simultáneos" symptom the design itself says the ticket originally cited for this file (design doc line 66-68: *"the file the ticket cites for '2 getUser simultaneos' at `CoacheeStatus.jsx:39-41`"*). `refreshUser()` (`src/hooks/useUserUtilities.ts:23-31`) calls `GET /user` and `dispatch(modifyUser(...))` — the same endpoint `App.tsx`'s login flow already calls once (`App.tsx:265` `dispatch(modifyUser(adaptedUser))`, fed by `getUserApi()` at line ~237). Every time a coach opens "Mis Coachees," this refires that whole-user fetch again.
- `state.user.coachees` is populated from that same `/user` response via `src/adapters/user.adapter.ts:238` (`coachees: (coachProfile.coachees || []).map(adaptPopulatedCoachee)`) — so the actually-live page never calls `getMyCoacheesById` at all; the endpoint the design chose to migrate to `useQuery` is not what feeds the real UI.

**Consequence:** Approach B's `getMyCoacheesById → useQuery` migration item (design doc, "Migration & compatibility," `MyCoachees.tsx:40`) would ship a no-op — it touches a code path nobody executes — and leaves the ticket's own originally-cited duplicate-fetch symptom (`refreshUser()` in the live `CoacheeStatus.jsx`) completely unaddressed. Worse, since the live consumer is Redux-entangled (like `sessions`, not like the other "clean" endpoints), fixing it for real needs the **same bridge/facade reasoning applied to `sessions`**, not a bare `useQuery`. This is a genuine "rediscover the reachable code" problem, not a detail to patch — it invalidates the design's scoping decision for one of its four target endpoints and the premise used to justify dropping the `.jsx` pair from scope.

**Severity: BLOCKER** for the `getMyCoacheesById`/`MyCoachees` slice of the design specifically. It does not touch the `sessions` bridge (Approach B's core), which is unaffected by this finding.

---

## CONCERN 2 — The "~6 Redux-reading consumers" of `state.user.sessions` inventory is materially incomplete

**Claim:** design doc lines 15-21 lists exactly 5 files (`CoachCalendar.jsx:122`, `NextSession.jsx:415-416`, `useEvaluationAggregates.ts:43`, `useSessionHydration.ts:44`, `App.tsx:178-202`) as "the" Redux-reading consumers, calling it "~6" and treating the enumeration as settled ("Constraints," lines 78-81).

**Found at least 6 more direct readers of `state.user.sessions`** the design's list omits, all reachable via `grep`/`Read` (none are `__tests__`):

- `src/pages/CoachCalendar/Components/Calendar/Calendar.jsx:14` — `const { sessions, timezone } = useSelector((state) => state.user);`, used at line 26: `useEffect(() => { if (!sessions) getSessions(); }, [sessions]);`
- `src/pages/MySessions/MySessions.jsx:361` — `const { sessions: rawSessions } = useSelector((state) => state.user);`, mapped into `sessions` at line 372 and driving the whole page's ordered/completed/alignment session lists.
- `src/pages/CoacheeCalendar/CoacheeCalendar.jsx:26` — `const { coach, sessions, timezone, testAccount } = user;`, used for spacing rules (line 37-38) and rendered via `<DayCalendar sessions={sessions} />` (line 277).
- `src/pages/ScheduleAppointment/ScheduleAppointment.jsx:21` — `const { coach, sessions, cohort, timezone, additionalSessions } = user;`, drives `lastSession`/`normalSessions` booking-eligibility logic (lines 28-30).
- `src/pages/RescheduleAppointment/RescheduleAppointment.jsx:29` — `const { coach, sessions, timezone } = user;`, drives the reschedule candidate list (lines 40-109).
- `src/pages/ScheduleAlignmentSession/ScheduleAlignmentSession.jsx:25` — `const { coach, sessions, mongoID, cohort } = user;`, drives alignment-session spacing/limit checks (lines 34-45).

These are missed because they destructure `sessions` off an already-selected `state.user` object (sometimes renamed, e.g. `rawSessions`), a pattern the design's own evidence-gathering (grep for the literal strings `state.user.sessions`/`user.sessions`) does not catch.

**Does this break Approach B's promise?** No — architecturally it doesn't matter, *because* B never touches `state.user.sessions` or its write path; any consumer, enumerated or not, keeps working identically as long as `dispatch(modifySessions(...))` still fires with the same data shape. So this is not a blocker for the chosen architecture.

**Why it's still a CONCERN:** (a) it's presented as a verified, closed inventory ("matches the ticket's count exactly") when it undercounts real consumers roughly 2x — a rigor gap worth fixing before this doc is trusted for anything else; (b) several of the missed readers (`ScheduleAppointment.jsx`, `RescheduleAppointment.jsx`, `ScheduleAlignmentSession.jsx`) don't just *display* sessions, they gate **booking-eligibility/spacing logic** on session freshness — which raises the stakes of the staleness question in Concern 3 below (a stale cache here doesn't just show an outdated list, it can let a booking-limit check pass or fail incorrectly).

**Severity: CONCERN** (confidence/completeness gap; doesn't invalidate B's transparency guarantee, but feeds into Concern 3's severity).

---

## CONCERN 3 — The "optimistic-write-then-refresh needs forced invalidation" failure mode is scoped too narrowly

**Claim:** design doc's "Failure modes" section (lines 179-186) identifies exactly **one** path needing `invalidateQueries` instead of a plain cached `fetchQuery`: `useSessionCloseHandler.ts:135-141`'s optimistic-dispatch-then-refresh.

**Found the same "a write just happened elsewhere, this refresh must reflect it" shape on at least 5 more of the 13 `refreshSessions()` call sites** — these don't do an optimistic Redux dispatch first, but they call `refreshSessions()` **immediately after a server-side mutation succeeded**, expecting the newly-mutated data back:

- `src/pages/ScheduleAppointment/components/Scheduled/Scheduled.jsx:15-17` — mounted only after `ScheduleAppointment.jsx:128` sets `scheduled=true` **following** `await callEndpoint(createSession(...))` (confirmed at `ScheduleAppointment.jsx:113-128`); its `useEffect(() => { refreshSessions(); }, [])` is meant to pull the just-booked session into the list.
- `src/pages/RescheduleAppointment/components/Scheduled/Scheduled.jsx:15-19` — same shape, post-reschedule confirmation screen.
- `src/pages/ScheduleAlignmentSession/components/Scheduled/Scheduled.jsx:15-29` — same shape, post-alignment-booking confirmation screen.
- `src/pages/CoacheeCalendar/components/Scheduled/Scheduled.jsx:20-56` — same shape.
- `src/pages/MySessions/components/SessionAlignment_item/SessionAlignment_item.tsx:33-45` — `cancelMySession()` calls `callEndpoint(cancelAlignmentSession(...))` then `await refreshSessions()` (line 45) expecting the cancellation to be reflected.

With the design's own assumed `staleTime` for `sessions` ("10-30s, mutated often via booking/cancel flows across many pages" — design doc, Open questions, lines 256-260), any of these confirmation screens rendered within that window of a prior `sessions` fetch (e.g. the user browsed Home or a calendar right before booking) would silently serve the **pre-mutation** cached list — the freshly booked/cancelled session would not appear, exactly the class of bug the design flags but scopes to a single call site.

**Severity: CONCERN**, not a blocker for Approach B's architecture — it's fixable by broadening the forced-invalidate treatment (or, more simply, giving the `sessions` key `staleTime: 0` so `fetchQuery` always issues a fresh request and react-query's request-collapsing does the "4→1 concurrent dedupe" job on its own, which is the actual stated win — see the Note under point 7). But as written, the design under-scopes a real, user-visible risk to one of ~6 affected sites.

---

## CONCERN 4 — `getUserWorkingHours`'s "component-local state, no Redux entanglement" framing is inaccurate for 2 of its 3 call sites, and its 3rd site has the same imperative-multi-caller topology used to justify the `sessions` bridge

**Claim:** design doc classifies `getFocusAreas`/`getMyCoacheesById`/`getUserWorkingHours` uniformly as "component-local reads... each caller stores the response in its own `useState`, no Redux involvement... idiomatic `useQuery` hooks directly" (lines 22-25, 102-104), and lists exactly 3 call sites for `getUserWorkingHours`: `useCoachCalendar.ts:21`, `CoachCalendar.jsx:42`, `WorkingHours.jsx:84` (design doc "Migration & compatibility," lines 210-214), claiming "4 call sites change... no other file is touched" (line 172).

**Found:**

1. `src/pages/CoachCalendar/CoachCalendar.jsx:39-44` — `getWorkingHours(id)` calls `getUserWorkingHours(id)` then `updateWorkingUI(data.data)` (line 44) — **not** local `useState`, but a write into `CoachCalendarContext` (`src/pages/CoachCalendar/context/CoachCalendarContext.js`), a React Context shared with its child `WorkingHours.jsx`.
2. `src/pages/CoachCalendar/Components/WorkingHours/WorkingHours.jsx:83-86` — its own `getWorkingHours(id)` also calls `getUserWorkingHours(id)` then `updateWorkingUI(data.data)`, and separately seeds its **local edit buffer** from that same context: `WorkingHours.jsx:26` `const [schedules, setSchedules] = useState(contextSchedules);`.
3. `src/pages/CoachCalendar/context/CoachCalendarContextWrapper.jsx:61-73` confirms `updateWorkingUI` mutates the single shared `schedules` state consumed by both components.

So 2 of the 3 call sites are cross-component-entangled through Context (not Redux, but still shared mutable state the design's "component-local, no entanglement" framing misses). Converting `CoachCalendar.jsx` and `WorkingHours.jsx` to two independent `useQuery(['workingHours', mongoID])` calls without also re-plumbing the `CoachCalendarContext` handoff risks `WorkingHours.jsx`'s edit buffer (`useState(contextSchedules)`) seeding from stale/empty context if `CoachCalendar.jsx` stops calling `updateWorkingUI`.

4. The 3rd call site, `src/hooks/useCoachCalendar.ts:13-64`, is an **imperative-trigger hook** (`getCoachCalendar()` called from a `useEffect` by its consumers, e.g. `src/pages/ScheduleAppointment/ScheduleAppointment.jsx:25,34`) — the exact same "imperative trigger, not render-time read" shape the design uses to justify the bridge/facade Approach B for `sessions` (design doc "Approach C" tradeoff, lines 111-116). This hook is reused by **5 different page components** with a per-call, non-`state.user` argument (`coach._id`, the coach being booked, not the logged-in user): `ScheduleAlignmentSession.jsx:30`, `ScheduleAppointment.jsx:25`, `RescheduleAppointment.jsx:33`, `CoacheeCalendar.jsx:33`, `ViewCoachCalendar.jsx:18`. Converting `useCoachCalendar.ts:21` to a literal `useQuery` (rather than the same kind of facade used for `refreshSessions`) changes its consumers from "call `getCoachCalendar()` when I decide to" to "refetch declaratively on key change," a real behavior change across all 5 consumers that "no other file is touched" doesn't account for.

**Severity: CONCERN.** Fixable — apply the same bridge/facade pattern already chosen for `sessions` to `useCoachCalendar.ts` and reconcile the `CoachCalendarContext` handoff for `CoachCalendar.jsx`/`WorkingHours.jsx` — but the design's blanket "these three are the clean, ticket-literal case" statement is wrong for `getUserWorkingHours` specifically, and needs a design update, not just an implementation detail.

---

## NOTE 5 — `queryKey` design: no cross-real-user collision, but no cache cleanup on in-tab user switch

Verified `useUserUtilities` (`src/hooks/useUserUtilities.ts:18-19`) takes **no parameters** — `const useUserUtilities = () => { const user = useSelector((state) => state.user); ... }` — and always reads the single global `state.user`. Several call sites pass an argument (`useUserUtilities(user)` — e.g. `src/pages/ScheduleAlignmentSession/components/Scheduled/Scheduled.jsx:15`, `src/pages/MySessions/MySessions.jsx:362`) that the hook signature silently ignores (pre-existing dead parameter, not introduced by this design). So two hook instances can never see two different `user.mongoID` values simultaneously — **no same-render-tree collision risk** for the `sessions` queryKey (answers design open question implicitly, confirms no BLOCKER here).

Residual, narrower risk: `App.tsx:288-289` subscribes to Firebase's `onAuthStateChanged` directly on the SPA root, meaning a **different user can log in after a logout within the same tab, with no full page reload** (shared-device scenario). The design's migration plan (mount `QueryClientProvider` once in `src/index.tsx`) doesn't call `queryClient.clear()`/`cancelQueries()` on `resetUser()`/logout. Since keys are namespaced by `mongoID`, this can't leak one real user's session data into another's key — but a slow in-flight `fetchQuery` for the previous user's key resolving after logout is unhandled, and cache entries accumulate across in-tab user switches until `gcTime` expires. Low risk, not a blocker, but worth a line in "Migration & compatibility."

**Severity: NOTE.**

---

## NOTE 6 — No component mounts `useUserUtilities()` with a genuinely different user in context (answers Q6); but `getUserWorkingHours`'s key must be keyed by the endpoint argument, not `state.user.mongoID`

As established in Note 5, `useUserUtilities`/`refreshSessions` structurally cannot see two different users at once — so the scenario the question poses ("admin viewing another user's sessions") does not exist for `sessions`. It **does** exist for `getUserWorkingHours`: via `useCoachCalendar(coach._id)`, the endpoint is called with an arbitrary **other** coach's ID in booking flows (`ScheduleAppointment.jsx`, `RescheduleAppointment.jsx`, `ScheduleAlignmentSession.jsx`, `CoacheeCalendar.jsx`, `ViewCoachCalendar.jsx` — see Concern 4). The design's stated key, `['workingHours', userId]` (design doc line 175), is correct **only if** `userId` means "whatever ID the endpoint call was actually given" — it must not be read as "the logged-in user's `mongoID`," or two coaches' working hours would collide. The design doc doesn't disambiguate this explicitly.

**Severity: NOTE** (the design's key shape is fine as long as this is implemented correctly; flagging because the doc's wording is ambiguous enough to be implemented wrong).

---

## NOTE 7 — Approach comparison (Q7): minor weighting gap, mooted by Blocker 1

The "Chosen over A" argument (design doc lines 154-156) treats all four endpoints as equally suffering from the "duplicate concurrent calls" problem that justifies a shared caching library over 4x hand-rolled caches. Before Blocker 1, `getMyCoacheesById` had exactly **one** call site (`MyCoachees.tsx:40`) — no concurrent-duplicate-call problem exists there to dedupe; the only benefit would have been cross-navigation staleness caching, a materially weaker justification than the `sessions` 13-call-site/4-simultaneous-mounts case. After Blocker 1 this is moot (that call site is dead code), but it's worth noting for whatever endpoint replaces it in a corrected scope (the live `CoacheeStatus.jsx` `refreshUser()`/`coachees` path). No genuinely missing alternative library (SWR, etc.) was found to matter here — bundle size isn't the ticket's concern, so that omission is immaterial.

**Severity: NOTE.**

---

## Verdict

**El diseño necesita rediseño en el alcance de `getMyCoacheesById`/`MyCoachees` (Blocker 1: el "dead code" que descarta está invertido — `MyCoachees.jsx`/`CoacheeStatus.jsx` son el código vivo, confirmado en el bundle de `dist/`; el endpoint que el diseño migra a `useQuery` no es el que alimenta la UI real, y el bug de "2 getUser simultáneos" que el propio ticket cita queda sin resolver) y en el tratamiento de `getUserWorkingHours` (Concern 4: 2 de 3 call sites comparten `CoachCalendarContext`, no son estado local, y `useCoachCalendar.ts` tiene la misma topología imperativa multi-consumidor que justificó el bridge de `sessions`) — el bridge de Approach B para `sessions` en sí (el núcleo del diseño) se sostiene, pero necesita ampliar el forced-invalidation a más de los 13 call sites (Concern 3) antes de implementarse.**
