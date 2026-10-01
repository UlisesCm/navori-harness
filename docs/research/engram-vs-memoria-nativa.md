# Engram contra la memoria automática nativa

> Tarea **T39** de la spec 0039 (fase F8), requisito **R50**. Medición del **2026-09-30** con Claude
> Code **2.1.286**, engram **2.2.1** (plugin `engram@engram` 0.1.5) y Codex con engram por MCP.
> Fuentes:
> [`requirements.md`](../../specs/0039-claude-first/requirements.md) § J,
> [`design.md`](../../specs/0039-claude-first/design.md) § "Verificaciones pendientes" y las filas
> de memoria de [`claude-first-verificacion.md`](claude-first-verificacion.md).

## Por qué existe este archivo

R50 pide decidir con datos si engram sigue ganándose su lugar ahora que Claude Code trae memoria
automática propia. Este documento compara las dos en las cinco dimensiones de R50 y propone un
veredicto. **No registra la fila de la matriz**: eso lo hace T40 (R51), y la fila queda sujeta al
refine de D2.

## Método

- **Ventana:** desde el 2026-09-01 hasta el 2026-09-30. Solo cuentan líneas con `timestamp`
  dentro de la ventana, en archivos modificados dentro de ella.
- **Corpus de Claude Code:** `~/.claude/projects/*/*.jsonl` (hilo principal: 383 archivos, 381
  sesiones) y, aparte, `~/.claude/projects/*/*/subagents/*.jsonl` (2165 archivos). Lectura sola.
- **Corpus de Codex:** `~/.codex/sessions/2026/*/*/*.jsonl` (811 archivos en la ventana), eventos
  `item_completed` con `item.type = "McpToolCall"` y `item.server = "engram"`.
- **Instrumento:** dos scripts de Python en el scratchpad de la sesión, fuera del repo
  (`mine_engram.py` y `native_and_codex.py`). Cuentan llamadas `mcp__engram__*` y
  `mcp__plugin_engram_engram__*` por herramienta, deduplicadas por `tool_use.id`. Miden:
  - el tamaño del input como `len(json.dumps(input))` en caracteres;
  - el tamaño del output como la longitud del texto del `tool_result` emparejado;
  - los tokens desde el `usage` del mensaje del asistente que emite la llamada.
- **Tokens:** las columnas de caracteres se pasan a tokens con la aproximación `chars / 4`. Los
  tokens de contexto por request (`input_tokens + cache_read_input_tokens +
  cache_creation_input_tokens`) son exactos y salen del `usage`. Un request "solo engram" es un
  mensaje del asistente cuyas únicas `tool_use` son de engram.
- **Inyección de arranque:** adjuntos `hook_success` con `hookEvent: SessionStart` cuyo contenido
  trae el bloque de engram. Se cuenta solo su longitud.
- **Sin datos sensibles:** ningún script imprime contenido de memorias, prompts ni resultados.
  Solo conteos, tamaños, nombres de herramientas, nombres de claves de input y los primeros
  caracteres normalizados de los mensajes de error.
- **Base de engram:** `engram stats --all`, `engram projects list` y `engram conflicts stats`
  (lectura), más un `sqlite3 -readonly` de conteo sobre `observations`.
- **Memoria nativa:** el tamaño en líneas y bytes de cada `~/.claude/projects/*/memory/MEMORY.md`,
  más los `Write`/`Edit` cuyo `file_path` cae en un directorio `memory/` de un proyecto.

## Cifras de partida

| | Engram | Memoria nativa |
|---|---|---|
| Almacén | `~/.engram/engram.db` (SQLite, 97.7 MB) | `~/.claude/projects/<repo>/memory/` (Markdown) |
| Volumen vivo | 4535 observaciones, 55 proyectos, 1438 sesiones, desde 2026-03-19 | 41 directorios `memory/`; 7 con `MEMORY.md` |
| Tamaño del índice cargado | n/a (contexto armado por consulta) | `MEMORY.md` de 1 a 11 líneas, de 101 a 1961 bytes |
| Escrituras en la ventana | 1106 `mem_save` (hilo principal) | 111 (`Write` 92, `Edit` 19) en 41 sesiones |
| Sesiones del hilo principal con uso | 258 de 381 (68%) | 41 |

## 1. Búsqueda entre proyectos

**Nativa.** La doc verificada dice que la memoria automática es *"Per repository, shared across
worktrees"* ([memory](https://code.claude.com/docs/en/memory)). No hay búsqueda entre repos: cada
proyecto ve solo su `MEMORY.md` y sus archivos de tema.

**Engram.** Es una sola base para todos los proyectos. `mem_search` acepta `project` y
`all_projects`, y la CLI expone `engram search --project PROJECT|--all`. Uso real en la ventana:

| Corpus | `mem_search` | Con `project` | Con `all_projects` |
|---|---|---|---|
| Hilo principal | 277 | 33 | 20 |
| Subagentes | 429 | 25 | 28 |
| **Total** | **706** | **58** | **48** |

