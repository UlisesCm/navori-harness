---
name: socketio
description: Use when touching realtime, gateways, or socket handlers — Socket.IO patterns in a Node service: namespaces, rooms, auth at the handshake, typed events, cleanup.
type: reference
---

# Socket.IO — service conventions

## When to use this skill

When adding or touching realtime: a namespace, an event, connection authentication, or a broadcast to a room. Socket.IO over Express's HTTP server. Base rule: the socket handler is a transport layer, not a business one — it delegates to the same service/controller the HTTP routes use.

## The pattern

```ts
io.of('/sessions').use(authSocket).on('connection', (socket) => {
  socket.join(`session:${socket.data.sessionId}`);

  socket.on('message:send', async (dto, ack) => {
    try {
      const saved = await messageService.create(socket.data.userId, dto);
      io.to(`session:${socket.data.sessionId}`).emit('message:new', saved); // room from socket.data, not the payload
      ack?.({ ok: true, id: saved._id });
    } catch (err) {
      ack?.({ ok: false, error: toClientError(err) });
    }
  });

  socket.on('disconnect', () => { /* cleanup timers/subscriptions */ });
});
```

`authSocket` validates the token in `socket.handshake.auth.token` and fills `socket.data` (userId/sessionId). Never trust an id coming in the event payload without cross-checking it against `socket.data`.

## Gotchas that bite

- **Rooms, not global broadcast.** `io.emit` sends to everyone connected; use `io.to(room)` / `socket.to(room)` to avoid leaking data across sessions/tenants.
- **`socket.emit` vs `io.to(...).emit`.** `socket.emit` replies to the emitter only; to include yourself and the rest of the room use `io.to(room)`, to exclude yourself use `socket.to(room)`.
- **Dangling listeners.** Every subscription/interval created in `connection` is cleaned up on `disconnect`, or memory leaks.
- **Errors.** A throw inside a handler doesn't reach the client: report via the `ack` callback or an `error:*` event, never leave the promise without a catch.
- **Auth at the handshake**, not per event — reject in the `.use()` middleware before `connection`.
- **Type the `Server`/`Socket`** with the 4 interfaces (`Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>`): autocompletion and type-check of payloads and acks. `socket.data` is typed via `SocketData`, not `any`.
- **Multi-instance ⇒ adapter (Redis) + sticky sessions.** Without an adapter, `io.to(room)` only reaches sockets on **this** process (broadcasts lost when scaling); without sticky, long-polling gives "Session ID unknown".
- **Acks that expect a reply use a timeout**: `socket.timeout(ms).emitWithAck(...)`. Without a timeout, a missing ack hangs/leaks.

## Hard rules

1. The handler delegates to the service; no inline queries or business logic.
2. Identity from `socket.data` (populated in auth), never from the payload.
3. Emit to a specific room; global `io.emit` only for health/system.
4. Every `on(...)` with side effects has its cleanup in `disconnect`.
5. Errors to the client via `ack`/`error` event, with the same `ApiError` mapping as HTTP.

## Before declaring done

- New events validate their input just like an HTTP endpoint.
- No global `io.emit` except system signals; the rest goes by room.
- Auth resolved in the namespace middleware, not inside the handlers.
- `{{qualityGate.fast}}` green.
