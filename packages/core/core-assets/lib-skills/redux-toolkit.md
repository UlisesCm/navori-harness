---
name: redux-toolkit
description: Patrones de Redux Toolkit en React+TS — slices, store tipado, hooks tipados, async thunks, selectores. Aplica al tocar estado global, slices o el store.
type: reference
---

# Redux Toolkit — convenciones

## Cuándo usar este skill

Al crear o tocar un slice, el store, async thunks, o leer/escribir estado global. RTK es el estándar — nada de `createStore` pelado, action types a mano, ni `connect`. Estado de servidor (fetch/cache) NO va aquí: eso es TanStack Query. Redux es para estado de cliente compartido (sesión, UI cross-página, carrito).

## El patrón

```ts
const slice = createSlice({
  name: 'session',
  initialState,
  reducers: {
    setActive(state, action: PayloadAction<Session>) {
      state.active = action.payload; // Immer: "mutas" un draft, no el real
    },
  },
  extraReducers: (b) => {
    b.addCase(loadSession.fulfilled, (s, a) => { s.active = a.payload; });
  },
});
export const { setActive } = slice.actions;
```

Store + hooks tipados una sola vez, y se usan en toda la app:

```ts
export const useAppDispatch = useDispatch.withTypes<AppDispatch>();     // patrón vigente (RTK 2 / react-redux 9)
export const useAppSelector = useSelector.withTypes<RootState>();       // no el viejo TypedUseSelectorHook
```

## Gotchas que muerden

- **Immer solo dentro de `createSlice`.** Ahí "mutas" el draft; fuera de un reducer, mutar el state es un bug. No retornes Y mutes en el mismo reducer.
- **Selectores memoizados** con `createSelector` cuando derivan/transforman — un selector que crea un array/objeto nuevo en cada llamada re-renderiza siempre.
- **`useSelector` devuelve la referencia**: selecciona lo mínimo, no el slice entero. Si necesitas varios campos, envuelve con `useShallow(...)` (react-redux 9) para comparar superficial y no re-renderizar de más.
- **Efectos reactivos → `createListenerMiddleware`**, no un `useEffect` espiando el store ni sagas. Reacciona a una acción/cambio de estado desde el middleware.
- **Colecciones por id → `createEntityAdapter`**: `selectAll`/`selectById` memoizados gratis, CRUD normalizado, sin arreglos a mano.
- **Async**: `createAsyncThunk` simple; si es data de API que cacheas/invalidas, evalúa RTK Query. `extraReducers` con builder callback (`(b) => b.addCase(...)`), la forma-objeto se eliminó en RTK 2.
- **No-serializables** (Date, Map, funciones) fuera del store; rompen devtools y persistencia.

## Reglas duras

1. Estado global solo vía slices de RTK; nada de Context improvisado para lo mismo.
2. Hooks `useAppDispatch`/`useAppSelector` tipados, nunca los crudos sin tipo.
3. Selecciona lo mínimo y memoiza los derivados con `createSelector`.
4. Estado de servidor no vive en Redux — eso es cache de queries.
5. Solo valores serializables en el store.

## Antes de declarar listo

- El slice nuevo expone acciones tipadas y se consume con los hooks tipados.
- Los selectores derivados están memoizados; los componentes seleccionan lo mínimo.
- Nada de data de API duplicada en el store si ya hay capa de queries.
- `{{qualityGate.fast}}` en verde.
