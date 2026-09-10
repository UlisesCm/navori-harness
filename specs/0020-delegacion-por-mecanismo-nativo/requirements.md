# Delegación por mecanismo nativo — Requirements

## Context

La escalera de ruteo llega al arranque y está verificada como mecanismo (spec 0019,
#631). Aun así, medido sobre las 48 sesiones auditadas: **21 cruzaron el umbral R2**
—4 o más archivos escritos por el hilo principal— y **12 de esas 21 (57%) no
delegaron nada**. La sesión `4935c4d7` de este mismo repo escribió 26 archivos con
cero subagentes, teniendo la escalera entregada como cuerpo.

La documentación de Claude Code explica por qué, y lo dice de frente:

> *"Claude treats them [CLAUDE.md files] as context, **not enforced configuration**."*
>
> *"If the instruction is something that must run at a specific point, write it as a
> **hook** instead. Hooks execute at fixed lifecycle events and apply regardless of
> what Claude decides to do."*
>
> *"**Target under 200 lines** per CLAUDE.md file. Longer files consume more context
> and **reduce adherence**."*
>
> *"Claude uses each subagent's **description** to decide when to delegate... To
> encourage proactive delegation, include phrases like **'use proactively'** in your
> subagent's description field."*

El host expone tres palancas para que la delegación ocurra. navori usa una sola —la
más débil, el contexto de arranque— y la ha estado reforzando durante una semana.
Los datos del repo, verificados:

| Palanca del host | Estado en navori |
|---|---|
| `description` del agente, que el host evalúa por tarea | **0 de 8** agentes declaran cuándo usarlos |
| Contexto a mitad de sesión (`additionalContext`) | **0 hooks** lo usan para ruteo |
| Presupuesto de adherencia del `CLAUDE.md` | **278 líneas** contra el objetivo de 200 |

Las skills, en cambio, **ya cumplen**: 40 de 40 declaran su disparador. Por eso esta
spec no las toca.

## Requirements (EARS)

- **R1** — El sistema SHALL declarar, en el `description` de cada subagente que
  entrega, tanto qué hace el agente como la condición observable que debe
  dispararlo, en la forma que el host evalúa para delegar.

- **R2** — WHEN el hilo principal haya escrito o editado 4 o más archivos distintos
  en una sesión sin que se haya invocado ningún subagente, el sistema SHALL
  entregarle al modelo la regla R2 de la escalera a través del `additionalContext`
  del hook `PostToolUse`.

- **R3** — El aviso de ruteo SHALL ser consultivo: no SHALL bloquear ninguna llamada
  a herramienta, y SHALL emitirse como máximo una vez por sesión.

- **R4** — El `CLAUDE.md` renderizado SHALL mantenerse por debajo de las 200 líneas
  que el host declara como umbral de adherencia.

- **R5** — WHEN se emite el aviso de ruteo, el sistema SHALL registrarlo en el log de
  audit, de modo que la tasa de activación se pueda remedir contra la línea base ya
  escrita en `docs/research/activacion-subagentes-y-skills.md`.
