# Matcher `Skill` en `PostToolUse` — Design

## Approach

Un hook nuevo, mínimo, cuyo único trabajo es dejar constancia de que la herramienta `Skill` se
invocó: `core-assets/hooks/skill-watch.sh`, registrado en `PostToolUse` con `matcher: "Skill"`. No
inyecta contexto, no bloquea, no decide nada. Escribe una línea por invocación con el recorder que
ya existe (`_partials/audit-log.sh`) y se calla.

La parte que no es el hook —y donde se gana o se pierde esta spec— es la **lectura**. Tener la
misma señal desde dos fuentes solo sirve si el reporte hace algo cuando discrepan; si se limitara a
elegir una etiqueta ganadora, la segunda fuente sería una etiqueta más y el desacuerdo quedaría
invisible, que es peor que no tenerla. Por eso la conciliación (R8-R11), la declaración de
cobertura parcial (R12, R13) y las dos guardas que impiden que el detector grite en el caso sano o
señale al inocente (R14, R15) son parte de esta spec y no de una siguiente. Y con ellas R16, que
es donde la alarma de contrato de verdad se tensa — el resto de los detectores vigila vías que no
son la que sostiene la medición.

**Descartado: `PreToolUse`.** Respondería la misma pregunta antes, con dos costos que
`PostToolUse` no tiene: se mete en el camino crítico de la carga de la skill, y un hook con
capacidad de bloquear en `PreToolUse` es superficie que este cambio no necesita. Hay además una
diferencia de significado a favor de `PostToolUse`: si la llamada no se completa (error, permiso
denegado), la skill no se usó, y no registrarla es lo correcto.

**Descartado: ampliar el matcher del `routing-watch` a `Edit|Write|…|Agent|Task|Skill`.** Costaría
cero archivos nuevos y sería el error de diseño clásico de este repo: ese hook responde "¿cuántos
archivos escribió el hilo principal sin delegar?", y agregarle una tool que no escribe archivos lo
haría cobrar spawns por una pregunta que no es la suya. Un hook, una pregunta.

**Descartado: derivar la invocación del transcript con más cuidado.** Es lo que ya se hace
(`skill-tool`). El problema no es la precisión del parseo: es que el transcript entero es un
formato que la doc del host declara interno y libre de cambiar. Más parseo no compra contrato.

## Veredicto: se sostiene, y por qué no es el caso de A3

