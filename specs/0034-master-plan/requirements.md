# Plan maestro de proyecto — Requirements

**Status:** borrador · **Fecha:** 2026-09-24 · **Base revisada:** `eacf1b99`

- **Origen:** pedido del usuario del 2026-09-24: planear un proyecto completo de principio a fin
  a partir de documentos de contexto (propuestas ejecutivas, formularios, hojas de cálculo) en
  docx, pdf o xlsx. Tres arquitectos escriben tres planes, el orquestador los consolida en un
  `MASTER.md` dividido en partes que se vuelven specs, y un `STATUS.md` lleva el avance.
- **Decisiones del usuario (2026-09-24, en el hilo):**
  - Los tres planes son ligeramente distintos: mismas secciones, distinta prioridad para
    desempatar. El `MASTER.md` toma lo mejor de cada uno.
  - Siempre corre en un repo con código y con el harness de navori ya instalado. Hay dos casos:
    un template recién creado (`create-expo-app`, un boilerplate) o un proyecto en curso, con
    código escrito a lo largo del tiempo. Una carpeta vacía no es el caso objetivo, pero no debe
    romper nada.
  - Los archivos originales (`context/raw/`) quedan fuera de git.
  - La conversión usa una herramienta ligera, porque el flujo se usa poco.
  - Claude primero y completo; la adaptación a Codex es una fase posterior.
  - Los arquitectos consultan documentación oficial cuando haga falta.
  - Rigor de escritura: todo `.md` del flujo se escribe para que lo ejecute alguien sin contexto,
    sin criterio propio y sin poder preguntar. Es una vara de escritura, no un despacho a un
    modelo barato.
  - Issues opcionales: uno por parte, en GitHub con `gh`, solo a pedido del usuario.
  - Nombres: bandera `harness.masterPlan`, skills `master-plan` y `context-intake`, carpeta
    `specs/_master/`.
- **Enmienda del 2026-09-24 — etapas y cierre:** un plan maestro termina. Cuando se entrega (por
  ejemplo, los primeros requisitos de un cliente), se cierra y queda como registro. Si después el
  cliente pide una segunda etapa compleja, se corre otro plan maestro con el mismo proceso, y el
  registro del primero sigue disponible. Decisiones del usuario:
  - Solo una etapa activa a la vez: para abrir la siguiente hay que cerrar la actual.
  - Una etapa se cierra cuando todas sus partes están hechas y el usuario confirma la entrega.
  - Se puede cerrar con partes sin terminar si cada una queda `descartada` o `diferida`, con su
    razón en el acta. Las diferidas se ofrecen como insumo de la etapa siguiente.
  - Cada etapa vive en su carpeta, numerada y con slug: `specs/_master/01-mvp/`,
    `specs/_master/02-<slug>/`.
- **Enmienda del 2026-09-24 — criterios de aceptación:** una parte no está hecha solo porque sus
  tareas están palomeadas; cada criterio de aceptación necesita evidencia. Decisiones del usuario:
  una parte es `hecho` con todas sus tareas marcadas y cada criterio verificado con evidencia, y
  los criterios manuales los aprueba el usuario, nunca el agente.
- **Enmienda del 2026-09-24 — cambio a spec:** si alguien abre un plan maestro, sube el contexto y
  el orquestador considera que el alcance cabe en una sola spec, debe recomendarlo y permitir
  cambiar a plantear solo la spec.

## Context

- Hoy navori planea tareas (niveles 0–2 de la spec 0032) y features (nivel 3, `spec-bootstrap`),
  pero no un proyecto entero. No hay un lugar para el contexto de negocio del proyecto ni una
  vista del avance total.
- El agente `architect` propone qué construir, no emite veredicto ni descompone
  (`core-assets/agents/architect.md`). Tampoco tiene `WebFetch` ni `WebSearch`; el `auditor` sí.
