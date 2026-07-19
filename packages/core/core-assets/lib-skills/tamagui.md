---
name: tamagui
description: UI con Tamagui v4 — styled() + variants, tokens de tema y qué mantiene contento al compiler. Aplica al crear componentes con estilo, definir el design system o tocar la config/tema.
type: reference
---

# Tamagui — el patrón canónico

Componentes con `styled()` y **variants**; estilos por **tokens** de tema (`$`), no por valores hardcodeados. El compiler extrae en build lo que sea estático — el trabajo es no romperlo.

## Cuándo usar este skill

Al crear un componente con estilo, definir tokens/themes del design system, o tocar `createTamagui`.

## Config

```tsx
import { defaultConfig } from '@tamagui/config/v4'
import { createTamagui, styled, View } from 'tamagui'

export const config = createTamagui({
  ...defaultConfig,
  settings: { ...defaultConfig.settings, styleCompat: 'react-native' },
})
declare module 'tamagui' { interface TamaguiCustomConfig extends typeof config {} }
```

El `declare module` da props tipadas y autocompletado en todo el proyecto. Elige **un solo paquete de import** (`tamagui` o `@tamagui/core`), no ambos.

## styled() + variants (no condicionales inline)

```tsx
const Box = styled(View, {
  variants: {
    tone: { danger: { bg: '$red10' }, ok: { bg: '$green10' } },
  } as const,
})
```

Prefiere variants sobre `bg={isError ? '$red10' : '$green10'}`: los valores runtime rompen el flattening del compiler. Usa `as const` en `variants`.

## Reglas duras

1. **Tokens en props** (`bg="$blue10"`, `p="$4"`, `color="$color"`), nunca `style={{...}}` con variables ni `StyleSheet` de RN (no resuelven tokens).
2. **No rompas el compiler:** evita valores runtime (`width={w*0.5}`), funciones inline y spreads no deterministas en props de estilo. Muévelos a variants.
3. **Themes semánticos** (`success`/`warning`/`error`) vía `createThemes`; colorea por contexto con `<Theme name="...">`, no con hex hardcodeado. Al definir el theme, sin `$`; al consumir, con `$`.
4. **Orden de props = prioridad:** lo que va después de un `{...spread}` gana; en `variants`, la primera listada gana.
5. **Animaciones:** driver `react-native-reanimated` en native; anima con `enterStyle`/`exitStyle`, `pressStyle`/`hoverStyle` y `AnimatePresence` para salidas.
6. **Ramifica plataforma con `Adapt`** (Dialog/Sheet), no con `Platform.OS`.
7. Al envolver un `styled`, usa `.styleable()` para preservar variantes.

## Dev vs prod

`disableExtraction: true` en dev (HMR más rápido); extracción completa en prod. Ignora `.tamagui/` en git.

## Antes de declarar listo

- Estilos por tokens `$`, no hardcodeados ni `style` inline con variables.
- Lógica condicional de estilo en `variants`, no inline (compiler-friendly).
- Un solo paquete de import; `declare module` registrado.
- `{{qualityGate.fast}}` en verde.
