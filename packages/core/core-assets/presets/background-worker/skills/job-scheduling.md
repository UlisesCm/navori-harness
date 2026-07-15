---
name: job-scheduling
description: Definir y agendar jobs en un worker (agenda / bullmq) — idempotencia, reintentos con backoff, concurrencia. Aplica al crear o tocar un job programado o recurrente.
type: reference
---

# job-scheduling — jobs idempotentes y reintentables

Un job define **qué** hacer; el scheduler decide **cuándo** y **cuántas veces**. Como un job puede correr más de una vez (reintento, doble disparo), el handler debe ser idempotente.

## Cuándo usar este skill

Al definir un job nuevo, agendar uno recurrente, o ajustar reintentos/concurrencia.

## El patrón (agenda)

Un archivo por job (`<name>.job.ts`) que registra el handler; el scheduling vive aparte del handler.

```ts
export function defineSyncJob(agenda: Agenda) {
  agenda.define('sync-user', { concurrency: 5, lockLifetime: 60_000 }, async (job) => {
    const { userId } = job.attrs.data as { userId: string };
    // idempotente: chequea estado antes de actuar
    if (await alreadySynced(userId, job.attrs.lastRunAt)) return;
    await syncUser(userId);
  });
}

// scheduling, separado del handler:
await agenda.every('0 * * * *', 'sync-user', { userId });   // recurrente
await agenda.schedule('in 5 minutes', 'sync-user', { userId }); // one-off
```

bullmq es equivalente: `new Worker(name, handler, { concurrency, connection })` + `queue.add(name, data, { attempts, backoff })`. Para recurrentes usa **`queue.upsertJobScheduler(id, { pattern: '0 * * * *' }, { name, data })`** — NO la opción `repeat` (deprecada en BullMQ 5); `upsert` con el mismo `id` actualiza el schedule en vez de duplicarlo en cada deploy.

## Gotchas que muerden

- **Doble disparo**: dos workers pueden tomar el mismo job. agenda usa `lockLifetime`; bullmq re-procesa si el `lockDuration` expira antes de renovarse (`stalledInterval`/`maxStalledCount`). Aun así, **el handler debe ser idempotente** — no confíes solo en el lock.
- **BullMQ: la conexión IORedis del `Worker` DEBE llevar `maxRetriesPerRequest: null`**, o el arranque falla (error #1). Y setea `removeOnComplete`/`removeOnFail` (`{ age, count }`), sino Redis crece sin límite con jobs viejos.
- **Reintentos sin backoff** martillan un servicio caído. Configura `attempts` + `backoff` exponencial.
- **`lockLifetime`/`lockDuration` corto** + job largo → el lock expira y otro worker lo retoma en paralelo. Ajústalo por encima de la duración real del job.

## Reglas duras

1. Un job por archivo `<name>.job.ts`; handler separado del scheduling.
2. Handler **idempotente**: chequea estado antes de mutar; usa upserts/claves de dedup.
3. Reintentos con backoff exponencial y un tope (`attempts`); sin reintento infinito.
4. `concurrency` y `lockLifetime` explícitos y coherentes con la duración del job.
5. Nada de trabajo no idempotente que dependa de "correr exactamente una vez".

## Antes de declarar listo

- El handler es seguro de re-ejecutar (probado corriéndolo dos veces).
- Reintentos con backoff y tope configurados.
- `{{qualityGate.fast}}` en verde.
