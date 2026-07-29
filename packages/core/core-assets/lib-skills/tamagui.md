---
name: tamagui
description: Use when creating styled components, defining the design system, or touching the config/theme — UI with Tamagui v4: styled() + variants, theme tokens, and what keeps the compiler happy.
type: reference
---

# Tamagui — the canonical pattern

Components with `styled()` and **variants**; styles by theme **tokens** (`$`), not hardcoded values. The compiler extracts whatever is static at build time — the job is to not break it.

## When to use this skill

When creating a styled component, defining design-system tokens/themes, or touching `createTamagui`.

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

The `declare module` gives typed props and autocompletion across the whole project. Pick **a single import package** (`tamagui` or `@tamagui/core`), not both.

## styled() + variants (not inline conditionals)

```tsx
const Box = styled(View, {
  variants: {
    tone: { danger: { bg: '$red10' }, ok: { bg: '$green10' } },
  } as const,
})
```

Prefer variants over `bg={isError ? '$red10' : '$green10'}`: runtime values break the compiler's flattening. Use `as const` on `variants`.

## Hard rules

1. **Tokens in props** (`bg="$blue10"`, `p="$4"`, `color="$color"`), never `style={{...}}` with variables or RN `StyleSheet` (they don't resolve tokens).
2. **Don't break the compiler:** avoid runtime values (`width={w*0.5}`), inline functions, and non-deterministic spreads in style props. Move them to variants.
3. **Semantic themes** (`success`/`warning`/`error`) via `createThemes`; color by context with `<Theme name="...">`, not with hardcoded hex. When defining the theme, no `$`; when consuming, with `$`.
4. **Prop order = priority:** whatever comes after a `{...spread}` wins; in `variants`, the first one listed wins.
5. **Animations:** `react-native-reanimated` driver on native; animate with `enterStyle`/`exitStyle`, `pressStyle`/`hoverStyle` and `AnimatePresence` for exits.
6. **Branch by platform with `Adapt`** (Dialog/Sheet), not with `Platform.OS`.
7. When wrapping a `styled`, use `.styleable()` to preserve variants.

## Dev vs prod

`disableExtraction: true` in dev (faster HMR); full extraction in prod. Ignore `.tamagui/` in git.

## Before declaring done

- Styles by `$` tokens, not hardcoded or inline `style` with variables.
- Conditional style logic in `variants`, not inline (compiler-friendly).
- A single import package; `declare module` registered.
- `{{qualityGate.fast}}` green.
