---
name: rn-performance
description: Performance de React Native — listas virtualizadas, re-renders, animaciones en UI thread. Aplica al crear listas, animaciones/gestos, o al optimizar pantallas que se sienten lentas.
type: reference
---

# React Native — performance

El costo real vive en el puente JS↔nativo y en el JS thread. La meta: menos renders, referencias estables, y el trabajo pesado en el UI thread.

## Listas (lo más crítico)

- **Virtualiza siempre.** Nunca `ScrollView` + `.map()` para datos: monta todo. Usa `FlashList`/`FlatList` con `keyExtractor` y `estimatedItemSize`/`getItemLayout`. Con layouts heterogéneos, `getItemType` para pools de reciclaje separados.
- **`data` estable.** Nada de `.map()`/`.filter()` sobre `data` en cada render: crea referencias nuevas y re-renderiza toda la lista visible en cada keystroke. Pasa el array estable y transforma dentro del ítem.
- **`renderItem` sin inline.** `item={{...}}` o `style={{...}}` rompen el `memo()`. Pasa primitivos o estilos hoisteados a módulo. Hoistea también los callbacks (una instancia que reciba el `id`), no uno nuevo por ítem.
- **Ítem ligero y memoizado.** Sin `useQuery` ni cómputo caro dentro; fetch en el padre. `memo()` + solo los campos que usa (`name`, no el objeto entero).

```tsx
const renderItem = ({ item }: { item: Row }) => <RowItem row={item} />;
<FlashList data={rows} renderItem={renderItem} keyExtractor={(r) => r.id}
  getItemType={(r) => r.type} estimatedItemSize={80} />
```

## Re-renders

- **Minimiza estado, deriva el resto** en render (no `useState`+`useEffect`).
- **Selectores de store** (`useStore(s => s.has(id))`) sobre `useContext` (Context re-renderiza ante cualquier cambio).
- Con **React Compiler** ON, `memo`/`useCallback` manuales sobran — pero la estabilidad de referencias de objetos sigue importando.

## Animaciones y gestos

- **Anima solo `transform` y `opacity`** (GPU). Nunca `width/height/top/margin`: recalculan layout por frame. Colapsar = `scaleY`, no `height`.
- **Gestos en UI thread** con Reanimated worklets (`useSharedValue`/`useAnimatedStyle`, `GestureDetector`), no `onPressIn/onPressOut` con round-trip al JS thread. `runOnJS` para saltar a JS.
- **Scroll con `useAnimatedScrollHandler`** + shared value, jamás en `useState` (render thrashing).

## Imágenes y misc

- **`expo-image`** para todo (caché memoria/disco, `contentFit`, `recyclingKey`). En listas, pide al CDN el tamaño real (`?w=200` a 2x), no full-res para un thumbnail.
- Hoistea formatters `Intl` a nivel de módulo. Difiere trabajo pesado con `InteractionManager.runAfterInteractions`.

## Evita crashes de render

- **Nunca `{value && <C/>}` con falsy** (`""`/`0` crashea en release): usa `!!value &&` o ternario `? : null`.
- Todo string va dentro de `<Text>`.

## Antes de declarar listo

- Listas virtualizadas con `keyExtractor` + `estimatedItemSize`; `renderItem` y sus props estables.
- Animaciones/gestos en UI thread; nada de layout animado por frame.
- `{cond && …}` sin falsy crudo. `{{qualityGate.fast}}` en verde.
