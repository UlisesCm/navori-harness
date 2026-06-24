## Stack — Background worker (jobs + queues)

Proceso de fondo en Node/TS cuyo trabajo es **procesar jobs y mensajes**, no servir HTTP. El flujo típico: un scheduler (`agenda` / `bullmq` / `node-cron`) dispara jobs en el tiempo, y/o un consumidor de cola (`amqplib` / `bullmq` / `kafkajs`) reacciona a mensajes. Cada handler hace su trabajo (mandar email, push, recalcular, sincronizar) y reporta éxito/fallo a la infraestructura de jobs.

Aunque el repo tenga `express` en deps, **no expone endpoints de negocio** — a lo sumo un `/health` para el orquestador. Si te piden agregar una "ruta", confirma: casi siempre es un job o un consumer nuevo, no un endpoint.

Reglas de oro:
- **Idempotencia**: un job/mensaje puede entregarse más de una vez. Todo handler debe ser seguro de re-ejecutar (claves de deduplicación, upserts, chequear estado antes de actuar).
- **Graceful shutdown**: en `SIGTERM`/`SIGINT`, deja de tomar trabajo nuevo, espera a que los jobs en vuelo terminen (con timeout) y cierra conexiones (DB, broker) antes de salir. Nunca mates un job a la mitad sin re-encolar.
- **Errores explícitos**: un fallo se reintenta con backoff o va a una dead-letter; nunca se traga en silencio. El logging va por el `Logger` estructurado, nunca `console.log`.
- **Nada de `process.env`** fuera del módulo de config.

Aplica las skills según la capa que toques:
- `worker-lifecycle` — bootstrap, graceful shutdown, healthcheck, no servir HTTP de negocio.
- `job-scheduling` — definir/agendar jobs (agenda/bullmq), idempotencia, reintentos con backoff.
- `queue-consumers` — consumir mensajes (amqplib/bullmq), `ack`/`nack`, dead-letter, backpressure.

El logging y el flujo de tickets/PR los cubre el harness base (agentes `leader`, `implementer`, `reviewer`, `commit-pr-pilot` y las skills core).
