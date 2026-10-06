# Claude first — Requirements

**Fecha:** 2026-09-30 · **Estado:** implementada (2026-10-06). Cierre en #1238; el veredicto medido de R43 sigue en #1177 ([claude-first-verificacion](../../docs/research/claude-first-verificacion.md)).
**Base del checkout:** `01f3ac97` (`origin/main`).
**Evidencia:** [evidence.md](evidence.md). Contiene la auditoría del 2026-09-30 sobre 127
sesiones, el inventario de capacidades nativas por verificar y la investigación del curso
`walkinglabs/learn-harness-engineering` contrastada con la documentación oficial de Claude Code y
Codex.

**Absorbe** el borrador de la spec 0038 "aprendizajes del curso de harness engineering", que nunca
se commiteó. Sus requisitos se conservan con numeración nueva: la tabla de equivalencias está al
final. Su diseño y su challenge (`.navori/state/handoffs/challenge_0038.md`) siguen vigentes para
esos grupos.

## Context

La auditoría del 2026-09-30 confirma, en las dos direcciones, lo que la del 2026-09-11 anticipó:

- **Lo que navori vuelve mecanismo funciona.** La delegación subió de 24% a 95%.
- **Lo que deja como texto no funciona.** El ruteo de búsqueda cayó de 40.7% a 0.1% al retirar su
  guard.
- **El costo dominante es el cache read que se acumula por turno, no el arranque.** El
  `implementer` consume el 44% de los tokens de contexto y el hilo principal el 37%.

A la vez, Claude Code trae de forma nativa varias piezas que navori duplica. El curso de harness
engineering, por su parte, señala huecos reales en navori:

- el agente declara criterios cumplidos sin evidencia;
- no hay detección de atasco;
- el reviewer no sabe dónde duda el implementer;
- los hallazgos del reviewer no se acumulan.

Esta spec fija la dirección **Claude first**: Claude Code es el engine de referencia, navori
complementa lo que Claude Code no trae y no duplica lo que ya trae. Otro engine sigue recibiendo
de navori lo que no tenga de forma nativa, y cada unidad declara su soporte por engine.

## Alcance y decisiones

**Decisiones del usuario (2026-09-30):**
- D19 se cierra mecanizando el ruteo textual.
- codegraph se cablea y mide antes de decidir si se queda.
- engram se evalúa contra la memoria nativa con evidencia.
- `guard-destructive` solo corrige su falso positivo; `rm -rf $VAR` sigue bloqueado siempre.

**Reglas que rigen todos los grupos:**
- Orden de metas de DIRECTION sin cambios: calidad > tokens > velocidad.
- **Invariante 9 intacto.** navori no ejecuta el `command` de ningún criterio; lo ejecuta el host
  y un hook lo registra (decidido en el challenge de la 0038).
- **Ningún retiro de navori se apoya en una capacidad nativa sin verificar** en la documentación
  oficial.
- **Ningún hook nuevo bloquea herramientas del agente**, salvo el guard de búsqueda del grupo F,
  que degrada abierto. El único rechazo nuevo fuera de hooks es el de `navori plan update` (R9).
- **Cada mecanismo declara su soporte por engine.** Un soporte que no se puede verificar en la
  documentación se registra como no soportado, no se supone.

## Requirements (EARS)

### A — Dirección Claude first

- **R1** — The system SHALL declarar en `docs/DIRECTION.md` a Claude Code como engine de
  referencia, junto con un criterio de admisión "nativo primero": una unidad de navori es
  admisible en Claude solo si ninguna capacidad nativa verificada da la misma garantía.
- **R2** — The system SHALL mantener una matriz de solapamiento con una fila por unidad
  distribuida (hook, skill, agente, bloque managed, plugin). Cada fila lleva cinco datos:
  - el equivalente nativo en Claude Code;
  - el veredicto (`complementa` / `reemplazar-por-nativo` / `retirar`);
  - el soporte por engine renderizado;
  - la URL de la documentación oficial;
  - la fecha de verificación.
- **R3** — IF una fila cita una capacidad nativa sin URL oficial o sin fecha de verificación
  THEN the system SHALL impedir que esa fila tenga veredicto distinto de `complementa`.
- **R4** — WHEN una unidad tiene veredicto `reemplazar-por-nativo`, the Claude renderer SHALL
  dejar de emitirla y emitir en su lugar la configuración nativa equivalente, y los renderers de
  los engines sin equivalente SHALL seguir emitiéndola.