El 15% de las búsquedas (106 de 706) sale del proyecto actual. Es el caso del Dominio y del
workspace Bonum (varios repos), que la memoria nativa no cubre.

## 2. Persistencia entre sesiones

Las dos persisten entre sesiones y son locales a la máquina. De la nativa, la doc dice *"Auto
memory is machine-local. … Files are not shared across machines or cloud environments."* Engram
también vive en un archivo local, pero trae `engram sync` (chunks versionables en `.engram/`) y
`engram cloud` como opción. Diferencias observadas:

- **Profundidad.** Engram guarda 4535 observaciones desde marzo. La nativa tiene 7 índices con un
  máximo de 11 líneas: en este equipo casi no se usa.
- **Subagentes.** La doc verificada dice *"The main conversation's auto memory isn't loaded into
  subagents; the exception is a fork"*. En la ventana, los subagentes hicieron 885 llamadas a
  engram (429 `mem_search`, 325 `mem_save`). Esa memoria no tiene equivalente nativo dentro de un
  subagente.
- **Fiabilidad de escritura.** Hay 275 `mem_save` con error en la ventana (97 en el hilo
  principal, 178 en subagentes). 258 de ellos son la misma clase, `failed to save … multiple
  active …`. Es decir, un guardado fallido que el agente tiene que reintentar o pierde.

## 3. Carga en el arranque

**Nativa.** *"The first 200 lines of `MEMORY.md`, or the first 25KB, whichever comes first, are
loaded at the start of every conversation."* Es un techo de unos 6 K tokens. Con los índices
reales (máximo 1961 bytes) la carga observada es de menos de 500 tokens, y cero en los 34
directorios `memory/` sin `MEMORY.md`.

**Engram.** El hook `SessionStart` (`scripts/session-start.sh`, matcher
`startup|resume|clear|fork`) inyecta dos cosas:

- El protocolo completo (modo `full`; `engram protocol-mode claude-code` devuelve `full`), de unos
  2.4 KB.
- El contexto del proyecto, pedido con `compact=1&pinned=20&max_bytes=16384`.

Además, `UserPromptSubmit` inyecta una vez la instrucción de cargar las herramientas por
`ToolSearch`.

| Inyección (hilo principal) | n | Mediana | p95 | Máximo | Total |
|---|---|---|---|---|---|
| `SessionStart` de engram | 336 | 5058 caracteres (~1.3 K tokens) | 9754 (~2.4 K) | 9987 | 1,652,114 caracteres |
| `UserPromptSubmit` de engram | 345 | 1359 caracteres (~340 tokens) | — | — | 333,148 caracteres |

Engram carga por arranque más que la nativa *tal como se usa hoy*, pero menos que el techo nativo
(25 KB). A esto se suman las instrucciones del servidor MCP y la sección de engram de `CLAUDE.md`,
que son residentes y no se midieron aquí. En subagentes, el `SessionStart` de engram solo apareció
1 vez: los subagentes buscan bajo demanda.

## 4. Costo por llamada, incluido `mem_judge`

### Llamadas por herramienta (hilo principal, n = 3281 en 258 sesiones)

| Herramienta | n | Input mediana / p95 (caracteres) | Output mediana / p95 (caracteres) | Output total | Errores | `output_tokens` del mensaje (mediana) |
|---|---|---|---|---|---|---|
| `mem_judge` | 1408 | 67 / 205 | 351 / 444 | 493,838 | 6 | 98 |
| `mem_save` | 1106 | 1525 / 3576 | 416 / 1434 | 839,898 | 97 | 914 |
| `mem_search` | 277 | 69 / 120 | 876 / 7250 | 486,852 | 0 | 206 |
| `mem_session_summary` | 261 | 3152 / 4617 | 256 / 362 | 64,902 | 48 | 1489 |
| `mem_get_observation` | 116 | 12 / 12 | 2159 / 4682 | 304,663 | 4 | 108 |
| `mem_context` | 64 | 43 / 65 | 4973 / 10752 | 412,205 | 1 | 134 |
| `mem_update` | 41 | 1527 / 4348 | 315 / 406 | 12,544 | 0 | 803 |
| otras (3) | 8 | — | — | 1,067 | 0 | — |

Total: 3,003,230 caracteres de input (~751 K tokens) y 2,615,969 de output (~654 K tokens).

En subagentes hubo 885 llamadas (`mem_search` 429, `mem_save` 325, `mem_judge` 57): unos 160 K
tokens de input y 179 K de output.

### El costo real es el request, no el payload

Cada llamada a engram ocupa un turno del modelo, y cada turno vuelve a leer el contexto completo
(casi todo como lectura de caché).

| Hilo principal | Requests | Contexto por request (mediana) | Contexto total | `output_tokens` total |
|---|---|---|---|---|
| Requests con alguna llamada a engram | 2316 | — | — | — |
| Requests **solo** de engram | 1801 | 208,613 tokens | 471.1 M tokens | 1.65 M |
| — de ellos, encabezados por `mem_judge` | 502 | 206,417 tokens | 124.6 M tokens | 162 K |

