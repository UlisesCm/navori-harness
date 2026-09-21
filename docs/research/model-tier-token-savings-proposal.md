# Propuesta de ahorro de tokens por tier y esfuerzo de agentes

> **Estado: propuesta no implementada.** Este documento no modifica `navori.config.json`, no cambia modelos ni esfuerzos, y no constituye una promesa de ahorro. Su propósito es definir una decisión reversible que se adoptará sólo si supera un experimento A/B.

## Objetivo

Reducir el costo y razonamiento consumido por tareas de exploración rutinarias sin degradar la calidad de la evidencia que recibe el orquestador. La propuesta se evalúa junto con dos palancas complementarias: cargar instrucciones bajo demanda y enviar cada tarea al rol proporcional a su complejidad.

## Estado actual

La configuración vigente mantiene Claude y Codex habilitados. Los roles usan tiers de Claude que el renderer de Codex traduce a modelos concretos, salvo que `models.codexMap` los reemplace.

| Rol | Tier actual | Effort actual | Propósito operativo |
|---|---|---:|---|
| `orchestrator` | `opus` | `medium` | Sintetiza, decide routing y coordina cambios. |
| `implementer` | `sonnet` | `medium` | Implementa una tarea y sus pruebas focalizadas. |
| `reviewer` | `sonnet` | `low` | Revisa el diff y ejecuta el quality gate completo. |
| `scout` | `haiku` | `high` | Reconnaissance y preguntas acotadas de código. |
| `auditor` | `sonnet` | `medium` | Audita áreas, tickets o desafía diseños. |
| `publisher` | `haiku` | `low` | Preflight de publicación, commit y PR. |
| `scribe` | `haiku` | `low` | Convierte evidencia verificada en artefactos Markdown. |
| `architect` | `opus` | `high` | Diseña cambios difíciles o de difícil reversión. |

**Fuentes internas.** `navori.config.json` (`models`, `effort`); `packages/cli/src/engines/codex/index.ts` (`buildAgentToml` y `CODEX_MODEL_BY_CLAUDE_TIER`); `packages/cli/src/engines/claude/build-settings.ts` (`buildClaudeSettings`). En Claude, `orchestrator` determina el `effortLevel` de la sesión y los subagentes pueden sobrescribirlo en su frontmatter; en Codex, el renderer emite `model` y `model_reasoning_effort` por agente.

## Propuesta principal: `scout = haiku + medium`

Cambiar **sólo después de medir** el esfuerzo de `scout` de `high` a `medium`, conservando el tier `haiku`. Es una reducción localizada: no cambia la asignación de modelo, el roster, permisos, reglas de delegación ni los demás roles.

La hipótesis es que `high` aporta poco en reconnaissance normal —localizar símbolos, identificar consumidores, mapear archivos o contestar una pregunta acotada— y que `medium` conserva suficiente razonamiento para devolver evidencia verificable. No se adopta por intuición: cada resultado debe citar rutas, símbolos o líneas, declarar incertidumbre y permitir al orquestador leer la fuente antes de decidir.

### Casos que conservarían `high`

La configuración global propuesta no impide pedir `high` explícitamente cuando la exploración deja de ser rutinaria. Se conserva o escala a `high` para:

1. **Impacto amplio:** una pregunta que atraviesa varios paquetes, engines o contratos y requiere reconstruir relaciones antes de editar.
2. **Área crítica:** render, sync, backups con escritura/borrado, permisos de `settings.json`, hooks de allow/deny/ask, bloques managed o anti-rollback.
3. **Investigación arquitectónica:** alternativas con ownership compartido, migración, concurrencia, contrato de API/DTO/schema/evento o reversión costosa.
4. **Evidencia contradictoria:** resultados parciales, fuente ausente o desacuerdo entre tests, documentación y comportamiento observado.

Estos casos deben declararse en el encargo. Si se requiere juicio de seguridad, causa raíz o veredicto, el rol correcto normalmente es `auditor`, no forzar a `scout` a hacer trabajo de auditoría.

## Tres palancas que se deben medir por separado

| Palanca | Cambio propuesto | Beneficio esperado | Riesgo que se controla |
|---|---|---|---|
| Effort de `scout` | `high` → `medium` para reconnaissance rutinaria. | Menos tokens de razonamiento en tareas baratas. | Omisiones de relaciones, evidencia débil o más rondas. |
| Progressive disclosure / contexto | Mantener root y reglas críticas breves; cargar skills, ejemplos y playbooks sólo cuando el trigger aplica. | Menos contexto residente repetido. | Que una regla crítica deje de llegar a su audiencia. |
| Routing por tipo de tarea | Usar `haiku` para inventarios, scribe, publicación y checks mecánicos; reservar `sonnet`/`opus` para implementación, revisión, auditoría y diseño. | Evitar pagar capacidad de juicio donde no aporta. | Clasificar mal una tarea y degradar calidad. |

No se suman porcentajes de ahorro entre palancas. Cambiar dos a la vez impide atribuir el resultado. La reducción de contexto residente ya tiene un plan separado en `docs/research/context-resident-token-reduction-plan.md`; esta propuesta no autoriza podas de prompts ni skills.

