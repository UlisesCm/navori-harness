---
name: expo-runtime
description: Runtime de Expo — safe areas, teclado, edge-to-edge, prebuild y EAS. Aplica al maquetar pantallas, tocar config nativa (app.config/plugins) o configurar builds.
type: reference
---

# Expo — runtime nativo

La config nativa se declara, no se edita a mano. Las pantallas respetan las zonas seguras del dispositivo, no valores hardcodeados.

## Safe areas

- **`react-native-safe-area-context`** con `useSafeAreaInsets()`. Nunca hardcodees `paddingTop: 44`. Centraliza en un componente `Screen` en vez de rodar tu propio `SafeAreaView` por pantalla.
- **Insets asimétricos por plataforma:** en Android respeta `bottom` (barra de gestos), en iOS lo maneja el OS → típico `["top","bottom"]` en Android, `["top"]` en iOS.
- En un scroll raíz, `contentInsetAdjustmentBehavior="automatic"` deja que iOS maneje los insets nativamente (contenido detrás del status bar).

## Teclado

- **`behavior` por plataforma:** `KeyboardAvoidingView behavior={isIos ? "padding" : "height"}`.
- Con **`react-native-keyboard-controller`** (`KeyboardAwareScrollView`), NO lo envuelvas además en `KeyboardAvoidingView` — doble offset. Un solo mecanismo por pantalla.

## Edge-to-edge (Android 15+)

- `edgeToEdgeEnabled: true` + **`react-native-edge-to-edge`**. Estila las barras con su `SystemBars`, NO con `expo-status-bar` cuando edge-to-edge está activo.

## Config nativa: declarar, no editar

- **Prebuild** (`ios/` commiteado, `android/` generado) o managed. En cualquier caso **no edites `ios/`/`android/`, `Info.plist` ni `AndroidManifest.xml` a mano** — se regeneran. Cambia vía `app.json`/`app.config.ts` o un config plugin en `plugins/`.
- Tras tocar `app.config`/plugins, corre `expo prebuild --clean` (o el script del repo).
- Permisos: `ios.infoPlist` / `android.permissions`, o deja que el plugin del módulo (`expo-image-picker`, `expo-location`) inyecte su purpose string — no lo dupliques.
- Instala capas nativas con **`expo install`** (pinea la versión del SDK); `expo install --fix` re-pinea. Prefiere módulos `expo-*` sobre equivalentes bare.

## EAS y env

- Perfiles en `eas.json` (`development`, `preview`, `production`). Las env vars requeridas por builds nativos van en cada perfil.
- **Runtime:** `process.env.EXPO_PUBLIC_*` para lo público; secrets (`google-services.json`, APNs `.p8`) por **EAS secrets**, nunca commiteados.

## Gotcha de build

- **Reanimated/Worklets:** `react-native-worklets/plugin` debe ser el **último** plugin de `babel.config.js`.

## Antes de declarar listo

- Insets vía `useSafeAreaInsets`, no valores fijos; un solo mecanismo de teclado por pantalla.
- Cambios nativos vía `app.config`/plugin (no en `ios/`/`android/`); `expo prebuild --clean` corrido si tocaste config.
- Ningún secret commiteado. `{{qualityGate.fast}}` en verde.
