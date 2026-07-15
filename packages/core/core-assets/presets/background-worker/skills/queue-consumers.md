---
name: queue-consumers
description: Consumir mensajes de una cola en un worker (amqplib / bullmq) — ack/nack, dead-letter, prefetch/backpressure, idempotencia. Aplica al crear o tocar un consumidor de cola.
type: reference
---

# queue-consumers — consumir sin perder ni duplicar

Un consumer reacciona a mensajes. La regla central: **un mensaje no se confirma (`ack`) hasta que se procesó con éxito**; si falla, se re-encola o va a dead-letter — nunca se pierde en silencio.

## Cuándo usar este skill

Al crear un consumer, manejar fallos de procesamiento, o ajustar prefetch / dead-letter.

## El patrón (amqplib)

```ts
await channel.prefetch(10); // backpressure: máx 10 sin ack a la vez
await channel.consume(queue, async (msg) => {
  if (!msg) return;
  try {
    const payload = JSON.parse(msg.content.toString());
    if (await alreadyProcessed(payload.id)) { channel.ack(msg); return; } // idempotente
    await handle(payload);
    channel.ack(msg);
  } catch (err) {
    logger.error({ err }, 'consume failed');
    // requeue una vez; si ya fue redelivered, mándalo a la DLQ (no requeue infinito)
    channel.nack(msg, false, !msg.fields.redelivered);
  }
});
```

bullmq: lanzar dentro del `Worker` handler re-encola según `attempts`/`backoff`; al agotarse, el job queda `failed`. **`failed` NO es una DLQ**: nadie reprocesa ni alerta solo — escucha `worker.on('failed')` / `QueueEvents`, o mueve a una `failed`-queue dedicada con monitoreo.

## Gotchas que muerden

- **`redelivered` es una heurística pobre para reintentos.** Se activa en **cualquier** re-entrega (incluida recuperación de conexión) y solo distingue "0 vs ≥1", no un contador; `nack` con requeue reencola en la **cabeza** → hot-loop sin backoff. El patrón robusto es **dead-letter exchange (DLX) + retry queue con TTL** (o header `x-death`/contador), no `redelivered`.
- **Dedup atómica, no check-then-act.** `if (await alreadyProcessed(id))` es TOCTOU: con `prefetch>1` o dos consumers, dos entregas pasan ambas el check. Usa `INSERT` con unique index (captura duplicate-key) o `SET NX` en Redis.
- **Parse fallido = no-retryable** → DLQ directo, no requeue (un payload corrupto haría loop eterno).
- **Sin `prefetch`** el consumer traga toda la cola en memoria. Fija un prefetch acorde a la duración del handler.
- **`ack` antes de procesar** = pérdida de mensajes si el handler crashea. Confirma **después** del éxito.
- **Mensajes duplicados** son normales (redelivery). El handler debe ser idempotente.

## Reglas duras

1. `ack` solo tras éxito; en fallo, reintento acotado (DLX + retry queue / contador) o dead-letter.
2. Nunca requeue infinito de un mensaje venenoso; un parse fallido va directo a DLQ.
3. `prefetch` explícito para backpressure.
4. Handler **idempotente** con dedup **atómica** (unique index / `SET NX`), no check-then-act.
5. Errores logueados (estructurado), nunca tragados en silencio.

## Antes de declarar listo

- Un mensaje que falla no se pierde ni hace loop infinito (va a DLQ).
- `prefetch` configurado; el handler es idempotente.
- `{{qualityGate.fast}}` en verde.
