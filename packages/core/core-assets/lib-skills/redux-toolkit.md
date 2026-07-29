---
name: redux-toolkit
description: Use when touching global state, slices, or the store — Redux Toolkit patterns in React+TS: slices, typed store, typed hooks, async thunks, selectors.
type: reference
---

# Redux Toolkit — conventions

## When to use this skill

When creating or touching a slice, the store, async thunks, or reading/writing global state. RTK is the standard — no bare `createStore`, hand-written action types, or `connect`. Server state (fetch/cache) does NOT go here: that's TanStack Query. Redux is for shared client state (session, cross-page UI, cart).

## The pattern

```ts
const slice = createSlice({
  name: 'session',
  initialState,
  reducers: {
    setActive(state, action: PayloadAction<Session>) {
      state.active = action.payload; // Immer: you "mutate" a draft, not the real state
    },
  },
  extraReducers: (b) => {
    b.addCase(loadSession.fulfilled, (s, a) => { s.active = a.payload; });
  },
});
export const { setActive } = slice.actions;
```

Store + typed hooks once, then used across the whole app:

```ts
export const useAppDispatch = useDispatch.withTypes<AppDispatch>();     // current pattern (RTK 2 / react-redux 9)
export const useAppSelector = useSelector.withTypes<RootState>();       // not the old TypedUseSelectorHook
```

## Gotchas that bite

- **Immer only inside `createSlice`.** There you "mutate" the draft; outside a reducer, mutating the state is a bug. Don't both return AND mutate in the same reducer.
- **Memoized selectors** with `createSelector` when they derive/transform — a selector that creates a new array/object on every call always re-renders.
- **`useSelector` returns the reference**: select the minimum, not the whole slice. If you need several fields, wrap with `useShallow(...)` (react-redux 9) for a shallow compare and avoid extra re-renders.
- **Reactive effects → `createListenerMiddleware`**, not a `useEffect` spying on the store or sagas. React to an action/state change from the middleware.
- **Collections by id → `createEntityAdapter`**: `selectAll`/`selectById` memoized for free, normalized CRUD, no hand-written arrays.
- **Async**: `createAsyncThunk` when simple; if it's API data you cache/invalidate, evaluate RTK Query. `extraReducers` with the builder callback (`(b) => b.addCase(...)`), the object form was removed in RTK 2.
- **Non-serializables** (Date, Map, functions) out of the store; they break devtools and persistence.

## Hard rules

1. Global state only via RTK slices; no improvised Context for the same thing.
2. Typed `useAppDispatch`/`useAppSelector` hooks, never the raw untyped ones.
3. Select the minimum and memoize derived values with `createSelector`.
4. Server state doesn't live in Redux — that's query cache.
5. Only serializable values in the store.

## Before declaring done

- The new slice exposes typed actions and is consumed with the typed hooks.
- Derived selectors are memoized; components select the minimum.
- No API data duplicated in the store if there's already a query layer.
- `{{qualityGate.fast}}` green.
