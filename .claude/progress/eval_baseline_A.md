# Baseline (sin capa de solutioning) — BTBS-162

Repo analizado: `/Users/ulisescm/Documents/Dev - Docs/bonum/bonum-webapp` (solo lectura, sin `@tanstack/react-query` instalado hoy — confirmado en `package.json`).

## Plan de implementación propuesto

### 0. Base: provider + query keys
1. `pnpm add @tanstack/react-query` (+ `@tanstack/react-query-devtools` como devDependency, opcional).
2. Crear un `QueryClient` único y envolver `<App />` con `<QueryClientProvider>` en `src/index.tsx:130-146` (justo dentro de `<Provider store={store}>`, fuera de `<BrowserRouter>`; no interfiere con Redux, que se queda como fuente de verdad para los componentes que ya leen `state.user.sessions` / `state.user.coachees`).
3. Defaults del `QueryClient`: `refetchOnWindowFocus: false` (para no cambiar comportamiento visible sin que el ticket lo pida) y un `staleTime` base bajo (ej. 30s) que cada `useQuery`/`fetchQuery` puede sobreescribir.
4. Los servicios en `src/services/*.ts` no cambian de forma — cada uno ya devuelve `{ call, controller }` (patrón `loadAbort`), compatible como `queryFn` sin tocar `useFetchAndLoad`. Nota: el `controller` interno de cada servicio NO se conecta al `AbortSignal` que React Query pasa al `queryFn`; para lecturas GET idempotentes esto es aceptable (React Query igual descarta respuestas de fetches obsoletos internamente), así que no es bloqueante para este ticket — lo dejo como nota, no como tarea.

### 1. `refreshSessions` (el ítem de mayor impacto del ticket)
Archivo: `src/hooks/useUserUtilities.ts:34-67`.

`refreshSessions` no es un simple "mostrar en pantalla": se invoca de forma **imperativa** desde 13 sitios distintos (clicks, `useEffect`s) y varios de esos sitios usan el **valor de retorno** directamente (ej. `NextSession.jsx:100-104` hace `const sessions = await refreshSessions(); const session = await getNextSession(sessions);`). Por eso `useQuery` puro (que es declarativo, atado al ciclo de vida del componente) no encaja tal cual como dice el ticket — la pieza correcta es `queryClient.fetchQuery`, que:
- sigue siendo una función invocable que retorna una promesa con los datos (mismo contrato que hoy),
- participa del cache/dedupe igual que `useQuery` (una key en curso se reutiliza; una key fresca dentro del `staleTime` no dispara red).

Cambios en `useUserUtilities.ts`:
- Añadir `const queryClient = useQueryClient();`.
- Definir `queryKey: ['sessions', user.mongoID, user.role]`.
- Mover el cuerpo actual (líneas 36-59: las 2 sub-llamadas `getCoachSessions`/`getAllAlignmentSessionCoach` o su par coachee, ya en paralelo con `callEndpoint`, ya se pueden envolver en `Promise.all` — hoy están en `await` secuencial, líneas 39-42/45-48) a un `queryFn` interno.
- `refreshSessions` pasa a ser: `const sessions = await queryClient.fetchQuery({ queryKey, queryFn, staleTime: 15_000 }); dispatch(modifySessions(sessions)); return sessions;` — el `dispatch` se queda fuera de la queryFn (no es un side-effect cacheable) y se sigue ejecutando en cada invocación, así que los 6 consumidores que leen `state.user.sessions` directamente (ver "Archivos que tocaría") no requieren ningún cambio.
- Con esto, `App.tsx` (efecto en `App.tsx:318-322`, dispara `getSessions()` definido en `App.tsx:204-210`) y `NextSession.jsx` (efecto en `NextSession.jsx:73-76`, dispara `getSessions()` definido en `NextSession.jsx:100-115`) siguen llamando `refreshSessions()` cada uno por su cuenta — no hace falta tocarlos — pero como comparten la misma `queryKey`, la segunda invocación (la que llegue más tarde, casi siempre `NextSession` porque `Home` sólo se monta cuando `user.mongoID` ya existe) reutiliza el fetch en curso o el cache reciente en vez de re-pegarle al backend.

