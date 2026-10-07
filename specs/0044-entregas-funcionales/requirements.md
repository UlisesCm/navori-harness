# Entregas funcionales: distribución de specs en PRs — Requirements

**Fecha:** 2026-10-07 · **Estado:** borrador para aprobación.
**Dirección aprobada:** [distribucion-entregas-agentes](../../docs/research/distribucion-entregas-agentes.md).
Contiene la evidencia, las siete reglas y los umbrales iniciales que aprobó el usuario el
2026-10-07.

## Contexto

Las specs producen micro-PRs técnicos. La 0039 salió en 32 PRs para 45 tareas y la 0041 en 14
PRs en un día. Ninguna regla lo pide: es la suma de cuatro reglas de la doctrina:

- tareas en lotes de 1–3;
- `implementer` → `reviewer` por lote;
- gate completo en cada revisión, re-revisión y re-firma delta;
- receipt atado a los bytes de cada commit.

Cada PR paga unos 10 gates en serie sin revisión humana que lo justifique. Esta spec cambia la
unidad de PR de la spec:

- **Spec pequeña o media:** 1 PR.
- **Spec media o grande:** de 2 a 4 PRs, uno por entrega funcional vertical.
- **Dentro de cada PR:** la verificación pequeña y frecuente vive en milestones con commit.

## Alcance y decisiones

**Decisiones del usuario (2026-10-07):**

- **Modelo híbrido.** Una spec se parte solo si tiene ≥2 capacidades demostrables por separado
  *y* rebasa el umbral (>12 tareas o >~1,500 LOC estimadas). El tope es de 4 PRs por spec; si
  necesita más, se parte la spec.
- **Umbrales.** Los iniciales se calibran por repo desde `navori.config.json`.
- **Branch destino.** Cada entrega mergea en orden a la branch destino configurada del repo
  (`main`, `dev` o `develop`), sin rama de integración.
- **Master-plan.** Toda spec o parte que genere master-plan sigue esta misma filosofía.

**Reglas que rigen todos los grupos:**

- **Lo que no cambia:** EARS, los ids `R<n>` y la trazabilidad `// Covers: R<n>`.
- **Prioridad:** calidad > tokens > velocidad (DIRECTION). Bajar gates repetidos no baja la
  verificación: el gate completo sigue corriendo sobre los bytes que se publican.
- **Invariante 9 intacto.** navori clasifica y valida, pero no ejecuta los comandos de
  aceptación ni abre PRs.
- **Specs anteriores.** Una spec con `tasks.md` en el formato anterior sigue siendo válida y no
  se migra.

## Requirements (EARS)

### A — Dirección

- **R1** — The system SHALL declarar en `docs/DIRECTION.md` la entrega funcional como unidad de
  PR de una spec y el milestone como unidad de verificación y commit, con enlace a la dirección
  aprobada.

### B — Configuración

- **R2** — The system SHALL aceptar en `navori.config.json` un bloque `sdd.deliveries` con
  `splitMinTasks`, `splitMinLoc` y `maxPrsPerSpec`, cuyos defaults son 12, 1500 y 4.
- **R3** — IF un valor de `sdd.deliveries` no es un entero positivo, o `maxPrsPerSpec` es menor
  que 2 THEN the system SHALL rechazar la configuración con un mensaje que nombre el campo.

### C — Clasificación de la spec

- **R4** — WHEN el usuario ejecuta `navori spec classify <feature>`, the system SHALL calcular a
  partir de `tasks.md` el número de tareas, de entregas declaradas y de LOC estimadas, y SHALL
  reportar la forma `single` (1 PR) o `split` (un PR por entrega), con las señales que la
  decidieron.
- **R5** — The system SHALL reportar `split` solo si la spec declara ≥2 entregas *y* supera
  `splitMinTasks` o `splitMinLoc`. En cualquier otro caso SHALL reportar `single`.
- **R6** — IF la spec declara ≥2 entregas pero no supera ningún umbral THEN the system SHALL
  reportar `single` y SHALL advertir que las entregas se fusionan en un solo PR.
- **R7** — IF el número de entregas supera `maxPrsPerSpec` THEN the system SHALL terminar con
  código distinto de 0 e indicar en formato ERROR / WHY / FIX que la spec debe partirse en varias
  specs.
- **R8** — WHEN `navori spec classify` recibe `--json`, the system SHALL emitir la forma, las
  señales y los umbrales efectivos en un objeto JSON estable.
- **R9** — IF `tasks.md` no existe o no se puede leer THEN the system SHALL terminar con código
  distinto de 0 e indicar en formato ERROR / WHY / FIX la ruta que esperaba.

### D — Forma de `tasks.md`

