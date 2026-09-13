# Guard sobre `gh pr create` — Tasks

Orden deliberado: el pre-registro y el instrumento van **antes** que el hook. Un criterio
escrito después de ver los primeros bloqueos no es un criterio.

## Lote 1 — el pre-registro, antes de tocar el hook

- [ ] **T1** (R10) — Escribir `docs/research/ruteo-del-pr.md` con la línea base ya medida
  (261 oportunidades / 38 activaciones globales; `navori-harness` 117/1; conversión de la capa
  `ask` 0 de 26 sobre 51 PRs a mano) y los criterios de la tabla 2×3 del diseño: denominador,
  numeradores A y B, ventana, y **los cuatro cuadrantes**, incluido `éxito con fuga`. Los
  umbrales van en un bloque con forma parseable —una tabla o un JSON embebido—, porque T3 los va
  a comparar contra el minero. **Prohibido copiar el "aviso de ruteo 0/1"**: #767 lo invalidó
  (el hook nunca se entregó en el carril Bash) y este documento es el registro de investigación
  donde un dato malo se vuelve permanente. Si se menciona, va con la salvedad y sin contar como
  evidencia. · test: `mine-pr-routing.test.ts`::`el pre-registro declara denominador, umbrales y
  ventana` con `// Covers: R10`

