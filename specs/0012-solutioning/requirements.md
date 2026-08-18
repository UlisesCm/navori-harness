# Spec 0012 — Capa de Solutioning · Requirements

**Estado:** en revisión (GATE H1) · **Fecha:** 2026-08-18
**Plan de ejecución:** [`plan.md`](./plan.md) · **Diseño:** [`design.md`](./design.md)

## Contexto

Entre *entender un problema* y *convertirlo en tareas de implementación* no hay
gate. `ticket-intake` fase 4 (DESIGN) es una línea opcional; `spec-bootstrap`
produce `design.md` sin exigir failure modes, contratos ni estrategia de testing.
El resultado observado: la solución que trae el ticket se hereda sin evaluarse, la
arquitectura se inventa en vez de extender lo existente, y cuatro fases de
ejecución con gates duros pulen una solución equivocada — lento *y* deficiente.

La fase 0 (PR #332) ya cubrió la ENTRADA: veredicto del ticket, problema vs
solución propuesta, tamaño verificado. Esta spec cubre lo siguiente: **dada esa
evidencia, qué construimos y por qué** — y cómo se desafía esa decisión antes de
escribir código.

## Requirements (EARS)

### Activación y ruteo

**R1** — WHEN una tarea presenta al menos una señal architectural, THE SYSTEM
SHALL producir un artefacto de diseño de solución antes de descomponer en tareas
de implementación.

**R2** — THE SYSTEM SHALL reconocer como señales architectural únicamente:
nueva abstracción compartida · cambio de ownership de estado · contrato compartido
(API/DTO/schema/evento) · migración o cambio de schema · dependencia externa nueva
· concurrencia o sincronización de estado · área crítica declarada en
`project.criticalAreas` · decisión difícil de revertir · existencia de ≥2 enfoques
viables genuinos. El número de archivos SHALL ser señal secundaria, nunca
definición de complejidad.

**R3** — WHEN una tarea no presenta ninguna señal de R2, THE SYSTEM SHALL NOT
producir artefacto de solutioning ni pasos adicionales de diseño (cero ceremonia
en R1 y en R2 de patrón conocido).

**R4** — WHEN el veredicto de `ticket-audit` es `proceed-differently` AND existe
al menos una señal de R2, THE SYSTEM SHALL activar la fase de diseño de solución.

### Contenido del diseño

**R5** — THE SYSTEM SHALL producir evidencia (`file:line` o salida de comando) de
los patrones ya existentes en el repo que resuelven total o parcialmente el
problema, ANTES de proponer arquitectura nueva.

**R6** — THE SYSTEM SHALL preferir, salvo evidencia contraria documentada, el
orden: patrón existente > extensión pequeña > abstracción nueva > subsistema nuevo.

**R7** — El artefacto de solución SHALL contener una sección de alcance excluido
(NOT in scope) con el trabajo diferido y su razón.

**R8** — WHEN existen ≥2 enfoques viables genuinos, THE SYSTEM SHALL documentar
sus tradeoffs y justificar el elegido incluyendo por qué NO los otros. WHEN existe
un único enfoque razonable, THE SYSTEM SHALL NOT generar alternativas artificiales.

**R9** — THE SYSTEM SHALL incluir las dimensiones condicionales (boundaries y
contratos, failure modes, migración/compatibilidad, estrategia de testing) SOLO
cuando la señal que activó el solutioning las haga relevantes, y SHALL NOT emitir
secciones vacías.

**R10** — WHEN el artefacto declara estrategia de testing, cada prueba nombrada
SHALL responder a un riesgo concreto identificado en el diseño.

### Challenge y veredicto

**R11** — THE SYSTEM SHALL someter el artefacto de solución a UNA ronda de
challenge ejecutada en contexto fresco, con encargo de falsificación (no de
mejora estética).

**R12** — THE SYSTEM SHALL emitir exactamente uno de tres veredictos: `READY`,
`CONCERNS` o `BLOCKED`.

**R13** — WHEN el veredicto es `CONCERNS`, THE SYSTEM SHALL registrar los concerns
en el artefacto y proceder a implementar. `CONCERNS` SHALL NOT bloquear.

**R14** — WHEN el veredicto es `BLOCKED`, cada blocker SHALL declarar los cuatro
campos: hecho bloqueante, por qué no se puede proceder sin adivinar, dueño de la
resolución, e información mínima necesaria. IF no puede declarar los cuatro, THEN
no es `BLOCKED`.

**R15** — THE SYSTEM SHALL NOT bloquear por: preferencia de nomenclatura,
abstracción futura hipotética, optimización menor, edge case opcional, ni
preferencia estilística de arquitectura.

**R16** — THE SYSTEM SHALL ejecutar como máximo una ronda de challenge por
artefacto. WHEN una decisión de alcance ya fue aceptada o rechazada, THE SYSTEM
SHALL NOT re-argumentarla en fases posteriores.

**R17** — THE SYSTEM SHALL solicitar decisión humana únicamente ante: veredicto
`BLOCKED`, fork arquitectónico irreversible, o cambio mayor de alcance respecto a
lo aprobado.

### Ambigüedad

**R18** — WHEN el diseño encuentra una ambigüedad, THE SYSTEM SHALL clasificarla y
actuar en consecuencia: resoluble leyendo el repo → investigarla; de producto o
humana → preguntarla; no bloqueante → asumir lo conservador y **registrar la
asunción** en el artefacto.

### Descomposición

**R19** — Las tareas derivadas de un diseño SHALL nombrar el comportamiento
observable y la evidencia esperada, y SHALL NOT contener placeholders ("TBD",
"implement later", "add appropriate error handling", "similar to Task N") ni
prescribir el código línea por línea.

**R20** — WHEN una decisión de arquitectura cambia las fronteras naturales de las
tareas, THE SYSTEM SHALL fijar el diseño antes de la descomposición fina.

### Costo

**R21** — El costo always-on de esta capa (texto añadido al bloque managed de
orquestación) SHALL NOT exceder 120 palabras; el resto del contenido SHALL vivir
en assets cargados on-demand.

## Trazabilidad `R<n>` ↔ evidencia

Esta spec modifica prompts de agentes, no lógica ejecutable: la mayoría de los
requirements no son verificables con un test unitario. La evidencia se divide:

| Tipo | Requirements | Cómo se verifica |
|---|---|---|
| Invariante de contenido | R2, R7, R12, R14, R15, R18, R19 | Test de fragmentos en el asset (`toContain` de tokens cortos, nunca párrafos) |
| Presupuesto medible | R21 | `wc -w` sobre el delta del bloque; test de cap para las skills |
| Registro/render | R1, R4 | Suite existente: `catalog.test.ts`, `skill-caps.test.ts`, `core-lean.test.ts` + render de prueba |
| Conductual | R3, R5, R6, R8, R9, R10, R11, R13, R16, R17, R20 | Evals de presión RED/GREEN (ver `plan.md` §7): baseline sin la capa vs. comportamiento con ella |

**Nota de método (superpowers `writing-skills`):** el baseline RED se observa
ANTES de escribir la skill — "no skill without a failing test first". El baseline
del Escenario A (BTBS-162) se corre en F2, no en F5.
