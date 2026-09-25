---
name: uniwind
description: Use when styling React Native with className via Uniwind, editing @theme tokens in the CSS entry file, wiring withUniwindConfig for Metro, wrapping a third-party component that doesn't forward className, or switching themes at runtime. Applies to repos that already chose Uniwind — it does not replace their styling with inline styles. Not for Tailwind on the web (see tailwind-v4) or NativeWind (a different library, its own babel preset and tailwind.config.js).
metadata:
  type: reference
---

# Uniwind — Tailwind 4 bindings for React Native

Written for Uniwind 1.12 (Tailwind 4 peer). Check the `uniwind` version in `package.json` first; a major bump can change the wiring below — follow its migration docs instead of guessing.

Its failure mode is silence: a class Uniwind can't statically resolve at build time renders an unstyled view with no warning, while typecheck and tests pass.

## Wiring (Expo/Metro)

- `metro.config.js` wraps the default config with `withUniwindConfig` from `uniwind/metro`, passing `cssEntryFile` (e.g. `./src/global.css`) and `dtsFile` (e.g. `./uniwind-env.d.ts`). Import the CSS entry once, in the root layout.
- Generated types come from the `uniwind generate-artifacts --css <entry> --dts <dts>` CLI; wire it as a `uniwind:types` script and run it before `tsc` — that `.d.ts` backs `className` typing.
- No babel preset, no `tailwind.config.js`. Unlike NativeWind, tokens and config live entirely in the CSS entry file (Tailwind 4 CSS-first: `@theme`, `@layer`, `@custom-variant`).

## Tokens and dark mode

Tokens are plain Tailwind 4 `@theme` custom properties. Uniwind's build-time extractor only recognizes per-theme overrides in one exact shape: a `:root` rule nested inside `@layer theme`, with the dark override nested as `&:where(.dark, .dark *) { ... }` — never a sibling top-level `.dark { ... }` rule, invisible to the extractor. Keep every themed token inside that single `@layer theme { :root { ...; &:where(.dark, .dark *) { ... } } }` block.

## Gotchas that bite

- **`className` does nothing on a third-party component.** Components that don't forward `className`/`style` as their own prop (e.g. `SafeAreaView`) need `withUniwind(Component)` (auto) or `withUniwind(Component, options)` (manual mapping for non-standard props), from `uniwind`'s root export.
- **Dark-mode override nested, never sibling** — the #1 cause of "dark mode looks light on mobile only."
- **`Uniwind.setTheme('light' | 'dark' | 'system')`** switches theme imperatively; `useUniwind()` reads/reacts to it inside a component (e.g. syncing a navigation `ThemeProvider`).
- **`useCSSVariable`/`useResolveClassNames`** resolve a token/classes to a style object for values consumed outside `className` (an SVG fill) — not a substitute for `className` on regular views.
- **A class with no static reference is dead.** Only names literally written as `className="..."` compile in — no runtime string concatenation into a class.
- **One token system.** A JS mirror elsewhere (a navigation theme) derives from the same CSS entry — never a second theme source.

## Debugging "the class does nothing"

1. Rerun `uniwind:types` and restart Metro with `--clear`.
2. Confirm the class exists in the CSS entry's `@theme`/utility set.
3. For a wrapped component, confirm it renders through `withUniwind`, not the raw import.

## Before declaring done

Copy and check off:

- [ ] Every themed token lives in one `@layer theme { :root { ...; &:where(.dark, .dark *) {...} } }` block — no sibling `.dark {}` rule.
- [ ] Third-party components that don't forward `className` are wrapped with `withUniwind`.
- [ ] Generated types (`uniwind:types`) are re-run after any CSS entry change.
- [ ] The screen was looked at in light and dark — these failures only show on screen.
- [ ] `{{qualityGate.fast}}` green.

If any item fails, fix it and re-run the whole list.

<!-- navori:user-section -->
## This repo's tokens (your domain)

<!-- user: add here what only applies to THIS repo. Suggestions:
     - The CSS entry file path and where its token set is shared with web (if any).
     - Third-party components already wrapped with withUniwind.
     - How theme preference is persisted and synced with expo-router's ThemeProvider.
-->
