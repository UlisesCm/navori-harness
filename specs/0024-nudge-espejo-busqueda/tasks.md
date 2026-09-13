# Nudge espejo de búsqueda — Tasks

Lotes de 1–3. El orden importa: el lote 1 deja un script que se puede ejercitar
con payloads sintéticos antes de que nada lo registre, igual que hizo la spec
0020.

## Lote 1 — el contador

- [ ] **T1** (R1, R2, R4, R5) — `packages/plugins/engram/scripts/memory-watch.sh`:
  hook `PostToolUse` que lee `tool_name`, `session_id` y `tool_input.file_path`
  con el partial `extract-cmd`; clasifica la ruta con
  `# navori:include classify-source`; acumula una línea `path:<ruta>` por archivo
  fuente distinto en `.claude/.memory-watch/<session_id>`; al llegar a 10 marca
  `#notified` y emite el aviso por
  `hookSpecificOutput.additionalContext`. Un `mem_search` observado marca
  `#searched` y desarma el resto de la sesión. Sello, barrida por `mtime +7` y
  contrato de salida 0 en todo camino, calcados de `routing-watch.sh`.
  · test: `packages/cli/src/lib/__tests__/memory-watch.test.ts` — casos
  `"emite el aviso a los 10 archivos fuente distintos"`,
  `"diez lecturas del mismo archivo no son diez archivos"`,
  `"no cuenta docs, tests ni rutas fuera del repo"`,
  `"emite exactamente una vez, aunque la sesión siga leyendo"`,
  `"un mem_search desarma el aviso para el resto de la sesión"` y
  `"sale 0 y sin permissionDecision incluso con el sello no escribible"`, todos
  con `// Covers: R1, R2, R4, R5`.

- [ ] **T2** (R3) — las otras dos vías en el mismo script: `Bash` con verbo de
  lectura (`cat`, `head`, `tail`, `sed -n`, `grep`) del que se extraen los
  operandos que la definición clasifica como `source`, precedido por un `case`
  sin forks sobre el payload crudo que descarta el comando sin verbo de lectura;
  y `mcp__codegraph__codegraph_explore`, que cuenta como una entrada distinta
  por `query` porque no nombra un archivo.
  · test: mismo archivo — casos `"las diez lecturas por shell llegan al umbral"`,
  `"mezcla las tres vías, porque la sesión las mezcla"` y
  `"un Bash sin verbo de lectura no cuenta ni gasta"`, con `// Covers: R3`.

- [ ] **T3** (R7) — guarda de subagente: cuando el payload trae `agent_id` no
  vacío, el hook sale 0 sin emitir y **sin** marcar `#notified`, de modo que el
  aviso de la sesión sigue disponible para el hilo principal.
  · test: mismo archivo — caso
  `"nunca avisa dentro de un subagente, y no consume el aviso de la sesión"`,
  con `// Covers: R7`.

## Lote 2 — el cableado

- [ ] **T4** (R3, R8) — `packages/plugins/engram/plugin.json` gana la entrada
  `scripts` (`scripts/memory-watch.sh` → `memory-watch.sh`, `exec: true`) y la
  entrada `hooks` (`event: "PostToolUse"`, `matcher:
  "Read|NotebookRead|Bash|mcp__engram__mem_search|mcp__codegraph__codegraph_explore"`,
  `timeout: 10`, `statusMessage: "navori/engram: memory check"`).
  `EPHEMERAL_HARNESS_PATHS` gana `.claude/.memory-watch/` **al final** de la
  lista, porque el orden está hasheado en el bloque `.gitignore` de todo repo ya
  onboardeado. Se regeneran los golden de `engines/__tests__/__golden__/`.
  · test: `packages/cli/src/lib/__tests__/memory-watch.test.ts` — caso
  `"queda registrado en PostToolUse con un matcher que admite todo lo que cuenta"`
  (afirma que el bucket que lleva `memory-watch.sh` contiene `Read`, `Bash` y
  `mem_search`, y que el sello está en `EPHEMERAL_HARNESS_PATHS`) y caso
  `"sin el plugin engram no se renderiza ni el script ni el hook"`, con
  `// Covers: R3, R8`.

## Lote 3 — la no-colisión con el upstream

- [ ] **T5** (R6) — antes de emitir, el hook lee
  `${TMPDIR:-/tmp}/engram-claude-<session_id>-last-nudge`. Si su epoch es más
  reciente que `${ENGRAM_NUDGE_COOLDOWN_SECS:-900}` segundos, marca `#deferred` y
  sale 0 sin emitir; el siguiente cruce reintenta. Tras el tercer `#deferred`
  emite igual. Archivo ausente, vacío o no numérico ⇒ no hay diferimiento.
  · test: mismo archivo — casos
  `"difiere el aviso cuando el nudge de guardado del upstream acaba de salir"`,
  `"emite cuando el sello del upstream ya está frío"` y
  `"emite igual tras tres diferimientos: un aviso que nunca llega no es un mecanismo"`,
  con `// Covers: R6`.

## Lote 4 — la medición

- [ ] **T6** (R9) — señal `memory-notice` en
  `packages/cli/src/lib/audit/signals.ts`, gemela de `routingNotice`: filtra los
  `hookEvents` con `name === "memory-watch"` y `verdict === "notify"` y devuelve
  dos estados —el aviso salió y la sesión terminó llamando `mem_search`, o salió
  y no—. `packages/cli/src/lib/audit/report.ts` agrega la fila del embudo al
  bloque de engram, junto a las de escrituras y lecturas de #755.
  · test: `packages/cli/src/lib/audit/__tests__/signals.test.ts` — casos
  `"el aviso de memoria salió y la sesión buscó"` y
  `"el aviso de memoria salió y la sesión no buscó"`, con `// Covers: R9`.

- [ ] **T7** (R9) — `docs/research/nudge-busqueda-preregistro.md`: el embudo
  escrito antes del primer dato. Lleva el denominador, el numerador, la línea
  base 20% (11/56) con la tabla de la que sale, los tres cortes (≥40% se queda ·
  ≤25% se retira el hook · 25–40% se extiende a 80 emisiones con kill en ≤30%),
  el sesgo conocido de H₀ —se calculó sin el diferimiento de R6, así que el
  denominador vivo es un subconjunto— con su regla de recálculo (si los
  `#deferred` que nunca emitieron superan el 15% de los cruces, H₀ se recalcula
  antes de aplicar los cortes), y la regla de alcance: **este embudo responde por
  `memory-watch` y por nada más**; la palanca consultiva solo se juzga con dos
  instrumentos vivos, es decir éste más `routing-watch` una vez que #767
  reconecte su carril `Bash` y acumule sus propias 40 emisiones. Se referencia
  desde `design.md` y desde el issue #759.
  · test: `packages/cli/src/lib/__tests__/memory-watch.test.ts` — caso
  `"el pre-registro existe y declara su línea base antes del primer dato"`
  (afirma que el archivo está en el repo y contiene el corte de muerte), con
  `// Covers: R9`.