La pregunta honesta es si esto no repite el canal OTel de skills: código completo, testeado, y cero
datos en toda su vida (#736, A3). No lo repite, y la diferencia es de **qué hay que hacer para que
produzca**:

| | OTel `skill.name` | Matcher `Skill` |
|---|---|---|
| Requiere proceso levantado | sí (`--collect`) | no |
| Requiere entorno exportado antes de arrancar la sesión | sí | no |
| Requiere opt-in por sesión | sí | **sí** (sesión marcada; sin eso el recorder no escribe) |
| Se distribuye con el harness | sí | sí |
| Datos producidos hasta hoy | 0 | — (no existe) |

La fila del opt-in está para que la tabla no se lea como si el hook no necesitara nada: lo necesita,
y es el mismo de siempre. La diferencia real con OTel son las otras dos filas —los otros hooks del
harness producen datos todos los días bajo exactamente ese opt-in, porque no hay que levantar nada
más—, y el hook viaja en el `settings.json` que todo repo onboardeado ya tiene.

Los dos beneficios, ordenados por cuál sobreviviría a que le quiten el otro:

1. **Alarma de contrato sobre `attributionSkill`, que es R16 y no R9.** #731 y #732 —entregadas y
   en uso— leen un campo sin documentar de un formato que el host puede cambiar en cualquier
   release. Lo que hoy pasa si desaparece **no** es silencio total: `signals.ts` adjunta una
   salvedad cuando la atribución suma 0, y su propio comentario nombra el escenario. Pero esa
   salvedad es `info` y no puede ser otra cosa, porque "el campo desapareció" y "nadie trabajó bajo
   una skill" imprimen igual y ninguna fuente las separa. El hook las separa: **invocación
   confirmada por contrato público + cero registros atribuidos es una contradicción**, y eso ya es
   una afirmación, no una salvedad. Ver § "Dónde se tensa el cable".
2. **Habilita el embudo de A6.** `skill-trigger-watch` (Fase 3, fuera de alcance aquí) quiere medir
   "de los prompts donde la tabla disparó, ¿qué fracción terminó en invocación?". Su denominador se
   escribe en el log de hooks; sin este evento, el numerador vive en otro archivo y con otro reloj.
   Con él, el par se cierra dentro del mismo archivo.

**Eran tres, y el tercero no lo entrega esta spec.** La versión anterior de este diseño argumentaba
que en `orphanSessions` (#675) —logs marcados cuyo transcript ya no resuelve— el log de hooks sería
la única señal de skills que queda. Es cierto que ahí las dos fuentes actuales valen cero, y falso
que esta spec lo cobre: `commands/audit.ts:432-434` descarta la sesión sin transcript **antes** de
parsear y nunca abre su `logFile`, y `orphanSessions` es una lista de ids, no una ficha donde
publicar nada. Leer esas sesiones es una capacidad del pipeline —y beneficiaría a **todos** los
eventos de hook, no a las skills—, así que su lugar es una spec propia y aquí queda en NOT in
scope. El beneficio se retira del veredicto en vez de quedarse como promesa.

**Lo que está en contra, dicho sin adorno.** La señal es rala: 14 invocaciones en 56 sesiones de
este repo (~0.25 por sesión). Esto es un **cable trampa, no un monitor**: los cuatro detectores
—R9, R10, R15 y R16— necesitan una sesión que invoque una skill para decir algo, así que una
regresión del host puede tardar semanas en hacerlos sonar. Y el hueco de `/skill-name` no se cierra
nunca desde aquí — es del host.

**Recomendación: hacerlo.** Es un sí más chico que el de la primera versión —el beneficio de las
sesiones huérfanas se retiró— y más firme que el de la segunda, porque ya no se apoya en un
requisito que no cubre el escenario que invoca. Con R16, la alarma vigila la vía que de verdad
carga la medición; sin R16 el veredicto no se sostenía y había que decirlo, que es lo que la
revisión encontró. El costo es ~0 (ver § Costo) y la superficie es un hook que no bloquea nada.

La condición: si por presupuesto hubiera que recortar, lo que NO puede recortarse es
**R10/R12/R14/R15/R16** — un evento cuyo conteo se imprime como si fuera el total, o que reporta
desacuerdos falsos en el caso sano, o que no vigila la fuente por la que se construyó, es peor que
no tener el evento. R9 es el único de los detectores que sí es prescindible: cubre la vía menos
consecuente y su valor es que el par de cubetas quede completo. En ese escenario de recorte la
recomendación se invierte y es **no hacerlo**. La spec entera se justifica por la lectura, no por
la línea de log.

## Qué se registra, y qué no

Una sola cosa del payload: `tool_input.skill`. La regla del repo —el audit persiste claves y
conteos, nunca contenido— tiene aquí dos infracciones a la mano, y las dos se prohíben explícito:

- **`tool_input.args`**: texto libre que escribe el modelo. Medido en este repo, 7 de las 12
  invocaciones del hilo principal lo traen, y uno de esos 7 lleva la descripción completa de un
  ticket. Es exactamente el contenido que el store no debe acumular. La prohibición alcanza a
  cualquier forma derivada —hash, largo, recorte— y está en el texto de R2, no aquí: una regla de
  contenido que vive solo en el diseño es una regla que el test no persigue.
- **La respuesta de la herramienta**: es el cuerpo de la skill, cientos o miles de tokens de un
  archivo que ya está en el repo. Guardarlo sería duplicar el harness dentro del log de cada
  sesión.

El identificador se acepta contra la clase `[A-Za-z0-9._:-]` con tope de 64 caracteres (el `:`
admite un slug con espacio de nombres de plugin). Lo que no cumple **no invalida el evento**: se
registra la invocación sin `reason` (R3). Esa asimetría es deliberada — el nombre es un dato que
puede venir raro, la invocación es un hecho que ocurrió, y un conteo que depende de la forma del
nombre es un conteo que miente por una razón que nada tiene que ver con lo que mide.

## Cómo se corroboran, y qué pasa cuando discrepan

**Ninguna fuente gana.** No es una jerarquía porque no responden la misma pregunta:

| Fuente | Qué afirma | Contrato |
|---|---|---|
| `skill-watch` (hook) | esta sesión **invocó** la skill, en este instante, desde este `agentId` | público, documentado |
| `skill-tool` (transcript) | lo mismo, leído del transcript | interno, libre de cambiar |
| `attribution` (transcript) | se **trabajó bajo** la skill durante N registros, heredable por subagentes, y con costo en tokens | interno, sin documentar |
| `host` (OTel) | el host la declaró en `api_request` | público, pero exige receptor corriendo |

`SkillSource` gana la variante `skill-hook`, colocada **arriba de `skill-tool` y abajo de `host`**:
es el mismo evento que `skill-tool`, leído desde el contrato estable. Pero esa etiqueta es solo
para el lector humano que mira una skill suelta; **no es donde vive la discrepancia**, porque una
etiqueta ganadora es justo el mecanismo que la borra.

### El alcance de la comparación, que es donde esto se rompe si no se fija

Las dos fuentes **no tienen la misma granularidad**, y compararlas sin decirlo produce falsos
hallazgos el primer día. El log de hooks es **uno por sesión**, con subagentes incluidos y cada
evento llevando su `agentId`. El transcript no: los subagentes son archivos aparte y
`collectSkills` corre por separado sobre cada uno, así que el modelo tiene `orchestrator.skills` y
`agents[].skills` y **ninguna lista de sesión**. Medido en el corpus de esta spec: 2 de las 14
invocaciones existen **solo** del lado subagente (`solution-design`). Comparar el log de la sesión
contra `orchestrator.skills` las reportaría como "deriva del formato del transcript" — el detector
estrella de la spec gritando por una diferencia de alcance.

R8 lo cierra: **sesión contra sesión**. Del lado hook, todos los eventos `skill-watch` del log sin
mirar `agentId`; del lado transcript, la unión sobre orquestador y subagentes. Eso obliga a
construir esa lista agregada, que hoy no existe y es trabajo de esta spec (T3).

**Descartado: conciliar por `agentId`.** Y **no** por falta de confianza en el campo: en las fases
de herramienta —`skill-watch` es una de ellas, `PostToolUse`— el recorder documenta que `agent_id`
es estable, 485 eventos de una sesión medida con 11 ids distintos que resolvieron contra
transcripts reales. Lo inestable es `SubagentStop`, que es otra fase y no la de este hook.

El motivo es la pregunta, no el dato: la conciliación responde "¿las dos fuentes vieron las mismas
skills?", que es de conjunto. Particionarla la convierte en un join por agente, y un join necesita
resolver a qué ficha pertenece cada evento — donde el campo no basta, el fallback es la ventana
temporal, y con agentes en paralelo esas ventanas se traslapan. Se cambiaría una comparación exacta
por una aproximada para responder una pregunta más fina que nadie hizo.

### El horizonte del recorder, definido sin heredar la ambigüedad del helper

R10 descuenta los usos anteriores a que el recorder existiera, y el helper homónimo que ya está en
el código **no sirve para eso**: `recorderWindow()` (`model.ts:533-549`) devuelve `null` en dos
situaciones opuestas —sin eventos de hook (fuente ausente) y recorder que ya corría al empezar
(cobertura total, el caso sano y mayoritario)—. Es correcto para lo que hace, que es decidir si
vale la pena imprimir un hallazgo de cobertura parcial; usarlo como ventana apagaría R10 justo en
las sesiones sanas, que son casi todas.

Así que la ventana se define desde el dato crudo, no desde ese helper: **horizonte =
`session.hookLogFrom`** (instante del primer evento de hook del log), y ventana = de ahí al final
de la sesión. Existe siempre que haya al menos un evento, y cuando el recorder ya corría antes del
inicio la ventana es la sesión completa — que es lo que debe pasar. Cuando no hay ningún evento no
hay horizonte, y ese caso no es "ventana vacía" sino **fuente ausente**, que es R14 y se resuelve
callando, no descartando.

Esto obliga a algo que hoy no se guarda: el **instante** de cada uso de `Skill` del transcript.
`collectSkills` colecciona slugs sin timestamp, y comparar contra el horizonte lo necesita.

### Las cubetas, las señales y las dos causas que no se pueden confundir

La discrepancia vive en un objeto propio, por sesión, con las tres cubetas de R8 —`corroborated`,
`hookOnly`, `transcriptOnly`— y dos señales que salen de las dos cubetas asimétricas:

- **`hookOnly`** → el hook vio una invocación que el transcript no muestra como `tool_use`. Lo más
  probable que significa es que el formato del transcript cambió, que es la falla que esta spec
  existe para detectar. Severidad `warn`, y el texto dice qué revisar (`collectSkills`), no
  "algo falló".
- **`transcriptOnly`** con al menos un uso en o después del horizonte → el hook debió haber corrido
  y no dejó línea: no se renderizó, no es ejecutable, o el log de la sesión no estaba marcado
  todavía. Severidad `warn`.
- **`transcriptOnly`** con todos sus usos anteriores al horizonte → **no es discrepancia** (R10).
  Es el mismo descuento que `recorderCoverage` aplica para un harness renderizado a media sesión, y
  omitirlo convertiría cada sesión pre-0022 en una alarma.

**Dos guardas, y las dos son requisito y no prosa** — esto es lo que decide si el detector se
puede leer:

- **Fuente ausente (R14)**: si el log de la sesión no registró **ningún** evento de hook, de
  ninguna clase, ninguna señal de discrepancia emite —tampoco la de R16, que necesita un evento
  registrado para tener contradicción que declarar—. Es el caso de una máquina sin `jq`, donde el
  recorder entero calla: sin la guarda, toda skill del transcript sería `transcriptOnly` y el
  reporte gritaría por una causa ambiental, una línea por skill.
- **Payload derivado (R15)**: si hay eventos `skill-watch` y **ninguno** trae identificador, la
  causa es el contrato del payload y no el despliegue del hook. Sin esto, el día que el host
  renombre `tool_input.skill` pasa lo peor que le puede pasar a una alarma: suena, y señala al
  inocente — todos los slugs caen en `transcriptOnly` y el reporte culpa a la cobertura del
  recorder, mientras `hookOnly` queda en cero. La regla invierte el diagnóstico usando el
  discriminador que R3 ya dejó disponible: eventos sí, nombres no.

  **Es señal propia, no la de R9.** R9 dice "cambió el formato del transcript"; ésta dice "cambió el
  payload del hook" — causas distintas, `kind` distinto. Además R9 es el único detector que el
  veredicto declara recortable, así que si R15 invocara su maquinaria, recortar R9 se llevaría
  también la alarma que sí es irrecortable.

El conteo de esos eventos sin nombre se publica junto a las cubetas (R15) por una razón aritmética
además de diagnóstica: sin él, el total de invocaciones del hook no cuadra con la suma de las
cubetas y el lector no tiene cómo saber por qué.

## Dónde se tensa el cable: R16, no R9

Esta sección existe porque la segunda versión del diseño se equivocó aquí, y el error es
instructivo: el veredicto invocaba "si el host quita `attributionSkill`, la alarma suena", y el
requisito que iba a sonar era R9, que **no mira ese campo**.

Repasando lo que vigila cada detector:

| Si el host … | Lo ve | Por qué |
|---|---|---|
| cambia el formato de los `tool_use` del transcript | R9 (`hookOnly`) | el hook tiene el slug, el transcript no |
| renombra o mueve `tool_input.skill` en el payload | R15 | hay eventos y ninguno trae nombre |
| deja de escribir `attributionSkill` | **R16** | hay invocación de una skill del catálogo y cero registros sellados |
| deja de renderizar o ejecutar el hook | R10 | el transcript tiene el uso, el log no |

R9 se tensa solo en la primera fila, y esa es **la vía menos consecuente de las tres**: el propio
`collectSkills` la llama "the documented path but in practice barely used" —0 llamadas a `Skill` y
34 `SKILL.md` abiertos en la sesión de referencia—. Justificar el cambio con la vía que sostiene la
medición (`attributionSkill`, 337 registros en el corpus) y entregar un detector que vigila la otra
era exactamente el error que R12 existe para no cometer en los números.

**Lo que hoy pasa si el campo desaparece, dicho con precisión.** No es silencio: `signals.ts`
adjunta una salvedad cuando `skillAttributionRecords` suma 0 en toda la sesión, y su comentario
nombra el escenario literal. Pero tiene techo por construcción — es `info`, y no puede ser más,
porque las dos causas imprimen igual: "el campo desapareció" y "nadie trabajó bajo una skill" son
indistinguibles desde el transcript. La salvedad es honesta sobre la ambigüedad; no puede
resolverla.

**Lo que el hook agrega es la contradicción.** Una invocación registrada por un contrato público
implica que **hubo** una skill activa; cero registros sellados dice que el host no marcó ninguno.
Las dos cosas no pueden ser ciertas a la vez, y esa imposibilidad es una afirmación — la salvedad
`info` se vuelve señal. Es barato: `skillAttributionRecords` ya está parseado en `SessionAudit` y
en cada `AgentRun`, justamente para distinguir "el host no marcó nada" de "no se trabajó bajo
skill". R16 usa un campo que existe y un evento que esta spec ya escribe.

**Los falsos positivos, en plural.** La primera versión de R16 decía "el falso positivo estructural
conocido" en singular y era falso: hay cuatro causas benignas por las que la atribución puede sumar
0 habiendo invocación, y solo dos son discriminables.

1. **Sesión que muere justo después de invocar.** El sello vive en los `assistant` posteriores, así
   que no alcanza a producirse ninguno. La mata la cláusula de registros posteriores.
2. **Invocación de una skill que no existe** —slug mal escrito, plugin no instalado, `SKILL.md`
   ilegible—. La herramienta retorna con error y `PostToolUse` **dispara igual**: el repo ya lo
   documenta para el caso gemelo en `routing-watch.sh`, donde la marca solo aterriza cuando la tool
   RETORNA, y retornar con error es retornar. Y el hook registra la invocación **con** identificador
   precisamente porque R2 le prohíbe mirar `tool_response`, que es donde vive el error. Sin
   discriminador, R16 gritaría "el host dejó de sellar" cuando lo que pasó es que el modelo nombró
   una skill inexistente — la alarma correcta señalando al inocente, otra vez.
3. **El tramo atribuido vive en un transcript de subagente que el parser no recibió.** La suma es
   sobre orquestador + `agents[]`, y 2 de las 14 invocaciones del corpus son de sidechain. No hay
   con qué descartarlo.
4. **La invocación ocurrió dentro de un subagente que murió antes de responder**, mientras el
   orquestador siguió produciendo registros. Es (1) medida a otra granularidad: la cláusula de
   registros posteriores mira el transcript **de la sesión**, así que se cumple por los registros
   del orquestador aunque el subagente no alcanzara a producir uno solo. Estrecha —exige que el
   subagente muera sin responder **y** que ningún registro de la sesión entera lleve sello— y real.

   **Se declara, no se afina.** Medir "registros posteriores" por agente exigiría casar cada evento
   con su agente, o sea particionar por `agentId`: exactamente lo que R8 prohíbe con argumento
   propio dos secciones más arriba. Arreglar este borde rompería una decisión de alcance que cuesta
   más que el borde.

**Elegida: la cuarta condición, con el residuo declarado.** Para (2) el discriminador ya está en la
mano del detector — `detectSignals` recibe el `HarnessCatalog` y `deadCatalog` ya trabaja sobre
`cat.skills` —, así que exigir que el slug invocado esté en el catálogo cuesta una condición y mata
la causa benigna más probable de las cuatro. Para (3), para (4), y para el residuo de (2) —una
skill que sí está en el catálogo y aun así falla al cargar—, no hay discriminador que no cueste más
de lo que resuelve: se aceptan como falsos positivos **declarados en la evidencia de la señal**,
que es el mismo trato que esta spec le da al hueco de `/skill-name`. Declararlo es lo que permite que el lector los descarte antes de culpar al
host; callarlos sería fingir una precisión que la señal no tiene.

**El borde de los slugs con espacio de nombres.** `cat.skills` son los directorios de
`.claude/skills`, o sea slugs planos; R3 admite `:` en el identificador para la forma
`<ns>:<slug>`. La comparación prueba el identificador tal cual **y** el segmento posterior al `:`,
que es lo que hace que una skill de plugin no se lea como inexistente. Lo que queda fuera del
catálogo de verdad —una skill de usuario en `~/.claude/skills`, o una que traiga un plugin— deja a
R16 callado: es un falso negativo, y para una alarma de contrato ése es el lado correcto en el que
fallar. Con el catálogo vacío R16 tampoco emite, por la misma razón.

**Y eso es una limitación de cobertura que hay que decir sin rodeos:** el alcance de R16 es el
catálogo del repo, o sea `.claude/skills`. En un repo cuyas skills vengan mayoritariamente de
plugins o del catálogo personal del usuario, este cable trampa **cubre poco o nada** — no porque
falle, sino porque no tiene con qué discriminar ahí. Va junto a las otras limitaciones declaradas
(el hueco de `/skill-name`, la señal rala): el instrumento dice dónde es ciego en vez de dejar que
el lector lo asuma cubierto.

**R16 no reemplaza la salvedad de #725, y el antecedente se reparte.** Fuera del traslape —las
sesiones sin evento de hook, que son todas las anteriores a esta spec y todas las que no invocan
skills— la salvedad sigue igual: declara una ambigüedad que nadie puede resolver ahí. Dentro del
traslape se pisan, y de un modo que se lee mal: R16 afirmando "el host dejó de sellar" y al lado
"una skill aplicada sin invocarse no deja rastro aquí", una frase sobre la ambigüedad que la señal
de arriba acaba de resolver, en una sesión donde consta que sí hubo invocación. Por eso R16
suprime la salvedad **en las sesiones donde emite**, y solo ahí.

## El hueco de `/skill-name`, y cómo se presenta

Una skill invocada tecleando `/skill-name` no produce `tool_use` (`anthropics/claude-code#24858`).
El hook no la ve, y ninguna de las dos fuentes tiene un contador de lo que se pierde: en los 56
transcripts de este repo no hay un solo `<command-name>` que nombre una skill, así que **ni
siquiera existe un proxy con el que estimar la fracción**. Decir "perdemos X%" sería inventarlo.

Lo que sí se puede hacer, y es lo que R12 exige, es que el número nunca se pueda leer como total:

- el conteo del hook se publica como **cota inferior de invocaciones del modelo**, con esa palabra;
- la línea lleva la razón del límite (invocación tecleada no observable, con el número de issue del
  host), no un asterisco;
- no se calcula porcentaje alguno sobre ese conteo. Un porcentaje exige denominador, y el
  denominador es justo lo que no se puede observar;
- los slugs que `attributionSkill` sella y que **ninguna** de las dos vías de invocación nombra se
  publican como lo que son: **candidatos** a invocación tecleada *o* a tramo heredado por un
  subagente. Las dos causas producen el mismo rastro y no se pueden separar, así que la línea dice
  las dos. Es la única pista cuantitativa que existe sobre el tamaño del hueco, y se presenta como
  pista, no como medición.

Esto es la lección de #673, #674 y #730 aplicada antes del primer dato en vez de después del
tercer reporte corregido.

## Costo

El matcher es el control de costo: el hook solo existe para el host cuando la tool es `Skill`.
Medido en este repo, **14 invocaciones en 56 sesiones** (~0.25 por sesión, contando las 2 de
sidechain), contra miles de llamadas `Bash` que sí pagan el drift watcher en cada una.

Por invocación: un `bash` (~5-10 ms) más dos `jq` —el que lee `tool_input.skill` y el que arma la
línea— y **solo** cuando audit-mode se activó alguna vez en la máquina. Si no, el hook sale sin
lanzar un subproceso (R5), porque el slug se lee **después** de que `navori_audit_begin` estableció
que hay algo que registrar. Es la misma doctrina de orden que ya documenta `routing-watch`: nada se
paga antes del campo que puede terminar la corrida.

En perspectiva: la propia invocación que se está midiendo carga el cuerpo de una skill —cientos o
miles de tokens de contexto—, así que el hook es ruido de fondo frente al evento que observa. El
riesgo de este cambio nunca fue el costo; es la completitud de la señal, que es de lo que se ocupa
la sección anterior.

## Components

- `packages/core/core-assets/hooks/skill-watch.sh` — el hook: gate de audit-mode, lectura del slug,
  validación de forma, una línea por invocación. Cubre R1, R2, R3, R4, R5.
- `packages/cli/src/engines/claude/build-settings.ts` — lo registra en `PostToolUse` con
  `matcher: "Skill"`, junto a `managed-drift-watch` y `routing-watch`. Cubre R6.
- `packages/cli/src/engines/shared/harness-plan.ts` — lo agrega al plan para que se materialice en
  todo repo onboardeado. Cubre R6, R7.
- `packages/cli/src/lib/audit/parse.ts` — reconoce el evento `skill-watch` al leer el log de
  sesión; **construye la lista de invocaciones de sesión** uniendo los usos de `Skill` del
  orquestador y de cada subagente (hoy no existe: `collectSkills` corre por transcript), **retiene
  el instante de cada uso** para poder compararlo con el horizonte, y arma la conciliación. Cubre
  R8, R10, R11, R15.
- `packages/cli/src/lib/audit/model.ts` — la variante `skill-hook` de `SkillSource`, el objeto de
  conciliación con sus tres cubetas y el conteo de eventos sin nombre, con `schemaVersion` a 7.
  Cubre R8, R11, R13, R15.
- `packages/cli/src/lib/audit/signals.ts` — las señales de discrepancia, con la guarda de fuente
  ausente, la inversión de diagnóstico cuando ningún evento trae nombre, y la contradicción entre
  invocación de una skill del catálogo y atribución en cero. `skillAttributionRecords` ya está en
  `SessionAudit` y en cada `AgentRun`, y `detectSignals` ya recibe el `HarnessCatalog`, así que R16
  no agrega parseo ni argumentos. También reparte el antecedente con la salvedad de #725 que vive
  en `deadCatalog`. Cubre R9, R10, R14, R15, R16.
- `packages/cli/src/lib/audit/report.ts` — el rendereo: cota inferior con su razón, conciliación,
  conteo de eventos sin nombre, y "sin registro" cuando la fuente no estuvo. Cubre R12, R13, R15.

## Decisions

- **Hook nuevo y no una rama del `routing-watch`.** Ver Approach. Un hook, una pregunta; el matcher
  es lo que mantiene el costo donde debe estar.

- **`verdict: "invoke"`.** Verbo nuevo en el vocabulario del recorder, que hoy usa `block`, `skip`,
  `notify`, `noop`. No cabe en ninguno: no bloqueó, no se abstuvo y no avisó nada — constató. Y
  `verdict` es el campo por el que `routingNotice` filtra, así que el lector de esta señal filtra
  igual, sin caso especial.

- **El slug va en `reason`, no en un campo nuevo del recorder.** `reason` es texto libre ya
  existente en el contrato del log, y agregar un campo obligaría a tocar el partial —que #736
  verificó que no hace falta tocar— y a versionar el formato del log para todos los hooks. Con la
  clase de caracteres de R3, un slug es una clave, no prosa.

- **`skill-hook` arriba de `skill-tool`, abajo de `host`.** Mismo evento, contrato más estable;
  `host` sigue arriba porque es una declaración del host sobre su propia ejecución. La etiqueta no
  es donde se resuelve la discrepancia (ver la sección de corroboración), así que este orden es una
  comodidad de lectura, no una decisión sobre qué es verdad.

- **La conciliación es por slug dentro de una sesión, no por evento.** Parear evento contra
  evento exigiría un reloj común con precisión que el transcript no da, y produciría discrepancias
  falsas por cada invocación repetida de la misma skill. La pregunta que el reporte responde —"¿las
  dos fuentes vieron las mismas skills?"— se contesta a nivel de conjunto.

- **La comparación es de sesión contra sesión, no por `agentId` ni contra una ficha.** Ver §
  "El alcance de la comparación": 2 de las 14 invocaciones del corpus viven solo en sidechain, y
  `agentId` es un campo que el propio consumidor trata como no confiable por sí solo.

- **El horizonte es `hookLogFrom`, no `recorderWindow()`.** El helper devuelve `null` en el caso
  sano y usarlo apagaría R10 en casi todas las sesiones. Ver § "El horizonte del recorder".

- **`transcriptOnly` anterior al horizonte no es hallazgo.** Sin esto, toda sesión anterior a esta
  spec se lee como una alarma, y una alarma que suena siempre deja de leerse. Es el mismo criterio
  que `recorderCoverage` ya aplica, con la ventana definida como dice el párrafo anterior.

- **La alarma de contrato es R16, y R9 es el complemento.** Ver § "Dónde se tensa el cable": R9
  vigila los `tool_use` del transcript, que es la vía que el código mismo llama apenas usada; R16
  vigila `attributionSkill`, que es la que sostiene la medición. Escribir la spec al revés fue el
  defecto que encontró la segunda revisión.

- **R16 lleva dos condiciones de descarte, no una.** Registros `assistant` posteriores (mata la
  sesión abortada) y pertenencia al catálogo (mata la invocación de una skill inexistente, que
  `PostToolUse` registra igual porque la tool retornó — con error, pero retornó). Las dos causas
  benignas restantes se declaran en la evidencia. Una alarma con falsos positivos estructurales sin
  declarar es una alarma que se aprende a ignorar.

- **El catálogo se usa como discriminador, no como filtro de cobertura.** Si el catálogo está vacío
  o la skill vive fuera de él (`~/.claude/skills`), R16 calla. Para una alarma de contrato, fallar
  hacia el silencio es el lado correcto: un falso negativo cuesta una detección tardía, un falso
  positivo cuesta la credibilidad de todas las siguientes.

- **Ningún cambio en `attributionSkill`, `skill-md` ni el canal OTel.** Esta spec agrega una fuente
  y su lectura, y R16 lee un campo que ya se parsea. La decisión de dirección sobre OTel es A3 de
  #736 y se toma aparte.

## Contracts

La línea que el hook agrega al log de sesión, con la forma que el recorder ya produce:

```json
{"tsMs":1789497000456,"event":"hook","name":"skill-watch","phase":"PostToolUse","verdict":"invoke","ms":4,"source":"core","tool":"Skill","reason":"spec-bootstrap","agentId":"orchestrator"}
```

`reason` se omite —nunca se escribe vacío, misma regla que el resto del recorder— cuando el payload
no trae identificador o el identificador no pasa la validación de forma (R3).

El fragmento que `render` agrega al `settings.json` generado (archivo completo con
`$navori.managed: true`, no bloque con marcadores):

```json
{
  "matcher": "Skill",
  "hooks": [
    {
      "type": "command",
      "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/skill-watch.sh\"",
      "timeout": 10,
      "statusMessage": "navori: skill invoked"
    }
  ]
}
```

El reporte (`--json`) sube `schemaVersion` de 6 a 7 —lector que distingue las formas por ese número
solo, como con los bumps anteriores— y cada sesión gana la conciliación:

```json
{
  "skillReconciliation": {
    "corroborated": ["spec-bootstrap"],
    "hookOnly": [],
    "transcriptOnly": ["solution-design"],
    "hookInvocations": 3,
    "unnamedEvents": 1
  }
}
```

`hookInvocations` es el total de eventos `skill-watch` y `unnamedEvents` el subconjunto sin
identificador (R15): con los dos, el lector reconcilia el total contra la suma de las cubetas sin
adivinar. La ausencia de la fuente se representa **omitiendo el objeto entero**, no con ceros — es
lo que le permite al rendereo distinguir "sin registro" de "ninguna invocación" (R13) sin un
booleano paralelo que se pueda desincronizar.

## Failure modes

- **`jq` no está en la máquina.** El recorder entero calla, de cualquier hook. El log no registra
  ningún evento, la fuente se declara ausente (R13 para el rendereo, R14 para el silencio de los
  detectores) y ninguna skill del transcript se reporta como discrepancia. Sin esa guarda, una
  máquina sin `jq` produciría una alarma por skill.
- **El payload no trae `tool_input.skill`.** Se registra la invocación sin nombre (R3). Cuenta para
  la cota inferior, se publica en el conteo de eventos sin nombre (R15) y no entra en ninguna
  cubeta — no hay slug que parear.
- **El modelo invoca una skill que no existe.** La tool retorna con error, `PostToolUse` dispara
  igual y el hook registra la invocación con identificador —R2 le prohíbe mirar `tool_response`—.
  El slug no está en el catálogo, así que R16 no emite. En las cubetas aparece como `hookOnly` si
  el transcript tampoco lo muestra, lo cual es correcto: el evento existió.
- **El host deja de escribir `attributionSkill`.** Los `tool_use` siguen ahí, así que el slug sale
  corroborado y R9 calla — correctamente, porque su vía no cambió. Lo que dispara es R16: hubo
  invocación y cero registros sellados, con registros `assistant` posteriores al evento. Es el
  escenario que justifica la spec, y el único requisito que lo cubre.
- **El host renombra o mueve `tool_input.skill`.** Todos los eventos quedan sin nombre y el lado
  hook se vacía. R15 invierte el diagnóstico: se emite deriva de contrato y no hueco de cobertura,
  que es lo que el conteo de eventos sin nombre permite distinguir.
- **Una skill se invoca solo dentro de un subagente.** Corroborada igual: los dos lados de la
  comparación son de sesión entera (R8). Medido, es el caso de 2 de las 14 invocaciones del corpus,
  y sin R8 sería el primer falso positivo del detector.
- **El log de la sesión no está marcado.** El recorder no escribe (comportamiento existente de
  `audit-log.sh`), el hook sale en 0. Auditar es opt-in por sesión y esto no lo cambia.
- **El hook se rinde a media sesión** (FS de solo lectura, log borrado). Quedan las invocaciones
  hasta ese punto; las posteriores caen en `transcriptOnly` con usos posteriores al horizonte →
  señal de hueco de cobertura, que es exactamente lo que pasó.
- **La skill se invoca tecleando `/skill-name`.** El hook no la ve y el transcript tampoco la
  muestra como `tool_use`. No produce discrepancia (ninguna de las dos la tiene) y queda dentro del
  hueco que R12 obliga a declarar.
- **El transcript no resuelve** (`orphanSessions`). El pipeline descarta la sesión antes de parsear
  y **nunca abre su log**, así que esta spec no publica nada de ella — ni conciliación ni conteo.
  El evento sí quedó escrito en el log; leerlo es la capacidad que queda en NOT in scope. Decirlo
  aquí evita que alguien lea el reporte como si esas sesiones estuvieran cubiertas.
- **Un slug absurdamente largo o con caracteres raros.** Se descarta el nombre, no el evento (R3).
  `jq` ya escapa cualquier contenido, así que el riesgo no es romper el JSONL sino inflar el log con
  texto del modelo; el tope de 64 caracteres es lo que lo cierra.

## Testing strategy

- **El hook se prueba corriéndolo**, con payloads reales en `bash` y en `zsh` (`acrossShells`),
  como `routing-watch.test.ts`: este repo ya envió hooks que pasaban en bash y no hacían nada en
  zsh (#391).
- **R2 se prueba por lo que NO se escribió**: un payload con `tool_input.args` de texto largo y un
  `tool_response` con el cuerpo de la skill, afirmando que el log no contiene ni un fragmento de
  ninguno de los dos. Es el test que protege la regla de contenido del store.
- **R5 se prueba con un `jq` señuelo**: un `PATH` donde `jq` es un script que toca un archivo
  centinela; sin raíz de audits, el centinela no debe existir al terminar. Afirmar solo "exit 0" no
  probaría la ausencia de subproceso, que es lo que R5 dice.
- **R3 se prueba con tres payloads** —sin `skill`, con un nombre fuera de la clase, y con uno de
  200 caracteres— afirmando en los tres que hay evento y no hay `reason`.
- **R6 se prueba sobre el `settings.json` construido**, no sobre el archivo del repo: que el bucket
  existe, que el matcher es exactamente `Skill`, y que ninguna otra entrada de `PostToolUse` lo
  nombra.
- **La conciliación se prueba con logs sintéticos** que fabrican las tres cubetas por separado, más
  el caso mixto. Cada cubeta tiene su aserción; una sola prueba del caso feliz dejaría pasar
  exactamente la discrepancia que la spec existe para ver.
- **El alcance (R8) se prueba con una invocación que solo existe en sidechain**: transcript de
  subagente con un uso de `Skill` que el orquestador no tiene, y evento de hook correspondiente.
  Tiene que salir `corroborated`. Es el caso que el corpus ya contiene dos veces, y el test que
  impide que el detector nazca con falsos positivos.
- **R10 se prueba dos veces con el mismo dato**: un uso `Skill` del transcript sin evento de hook,
  una vez posterior al horizonte (es hallazgo) y otra anterior (no lo es). El par es lo que fija el
  descuento. Un tercer caso fija el extremo que el helper del código no cubre: **recorder que ya
  corría antes de que la sesión empezara** —donde `recorderWindow()` es `null`— tiene que seguir
  produciendo hallazgo, porque ahí la ventana es la sesión completa.
- **R16 se prueba con cinco sesiones**, y cuatro son las que impiden que nazca ruidosa: invocación
  de una skill del catálogo + registros `assistant` posteriores + atribución en cero (dispara); la
  misma con atribución no nula (no dispara); una que termina sin registros `assistant` después del
  evento (no dispara); una cuyo slug **no** está en el catálogo (no dispara — la invocación
  fallida); y una con catálogo vacío (no dispara). Un sexto caso fija el borde del espacio de
  nombres: `<ns>:<slug>` contra un catálogo que lista `<slug>` **sí** cuenta como del catálogo.
- **El reparto con la salvedad de #725 se prueba en el traslape**: una sesión donde R16 emite no
  imprime la salvedad de atribución en cero, y una sesión sin eventos de hook la sigue imprimiendo
  igual que hoy.
- **R14 se prueba con una sesión con transcript y sin un solo evento de hook**, afirmando cero
  señales de discrepancia. Sin esa aserción, la máquina sin `jq` es una alarma por skill.
- **R15 se prueba con dos sesiones**: una con eventos nombrados y uno sin nombre (el conteo aparece
  y las cubetas no cambian), y otra donde **ningún** evento trae nombre (sale deriva de contrato y
  no sale hueco de cobertura). La segunda es el escenario de la deriva real.
- **R12 se prueba sobre el texto renderizado**: la línea del conteo lleva la palabra que lo declara
  cota inferior y la causa, y no aparece porcentaje alguno calculado sobre él.
- **R13 se prueba con una sesión sin log de hooks**, afirmando "sin registro" y la ausencia de un
  cero. Es el modo en que corre el 100% de las sesiones existentes.

## Migration

Ninguna para el usuario. El hook entra por el plan del harness, así que `navori update` o
`navori render --apply` lo materializan y lo registran en el `settings.json` generado; los golden
snapshots de render cambian con el PR. `settings.local.json` no se toca.

Hacia atrás, todo es aditivo: un log sin eventos `skill-watch` produce el mismo reporte de hoy más
la declaración de ausencia de la fuente. Un log escrito por esta versión lo lee una anterior sin
romperse — `readJsonl` ya tolera y cuenta lo que no reconoce, y el evento usa el `event: "hook"` que
esa versión ya sabe leer (le sobraría un `name` desconocido, que es el caso normal de un hook que
todavía no conoce).

## NOT in scope

- **El embudo de `skillTriggers` (A6 de #736).** Esta spec entrega el evento con el que se contará
  el numerador; el disparador, la tabla y la señal del embudo son trabajo aparte y con su propio
  pre-registro. Mezclarlos haría que el instrumento y el mecanismo nazcan en el mismo PR sin línea
  base, que es el ciclo que #674/#679 dejaron por escrito que no se repite.
- **Leer el log de hooks de una sesión sin transcript (`orphanSessions`, #675).** Hoy
  `commands/audit.ts:432-434` la descarta antes de parsear y su `logFile` no se abre nunca; la
  lista es de ids, no de fichas. Publicar algo de esas sesiones exige una ficha mínima construida
  solo desde el log, con su propia forma en `--json` — y beneficiaría a **todos** los eventos de
  hook, no a las skills: el drift watcher, los avisos de ruteo y el resto están igual de invisibles
  ahí. Por eso es una spec del pipeline y no un apéndice de ésta, y por eso el beneficio salió del
  veredicto en vez de quedarse escrito como si esta entrega lo diera.

- **Cerrar el hueco de `/skill-name`.** Es un bug del host
  (`anthropics/claude-code#24858`). Lo único que esta spec puede hacer —y hace— es declararlo.
- **La decisión sobre el canal OTel de skills (A3).** Independiente: esta fuente no la fuerza en
  ninguna dirección.
- **Precio por skill desde el hook.** El costo en tokens lo da `attributionSkill`, que es la única
  fuente con `usage` por registro. El hook cuenta invocaciones y no pretende otra cosa.
- **Un `PreToolUse` sobre `Skill`.** Ni para bloquear ni para medir latencia de carga. Si algún día
  hace falta medir el costo de cargar una skill, es otra pregunta y otra spec.
- **Registrar `tool_input.args`**, en cualquier forma. La prohibición es de R2 e incluye hash,
  largo y recorte: un largo parece inofensivo y es el primer escalón de guardar contenido. Si algún
  día hay una pregunta que lo necesite, se justifica entonces.