- **R5** — WHEN `render --apply` deja de emitir una unidad por R4 en un repo ya instalado, the
  system SHALL retirarla con el backup y el prune existentes para unidades retiradas, sin tocar
  contenido del usuario.

### B — Evidencia de los criterios de aceptación

- **R6** — WHEN una ejecución Bash del agente termina con éxito y su comando coincide exactamente
  con el `command` de un `A<n>` de algún workplan del checkout, the system SHALL registrar en un
  log de solo-anexar bajo `.navori/state/` la evidencia de esa ejecución: feature, `A<n>`, comando,
  `HEAD`, huella del árbol, árbol sucio o limpio, directorio y fecha.
- **R7** — The system SHALL NOT ejecutar el `command` de un criterio desde la CLI de navori ni
  desde un hook.
- **R8** — WHEN `navori plan update` recibe `--progress A<n>=cumplido`, the system SHALL aceptar
  la transición solo si existe evidencia de R6 para ese `A<n>`, con el `command` actual del
  criterio y la huella actual del árbol donde corrió.
- **R9** — IF no existe evidencia válida THEN the system SHALL rechazar la transición, conservar
  el estado previo, terminar con código distinto de 0 e imprimir en formato ERROR / WHY / FIX qué
  falta, por qué y el comando exacto que debe ejecutarse.
- **R10** — WHERE el engine no expone una señal de éxito verificable para Bash, the system SHALL
  aceptar `cumplido` registrándolo como no evidenciado, y `navori doctor` SHALL listar el control
  como no soportado para ese engine.
- **R11** — WHEN `plan check` o `plan render` leen un workplan, the system SHALL distinguir un
  `A<n>` `cumplido` con evidencia de uno sin evidencia, sin cambiar el resultado `ok` de
  `plan check`.
- **R12** — WHEN el reviewer revisa un cambio con workplan, the reviewer SHALL reportar como
  hallazgo cada `A<n>` `cumplido` sin evidencia.

### C — Detección de atasco

- **R13** — WHEN el mismo comando falla con la misma firma de error por tercera vez consecutiva,
  dentro de una sesión y un mismo agente, the system SHALL inyectar un aviso aditivo al modelo.
  El aviso propone cambiar de enfoque con `debug-failure` o escalar al usuario.
- **R14** — The system SHALL guardar el estado de fallos repetidos bajo `.navori/state/hooks/`,
  por sesión, con un tope de líneas y sin versionarlo.
- **R15** — IF el hook de atasco falla, excede su tiempo límite o no puede leer su estado THEN
  the system SHALL terminar sin bloquear la herramienta ni alterar su resultado.
- **R16** — WHERE el engine es Codex, the system SHALL registrar el aviso de atasco solo si su
  forma de entrega no reemplaza el resultado de la herramienta; en otro caso SHALL listarlo como
  no soportado en `navori doctor`.
- **R17** — IF una captura real de `PostToolUseFailure` muestra que `error` no trae la salida del
  comando THEN the system SHALL diferir R13–R16 a otra spec en lugar de implementarlos con una
  firma gruesa.

### D — Reviewer: dudas, cobertura y hallazgos

- **R18** — The system SHALL permitir que el handoff del implementer declare una lista opcional de
  dudas, cada una con archivo y motivo.
- **R19** — WHEN el handoff trae dudas, the reviewer SHALL responder a cada una con una conclusión
  y evidencia `file:line`, además de revisar el diff.
- **R20** — WHEN el reviewer emite `APPROVED` sin hallazgos bloqueantes, the reviewer SHALL
  declarar qué revisó en cada dimensión de `review-diff`, en lugar de un aprobado sin cobertura.
- **R21** — WHEN el reviewer emite un veredicto, the system SHALL registrar sus hallazgos de score
  ≥ 50 como registros estructurados en un log de solo-anexar bajo `.navori/state/`, que no se
  sobrescribe entre features. Cada registro lleva categoría, severidad, score y archivo.
- **R22** — The system SHALL fijar el tope `maxWords` de `reviewer` e `implementer` en el conteo
  medido tras escribir la prosa de B y D, más 10 palabras de margen.

### E — Correcciones de hooks

- **R23** — IF un comando `rm` apunta a una variable sin ninguna opción recursiva (`-r`, `-R`,
  `--recursive`) THEN `guard-destructive` SHALL permitirlo.
