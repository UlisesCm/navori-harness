# Admisión y retiro de agentes — Requirements

**Status:** aprobada (2026-09-23) · **Fecha:** 2026-09-23 · **Base revisada:** `8d8e3a4e`

- **Origen:** decisión del usuario del 2026-09-23: un agente se justifica solo si garantiza código
  de más calidad, más velocidad o ahorro de tokens; si no, navori lo trata como prescindible.
- **Fuentes y cifras:** `design.md`, "Evidencia".

## Context

`DIRECTION.md` ordena las metas (**calidad > tokens > velocidad**) y tiene un criterio de admisión
por superficie (reglas always-on → skill → MCP → CLI → API), pero **no menciona agentes**. Hoy
las piezas de un criterio existen dispersas y nunca se juntaron en una regla:

- La doctrina de orquestación: para leer, un subagente es "solo una palanca de escala"
  (`managed/orquestacion.md`).
- El arranque en frío de un subagente, ~25k tokens a precio de `cache_creation`, que retiró las
  tareas T2–T4 de la spec 0027 porque costaba más que el artefacto de ~2k que producía.
- El único criterio de retiro escrito: 60 días sin ciclos → evaluar `architect` para
  `RETIRED_AGENTS` (spec 0026, criterio 2).
- El rollout apagado por default de `architect` (`schema.ts`).

Sin una regla, un agente entra porque "suena útil" y se queda aunque nadie lo invoque: `scribe`
salió habilitado por default y quedó sin trabajo al retirarse T2–T4.

## Requirements (EARS)

- **R1** — `DIRECTION.md` DEBERÁ declarar que un agente (del core o de un preset) es
  admisible solo si garantiza al menos una de estas tres cosas, y que si no garantiza ninguna es
  prescindible:
  - **Calidad:** un resultado verificablemente mejor que el que obtendría el hilo principal. Las
    fuentes admitidas son verificación independiente en contexto fresco, un tier de modelo que el
    orquestador no puede fijarse a sí mismo, o un contexto especializado que el hilo principal no
    debe cargar.
  - **Velocidad:** menos tiempo total por fan-out paralelo sobre trabajo independiente.
  - **Tokens:** ahorro **neto** del arranque en frío, ya sea porque saca del contexto principal
    salida voluminosa que no se vuelve a leer o porque corre trabajo mecánico en un tier más
    barato.
- **R2** — El orden de prioridad DEBERÁ aplicarse entre ejes: una ganancia en un eje NO DEBERÁ
  pagarse con un eje de mayor prioridad. Ejemplo: implementers en paralelo que degradan la calidad
  no son admisibles por velocidad.
- **R3** — CUANDO se proponga un agente nuevo, la propuesta DEBERÁ declarar:
  - qué garantía de R1 da y la señal con que se mide;
  - su costo de arranque frente a lo que produce;
  - un criterio de retiro con plazo (por ejemplo, N días sin invocaciones → `RETIRED_AGENTS`).
- **R4** — Un agente nuevo DEBERÁ salir apagado por default hasta que su señal de R3 lo sostenga.
- **R5** — El roster vigente DEBERÁ evaluarse contra R1–R2. Un agente que no pase DEBERÁ
  proponerse para retiro en un ticket propio; esta spec no retira ninguno.
- **R6** — navori-harness DEBERÁ incluir una skill project-local `author-agent` que aplique R1–R4
  al proponer o revisar un agente. La skill DEBERÁ cubrir el contrato por engine (Claude `.md`,
  Codex `.toml`, y que DeepSeek no tiene archivo de agente declarativo) y la lista de piezas que
  navori exige tocar al sumar un agente.
- **R7** — CUANDO una propuesta amplíe el trabajo de un agente existente (por ejemplo, #985:
  `scribe` dueño de todo el Markdown), la ampliación DEBERÁ pasar R1–R3 antes de implementarse,
  con el arranque en frío de cada delegación contado en el eje de tokens.

## Fuera de alcance

- Retirar agentes. R5 solo produce la evaluación y los tickets.
- Un mecanismo `project.localAgents`.
- Cambiar el criterio de admisión de skills, MCP o plugins.
