# Línea base de `topic_key` — reuso e higiene

> Congelada el **2026-09-13 19:42 CST**, commit **`16c9dc8`**, antes de que ningún
> cambio de conducta de #760 toque el repo. Instrumento:
> [`scripts/py/mine-topic-keys.py`](../../scripts/py/mine-topic-keys.py).

## Por qué existe este archivo

#760 pide que el flujo de guardado busque la clave antes de acuñar una nueva, y
arranca de una premisa: *"la métrica que lo distinguiría no existe: la tasa de
reuso de `topic_key`"*. **Sí existe** — el esquema de engram la soporta con
`revision_count`, y basta una query. Lo que no existía era una forma repetible de
correrla, que es la diferencia entre una línea base y una anécdota
(`specs/0025-disparadores-de-skill/requirements.md:153-155`).

Se congela **ahora**, antes de cualquier intervención, por la disciplina de
pre-registro del repo: *"El 57% se publicó mirando los datos primero; por eso
aguantó cinco sesiones y no dieciséis"* (`progress/current.md:102-103`). Un
número elegido después de ver el resultado no prueba nada.

Y se congela con una advertencia que el instrumento descubrió al correrse: **el
corpus está vivo**. Entre dos queries de la misma sesión pasó de 673 a 674 filas.
Toda cifra de aquí se cita con `filas` y `saves` al lado; un porcentaje solo no
permite distinguir un efecto de cuatro saves nuevos.

## Alcance de lo medido

| | |
|---|---|
| Fuente | `~/.engram/engram.db`, tabla `observations`, filas vivas (`deleted_at IS NULL`) |
| Proyecto principal | `navori-harness` — **674 filas · 737 saves** |
| Parque completo | **2,955 filas · 3,294 saves** en **29 proyectos** distintos con filas vivas (18 con ≥ 10 filas) |
| Columnas leídas | `topic_key, type, revision_count, project, created_at` — y ninguna más |
| Ventana | todo el corpus, desde 2026-06 |

**La debilidad conocida es el denominador vivo.** A diferencia de
`linea-base-delegacion-0.8.5.md`, cuya población (sesiones auditadas) solo crece
hacia adelante, aquí una curación de memoria puede *borrar* filas y mover la
cifra hacia atrás. Cualquier comparación futura tiene que citar los conteos
crudos, no solo el porcentaje.

## Los números

> **Por qué la auditoría dice 670 filas y aquí dice 674.** Se movió el corpus, no
> el instrumento, y la prueba está en los **numeradores**: son conteos puros y
> salen idénticos en las cuatro corridas —**146** claves sin slash, **114** con
> prefijo de proyecto, **13** fechadas—, los mismos tres números que
> `.claude/progress/audit_ticket_760.md` sacó con SQL a mano. Lo único que se
> mueve son los denominadores, y se mueven **hacia arriba con saves que ya traen
> clave `<area>/<slug>`**, que es por lo que cada cociente baja unas décimas sin
> que nadie haya empeorado: 670 filas en la auditoría → **674 al congelar esta
> línea base** → 675 en la revisión → 676 al reverificarla (2026-09-13 20:10 CST;
> el parque, en paralelo, 2,955 → 2,957 filas · 3,294 → 3,296 saves). Las cifras
> de abajo se quedan **congeladas en la corrida de las 19:42**: son el
> pre-registro, y reescribirlas cada vez que el corpus respira es justo lo que un
> pre-registro no puede hacer. Por eso van con `filas` y `saves` al lado.

### Reuso — qué fracción de los saves evolucionó algo que ya existía

`reuso = (saves − filas) / saves`, donde `saves = SUM(revision_count)`.

| población | filas | saves | evolucionados | reuso |
|---|---:|---:|---:|---:|
| todas | 674 | 737 | 63 | **8.5 %** |
| con `topic_key` | 237 | 293 | 56 | **19.1 %** |
| sin `topic_key` | 437 | 444 | 7 | 1.6 % |

**El denominador son SAVES, no filas, y eso es la mitad del trabajo.** Dividir
entre filas responde otra pregunta —"qué fracción de las filas se tocó más de una
vez", 47/674 = 7.0 %— y se parece lo bastante al número bueno como para pasar por
él. La intervención que #760 discute actúa **por save**.

Las filas sin clave **no** salen del denominador global: son el 64.8 % del corpus
y el defecto dominante que el ticket no nombra. Sacarlas convertiría la métrica en
higiene de claves mientras el problema mayor queda invisible.

### Higiene — qué forma tienen las 237 claves vivas

