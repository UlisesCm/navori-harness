> Fecha: 2026-09-16. Estado: propuesta no implementada.
> Snapshots analizados: `3f0fceb0` y `26f05dcd`.
> Este documento conserva el análisis presentado en la conversación. Las referencias al repositorio y sus líneas son históricas; `HEAD` puede haber avanzado desde la revisión.

# Recomendación: adoptar una versión modificada

**Conservaría siete roles, pero no los siete propuestos:**

```text
leader
explorer
analyst
architect
implementer
reviewer
operator
```

- **No crearía un `planner` obligatorio:** planning normal como skill breve.
- **Conservaría `explorer` barato:** fusionarlo hoy complica el tiering, especialmente en Codex.
- **Fusionaría `researcher`, `auditor` y `ticket-audit` en `analyst`**, con protocolos por modo.
- **Extraería la lógica determinista de reviewer/pilot antes de adelgazar sus prompts.**

La principal oportunidad no es pasar de ocho nombres a siete: es **eliminar handoffs innecesarios, contexto repetido y algoritmos descritos en prosa**.

## 1. Estado analizado y límites

Revisé fuentes canónicas, configuración, skills, hooks, adapters, pruebas de contratos y documentación oficial. Hubo dos investigaciones paralelas y un challenge independiente.

Durante la revisión, otra sesión movió `HEAD` de `3f0fceb0` a `26f05dcd`. Contrasté ambos:

| Configuración local | Inicio | Snapshot reciente |
|---|---|---|
| Engines habilitados | Claude + Codex | Claude |
| Leader | Sonnet/high | Opus/xhigh |
| Researcher | Haiku/high | Sonnet/medium |
| Reviewer | Sonnet/low | Sonnet/medium |

**Codex salió de la configuración local, no del producto:** su adapter sigue existiendo.

No implementé cambios. Las comparaciones de rendimiento siguientes son **expectativas arquitectónicas, no resultados de un benchmark**.

## 2. Qué está bien y qué está mal ubicado

### Lo que conservaría

1. **Separación implementer/reviewer.** Aporta independencia real.
2. **Diseño antes de descomposición**, cuando cambia contratos, ownership o migraciones.
3. **Challenge en contexto fresco.** Importa más la independencia de la instancia que su nombre.
4. **Tests focalizados durante implementación**, antes del full gate.
5. **Aprobación vinculada al contenido revisado**, con detección de cambios posteriores.
6. **Un pipeline de render compartido**, con adapters y configuración como fuente de verdad.

### Problemas concretos

**A. El reviewer y el pilot contienen demasiado software escrito como instrucciones.**

Medición de los assets canónicos:

| Prompt | Palabras |
|---|---:|
| Leader | 2,957 |
| Implementer | 1,661 |
| Reviewer | 2,464 |
| Commit-pr-pilot | 4,070 |

Incluyen frontmatter, comentarios y ejemplos; **no son tokens ni indican cuánto se carga en cada sesión**. Sin embargo, reviewer y pilot suman 6,534 palabras, con recetas para calcular archivos, hashes, cobertura y drift.

El reviewer genera receipts; el pilot repite el cálculo del conjunto de archivos y verifica sus hashes. Incluso existen pruebas que extraen shell del Markdown para ejecutarlo. Eso demuestra que parte del prompt ya funciona como código fuente, pero con una interfaz frágil.

Evidencia: `packages/core/core-assets/agents/reviewer.md:122`, `packages/core/core-assets/agents/commit-pr-pilot.md:50`, `packages/cli/src/lib/__tests__/commit-pr-pilot-drift-loop.test.ts:23`.

**B. Hay instrucciones contradictorias de routing.**

El leader prohíbe editar código, pero después permite cambios directos en docs, `CLAUDE.md`, `.claude/` y posiblemente una línea trivial. La orquestación canónica exige implementer → reviewer para cualquier cambio a source, incluido el harness.

Evidencia: `packages/core/core-assets/agents/leader.md:159-170`.

Esto cuesta más que un nombre adicional: obliga al modelo a resolver qué regla prevalece.

**C. El pipeline de tickets sobreactiva análisis.**

`ticket-intake` exige `ticket-audit` para todo ticket no trivial; después admite exploración y solution-design con otro investigador. El origen “viene de un ticket” termina influyendo demasiado en el costo.

