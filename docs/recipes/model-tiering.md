# Recipe — perfil de modelos y effort por agente en navori

> Cómo elegir valores para `{{models.<agent>}}` / `{{effort.<agent>}}`, los placeholders
> que el render interpola en el frontmatter de cada `.claude/agents/*.md`.
> Defaults en `packages/cli/src/lib/recommended.ts` (`RECOMMENDED_MODELS`,
> `RECOMMENDED_EFFORT`), sembrados en `navori.config.json` por `init --recommended` /
> `--full`. Enforced por `packages/cli/src/lib/__tests__/recommended.test.ts`.

## Principio

Elige el modelo por agente según lo que SU tarea necesita, no un tier único para todos:

- **Mecánico** (mapear un directorio, redactar un commit): tier barato/rápido.
- **Implementación estándar** (código ya planeado, síntesis textual): tier medio.
- **Juicio** (revisar, auditar, decidir arquitectura): tier top.

Sin perfil explícito, cada subagente hereda el modelo de la sesión (típicamente el
más caro) — así que trabajo mecánico corre al mismo precio que trabajo de juicio.

## Defaults recomendados

Claves reales de `ModelsSchema`/`EffortSchema` (`packages/cli/src/lib/schema.ts`);
`ticket-audit`/`commit-pr-pilot` son los ids de archivo en `core-assets/agents/`,
`ticketAudit`/`commitPrPilot` las claves de config.

| Agente | `models.<agent>` | `effort.<agent>` | Por qué |
|---|---|---|---|
| `leader` | `opus` | `xhigh` | Orquesta, define scope y arbitra `CHANGES_REQUESTED` — el único rol de juicio puro, no se abarata. |
| `implementer` | `sonnet` | `medium` | Código desde una tarea ya acotada; sonnet rinde casi como opus en coding a una fracción del costo. |
| `reviewer` | `sonnet` | `medium` | Revisa contra spec/quality gate — síntesis contra un contrato, no arquitectura desde cero. |
| `researcher` | `sonnet` | `medium` | Investigación con preguntas acotadas; redacta hallazgos, no solo mapea archivos. |
| `ticketAudit` | `sonnet` | `medium` | Lee y estructura un ticket/spec — síntesis textual. |
| `auditor` | `sonnet` (sube a `opus` si el presupuesto alcanza) | `medium` | Auditoría arquitectural (SOLID, seguridad, performance, edge cases) — más cerca de juicio que de síntesis; el propio `auditor.md` lo señala explícito. |
| `explorer` | `haiku` | `low` | Mapear archivos/patrones — lectura mecánica, sin síntesis. |
| `commitPrPilot` | `haiku` | `low` | Redacta commit/PR desde un diff ya aprobado — mecánico. |

## Effort sigue la misma lógica

`effort.<agent>` es la otra palanca del mismo eje: modelo caro + effort alto significa
más tokens de razonamiento y más tool calls por invocación. Un agente mecánico en
`sonnet`/`low` sigue siendo más barato en agregado que el mismo agente en `opus`/`xhigh`
corriendo N veces por sesión (ej. un `explorer` por sub-mapa en un fan-out). El
`effort` de `leader` además siembra `effortLevel` de `settings.json`, porque ese rol
es el agente principal — no se spawnea como subagente, así que no hay otro punto
donde fijar su tier.

## No definas todo en el tier top

El costo se multiplica por invocación, no por sesión: poner cada agente en
`opus`/`xhigh` no mejora la calidad donde no hay juicio real que ejercer, solo quema
presupuesto en cada llamada. `init --recommended` / `--full` siembran los defaults de
la tabla; `init --yes` no siembra nada (cada subagente hereda el modelo de sesión).

## Cuándo subir un tier

Señal concreta, no intuición: 2+ ciclos `CHANGES_REQUESTED` seguidos sobre la misma
tarea compleja (cap ya documentado en `orquestacion.md`) indica que el tier del
`implementer` — o el del rol que está fallando — es insuficiente para esa
complejidad, no que falte reintentar. Sube ese agente un tier antes de reintentar en
loop.

## Tiering por fix, no por ronda

Cuando una revisión produce N hallazgos, no mandes toda la ronda al mismo tier alto:
clasifica cada fix por lo que exige, no por la ronda a la que pertenece. Es el mismo
criterio del "Principio" de arriba, aplicado por fix en vez de por agente — dentro de
una sola ronda coexisten sub-tareas de distinto tier.

| Tipo de fix | Ejemplos | Tier |
|---|---|---|
| Mecánico | Tablas de strings, ediciones de JSON, notas de una línea, renombres | Bajo/medio |
| Juicio | Decisiones de diseño, regex de seguridad, semántica de remoción | Alto |
