# Admisión y retiro de agentes — Design

## Decisiones

1. **Tres garantías, no una lista de casos de uso.** Una lista de "cuándo sí crear un agente"
   envejece con cada engine. Las tres garantías de R1 son estables porque describen el efecto,
   no el mecanismo, y coinciden con las metas que `DIRECTION.md` ya ordena.
2. **Tokens se mide neto.** El arranque en frío es el costo que la spec 0027 midió y que tumbó
   T2–T4. Un agente que "ahorra tokens" sin pagar su arranque no ahorra.
3. **El orden de prioridad aplica entre ejes (R2).** Sin esta regla, la velocidad justificaría
   cualquier fan-out, incluso uno que degrade la calidad.
4. **Apagado por default (R4)** generaliza lo que ya se hizo con `architect`. Encender un agente
   en todos los repos cambia la superficie de cada usuario sin que lo pida.
5. **La skill `author-agent` vive en navori-harness, no en el core.** Casi todo agente nace en el
   core de navori: no existe `project.localAgents`, ningún preset bundled trae agentes y el
   registro de un agente core (roster, schema, i18n, paridad) solo existe en este repo. Un preset
   local puede sumar agentes vía `extras.agents`, pero es un caso raro que no justifica una fila
   del índice en cada repo; si aparece la demanda, la skill sube al core.

## Evidencia

| Dato | Fuente |
|---|---|
| Un agente usa ~4× los tokens de un chat; un sistema multi-agente, ~15× | Anthropic, "How we built our multi-agent research system" |
| Un lead Opus con subagentes Sonnet superó a Opus solo en 90.2% en investigación amplia; los tokens explican 80% de la varianza | misma fuente |
| El fan-out paralelo (3–5 subagentes) recortó hasta 90% el tiempo de investigación | misma fuente |
| Los dominios con contexto compartido o muchas dependencias entre agentes, y la mayoría de las tareas de código, encajan mal en multi-agente | misma fuente |
| "we recommend finding the simplest solution possible… This might mean not building agentic systems at all" | Anthropic, "Building effective agents" |
| "Maximize a single agent's capabilities first" | OpenAI, "A practical guide to building agents" |
| Codex activa subagentes de forma explícita (salvo la delegación proactiva del nivel Ultra) y consumen más tokens que una corrida de un solo agente | docs de subagentes de Codex |
| Arranque en frío de un subagente ~25k tokens contra un artefacto de ~2k | spec 0027, design, "Amendment" |

## Cómo se aplica a cada garantía

| Garantía | Admisible cuando | No admisible cuando |
|---|---|---|
| Calidad | revisa en contexto fresco lo que otro escribió; necesita un tier que el orquestador no puede fijarse; carga contexto especializado | repite lo que el hilo principal ya haría igual |
| Velocidad | parte trabajo independiente en paralelo | el trabajo es secuencial o comparte estado |
| Tokens | saca salida voluminosa del contexto principal o baja trabajo mecánico de tier, neto del arranque | su salida cuesta menos que su arranque |

## Evaluación inicial del roster (R5)

Solo informativa: los tickets de retiro se abren aparte.

| Agente | Garantía | Nota |
|---|---|---|
| `orchestrator` | — | Lo encarna el hilo principal; no es un subagente, así que no aplica |
| `implementer` | Tokens y tier (saca la escritura del contexto del orquestador y la corre en un tier más barato) | — |
| `reviewer` | Calidad (verificación en contexto fresco) | — |
| `scout` | Tokens / velocidad (fan-out de lectura, tier barato) | — |
| `auditor` | Calidad (contexto especializado, lectura profunda) | — |
| `architect` | Calidad (tier + contexto) | Ya tiene criterio de retiro a 60 días |
| `publisher` | Tokens (trabajo mecánico en tier barato) | Neto del arranque sin medir: se revisa a 60 días con `navori audit`, igual que `architect` |
| `scribe` | Ninguna vigente | Sin trabajo desde que se retiraron T2–T4 de la spec 0027. #985 propone ampliarlo (dueño de todo el Markdown): esa propuesta pasa primero por R7, y el retiro (#993) espera su resultado |