En subagentes hubo 414 requests solo de engram (mediana de 102,723 tokens de contexto, 50.3 M en
total).

### `mem_judge`

- Es la herramienta más llamada: **43% de las llamadas del hilo principal** (1408 de 3281).
- La dispara el flujo `judgment_required`: 1009 de los resultados de `mem_save`/`mem_update` del
  hilo principal lo traían (147 en subagentes). Eso da 1.27 `mem_judge` por `mem_save`.
- Su payload es mínimo (mediana de 67 caracteres de input y 351 de output). Su costo está en los
  502 requests extra que abre: **124.6 M tokens de contexto en un mes** (26% de lo que cuestan
  todos los requests solo de engram) para registrar relaciones. En el proyecto `navori-harness`,
  `engram conflicts stats` muestra 781 de 1008 relaciones como `related`, el veredicto de menor
  valor.
- La memoria nativa no tiene paso equivalente: escribe con `Write`/`Edit` y no juzga conflictos.

## 5. Soporte en Codex

**Memoria nativa de Codex.** Fila verificada en
[`claude-first-verificacion.md`](claude-first-verificacion.md):

> https://learn.chatgpt.com/docs/customization/memories?surface=app — *"Local Codex memories are
> off by default."* y *"The main memory files live under ~/.codex/memories/"*

Es una memoria aparte, apagada por defecto y en otro almacén (`~/.codex/memories/`, vacío en este
equipo). La memoria automática de Claude Code no la lee Codex ni al revés.

**Engram en Codex.** Está conectado como `[mcp_servers.engram]`, con plugin `engram@engram`
(hooks `session_start`, `user_prompt_submit`, `pre_tool_use`, `stop`, `session_end`) y
`model_instructions_file` propio. En la ventana tuvo uso real:

| Herramienta | Llamadas en Codex |
|---|---|
| `mem_judge` | 1435 |
| `mem_save` | 657 |
| `mem_search` | 477 |
| `mem_session_summary` | 288 |
| `mem_context` | 130 |
| `mem_get_observation` | 84 |
| otras | 28 |
| **Total** | **3099 en 455 de 811 sesiones** |

Engram es hoy la única memoria compartida entre los dos engines: lo que guarda Claude Code lo
busca Codex en la misma base. Reemplazarlo rompe esa paridad, que es un invariante multi-engine de
[`DIRECTION.md`](../DIRECTION.md). `mem_judge` vuelve a ser ahí la herramienta más llamada (46%).

## Veredicto propuesto

**`recortar`.** Engram se conserva como memoria, pero se le quita peso.

**Por qué no `reemplazar`.** La nativa pierde en tres de las cinco dimensiones, con evidencia:

- no busca entre proyectos (106 búsquedas del mes lo hicieron);
- no entra en subagentes (885 llamadas de subagentes no tendrían destino);
- no existe en Codex (3099 llamadas, y la memoria de Codex está apagada por defecto y es otro
  almacén).

Además, `reemplazar` mapea a `reemplazar-por-nativo` y el refine de D2 exige `native.url` en la
allowlist, `native.verifiedAt`, `engines.claude === "native"` y emisión nativa. Las citas
verificadas de `/memory` respaldan las *limitaciones* de la nativa, no una capacidad equivalente.

**Por qué no `conservar` tal cual.** El costo está concentrado y es recortable:

- `mem_judge` es el 43% de las llamadas del hilo principal y el 46% de las de Codex. Abre 502
  requests propios que releen ~206 K tokens cada uno (124.6 M de contexto en el mes), y en
  `navori-harness` el 77% de las relaciones queda en `related`.
- 275 `mem_save` fallaron en el mes, 258 por la misma clase de error (`multiple active`).
- La inyección de arranque usa el protocolo `full` (~2.4 KB) en cada sesión, además de las
  instrucciones del servidor MCP y la sección de `CLAUDE.md`.

**Recortes candidatos** (para decidir en T40 o en una spec propia; aquí no se implementa nada):

1. Sacar `mem_judge` del turno del agente: resolver `related`/`compatible` sin llamada, y pedir
   juicio solo para `supersedes`/`conflicts_with` en tipos `architecture`/`policy`/`decision`.
2. Probar el modo `slim` de `engram protocol-mode` y medir la diferencia de la inyección.
3. Diagnosticar el error `multiple active` antes de cualquier otra medida de volumen de guardados.
4. Dejar la memoria nativa para lo que hace bien (notas de un solo repo y del hilo principal), sin
   duplicar en engram lo que ya está en `MEMORY.md`.

**Registro.** La fila de la matriz de R2 (`evaluation: { kind: "engram", … }`) la registra
**T40** (R51). `recortar` no es `reemplazar-por-nativo`, así que no necesita la verificación
oficial del refine D2 más allá de lo que exija la fila. Un `reemplazar` futuro sí la exigiría:
URL de la allowlist, fecha de verificación y emisión nativa, además de resolver la búsqueda entre
proyectos y la paridad con Codex.