- **R24** — WHEN un comando `rm` con opción recursiva apunta a una variable, a la raíz, al home o a
  un directorio de sistema, `guard-destructive` SHALL seguir bloqueándolo, también cuando la
  variable apunta al scratchpad.
- **R25** — WHEN `plan-gate` se ejecuta con audit-mode activo, the system SHALL escribir un
  registro `hook` con nombre, fase, veredicto y duración, igual que el resto de los hooks.
- **R26** — WHEN `subagent-stop-handoff` ya avisó sobre un archivo de handoff en la sesión, the
  system SHALL no repetir el aviso para ese archivo mientras su contenido no cambie.
- **R27** — The system SHALL no registrar hooks con matcher universal (`.*`) que no actúen sobre
  todas las herramientas. `model-advisor` se acota a los eventos donde puede emitir una
  recomendación, o se retira por R4 si la matriz lo reemplaza con `model` y `effort` nativos.
- **R28** — The system SHALL no aumentar el número de hooks que corren en cada llamada Bash.
  Se compara la cuenta al cierre de la spec contra la línea base de R43; los hooks nuevos de B y C
  se compensan con los retiros de E.

### F — Búsqueda

- **R29** — WHERE el plugin `tgrep` está habilitado, the Claude renderer SHALL instalar un guard
  PreToolUse que desvíe hacia `tgrep search` la búsqueda recursiva de contenido por shell
  (`grep -r`, o `rg` sobre directorios). El guard SHALL no redirigir a `codegraph`.
- **R30** — The guard de R29 SHALL permitir los usos de `grep` que no son búsqueda en el repo:
  filtrar la salida de otro comando por pipe y extraer de un archivo ya conocido.
- **R31** — IF `tgrep` no responde o su índice no existe THEN el guard de R29 SHALL permitir la
  búsqueda por shell en lugar de bloquearla.
- **R32** — The system SHALL verificar el cableado de `codegraph` antes de medirlo, en tres
  puntos:
  - que el índice exista y esté fresco;
  - qué agentes tienen permiso para llamarlo;
  - que `projectPath` apunte al checkout correcto, también en worktrees.
- **R33** — The system SHALL medir el costo neto de `codegraph_explore` contra la búsqueda por
  `grep` o `tgrep` más `Read`, sobre las mismas tareas de descubrimiento. Mide tokens de contexto
  acumulados, turnos hasta la respuesta y corrección, con al menos dos valores de `maxFiles`.
- **R34** — The system SHALL registrar un criterio de decisión antes de la medición de R33. IF el
  ahorro neto no supera ese criterio THEN `codegraph` SHALL quedar fuera de los defaults de nuevas
  instalaciones `navori init --full` y seguir disponible como plugin opt-in. La medición T31 no
  autoriza una migración automática: las configuraciones existentes con codegraph habilitado
  conservan sus bloques y grants actuales. El grant nominal de `scout` es un precedente aceptado;
  este requisito no afirma que no exista ningún grant sin opt-in.
- **R35** — WHEN la medición de R33 concluye, the system SHALL registrar el veredicto
  (`conservar` / `conservar-con-maxFiles` / `quitar-del-default`) como fila de la matriz de R2.

### G — Agentes

- **R36** — WHERE el host permite que un subagente despache a otro, the `architect` SHALL poder
  despachar `scout` para investigación acotada y `scribe` para serializar artefactos Markdown.
- **R37** — IF el host no permite despacho anidado THEN the system SHALL registrarlo en la matriz
  de R2 y cubrir el flujo desde el orquestador: `scout` antes del `architect`, y `scribe` después.
- **R38** — The `architect` SHALL tener acceso a `tgrep search` y, cuando codegraph esté habilitado
  como opt-in, a `codegraph_explore` con las mismas reglas de ruteo que el resto de los agentes.
  El veredicto R35 decide si codegraph integra nuevos defaults, no revoca el acceso opt-in.
- **R39** — The `scout` SHALL tener `WebFetch` y `WebSearch` entre sus herramientas.
- **R40** — WHEN el orquestador despacha `general-purpose` para una tarea de solo lectura o de
  investigación web, the system SHALL pedir confirmación indicando que `scout` cubre ese caso,
  con el mismo mecanismo que `pr-publisher-confirm`.

### H — Tokens y cache read

- **R41** — The system SHALL declarar en el `implementer` un límite nativo de turnos, con un valor
  derivado de la distribución medida.