Corrección de precisión sobre el ticket: el "4→1" que describe el hallazgo es la cantidad de **round-trips HTTP**, no de invocaciones de `refreshSessions`. Cada `refreshSessions()` sigue haciendo 2 llamadas reales (sesiones + alineación) porque son 2 endpoints de negocio distintos — fusionarlos en 1 sería un cambio de backend, fuera de alcance. Lo que colapsa con el fix es: 2 invocaciones de `refreshSessions()` × 2 sub-llamadas = 4 round-trips → 1 invocación efectiva × 2 sub-llamadas = 2 round-trips. Dejo esto explícito para no prometer un "4→1" que no es alcanzable solo con caché de cliente.

Los otros 11 sitios que llaman `refreshSessions()` (`ModalCloseSession/useSessionCloseHandler.ts:141`, `CoachCalendar/Components/Calendar/Calendar.jsx:19`, `ScheduleAlignmentSession.jsx:60`, `ScheduleAlignmentSession/components/Scheduled/Scheduled.jsx:29`, `ScheduleAppointment/components/Scheduled/Scheduled.jsx:16`, `MySessions.jsx:375`, `MySessions/components/SessionAlignment_item/SessionAlignment_item.tsx:45`, `RescheduleAppointment/components/Scheduled/Scheduled.jsx:19`, `RescheduleAppointment.jsx:65`, `CoacheeCalendar.jsx:69`, `CoacheeCalendar/components/Scheduled/Scheduled.jsx:56`) no necesitan tocarse — todos ganan el dedupe gratis porque comparten la misma implementación centralizada en el hook. Los que llaman `refreshSessions()` tras una mutación (agendar/reprogramar/cerrar sesión) SÍ deben forzar red aunque el cache esté "fresh": para esos, pasar `{ staleTime: 0 }` explícito en esa invocación puntual, o exponer una variante `refreshSessions({ force: true })` que internamente use `queryClient.invalidateQueries(queryKey)` antes de `fetchQuery`. Sin esto se arriesga mostrar datos viejos justo después de escribir.

### 2. `getFocusAreas` (catálogo casi estático)
Archivo: `src/services/focusAreas.service.ts:6-12` (sin cambios).

3 call sites, todos con el mismo patrón "fetch en mount → `useState` local" (candidato ideal para `useQuery` declarativo, sin necesidad de `fetchQuery`):
- `src/pages/Preferences/components/Profile/Profile.jsx:81-98` — fetch condicionado a `isCoach`.
- `src/pages/MySessions/MySessions.jsx:391-404`.
- `src/pages/Onboarding/components/FocusAreas/FocusAreas.jsx:31-50` (nota: el path real es `Onboarding/components/FocusAreas/FocusAreas.jsx`, no `Onboarding/FocusAreas.jsx` como dice el ticket — mismo archivo, path desactualizado).

Reemplazar el trío `useState` + `useEffect` + `callEndpoint` por `useQuery({ queryKey: ['focusAreas'], queryFn, staleTime: 1000 * 60 * 60, enabled: <condición existente si aplica> })` en cada uno de los 3 archivos. `staleTime` alto (1h, o `Infinity` si el catálogo solo cambia con deploy) porque es dato casi estático, tal como pide el ticket. En `Profile.jsx` el `enabled: isCoach` reemplaza el `if (isCoach)` de la línea 95-97. En `FocusAreas.jsx` hay que preservar la rama coachee (línea 33-36, que NO pega al backend y arma `focusAreas` desde `coachingProgram?.focusAreas` ya presente en redux) — ahí el `useQuery` debe ir con `enabled: !isCoachee` y mantener el `if` para el caso coachee fuera de la query.

### 3. `getMyCoacheesById` — bloqueado, ver "Preguntas abiertas"
El único call site es `src/pages/MyCoachees/MyCoachees.tsx:40`. Antes de tocar esto verifiqué qué archivo se compila realmente: `MyCoachees/index.tsx:2` hace `import MyCoachees from './MyCoachees'` y en el mismo directorio conviven `MyCoachees.jsx` (viejo) y `MyCoachees.tsx` (nuevo, con `CoacheeStatus2` + `getMyCoacheesById`). Vite resuelve por su orden de extensiones por defecto (`.mjs, .js, .mts, .ts, .jsx, .tsx, .json` — `.jsx` antes que `.tsx`), así que gana `MyCoachees.jsx`. Confirmé contra `dist/assets/index-kFShfULL.js` (build ya generado en el repo): contiene el texto "Gestiona y revisa la información de tus coachees" y la clase `MyCoachees__searchbar` (exclusivos de `MyCoachees.jsx` + `CoacheeStatus.jsx`), y **no** contiene `CoacheeStatus__searchbar` (clase exclusiva de `CoacheeStatus2.tsx`). Es decir: `MyCoachees.tsx` / `CoacheeStatus2.tsx` / `getMyCoacheesById` son código muerto hoy — nunca se bundlean. Ver "Preguntas abiertas" antes de decidir qué hacer aquí.

