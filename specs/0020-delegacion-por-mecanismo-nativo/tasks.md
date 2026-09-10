# Delegación por mecanismo nativo — Tasks

## Lote 1 — el disparador que el host evalúa

- [x] **T1** (R1) — Reescribir el `description` de los 8 agentes de
  `core-assets/agents/` a la forma "qué hace · cuándo dispararlo", con la condición
  observable primero cuando quepa. `leader` es el caso especial: su condición es
  "nunca como subagente", y el texto debe seguir diciéndolo. Mantener cada uno en
  una línea — el host trunca el listado y cobra esos tokens en cada decisión de
  ruteo. · test: `agent-descriptions.test.ts`::`todo agente declara cuándo
  dispararlo` con `// Covers: R1`

- [x] **T2** (R1) — Test que recorre los assets **enviados** (no un fixture) y exige
  en cada `description`: una cláusula de condición y un largo por debajo del corte
  del listado del host. Debe fallar nombrando el agente. · test:
  `agent-descriptions.test.ts`::`la convención no se revierte en silencio` con
  `// Covers: R1`

- [x] **T2b** (R1) — Reescribir las entradas de `blocks.agentsIndex.when` en las dos
  tablas de idioma de `lib/i18n.ts` para que declaren la condición de disparo,
  coherentes con el frontmatter. `leader` queda fuera: `buildAgentsIndexBody` lo
  excluye a propósito. El bloque viaja en el contexto de arranque, así que el margen
  de `session-start-budget.test.ts` (8,000 chars) es la restricción real. · test:
  `agent-descriptions.test.ts`::`los dos canales declaran condición para los mismos
  agentes` con `// Covers: R1`

## Lote 2 — el aviso en el momento de la decisión

- [x] **T3** (R2, R3) — Escribir `core-assets/hooks/routing-watch.sh`: lee el payload
  de `PostToolUse` de stdin; sobre `Edit`/`Write`/`NotebookEdit` acumula el
  `file_path` en un sello por `session_id`; sobre `tool_name: "Agent"` marca la
  sesión como delegada; al llegar a 4 archivos distintos sin delegación y sin haber
  avisado, emite el aviso por `hookSpecificOutput.additionalContext` y marca el
  sello. Sale 0 siempre, incluso si no puede leer o escribir el sello. · test:
  `routing-watch.test.ts`::`emite al cruzar el umbral` con `// Covers: R2`

- [x] **T4** (R3) — Los tres casos que impiden que el aviso se vuelva ruido, cada uno
  con su secuencia de payloads: se emite **exactamente una vez** aunque se sigan
  editando archivos; **no** se emite si hubo un `Agent` antes del umbral; **no**
  bloquea (exit 0, sin `permissionDecision` en la salida). · test:
  `routing-watch.test.ts`::`una sola vez`, `::`no avisa si ya delegó`,
  `::`nunca bloquea` con `// Covers: R3`

- [x] **T5** (R2) — Registrar el hook en `build-settings.ts` bajo `PostToolUse` y
  agregarlo a `resolveHarnessPlan` para que se materialice en todo repo onboardeado.
  Marcar `SubagentStop` como segunda vía de "ya delegó". Agregar el sello a
  `EPHEMERAL_HARNESS_PATHS`, que le da `.gitignore`, exclusión del backup y check de
  `doctor` de una vez. Actualizar los golden de claude y codex. · test:
  `routing-watch.test.ts`::`queda registrado en PostToolUse y su sello es efímero`
  con `// Covers: R2`

  > **`SubagentStop` descartado durante la implementación.** T5 lo pedía como segunda
  > vía de "ya delegó". No aporta: dispara cuando el subagente **termina**, igual que
  > el `PostToolUse` de `Agent`, así que no adelanta la detección. Su único valor era
  > resistir un rename del `tool_name` del host, y eso quedó cubierto aceptando
  > `Agent | Task` en el `case` del script. Registrar el hook dos veces sería costo sin
  > beneficio.

## Lote 3 — que la medición cierre el ciclo

- [ ] **T6** (R5) — Escribir la emisión del aviso al log de audit como evento propio,
  con el conteo de archivos y el `session_id`, y leerlo en `lib/audit/parse.ts` para
  que el reporte lo muestre. Sin esto el aviso es invisible para la única
  herramienta que puede decir si sirvió. · test:
  `audit-routing-notice.test.ts`::`el reporte cuenta los avisos de ruteo de la
  sesión` con `// Covers: R5`

## Lote 4 — devolverle adherencia al CLAUDE.md

- [x] **T7** (R4) — Bajar el `CLAUDE.md` renderizado de 278 a menos de 200 líneas.
  Los dos bloques más pesados son `operaciones-seguras` (27 líneas / 6,473 chars) y
  `tgrep-protocol` (34 / 3,177): mover su profundidad a las skills que ya cubren el
  tema —que cargan bajo demanda y no cuestan nada hasta usarse— y dejar en el bloque
  la regla accionable. No borrar doctrina: moverla y dejar el puntero. · test:
  `claude-md-budget.test.ts`::`el render cabe en el presupuesto de adherencia` con
  `// Covers: R4`

  > **Qué mide R4, precisado con el dato.** El render limpio pasó de 209 a 184 líneas
  > y cumple con 16 de margen. El `CLAUDE.md` de ESTE repo quedó en 253, pero de esas
  > solo 156 están en bloques managed: el resto es prosa escrita a mano por el usuario,
  > que navori no controla ni debe tocar. R4 mide **lo que navori envía**, que es lo
  > único que el paquete puede sostener. Que un repo se pase por su propia mitad es un
  > aviso de `doctor` que hoy no existe — follow-up, no alcance de esta spec.

- [x] **T8** (R4) — Test de presupuesto sobre el `CLAUDE.md` **renderizado** (no
  sobre los assets sueltos), con el umbral de 200 líneas citado a la doc del host en
  el propio test, igual que `session-start-budget.test.ts` cita el corte medido. Debe
  fallar diciendo cuántas líneas sobran y qué bloques son los más pesados. · test:
  `claude-md-budget.test.ts`::`nombra los bloques más pesados al fallar` con
  `// Covers: R4`

## Cierre

Al terminar los cuatro lotes, remedir con las herramientas que ya existen:

```
python3 scripts/classify-activation-arm.py --ids-after <dir-de-proyecto> > after.txt
python3 scripts/mine-activation.py after.txt
```

y escribir el resultado en `docs/research/activacion-subagentes-y-skills.md` **contra
la línea base de ese documento — incluido si sale nulo o inverso**, que es la regla
que ese doc ya se puso. La medición del 57% de violación de R2 vive en esta spec y en
la conversación que la originó; conviene moverla a ese documento junto al resultado,
para que el antes y el después queden en el mismo sitio.
