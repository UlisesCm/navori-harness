## Stack — React Native + Expo

App móvil con Expo (SDK actual) + React Native. Navegación con `expo-router`/`native-stack`; estilos y capas nativas por `expo-*` (no equivalentes bare). El trabajo pesado —listas, animaciones, gestos— corre en el **UI thread**, no en el JS thread.

Regla de oro: cada render de una lista o pantalla toca el puente JS↔nativo. Mantén las referencias estables y el trabajo fuera del render. Aplica `rn-performance` para listas/animaciones/re-renders y `expo-runtime` para safe-area, teclado, edge-to-edge y EAS/prebuild.