- [ ] **T2** (R9) — Escribir `scripts/mine-pr-routing.py` sobre el mismo molde que
  `mine-search-routing.py`: recorre `~/.navori/audits/*/session-*.log`, cuenta por repo y
  global los veredictos `block` / `allow` / `override` de `pr-pilot-confirm`, y cruza cada
  bloqueo contra el transcript de su sesión para ver si después hubo `Agent`/`Task` con
  `subagent_type: commit-pr-pilot` (numerador A) o un `override` (numerador B). **Normaliza
  `.claude/worktrees/<id>` a la raíz del repo** antes de agrupar, o el mismo experimento sale
  partido entre `navori-harness` y un repo fantasma (#764). Acepta `--desde` / `--hasta` por
  día, igual que su hermano. · test:
  `mine-pr-routing.test.ts`::`cuenta bloqueo, reintento por el pilot, override y repliegue`
  con `// Covers: R9`

- [ ] **T3** (R10) — Que el minero imprima los umbrales junto al resultado, leídos de la
  misma fuente que T1, y un test de deriva que falle nombrando el umbral que difiere. Es lo
  que impide moverlos después de ver el dato. · test:
  `mine-pr-routing.test.ts`::`el minero y el pre-registro declaran los mismos umbrales` con
  `// Covers: R10`

## Lote 2 — el bloqueo y sus dos repliegues

- [ ] **T4** (R1, R4) — En `core-assets/hooks/pr-pilot-confirm.sh`, sustituir la emisión de
  `permissionDecision: "ask"` por `exit 2` con la razón a stderr, en el idioma de `block()` de
  `guard-destructive`: primera línea `[navori] BLOCKED by pr-pilot-confirm: …`, y después las
  **dos** salidas, la delegación (`Agent` con `subagent_type: commit-pr-pilot`) y la ruta
  literal del centinela. Redactar el mensaje como la vía alterna que sí procede, no como una
  regla repetida: la doctrina de `operaciones-seguras` manda parar ante un bloqueo, y un texto
  que solo diga "no deberías" deja el embudo en 0% por doctrina y no por conducta. Asignaciones
  solamente entre el veredicto y el `exit 2`; el registro ocurre en el trap que ya existe. ·
  test: `pr-pilot-confirm.test.ts`::`bloquea el PR del hilo principal y nombra las dos salidas`
  —una aserción por salida: el `subagent_type: commit-pr-pilot` y la ruta literal del
  centinela, porque R4 exige las dos y un test que solo mira una deja media cubierta— con
  `// Covers: R1, R4`

- [ ] **T5** (R2, R3) — Los dos casos en los que el guard se hace a un lado. (a) El payload
  nombra un subagente → exit 0 y registro `allow`; ya está implementado y solo hay que
  conservarlo al reescribir el final del script. (b) El `commit-pr-pilot` no es resoluble →
  exit 0 y registro `allow` con la razón del repliegue.

  **El resolvedor de (b) NO es `navori_worktree`.** Ese partial devuelve
  `git rev-parse --show-toplevel`, o sea la raíz del repo: probado desde `packages/cli`,
  acierta y el repliegue no dispararía nunca, con lo que R3 quedaría verde y hueco. Hay que
  replicar lo que hace el host: **ascender por `.claude/agents/commit-pr-pilot.md`** desde el
  directorio sobre el que actúa el comando, nivel por nivel hasta la raíz del FS, y probar al
  final `~/.claude/agents/commit-pr-pilot.md`. `test -f` por nivel, sin forks, todo detrás del
  atajo de #716. (`navori_worktree` sí es el resolvedor correcto para el centinela de T7.)

  El test lleva **tres brazos, y solo el tercero discrimina**. Los dos primeros —repo sin el
  agente en ningún nivel → repliegue; comando desde un **subdirectorio** de un repo que sí lo
  tiene en la raíz → bloquea— dan el MISMO veredicto con el ascenso y con el proxy de git, y
  está ejecutado: para cualquier cwd dentro del repo, el ascenso pasa por la raíz de git, así
  que coinciden. Una suite con solo esos dos queda verde aunque alguien implemente R3 con
  `navori_worktree`, que es el defecto del ciclo 1 — o sea que no protegen nada.

  **El brazo que discrimina: `.claude/agents/` POR ENCIMA de la raíz de git.** Montaje completo,
  dos comandos: `mkdir -p $T/.claude/agents && touch
  $T/.claude/agents/commit-pr-pilot.md && git init $T/repo && mkdir -p $T/repo/sub`, y el
  comando corre desde `$T/repo/sub`. Verificado sobre ese fixture, los veredictos son opuestos:

  | resolvedor | resultado |
  |---|---|
  | proxy `git rev-parse --show-toplevel` | `$T/repo/.claude/agents/…` no existe → **repliegue** |
  | ascenso por `.claude/` | lo encuentra en `$T` → **bloquea** |

  El test exige **bloquea**. Es la única aserción de la suite que falla si R3 se implementa con
  el resolvedor equivocado, así que su comentario debe decirlo para que nadie la "simplifique"
  después. · test: `pr-pilot-confirm.test.ts`::`no toca el PR que viene de un subagente`,
  `::`se repliega cuando no hay pilot al que delegar`,
  `::`un subdirectorio no es un repliegue: el pilot se descubre hacia arriba`,
  `::`encuentra el pilot por encima de la raíz de git — el brazo que descarta el proxy`
  con `// Covers: R2, R3`

- [ ] **T6** (R7, R8) — Fail-open y registro. Sin `jq`, con payload ilegible o con comando
  vacío: exit 0 (la dirección del fail-open cambia respecto a #712 — antes era callarse,
  ahora es no bloquear). Y los cuatro veredictos de la tabla de contratos del diseño tienen
  que salir distinguibles en el log, sin que un `git status` escriba ninguno. · test:
  `pr-pilot-confirm.test.ts`::`deja pasar cuando el guard no puede decidir`,
  `::`cada veredicto queda registrado con su razón` con `// Covers: R7, R8`

## Lote 3 — el override contable

- [ ] **T7** (R5) — Honrar `.claude/progress/pr-override` relativo a la raíz que resuelve
  `navori_worktree`: si su primera línea tiene texto, exit 0, registro con `verdict: override`
  y esa razón truncada a 200 caracteres, y **borrar el archivo**. Si el borrado falla, honrarlo
  igual y añadir `(centinela no consumido)` a la razón. La ruta no se agrega a
  `EPHEMERAL_HARNESS_PATHS`: `.claude/progress/` ya está ahí y el archivo hereda `.gitignore`,
  exclusión del backup y el check de `doctor`. · test:
  `pr-pilot-confirm.test.ts`::`el override pasa una vez y se consume` con `// Covers: R5`

- [ ] **T8** (R6) — Centinela presente sin razón legible (vacío, solo espacios, ilegible):
  bloquea igual, y el stderr dice que el centinela necesita una razón. Sin este caso, un
  `touch` es un bypass permanente y el override deja de ser contable — que es todo el
  propósito del lote. · test:
  `pr-pilot-confirm.test.ts`::`un centinela sin razón no ampara nada` con `// Covers: R6`

## Lote 4 — cerrar el contrato viejo

- [ ] **T9** (R1) — Invertir el caso `NUNCA bloquea — el exit es 0 incluso cuando eleva` de la
  suite existente: no se borra, pasa a fijar el contrato nuevo, y su comentario dice contra
  qué medición cambió. Reescribir la cabecera del hook, que hoy promete "is raised to a user
  confirmation" — `hook-claims-vs-scripts.test.ts` exige que una prosa que dice "blocks"
  contenga `exit 2`, así que el mecanismo y su descripción se mueven juntos o el gate lo caza.

  **Y los dos comentarios TS que quedarían mintiendo**, que ningún test cubre porque ese gate
  solo valida cabeceras de scripts shell: `build-settings.ts:123-127` ("It does not block: it
  answers `ask`, which routes the call to the user") y `harness-plan.ts:183-184` ("to a user
  confirmation"). Los bytes que esos archivos emiten no cambian —el bloque managed de
  `settings.json` se queda idéntico—, solo su prosa; pero es área crítica de este repo y un
  comentario falso sobre un hook que bloquea es exactamente lo que hace perder una hora al
  siguiente que lo lea.

  Nota en el changelog: un comando que antes pasaba con confirmación ahora no pasa. ·
  test: `pr-pilot-confirm.test.ts`::`el exit deja de ser 0 cuando hay ruta al pilot` con
  `// Covers: R1`

## Cierre

Con el guard en `main`, medir contra el pre-registro de T1 —y contra nada más—:

```
python3 scripts/mine-pr-routing.py                       # el embudo
python3 scripts/mine-activation.py sessions.txt          # pr-opp / pr-act por repo
```

Ventana: 20 bloqueos o 14 días, lo que ocurra primero. El resultado se escribe en
`docs/research/ruteo-del-pr.md` **salga como salga, incluido nulo o inverso**, y se adjudica
con la tabla 2×3 del diseño, que cubre el plano (A, B) entero: fracaso → se revierte a `ask` en
el mismo PR que publica el número; `éxito con fuga` (A ≥ 50%, B > 30%) → se queda y las razones
de override agrupadas abren el issue que convierte cada clase legítima recurrente en un
repliegue de R3.
