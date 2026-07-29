---
name: expo-runtime
description: Use when laying out screens, touching native config (app.config/plugins), or configuring builds in Expo — runtime: safe areas, keyboard, edge-to-edge, prebuild, and EAS.
type: reference
---

# Expo — native runtime

Native config is declared, not hand-edited. Screens respect the device's safe areas, not hardcoded values.

## Safe areas

- **`react-native-safe-area-context`** with `useSafeAreaInsets()`. Never hardcode `paddingTop: 44`. Centralize in a `Screen` component instead of rolling your own `SafeAreaView` per screen.
- **Asymmetric insets per platform:** on Android respect `bottom` (the gesture bar), on iOS the OS handles it → typically `["top","bottom"]` on Android, `["top"]` on iOS.
- On a root scroll, `contentInsetAdjustmentBehavior="automatic"` lets iOS handle insets natively (content behind the status bar).

## Keyboard

- **`behavior` per platform:** `KeyboardAvoidingView behavior={isIos ? "padding" : "height"}`.
- With **`react-native-keyboard-controller`** (`KeyboardAwareScrollView`), do NOT also wrap it in `KeyboardAvoidingView` — double offset. One mechanism per screen.

## Edge-to-edge (Android 15+)

- `edgeToEdgeEnabled: true` + **`react-native-edge-to-edge`**. Style the bars with its `SystemBars`, NOT with `expo-status-bar` when edge-to-edge is active.

## Native config: declare, don't edit

- **Prebuild** (`ios/` committed, `android/` generated) or managed. Either way **don't edit `ios/`/`android/`, `Info.plist`, or `AndroidManifest.xml` by hand** — they get regenerated. Change via `app.json`/`app.config.ts` or a config plugin in `plugins/`.
- After touching `app.config`/plugins, run `expo prebuild --clean` (or the repo's script).
- Permissions: `ios.infoPlist` / `android.permissions`, or let the module's plugin (`expo-image-picker`, `expo-location`) inject its purpose string — don't duplicate it.
- Install native layers with **`expo install`** (pins the SDK version); `expo install --fix` re-pins. Prefer `expo-*` modules over bare equivalents.

## EAS and env

- Profiles in `eas.json` (`development`, `preview`, `production`). Env vars required by native builds go in each profile.
- **Runtime:** `process.env.EXPO_PUBLIC_*` for public values; secrets (`google-services.json`, APNs `.p8`) via **EAS secrets**, never committed.

## Build gotcha

- **Reanimated/Worklets:** `react-native-worklets/plugin` must be the **last** plugin in `babel.config.js`.

## Before calling it done

- Insets via `useSafeAreaInsets`, not fixed values; one keyboard mechanism per screen.
- Native changes via `app.config`/plugin (not in `ios/`/`android/`); `expo prebuild --clean` run if you touched config.
- No secret committed. `{{qualityGate.fast}}` green.
