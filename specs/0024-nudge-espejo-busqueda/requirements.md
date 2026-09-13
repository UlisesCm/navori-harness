# Nudge espejo de búsqueda — Requirements

## Context

El canal de ESCRITURA de engram tiene tres refuerzos mecánicos —el protocolo que
el plugin upstream inyecta en cada arranque (11 bullets de save contra 4 de
search), un nudge cada 15 minutos en `UserPromptSubmit`
(`scripts/user-prompt-submit.sh`, cooldown 900s) y las instrucciones del MCP
server—. El canal de LECTURA no tiene ninguno: el pre-flight `mem_search` que
pide `engram-protocol.md` es prosa, y solo prosa.

Lo que eso produce, medido sobre los 197 transcripts de esta máquina (17 ago –
13 sep), 174 de ellos con al menos una lectura de código en el hilo principal:

| Hecho | Medición |
|---|---|
| Sesiones que nunca llaman `mem_search` | **60 / 174 (34%)** |
| Sesiones que sí, y lo hacen como su PRIMER evento contado | **89 / 114 (78%)** |
| Archivos fuente distintos leídos por sesión | mediana **31**, p90 **109** |
| Lecturas de código después del ÚLTIMO `mem_search` | mediana **20**, p90 **133** |
| Lecturas por la vía nativa (`Read`) vs. por shell | **292 vs 10,544** |

Las dos últimas filas son las que fijan el diseño. La búsqueda que ocurre es la
ceremonial del primer mensaje —la que menos aporta, porque `SessionStart` ya
inyectó ~10K caracteres de contexto— y detrás de ella la sesión lee decenas de
archivos sin volver a consultar memoria. Y el 97% de esas lecturas entran por
`Bash`, no por `Read`: un contador que solo mire la vía nativa es inalcanzable
por construcción, que es exactamente el defecto que #722 A4 encontró en el hook
gemelo.

El precedente de la palanca es la spec 0020: `routing-watch` entrega una línea
consultiva por `additionalContext` de `PostToolUse`, una sola vez por sesión,
sin bloquear nada. Esta spec es esa misma palanca aplicada al canal de lectura.

**Lo que esta spec NO toca, por moratoria de doctrina**: los triggers de save
del upstream, `engram-protocol.md`, el bloque `## Engram` de `CLAUDE.md` y los
assets de subagente. El ratio 4:1 escritura/lectura es el diseño del autor del
plugin y el volumen de escritura no es el problema. Lo que se agrega es un
mecanismo, no un párrafo.

## Requirements (EARS)

- **R1** — WHEN el hilo principal de una sesión haya leído **10 o más archivos
  fuente distintos** sin que se haya llamado `mem_search` ni una vez en esa
  sesión, el sistema SHALL entregarle al modelo una línea consultiva a través
  del `additionalContext` del hook `PostToolUse`.

  El umbral es 10 y su criterio está en `design.md` (§ *El umbral*): sobre los
  dos ejes medidos —cobertura de la población objetivo y pre-emption de una
  búsqueda que iba a ocurrir igual— 10 es **el único punto que domina a sus dos
  vecinos**, es decir el codo del frente. No es el único no dominado: el frente
  tiene seis puntos ({3, 4, 5, 10, 15, 20}) y elegir entre los otros cinco sería
  preferencia. En 10 no lo es, porque el paso 8 → 10 quita ruido sin costar
  cobertura y el paso 10 → 12 cuesta cobertura sin quitar ruido.

- **R2** — El sistema SHALL decidir qué cuenta como "lectura de código" con la
  **definición compartida** del repo (`lib/source-classify.ts`, materializada en
  `_partials/classify-source.sh`), aplicada a la ruta relativa al repo. Una
  lectura de una ruta fuera del repo, o de una ruta que la definición no clasifica
  como `source`, NO SHALL contar.

- **R3** — El sistema SHALL contar las lecturas de **las tres vías** por las que
  el modelo obtiene fuente: las herramientas nativas (`Read`, `NotebookRead`),
  los comandos de lectura por shell (`Bash`) y `codegraph_explore`. El `matcher`
  con el que el hook queda registrado SHALL admitir toda vía que el script
  cuenta, y un test SHALL fijar esa correspondencia.

- **R4** — El aviso SHALL ser consultivo: el hook NO SHALL bloquear ninguna
  llamada a herramienta, SHALL salir con código 0 en todos sus caminos —incluidos
  los de fallo— y SHALL emitirse como máximo **una vez por sesión**.

- **R5** — WHEN se observe una llamada a `mem_search` en la sesión, el sistema
  SHALL desarmar el aviso para el resto de esa sesión. Un aviso ya emitido NO
  SHALL volver a emitirse, ni siquiera después de una compactación.

- **R6** — IF el nudge de guardado del upstream se emitió dentro de su ventana de
  cooldown (`ENGRAM_NUDGE_COOLDOWN_SECS`, 900s por defecto), THEN el sistema
  SHALL **diferir** su aviso al siguiente cruce del umbral en vez de emitirlo en
  la misma ventana. El diferimiento SHALL estar acotado: tras **3** diferimientos
  el aviso se emite de todos modos.

- **R7** — El aviso SHALL emitirse **solo en el hilo principal**. WHEN el payload
  del hook traiga un `agent_id` —es decir, cuando la llamada venga de dentro de
  un subagente— el sistema NO SHALL emitir nada ni consumir el aviso de la
  sesión.

- **R8** — El hook SHALL renderizarse únicamente en los repos donde el plugin
  `engram` está habilitado, y SHALL desaparecer del `settings.json` y del disco
  cuando el plugin se deshabilita.

- **R9** — WHEN se emite el aviso, el sistema SHALL registrarlo en el log de
  audit, y el reporte de `navori audit` SHALL expresar el **embudo
  pre-registrado**: de las sesiones donde el aviso disparó, qué fracción terminó
  llamando `mem_search`. La línea base contra la que se compara es **20%
  (11/56)** y está fijada en `design.md` § *El embudo pre-registrado* antes de
  que exista un solo dato nuevo.
