# Planificación por niveles — Requirements

**Status:** borrador (enmendada 2026-09-23, #1011) · **Fecha:** 2026-09-23 · **Base revisada:** `a717d440`

- **Origen:** pedido del usuario del 2026-09-23: la planificación hoy es prosa en el chat y no se
  ve un plan claro durante el desarrollo. Quiere más formalidad, sin plan para lo muy simple, con
  un plan simple o uno avanzado para lo demás, y el `architect` dentro del plan avanzado.
- Enmienda del 2026-09-23 (#1011): el usuario pide clasificar cada tarea con una complejidad 0–10,
  que el plan simple sea el caso común (meta ≥70 % de las tareas con plan), escalar de nivel cuando
  el reviewer rechaza dos veces, un architect que explore alternativas y recomiende por encaje con
  el proyecto, y que el Markdown del plan no lo escriba nadie a mano.
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
- La escalera anterior (inline para lo chico, delegación para lo demás) se retiró en #691
  (`dc0ca995`) porque su umbral estaba escrito en siete lugares que no coincidían
  (`agents/orchestrator.md:16`).
- Los avisos no cambiaron la conducta: tras el aviso de `routing-watch` siguieron 219 eventos
  `Bash` y ningún subagente (`docs/research/activacion-subagentes-y-skills.md:705`). Los
  bloqueos sí: `guard-search-routing` cubrió el 91.7 % (`docs/research/tgrep-como-funcionaba.md:418`).
- La documentación de Claude Code dice que CLAUDE.md es contexto, no configuración que se
  haga cumplir, y que para bloquear una acción se use un hook `PreToolUse`
  (<https://code.claude.com/docs/en/memory>).
- `lib/diagnose/source-classify.ts` ya es la definición única, como código, de archivo no
  trivial; falta la de tarea.
- `project.criticalAreas` es prosa (`navori.config.json`), no rutas: ningún código puede
  decidir con ella si un archivo cae en área crítica.

## Requirements (EARS)

### Clasificación

- **R1** — navori DEBERÁ exponer `navori plan classify <feature>`, que calcule una complejidad
  entera de 0 a 10 desde las señales de `design.md` "Señales y pesos" y derive el nivel. Es la
  única definición de nivel: el gate (R16), el reviewer (R21) y el minero DEBERÁN llamarla, y
  ningún otro archivo DEBERÁ reescribir sus umbrales.
- **R2** — Los pesos y umbrales DEBERÁN vivir en un solo módulo de código (`lib/plan/signals.ts`).
- **R3** — SI la tarea toca una ruta de `project.criticalPaths`, maneja dinero, credenciales o
  PII, afecta dos o más repos, agrega una dependencia externa, cambia un contrato compartido o
  incluye una migración de datos o de esquema, ENTONCES el nivel DEBERÁ ser al menos 2, sin
  importar la suma.
- **R4** — Una tarea DEBERÁ clasificarse en nivel 1 salvo que califique como nivel 0 o active el
  nivel 2 o 3. Califica como nivel 0 solo cuando `classify` verifica: complejidad ≤ 3, a lo sumo
  un archivo no trivial según `source-classify` y ningún piso de R3.
- **R5** — Nivel 2: complejidad ≥ 8 o un piso de R3. Nivel 3: el usuario aceptó una spec.
- **R6** — CUANDO el orquestador clasifique una tarea, DEBERÁ mostrarle al usuario, antes del plan
  y en no más de cuatro líneas, el nivel, la complejidad y el desglose de señales.
- **R7** — CUANDO el usuario pida un nivel mayor, el orquestador DEBERÁ usarlo. SI pide uno menor
  y la tarea tiene un piso de R3, ENTONCES DEBERÁ mantener el nivel y decir qué piso lo fija.
- **R8** — Una tarea de nivel 0 NO DEBERÁ requerir workplan; una de nivel 3 DEBERÁ usar
  `specs/<feature>/tasks.md` y NO DEBERÁ producir workplan.
- **R9** — navori DEBERÁ aceptar `project.criticalPaths` (lista de globs, opcional). DONDE no
  esté definido, el piso de área crítica DEBERÁ venir de la señal declarada en el workplan y el
  reviewer DEBERÁ verificarla contra `project.criticalAreas`.

### El workplan

- **R10** — CUANDO una tarea sea de nivel 1 o 2, el orquestador DEBERÁ escribir la fuente del
  plan en `.claude/progress/workplan_<feature>.json`, válida contra el esquema de `lib/plan`.
- **R11** — `navori plan render <feature>` DEBERÁ generar `.claude/progress/workplan_<feature>.md`
  desde el JSON de forma determinista (misma entrada, mismos bytes). Ningún agente DEBERÁ
  escribir ese `.md` a mano.
- **R12** — `navori plan update <feature>` DEBERÁ cambiar el estado de un `A<n>` o agregar una
  decisión en el JSON y volver a renderizar.
- **R13** — Secciones de nivel 1 (las del R8 original: Objetivo, Criterios A<n> con comando y
  salida esperada, Fuera de alcance, Archivos, Progreso, Decisiones) más la sección Clasificación
  (complejidad, nivel y desglose que devolvió `classify`).
- **R14** — Nivel 2 agrega Solución, Fases, Riesgos y rollback (las del R9 original).
- **R15** — `navori plan check <feature>` DEBERÁ fallar con código distinto de cero y nombrar cada
  falla ante: las reglas del R13 original; un JSON que no cumpla el esquema; un nivel declarado
  menor que el que calcula `classify`. Con un plan válido DEBERÁ salir con cero.
- **R36** — MIENTRAS se ejecute una tarea de nivel 1 o 2, el orquestador DEBERÁ registrar con
  `navori plan update` el estado de cada `A<n>` y cada decisión al cerrar cada sub-tarea, y
  `progress/current.md` DEBERÁ apuntar al workplan activo en lugar de copiar su contenido.
- **R37** — SI durante la ejecución un cambio necesario queda fuera de los Archivos o del Fuera de
  alcance aprobados, ENTONCES el orquestador DEBERÁ registrarlo como decisión y consultarlo con el
  usuario antes de despacharlo.

### Gate y escalamiento

- **R16** — MIENTRAS `harness.planTiers` sea `true`, CUANDO el orquestador lance el
  `implementer`, un hook `PreToolUse` sobre la herramienta `Agent` DEBERÁ negar el lanzamiento
  salvo que el encargo nombre un feature cuyo workplan pase `plan check`, o una exención de nivel
  0 que `classify` confirme. El motivo de la negación DEBERÁ nombrar la skill a cargar y el
  comando a correr. El encargo DEBERÁ abrir con una línea `workplan: <feature>` o, para nivel 0,
  `nivel-0: <ruta>`; el hook la lee de `tool_input.prompt`, campo documentado para la herramienta
  `Agent` (<https://code.claude.com/docs/en/hooks>, sección Agent). Un encargo sin esa línea se
  niega.
- **R17** — DONDE el engine no permita interceptar el lanzamiento de subagentes, el gate DEBERÁ
  degradarse a la verificación del reviewer (R21) y `navori doctor` DEBERÁ reportarlo.
- **R18** — CUANDO `plan check` o `plan update` calculen un nivel mayor que el declarado, el
  orquestador DEBERÁ rehacer el plan al nivel nuevo antes del siguiente despacho y avisarlo al
  usuario en una línea.
- **R19** — SI un feature acumula dos `review_<feature>` con `CHANGES_REQUESTED`, ENTONCES el
  gate DEBERÁ exigir los artefactos del nivel siguiente antes de un tercer despacho: de 0 a 1, un
  workplan; de 1 a 2, `solution_<scope>.md` con su challenge. En nivel 2 o 3 DEBERÁ escalar al
  usuario (el tope vigente de `orchestrator.md`).

### Consumo aguas abajo

- **R20** — El encargo al implementer (nivel 1 o 2) DEBERÁ incluir el path del workplan y los
  `A<n>` que cubre; el implementer DEBERÁ reportar `acceptance` en `impl_<feature>.json` (el R17
  original).
- **R21** — El reviewer DEBERÁ emitir `CHANGES_REQUESTED` si un `A<n>` asignado no tiene
  evidencia, si el diff toca un archivo fuera de Archivos sin una decisión que lo cubra, o si
  `classify` sobre el diff real da un nivel mayor que el declarado.

### Contenido por nivel

- **R22** — El bloque `planificacion` DEBERÁ contener solo la tabla de niveles y la regla del
  gate, dentro de su techo propio; el procedimiento de nivel 1 DEBERÁ vivir en la skill
  `plan-simple`, el de nivel 2 en `plan-advanced` y el de nivel 3 en `spec-bootstrap`. El
  mecanismo que las activa es el motivo del gate (R16), no la coincidencia de su descripción.

### El architect

- **R23** — Nivel 2: `architect` produce `solution_<scope>.md`, un `auditor` lo cuestiona, el
  orquestador presenta las opciones al usuario con la recomendada primero y los hallazgos del
  challenge, el usuario elige, y después viene el veredicto y el workplan. Aplica siempre.
- **R24** — En nivel 2 y 3 el orquestador NO DEBERÁ aplicar `solution-design` por sí mismo: el
  diseño lo produce el architect.
- **R25** — El architect NO DEBERÁ escribir el workplan ni descomponer en tareas.
- **R26** — El architect DEBERÁ explorar al menos tres peldaños (patrón existente, extensión,
  abstracción nueva); los que descarte DEBERÁN quedar en una línea con su evidencia, y los que
  sobrevivan, desarrollados. DEBERÁ recomendar la opción que mejor cumple los criterios de
  decisión del proyecto, no la más barata por default, y proponer el destino del conocimiento
  durable (Dominio, CLAUDE.md, user-section o skill) sin escribirlo.
- **R27** — `solution-design`, para todos: los criterios de decisión se derivan de las reglas del
  proyecto antes de listar opciones, y lo que el diseño da por existente se verifica contra
  `origin/main`.
- **R28** — Nivel 3: el architect produce el `design.md` de la spec aplicando `solution-design`.
  Aplica siempre.
- **R29** — Esta spec DEBERÁ declarar la admisión del architect según la 0031 R3 y reemplazar
  explícitamente el criterio 2 de la spec 0026 por uno propio, registrado antes de implementar.

### Rollout y medición

- **R30** — Todo lo anterior salvo los comandos DEBERÁ quedar detrás de `harness.planTiers`
  (default `false`); en `false`, los contratos renderizados DEBERÁN quedar byte a byte como antes,
  salvo lo que cambia R33 (el `architect` siempre habilitado). Los comandos
  `plan classify|render|update|check` existen con cualquier valor.
- **R31** — Este repo DEBERÁ encender `harness.planTiers`.
- **R32** — La medición DEBERÁ separarse por repo y reportar: porcentaje de tareas por nivel
  (meta: nivel ≥ 1 en al menos el 70 %), clasificaciones erróneas (nivel sobre el diff mayor que
  el declarado) y escalamientos por rechazo. Antes de concluir, DEBERÁ verificarse el
  instrumento, y DEBERÁ declararse un disparador de re-medición.

### Retiro de `harness.architect`

- **R33** — navori DEBERÁ retirar la clave `harness.architect`: sale del esquema, entra en la
  lista de claves retiradas con su mensaje de migración (el mecanismo que ya usa `config.ts` para
  claves retiradas), las ramas `navori:if architect` / `navori:if-not architect` se eliminan de
  los assets de core y el agente `architect` se renderiza siempre. El mecanismo de claves
  retiradas de `config.ts` DEBERÁ aceptar una clave sin reemplazo: su aviso dice que la clave ya
  no tiene efecto y la migración la elimina.
- **R34** — El default de core para el architect DEBERÁ ser modelo `opus` y `effort` `xhigh`
  (`lib/config/recommended.ts`); un proyecto puede bajarlo con `models.architect` /
  `effort.architect`.
- **R35** — Esta spec DEBERÁ registrar, en `design.md`, que habilitar el architect siempre es una
  excepción a la spec 0031 R4 decidida por el usuario, con esta razón (texto literal): "El costo
  queda acotado: el architect solo corre en tareas de nivel 2 y 3, y ese nivel lo decide
  `classify`, no el modelo. La señal y el criterio de retiro de R29 siguen vigentes."

## Fuera de alcance

- Inline para nivel 0: se retoma en una fase 2, cuando `classify` exista y haya datos de que
  clasifica bien (condición de `orchestrator.md:18`).
- Un agente planificador (la razón original se conserva).
- Que el scribe escriba el workplan: el arranque en frío de un subagente (~25k tokens) supera lo
  que produce (~2k), la misma razón que retiró T2–T4 de la spec 0027; el render determinista lo
  sustituye.
- Trazabilidad `A<n>` → test (se conserva).
- Renombrar el `plan_<scope>.md` del auditor (se conserva).
