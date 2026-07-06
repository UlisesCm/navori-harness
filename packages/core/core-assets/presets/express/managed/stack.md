## Stack — Express (TypeScript)

Backend HTTP sobre Express en TypeScript, agnóstico de base de datos (Socket.IO, PeerJS, DB nativo, sin DB, etc.). Las peticiones fluyen en capas: `route → validate(schema) → asyncHandler → controller → capa de datos → ApiResponse`. Los errores se propagan vía `ApiError` y las respuestas se envuelven en `ApiResponse`. El logging va por el `Logger` de winston, nunca `console.log`.

Regla de oro: nada de `res.json` / `res.status(500)` crudos; nada de `console.log`; nada de `process.env` fuera del módulo de config. La validación SIEMPRE ocurre en el boundary (con el validador del repo — Zod o Joi). Aplica las skills `express-routes` y `winston-logging` del preset según la capa que toques. Las skills de la capa de datos (mongoose, socketio, etc.) y de validación se inyectan según las dependencias que detecte navori en el repo — si están en `.claude/skills/`, aplícalas.

El trabajo de un ticket sigue el pipeline documentado en la skill `ticket-intake` (la orquestadora). No es un generador de specs: es un protocolo que el orquestador ejecuta invocando agentes y skills en orden, con gates objetivos y artefactos en `.claude/progress/`. Mapeo de fases a la infraestructura de navori:

| Fase | Quién la cubre | Artefacto |
|---|---|---|
| Audit | agente `ticket-audit` | `audit_<id>.md` |
| Explore | agente `explorer` (2-3 en paralelo) | `explore_<dim>.md` |
| Design | skill `new-endpoint` según alcance | (en el plan) |
| Implement | agente `implementer` (aplica las skills de stack) | `impl_<feature>.md` |
| Verify | skill core `verify-before-done` (Iron Law) | (evidencia en turno) |
| Review | agente `reviewer` + skill core `review-diff` | `review_<feature>.md` |
| Debug | skill core `loop-back-debug` | — |
| PR | skill `pr-create` | URL del PR |

navori bootstrapea `current.md` e `history.md`; el resto de artefactos los crea el flujo en runtime.
