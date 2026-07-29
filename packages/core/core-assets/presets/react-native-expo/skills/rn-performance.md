---
name: rn-performance
description: Use when building lists, animations/gestures, or optimizing screens that feel slow in React Native — performance: virtualized lists, re-renders, UI-thread animations.
type: reference
---

# React Native — performance

The real cost lives in the JS↔native bridge and the JS thread. The goal: fewer renders, stable references, and heavy work on the UI thread.

## Lists (the most critical)

- **Always virtualize.** Never `ScrollView` + `.map()` for data: it mounts everything. Use `FlashList`/`FlatList` with `keyExtractor` and `estimatedItemSize`/`getItemLayout`. With heterogeneous layouts, `getItemType` for separate recycling pools.
- **Stable `data`.** No `.map()`/`.filter()` over `data` on every render: it creates new references and re-renders the whole visible list on every keystroke. Pass the stable array and transform inside the item.
- **`renderItem` without inline.** `item={{...}}` or `style={{...}}` break `memo()`. Pass primitives or module-hoisted styles. Also hoist the callbacks (one instance that takes the `id`), not a new one per item.
- **Light, memoized item.** No `useQuery` or expensive compute inside; fetch in the parent. `memo()` + only the fields it uses (`name`, not the whole object).

```tsx
const renderItem = ({ item }: { item: Row }) => <RowItem row={item} />;
<FlashList data={rows} renderItem={renderItem} keyExtractor={(r) => r.id}
  getItemType={(r) => r.type} estimatedItemSize={80} />
```

## Re-renders

- **Minimize state, derive the rest** in render (not `useState`+`useEffect`).
- **Store selectors** (`useStore(s => s.has(id))`) over `useContext` (Context re-renders on any change).
- With **React Compiler** ON, manual `memo`/`useCallback` are unnecessary — but object reference stability still matters.

## Animations and gestures

- **Animate only `transform` and `opacity`** (GPU). Never `width/height/top/margin`: they recompute layout per frame. Collapse = `scaleY`, not `height`.
- **Gestures on the UI thread** with Reanimated worklets (`useSharedValue`/`useAnimatedStyle`, `GestureDetector`), not `onPressIn/onPressOut` with a round-trip to the JS thread. `runOnJS` to jump to JS.
- **Scroll with `useAnimatedScrollHandler`** + a shared value, never in `useState` (render thrashing).

## Images and misc

- **`expo-image`** for everything (memory/disk cache, `contentFit`, `recyclingKey`). In lists, ask the CDN for the real size (`?w=200` at 2x), not full-res for a thumbnail.
- Hoist `Intl` formatters to module level. Defer heavy work with `InteractionManager.runAfterInteractions`.

## Avoid render crashes

- **Never `{value && <C/>}` with a falsy value** (`""`/`0` crashes in release): use `!!value &&` or a ternary `? : null`.
- Every string goes inside `<Text>`.

## Before calling it done

- Virtualized lists with `keyExtractor` + `estimatedItemSize`; `renderItem` and its props stable.
- Animations/gestures on the UI thread; no layout animated per frame.
- `{cond && …}` without a raw falsy. `{{qualityGate.fast}}` green.