- **R42** — WHEN un subagente en foreground termina por alcanzar su límite de turnos, the
  orchestrator SHALL recibir el handoff marcado como parcial, y `subagent-stop-handoff` SHALL
  detectar la marca por su texto (`stopped at its N-turn limit`) en el `PostToolUse(Agent)` y
  señalarlo como tal. Quedan excluidos los agentes en background o reanudados con `SendMessage`:
  en 2.1.287 `SubagentStop` no se dispara al tope y la marca no llega al hook (T2).
- **R43** — The system SHALL registrar, antes de implementar H, una línea base y un criterio de
  éxito, medidos con el mismo minero y el mismo `audit.mode`:
  - la mediana de cache read por sesión;
  - la mediana por lanzamiento de `implementer`;
  - los hooks por llamada Bash.
- **R44** — WHEN el hilo principal supera un umbral configurable de tokens de contexto al cerrar
  un ciclo (tras un despacho del `publisher`), the system SHALL inyectar un aviso aditivo. El aviso
  propone `/compact` o `/clear`, con el resumen de sesión ya guardado.
- **R45** — *Retirado tras el challenge (B3).* Las reglas nativas con alcance por ruta solo se
  cargan cuando Claude lee un archivo que coincide, así que un agente que crea un archivo nuevo no
  las tendría en contexto. El ahorro estimado era de unos 60 tokens por sesión. Por la prioridad
  calidad > tokens, los bloques managed se quedan always-on.

### I — Medición en `navori audit`

- **R46** — WHEN `navori audit` genera un reporte de rango, the system SHALL contar en cuántas
  sesiones se invocó cada agente declarado, incluidos los que tienen cero invocaciones.
- **R47** — The system SHALL marcar como candidata a revisión cada skill o agente managed sin
  invocaciones en el rango, junto con el número de sesiones consideradas.
- **R48** — WHEN `navori audit` genera un reporte de rango, the system SHALL agregar el hilo
  principal como una fila más de `totals.byAgentType`, con los mismos campos de tokens. Cada fila
  SHALL traer el número de sesiones además del de lanzamientos (`count`).
- **R49** — WHEN `navori audit` genera un reporte de rango, the system SHALL contar las llamadas
  `WebFetch` y `WebSearch` por tipo de agente.

### J — Memoria

- **R50** — The system SHALL producir una evaluación de engram contra la memoria automática nativa
  de Claude Code que compare cinco cosas con evidencia de sesiones reales:
  - la búsqueda entre proyectos;
  - la persistencia entre sesiones;
  - la carga en el arranque;
  - el costo por llamada, incluido `mem_judge`;
  - el soporte en Codex.
- **R51** — WHEN la evaluación de R50 concluye, the system SHALL registrar el veredicto
  (`conservar` / `recortar` / `reemplazar`) como fila de la matriz de R2, sujeta a R3.

### K — Master plan antes del primer uso

- **R52** — WHEN `navori master status --json` corre en un repo sin `index.json`, the system SHALL
  devolver un estado vacío válido con código 0, en lugar de texto y código 1. El primer uso es un
  caso normal, no un error.
- **R53** — The system SHALL reportar `allDone` y `closable` como verdaderos solo si el plan tiene
  al menos una parte y la fase permite cerrar. Así el skill no ofrece un cierre que
  `navori master close` rechaza.
- **R54** — WHEN `navori master init` crea un plan, the system SHALL escribir también
  `STATUS.md`, al que `INDEX.md` ya enlaza, y la línea de estado SHALL no repetir la palabra
  "ninguna" cuando no hay parte activa.
- **R55** — WHEN `navori master advance`, `close` o `part --accept` cambian el estado con
  audit-mode activo, the system SHALL escribir un registro en el log de audit de la sesión.
- **R56** — The skill `master-plan` SHALL indicar qué hacer cuando `sdd.enabled` es falso, SHALL
  aceptar variantes de "sí, continúa" que no cambian su sentido, y SHALL quedar bajo el `maxWords`
  de referencia de las skills core, o declarar en su frontmatter por qué lo excede.
- **R57** — The system SHALL incluir en la matriz de R2 las filas de master-plan frente a plan
  mode, la lista de tareas nativa y los workflows nativos, con su veredicto.
- **R58** — WHEN un comando de `navori master` registra una aprobación del usuario
  (`--approved-by user` o equivalente), the system SHALL pedir confirmación por hook en todos esos
  caminos del CLI, no solo en el que hoy cubre `master-accept-confirm`.
