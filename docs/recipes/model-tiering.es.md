> [English](model-tiering.md) | [Español](model-tiering.es.md) | [简体中文](model-tiering.zh-CN.md)

# Recipe — perfil de modelos y effort por agente en navori

> Cómo elegir valores para `{{models.<agent>}}` / `{{effort.<agent>}}`, los placeholders
> que el render interpola en el frontmatter de cada `.claude/agents/*.md`.
> Defaults en `packages/cli/src/lib/config/recommended.ts` (`RECOMMENDED_MODELS`,
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

Claves reales de `ModelsSchema`/`EffortSchema` (`packages/cli/src/lib/config/schema.ts`), que
coinciden con los ids de archivo en `core-assets/agents/` — el roster canónico vive en
`engines/shared/roster.ts` (`ROSTER_AGENTS`).

| Agente | `models.<agent>` | `effort.<agent>` | Por qué |
|---|---|---|---|
| `orchestrator` | `opus` | `xhigh` | Orquesta, define scope y arbitra `CHANGES_REQUESTED` — el único rol de juicio puro, no se abarata. |
| `architect` | `opus` | `xhigh` | Diseña en tareas de nivel 2/3 (`navori plan classify` decide el nivel, no el modelo): lee mucho código y pesa tradeoffs antes de que nadie escriba código, mantiene el tier del orchestrator (spec 0026 F) en vez de bajar al de síntesis. |
| `implementer` | `sonnet` | `medium` | Código desde una tarea ya acotada; sonnet rinde casi como opus en coding a una fracción del costo. |
| `reviewer` | `sonnet` | `medium` | Revisa contra spec/quality gate — síntesis contra un contrato, no arquitectura desde cero. |
| `scout` | `sonnet` | `medium` | Mapea y/o investiga con preguntas acotadas; redacta hallazgos, no solo lista archivos. |
| `auditor` | `sonnet` | `medium` | Auditoría arquitectural (SOLID, seguridad, performance, edge cases) — más cerca de juicio que de síntesis; el propio `auditor.md` lo señala explícito. |
| `publisher` | `haiku` | `low` | Redacta commit/PR/comentarios desde un diff ya aprobado — mecánico. |
| `scribe` | `haiku` | `low` | Serializa evidencia ya verificada a Markdown — mecánico, igual que publisher. |

## Effort sigue la misma lógica

`effort.<agent>` es la otra palanca del mismo eje: modelo caro + effort alto significa
más tokens de razonamiento y más tool calls por invocación. Un agente mecánico en
`sonnet`/`low` sigue siendo más barato en agregado que el mismo agente en `opus`/`xhigh`
corriendo N veces por sesión (ej. un `scout` por sub-mapa en un fan-out). El
`effort` de `orchestrator` además siembra `effortLevel` de `settings.json`, porque ese rol
es el agente principal — no se spawnea como subagente, así que no hay otro punto
donde fijar su tier.

## Codex

Codex resuelve modelo y esfuerzo de forma independiente. Los defaults por familia son
Opus → Sol, Sonnet → Luna y Haiku → Luna; `models.codexMap` puede cambiar el valor de cada
tier a otra familia o a un ID completo. Un ID completo, como `gpt-6-sol`, es un pin; una
familia como `sol`, `luna` o `astra` busca la versión numérica más alta compatible del
catálogo local de Codex, por ejemplo `gpt-6.1-sol`.

El esfuerzo de Claude solo alimenta esta resolución de Codex: Sonnet con `medium` pasa a
`high`, incluso cuando el modelo viene de un pin o de `codexMap`. Los demás esfuerzos se
conservan (`Sonnet low` sigue en `low`, y `Sonnet high` en `high`). Un override explícito
por agente prevalece en su campo correspondiente.

Se pueden definir overrides por nombre TOML nativo en `models.codexProfiles`. Las claves
deben ser los nombres exactos, como `implementer`; `orchestrator` está reservado para el
agente principal y usa `.codex/config.toml`. Cada registro puede fijar `model`, `effort` o
ambos sin que uno sustituya al otro:

```json
{
  "models": {
    "codexProfiles": {
      "orchestrator": { "model": "gpt-6.1-sol", "effort": "xhigh" },
      "implementer": { "model": "luna", "effort": "medium" }
    }
  }
}
```

El inventario considera el principal y los agentes Codex habilitados, además de los TOML
nativos del proyecto que no administra navori. Esos archivos se leen dentro del checkout;
los archivos locales del usuario no se reescriben. El render expresa intención administrada
para futuros inicios y conserva campos del usuario, valores más nuevos de la misma familia
y TOML de agentes que pertenecen al usuario.

Una entrada de `models_cache.json` solo aporta candidatos. La frescura es `unknown` si no
hay fuente, timestamp y contexto verificados externamente; si falta el catálogo, está
malformado o no contiene entradas compatibles, el estado es `degraded`. El cache, su mtime
y sus slugs no prueban disponibilidad actual. `configured`, candidato a render y `observed`
son estados distintos: sin observación ligada al contexto iniciado, el resultado efectivo
permanece desconocido y la aplicación queda `pending`, con el remedio de iniciar un contexto
Codex nuevo y verificar ahí modelo y esfuerzo. No se afirma equivalencia de calidad entre
modelos.

Pi conserva su consumidor explícito de `codexMap`, que solo resuelve el modelo; la
transformación de esfuerzo y los overrides nombrados se limitan a Codex. Los perfiles de
Claude permanecen sin cambios.

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
