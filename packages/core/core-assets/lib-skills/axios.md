---
name: axios
description: Patrones de Axios en TS — instancia central, interceptores, tipado de respuestas, manejo de errores y cancelación. Aplica al tocar llamadas HTTP a APIs.
type: reference
---

# Axios — convenciones

## Cuándo usar este skill

Al hacer una llamada HTTP a una API: crear un endpoint del cliente, agregar auth, mapear errores, o cancelar una request. Axios se cablea **una vez** en una instancia central con interceptores — los componentes/servicios importan esa instancia, no `axios` crudo con la URL a mano en cada llamada.

## El patrón

Una instancia por API (baseURL + interceptores), funciones tipadas encima; nunca `axios.get(fullUrl)` disperso:

```ts
export const api = axios.create({
  baseURL: import.meta.env.VITE_APP_NEXUS_URL,
  timeout: 15_000,
});

api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (error) => Promise.reject(normalizeError(error)),  // un solo shape de error
);

// Servicio tipado: el genérico es el TIPO DE DATA, no el del envelope.
export const getSession = (id: string) =>
  api.get<Session>(`/sessions/${id}`).then((r) => r.data);
```

## Gotchas que muerden

- **`api.get<T>()` tipa `response.data`, no la respuesta entera.** El `T` describe el `data`; Axios envuelve en `{ data, status, headers }`. Devuelve `r.data` desde el servicio para que el caller vea `Session`, no `AxiosResponse<Session>`.
- **Una instancia con `baseURL`, no la URL completa por llamada.** Centraliza host/timeout/headers. Repetir `axios.get('https://…/sessions')` esparce la config y rompe al cambiar de entorno.
- **Auth/refresh/logging en interceptores, no copiados en cada request.** El token va en un `request.use`; el 401→refresh y el mapeo de error van en `response.use`. Nada de `headers: { Authorization }` a mano en cada endpoint.
- **`axios.isAxiosError(err)` antes de leer `err.response`.** En el `catch`, `err` es `unknown`. Sin el type guard, `err.response.data` explota en errores de red (donde `response` es `undefined` y solo hay `err.request`).
- **Un error de red NO es un error HTTP.** Timeout/DNS/offline no traen `response`. Distingue `err.response` (el server respondió con 4xx/5xx) de `err.request` (nunca llegó) para dar el mensaje correcto.
- **Cancela requests en vuelo con `AbortController`.** En efectos/búsqueda-as-you-type pasa `{ signal: controller.signal }` y aborta en el cleanup; sin esto, una respuesta vieja pisa a una nueva (race).
- **4xx/5xx ya rechazan la promesa.** No revises `res.status` en el `.then`; el flujo de error vive en `catch`/el interceptor. Solo `validateStatus` cambia esa regla, y rara vez la necesitas.

## Reglas duras

1. Todo HTTP pasa por la instancia central con `baseURL` + interceptores; nada de `axios` crudo con URL completa suelta.
2. Auth, refresh y normalización de error en interceptores, una sola vez.
3. Servicios tipados con `api.get<Data>(...)` que devuelven `.data`; el genérico es la data, no el envelope.
4. En `catch`, `axios.isAxiosError` antes de tocar `.response`; distingue error de red de error HTTP.
5. Requests cancelables (`AbortController`) donde puede haber carreras.

## Antes de declarar listo

- La llamada usa la instancia central; sin URLs absolutas ni headers de auth repetidos.
- Respuestas tipadas devolviendo `.data`; el error se maneja con `isAxiosError` y un shape único.
- Requests que compiten se cancelan en el cleanup.
- `{{qualityGate.fast}}` en verde.
