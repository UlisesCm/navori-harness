---
name: zustand
description: Use when creating a store, reading state in a component, or moving shared state out of Context — global state with Zustand v5: selectors to avoid re-renders, actions in the store, slices.
type: reference
---

# Zustand — the canonical pattern

One store with state and actions together; components subscribe with a **selector**, not to the whole store. That way they only re-render when what they read changes.

## When to use this skill

When creating a store, reading state in a component, or moving frequently-changing shared/mutable state out of Context (which re-renders the whole Provider tree).

## The pattern

```ts
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

const useUserStore = create<UserStore>((set) => ({
  user: null,
  loading: false,
  fetchUser: async (id) => {
    set({ loading: true });
    try {
      const user = await api.getUser(id);
      set({ user, loading: false });
    } catch {
      set({ error: "fetch failed", loading: false });
    }
  },
}));

const name = useUserStore((s) => s.user?.name);            // one field → no extra re-render
const { user, loading } = useUserStore(                    // several fields → useShallow
  useShallow((s) => ({ user: s.user, loading: s.loading })),
);
```

## Hard rules

1. **Always a selector.** `const s = useStore()` (no selector) re-renders on any store change. Select the field you use.
2. **Several fields → `useShallow`.** Returning a new object/array without `useShallow` re-renders on every render due to a new identity.
3. **Actions inside the store**, not in the component; use `set((state) => ...)` when the update depends on the current value.
4. **Async state with its `loading`/`error` in the store**, not loose in the component.
5. **No single giant global store.** Split by domain (user, cart, settings) with the **slices pattern**: each slice is a factory `(set) => ({...})` and the store is composed by spread; the type is the intersection.
6. Outside React: `useStore.getState()` / `setState()` / `subscribe()` — no hooks.

```ts
const useStore = create<UserSlice & CartSlice>()((...a) => ({
  ...createUserSlice(...a),
  ...createCartSlice(...a),
}));
```

## Middlewares

`persist` (hydrate from storage, with `name`), `immer` (nested updates by "directly" mutating), `devtools` (`{ name }`). They nest by wrapping the creator.

## Zustand vs Context

Context is for **stable** injection (theme, config, i18n). For shared state that changes often, Zustand — it avoids the massive Provider re-render.

## Before declaring done

- Every component reads with a selector; multi-field with `useShallow`.
- Actions and async state (with loading/error) live in the store.
- Stores split by domain; no global mega-store.
- `{{qualityGate.fast}}` green.
