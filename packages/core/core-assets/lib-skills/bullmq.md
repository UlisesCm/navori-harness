---
name: bullmq
description: Jobs y colas con BullMQ sobre Redis — Queue/Worker/QueueEvents, jobs idempotentes, retries con backoff, concurrency y graceful shutdown. Aplica al crear/tocar un job, un worker o al encolar trabajo async.
type: reference
---

# BullMQ — jobs & queues

BullMQ mueve trabajo pesado o diferido fuera del request: un **productor** encola (`Queue.add`) y un **worker** (proceso aparte) lo procesa. La conexión es Redis (`ioredis`). El productor y el worker viven en procesos distintos y comparten solo el nombre de la cola.

## Cuándo usar este skill

Al crear una cola o un job nuevo, tocar el worker, encolar trabajo desde un handler/hook, o depurar jobs que se cuelgan, se reintentan en loop o se pierden.

> **Scope.** Este skill cubre la **API de BullMQ** (Queue/Worker/QueueEvents, opciones de job). Si tu repo usa el preset `background-worker`, sus skills `worker-lifecycle` y `queue-consumers` son la fuente para el **ciclo de vida del worker** y las convenciones del servicio (arranque/apagado, idempotencia a nivel de consumidor); apóyate en aquéllas para eso y en ésta para el uso concreto de la librería.

## El patrón

```ts
// Productor (en un request/hook): encola y responde rápido, NO esperes el resultado.
await queue.add("send-welcome", { userId }, {
  attempts: 3,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: 1000,   // no dejes que Redis crezca sin límite
  removeOnFail: 5000,
});

// Worker (proceso aparte): una responsabilidad por worker/cola.
const worker = new Worker("emails", async (job) => {
  // idempotente: correr dos veces el mismo job no debe duplicar efectos
  return sendEmail(job.data);
}, { connection, concurrency: 5 });
```

## Reglas duras

1. **Jobs idempotentes.** Un job puede reintentarse o entregarse dos veces. Usa un id determinista (`jobId`) o un guard de "ya procesado" para efectos no repetibles (cobros, emails, mutaciones críticas).
2. **`attempts` + `backoff` siempre.** Un job sin reintentos muere al primer error transitorio; uno sin backoff martillea el recurso que falla. Exponencial por default.
3. **El productor NO espera el resultado.** Encola y responde; el valor del job se consume por eventos (`QueueEvents`) o releyendo estado, no bloqueando el request.
4. **`removeOnComplete`/`removeOnFail`.** Sin límites, Redis se llena de jobs viejos. Acota siempre.
5. **Graceful shutdown.** En `SIGTERM`/`SIGINT`, `await worker.close()` antes de salir para no matar un job a medias. Un worker que no cierra limpio deja jobs en `active` colgados.
6. **Errores que deben reintentar → lanza; errores permanentes → no.** Un input inválido no se arregla reintentando: valida antes de encolar o marca el job como fallido sin reintento (`attempts: 1` o un error no-recuperable).
7. **Una responsabilidad por worker.** No metas varios tipos de trabajo no relacionado en un solo `Worker` con `if job.name`; sepáralos por cola.

## Gotchas que muerden

- **La `connection` de ioredis para BullMQ necesita `maxRetriesPerRequest: null`** — si no, BullMQ lanza al reconectar.
- **`concurrency` alto no es gratis**: cada job concurrente abre conexiones/CPU. Súbelo con medida, no por default.
- **Un job "perdido"** casi siempre es: el worker no está corriendo, apunta a otra cola/Redis, o crasheó sin `removeOnFail` y quedó en `failed`. Revisa el estado del job antes de asumir un bug de lógica.
- **Delayed/repeatable jobs** viven en Redis: cambiar el patrón de un repeatable no borra el viejo — límpialo explícitamente.

## Antes de declarar listo

- El job es idempotente (o tiene guard de duplicados) y define `attempts` + `backoff`.
- El worker cierra en `SIGTERM`/`SIGINT` (`worker.close()`).
- `removeOnComplete`/`removeOnFail` acotados; la `connection` usa `maxRetriesPerRequest: null`.
- El productor no bloquea el request esperando el job.
- `{{qualityGate.fast}}` en verde.
