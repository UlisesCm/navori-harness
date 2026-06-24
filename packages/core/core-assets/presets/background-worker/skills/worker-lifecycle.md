---
name: worker-lifecycle
description: Ciclo de vida de un worker de fondo en Node/TS — bootstrap, graceful shutdown, healthcheck mínimo, sin servir HTTP de negocio. Aplica al tocar el arranque/apagado del proceso o la conexión a DB/broker.
type: reference
---

# worker-lifecycle — arrancar y apagar limpio

Un worker no es un HTTP server: arranca conexiones, registra schedulers/consumers, y debe **apagar limpio** sin matar trabajo en vuelo. Su `main` orquesta el bootstrap y un único shutdown idempotente.

## Cuándo usar este skill

Al tocar `index.ts`/`main.ts`, el arranque del scheduler/consumer, la conexión a Mongo/broker, o el manejo de señales.

## El patrón

```ts
async function main() {
  const db = await connectMongo(config.mongoUri);
  const broker = await connectBroker(config.amqpUrl);
  const scheduler = startScheduler({ db });   // job-scheduling
  const consumer = startConsumer({ broker });  // queue-consumers

  const shutdown = once(async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    await consumer.stop();        // deja de tomar mensajes nuevos
    await scheduler.stop();       // deja de disparar jobs
    await drainInflight(15_000);  // espera lo en vuelo, con timeout
    await broker.close();
    await db.close();
    process.exit(0);
  });

  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => shutdown(sig));
}
main().catch((err) => { logger.error({ err }, 'fatal on boot'); process.exit(1); });
```

`once` garantiza que dos señales seguidas no disparen dos shutdowns. El orden importa: **primero dejas de aceptar trabajo**, luego drenas lo en vuelo, luego cierras conexiones.

## Healthcheck (si el orquestador lo exige)

Un solo endpoint `/health` con un `http.createServer` mínimo está bien — **no es** una API. Devuelve `200` si las conexiones (DB, broker) están vivas. Nada de rutas de negocio aquí.

## Reglas duras

1. Un único punto de shutdown, idempotente (`once`), escuchando `SIGTERM` y `SIGINT`.
2. Dejar de aceptar trabajo **antes** de drenar; drenar con timeout; cerrar conexiones al final.
3. Nunca `process.exit` a mitad de un job sin re-encolarlo o dejarlo `nack`-eado.
4. Sin rutas HTTP de negocio. `/health` es el único endpoint permitido.
5. Errores de arranque → log estructurado + `exit(1)`; no arranques a medias.

## Antes de declarar listo

- `SIGTERM` apaga limpio: sin jobs muertos a la mitad, conexiones cerradas.
- El proceso no expone endpoints de negocio.
- `{{qualityGate.fast}}` en verde.