### 4. `getUserWorkingHours` — alcance más amplio del que lista el ticket
El ticket cita 3 sitios (`useCoachCalendar.ts:21`, `CoachCalendar.jsx:42`, `WorkingHours.jsx:84`), pero `useCoachCalendar.ts` es un hook compartido que además consumen `ViewCoachCalendar.jsx:18`, `ScheduleAlignmentSession.jsx:30`, `ScheduleAppointment.jsx:25`, `RescheduleAppointment.jsx:33` y `CoacheeCalendar.jsx:33` — todos piden el horario del **mismo coach** en flujos de agendar/reagendar. Cachear por `['workingHours', coachId]` beneficia a los 8 sitios, no solo a 3.

Dos patrones distintos, no uno:
- `useCoachCalendar.ts:19-26` y `CoachCalendar.jsx:36-46` son lecturas puras → `useQuery(['workingHours', coach], ...)`.
- `WorkingHours.jsx` es un **formulario de edición** de las horas del propio coach: `saveWorkingHours()` (línea ~89) llama `saveUserWorkingHours` (mutación) y luego vuelve a llamar `getWorkingHours(mongoID)` para refrescar (línea 84 que cita el ticket es justo ese refetch post-guardado). Para este archivo la pieza correcta no es "envolver el GET en una query cacheada" sino `useMutation` para el guardado + `queryClient.invalidateQueries(['workingHours', mongoID])` en `onSuccess`, que automáticamente refresca cualquier `useQuery(['workingHours', mongoID])` activa en otros componentes (ej. si `CoachCalendar.jsx` está montado al mismo tiempo). Tratarlo como "query cacheada" simple, como sugiere el ticket, perdería la invalidación cross-componente tras guardar.

## Archivos que tocaría

- `src/index.tsx:130-146` — envolver con `QueryClientProvider`.
- `src/hooks/useUserUtilities.ts:34-67` — `refreshSessions` sobre `queryClient.fetchQuery`.
- `src/pages/Preferences/components/Profile/Profile.jsx:81-98`
- `src/pages/MySessions/MySessions.jsx:391-404`
- `src/pages/Onboarding/components/FocusAreas/FocusAreas.jsx:31-50`
- `src/hooks/useCoachCalendar.ts:19-26`
- `src/pages/CoachCalendar/CoachCalendar.jsx:36-46`
- `src/pages/CoachCalendar/Components/WorkingHours/WorkingHours.jsx` (mutación + invalidación, no solo query)
- `src/pages/MyCoachees/MyCoachees.tsx:31-49` — condicionado a lo que se decida en "Preguntas abiertas" (puede no tocarse si se descarta el archivo muerto)
- Nuevo, opcional: un `src/queryKeys.ts` (o similar) centralizando `['sessions', ...]`, `['focusAreas']`, `['workingHours', ...]`, `['coachees', ...]` para evitar keys inconsistentes entre archivos.
- `package.json` / lockfile — nueva dependencia.

No tocaría (a propósito, fuera de alcance): `src/pages/MyCoachees/components/CoacheeStatus/CoacheeStatus.jsx` (el `refreshUser` de sus líneas 39-41 corresponde a `getUser`, no está en la lista de "Mejora propuesta" del ticket) — ver nota en Riesgos, porque igual explica el hallazgo citado.

## Riesgos que veo

