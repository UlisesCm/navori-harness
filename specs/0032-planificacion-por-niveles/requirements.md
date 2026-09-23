# Planificación por niveles — Requirements

**Status:** borrador · **Fecha:** 2026-09-23 · **Base revisada:** `a717d440`

- **Origen:** pedido del usuario del 2026-09-23: la planificación hoy es prosa en el chat y no se
  ve un plan claro durante el desarrollo. Quiere más formalidad, sin plan para lo muy simple, con
  un plan simple o uno avanzado para lo demás, y el `architect` dentro del plan avanzado.
- **Fuentes:** `design.md`, "Evidencia".

## Context

El orquestador descompone y coordina, pero el plan que presenta al usuario no tiene formato ni
deja rastro verificable:

- No existe un artefacto de plan para el trabajo que no es SDD. Solo SDD tiene trazabilidad
  (`R<n>` ↔ test), y SDD es opt-in para alcance real; entre "typo" y "spec" hay un hueco.
- El `reviewer` juzga el diff contra `CLAUDE.md` y el gate, no contra lo que se planeó: nadie
  verifica que el resultado cumpla lo prometido ni que no se salga del alcance.
- La tabla de señales de `managed/orquestacion.md` ya separa el trabajo con señal arquitectónica
  del que no la tiene, pero esa separación decide cuánto se **lee**, no cómo se **planea**.
- El agente `architect` existe en el roster, apagado por default (`harness.architect`), y en este
  repo no está renderizado; la pasada arquitectónica la hace el orquestador con `solution-design`.
- El nombre `.claude/progress/plan_<scope>.md` ya lo usa el plan priorizado del `auditor` en su
  encargo de área.

## Requirements (EARS)

### Niveles

- **R1** — El bloque de orquestación DEBERÁ clasificar toda tarea que cambia fuente en uno de
  cuatro niveles de planificación, cada uno con su señal verificable:
  - **Nivel 0 · directo:** la tarea toca un solo archivo y no dispara ninguna fila de la tabla de
    señales (por ejemplo typo, copy, color).
  - **Nivel 1 · plan simple:** la tarea no es nivel 0 y no dispara la fila arquitectónica.
  - **Nivel 2 · plan avanzado:** la tarea dispara la fila arquitectónica de la tabla de señales.
  - **Nivel 3 · SDD:** la tarea cruza el umbral del bloque SDD y el usuario aceptó la spec.
- **R2** — CUANDO el orquestador clasifique una tarea, DEBERÁ decirle al usuario en una línea el
  nivel elegido y la señal que lo decidió, antes de escribir el plan.
- **R3** — CUANDO el usuario pida un nivel mayor que el clasificado, el orquestador DEBERÁ usar el
  nivel pedido.
- **R4** — SI el usuario pide un nivel menor que el clasificado y la tarea dispara la fila de área
  crítica, ENTONCES el orquestador DEBERÁ mantener el nivel clasificado y decir por qué.
- **R5** — Una tarea de nivel 0 NO DEBERÁ requerir artefacto de plan; su encargo al `implementer`
  sigue siendo el de hoy.
- **R6** — Una tarea de nivel 3 DEBERÁ usar `specs/<feature>/tasks.md` como plan y NO DEBERÁ
  producir además un `workplan`.

### El artefacto de plan

- **R7** — CUANDO una tarea sea de nivel 1 o 2, el orquestador DEBERÁ escribir
  `.claude/progress/workplan_<feature>.md` antes de pedir la aprobación del usuario, con un
  encabezado que declare el nivel.
- **R8** — Un `workplan` de nivel 1 DEBERÁ contener estas secciones:
  - **Objetivo:** una línea con el resultado observable.
  - **Criterios de aceptación:** de 1 a 5 criterios con id `A<n>`, cada uno con un comando y la
    salida esperada de ese comando.
  - **Fuera de alcance:** al menos un elemento.
  - **Archivos:** los archivos que se tocarán, medidos en el repo, no supuestos.
  - **Progreso:** el estado de cada `A<n>` (`pendiente`, `cumplido` o `bloqueado`).
  - **Decisiones:** los cambios respecto al plan aprobado, con su motivo.
- **R9** — Un `workplan` de nivel 2 DEBERÁ contener además:
  - **Solución:** el path al `solution_<scope>.md` de la pasada arquitectónica y el veredicto
    (READY, CONCERNS o BLOCKED) del orquestador.
  - **Fases:** los lotes de trabajo en orden, cada uno con los `A<n>` que cubre.
  - **Riesgos y rollback:** al menos un riesgo con su forma de revertir.
