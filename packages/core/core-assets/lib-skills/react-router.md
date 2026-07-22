---
name: react-router
description: Patrones de React Router (v6/v7) — rutas anidadas, loaders, navegación, params y guards. Aplica al crear rutas, leer params, redirigir o proteger vistas.
type: reference
---

# React Router — convenciones

## Cuándo usar este skill

Al tocar navegación: declarar una ruta, leer un param, redirigir, proteger una vista por rol, o cablear links. React Router es la fuente de verdad de **en qué URL estás y a dónde vas** — no dupliques la ruta en estado propio ni parsees `window.location` a mano.

## El patrón

Rutas anidadas con layout compartido vía `<Outlet />`; navegación por hooks, no por mutar `window.location`:

```tsx
const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,           // renderiza <Outlet /> para los hijos
    children: [
      { index: true, element: <Home /> },
      { path: 'sessions/:id', element: <SessionDetail /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

function SessionDetail() {
  const { id } = useParams();                 // string | undefined, siempre
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  // ...
  navigate('/sessions', { replace: true });   // no <a href> manual
}
```

## Gotchas que muerden

- **`useParams()` siempre da `string | undefined`.** Nunca `number`. Convierte y valida (`Number(id)`, guard) antes de usarlo como id; una ruta mal tecleada no lanza, solo llega `undefined`.
- **Navegar imperativo con `useNavigate`, no `window.location`.** `window.location.href = …` recarga toda la SPA y tira el estado. Para volver: `navigate(-1)`; para redirigir sin dejar historial: `{ replace: true }`.
- **`<NavLink>` para tabs/menús, `<Link>` para el resto.** `NavLink` expone `isActive` en `className`/`style`/children; no reimplementes "está activo" comparando `pathname` a mano.
- **Search params son la URL, no `useState`.** Filtros/paginación viven en `useSearchParams` para que la vista sea linkeable y sobreviva al refresh. `setParams` reemplaza TODO el query — clona lo actual si solo cambias una clave.
- **Ruta protegida = un wrapper con `<Navigate>`, no un `if` suelto.** `if (!user) return <Navigate to="/login" replace />;` dentro de un guard/layout. Redirigir desde un `useEffect` parpadea la vista privada un frame.
- **Rutas relativas anidan; un `/` inicial las hace absolutas.** Dentro de `sessions/:id`, `navigate('edit')` va a `sessions/:id/edit`; `navigate('/edit')` va a la raíz. Es el error #1 al mover un componente de nivel.

## Reglas duras

1. Navegación por `useNavigate`/`<Link>`/`<NavLink>`; nunca `window.location` ni `<a href>` interno.
2. `useParams` se valida antes de usar (puede ser `undefined`); ids numéricos se convierten explícito.
3. Estado de filtros/paginación en `useSearchParams`, no en `useState` espejo.
4. Vistas protegidas por un guard con `<Navigate replace>`, no por `if` + efecto.
5. Layouts compartidos con rutas anidadas + `<Outlet />`; nada de repetir el chrome por página.

## Antes de declarar listo

- Sin `window.location`/`<a href>` para navegación interna; links con `<Link>`/`<NavLink>`.
- Params validados; el estado de la URL (filtros, tab) vive en search params.
- Rutas protegidas redirigen con `<Navigate replace>`; sin parpadeo de la vista privada.
- `{{qualityGate.fast}}` en verde.