| forma | conteo | % |
|---|---:|---:|
| `<area>/<slug>` — la que documenta el upstream y emite `mem_suggest_topic_key` | 91 | 38.4 % |
| **sin slash** — otra convención | **146** | **61.6 %** |
| con prefijo de proyecto (la columna `project` ya lo lleva) | 114 | 48.1 % |
| **con `YYYY-MM` embebido** — irreusables por construcción | **13** | 5.5 % |
| con no-ASCII | 0 | 0.0 % |

Las etiquetas no son excluyentes: `navori/audit-reprocesos-2026-08` es
`<area>/<slug>` **y** fechada a la vez.

Las 13 fechadas son el hallazgo accionable: `navori-audit-hallazgos-2026-09` no
puede evolucionar en octubre aunque el agente busque perfecto. **Y las dos mitades
"duplicadas" que #728 P3 cita están entre esas 13**
(`navori-audit-tool-routing-2026-09`, `navori-skill-attribution-2026-09`).

El cero de no-ASCII es un tripwire, no un descuido: el slugificador del upstream
destroza los acentos (§ corrección 1), así que si alguien escribe a mano
`auditoría/ruteo`, esa clave queda fuera del alcance de `mem_suggest_topic_key`
para siempre. Hoy nadie lo hace. Un cero medido también es un resultado.

### Sin clave, por `type` — y por qué el desglose no es decoración

| `type` | sin clave |
|---|---:|
| `manual` | 167 |
| `session_summary` | **132** |
| `project` | 55 |
| `decision` | 53 |
| resto | 30 |

**`mem_session_summary` no acepta `topic_key` en su schema** (sus parámetros son
`content, project, project_choice_reason, recovery_token, session_id`). Esas 132
filas son **inclaveables por API**, no negligencia del agente. Un "% sin clave" a
secas fija un techo que nadie puede alcanzar, y entonces cualquier intervención
parece fracasar — el mismo defecto de denominador que `mine-search-routing.py`
tuvo que corregir con los pipes y las extracciones.

### El parque, con el mismo instrumento y la misma corrida

| | filas | saves | reuso | sin clave | off-convention |
|---|---:|---:|---:|---:|---:|
| `navori-harness` | 674 | 737 | 8.5 % | 64.8 % | 61.6 % |
| **todos los proyectos** | **2,955** | **3,294** | **10.3 %** | **58.8 %** | **65.8 %** |

`navori-harness` no es un caso raro: es el caso típico. Cualquier arreglo que se
diseñe mirando solo este repo aplica a 2,955 observaciones, no a 674.

## Las tres correcciones de diagnóstico

El problema que #760 mide es real. Su diagnóstico está desplazado, y estas tres
correcciones son lo que la auditoría (`.claude/progress/audit_ticket_760.md`)
estableció con evidencia. Quedan aquí para que no vuelvan por re-derivación.

### 1. `mem_suggest_topic_key` no consulta el corpus: es un slugificador puro

Es `slugify(type) + "/" + slugify(title)`, función pura de sus entradas, **cero
lecturas de la DB**. Cuatro llamadas en vivo (engram 1.20.0, `/opt/homebrew/bin/engram`):

| `title` | `type` | devuelve |
|---|---|---|
| `Skill attribution` | `audit` | `audit/skill-attribution` |
| `Skill attribution en navori` | `audit` | `audit/skill-attribution-en-navori` |
| `Auditoría de ruteo de herramientas` | `routing` | `routing/auditor-a-de-ruteo-de-herramientas` |
| `Atribución de skills: la señal del host que nadie consume` | `decision` | `decision/atribuci-n-de-skills-la-se-al-del-host-que-nadie-consume` |

Tres consecuencias:

- `audit/skill-attribution` **ya existe** en la DB (#2903), y **10 caracteres**
  más de título (`' en navori'`: 17 → 27) acuñan clave nueva sin aviso. Enrutar
  los saves por esta tool **no deduplica**: reproduce el modo de fallo que #760
  quiere cerrar.
- **El `type` entra en la clave.** Los pares duplicados son `discovery` +
  `manual`: aun con títulos idénticos habrían salido claves distintas.
- **Destroza el no-ASCII** (`Auditoría` → `auditor-a`). Este repo escribe títulos
  en español MX.

Implementación: `Gentleman-Programming/engram`, `internal/store.SuggestTopicKey`.

### 2. Los dos pares de #728 P3 se escribieron en la MISMA sesión

| # | `topic_key` | `type` | creada | sesión |
|---|---|---|---|---|
| 2901 | `routing/tool-routing-audit` | discovery | 2026-09-12 **12:34:08** | `59832678-…` |
| 2902 | `navori-audit-tool-routing-2026-09` | manual | 2026-09-12 **12:35:02** | `59832678-…` |
| 2903 | `audit/skill-attribution` | discovery | 2026-09-12 **13:02:08** | `59832678-…` |
| 2904 | `navori-skill-attribution-2026-09` | manual | 2026-09-12 **13:02:45** | `59832678-…` |

**Δ = 54 s y 37 s, misma sesión los cuatro.** No fue un fallo de lookup: la
primera observación tenía 37 segundos de vida cuando se escribió la segunda y el
escritor ya la tenía en contexto. El patrón es **dos escritores con dos
convenciones** —subagente y orquestador—, cada uno con su formato de clave, y
ninguno puede ver la del otro (corrección 3).

### 3. `mem_search` no devuelve `topic_key`

Los campos de `results[]` son `id, pinned, project, scope, state, sync_id, title,
type`. La clave no aparece ni ahí ni en la prosa del resultado. El único lector
que la expone es `mem_get_observation`, que imprime `Topic: audit/skill-attribution`.

**Reusar una clave cuesta hoy N+1 llamadas**: una búsqueda más una lectura
completa por cada candidato. Pedir "busca la clave antes de acuñar" por doctrina
es pedir un procedimiento que el API no soporta con la ergonomía que la doctrina
supone. **Éste es el fix de verdad, y es upstream** (Tarea B del plan de #760).

## Cómo reproducir

```bash
python3 scripts/py/mine-topic-keys.py navori-harness   # la línea base de arriba
python3 scripts/py/mine-topic-keys.py                  # el parque completo
python3 scripts/py/mine-topic-keys.py --top 30         # más claves irreusables
ENGRAM_DB=/ruta/a/otra.db python3 scripts/py/mine-topic-keys.py
```

**Qué lee, y qué no.** La DB está en 644 (world-readable) y guarda los prompts
del usuario en claro. El minero la abre **read-only de verdad** (URI `mode=ro`),
toca una sola tabla (`observations`) y de ella cinco columnas
(`topic_key, type, revision_count, project, created_at`). El cuerpo y el título
de la observación están fuera; la tabla de prompts está fuera entera. Eso no es
una convención de estilo: `packages/cli/src/lib/__tests__/mine-topic-keys.test.ts`
lo afirma de dos formas —leyendo el script como texto y verificando que un cuerpo
sembrado en una DB de prueba no aparece en la salida—, y las dos fallan si alguien
agrega una columna.

## Qué contaría como mejora, y qué no

Escrito antes de ver un solo dato posterior.

**La métrica primaria es `% sin topic_key` (64.8 %)**, no el reuso. Es el defecto
dominante, es el que bloquea todo lo demás —para una fila sin clave el upsert no
puede engancharse, busque quien busque— y tiene un techo conocido: con 132
`session_summary` inclaveables por API, el piso alcanzable hoy es **19.6 %**
(132/674), no 0 %.

**La métrica secundaria es el reuso entre claveadas (19.1 %)**, que es donde un
arreglo de lookup se vería.

**Qué NO cuenta como evidencia:**

- Que suba el reuso **global** sin que baje el % sin clave. Se mueve solo con la
  mezcla de tipos de save: una sesión con muchos `session_summary` lo baja y una
  con muchos upserts lo sube, sin que nadie haya cambiado de conducta.
- Un movimiento de menos de ~2 puntos con menos de ~100 saves nuevos. El corpus
  crece unos pocos saves por sesión; a ese ritmo el ruido domina.
- Que bajen las claves fechadas por curación manual del corpus. Eso es limpiar la
  medición, no la conducta — y si se hace, hay que anotar la fecha aquí para que
  el antes/después no lo lea como efecto.

**Tamaño mínimo antes de concluir:** 100 saves nuevos en `navori-harness` (≈ 15 %
del corpus actual) o 300 en el parque.

## Lo que falta para que la comparación valga

1. **Los arreglos upstream** (Tarea B de #760). Mientras `mem_search` no devuelva
   `topic_key`, ninguna doctrina puede pedir algo barato de obedecer, y mientras
   `mem_suggest_topic_key` no mire el corpus, enrutar los saves por ahí no
   deduplica. Son la causa mecánica; todo lo demás es paliativo.
2. **Los embeddings**. `embedding IS NOT NULL` ⇒ **0 filas** en todo el corpus, y
   el binario ya trae `engram conflicts scan --semantic`. El dedupe semántico
   está construido y sin combustible. `duplicate_count > 1` ⇒ 0 filas: el dedupe
   por hash exacto nunca atrapó nada porque los pares difieren en redacción.
3. **La decisión de curación** de los dos pares (#2901/#2902, #2903/#2904). Es
   mutación de datos ⇒ la toma el usuario, no un agente.
