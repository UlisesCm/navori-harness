# Runbook — curación del corpus de engram (#761, decisión 1)

> **Este documento no muta nada.** Es el procedimiento escrito para una operación que sí muta:
> `~/.engram/engram.db`, el store personal del usuario, que vive fuera de este repo, fuera de git,
> sin diff y sin deshacer. Leerlo entero cuesta menos que restaurar un `export`.
>
> Todas las cifras se midieron el **2026-09-13 a las 21:04 CST** contra `engram v1.20.0`. El corpus
> está vivo: **derivan**. Al final está cómo re-medirlas.

## Por qué existe este documento

[#761](https://github.com/UlisesCm/navori-harness/issues/761) empaqueta dos decisiones del usuario.
La **decisión 2** —`researcher` y `explorer` con memoria— **ya se tomó y se entregó** en `4dd7a78`
(#768), cuyo cuerpo dice literal *"Decisión 2 de #761"*. Está cerrada con evidencia al final de este
doc.

La **decisión 1** —la pasada de curación del corpus— sigue abierta, y **no la puede tomar un PR**.
No hay archivo del repo que tocar: es mutación de una base de datos que ningún revisor ve y que
ningún `git revert` recupera.

Este runbook es el entregable que sí cabe en un PR: convierte una decisión abierta en un **sí/no
informado**. Trae el estado medido, el procedimiento ordenado de menor a mayor riesgo, y las guardas
escritas donde la evidencia dice que hacen falta.

**Y ya se había escrito una vez.** `specs/0005-search-efficiency-layer/design.md:137` rotuló esta misma
operación **"Higiene one-time del store personal (acción, no feature de navori)"**, y `:206` la dejó
como decisión abierta literal: *"¿Ejecutar la higiene one-time del store personal (§5.3) ahora,
aparte del plan?"*. #761 decisión 1 **es esa misma pregunta, redescubierta por otro camino meses
después**. Que este documento exista es lo que evita la tercera vez.

---

## ⛔ Lo que no puede correrse a ciegas

Dos comandos de esta familia hacen daño con la sintaxis que uno teclearía por reflejo. Van primero
porque el orden de lectura importa más que el orden lógico.

### Trampa 1 — `engram projects consolidate --all` fusiona repos distintos

Corrido el **2026-09-13 21:04 CST**, `engram projects consolidate --all --dry-run` propone **7
grupos**. El **grupo 4 es destructivo**:

| grupo 4 — se fusionaría dentro de `navori-harness` | obs |
|---|---:|
| `alertaciudadana` | 1 |
| `alertaciudadana_app` | 237 |
| `alertaciudadana_backend` | 227 |
| `alertaciudadana_backend_audit` | 1 |
| `navori` | 14 |
| `navori-ab-smoke2` | 0 |
| `navori-dashboard-template` | 96 |
| `navori-health` | 104 |
| **total absorbido** | **680** |

**680 observaciones de repos reales distintos colapsadas dentro de `navori-harness`** (que tiene
681), con la memoria de dos productos ajenos mezclada en la de éste. El **grupo 5** mete
`reports-server-bonum` (38 obs) dentro de `notifications-server` (60).

Y **el modo interactivo tampoco es seguro por default**: corrido sin `--all` desde la raíz del
repo, el comando detecta `navori-harness` y ofrece fusionar `navori` (14 obs) y `navori-health`
(104 obs) dentro de él. Las dos son bases de código distintas. La respuesta correcta a ese prompt
era `none`, que es la que se dio.

**Regla: `--all` está prohibido.** Solo por grupo verificado a mano, vía el prompt interactivo,
seleccionando números explícitos. Los grupos legítimos del dry-run de hoy —todos de 0–3 obs en el
lado que se absorbe— son:

- `bonum-services-sessions` (1) → `services-sessions` (12)
- `poker-2` (3) → `poker` (3)
- `codex-spike` (0) + `codex-spike2` (0)
- `.g-p-683086de…-previous-dcdb38aa…` (1) → `g-p-683086de…` (3)
- `alertaciudadana` (1) y `alertaciudadana_backend_audit` (1) → **a su repo real**

Ese último punto tiene una arruga que hay que ver: `alertaciudadana` y `alertaciudadana_backend_audit`
sí deberían consolidarse, pero **el grupo 4 los manda a `navori-harness`, no a su repo**. Aceptar el
grupo para llevarse lo legítimo se lleva también el desastre. Van por separado, desde el directorio
del repo que debe quedar como canónico.

Y uno que el dry-run propone y **no hay que aceptar aunque sea chico**: el grupo 2 fusiona
`con-harness` (4 obs) con `sin-harness` (0 obs). Los nombres son los dos brazos de una comparación;
fusionarlos borra justo la distinción que los hace útiles. Verificar antes de tocarlo.

### Trampa 2 — `engram export --help` escribe el export a un archivo llamado `--help`

`engram export` toma el destino como **argumento posicional**, y no tiene bandera de ayuda. Así que
`engram export --help` **no imprime nada de ayuda: escribe el export completo a un archivo llamado
`--help`**. Medido: **9.9 MB**, en `-rw-r--r--` (644), con las **1,798** filas de `user_prompts` en
claro adentro.

Corrido desde un repo, eso deja ese archivo **dentro de un working tree de git**, a un `git add -A`
de quedar commiteado para siempre.

Dos reglas que se derivan:

1. **El backup nunca se escribe dentro de un repo.** Destino fuera de todo working tree (`~/`,
   por ejemplo), y `git status` después de correrlo para comprobar que no cayó nada.
2. **Para descubrir banderas de `engram`, usa `engram help`** (o `engram --help`), que imprime la
   ayuda completa de todos los subcomandos y **no escribe nada**. `engram help <subcomando>` también
   es seguro, aunque ignora el argumento e imprime la misma ayuda global.

`engram <subcomando> -h` **no es una ruta confiable**: funciona en algunos (`engram doctor -h`
imprime un usage real) y en otros no (`engram stats -h` ignora la bandera y simplemente corre
`stats`). En los subcomandos cuyo primer argumento es posicional —`export`, `import`, `save`,
`search`, `delete`— `-h` puede interpretarse como el argumento: el efecto depende del subcomando y
solo `export` escribe un archivo, pero ninguno es una forma segura de pedir ayuda. **No lo pruebes
ahí.**

---

## Estado del corpus, medido

Medición del **2026-09-13 21:04 CST**, `sqlite3 -readonly` sobre `~/.engram/engram.db`. Solo
conteos y claves; ningún `observations.content` ni ningún `user_prompts.content` salió de la DB.

**La cifra deriva, y rápido.** Las observaciones vivas de `navori-harness` tomaron cinco valores
durante el ciclo de #760: 670 → 674 → 675 → 676 → **681**. Cualquier número de abajo hay que
re-medirlo antes de actuar sobre él.

### `navori-harness` — 681 observaciones vivas

| tipo | obs | % |
|---|---:|---:|
| `manual` (sin tipo curado) | 217 | **32 %** |
| `session_summary` | 132 | **19 %** |
| `decision` | 96 | 14 % |
| `project` | 60 | 9 % |
| `discovery` | 48 | 7 % |
| `architecture` | 39 | 6 % |
| `bugfix` | 37 | 5 % |
| `config` | 10 | 1 % |
| `pattern` | 7 | 1 % |
| `bug` | 6 | 1 % |
| `learning` | 5 | <1 % |
| `solution` · `bug_fix` | 4 c/u | <1 % |
| `task` · `reference` · `convention` | 3 c/u | <1 % |
| `preference` · `feedback` | 2 c/u | <1 % |
| `research` · `progress` · `incident` | 1 c/u | <1 % |

Los **durables** (`decision` + `architecture` + `convention` + `pattern`) suman **145 = 21 %**. O
sea: una de cada cinco escrituras es la que el protocolo describe como el objetivo, y casi un tercio
del corpus quedó en `manual`, el tipo por default.

### Los huecos

| señal | navori-harness | % del corpus vivo |
|---|---:|---:|
| sin `title` | **352** | 52 % |
| sin `topic_key` | **437** | 64 % |
| `revision_count > 1` | 47 | 7 % |
| soft-deleted | 0 | — |
| con `review_after` | 99 | 15 % |
| con `review_after` vencido | 0 | — |

De las 352 sin `title`, **64 son de tipo durable** (`decision` 41, `architecture` 23). Ésa es la
rebanada que rinde más en el paso 1: son las que alguien va a querer encontrar en seis meses y hoy
solo se distinguen abriéndolas una por una.

### El vocabulario de `type` está fragmentado

`bugfix` (37) + `bug` (6) + `bug_fix` (4) son **el mismo concepto en tres claves**. En toda la DB:
`bugfix` 311, `bug` 45, `bug_fix` 9. Mientras dure, `mem_search --type bugfix` deja fuera **10 de 47
en `navori-harness` (21 %)** y **54 de 365 en toda la DB (15 %)**.

### `engram doctor` sale `blocked`

```
engram doctor --json --project navori-harness
```

→ `"status": "blocked"`, 4 checks, 3 ok, **1 blocked**:

```
sync_mutation_required_fields — sync_mutation_payload_missing_required_fields
  observation payload missing required fields: title
  evidence: {"entity":"observation","entity_key":"obs-c08da4feeb4afbdd",
             "missing_fields":["title"],"op":"upsert","project":"navori-harness",
             "seq":15579,"target_key":"cloud"}
```

Es la observación **#2756** (`discovery`, viva, sin título). El detalle se ve con
`engram doctor --project navori-harness --check sync_mutation_required_fields`.

Es el mismo síntoma que las 352 sin título, un nivel más abajo: una mutación de sync encolada con el
campo faltante. **Ojo con la promesa**: titular el corpus elimina la *clase* de causa; que además
limpie esta mutación concreta (`seq` 15579) no está verificado. El propio `doctor` nombra su
siguiente paso como `engram cloud upgrade doctor --project navori-harness` — comando que **no
aparece en `engram help`** (los subcomandos documentados de `cloud` son `status`, `enroll`, `config`
y `serve`). Confirmarlo antes de correrlo.

### `embedding IS NOT NULL` ⇒ **0 filas**, pero el scan semántico no depende de ellas

Ni en `navori-harness` ni en toda la DB (2,964 observaciones vivas) hay un solo embedding. **Eso no
inutiliza `engram conflicts scan --semantic`**: esa vía usa el runner LLM configurado mediante
`ENGRAM_AGENT_CLI`, no la columna `embedding`.

Verificado el **2026-09-14 14:05 CST** con `ENGRAM_AGENT_CLI=claude`, `--dry-run`,
`--max-semantic 10`, concurrencia 1 y timeout de 20 segundos por llamada: inspeccionó 689
observaciones, encontró 3 candidatos, juzgó 1, omitió 2 y reportó 0 errores semánticos; `inserted: 0`
y `dry_run: true`. La corrida tardó varios minutos y el descubrimiento emitió tres errores FTS5 por
contenido que el parser no pudo convertir a query, pero terminó con exit 0. Es una fuente real de
candidatos, no una operación instantánea ni exhaustiva.

Las relaciones persistidas antes de esa corrida vienen de juicio: `engram conflicts stats --project
navori-harness` reportaba 9 relaciones juzgadas (6 `not_conflict`, 3 `related`) sobre 131 filas en
`memory_relations` en toda la DB. El `--dry-run` no agregó ninguna.

### Contexto global

`engram stats` y `engram projects list`, misma corrida: **2,964** observaciones vivas · **1,162**
sesiones · **1,798** prompts · **37** proyectos. En toda la DB hay **1,241** observaciones sin
`title` (42 %).

---

## El procedimiento

Ordenado de menor a mayor riesgo. **Los pasos se autorizan por separado**: 1 y 2 son baratos y
reversibles; 3 y 4 son los que piden pulso. Un "sí al 1 y al 2, el resto después" es una respuesta
completa y probablemente la mejor primera corrida.

### Paso 0 — el backup, innegociable

```
engram export ~/engram-backup-2026-09-13.json
```

Verificado: exit 0, imprime `Exported to <ruta>` y los tres conteos (`Sessions` / `Observations` /
`Prompts`). El artefacto trae `version`, `exported_at`, `sessions`, `observations` y **`prompts`**.

Tres cosas que van juntas con este comando:

- **Fuera de todo repo.** Ver la trampa 2. Después de correrlo, `git status` en cualquier working
  tree donde estés parado.
- **`chmod 600` inmediatamente.** El archivo nace en `-rw-r--r--` (644) y lleva los 1,798 prompts en
  claro. Hereda la misma exposición que la DB original.
- **Restaurar es `engram import <file>`**, documentado en `engram help`. No se probó en esta
  corrida. Para ensayarlo, usa **`ENGRAM_DATA_DIR`**, que recibe un directorio y hace que el binario
  abra `<directorio>/engram.db`; `ENGRAM_DB` no existe y se ignora silenciosamente. Antes del import,
  crea un directorio temporal privado y exige que `stats` muestre esa ruta y cero observaciones:

  ```sh
  restore_dir="$(mktemp -d "${TMPDIR:-/tmp}/engram-restore.XXXXXX")"
  chmod 700 "$restore_dir"
  ENGRAM_DATA_DIR="$restore_dir" engram stats
  # Solo si Database apunta a "$restore_dir/engram.db" y Observations es 0:
  ENGRAM_DATA_DIR="$restore_dir" engram import ~/engram-backup-2026-09-13.json
  ```

  No apuntes `ENGRAM_DATA_DIR` a `~/.engram` ni continúes si `stats` muestra el store real.

### Paso 1 — titular las observaciones sin `title`

**Riesgo: ninguno.** Es puro añadido: `mem_update(id, title)` no toca `content`, `type` ni
`topic_key`.

352 candidatas en `navori-harness`. Empezar por las **64 durables** (`decision` 41, `architecture`
23), que son las que un `mem_search` futuro va a querer distinguir por el título.

Un título se escribe **como la afirmación misma, no como etiqueta del tema**: los resultados de
búsqueda encabezan con él, así que un título vago obliga a abrir la observación completa solo para
saber de qué trata.

Además, es el paso que ataca la causa del `blocked` de `doctor`. Re-correr el doctor al terminar
para ver si el finding se fue o si hace falta el paso que el propio doctor sugiere.

### Paso 2 — normalizar el vocabulario de `type`

**Riesgo: bajo.** Reversible y mecánico: `bug` → `bugfix`, `bug_fix` → `bugfix`, vía `mem_update`.
10 observaciones en `navori-harness`, 54 en toda la DB.

Lo que gana: `mem_search --type bugfix` deja de mentir. Decidir antes si el alcance es solo
`navori-harness` o los 37 proyectos — el criterio correcto es el mismo en los dos casos, pero el
volumen no.

Los otros tipos huérfanos (`solution` 4, `task` 3, `progress` 1, `incident` 1, `project` 60) **no
entran en este paso automáticamente**: `project` con 60 filas no es ruido de tecleo, es un uso
deliberado que hay que entender antes de reescribir.

### Paso 3 — fusionar duplicados semánticos

**Riesgo: medio. Juicio de agente, uno por uno.** No hay corrida masiva aquí.

Empezar por los dos pares confirmados, verificados vivos en esta corrida:

| ids | type | topic_key |
|---|---|---|
| **2901** / **2902** | `discovery` / `manual` | `routing/tool-routing-audit` / `navori-audit-tool-routing-2026-09` |
| **2903** / **2904** | `discovery` / `manual` | `audit/skill-attribution` / `navori-skill-attribution-2026-09` |

**Por qué SQL no los ve, y ésta es la parte importante del runbook:** en `navori-harness` hay **0
`topic_key` con más de una fila viva** y **0 `normalized_hash` repetido**. Cero. Y aun así los cuatro
de arriba son dos pares del mismo hecho. Cada par difiere en `type` *y* en `topic_key` —una clave con
convención `<area>/<slug>`, la otra con el mes embebido—, así que ninguna regla determinista los
agrupa. **Un script no puede encontrar esto; un agente leyendo título y contenido sí.**
`specs/0005-search-efficiency-layer/design.md:129-130` ya lo había resuelto igual: *"Es juicio → agente, no
hook mecánico (un script no sabe qué es 'importante')"*.

`engram conflicts scan --project navori-harness --dry-run --semantic` está documentado en
`engram help` y **sí propone candidatos aunque haya 0 embeddings**: usa el runner indicado por
`ENGRAM_AGENT_CLI`. La corrida medida arriba encontró 3 y juzgó 1. El resultado sigue siendo una
propuesta que se revisa antes de aplicar. El resumen del comando no imprime los pares, así que esa
corrida no permite afirmar si incluyó los dos confirmados de esta tabla.

La fusión concreta es: consolidar el contenido bajo **una** observación con el `topic_key` que siga
la convención, y soft-delete de la otra (paso 4).

### Paso 4 — podar snapshots volátiles

**Riesgo: el más alto. Es el único paso que borra.**

- **Soft-delete, que es el default de `engram delete <obs_id>`. NUNCA `--hard`.** El `--hard` no
  tiene deshacer, y el corpus tiene hoy **0 soft-deleted**, así que la papelera está vacía y sirve.
- **Nunca sobre un `decision` ni un `architecture`.** No es preferencia: es lo que manda el propio
  protocolo que este harness renderiza —`packages/plugins/engram/managed/engram-protocol.md:11`,
  *"Never aggressive deletion, never delete a durable decision"*.
- Candidatas legítimas: mediciones puntuales, estado de PRs, resultados de una corrida — lo que el
  `session_summary` de esa sesión ya cubre. `mem_review(action: list)` lista lo que pasó su
  `review_after`; hoy son **0 de 99**, así que esa vía no aporta candidatos todavía y la selección
  es manual.
- `engram delete <obs_id>` no se corrió en esta medición. Está documentado en `engram help`.

### Resumen de autorización

| paso | qué hace | reversible | se puede autorizar solo |
|---|---|---|---|
| 0 | `engram export` | n/a | obligatorio, no es opcional |
| 1 | titular 352 | sí (`mem_update`) | sí |
| 2 | normalizar `type` | sí (`mem_update`) | sí |
| 3 | fusionar duplicados | sí, si el borrado es soft | sí, pero exige juicio por par |
| 4 | podar volátiles | sí, si es soft-delete | sí |

---

## Diagnóstico: siempre read-only, y sin texto

**El criterio**: `sqlite3 -readonly` con `COUNT` / `GROUP BY`, o `engram stats` / `engram doctor
--json`. **Nunca `SELECT content`. Nunca la tabla `user_prompts`.** Toda la medición de este
documento cumple eso.

### Por qué el criterio existe

`~/.engram/engram.db` guarda **~1,798 prompts del usuario en claro** y está en **`-rw-r--r--` (644),
world-readable**. Verificado con `stat -f "%Sp %z %N" ~/.engram/engram.db` (20.5 MB) y un
`COUNT(*)` sobre `user_prompts`. El `engram.db-wal` que lo acompaña son otros 4.3 MB con los mismos
permisos.

El `~` de esa cifra no es pereza: el `COUNT(*)` devolvió **1,797** y `engram stats`, un minuto
después en la misma corrida, **1,798**. El corpus crece mientras lo mides — ésa es la razón por la
que cada número de este documento lleva su hora al lado.

Es **la misma clase de exposición que la decisión abierta B6** señala para `~/.navori/audits` —
`.claude/progress/audit_deep_navori-audit.md:18`, rotulada en `progress/current.md:153-154` como
*"B6 (los prompts viajan en claro en el log)"*— pero **un nivel más arriba y con más volumen**: B6
habla de un log opt-in por sesión; esto es el store completo, siempre encendido.

**B6 sigue sin responder** (*"¿nota de privacidad en el reporte, permisos 600, o nada?"*,
`.claude/progress/audit_deep_navori-audit.md:126`). Este dato se le suma: cualquiera que sea la
respuesta para `~/.navori/audits`, hay que decidir si aplica igual a `~/.engram/engram.db` y al
`.json` que produce el paso 0.

### El precedente que ya respeta el criterio

`scripts/py/mine-topic-keys.py` —entregado en la **PR
[#784](https://github.com/UlisesCm/navori-harness/pull/784)**, mergeada el 2026-09-14— es el
instrumento que ya lee esta misma DB bajo estas mismas reglas, y sirve de plantilla:

- Abre con URI **`mode=ro`**, no con una promesa en un comentario: *"que este script no emita un
  INSERT es una propiedad del código, no del canal. La URI lo vuelve una propiedad del canal"*.
- Declara **una sola tabla y cinco columnas** en constantes de las que se construye el `SELECT`:
  `observations` × (`topic_key`, `type`, `revision_count`, `project`, `created_at`). Ninguna es
  texto del usuario.
- Su test (`packages/cli/src/lib/__tests__/mine-topic-keys.test.ts`) lo prueba en vez de afirmarlo:
  *"no lee el cuerpo de la observación ni la tabla de prompts"* asserta que el fuente **no contiene**
  `user_prompts` ni `content`, y *"abre la DB read-only de verdad: un INSERT rebota"* lo verifica
  contra una DB real.

Cualquier consulta nueva de diagnóstico se escribe con esa barra.

---

## Qué NO hacer, y por qué

Las dos ideas de abajo se re-derivan solas cada vez que alguien mira este problema de frente. Quedan
escritas con su refutación para que la próxima vez cueste un párrafo y no una auditoría.

### No: un script de curación versionado en navori

La forma tentadora es `scripts/curate-engram.py`, read-only por default, `--apply` como opt-in.
Pierde por cuatro razones, cada una suficiente:

1. **Reimplementa tooling ajeno.** `engram v1.20.0` ya trae `delete [--hard]`, `delete project`,
   `projects consolidate [--all] [--dry-run]`, `conflicts scan [--dry-run] [--apply] [--semantic]`,
   `doctor --json`, `stats`, `export` e `import`. Una copia en este repo se desincroniza en la
   siguiente versión del binario — y ya hay señal: `specs/0005` nombraba un `engram prune` que
   **no existe** en la superficie de v1.20.0.
2. **Cruzaría una frontera que hoy está limpia.** Navori tiene **0 accesos** a `~/.engram/engram.db`
   desde `packages/cli/src/`, `packages/core/` y `scripts/`; el acoplamiento con engram termina en
   `packages/plugins/engram/plugin.json`, que instala el binario, registra el MCP server y renderiza
   doctrina. **El store es del plugin, no de navori.** Sería el primer código de navori que abre el
   store de otro producto.
3. **No puede hacer la parte que importa.** Los dos pares duplicados del paso 3 tienen `topic_key`
   distinto y `normalized_hash` distinto — medido: 0 y 0. El duplicado semántico es **invisible a
   cualquier regla determinista**.
4. **Ya estaba resuelto.** `specs/0005-search-efficiency-layer/design.md:129-130`: *"Es juicio → agente, no
   hook mecánico"*.

Lo único que un script podría aportar —la lista de candidatos: sin título, tipo raro, `review_after`
vencido— **ya lo cubren tres superficies existentes**: `engram doctor --json`, `engram conflicts
scan --dry-run --semantic` y `mem_review(action: list)`. El scan semántico sí produjo candidatos en
la medición, pero tardó varios minutos; es una herramienta de curación deliberada, no un chequeo
barato para cada cierre.

### No: un skill `/curate-memory`

`specs/0005:171` lo dejó como opcional. Hoy pierde por dos razones:

1. **La doctrina ya está entregada.** `packages/plugins/engram/managed/engram-protocol.md:11` dice
   exactamente qué es curar y cuándo: *"Curation at close: in the SAME turn as the summary…
   Consolidate duplicates under their `topic_key`, promote what's durable, and delete only volatile
   observations…"*. Ese bloque es always-on: viaja en `CLAUDE.md` a todo agente y subagente.
2. **La moratoria de doctrina muerde justo aquí.**
   `specs/0025-disparadores-de-skill/design.md:234-239`: *"el mecanismo no agrega prosa nueva a
   `CLAUDE.md`, pero **re-entrega prosa que ya está ahí**. Un mecanismo cuyo contenido es una copia
   de un bloque always-on paga el cuerpo dos veces"*. Un skill de curación sería exactamente eso.

**Si la curación no ocurre, no es por falta de texto: es por falta de una corrida.** Ése es el
argumento entero, y es la razón por la que el entregable de #761 es este runbook y no un skill.

---

## La decisión 2, cerrada con evidencia

`4dd7a78` (#768, 13 sep 2026) — *"feat(agents): researcher y explorer leen memoria, y solo la leen"*,
9 archivos, +105/−11. Le dio a los dos agentes **`mem_search` + `mem_get_observation` y ningún
writer**. Verificado en el árbol al 2026-09-13:

| qué | dónde |
|---|---|
| Los 4 assets, `tools:` con las dos lecturas y cero writers | `.claude/agents/researcher.md:4` · `.claude/agents/explorer.md:4` · `packages/core/core-assets/agents/researcher.md:4` · `packages/core/core-assets/agents/explorer.md:4` |
| La cláusula de toolset de solo lectura en el bloque always-on | `packages/plugins/engram/managed/engram-protocol.md:3` — *"If your `tools:` lists a reader (`mem_search`, `mem_get_observation`) and no writer, the pre-flight below is the whole block"* |
| Anti-regresión | `packages/cli/src/lib/__tests__/mcp-capability-wiring.test.ts:298` — `describe("researcher and explorer read memory, and only read it (#761)")`, con `WRITE_TOOLS` en `:302` y el mensaje de falla *"reverses a deliberate decision — take it to the issue, not to this line"* en `:341` |

Los dos assets de `.claude/` llevan además `mcp__codegraph__codegraph_explore` (tool exacta,
no family wildcard, desde #838), que no es parte de esta decisión.

**No re-litigar.** Lo único pendiente del lado de la decisión 2 es housekeeping del issue: editar el
cuerpo de #761 o cerrar esa mitad citando `4dd7a78`. Mientras siga como está, el próximo lector
re-audita una decisión ya tomada — que es exactamente lo que pasó para producir este documento.

---

## Cómo re-medir

Todo lo de arriba sale de comandos read-only. Para refrescar las cifras antes de decidir:

```
# 1. Estado general — read-only, sin texto
engram stats
engram projects list
engram doctor --json --project navori-harness
engram doctor --project navori-harness --check sync_mutation_required_fields
engram conflicts stats --project navori-harness

# 2. Conteos del corpus (sqlite3 -readonly, solo COUNT/GROUP BY)
sqlite3 -readonly ~/.engram/engram.db \
  "SELECT COUNT(*) FROM observations WHERE project='navori-harness' AND deleted_at IS NULL;"
sqlite3 -readonly ~/.engram/engram.db \
  "SELECT type, COUNT(*) FROM observations WHERE project='navori-harness' AND deleted_at IS NULL
   GROUP BY type ORDER BY COUNT(*) DESC;"
sqlite3 -readonly ~/.engram/engram.db \
  "SELECT COUNT(*) FROM observations WHERE project='navori-harness' AND deleted_at IS NULL
   AND (title IS NULL OR title='');"
sqlite3 -readonly ~/.engram/engram.db \
  "SELECT COUNT(*) FROM observations WHERE deleted_at IS NULL AND embedding IS NOT NULL;"

# 3. Los grupos de consolidación — dry-run, NUNCA sin --dry-run
engram projects consolidate --all --dry-run

# 4. Permisos del store
stat -f "%Sp %z %N" ~/.engram/engram.db ~/.engram/engram.db-wal
```

Todos verificados el 2026-09-13 21:04 CST con `engram v1.20.0` y `sqlite3 3.50.6`. **Ninguno muta
nada**, incluido el `--dry-run` del punto 3 — pero ese comando sin `--dry-run` sí, así que no se
teclea a medias.

## Referencias

- `.claude/progress/audit_ticket_761.md` — la auditoría que produjo este runbook, con la evidencia
  `file:line` completa.
- `specs/0005-search-efficiency-layer/design.md` §5.2 (`:116-135`), §5.3 (`:137-148`), §9 (`:199-206`).
- `specs/0025-disparadores-de-skill/design.md:234-239` — la moratoria de doctrina.
- `packages/plugins/engram/managed/engram-protocol.md` — el protocolo que se renderiza a `CLAUDE.md`.
- [#761](https://github.com/UlisesCm/navori-harness/issues/761) · [#728](https://github.com/UlisesCm/navori-harness/issues/728) · [#768](https://github.com/UlisesCm/navori-harness/pull/768) · [#784](https://github.com/UlisesCm/navori-harness/pull/784)