- **R10** — MIENTRAS se ejecute una tarea de nivel 1 o 2, el orquestador DEBERÁ actualizar las
  secciones Progreso y Decisiones del `workplan` al cerrar cada sub-tarea, y
  `progress/current.md` DEBERÁ apuntar al `workplan` activo en lugar de copiar su contenido.
- **R11** — SI durante la ejecución un cambio necesario queda fuera de los Archivos o del Fuera de
  alcance aprobados, ENTONCES el orquestador DEBERÁ registrarlo en Decisiones y consultarlo con el
  usuario antes de despacharlo.

### Validación determinista

- **R12** — navori DEBERÁ exponer el comando `navori plan check <archivo>` que valide un
  `workplan` contra R8 y, cuando el encabezado declare nivel 2, también contra R9.
- **R13** — `navori plan check` DEBERÁ salir con código distinto de cero y nombrar cada falla
  cuando:
  - falte una sección requerida por el nivel declarado;
  - un `A<n>` no tenga comando o no tenga salida esperada;
  - los ids `A<n>` estén repetidos o no sean consecutivos desde `A1`;
  - un archivo de la sección Archivos no exista y no esté marcado como nuevo;
  - quede un marcador `[NEEDS CLARIFICATION]`;
  - en nivel 2, el `solution_<scope>.md` citado no exista.
- **R14** — CUANDO un `workplan` pase la validación, `navori plan check` DEBERÁ salir con código
  cero.
- **R15** — El orquestador DEBERÁ correr `navori plan check` sobre el `workplan` y tenerlo en
  verde antes de pedir la aprobación del usuario.

### Consumo aguas abajo

- **R16** — CUANDO el orquestador despache al `implementer` una tarea de nivel 1 o 2, el encargo
  DEBERÁ incluir el path del `workplan` y los `A<n>` que esa sub-tarea cubre.
- **R17** — CUANDO el `implementer` cierre una sub-tarea con `A<n>` asignados, su
  `impl_<feature>.json` DEBERÁ incluir la clave `acceptance`: por cada `A<n>`, el comando
  ejecutado, su código de salida y un extracto de la salida.
- **R18** — CUANDO el `reviewer` revise una tarea de nivel 1 o 2, DEBERÁ emitir
  `CHANGES_REQUESTED` si algún `A<n>` asignado no tiene evidencia en `acceptance` o si el diff
  toca un archivo fuera de la sección Archivos sin una entrada en Decisiones que lo cubra.

### El architect en el plan avanzado

- **R19** — CUANDO una tarea sea de nivel 2 y `harness.architect` sea `true`, el orquestador
  DEBERÁ despachar al `architect` para producir `solution_<scope>.md`, luego al `auditor` para el
  challenge, y solo después de su veredicto escribir el `workplan`.
- **R20** — CUANDO una tarea sea de nivel 2 y `harness.architect` sea `false`, el orquestador
  DEBERÁ aplicar `solution-design` por sí mismo, como hoy, antes de escribir el `workplan`.
- **R21** — El `architect` NO DEBERÁ escribir el `workplan` ni descomponer en tareas; su salida
  sigue siendo solo `solution_<scope>.md`.
- **R22** — Esta spec DEBERÁ declarar, según la spec 0031 R3, la garantía de encender
  `harness.architect` en este repo, la señal que la mide, su costo frente a lo que produce y un
  criterio de retiro con plazo.

### Rollout

- **R23** — El comportamiento de R1–R21 DEBERÁ quedar detrás de `harness.planTiers`, default
  `false`: MIENTRAS sea `false`, los contratos renderizados DEBERÁN comportarse como antes de esta
  spec; CUANDO sea `true`, aplican R1–R21. `navori plan check` existe con cualquier valor.
- **R24** — Este repo DEBERÁ encender `harness.planTiers` y `harness.architect` en su
  `navori.config.json`.

## Fuera de alcance

- Un gate duro que bloquee al `implementer` sin plan aprobado (hook o firma tipo
  `receipt.txt`). Se evalúa con la evidencia de esta spec; ver `design.md`, "NOT in scope".
- Trazabilidad `A<n>` → test con `// Covers: A<n>`. Ese nivel de rigor ya es SDD.
- Un agente planificador. El plan es del orquestador; ver `design.md`, "Decisiones".
- Renombrar el `plan_<scope>.md` del `auditor`.