1. **El hallazgo "CoacheeStatus.jsx:39-41 hace 2 getUser simultáneos" no es lo que parece a primera vista, y el ticket no lo cubre.** No son 2 llamadas en el mismo componente: `refreshUser()` se llama una sola vez en un `useEffect([])` (`CoacheeStatus.jsx:39-41`). Lo que pasa es que `Tabs.Panel` de Mantine mantiene montados ambos paneles por defecto (`keepMounted` es `true` salvo que se desactive), así que `MyCoachees.jsx` (el `.jsx` viejo, confirmado como el que sí se bundlea — ver punto 3 del plan) monta **dos instancias hermanas** de `<CoacheeStatus>` al mismo tiempo (una por pestaña, `activeCoachees={true}` y `activeCoachees={false}`), y cada una dispara su propio `refreshUser()` → de ahí los 2 `getUser` simultáneos. La lista "Mejora propuesta" del ticket no incluye migrar `refreshUser`/`getUser`, así que si se implementa tal cual el ticket, este hallazgo específico queda sin resolver. Lo dejo como pregunta abierta.
2. **Colisión de nombres `MyCoachees.jsx` / `MyCoachees.tsx` (y `CoacheeStatus.jsx` / `CoacheeStatus2.tsx`) es deuda preexistente que puede sabotear cualquier cambio en esa carpeta.** Es fácil editar el archivo equivocado (el `.tsx`, que parece "el más nuevo y correcto") y no ver ningún efecto en producción. Cualquier implementer que toque `getMyCoacheesById` necesita esta verificación primero, no asumir por convención de nombre.
3. **Invalidación tras mutaciones.** El ticket describe bien las lecturas pero no menciona invalidación. Si `refreshSessions` gana `staleTime`, hay que auditar los ~13 call sites para separar "refresco tras mutación" (agendar, reagendar, cerrar sesión, evaluar) de "refresco de lectura pasiva" — los primeros necesitan `staleTime: 0` o `invalidateQueries` explícito, si no, un usuario que agenda una sesión puede ver la lista vieja unos segundos.
4. **`user.mongoID`/`user.role` cambiando de identidad (logout→login con otro usuario) sin remount completo.** Si el `queryKey` de sessions no incluye `user.role` (solo `mongoID`), un cambio de rol en el mismo `mongoID` (poco probable pero posible en datos de prueba/impersonation) serviría cache cruzado. Ya lo incluí en la key propuesta (`['sessions', user.mongoID, user.role]`) pero es un detalle fácil de perder.
5. **`useFetchAndLoad`'s `loading` deja de ser la fuente de verdad del loading state** en los sitios migrados a `useQuery` (React Query trae su propio `isLoading`/`isFetching`). Cualquier JSX que hoy lea `loading` de `useFetchAndLoad` en un componente migrado (ej. `Profile.jsx`, `FocusAreas.jsx`) debe cambiar a leer `isLoading` de `useQuery` — si se deja el `loading` viejo sin cablear, la UI deja de mostrar el spinner correctamente (regresión silenciosa, no truena en build).
6. **Sin tests de referencia para hooks de datos.** No vi tests existentes para `useUserUtilities` ni para los componentes que consumen `getFocusAreas`/`getUserWorkingHours` (no confirmé exhaustivamente, pero no aparecieron en las búsquedas). Migrar sin cobertura nueva es alto riesgo para un cambio que toca 13+ call sites de sesiones — recomendaría al menos tests unitarios de `refreshSessions` (dedupe real con 2 invocaciones concurrentes) antes de mergear.

## Preguntas abiertas (si las tienes)

1. ¿La migración de `refreshUser`/`getUser` (que resolvería el hallazgo real de `CoacheeStatus.jsx:39-41`) está fuera de alcance de BTBS-162, o se agrega como quinto ítem? El ticket la menciona en el hallazgo pero no en la lista de cambios propuestos.
2. Para `getMyCoacheesById`/`MyCoachees.tsx`/`CoacheeStatus2.tsx`: ¿se sabe si esa es una migración en curso (Chakra→Mantine, o de coachees embebidos en `getUser` a un endpoint paginado propio) que quedó a medias? Antes de invertir tiempo cacheándolo con React Query hace falta decidir: (a) se retoma esa migración y se borra `MyCoachees.jsx`/`CoacheeStatus.jsx` (el código muerto pasa a vivo, y ahí sí aplica el `useQuery` que pide el ticket), o (b) se descarta `MyCoachees.tsx`/`CoacheeStatus2.tsx`/`getMyCoacheesById` como código muerto y se elimina del alcance de este ticket (los coachees ya viajan gratis dentro de `getUser`, vía `user.adapter.ts:238`, así que cachear una llamada que no se ejecuta no aporta nada).
3. ¿Existe ya una convención de `staleTime`/`gcTime` en algún otro repo Bonum con React Query (ej. `bonum-nexus` del lado frontend, o `bonum-ai-coach-frontend`) que debiera replicarse aquí por consistencia, o se define desde cero en este ticket?
4. Para las invalidaciones tras mutación de sesiones (agendar/reagendar/cerrar/evaluar): ¿el ticket espera que ese trabajo se incluya en BTBS-162, o es un ticket de seguimiento? Sin esa parte, el riesgo 3 queda abierto en producción.
