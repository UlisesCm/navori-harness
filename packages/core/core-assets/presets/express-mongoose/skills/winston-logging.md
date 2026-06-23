---
name: winston-logging
description: Logging con winston — Logger.error/warn/info/debug, niveles correctos, mensajes accionables con contexto, nada de console.log. Aplica al agregar logs o auditar las traces de un bug.
type: reference
---

# Winston Logging — patterns del repo

El `Logger` del repo (winston, típicamente en `infrastructure/`) reemplaza por completo a `console`. Escribe a consola y archivo en dev, solo consola en prod.

## Cuándo usar este skill

Al agregar logs a un controller, job o servicio, elegir el nivel correcto, auditar traces de un bug, o limpiar `console.log` heredados.

## El patrón

```ts
import Logger from '../../infrastructure/core/Logger';

try {
  const created = await Resource.create(dto);
  Logger.info(`[resource:create] ${created._id} owner ${dto.owner}`);
} catch (err) {
  Logger.error(`Failed to create Resource`, err);
  throw err; // re-throw → middleware global lo mapea a InternalError
}
```

Con `format.errors({ stack: true })` (config típica), pasar un `Error` loguea el stack solo. Prefija con `[<scope>:<verb>]` (`[job:sendReminder]`, `[email:welcome]`) para que sea grep-friendly.

A menudo NO necesitas try/catch en el controller: el `asyncHandler` ya pasa el error al middleware global. Agrégalo solo para loguear contexto extra, mapear un error específico (ej. `MongoServerError` 11000 → `BadRequestError`), o cleanup antes del re-throw.

## Gotchas que muerden

- **`Logger.debug` no se imprime en prod** cuando `logLevel = isDev ? 'debug' : 'info'`. Perfecto para diagnóstico que no quieres exponer; inútil si esperabas verlo en prod.
- **`JSON.stringify(req)` revienta**: los Request son enormes y tienen circular refs. Loguea solo lo que necesitas.

## Reglas duras

1. `Logger` siempre, nunca `console.log/error/warn`. Borra los `console.log` temporales antes del commit.
2. Nivel correcto: `error` (capturado/crítico), `warn` (recuperable pero notable), `info` (evento de dominio: job, login, email), `debug` (solo dev).
3. Mensajes accionables: incluye IDs y contexto, no solo "Error"/"Failed".
4. No spammees — un `info` por request es ruido; resérvalo para eventos.
5. Re-lanza (`throw err`) tras el `Logger.error` cuando el flujo lo necesita; el caller debe enterarse del fallo.
6. Nunca loguees secrets (tokens, passwords) ni `JSON.stringify(req)` completo. Nada de `catch (e) {}` tragador.

## Tabla rápida

| Situación | Nivel |
|---|---|
| Error capturado o evento crítico | `Logger.error(err)` |
| Recuperable pero notable | `Logger.warn(msg)` |
| Evento de dominio (job, login, email) | `Logger.info(msg)` |
| Diagnóstico de desarrollo | `Logger.debug(msg)` |

## Antes de declarar listo

- No quedó ningún `console.log` nuevo; los temporales se borraron.
- Cada log usa el nivel correcto y lleva IDs/contexto accionable.
- Los errores capturados re-lanzan cuando el flujo lo necesita.
- No se loguean secrets ni `JSON.stringify(req)` completo.
- `{{qualityGate.fast}}` en verde.
