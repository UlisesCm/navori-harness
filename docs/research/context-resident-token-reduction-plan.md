# Plan de reducción de contexto residente

> **Estado:** propuesta de investigación e implementación posterior. Este documento no modifica el render, los prompts, los límites ni las reglas de delegación. No es una spec SDD.

## Objetivo

Construir primero un inventario reproducible del contexto que Navori entrega a Claude Code y Codex, clasificado por **cuándo** y **a quién** llega. Con esa línea base, reducir únicamente contexto repetido que no sea un invariante de seguridad, permisos u orquestación, y demostrar una mejora de costo sin bajar calidad ni adherencia.

El resultado buscado no es un número de bytes aislado: es menos `input + cache_read + cache_creation + output` por tarea comparable, preservando el diff correcto, hallazgos de review y quality gate.

## No objetivos

- No instalar ni adoptar Caveman, Ponytail ni un proxy de compresión.
- No habilitar modos `lite/full/ultra`, resumir errores/diffs, ni filtrar output de herramientas de forma lossy.
- No mover fuera del contexto residente reglas de seguridad, permisos, bloques managed, límites de operaciones destructivas ni `implementer → reviewer`.
- No cambiar modelos, precios, concurrencia o la política de subagentes como parte de este trabajo.
- No crear una spec SDD: la primera entrega es medición read-only y las decisiones posteriores dependen de esa evidencia.

## Evidencia que motiva el plan

### Documentación oficial

