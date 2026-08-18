---
name: socketio-client
description: Use when a component subscribes to realtime events — Socket.IO on the CLIENT: subscribing inside an effect, named handlers, cleanup, module singletons, and reconnection.
type: reference
---

# Socket.IO client — conventions

## When to use this skill

When a component or hook listens to a realtime event, or when a screen shows data that arrives by socket. The bugs here are not about the protocol: they are about WHERE the subscription is registered and WHETHER it is removed.

## The pattern

Subscribe inside an effect, with a **named** handler, and remove exactly that handler on cleanup:

```tsx
useEffect(() => {
  const onSessionUpdate = (payload: SessionUpdate): void => {
    if (payload.sessionId !== sessionId) return;  // the guard goes FIRST
    setSession(payload.session);
  };

  socket.on("session:update", onSessionUpdate);
  return () => {
    socket.off("session:update", onSessionUpdate);  // same reference, or it isn't removed
  };
}, [sessionId]);
```

## Gotchas that bite

- **`socket.on()` in the component body registers a new listener on EVERY render.** None is ever removed. The subscription belongs in an effect, never in the render path.
- **A module singleton (`const socket = io(URL)` at the top level) makes the leak permanent.** The instance outlives every unmount, so orphan handlers accumulate for the whole session: when the event arrives it runs N times, N = accumulated renders. Local state, network calls and toasts all fire N times.
- **An anonymous handler cannot be removed.** `socket.off("event")` with no reference kills OTHER components' listeners too; `off` with a different arrow function removes nothing. Name the handler and pass the same reference to `on` and `off`.
- **Missing deps capture stale values.** A handler that closes over `sessionId` and never re-subscribes keeps comparing the first one. Complete deps, or read from a ref.
- **The "is this for me?" guard goes BEFORE the `setState`.** A broadcast reaches everyone; without the guard you rewrite state for users who weren't the target.
- **`connect`/`disconnect`/`connect_error` are events too.** They need the same cleanup, and they're where the "reconnecting" UI and the post-reconnect refetch belong.
- **Reconnecting does NOT replay what you missed.** On `connect` (after the first one) refetch the state you may have lost, or the UI stays silently stale.

## Hard rules

1. Subscription inside an effect (or a hook that owns it), never in the component body.
2. Named handler + `off` with the SAME reference in the cleanup.
3. Complete deps, or a ref, so the handler never reads stale values.
4. Recipient guard before touching state.
5. Reconnection resyncs: refetch on `connect`, don't assume continuity.

## Before declaring done

- Mount/unmount the screen several times: the handler count doesn't grow.
- The event arriving twice doesn't duplicate UI effects.
- Losing the connection and getting it back leaves consistent data.
- `{{qualityGate.fast}}` green.

<!-- navori:user-section -->
## This repo's realtime layer (your domain)

<!-- user: add here what only applies to THIS repo. Suggestions:
     - Where the socket instance lives (module singleton, context, hook) — this decides whether a listener leaks per mount or for the whole session.
     - The events the UI listens to and what each updates.
     - The 'is this for me?' guard each handler needs BEFORE touching state.
     - What the UI does on disconnect/reconnect (refetch, banner, queued state).
-->
