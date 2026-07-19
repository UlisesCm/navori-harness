---
name: zustand
description: Estado global con Zustand v5 — selectores para evitar re-renders, acciones en el store, slices. Aplica al crear un store, leer estado en un componente o mover estado compartido fuera de Context.
type: reference
---

# Zustand — el patrón canónico

Un store con estado y acciones juntos; los componentes se suscriben con un **selector**, no al store entero. Así solo re-renderizan cuando cambia lo que leen.

## Cuándo usar este skill

Al crear un store, leer estado en un componente, o mover estado compartido/mutable frecuente fuera de Context (que re-renderiza todo el árbol del Provider).

## El patrón

```ts
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

const useUserStore = create<UserStore>((set) => ({
  user: null,
  loading: false,
  fetchUser: async (id) => {
    set({ loading: true });
    try {
      const user = await api.getUser(id);
      set({ user, loading: false });
    } catch {
      set({ error: "fetch failed", loading: false });
    }
  },
}));

const name = useUserStore((s) => s.user?.name);            // un campo → sin re-render de más
const { user, loading } = useUserStore(                    // varios campos → useShallow
  useShallow((s) => ({ user: s.user, loading: s.loading })),
);
```

## Reglas duras

1. **Siempre un selector.** `const s = useStore()` (sin selector) re-renderiza ante cualquier cambio del store. Selecciona el campo que usas.
2. **Varios campos → `useShallow`.** Devolver un objeto/array nuevo sin `useShallow` re-renderiza en cada render por identidad nueva.
3. **Acciones dentro del store**, no en el componente; usa `set((state) => ...)` cuando el update depende del valor actual.
4. **Estado async con su `loading`/`error` en el store**, no suelto en el componente.
5. **Nada de un único store global gigante.** Separa por dominio (user, cart, settings) con el **slices pattern**: cada slice es una factory `(set) => ({...})` y el store se compone por spread; el tipo es la intersección.
6. Fuera de React: `useStore.getState()` / `setState()` / `subscribe()` — no hooks.

```ts
const useStore = create<UserSlice & CartSlice>()((...a) => ({
  ...createUserSlice(...a),
  ...createCartSlice(...a),
}));
```

## Middlewares

`persist` (hidratar desde storage, con `name`), `immer` (updates anidados mutando "directo"), `devtools` (`{ name }`). Se anidan envolviendo el creador.

## Zustand vs Context

Context es para inyección **estable** (theme, config, i18n). Para estado compartido que cambia seguido, Zustand — evita el re-render masivo del Provider.

## Antes de declarar listo

- Cada componente lee con selector; multi-campo con `useShallow`.
- Acciones y estado async (con loading/error) viven en el store.
- Stores separados por dominio; nada de un mega-store global.
- `{{qualityGate.fast}}` en verde.
