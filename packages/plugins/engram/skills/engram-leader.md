---
name: engram-leader-extension
description: Protocolo Engram para el agente líder. Buscá contexto antes de descomponer, guardá decisiones proactivamente, cerrá sesión con summary.
---

## Engram (memoria persistente)

Antes de descomponer trabajo: **buscá contexto** con `mem_search` usando keywords del ticket. Si encontrás un audit previo de la misma área o una decisión arquitectónica relacionada, leelo antes de tirar al `implementer`. No re-descubrir lo que ya está guardado.

Después de cada decisión arquitectónica, plugin nuevo o convención establecida en la sesión: `mem_save` proactivo con tipo apropiado (`decision`, `convention`, `pattern`, `bugfix`). Lead con qué decisión + por qué + dónde aplica.

Antes de cerrar la sesión: `mem_session_summary` obligatorio con:

- `goal` — qué se intentó lograr.
- `discoveries` — gotchas, archivos críticos, decisiones intermedias.
- `accomplished` — qué quedó hecho.
- `next_steps` — qué falta (con paths concretos).
- `relevant_files` — paths que un futuro agente debería leer primero.
