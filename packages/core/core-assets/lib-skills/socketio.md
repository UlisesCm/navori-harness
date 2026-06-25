---
name: socketio
description: Patrones de Socket.IO en un servicio Node — namespaces, rooms, auth en el handshake, eventos tipados, cleanup. Aplica al tocar realtime, gateways o handlers de socket.
type: reference
---

# Socket.IO — convenciones del servicio

## Cuándo usar este skill

Al agregar o tocar realtime: un namespace, un evento, autenticación de conexión, o broadcast a un room. Socket.IO sobre el HTTP server de Express. La regla base: el handler de socket es una capa de transporte, no de negocio — delega al mismo service/controller que usan las rutas HTTP.

## El patrón

```ts
io.of('/sessions').use(authSocket).on('connection', (socket) => {
  socket.join(`session:${socket.data.sessionId}`);

  socket.on('message:send', async (dto, ack) => {
    try {
      const saved = await messageService.create(socket.data.userId, dto);
      io.to(`session:${dto.sessionId}`).emit('message:new', saved);
      ack?.({ ok: true, id: saved._id });
    } catch (err) {
      ack?.({ ok: false, error: toClientError(err) });
    }
  });

  socket.on('disconnect', () => { /* cleanup timers/subscriptions */ });
});
```

`authSocket` valida el token en `socket.handshake.auth.token` y rellena `socket.data` (userId/sessionId). Nunca confíes en un id que venga en el payload del evento sin cruzarlo contra `socket.data`.

## Gotchas que muerden

- **Rooms, no broadcast global.** `io.emit` manda a todos los conectados; usa `io.to(room)` / `socket.to(room)` para no filtrar datos entre sesiones/tenants.
- **`socket.emit` vs `io.to(...).emit`.** `socket.emit` responde solo al emisor; para incluirte y al resto del room usa `io.to(room)`, para excluirte usa `socket.to(room)`.
- **Listeners colgados.** Toda suscripción/intervalo creado en `connection` se limpia en `disconnect`, o se filtra memoria.
- **Errores.** Un throw dentro de un handler no llega al cliente: reporta vía el callback `ack` o un evento `error:*`, nunca dejes la promesa sin catch.
- **Auth en el handshake**, no por evento — rechaza en el middleware `.use()` antes de `connection`.

## Reglas duras

1. El handler delega al service; nada de queries ni lógica de negocio inline.
2. Identidad desde `socket.data` (poblado en auth), nunca desde el payload.
3. Emite a un room específico; `io.emit` global solo para health/system.
4. Cada `on(...)` con efectos secundarios tiene su cleanup en `disconnect`.
5. Errores al cliente vía `ack`/evento `error`, con el mismo `ApiError` mapeado que HTTP.

## Antes de declarar listo

- Los eventos nuevos validan su input igual que un endpoint HTTP.
- Ningún `io.emit` global salvo señales de sistema; el resto va por room.
- Auth resuelta en el middleware del namespace, no dentro de los handlers.
- `{{qualityGate.fast}}` en verde.