Evidencia: `packages/core/core-assets/skills/ticket-intake.md:17-41`.

**D. La planificación tiene varios productores.**

- Leader: descomposición y paralelismo.
- Ticket-audit: descomposición sugerida.
- Auditor: plan priorizado.
- SDD: `tasks.md`.
- Implementer: microplan local.

No todo es duplicación: prioridades de una auditoría no son un calendario de ejecución. Pero falta una frontera clara entre **hallazgos, decisión y tareas autorizadas**. Añadir un planner sin corregirla agrega otro productor.

**E. Los hooks no equivalen todos a gates.**

| Mecanismo actual | Garantía real |
|---|---|
| `quality-gate-pre-commit` | Ejecuta el gate rápido al detectar commit; no verifica receipts |
| `routing-watch` | Aviso, no bloqueo |
| `subagent-stop-handoff` | Advierte sobre archivos existentes defectuosos; no detecta cualquier handoff ausente |
| `pr-pilot-confirm` | Distingue hilo principal de algún subagente; no autentica que sea el pilot |
| `managed-drift-watch` | Detecta alteraciones de bloques managed; no sustituye el receipt de revisión |

Evidencia: los respectivos archivos en `packages/core/core-assets/hooks/`, especialmente `quality-gate-pre-commit.sh:7-13`, `subagent-stop-handoff.sh:30-43` y `pr-pilot-confirm.sh:88-103`.

**No conviene diseñar el roster suponiendo garantías que esos mecanismos no ofrecen.**

## 3. Mapa de responsabilidades

| Actual | Conservar | Mover o eliminar | Dueño propuesto |
|---|---|---|---|
| **Leader** | Intento, routing, síntesis, estado, dependencias y escalación | Investigación profunda, diseño difícil, delivery y recetas mecánicas | Analyst, architect, operator, scripts |
| **Explorer** | Mapa barato, entrypoints, dependencias y orientación | Diagnóstico profundo y conclusiones arquitectónicas | Analyst / architect |
| **Researcher** | Pregunta acotada, evidencia, incertidumbre y falsificación | Identidad separada y protocolo repetido | Analyst `investigate` / `challenge` |
| **Auditor** | Hallazgos verificables, severidad, cobertura y prioridades | Checklist permanentemente cargada; planificación de ejecución completa | Analyst `audit` + skills |
| **Ticket-audit** | Verificar problema, causa, alcance y solución sugerida | Paso obligatorio por ser ticket; decisión arquitectónica final | Analyst `ticket`; architect condicional |
| **Implementer** | Una tarea, código, tests y verificación local | Ceremonia duplicada, decisiones fuera de scope | Scripts / leader / architect |
| **Reviewer** | Cumplimiento, correctness, seguridad, scope, tests y veredicto | Cálculo de shipping, hashes, receipt y ejecución procedural repetida | Scripts de verificación |
| **Commit-pr-pilot** | Delivery autorizado y presentación del cambio | Algoritmos de preflight/drift; responsabilidad exclusiva de GitHub | Operator + skills y scripts |
| **Solution-design** | Comparar alternativas, contratos, riesgos y challenge | Competencia con otro “brainstorm gate” | Skill de diseño, architect para casos difíciles |

### Explorer + researcher: no los fusionaría todavía

Son cercanos y comparten herramientas, pero tienen un motivo operativo para separarse:

```text
explorer: localizar y orientar barato
analyst: demostrar, explicar o cuestionar
```

