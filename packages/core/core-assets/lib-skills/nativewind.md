---
name: nativewind
description: Use when styling React Native with className, editing global.css or tailwind.config.js tokens, wiring babel/Metro for NativeWind, or when a class renders unstyled with no error. Applies to repos that already chose NativeWind — it does not replace their styling with inline styles. Not for component APIs (see the component kit's skill).
metadata:
  type: reference
---

# NativeWind — Tailwind classes on React Native

Written for NativeWind 4 (Tailwind 3). Check the `nativewind` major in `package.json` first: v5 removes the babel preset, renames `withNativeWind` to `withNativewind`, moves config into Tailwind 4 CSS, and replaces `cssInterop` with `styled` — follow its migration docs instead of the wiring below.

Its failure mode is silence: a class that doesn't compile, or a token that doesn't resolve, renders an unstyled view with no warning while typecheck and tests pass.

## Wiring (v4 + Expo)

- `babel.config.js` `presets` (not `plugins`) holds both `["babel-preset-expo", { jsxImportSource: "nativewind" }]` and `"nativewind/babel"`.
- `tailwind.config.js`: `presets: [require("nativewind/preset")]` and `content` globs covering every folder that holds a `className`.
- Metro: `withNativeWind(config, { input: "./global.css" })`; `global.css` imported once in the root layout; types in `nativewind-env.d.ts`.

## Gotchas that bite

- **Tokens resolve or paint nothing.** Every `var(--x)` referenced in `tailwind.config.js` must be defined in `global.css` for each theme (light and dark). A missing one still typechecks.
- **A folder outside `content` gets no styles** — add new roots (`features/`, `packages/ui`) to the globs.
- **Color doesn't cascade from `View` to `Text`.** Put text color on the `Text` itself.
- **State variants work on native.** `active:`, `focus:`, and `hover:` map to `onPressIn`, `onFocus`, and `onHoverIn` on components that emit them (`Pressable`, `TextInput`). Platform variants: `ios:`, `android:`, `native:`, `web:`.
- **Dark mode:** the default `darkMode` is `"media"`; `setColorScheme` / `toggleColorScheme` from `nativewind`'s `useColorScheme` throw unless it's `"class"`.
- **`cssInterop` / `remapProps` are for third-party components only** and cost performance; your own components pass `className` through.
- **Animation classes (`animate-*`, `transition-*`) are experimental in v4.** For anything that matters, animate with Reanimated on the `style` prop.
- **Keep one token system.** If a JS mirror of the tokens exists (a navigation theme), update it in the same change — never start a second theme system beside `global.css`.

## Debugging "the class does nothing"

1. `npx expo start --clear`.
2. `npx tailwindcss --input global.css --output output.css` — is the class in the output?
3. Call `verifyInstallation()` from `nativewind` inside a component.
4. `DEBUG=nativewind npx expo start` for the compiler log.

## Before declaring done

Copy and check off:

- [ ] Every `var(--…)` in `tailwind.config.js` exists in `global.css` for each theme.
- [ ] New folders are in `content`; no hex colors or ad-hoc arbitrary values where a token exists.
- [ ] `npx expo export --clear` succeeds after any babel/Metro/Tailwind config change.
- [ ] The screen was looked at in light and dark — these failures only show on screen.
- [ ] `{{qualityGate.fast}}` green.

If any item fails, fix it and re-run the whole list.

<!-- navori:user-section -->
## This repo's tokens (your domain)

<!-- user: add here what only applies to THIS repo. Suggestions:
     - The token set and where its JS mirror lives, if any.
     - Brand fonts and how they are loaded.
     - Third-party components already wrapped with cssInterop.
-->