- **R59** — The system SHALL verificar el comportamiento del skill `master-plan` con un escenario
  ejecutable de primer uso (init, status, part, advance y close en un repo desechable), además de
  las comprobaciones de presencia de texto actuales.
- **R60** — WHERE el engine es Codex, the system SHALL seguir marcando master-plan como no
  soportado en `navori doctor`; la paridad con Codex queda fuera de esta spec.

### L — Cobertura de medición de `navori audit`

Todas las métricas de esta spec salen de `navori audit`. La auditoría del 2026-09-30 necesitó
mineros ad hoc para cada una de las que aquí se piden.

- **R61** — WHEN el usuario pide un reporte de rango sobre todos los repos auditados, the system
  SHALL agregar las sesiones de todos los directorios de `~/.navori/audits/`, con una fila por
  repo, además del reporte por repo actual.
- **R62** — WHEN `navori audit` genera un reporte de rango, the system SHALL reportar la cobertura
  del periodo: sesiones con log de audit contra sesiones totales del host en ese periodo.
- **R63** — WHEN `navori audit` genera un reporte de rango, the system SHALL agregar por hook sus
  disparos, la distribución de veredictos, el tiempo sumado y los hooks por llamada Bash (la cifra
  de R28).
- **R64** — WHEN `navori audit` genera un reporte de rango, the system SHALL agregar por
  herramienta el número de llamadas, la mediana y el p90 del tamaño del resultado, y su reparto
  entre hilo principal y subagentes. Esa es la cifra que R33 necesita para `codegraph_explore`.
- **R65** — WHEN `navori audit` genera un reporte de rango, the system SHALL agregar por tipo de
  agente la distribución de turnos por lanzamiento (mediana, p90), los lanzamientos terminados por
  límite de turnos, y, para el hilo principal, el pico de contexto por sesión y las compactaciones.
- **R66** — WHEN `navori audit` genera un reporte de rango, the system SHALL agregar por hook los
  bloqueos por regla (motivo), con hasta tres comandos de ejemplo por regla, para medir falsos
  positivos como el de R23.
- **R67** — The system SHALL incorporar a `navori audit` las dos métricas que hoy solo existen en
  `scripts/py/`: el ruteo de búsqueda (`mine-search-routing.py`) y la activación sobre
  oportunidades (`mine-activation.py`). La activación SHALL publicarse junto con el porcentaje de
  ediciones del hilo principal, porque su heurística cuenta como oportunidad todo turno delegado.
- **R68** — WHEN el usuario ejecuta `navori audit` con una opción de instantánea, the system SHALL
  guardar el reporte de rango bajo la raíz de audit (`~/.navori/audits/`), fuera de la rotación de
  logs y con un formato de instantánea versionado aparte del esquema del reporte. Copiarla al repo
  SHALL requerir una ruta explícita del usuario, y una instantánea de varios repos SHALL no
  escribirse dentro de ningún repo.
- **R69** — WHEN el usuario ejecuta `navori audit` con una instantánea previa como referencia,
  the system SHALL mostrar la diferencia por métrica entre esa instantánea y el rango actual. Esa
  comparación es la que usan R30, R34 y R43.
- **R70** — WHEN los mecanismos de B, C, D, F, G, H y K emiten un veredicto, the system SHALL
  poder contarlos en el reporte de rango. Cuenta, entre otros:
  - evidencias registradas;
  - rechazos de `plan update`;
  - avisos de atasco;
  - redirecciones a tgrep;
  - confirmaciones por `general-purpose`;
  - avisos de compactación;
  - cambios de estado de master-plan.
- **R71** — WHERE la sesión es de Codex, the system SHALL reportar lo que su log de audit permite
  medir (hooks y veredictos) y marcar como no disponibles las métricas que requieren el
  transcript, en lugar de omitir la sesión o contarla como cero.

## Equivalencias con el borrador 0038

| 0038 | Aquí | Nota |
|---|---|---|
| R1 | R6 | — |
| R2, R3 | R8, R9 | — |
| R4 | R7 | — |
| R5 | R10 | — |
| R6, R6b | R11, R12 | — |
| R7–R10 | R13–R16 | R13 agrega "un mismo agente" (challenge M4) |
| (condición de S) | R17 | Pasa a requisito explícito |
| R11–R13 | R18–R20 | — |
| R14 | R21 | — |
| R15 | — | Diferido: ≥ 30 hallazgos de ≥ 10 features |
| R16, R17 | R46, R47 | — |
| (tope M8) | R22 | Pasa a requisito explícito |
