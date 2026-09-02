# La orquestación fuera de la capa always-on — Tasks

Tres lotes. El primero abre el canal sin mover nada, así que el harness sigue idéntico
mientras el mecanismo se prueba; el segundo hace la mudanza; el tercero migra los repos ya
renderizados y deja el número medido.

## Lote 1 — el canal, con el bloque todavía en su sitio

- [ ] **T1** (R1, R6, R7) — `audience: orchestrator` en el frontmatter del asset, y el render
  del engine claude escribe un bloque así marcado en `.claude/context/<id>.md` con su
  marcador, su hash y la config interpolada, en vez de componerlo dentro del `CLAUDE.md`.
  Detrás de la marca: mientras ningún asset la declare, el render se comporta igual que hoy.
  · test: `src/engines/claude/__tests__/audience-routing.test.ts` con `// Covers: R1, R6, R7`
  — un asset de fixture con la marca aterriza en `.claude/context/` y NO en el `CLAUDE.md`;
  conserva `id`, `hash` y `version`; un placeholder sin resolver hace fallar el render.

- [ ] **T2** (R2, R3) — `session-start-context.sh` concatena `.claude/context/*.md` a su
  `additionalContext`. Sin archivos, sin directorio o sin permiso de lectura: emite el resto y
  sale 0.
  · test: `src/lib/__tests__/session-start-context.test.ts` con `// Covers: R2, R3` — el
  contenido aparece en `additionalContext` bajo bash y zsh; el directorio ausente no cambia ni
  la salida previa ni el código de salida.

- [ ] **T3** (R6) — `.claude/context` entra en `ENGINE_OUTPUTS` (marcadores html, recursivo),
  para que el scan de drift, `doctor` y el prune lo traten como a `.claude/agents`.
  · test: `src/lib/__tests__/health.test.ts` con `// Covers: R6` — un bloque manipulado a mano
  bajo `.claude/context/` sale reportado como drift.

## Lote 2 — la mudanza

- [ ] **T4** (R1, R4, R8) — `orquestacion.md` declara `audience: orchestrator`. El
  `CLAUDE.md` renderizado deja de contenerlo; `.claude/context/orquestacion.md` lo contiene.
  `blocks.exclude: ["orquestacion"]` sigue quitándolo de las dos vías.
  · test: `src/engines/claude/__tests__/render-engine.test.ts` con `// Covers: R1, R4, R8` —
  el marcador `orquestacion` no aparece en el `CLAUDE.md`; sí en el archivo nuevo; con la
  exclusión no aparece en ninguno.

- [ ] **T5** (R5) — Una spec por agente que verifique que su asset sigue declarando lo suyo:
  la ruta de su archivo de reporte y la marca `Status:` / veredicto. Es lo que hoy hace
  redundante al párrafo del bloque, y lo que alguien podría "limpiar" mañana creyéndolo
  duplicado.
  · test: `src/lib/__tests__/agents-assets.test.ts` con `// Covers: R5` — `implementer`
  nombra `impl_<feature>.md` y `Status:`; `reviewer` nombra `review_<feature>.md` y su
  veredicto; falla nombrando al agente que lo perdió.

- [ ] **T6** (R11) — Conservar y hacer explícito el test de la exclusión mutua con la capa
  global: dentro de un repo con `navori.config.json`, el hook global no emite nada, así que el
  bloque llega una sola vez.
  · test: donde ya vive esa aserción (`global-render` / `global-zero-footprint`) con
  `// Covers: R11` — el comentario debe decir que ahora también evita la doble entrega del
  bloque, no solo la doble baseline.

## Lote 3 — migrar y medir

- [ ] **T7** (R9, R10) — El render retira el bloque de un `CLAUDE.md` ya renderizado, por su
  marcador, sin tocar el texto del usuario alrededor, y lo dice en su reporte.
  · test: `src/commands/__tests__/render-audience-migration.test.ts` con `// Covers: R9, R10`
  — un `CLAUDE.md` con el bloque + prosa propia del usuario antes y después queda sin el
  bloque y con la prosa intacta; el reporte del render lo menciona.

- [ ] **T8** (R12) — Medir con `navori audit` el arranque por subagente antes y después sobre
  la misma sesión de referencia, y dejar el número en el PR. Sin código nuevo: la señal
  `startup-overhead` ya lo publica.
  · verificación: el reporte de la sesión de 19 agentes baja de 527,949 tokens de arranque en
  la proporción que corresponda a 3,147 × agentes lanzados. Un número que no baje es la señal
  de que la mudanza no llegó a donde creíamos.

## Trazabilidad

| R | Tareas |
|---|--------|
| R1 | T1, T4 |
| R2, R3 | T2 |
| R4 | T4 |
| R5 | T5 |
| R6 | T1, T3 |
| R7 | T1 |
| R8 | T4 |
| R9, R10 | T7 |
| R11 | T6 |
| R12 | T8 |