En Claude es viable cambiar el modelo por invocación. En Codex, **un modelo/effort fijado en el archivo del agente prevalece sobre los valores del spawn**. El adapter actual escribe ambos campos. [Claude: selección por invocación](https://code.claude.com/docs/en/subagents#choose-a-model), [Codex: agentes personalizados](https://learn.chatgpt.com/docs/agent-configuration/subagents#custom-agents).

Por tanto, `analyst(mode=map)` no conserva automáticamente Haiku/low o su equivalente.

**No construiría un sistema de perfiles dinámicos solo para eliminar `explorer`.** Es una separación pequeña, comprensible y económicamente útil.

### Auditor + ticket-audit: sí los fusionaría

La diferencia importante es el **contrato de la tarea**, no una identidad independiente:

- `audit`: detectar problemas en un área, sin ticket.
- `ticket`: contrastar un problema concreto y su solución sugerida.

Ambos requieren lectura, evidencia, alcance y evaluación. La fusión es razonable si conserva sus checklists y salidas distintas, cargadas bajo demanda.

### Planner: skill, no estación obligatoria

El flujo normal propuesto:

```text
leader → planner → implementer → reviewer → operator
```

agrega una llamada serial incluso cuando el leader ya conoce la tarea y sus límites.

Recomiendo:

- Una tarea acotada: el leader entrega directamente un encargo.
- Varias tareas: aplica una skill de planificación.
- Decisión difícil: architect entrega diseño y, cuando sea suficiente, tareas.
- SDD aceptado: `tasks.md` es el plan; no crear otro equivalente.

La skill debe cubrir únicamente:

```text
tarea · dueño · dependencia · alcance · criterio de aceptación
```

**Planificar no es determinista.** Una skill organiza ese razonamiento; no lo convierte en un algoritmo ni lo hace gratuito.

### Solution-design y architect

`solution-design` ya distingue correctamente **qué construir y por qué** de **archivos y orden**. No necesita otro protocolo que lo duplique.

Evidencia: `packages/core/core-assets/skills/solution-design.md:18-21`.

Usaría **architect**:

- Más preciso que `strategist`, que sugiere estrategia de producto.
- Más claro que `advisor`, que no expresa qué decisión produce.
- Dueño del análisis de decisiones difíciles, no de toda decisión técnica.

Para diseño local y reversible, el leader puede aplicar una versión breve del método. Para diseño difícil, lo aplica architect. **Nunca ambos rehacen el mismo análisis.**

## 4. Roster recomendado

Los modelos siguientes son **defaults candidatos para Claude**, no una superioridad medida.

| Agente | Responsabilidad y triggers | NO responsabilidad | Modelo / effort | Tools y skills | Output |
|---|---|---|---|---|---|
| **Leader** | Entender petición, elegir flujo, sintetizar, coordinar y mantener estado | Código, investigación profunda, delivery, rehacer diseño aprobado | **Opus / medium** | Lectura acotada, delegación, preguntas, memoria; `ticket-intake`, planificación, SDD opt-in | Encargo o grafo mínimo; decisiones de routing |
| **Explorer** | Mapa cuando falta orientación real | Probar causa raíz, auditoría profunda, decidir arquitectura | **Haiku / low** | Lectura, búsqueda, structural provider disponible; memoria de lectura, `structural-search` | Mapa breve, entrypoints, dependencias y límites |
| **Analyst** | Evidencia en modos `investigate`, `challenge`, `audit`, `ticket` | Código, orquestación, aprobar implementación, imponer solución final | **Sonnet / medium** | Lectura/búsqueda, probes permitidos, docs cuando hagan falta; protocolos por modo, seguridad | Respuesta evidenciada; hallazgos, incógnitas o veredicto de aplicabilidad |
| **Architect** | Decisiones difíciles o replanteamiento conceptual | Implementar, despachar agentes, repetir investigación ya disponible | **Opus / xhigh** | Lectura, evidencia previa, docs; `solution-design`, skills del dominio | Solución elegida, tradeoffs, contratos, riesgos, validación y tareas si procede |
| **Implementer** | Escribir una tarea autorizada y sus tests | Rediseñar, ampliar scope, aprobarse, publicar | **Sonnet / medium** | Edición y comandos del proyecto; skills de stack, debug y verificación | Diff acotado, tests, evidencia y bloqueos |
| **Reviewer** | Juzgar requirement, correctness, seguridad, alcance y suficiencia de tests | Editar producto, generar manualmente hashes, sustituir autorización | **Sonnet / medium** | Lectura, evidencia de scripts, comprobaciones focalizadas; `review-diff`, `security-guidance` | `APPROVED` / `CHANGES_REQUESTED`, asociado al snapshot revisado |
| **Operator** | Acciones externas y delivery explícitamente autorizados | Diseño, código, aprobación técnica o autoridad para publicar por iniciativa propia | **Haiku / low**; Sonnet/medium para síntesis compleja | Git, `gh`, `acli`, conectores opt-in; skills de delivery/tracker/comunicación | Acción realizada, identificador/URL y estado verificado |

### Contrato del analyst

No concatenaría los prompts actuales. Usaría una base corta y **un protocolo principal por encargo**:

| Modo | Salida esencial |
|---|---|
| `investigate` | Respuesta, evidencia, incertidumbre |
| `challenge` | Supuestos falsificados y riesgos clasificados |
| `audit` | Hallazgos por severidad, cobertura, exclusiones y prioridades |
| `ticket` | Problema verificado, causa o hipótesis, alcance y aplicabilidad |

Un challenge exige **otra instancia con contexto fresco**. Cambiarle el modo al mismo agente que defendió la propuesta no preserva independencia.

### Límites del operator

`operator` es un nombre adecuado si se define como **operación autorizada**, no “todo lo externo”.

- Leer un ticket no obliga a crear un subagente: una consulta breve puede hacerla quien necesita la evidencia.
- Publicar un ADR aprobado puede ser operación; **decidir y redactar su contenido técnico no**.
- Changelog y release notes pueden derivarse de cambios aprobados.
- Cambios de docs versionadas siguen el ciclo de autoría/revisión.
- Releases, deploys, cambios de estado y mensajes externos conservan sus permisos específicos.

**Una skill disponible o un gate verde no constituyen autorización.**

## 5. Routing y escalación

### Modelo mental

```text
Need a cheap map?    → explorer
Need evidence?       → analyst
Need normal tasks?   → leader + planning skill
Need hard design?    → architect
Need code changed?   → implementer
Need code judged?    → reviewer
Need external action?→ operator
Need synthesis?      → leader
```

### Flujos

**Cambio conocido**

```text
leader
→ implementer
→ verificación determinista
→ reviewer
→ validación de aprobación/contenido
→ operator, si hay delivery autorizado
```

**Investigación**

```text
leader
→ explorer o analyst(s), según la incógnita
→ síntesis
→ encargo o planificación breve
→ implementación y revisión
```

No ejecutar explorer antes de analyst por rutina. Tampoco repetir investigación que ya tiene evidencia vigente.

**Diseño difícil**

```text
leader
→ evidencia faltante, si la hay
→ architect
→ analyst/challenge independiente
→ síntesis y decisión del leader
→ implementación
```

El diseño y el challenge son dependientes: no se paralelizan artificialmente.

### Escalación propuesta

| Evidencia | Acción |
|---|---|
| Falta información del repo | Explorer/analyst; no subir esfuerzo automáticamente |
| Cambia ownership, frontera de confianza, consistencia o migración difícil de revertir | Architect |
| Varias soluciones con tradeoffs relevantes sin resolver | Architect |
| Cambio crítico siguiendo un patrón conocido | Reviewer reforzado; architect solo si hay decisión abierta |
| Review detecta defecto local | Corrección acotada por implementer |
| Review demuestra que la solución está equivocada | Architect |
| Dos ciclos repiten el mismo defecto | Detener parches, revisar hipótesis y escalar según causa |
| Falla de entorno, permisos o infraestructura | Resolver/declarar bloqueo; un modelo más caro no lo arregla |

**No usaría “más de N archivos” como señal suficiente de arquitectura difícil.**

### Reviewer: Sonnet/medium frente a Opus/low

Elegiría **Sonnet/medium como default inicial** y **Opus/medium para riesgo semántico elevado**.

No hay evidencia en esta revisión que demuestre que Opus/low sea más rápido o mejor para los diffs de Navori. La recomendación es conservadora:

- Preservar capacidad de razonamiento suficiente.
- Reservar el tier caro para riesgo.
- Comparar ambos perfiles con el mismo conjunto de cambios.

Los gates detectan fallos mecánicos; **no garantizan que el reviewer detecte una autorización incorrecta o un requisito mal entendido**.

## 6. Qué convertir en lógica determinista

| Trabajo | Dueño recomendado |
|---|---|
| Resolver repo/worktree, base y conjunto de archivos | Script compartido |
| Calcular hashes, registrar eliminaciones y detectar drift | Herramienta de receipt |
| Comprobar cobertura del contenido aprobado | Validador de receipt |
| Ejecutar lint/typecheck/tests/scanners y normalizar resultados | Scripts del proyecto/gates |
| Validar campos obligatorios y pertenencia del handoff al ciclo | Validador de artefactos |
| Comprobar rama, target, upstream y autenticación | Preflight de delivery |
| Comprobar formato de commit/PR | Validador cuando la regla sea expresable |
| Evaluar causa raíz, requisitos, seguridad de negocio y tests adecuados | Analyst/reviewer |
| Elegir solución, prioridades y autorización | Architect/leader/humano según responsabilidad |

### La extracción debe respetar dos límites

**1. Skill no significa ejecución garantizada.**

Mover una receta desde `reviewer.md` hacia `SKILL.md` reduce carga permanente, pero sigue dependiendo de que el agente la invoque. Para garantías hacen falta ejecución comprobable y consumidores que rechacen evidencia ausente o inválida.

**2. Navori genera el harness; no necesita convertirse en otro runtime.**

`docs/DIRECTION.md:113-115` mantiene el principio “genera, no ejecuta”.

Recomiendo **scripts distribuidos/generados con el harness**, llamados desde el flujo, hooks compatibles y CI. No un scheduler, daemon o nuevo framework de agentes.

### Receipts: extraer primero, endurecer después

El hook anterior se retiró por fallas con worktrees, Codex, zsh, rutas no ASCII y receipts truncados; su comentario exige evidencia antes de reintroducirlo.

**No restauraría ese hook como parte de esta simplificación.**

Primero extraería las recetas actuales a una herramienta explícita y testeada, manteniendo:

- Scope por ciclo y worktree.
- Base identificada.
- Contenido aprobado recuperable.
- Cobertura completa del cambio.
- Distinción entre `DRIFT` y error de verificación.
- Revisión humana/LLM separada del cálculo del hash.

Un receipt demuestra correspondencia de contenido; **no demuestra por sí solo independencia ni calidad del juicio**.

### Evitar gates duplicados

El objetivo sería reutilizar evidencia únicamente cuando corresponde al mismo snapshot y condiciones relevantes. No basta “ya corrió hoy”.

Tampoco haría:

```text
full gate en implementer
full gate en reviewer
full gate en operator
```

por ceremonia. Pero no eliminaría verificaciones independientes de CI hasta demostrar que el reemplazo conserva las garantías.

## 7. Impacto por plataforma

### Claude Code

Es el camino más directo:

- Agentes Markdown con modelo, effort y tools.
- Skills por demanda.
- Más hooks de lifecycle ya conectados.
- Override de modelo por invocación documentado. [Documentación oficial](https://code.claude.com/docs/en/subagents).

Dos advertencias:

1. `models.leader` **no cambia por sí mismo el modelo de la conversación principal**. El rol se encarna; no se lanza como subagente.
2. `effort.leader` sí alimenta `settings.json.effortLevel`.

Evidencia: `packages/cli/src/engines/claude/build-settings.ts:93-98`.

Por tanto, recomendar “leader Opus/medium” exige configurar/verificar la **sesión efectiva**, no solo modificar su asset.

### Codex

El adapter actual:

- Genera TOML por agente.
- Fija modelo y effort.
- Traduce paths/instrucciones.
- No reproduce la allowlist `tools:` de Claude.
- Registra guard y gate rápido en `PreToolUse(Bash)`, no toda la instrumentación Claude.

Evidencia: `packages/cli/src/engines/codex/index.ts:381-395`, `build-config-toml.ts:13-62`.

Su mapeo actual es:

| Tier de configuración | Modelo Codex |
|---|---|
| Opus | `gpt-5.6-sol` |
| Sonnet | `gpt-5.6-terra` |
| Haiku | `gpt-5.6-luna` |

Es un puente configurable mediante `codexMap`, **no evidencia de equivalencia de calidad o precio**.

La documentación confirma que los archivos personalizados pueden fijar modelo/effort sobre los valores del spawn, y que los permisos efectivos también dependen del padre. [Configuración oficial](https://learn.chatgpt.com/docs/agent-configuration/subagents#custom-agents).

Consecuencias:

- Conservar explorer evita depender de overrides dinámicos para trabajo barato.
- No prometer escalación porque el prompt diga “usa más razonamiento”: verificar el perfil efectivo.
- No presentar roles “read-only” como aislamiento garantizado: actualmente necesitan escritura de handoffs y el catálogo los trata como `workspace-write`.
- Scripts compartidos ayudan a la portabilidad; los hooks específicos requieren pruebas propias.

## 8. Riesgos y comparación

### Riesgos principales

1. **Analyst monolítico:** fusionar nombres, pero cargar todas las checklists.
2. **Architect ceremonial:** activarlo por cualquier cambio compartido y volver a Opus/xhigh constantemente.
3. **Operator demasiado amplio:** confundir capacidad técnica con permiso.
4. **Falsa protección:** asumir que tests verdes reemplazan review semántico.
5. **Pérdida de tiering:** mapas simples terminan pagando modelo de auditoría.
6. **Migración incompleta:** roles están referidos por schemas, plugins, catálogos, tests y adapters.
7. **Aprobaciones cruzadas:** artefactos compartidos entre ciclos o sesiones.
8. **Medición engañosa:** comparar sesiones con modelos, tareas y versiones diferentes.

### Actual frente a propuesta

| Dimensión | Actual | Propuesta |
|---|---|---|
| **Velocidad** | Auditoría de tickets obligatoria; recetas y handoffs extensos | Menos etapas obligatorias; mapa barato preservado |
| **Tokens** | Protocolos repetidos y mucho shell en prompts | Base corta, skills específicas y resultados estructurados |
| **Calidad** | Independencia valiosa; garantías parcialmente procedurales | Misma independencia, mecánica más verificable |
| **Routing** | Ocho roles y algunas reglas contradictorias | Siete roles con frontera explícita; planning no ceremonial |
| **Mantenibilidad** | Algoritmos y contratos repartidos en prosa | Algoritmos compartidos y prompts centrados en juicio |
| **Claude/Codex** | Render compartido, garantías de runtime distintas | Mayor reutilización de scripts sin fingir paridad de hooks |

**La propuesta literal de siete roles tiene un problema:** agrega planner al camino normal y elimina explorer barato. Puede mejorar la taxonomía sin mejorar el tiempo total.

## 9. Orden recomendado y validación

No haría una migración masiva conjunta.

1. **Extraer mecánica de reviewer/pilot**, conservando comportamiento y nombres.
2. **Corregir contradicciones de routing** y eliminar repeticiones.
3. **Fusionar analyst y agregar architect excepcional**, preservando explorer.
4. **Renombrar pilot a operator**, inicialmente manteniendo delivery; ampliar integraciones solo cuando exista necesidad.
5. **Medir antes de ajustar modelos otra vez.**

La migración debe preservar opt-outs, overrides, user-sections y extensiones de plugins. Engram, CodeGraph, GH y ACLI referencian roles actuales; renombrar archivos no basta.

### Pruebas necesarias

- Receipt: archivos nuevos/eliminados/renombrados, Unicode, espacios, modos de archivo, staging parcial y cambios posteriores.
- Worktrees y sesiones simultáneas; base avanzada; receipt ausente, truncado o de otro ciclo.
- Gate fallido, timeout, cancelación y herramienta inexistente: ninguno debe aparecer como verde.
- Render/migración Claude y Codex, plugins, roles deshabilitados y perfiles efectivos.
- Routing: tarea local sin architect/planner; ticket simple sin auditoría profunda; cambio conceptual con escalación.
- Calidad semántica: defectos conocidos que lint/tests no detectan.

Para comparar velocidad/costo: mismo conjunto de tareas, perfiles fijados, tiempo hasta cambio revisado, tokens/costo, número de handoffs, ciclos de corrección y defectos omitidos. **No usar “menos agentes lanzados” como métrica única.**

## Recomendación final

**Adoptar la versión modificada: siete roles, sin planner obligatorio y conservando explorer barato.**

La prioridad de implementación futura sería:

> **Sacar los algoritmos de los prompts; después simplificar los roles.**

El challenge independiente dejó preocupaciones de portabilidad, permisos y preservación de contratos, no una razón para mantener toda la arquitectura actual. Esas preocupaciones justifican la migración gradual.

**Verificación:** no modifiqué el repo. No declaro quality gate verde: la prueba focalizada fue interrumpida durante el `globalSetup` que ejecuta `pnpm build`. Engram tampoco pudo persistir el cierre por sesiones activas ambiguas; el fallback de escritura fue bloqueado por permisos.

## Key Learnings:

1. El ahorro depende de contexto, tier y handoffs, no del número de nombres.
2. Codex hace valioso conservar un explorer barato con configuración propia.
3. Gates y receipts deben aportar evidencia determinista; reviewer conserva juicio y operator no adquiere autorización por recibir un resultado verde.
