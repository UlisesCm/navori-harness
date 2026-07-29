## Stack — React Native + Expo

Mobile app with Expo (current SDK) + React Native. Navigation with `expo-router`/`native-stack`; styling and native layers via `expo-*` (no bare equivalents). The heavy work —lists, animations, gestures— runs on the **UI thread**, not the JS thread.

Golden rule: every render of a list or screen crosses the JS↔native bridge. Keep references stable and keep work out of the render. Apply `rn-performance` for lists/animations/re-renders and `expo-runtime` for safe-area, keyboard, edge-to-edge and EAS/prebuild.
