# Distribución de specs en PRs para agentes: entregas funcionales

**Fecha:** 2026-10-07 · **Estado:** dirección aprobada e implementada en la spec 0044.
**Alcance:** cómo se reparte una spec SDD (y toda spec o parte que genere master-plan) en
milestones, commits y PRs. No cambia EARS, `R<n>` ni la trazabilidad `// Covers: R<n>`.

## Decisión

Modelo híbrido:

- **Spec pequeña o media → 1 PR.** Los milestones son commits dentro del PR.
- **Spec media o grande → 2 a 4 PRs, uno por entrega funcional.** Cada entrega es vertical:
  se puede demostrar y usar por sí sola.

**Lo que se hace pequeño es la verificación, no el PR.**

## Problema medido

Medición de solo lectura sobre `specs/`, 174 PRs mergeados desde el 2026-09-24 y 200 corridas
de CI.

| Spec | Tareas | PRs |
|---|---|---|
| 0039 | 45 | 32 (~28% sin comportamiento en runtime: docs, solo tests, cambio de estado) |
| 0041 | 21 | 14, el mismo día, con ramas apiladas y PR de reintegración (#1186) |
| 0034 | 21 | 10, más #1091 que volvió a entregar +11,613 líneas desde una rama de integración |
| 0035, 0040, 0043 | 7–14 | 1 |

Ninguna regla pide un PR por lote. Los micro-PRs salen de la suma de cuatro reglas:

1. tareas en lotes de 1–3 (`core-assets/skills/spec-bootstrap.md:43`, `core-assets/managed/sdd.md:5`);
2. `implementer` → `reviewer` en cada lote (`core-assets/managed/orquestacion.md:24`);
3. gate completo en cada revisión, re-revisión y re-firma delta (`core-assets/agents/reviewer.md:51,119`);
4. receipt atado a los bytes exactos de cada commit (`core-assets/agents/publisher.md:82-123`).

Cada PR paga unos 10 gates en serie: plan, implementer, handoff check, scribe, reviewer en dos
pasadas, gate completo, receipt, pre-commit, publisher y CI. Ese costo no compra atención
humana: los 174 PRs tienen 0 reviews en GitHub y una mediana de 6.8 min entre apertura y merge.
El 36% de los PRs mergeados son `fix`.

## Línea base 0039/0041

| Spec | Tareas | PRs |
|---|---|---|
| 0039 | 45 | 32 |
| 0041 | 21 | 14 |

## Evidencia externa (resumen)

- **Proveedores:** Copilot, Devin, Codex y Anthropic abren un PR por tarea o por corrida y
  manejan la granularidad con milestones y commits dentro de la corrida (ExecPlans de OpenAI,
  harness de larga duración de Anthropic). Anthropic retiró sus sprints por feature en
  marzo de 2026 (Opus 4.6) porque "codificaban limitaciones del modelo que quedaron obsoletas".
- **Herramientas SDD:** ninguna ata un PR a cada historia. spec-kit es la más cercana a slices
  verticales: historias P1/P2/P3 "independientemente probables", con checkpoint por historia.
- **Críticas a SDD** (Böckeler en martinfowler.com, Thoughtworks Radar, Marmelab): demasiados
  archivos, revisión más cara y "sledgehammer to crack a nut" en cambios chicos.
- **DORA 2024/2025:** los lotes pequeños importan más con IA. Se cumple en la verificación
  frecuente, no en el número de PRs.
- **METR:** la confiabilidad del agente decae con la duración de la tarea. Eso acota el
  milestone, no el PR.
- **PRs de agentes (AIDev, MSR'26):** los más chicos se mergean más, y cada comentario de
  revisión extra baja 2.8% la probabilidad de merge. Conviene verificar bien antes del PR, no
  abrir más PRs.

Limitaciones: parte de las cifras de DORA 2025 y METR 2026 viene de fuentes secundarias, y
ningún estudio compara de frente un PR largo de agente contra varios cortos.

## Reglas

| # | Regla |
|---|---|
| 1 | **Cuándo partir.** Solo si la spec tiene **≥2 capacidades demostrables por separado** *y* rebasa el umbral de tamaño (**>12 tareas o >~1,500 LOC estimadas**). Si cumple solo una condición, va en 1 PR. |
| 2 | **Tope de PRs.** Máximo **4 PRs por spec**. Si salen más, se parte la spec en varias specs. |
| 3 | **Entrega vertical.** Cada entrega cambia comportamiento observable y declara su aceptación (comando y salida esperada). No hay PRs solo de docs, solo de tests ni solo de schema. |
| 4 | **Excepción foundation.** La primera entrega puede ser un contrato compartido solo si al menos un consumidor real lo usa en el mismo PR. |
| 5 | **Sin rama de integración.** Cada entrega mergea en orden a la branch destino del repo (`prTarget` en `navori.config.json`: `main`, `dev` o `develop`). |
| 6 | **Gate proporcional.** Dentro del PR, cada milestone pasa tests dirigidos y un gate acotado al diff (`scoped-gate`). El gate completo corre **una vez por PR**, sobre los bytes que se publican. |
| 7 | **Cierre del issue.** Los PRs intermedios llevan `Refs #N` y el último `Closes #N`. Con 1 PR, ese PR cierra el issue. |

La clasificación la calcula navori a partir de `requirements.md` y `tasks.md`, igual que
`navori plan classify`. No la decide el agente.

### Umbrales configurables

Los valores iniciales se calibran por repo desde `navori.config.json`. Forma tentativa, que la
spec define:

```json
{
  "sdd": {
    "deliveries": {
      "splitMinTasks": 12,
      "splitMinLoc": 1500,
      "maxPrsPerSpec": 4
    }
  }
}
```

## Forma de `tasks.md`

Deja de organizarse en "lotes de 1–3 tareas" y pasa a entregas y milestones:

```
E1 — <capacidad demostrable>            → PR 1 (o el único PR)
  M1 — <milestone vertical>             → commit
    aceptación: A1 = <comando> → <salida esperada>
    T1 (R1, R2), T2 (R3)
  M2 — ...
E2 — <capacidad demostrable>            → PR 2
  ...
```

- `T<n>` sigue siendo la unidad de trazabilidad hacia `R<n>`.
- El milestone (`M<n>`) es la unidad de verificación y de commit.
- La entrega (`E<n>`) es la unidad de PR.

Usa el mismo vocabulario que el modo entregas de master-plan (`E<n>`, `P<n>`, `A<n>`; PR #1228),
sin un formato nuevo.

## Master-plan

Toda spec o parte que genere master-plan sigue esta misma filosofía. Una etapa de master-plan
produce specs que se clasifican con la regla 1 y se reparten con las reglas 2–7. Las entregas
`E<n>` del modo entregas ya son la unidad de PR. Lo que falta es que la skill `master-plan` y
las plantillas lo digan y lo apliquen.

## Superficies que tocaría la spec

- `docs/DIRECTION.md`: el invariante o la sección de planificación que fija la unidad de PR.
  Requiere spec, según "Qué requiere discusión antes de cambiarse".
- `core-assets/skills/spec-bootstrap.md` y `core-assets/managed/sdd.md`: reemplazar "lotes de
  1–3" por entregas y milestones.
- `core-assets/managed/orquestacion.md`, `core-assets/agents/reviewer.md` y `publisher.md`:
  gate completo una vez por PR, y gate acotado en re-revisiones y re-firmas.
- `core-assets/skills/master-plan.md` y las plantillas `master-plan/*`: aplicar la clasificación
  a las specs que generan.
- CLI: comando de clasificación de spec y lectura de `sdd.deliveries` en el schema de config.

## Tabla de calibración

| Spec | Entregas | PRs | LOC | Observación |
|---|---|---|---|---|
| 0039 / 0041 | — | 32 / 14 | — | línea base |
| 0044 | 3 | — | — | pendiente tras el merge |

Evidencia: [`distribucion-entregas-agentes-evidencia.md`](distribucion-entregas-agentes-evidencia.md).

## Calibración

Antes de fijar los umbrales como default, medir en las primeras 2–3 specs contra la línea
base de 0039 y 0041:

- corridas del gate completo, corridas de CI y plan gates por spec;
- tiempo de reloj desde el inicio hasta el merge;
- PRs `fix` en las 72 h siguientes al merge;
- rondas de `CHANGES_REQUESTED` por milestone;
- tamaño máximo de diff que el reviewer agente verifica bien (hoy no hay dato);
- tokens (cache read) por spec, no por lanzamiento.

## Preguntas abiertas para la spec

1. **LOC estimadas antes de codear.** ¿De dónde sale la cifra: archivos del workplan, conteo
   de tareas o estimación declarada en `tasks.md`?
2. **Reviewer por milestone.** ¿Basta con evidencia `A<n>` más el gate acotado, o hace falta un
   reviewer de cumplimiento por milestone? Lo resuelve el piloto.
3. **Gate completo de más de 10 min.** `bun run check` tarda ~11 min y rebasa el tope de Bash
   de Claude Code, así que el hook no puede registrar su evidencia. ¿Correrlo partido, o aceptar
   evidencia de CI con su `run id`?
4. **Specs ya abiertas.** ¿La regla aplica solo a specs nuevas o también a las que están en curso?
