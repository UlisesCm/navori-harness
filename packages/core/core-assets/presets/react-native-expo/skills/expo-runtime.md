---
name: expo-runtime
description: Use when laying out screens (safe areas, keyboard, system bars), editing app.config or config plugins, adding a native dependency, or configuring prebuild and EAS builds in Expo. Covers the runtime and build rules that typecheck never exercises. Not for styling (see the styling library's skill) or list/animation performance (see rn-performance).
metadata:
  type: reference
---

# Expo — native runtime and build

Read the `expo` major in `package.json` first and use that SDK's docs (`docs.expo.dev/versions/v<major>.0.0/`), not memory — defaults change between SDKs. For UI and animation depth, prefer Expo's official skills (`expo-native-ui`, `expo-animation`, `expo-upgrade`).

## Safe areas and system bars

- Insets come from `react-native-safe-area-context` (`useSafeAreaInsets` or its `SafeAreaView`), never hardcoded values — top and bottom on both platforms.
- On a root scroll view, `contentInsetAdjustmentBehavior="automatic"` lets iOS inset the content natively; native tabs and stack headers handle their own insets.
- Since SDK 54, Android is always edge-to-edge and it can't be turned off: content draws behind the system bars, so insets are mandatory. Style the bars with `expo-status-bar` and `expo-navigation-bar`.

## Keyboard

- Built-in: `KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}` — Android resizes on its own.
- With `react-native-keyboard-controller`: a `KeyboardProvider` at the root, and one mechanism per screen — don't nest its `KeyboardAwareScrollView` inside `KeyboardAvoidingView`.

## Native config and CNG

- **Without `ios/`/`android/` in git (CNG):** they are generated — never create or edit them. Change native config in `app.json`/`app.config.ts` or a config plugin; prebuild runs at build time.
- **With hand-maintained native folders:** don't run `expo prebuild --clean` — it regenerates and overwrites them. Edit native files directly and keep app config in sync.
- Install native modules with `npx expo install` (pins SDK-compatible versions). A native module or config plugin not in Expo Go requires a development build (`npx expo run:ios|android` or an EAS development profile).

## EAS and environment

- Each `eas.json` build profile sets its `environment`; values live in EAS environment variables (visibility plain text, sensitive, or secret), pulled locally with `eas env:pull`. `.env*` files stay out of git.
- `EXPO_PUBLIC_*` values are inlined into the bundle and public — only with dot access (`process.env.EXPO_PUBLIC_API_URL`). Never put a secret there.
- Signing material (APNs keys, keystores) is managed with `eas credentials`.

## Build gotchas

- **Typecheck never runs babel or Metro.** A broken `babel.config.js`/`metro.config.js`, or an import Metro can't resolve, typechecks green. Only a bundle proves the pipeline: `npx expo export --clear` (all platforms — `-p ios` skips `.android.tsx`).
- **`babel-preset-expo` already adds the Reanimated/worklets plugin** — don't add it by hand. A plugin listed in `babel.config.js` must be installed in the same change.
- **Don't gate a critical control behind an `entering` animation.** Some Reanimated releases stalled entering animations at startup, leaving the view at opacity 0 — animate decoration, not the button the user needs.

## Before calling it done

Copy and check off:

- [ ] Insets from safe-area context, top and bottom; one keyboard mechanism per screen.
- [ ] Native changes follow the repo's CNG choice.
- [ ] `npx expo install --check` and `npx expo-doctor` pass.
- [ ] Touched babel, Metro, or dependencies → `npx expo export --clear` succeeds.
- [ ] No secret in `EXPO_PUBLIC_*` or in git. `{{qualityGate.fast}}` green.

If any item fails, fix it and re-run the whole list.

<!-- navori:user-section -->
## This repo's native setup (your domain)

<!-- user: add here what only applies to THIS repo. Suggestions:
     - CNG or committed native folders, and which platforms.
     - EAS profiles and their environments.
     - Native modules that require a development build.
-->
