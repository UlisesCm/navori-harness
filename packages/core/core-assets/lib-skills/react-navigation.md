---
name: react-navigation
description: Use when adding a screen or navigating in React Native — typed routes (ParamList), serializable params, useFocusEffect, and deep linking.
type: reference
---

# React Navigation — conventions

## When to use this skill

When registering a screen, navigating with params, or reacting to a screen coming into focus. Navigation is the classic source of implicit `any`: without the declared `ParamList`, `route.params` is untyped and every typo shows up at runtime.

## The pattern

One `ParamList` per navigator, registered globally so `useNavigation` is typed everywhere:

```ts
export type RootStackParamList = {
  Home: undefined;
  SessionDetail: { sessionId: string };
};

declare global {
  namespace ReactNavigation {
    interface RootParamList extends RootStackParamList {}
  }
}

// Typed screen: params and navigation come from the ParamList, no casts.
type Props = NativeStackScreenProps<RootStackParamList, "SessionDetail">;

export function SessionDetail({ route, navigation }: Props): JSX.Element {
  const { sessionId } = route.params;
  …
}
```

## Gotchas that bite

- **Without the `declare global` registration, `useNavigation()` is untyped.** `navigate("Typo", …)` compiles and blows up at runtime. Registering the ParamList is what turns navigation into a checked API.
- **Params must be SERIALIZABLE.** Passing an object with functions, a Date, or a whole entity breaks state persistence and deep linking. Pass the id and read the entity from the store/cache in the screen.
- **`useEffect` does not re-run when the screen regains focus.** In a stack the screen stays mounted underneath: coming back does NOT remount it. Use `useFocusEffect` (with `useCallback`) for what must refresh on return.
- **`navigate` vs `push`.** `navigate` reuses the existing screen if it's already in the stack (params change, no new entry); `push` always adds one. Navigating to the same screen with a different id and seeing no change is this.
- **Nested navigators need the nested form.** `navigate("Tabs", { screen: "Profile", params: … })` — passing the inner route directly only works by accident.
- **The header is configured per screen, not with a component inside it.** `navigation.setOptions` in an effect, or `options` at registration.
- **Deep linking has to be declared.** A screen without a `linking` entry is unreachable from a URL/notification, even though it works in-app.

## Hard rules

1. Every navigator declares its `ParamList`, and the root one is registered via `declare global`.
2. Params: primitives and ids only — never entities, functions, or Dates.
3. What must refresh on return goes in `useFocusEffect`, not `useEffect`.
4. Navigation typed with `NativeStackScreenProps` (or its equivalent) — no `any` on `route`/`navigation`.
5. A new screen reachable from outside is registered in the `linking` config.

## Before declaring done

- Navigating with a typo in the route name fails to compile.
- Going back to the screen shows fresh data.
- The params carry no non-serializable objects.
- `{{qualityGate.fast}}` green.

<!-- navori:user-section -->
## This repo's navigation (your domain)

<!-- user: add here what only applies to THIS repo. Suggestions:
     - The navigator map: which stacks/tabs exist and how they nest.
     - Where the ParamList types live and how a new screen is registered.
     - Deep links / URL scheme and which screens are reachable from outside.
     - Screens gated by auth and where the redirect lands.
-->