- `spec-bootstrap` prohíbe placeholders, pero también dice que la spec no dicta el código línea
  por línea y que el implementer conserva su criterio. El rigor que pide el usuario va más lejos
  en archivos, contratos y patrones, sin llegar al cuerpo de las funciones.
- El bloque SDD dice que el avance vive en `tasks.md` de cada spec. Un `STATUS.md` escrito a mano
  sería una segunda copia que se desincroniza.
- `markitdown` (Microsoft) convierte PDF, Word, Excel y PowerPoint a Markdown y requiere Python
  3.10–3.14 (<https://github.com/microsoft/markitdown>, consultado 2026-09-24). `uvx` corre una
  herramienta en un entorno temporal y aislado, sin instalarla, y acepta extras con
  `--from 'pkg[extra]'` (<https://docs.astral.sh/uv/guides/tools/>, consultado 2026-09-24).
- El invariante 9 de `docs/DIRECTION.md` dice que navori genera y no ejecuta: la conversión la
  corre el agente, no el CLI.

**Convención de rutas.** En estos requisitos, `<etapa>` es la carpeta de la etapa activa,
`<sdd.specsDir>/_master/<NN>-<slug>/`. Las rutas relativas (`context/…`, `plans/…`,
`state.json`, `parts.json`, `DECISIONS.md`, `MASTER.md`, `STATUS.md`, `CLOSURE.md`) cuelgan de
ella.

## Requirements (EARS)

### Entrada y precondición

- **R1** — navori DEBERÁ renderizar la skill `master-plan` en todo repo con el engine `claude`,
  con o sin `harness.masterPlan`. La skill DEBERÁ poder cargarse con `/master-plan` o cuando el
  usuario lo pida en prosa, y su primer paso DEBERÁ comprobar que el usuario pidió el plan maestro
  de forma explícita en el hilo actual. SI no lo pidió, ENTONCES la skill NO DEBERÁ hacer nada
  más. Es el mismo candado que `spec-bootstrap` adoptó en #892: `disable-model-invocation` bloquea
  también el "sí, continúa" en prosa que necesita R38 (decisión del usuario, 2026-09-24).
- **R2** — CUANDO se invoque `master-plan`, la skill DEBERÁ verificar primero que existe
  `navori.config.json` y que `navori doctor` no reporta errores. SI falla cualquiera, ENTONCES
  DEBERÁ detenerse sin escribir nada y nombrar el comando que lo resuelve.
- **R46** — CUANDO la skill pase el candado de R1 y la precondición de R2, y antes de escribir
  nada, DEBERÁ avisar que se invocó el plan maestro, listar lo que el harness va a hacer (crear
  la carpeta de la etapa, encender `harness.masterPlan`, pedir el contexto, convertirlo, mapear
  el código, lanzar tres `architect`, hacer preguntas y escribir `MASTER.md` y `STATUS.md`),
  advertir que el proceso puede tardar y consumir muchos tokens, y preguntar si continúa
  (`AskUserQuestion`). SI el usuario no confirma, ENTONCES NO DEBERÁ escribir nada. CUANDO ya
  exista una fase registrada (R7), el aviso DEBERÁ nombrar la fase actual y la siguiente en vez de
  la lista completa. El id va fuera de orden a propósito: se agregó después de fijar los demás.
- **R3** — navori DEBERÁ exponer `navori master init <slug>`, que cree `<etapa>` con
  `context/raw/`, `context/md/` y `plans/`, la registre como activa en
  `<sdd.specsDir>/_master/index.json`, ponga `harness.masterPlan: true` en `navori.config.json` y
  aplique el render. `<NN>` DEBERÁ ser el número de etapa más alto registrado más uno, con dos
  dígitos y empezando en `01`; el slug lo da el usuario, en kebab-case. La skill DEBERÁ usar ese comando y no crear la
  estructura ni editar la config a mano.
- **R4** — `navori master init` DEBERÁ asegurar que `<etapa>/context/raw/` esté en `.gitignore`,
  sin importar el valor de `gitignoreHarness`.
- **R5** — SI ya hay una etapa activa, ENTONCES `navori master init` NO DEBERÁ crear otra ni
  sobrescribir ningún archivo, y DEBERÁ reportar la etapa activa y su fase.

### Fases y reanudación

- **R6** — El flujo DEBERÁ registrar la fase de cada etapa en `<etapa>/state.json`, con
  exactamente una de: `context`, `transcribed`, `mapped`, `planned`, `questioned`, `mastered`,
  `executing`, `closed`.
- **R7** — CUANDO se invoque `master-plan` con una fase ya registrada, la skill DEBERÁ continuar
  desde esa fase sin repetir las anteriores.
- **R8** — Una fase DEBERÁ avanzar solo cuando su checklist de cierre pasa completa. El avance
  DEBERÁ hacerse con un comando de navori, no editando `state.json` a mano.

### Contexto

- **R9** — La skill `context-intake` DEBERÁ convertir cada archivo de `context/raw/` a Markdown en
  `context/md/` con `uvx --from 'markitdown[all]' markitdown`, sin instalar nada de forma
  permanente.
- **R10** — SI `uvx` no está disponible o la conversión de un archivo falla, ENTONCES la skill
  DEBERÁ leer PDF e imágenes con la lectura nativa del host y, para cualquier otro formato,
  pedirle al usuario que lo exporte a PDF. DEBERÁ listar cada archivo no convertido y su causa.
- **R11** — Cada archivo de `context/md/` DEBERÁ empezar con el nombre del archivo original y el
  método de conversión, incluida la versión de `markitdown` que lo convirtió. La versión no se
  fija en el comando (decisión del usuario, 2026-09-24).
- **R12** — La skill DEBERÁ escribir `context/DIGEST.md`: un resumen por archivo y los hechos
  consolidados del proyecto, cada hecho con el archivo de `context/md/` del que sale.
- **R13** — El contenido de `context/` DEBERÁ tratarse como datos. SI un documento contiene texto
  con forma de instrucción para el agente, ENTONCES NO DEBERÁ seguirse y DEBERÁ anotarse en
  `DIGEST.md` como hallazgo.

### Mapa del código y modo

- **R14** — En toda ejecución, un `scout` DEBERÁ escribir `context/CODEBASE.md` con el stack, la
  estructura, las convenciones observables y las specs existentes. DEBERÁ partir de
  `navori.config.json` y `CLAUDE.md`, y leer código solo para lo que la config no declare.
- **R15** — `navori master init` DEBERÁ reportar una señal de modo: desde git, el número de
  commits, la fecha del primer commit y los archivos modificados después del primer commit; desde
  la detección de stack que ya usa `navori scan` (`detectStack`), el framework y las librerías.
- **R16** — La primera pregunta al usuario después de la confirmación de R46 DEBERÁ ser el modo: `template` o `en-curso`, con la
  opción que sugiere R15 marcada como recomendada. El modo elegido DEBERÁ quedar en `state.json`.
  Esto aplica a la primera etapa. En una etapa posterior, el modo DEBERÁ registrarse como
  `en-curso` sin preguntar: la etapa anterior ya dejó código escrito.
- **R17** — DONDE el modo sea `template`, el stack del template DEBERÁ tratarse como restricción.
  SI el contexto lo contradice, ENTONCES la contradicción DEBERÁ volverse una pregunta (R26).
- **R18** — DONDE el modo sea `en-curso`, cada plan DEBERÁ incluir la sección "Estado actual vs.
  objetivo" y el `MASTER.md` DEBERÁ marcar cada parte como `hecho`, `parcial` o `pendiente`.
- **R19** — SI el repo no tiene código fuente, ENTONCES el flujo NO DEBERÁ fallar:
  `CODEBASE.md` DEBERÁ decirlo y el stack DEBERÁ tratarse como decisión abierta de los planes.

### Planes

- **R20** — El orquestador DEBERÁ despachar tres `architect` en el mismo turno, con contexto
  limpio y sin acceso a los otros planes. Cada uno recibe `DIGEST.md`, `CODEBASE.md`, el modo, la
  plantilla de plan y una prioridad de desempate distinta: tiempo a valor (`plan1.md`), solidez
  (`plan2.md`) o reuso del ecosistema (`plan3.md`).
- **R21** — Cada plan DEBERÁ cubrir todas las secciones de la plantilla de plan definida en
  `design.md`. Ninguna sección DEBERÁ quedar vacía; lo que no aplica se declara con su razón.
- **R22** — Cada regla de negocio de un plan DEBERÁ citar el archivo de `context/md/` del que sale
  o marcarse `[SUPUESTO]`.
- **R23** — Cada dato que caduca (versión, API, límite, precio, deprecación, compatibilidad entre
  librerías) DEBERÁ citar la URL de la documentación oficial y la fecha de consulta, o marcarse
  `[SIN VERIFICAR]`.
- **R24** — El agente `architect` DEBERÁ tener `WebFetch` y `WebSearch`, y su contrato DEBERÁ
  decir cuándo consultar (los datos de R23) y cómo citarlos.
- **R25** — En el encargo de plan maestro, el `architect` DEBERÁ escribir
  `<etapa>/plans/plan<n>.md` y proponer partes de entrega. Una parte es una unidad
  de alcance con su criterio de aceptación, no una tarea de implementer: el contrato de no
  descomponer en tareas, no emitir veredicto y no preguntarle al usuario se mantiene. Lo que el
  architect no pueda decidir DEBERÁ ir en la sección "Preguntas abiertas" de su plan.

### Consolidación y preguntas

- **R26** — El orquestador DEBERÁ comparar los tres planes sección por sección. Si coinciden, la
  sección pasa al `MASTER.md`. Si difieren y una opción es superior con evidencia, pasa esa con su
  origen. Si la diferencia es de negocio o de preferencia, o queda un `[SUPUESTO]` o un
  `[SIN VERIFICAR]` sin resolver, DEBERÁ volverse una pregunta.
- **R27** — Las preguntas DEBERÁN hacerse de una en una, con opción múltiple (`AskUserQuestion`),
  la opción recomendada primero y las opciones tomadas de los planes.
- **R28** — El orquestador NO DEBERÁ preguntar lo que el contexto o el código ya responden.
- **R29** — Cada respuesta DEBERÁ registrarse en `DECISIONS.md` como `D<n>`, con la pregunta, la
  opción elegida, las descartadas y la fecha.

### MASTER

- **R30** — `MASTER.md` DEBERÁ seguir la plantilla de plan, y cada sección DEBERÁ citar su origen
  (`plan<n>` con su sección, o un `D<n>`).
- **R31** — `MASTER.md` DEBERÁ dividirse en partes `P<n>`. Cada parte DEBERÁ tener objetivo,
  alcance, fuera de alcance, dependencias, requisitos semilla, criterios de aceptación según R59,
  estado y la ruta de su spec, que queda pendiente hasta que la parte arranque.
- **R32** — `MASTER.md` NO DEBERÁ contener `[SUPUESTO]` ni `[SIN VERIFICAR]` sin resolver.
- **R33** — Una parte DEBERÁ convertirse en spec (`spec-bootstrap`) cuando arranque, no antes.
  SI ya existe una spec del repo que cubre la parte, ENTONCES el `MASTER.md` DEBERÁ enlazarla en
  vez de crear otra.

### Rigor de escritura

- **R34** — La skill `master-plan` DEBERÁ definir una checklist de rigor y aplicarla antes de
  cerrar cada plan, el `MASTER.md` y cada spec de parte: nada implícito, ningún adjetivo sin
  medida, citas según R22 y R23, criterios de aceptación observables y cero decisiones abiertas.
- **R35** — CUANDO `harness.masterPlan` esté activo y se cree la spec de una parte, cada tarea de
  su `tasks.md` DEBERÁ declarar los archivos exactos, las interfaces que toca (definidas en
  `design.md`), un archivo del repo como patrón a seguir, la lista cerrada de lectura, las
  librerías con versión fija, el criterio de done (comando, resultado esperado y casos de test con
  nombre) y lo que queda fuera de alcance. NO DEBERÁ dictar el cuerpo de las funciones.

### Avance y modo activo

- **R36** — `navori master status` DEBERÁ generar `STATUS.md` de forma determinista desde las
  partes de `MASTER.md` y los checkboxes de cada `tasks.md` enlazado. Ningún agente DEBERÁ
  escribir `STATUS.md` a mano.
- **R37** — DONDE `harness.masterPlan` esté activo, el render DEBERÁ agregar un bloque managed que
  diga que el agente NO DEBERÁ empezar ni avanzar el plan maestro por iniciativa propia, solo a
  pedido explícito del usuario. CUANDO el usuario lo pida, el agente DEBERÁ mapear el trabajo a
  su parte, tratar la parte como nivel 3 y regenerar `STATUS.md` al cerrar la sesión. El trabajo
  que el usuario pida fuera del plan maestro NO DEBERÁ forzarse a una parte.
- **R38** — DONDE `harness.masterPlan` esté activo, el hook `SessionStart` DEBERÁ inyectar una
  línea con la parte activa, su avance y la ruta de `STATUS.md`, e indicar que en su primera
  respuesta de la sesión el agente ofrezca continuar con el plan maestro en una sola línea, sin
  interrumpir ni reemplazar lo que el usuario pidió. SI esa línea no cabe en el presupuesto del
  contexto de arranque, ENTONCES DEBERÁ inyectar solo la ruta y la indicación de ofrecer.
- **R39** — DONDE `harness.masterPlan` no esté activo, el render NO DEBERÁ producir el bloque de
  R37 ni la inyección de R38.
- **R40** — CUANDO `navori master status` detecte todas las partes en `hecho`, la skill DEBERÁ
  proponerle al usuario cerrar la etapa (R47). NO DEBERÁ cerrarla ni cambiar la config sin su
  confirmación.

### Engines

- **R41** — DONDE esté configurado un engine distinto de `claude`, `navori doctor` DEBERÁ
  declarar el plan maestro como no soportado en ese engine, con su razón, en el registro de
  controles de la spec 0033 (R20).

### Issues

- **R42** — CUANDO el usuario pida crear issues, o acepte que la skill se lo proponga, la skill
  DEBERÁ crear un issue de GitHub por parte `P<n>` con `gh issue create`. El cuerpo sale de la
  parte: objetivo, alcance, fuera de alcance, dependencias, criterio de aceptación y la ruta de
  `MASTER.md`. Antes de crearlos DEBERÁ mostrar la lista de issues y esperar la confirmación del
  usuario. GitHub es el único destino: la skill NO DEBERÁ crear issues ni tickets en ningún otro
  tracker.
- **R43** — Toda creación de un issue de GitHub DEBERÁ pedir confirmación del usuario
  (`permissionDecision: "ask"` desde un `PreToolUse(Bash)`) a cualquier agente y en cualquier
  modo de permisos, incluidos `bypassPermissions` y `dontAsk` (decisión del usuario, 2026-09-24).
  Cubre `gh issue create`, `gh api` contra `/repos/<owner>/<repo>/issues` y la mutación GraphQL
  `createIssue`. La confirmación en el chat de R42 no la sustituye.
- **R44** — El número de cada issue DEBERÁ quedar en su parte de `MASTER.md` y aparecer en
  `STATUS.md`. SI una parte ya tiene issue, ENTONCES NO DEBERÁ crearse otro.
- **R45** — SI `gh` no está autenticado o el plugin `gh` no está habilitado, ENTONCES la skill
  DEBERÁ omitir ese paso, nombrar el comando que lo resuelve (`gh auth login` o habilitar el
  plugin) y seguir sin issues.

### Etapas y cierre

- **R47** — `navori master close` DEBERÁ cerrar la etapa activa solo cuando cada parte esté en
  `hecho` (estado efectivo) o marcada `descartada` o `diferida` con una razón, y solo después de
  que el usuario confirme la entrega con `AskUserQuestion`. SI alguna parte no cumple, ENTONCES
  NO DEBERÁ cerrar y DEBERÁ listar las partes que lo impiden.
- **R48** — Marcar una parte como `descartada` o `diferida` DEBERÁ exigir una razón y hacerse con
  un comando de navori. La skill DEBERÁ preguntarle al usuario, parte por parte, el estado final
  de cada parte sin terminar antes de cerrar.
- **R49** — Al cerrar, navori DEBERÁ escribir `<etapa>/CLOSURE.md` de forma determinista desde
  `state.json` y `parts.json`: fechas de apertura y cierre, cada parte con su estado final, su
  spec, su issue y la razón si quedó `descartada` o `diferida`, y el número de decisiones de
  `DECISIONS.md`. También DEBERÁ poner la etapa en fase `closed`, marcarla cerrada en
  `index.json`, poner `harness.masterPlan: false` y aplicar el render.
- **R50** — Una etapa cerrada DEBERÁ quedar como registro de solo lectura: los comandos de
  `navori master` que mutan estado DEBERÁN rechazarla, y `navori master check` DEBERÁ poder
  validarla.
- **R51** — CUANDO se invoque `master-plan` sin etapa activa y con al menos una cerrada, la skill
  DEBERÁ abrir la etapa siguiente con el mismo proceso. El aviso de R46 DEBERÁ decir que es una
  etapa nueva y nombrar la última cerrada.
- **R52** — En una etapa posterior a la primera, los tres `architect` y la consolidación DEBERÁN
  leer completos el `MASTER.md`, el `DECISIONS.md` y el `CLOSURE.md` de la última etapa
  `cerrada`, el `DECISIONS.md` y el `CLOSURE.md` de las etapas `convertida` o `abandonada`
  posteriores a ella, y de las etapas anteriores solo su `CLOSURE.md` e `INDEX.md`. Así el
  contexto no crece sin tope: cada etapa ya consolidó las decisiones de las anteriores como
  restricción. Esas decisiones DEBERÁN tratarse como restricciones; SI el contexto nuevo las contradice, ENTONCES la
  contradicción DEBERÁ volverse una pregunta (R26). La skill DEBERÁ ofrecerle al usuario incluir
  cada parte `diferida` de la etapa anterior, y la respuesta DEBERÁ registrarse como `D<n>`.
- **R53** — SI hay una etapa activa y el usuario pide abrir un plan maestro nuevo, ENTONCES la
  skill NO DEBERÁ abrirlo: DEBERÁ nombrar la etapa activa, su fase y su avance, y ofrecer
  cerrarla (R47).
- **R54** — `<sdd.specsDir>/_master/index.json` DEBERÁ registrar cada etapa con su número, slug,
  estado (`activa`, `cerrada`, `convertida` o `abandonada`) y fechas, y `navori master status` DEBERÁ generar
  `<sdd.specsDir>/_master/INDEX.md` desde él. La línea de R38 y `STATUS.md` DEBERÁN nombrar la
  etapa activa.

### Criterios de aceptación

- **R59** — Cada criterio de aceptación de una parte DEBERÁ tener id `P<n>.A<m>`, una descripción
  observable y un método de verificación: `test` (archivo y caso con nombre), `comando` (comando y
  resultado esperado) o `manual` (qué debe revisar el usuario y cómo).
- **R60** — El `requirements.md` de la spec de una parte DEBERÁ citar cada `P<n>.A<m>` en al menos
  un `R<n>`. `navori master check --part` DEBERÁ fallar si un criterio no aparece en ningún `R<n>`
  o si un `R<n>` cita un criterio que no existe.
- **R61** — Una parte DEBERÁ tener estado efectivo `hecho` solo cuando todas sus tareas estén
  marcadas y cada `P<n>.A<m>` tenga evidencia registrada con un comando de navori. Para `test` y
  `comando`, la evidencia es el comando que corrió el agente, su resultado, el commit y la fecha;
  para `manual`, la aprobación del usuario con su fecha. SI a una parte con todas sus tareas
  marcadas le falta evidencia de algún criterio, ENTONCES su estado efectivo DEBERÁ ser `parcial`,
  y `STATUS.md` y `blockers` DEBERÁN nombrar los criterios pendientes.
- **R62** — Un criterio `manual` DEBERÁ aprobarse solo con la respuesta del usuario a una
  `AskUserQuestion` que presente el criterio y cómo verificarlo. El agente NO DEBERÁ registrar una
  aprobación manual por su cuenta, y el comando que la registra NO DEBERÁ estar en `allow`.
  Además, un `PreToolUse(Bash)` DEBERÁ responder `permissionDecision: "ask"` a ese comando en
  cualquier modo de permisos, igual que R43 con los issues (decisión del usuario, 2026-09-24).
- **R63** — `CLOSURE.md` DEBERÁ listar cada criterio de cada parte con su método, su evidencia y su
  fecha. Los criterios de partes `descartada` o `diferida` DEBERÁN aparecer como no verificados.

### Cambio a spec

- **R55** — Antes de despachar los tres `architect` (R20), el orquestador DEBERÁ evaluar si el
  alcance de `DIGEST.md` y `CODEBASE.md` cabe en una sola spec, con los criterios que fija
  `design.md`. SI cabe, ENTONCES DEBERÁ recomendar cambiar a spec, con las razones que lo
  sostienen.
- **R56** — La recomendación DEBERÁ ser una pregunta de `AskUserQuestion` con "Cambiar a spec" y
  "Seguir con el plan maestro". El cambio NO DEBERÁ hacerse sin la confirmación del usuario. El
  usuario DEBERÁ poder pedir el cambio en cualquier fase anterior a `mastered`.
- **R57** — CUANDO el usuario confirme el cambio, navori DEBERÁ cerrar la etapa como `convertida`:
  `CLOSURE.md` con la razón y la ruta de la spec, estado `convertida` en `index.json`,
  `harness.masterPlan: false` y render aplicado. La spec DEBERÁ crearse con `spec-bootstrap`,
  que recibe `DIGEST.md`, `CODEBASE.md` y `context/md/` como entrada y los cita. La confirmación
  del usuario cuenta como la aceptación explícita que exige `spec-bootstrap`.
- **R58** — El usuario DEBERÁ poder abandonar la etapa activa en cualquier fase anterior a
  `mastered` con `navori master close --abandon --reason <texto>`, después de confirmarlo con
  `AskUserQuestion`. La etapa DEBERÁ quedar `abandonada` en `index.json`, con un `CLOSURE.md` corto
  que registra la razón y la fase en que se abandonó; la bandera DEBERÁ apagarse y el render
  aplicarse. NO DEBERÁ borrarse ningún archivo de la etapa (decisión del usuario, 2026-09-24).

## Fuera de alcance

- Adaptación a Codex (fase 2). R41 solo la hace visible.
- OCR y transcripción de audio o video.
- Conversión ejecutada por el CLI de navori (invariante 9).
- Crear todas las specs de parte por adelantado (R33).
- Planes maestros que abarquen varios repos.
- Varias etapas activas a la vez (decisión del usuario, 2026-09-24).
- Issues en Jira u otro tracker distinto de GitHub, e issues por tarea (decisión del usuario,
  2026-09-24: un issue por parte, solo GitHub).