- Claude distingue `CLAUDE.md` (instrucciones siempre activas), rules por path, skills on-demand, subagentes aislados y hooks. Recomienda mantener cada `CLAUDE.md` bajo 200 líneas y mover referencia a skills; las descripciones de skills se cargan al inicio y el cuerpo al invocarlas. También aclara que los skills declarados explícitamente en un subagente sí se precargan para ese subagente. [Claude Code: Features overview](https://code.claude.com/docs/en/features-overview)
- Codex concatena las instrucciones `AGENTS.md` descubiertas de raíz a hoja antes del prompt. Su documentación recomienda usar subagentes para aislar lectura y devolver resúmenes, pero advierte que los flujos multiagente consumen más tokens totales que una ejecución equivalente de un solo agente. [AGENTS.md](https://developers.openai.com/codex/guides/agents-md/) · [Subagents](https://developers.openai.com/docs/agent-configuration/subagents)
- En ambos hosts, los subagentes aíslan el hilo principal, no garantizan menor costo total; se medirán por escenario en vez de incentivarlos globalmente.

### Evidencia local verificable

| Hallazgo | Evidencia actual | Consecuencia para el plan |
|---|---|---|
| El presupuesto debe medir el render, no assets fuente. | `packages/cli/src/engines/claude/__tests__/claude-md-budget.test.ts` renderiza con todos los plugins y cuenta el resultado real. | El inventario partirá del render por engine/configuración, con hashes reproducibles. |
| Claude tiene un límite de 200 líneas para `CLAUDE.md` renderizado. | Mismo test: `LINE_BUDGET = 200` y diagnóstico por bloques managed. | `always-on` reportará líneas y bytes, y conservará este guard. |
| El hook de arranque puede perder contexto si se rebasa la entrega real. | `packages/cli/src/engines/claude/__tests__/session-start-budget.test.ts`: `BUDGET = 8000`, `DELIVERY_CEILING = 8800`, inline o puntero. | `hook` se medirá sobre el payload emitido, no sobre el script ni archivo persistido. |
| Ya hay techos por bloque always-on. | `packages/cli/src/lib/doc-budgets.ts` y `check-doc-budgets.mjs`. | El reporte complementa esos techos; no los sustituye. |
| El catálogo de agentes es residente y ya se limita. | `packages/cli/src/lib/__tests__/agent-descriptions.test.ts` declara máximo de 340 caracteres por descripción y explica que ocho descripciones se cargan cada sesión. | El reporte separará catálogo/descripciones de cuerpos de rol. |
| Las skills ya tienen carga diferida y caps. | `packages/cli/src/lib/__tests__/skill-caps.test.ts` exige trigger y límite de listado; `claude-md-budget.test.ts` indica que el cuerpo carga sólo al usarlo. | Se distinguirán `lazy-metadata` de `lazy-body`. |
| Los punteros no son una pérdida silenciosa. | `session-start-budget.test.ts` exige que cada bloque llegue inline o como puntero. | El inventario registrará `handoff/pointer` y no eliminará su fallback. |
| Ponytail ya fue auditado localmente. | `docs/research/ponytail-lessons.md`. | Se extraen prácticas medibles, no se copia su runtime o modos. |

## Modelo de inventario (línea base)

Cada fila representa un artefacto **tal como el host puede verlo**, no una estimación del repositorio fuente. Campos mínimos:

`engine`, `configuration`, `category`, `audience`, `path_or_origin`, `bytes`, `lines`, `estimated_tokens`, `delivery` (`inline` o `pointer`), `hash` y `notes`.

`estimated_tokens` es sólo una señal de ordenamiento (declarar algoritmo y versión); bytes y líneas siguen siendo métricas de contrato. No se debe presentar como uso facturado.

| Categoría | Qué incluye | Audiencia esperada |
|---|---|---|
| `always-on` | `CLAUDE.md` o `AGENTS.md` final y bloques/root que el host entrega por sesión. | principal, y donde aplique subagente |
| `role` | Prompt/instrucciones y descripción de cada agente; separar descripción de cuerpo. | agente de ese rol; metadata puede ser principal |
| `lazy-metadata` | Nombre, trigger y descripción indexados de skills. | principal o subagente, según host |
| `lazy-body` | Cuerpo de skill sólo al invocarse o precargarse mediante `skills:`. | invocador o rol que la predeclara |
| `hook` | `additionalContext` emitido realmente por hooks, incluido payload y degradación. | sesión receptora |
| `handoff/pointer` | Referencias a artifacts/progress en vez de cuerpo inline. | quien debe reconstruirlo |
| `external-memory` | Contexto de plugins/host fuera del render core, sin capturar secretos. | según plugin/host |

Configuraciones mínimas: Claude y Codex; plugins conocidos habilitados y configuración mínima; idioma `es` y `en` si el render cambia tamaño; y un `SessionStart` con progreso representativo y otro sobredimensionado. El reporte declarará toda dimensión que aún no pueda materializar.

## Fases y gates

### Fase 0 — Instrumento read-only y baseline

**Entregable.** Comando/reporte determinista que produzca JSON para máquina y Markdown compacto. Ordenará categorías por bytes, mostrará subtotal por audiencia y enlazará source/render.

**Archivos candidatos (no comprometidos).**

- `packages/cli/src/engines/claude/index.ts`
- `packages/cli/src/engines/codex/index.ts`
- `packages/cli/src/engines/shared/agents-index.ts`
- `packages/core/core-assets/hooks/session-start-context.sh`
- `packages/cli/src/engines/claude/__tests__/claude-md-budget.test.ts`
- `packages/cli/src/engines/claude/__tests__/session-start-budget.test.ts`
- nuevo comando/test bajo `packages/cli/src/**` y documentación de uso.

**Métricas.** Bytes, líneas, token estimado, porcentaje por categoría, duplicación exacta entre canales e `inline/pointer`; no factura ni infiere ahorro aún.

**Gate.** Reproducible desde un directorio temporal, sin datos de usuario/progreso real; cubre Claude y Codex o declara el hueco con test; no cambia assets renderizados. Se conserva verde el gate existente de budgets/render.

### Fase 1 — Diagnóstico y selección de candidatos

**Entregable.** Tabla priorizada de redundancias verificadas con texto/origen, audiencia, categoría destino propuesta, regla preservada, ahorro estático estimado y rollback.

**Método.** Comparar contenido real entre `always-on`, `role`, `hook` y `handoff/pointer`; marcar sólo duplicación literal o semántica revisada. Una regla se mueve únicamente si su destino carga cuando la necesita su audiencia.

**Métricas.** Bytes residentes potencialmente evitables por engine/audiencia; porcentaje descripción/cuerpo; y número de reglas críticas que permanecen residentes.

**Gate.** Revisión humana de cada candidato contra invariantes. No se aprueba mover texto sólo por ser largo o por parecerse a Ponytail/Caveman.

### Fase 2 — Poda segura y segmentación mínima

**Entregable.** PRs pequeños, uno por hipótesis, que dejen en root invariantes universales, trigger/routing breve y punteros. Tablas, ejemplos, justificaciones y playbooks van al skill o rol dueño.

**Archivos candidatos.**

- `packages/core/core-assets/managed/*.md`
- `packages/core/core-assets/agents/{implementer,reviewer,publisher,orchestrator}.md`
- `packages/core/core-assets/skills/*.md`
- `packages/cli/src/lib/doc-budgets.ts`
- presupuestos/tests de Claude y Codex afectados.

**Métricas.** Delta de bytes/líneas de `always-on`, `role` y `hook`; cobertura de invariantes; regresión de activación de agentes/skills.

**Gate.** Managed markers, presupuestos y entrega inline/pointer permanecen correctos, y `implementer → reviewer` sigue explícito para todos los engines aplicables.

### Fase 3 — Experimento operacional A/B

**Entregable.** Protocolo y resultados de tareas comparables: bug local, feature con implementer+reviewer, ticket de investigación y tarea con logs grandes. Baseline/control y variante se ejecutan por separado.

**Métricas primarias.** Por tarea, engine y modelo: `input`, `cache_read`, `cache_creation`, `output`, costo total si el host lo expone, tool calls, tiempo, tamaño de diff, findings válidos, intentos de quality gate y resultado del gate.

**Métricas de calidad.** Hallazgos omitidos, reglas no obedecidas, fallos de render, contenido crítico ausente y reconstrucciones fallidas desde puntero.

**Gate.** Muestra y método documentados antes de comparar; no mezclar poda con filtros de output, tiering o cambios de modelo. Menos bytes sin beneficio en uso comparable no prueba ahorro facturable.

### Fase 4 — Decisión, rollback y extensiones opcionales

**Entregable.** Decisión por palanca (`adoptar`, `revertir`, `seguir midiendo`) y actualización de budgets/documentación sólo para cambios aceptados. Cada cambio incluye rollback directo a assets previos.

**Extensiones sólo después.**

- Disciplina de output tipo Caveman: experimento reversible; nunca ocultar errores, diffs, seguridad o tests.
- Escalera YAGNI de Ponytail: ya existe variante local en implementer/reviewer; medir adherencia antes de añadir modos o runtime.
- `disable-model-invocation` para skills manuales de Claude: sólo si hay metadata ociosa y trigger humano documentado; nunca para routing automático.

**Gate de adopción.** Reducir al menos **10% la mediana de costo total** en el escenario objetivo frente a control comparable, sin regresión en quality gate, review, seguridad ni activación correcta. Se rechaza si sólo baja `output` mientras crece el total, si el ahorro cae en variación no explicada, o si requiere proxy/runtime nuevo.

## Hipótesis de ahorro, no promesas

Los rangos se solapan; no se suman.

| Escenario | Palanca principal | Hipótesis | Confianza |
|---|---|---:|---|
| Bug local o tarea mecánica | Poda de root/metadata | 2–8% | media |
| Feature con implementer + reviewer | Root, role y handoff por puntero | 8–18% | media |
| Investigación multiagente | Evitar duplicación y devolver síntesis | 15–30% en hilo principal; no necesariamente costo total | baja-media |
| Tests/logs voluminosos | Filtro reversible posterior, fuera de este plan | 0–25% adicional | baja |

La expectativa agregada previa a medición es 5–15% en sesiones normales y 15–30% en sesiones cortas/repetitivas o con varios subagentes. Es hipótesis de priorización, no criterio de éxito: manda la mediana A/B de Fase 3.

## Riesgos e invariantes

1. **Seguridad y permisos son residentes.** No se desplazan reglas de autorización, operaciones destructivas, secretos, managed blocks ni anti-rollback.
2. **Orquestación no se degrada.** `implementer → reviewer` permanece visible para quien decide/delega.
3. **Puntero no equivale a omisión.** Contenido fuera de inline conserva ruta e instrucción accionable; los tests de entrega son contrato.
4. **No confundir resident con cache.** Un token cacheado puede costar menos, pero ocupa contexto y puede afectar adherencia; se reporta separado.
5. **No optimizar sólo con benchmark sintético.** Ponytail aporta benchmark/variantes; Caveman, hipótesis de ruido de output. Ninguno sustituye casos reales ni justifica su runtime/licencia.
6. **La medición no entra al prompt.** Inventario en CLI/tests/artefacto generado, no como instrucciones por sesión.

## Orden explícito de implementación posterior

1. Implementar Fase 0 sin cambiar render y revisarla independientemente.
2. Ejecutar/publicar baseline para engines y configuraciones definidas.
3. Hacer Fase 1: seleccionar máximo tres candidatos con evidencia.
4. Implementar una poda de Fase 2 por PR, con implementer y reviewer.
5. Ejecutar Fase 3 para esa palanca; adoptar/revertir antes de la siguiente.
6. Sólo tras adopción comprobada, evaluar extensiones de Fase 4 por separado.

El orden evita que el reporte justifique retrospectivamente una poda y que varias optimizaciones oculten cuál cambió costo o calidad.

## Referencias de patrones externos

- [Ponytail](https://github.com/DietrichGebert/ponytail): reglas bajo demanda, benchmark con brazos separados y adaptadores delgados. `docs/research/ponytail-lessons.md` concluye que Navori ya tiene fuente de verdad/render, caps y parte de YAGNI; copiar modos/runtime sería scope especulativo.
- Caveman se considera sólo como inspiración para separar medición de output de herramientas. No se adopta proxy: aumenta superficie operativa y no hay evidencia local de beneficio neto.