## Trade-offs

### Beneficios potenciales

- `scout` deja de usar razonamiento alto para localizaciones y mapas simples.
- La separación entre trabajo mecánico y trabajo de juicio mantiene la capacidad cara donde protege calidad.
- Un experimento pequeño se puede revertir sin migraciones, cambios de assets ni nuevos proveedores.

### Costos y límites

- Menos esfuerzo puede producir exploraciones demasiado superficiales y trasladar costo al orquestador, implementer o auditor.
- Subagentes aíslan contexto del hilo principal, pero no garantizan menor costo total; más delegación puede aumentar tokens agregados.
- Un tier `haiku` no sustituye análisis profundo. El routing debe escalar el rol o effort, no pedirle a `scout` un veredicto que no le corresponde.
- El uso facturado y los campos de telemetría dependen del host/modelo. Bytes, líneas y conteo estimado no son una factura.

## Diseño del experimento A/B

### Control y variante

- **Control:** configuración actual: `scout = haiku + high`.
- **Variante:** únicamente `scout = haiku + medium`.
- Mantener constantes engine, modelo base, prompt de tarea, checkout/commit, reglas, herramientas disponibles y máximo de agentes.
- Ejecutar control y variante en orden alternado para reducir sesgo por calentamiento de caché o cambios de working tree.

### Muestra mínima sugerida

Ejecutar al menos diez pares comparables, repartidos entre:

1. búsqueda de definición/call sites;
2. mapa de un módulo con relación entre dos componentes;
3. investigación de impacto local antes de un cambio;
4. pregunta sin respuesta conocida que requiera declarar incertidumbre.

Excluir áreas críticas de la primera muestra; se prueban después con un encargo explícito de `high`, no para justificar bajar la base global.

### Métricas

Por par y por engine, registrar:

- `input`, `cache_read`, `cache_creation`, `output` y costo total si el host los expone;
- tokens de razonamiento o señal de effort, si el host los expone;
- duración, número de tool calls, subagentes y rondas adicionales solicitadas;
- rutas/símbolos citados y porcentaje de afirmaciones verificadas al abrir la fuente;
- cobertura de consumidores/entry points esperados para la tarea;
- correcciones posteriores: hallazgos que el orquestador, implementer o reviewer tuvo que reparar;
- resultado de los gates que dependan de la investigación y retrabajo atribuible.

Reportar mediana y rango intercuartil, no sólo el mejor caso. Separar costo total de costo del hilo principal y separar ahorro observado de estimaciones por bytes.

## Criterios de adopción y reversión

### Adoptar

Adoptar `scout = haiku + medium` sólo si, frente al control comparable:

1. la mediana de costo total o tokens medidos disminuye al menos **10%**;
2. no hay regresión material en evidencia verificable, cobertura de impacto ni rondas adicionales;
3. no aparecen omisiones de seguridad, permisos o entry points atribuibles a la variante;
4. el quality gate de los cambios que usaron la exploración permanece verde y no aumenta el retrabajo de forma explicable por la variante.

El umbral es un gate de adopción, no una predicción. Si el host no expone uso comparable, no se afirma ahorro: se conserva la configuración actual y se mide primero.

### Revertir o no adoptar

Revertir inmediatamente al valor actual (`scout = haiku + high`) o no aplicar el cambio si ocurre cualquiera de estas condiciones:

- un resultado de `medium` omite una relación o invariante que el control encontraba;
- el ahorro es menor a 10%, está dentro de variación no explicada o se compensa con más rondas/subagentes;
- disminuye sólo `output` pero crece el costo total;
- el experimento toca un área crítica sin haber escalado a `high` o al rol adecuado;
- la telemetría no permite una comparación honesta.

La reversión es restaurar un único valor de `effort.scout`; no requiere cambios de modelos ni de assets. Todo cambio posterior de contexto o routing debe abrir su propio control/variante.

## Secuencia posterior propuesta

1. Registrar baseline de tareas comparables con el estado actual.
2. Aplicar temporalmente sólo la variante en una branch de experimento.
3. Ejecutar y revisar los pares A/B con evidencia de fuentes y telemetría disponible.
4. Decidir adoptar, revertir o seguir midiendo; documentar el resultado antes de modificar el default.
5. Evaluar progressive disclosure y routing en experimentos independientes, nunca mezclados con el tiering de `scout`.

## Referencias internas relacionadas

- `docs/research/context-resident-token-reduction-plan.md`: inventario y experimento de contexto residente, con invariantes y gate de adopción separados.
- `packages/cli/src/lib/schema.ts` (`NavoriConfigSchema`): contrato de `models`, `effort` y `models.codexMap`.
- `packages/cli/src/engines/shared/roster.ts` (`ROSTER_AGENTS`): roles del harness y sus capacidades.
- `packages/cli/src/engines/codex/index.ts` (`buildAgentToml`): resolución de tier a modelo y emisión de `model_reasoning_effort`.
- `packages/cli/src/engines/claude/build-settings.ts` (`buildClaudeSettings`): `effortLevel` de sesión Claude.
- `.agents/skills/locate-code/SKILL.md`: contracto de reconnaissance y evidencia acotada.