- **R10** — The skill `spec-bootstrap` y el bloque managed `sdd` SHALL describir `tasks.md`
  organizado en entregas `E<n>` (unidad de PR), milestones `M<n>` (unidad de verificación y
  commit) y tareas `T<n>` (trazabilidad a `R<n>`), en lugar de lotes de 1–3 tareas.
- **R11** — WHEN el usuario ejecuta `navori spec check <feature>`, the system SHALL verificar que:
  - cada entrega tenga ≥1 milestone;
  - cada milestone declare ≥1 criterio de aceptación con comando y salida esperada;
  - cada tarea pertenezca a exactamente un milestone;
  - cada `R<n>` de `requirements.md` esté cubierto por ≥1 tarea.
- **R12** — IF una entrega contiene solo tareas cuyo único efecto declarado es documentación,
  tests o schema, sin un criterio que verifique comportamiento observable, THEN `navori spec
  check` SHALL reportarla como entrega no vertical.
- **R13** — WHERE una entrega se marca como `foundation`, `navori spec check` SHALL exigir que
  sea la primera y que al menos uno de sus milestones declare, en una línea `Consumes:`, un
  consumidor del contrato dentro de la misma entrega.
- **R14** — WHEN `navori spec check` o `navori spec classify` leen un `tasks.md` sin entregas
  declaradas, the system SHALL tratarlo como una sola entrega del formato anterior, SHALL
  advertirlo, SHALL reportar cualquier hallazgo como advertencia y SHALL terminar con código 0.

### E — Gates proporcionales

- **R15** — The bloque managed `orquestacion` SHALL indicar que cada milestone se verifica con
  un gate acotado (`qualityGate.fast` más los comandos de sus criterios `A<n>`), y que el gate
  completo corre una vez por PR sobre los bytes que se publican.
- **R16** — WHEN el `reviewer` revisa, re-revisa o re-firma un milestone para el que
  `navori receipt gate` responde `scoped`, the reviewer SHALL correr el gate acotado en lugar del
  gate completo.
- **R17** — WHEN el `reviewer` emite el veredicto que el `publisher` reutiliza para publicar,
  the reviewer SHALL haber corrido el gate completo sobre esos bytes, como hoy.
- **R25** — WHEN `navori receipt gate` o `navori receipt sign` reciben `--spec <spec>` y
  `--milestone M<n>`, the system SHALL decidir el tipo de gate a partir de `tasks.md`: `scoped`
  solo si queda ≥1 tarea sin marcar en un milestone posterior de la misma unidad de PR, y `full`
  en cualquier otro caso. `sign` SHALL escribir ese tipo en el receipt y SHALL rechazar firmar
  cuando el tipo decidido es `full` y se declaró que corrió el gate acotado. IF faltan esos
  flags, el formato de `tasks.md` es el anterior o `tasks.md` no se puede leer THEN the system
  SHALL decidir `full` y firmar como hoy.

### F — PRs y branch destino

- **R18** — WHEN la forma es `split`, the `publisher` SHALL abrir un PR por entrega, en el orden
  de `tasks.md`, contra la branch `prTarget` configurada, sin rama de integración.
- **R19** — WHEN la forma es `split`, the `publisher` SHALL usar `Refs #<issue>` en los PRs
  intermedios y `Closes #<issue>` en el PR de la última entrega. WHEN la forma es `single`, SHALL
  usar `Closes #<issue>` en el único PR.
- **R26** — WHILE el receipt vigente es de tipo `scoped`, o el brief del `publisher` declara
  `mode: commit-only`, the `publisher` SHALL hacer solo el commit y SHALL NOT publicar la rama
  ni abrir un PR.
- **R20** — The system SHALL corregir `prTarget` en el `navori.config.json` de este repo a `main`,
  la branch a la que mergea.

### G — Master-plan

- **R21** — The skill `master-plan` y las plantillas de master-plan SHALL indicar que cada spec o
  parte que generen se clasifica con `navori spec classify` y se reparte con las reglas de esta
  spec.
- **R22** — WHERE master-plan usa el modo entregas, the system SHALL mapear cada entrega `E<n>`
  de `parts.json` a una entrega `E<n>` del `tasks.md` de la spec que la implementa, con el mismo
  id.

### H — Engines y calibración

- **R23** — The prosa de R10, R15–R19, R21 y R26 SHALL renderizarse para Claude y Codex. La
  diferencia de mecanismo por engine se declara en la matriz de solapamiento, como en la spec 0039.
- **R24** — The system SHALL registrar en
  [distribucion-entregas-agentes](../../docs/research/distribucion-entregas-agentes.md) la línea
  base de las specs 0039 y 0041 y una tabla de calibración con estas columnas:
  - PRs por spec;
  - corridas del gate completo;
  - tiempo de reloj hasta el merge;
  - PRs `fix` en las 72 h siguientes.

  La fila de la primera spec que use este formato se llena después de su merge, como cierre de
  la siguiente spec. Esos datos no existen dentro del PR que la implementa.
