---
name: react-native-reusables
description: Use when adding or editing UI components in an Expo app built on React Native Reusables (shadcn/ui for React Native) — the add/doctor CLI, the owned copies in components/ui, overlays and PortalHost, Text and Icon rules. Not for class/token styling (see uniwind).
metadata:
  type: reference
---

# React Native Reusables — owned UI components

React Native Reusables (RNR) copies component source into `components/ui/`; the repo owns and edits it. Runtime dependencies are only the `@rn-primitives/*` packages (a React Native port of Radix), `lucide-react-native`, Reanimated, and the `cn()` utils. The CLI needs `components.json` and the `@/*` path alias.

## The pattern

```bash
npx @react-native-reusables/cli add button dialog select   # copy into components/ui/
npx @react-native-reusables/cli doctor                     # diagnose the setup
```

```tsx
<Button variant="outline">
  <Icon as={PlusIcon} className="size-4" />
  <Text>New session</Text>
</Button>
```

Screens compose owned components; components take values from tokens through `cn()` and `class-variance-authority` variants.

## Gotchas that bite

- **Text doesn't inherit.** Every string goes in RNR's `<Text>`; a parent passes classes down through `TextClassContext`. Headings use `<Text variant="h1">`…`"muted"`.
- **Overlays need `<PortalHost />`** as the last child inside your providers in the root layout. Without it Dialog, AlertDialog, Select, Popover, DropdownMenu, ContextMenu, HoverCard, Menubar, and Tooltip open into nothing.
- **DropdownMenu, Popover, and Select open and close through a trigger ref** (`triggerRef.current?.open()`); `onOpenChange` on the root only listens. Dialog is controlled with `open` / `onOpenChange`.
- **No `data-*` attributes on native.** Variants come from props and state — don't paste `data-[state=open]:` selectors from shadcn web.
- **`add --overwrite` replaces your copy.** Commit first, overwrite, then re-apply local edits from the diff.
- **Themes pasted from shadcn** must be the Tailwind 3 version, with `.dark` rewritten to `.dark:root`.
- **The theme lives in CSS and in `lib/theme.ts`.** `THEME` / `NAV_THEME` mirror the CSS variables for navigation colors; change both together.
- **NativeWind setups need `inlineRem: 16`** in `withNativeWind`; `doctor` flags it.
- A scrollable `Select` needs `react-native-gesture-handler` and `NativeSelectScrollView`.

## Rules for this component kit

1. A component RNR provides is added with the CLI, not hand-rolled.
2. Screens don't use `Pressable` / `TextInput` directly for a standard control; extend or add a component in `components/ui/`.
3. A UI pattern used in two or more screens becomes an owned component in `components/ui/`.

## Before declaring done

Copy and check off:

- [ ] No standard control is built from raw `Pressable` / `TextInput` outside `components/ui/` — search the screens roots declared below (default `app/`). A root that doesn't exist is an error, not a pass.
- [ ] Any overlay touched was opened on a device or simulator, not only typechecked.
- [ ] `npx @react-native-reusables/cli doctor` reports no issues.
- [ ] `{{qualityGate.fast}}` green.

If any item fails, fix it and re-run the whole list.

<!-- navori:user-section -->
## This repo's component kit (your domain)

<!-- user: add here what only applies to THIS repo. Suggestions:
     - Screens root(s) to scan (e.g. `app/`, `features/`).
     - Styling library in use (NativeWind or Uniwind).
     - Owned composites beyond RNR (ListRow, EmptyState…) and when to use each.
     - Local edits made to RNR components, so `add --overwrite` doesn't erase them.
-->
