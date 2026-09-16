# Recipe — autoría de SKILL.md en navori

> El contrato de un archivo de skill: frontmatter, tipos, caps y triggers.
> Implementa spec 0003 §3.2.1 (output discipline) y §3.2.2 (triggers).
> Enforced por `packages/cli/src/lib/__tests__/skill-caps.test.ts` sobre los assets que
> navori bundlea (core, presets, plugins).
>
> **Dónde va tu skill** —core, preset, plugin o project-local— es otra pregunta, y se
> responde en [`../EXTENDING.md`](../EXTENDING.md). Este doc asume que ya la decidiste.

## Dónde vive el archivo

Una sola forma, porque es la única que el host descubre: un **directorio** con su `SKILL.md`.

```
.claude/skills/<id>/SKILL.md
```

Con esa estructura la skill queda cargable desde el primer momento. La forma plana (`<id>.md`
suelto en la raíz de `skills/`) pertenece a `.claude/commands/`, que es otra feature. Vale igual
para las skills que navori renderiza y para las tuyas.

## Frontmatter

```yaml
---
name: nextjs-app-router
description: Reglas para Next.js App Router — Server vs Client Components. Aplica antes de tocar app/.
type: reference
# maxWords: 520           # opcional — override del cap del tipo
# maxWordsComposed: 700   # opcional — techo del archivo YA compuesto (ver abajo)
---
```

| Campo | Requerido | Qué es |
|---|---|---|
| `name` | sí | id de la skill (kebab-case). |
| `description` | sí | una línea con **trigger de activación** (ver abajo). |
| `type` | sí | `behavior` \| `reference` \| `tool`. |
| `maxWords` | no | sube el cap del tipo cuando la longitud está justificada. |
| `maxWordsComposed` | no | techo del archivo compuesto, cuando un plugin la extiende. |

## Caps por tipo

El body (todo lo que sigue al frontmatter) tiene un cap de palabras. Los tokens se gastan cada
vez que la skill se carga, así que se mantienen ajustadas.

| Tipo | Cap | Cuándo |
|---|---|---|
| `behavior` | ≤200 | dicta cómo actúa el agente (ej. `verify-before-done`). |
| `reference` | ≤500 | documenta un patrón/stack (ej. `mantine-ui-patterns`). |
| `tool` | ≤300 | envuelve una herramienta externa. |

Si una skill excede su cap, el test falla. Para excederlo a propósito declara `maxWords: N` — el
override es explícito, no silencioso, y **lleva escrita la razón en un comentario** junto al campo.
Varios assets del core lo usan hoy; para verlos, `grep -rn '^maxWords:' packages/core/core-assets
packages/plugins`.

### `maxWordsComposed` — el archivo que la sesión realmente carga

`maxWords` es el presupuesto del **autor del asset**: lo que ese archivo argumenta por sí solo, y
esa razón no debe evaporarse porque un plugin le anexó una sección. `maxWordsComposed` es lo que
**paga la sesión**: el `SKILL.md` final, con cada extensión de plugin ya inyectada y los valores
del proyecto ya interpolados.

Declararlo sólo aplica a una skill que algo extiende (`injectInto`). Cuando nada la extiende, el
archivo compuesto **es** el asset y `maxWords` ya mide lo correcto. Ejemplo real: `review-diff`
declara `maxWords: 1200` y `maxWordsComposed: 1450` — 1200 del núcleo, 200 de la extensión de
`jscpd`, más margen para los `project.criticalAreas` que el render interpola dentro del bloque.

## Triggers en `description`

El host carga una skill **on-demand** leyendo su `description` y decidiendo si la situación
encaja. Ese trigger es lo que la pone a trabajar sola en el momento justo, así que es la línea de
mayor retorno del archivo: incluye un verbo de activación y la skill se activa cuando toca.

- ✅ `Aplica antes de tocar src/api/.`
- ✅ `Usar cuando definas contratos HTTP.`
- ✅ `Use when the user edits app/.`
- ↗ `Reglas de Medusa.` → gana con un `Aplica cuando toques src/modules/.`
- ↗ `Automate browser interactions and test web pages.` → dice qué hace; súmale el cuándo

Se aceptan los verbos comunes es/en (`Aplica`, `Usar`, `cuando`, `antes de`, `Use when/this`): los
assets de navori se escriben en inglés, pero una skill tuya se escribe en tu idioma.

El trigger también es lo que se imprime en el índice "Skills disponibles" de `CLAUDE.md` — se
condensa a la primera cláusula y se corta a 120 caracteres, así que ponlo al principio.

## Piezas opcionales: fallback declarado

Si tu skill depende de algo que puede faltar en la máquina —un binario externo, un MCP,
memoria persistente—, escribe en el propio archivo qué hacer cuando no está, no asumas que
siempre va a estar. Sin eso, la falta de la pieza se reporta como "no encontré nada" en vez
de "no pude buscar" — el anti-patrón "silent skipping" (#824): un canal caído no es lo mismo
que cero resultados, y confundirlos produce un falso negativo. `structural-search` es el
ejemplo: Rung 0 se salta limpio sin memoria persistente y Rung 2 cae a `Grep` si `ast-grep`
no está instalado — cada rung nombra su propio escalón de degradación en vez de darlo por
sentado.

## Skills project-local

Una skill que escribes en tu repo (`project.localSkills`) sigue el **mismo contrato de archivo**,
con dos diferencias:

- **navori nunca la toca.** No lleva bloque managed ni user-section: el archivo es tuyo entero.
- **Los caps quedan a tu criterio** — `skill-caps.test.ts` audita los assets bundleados. Siguen
  siendo la referencia correcta, porque quien cobra esos tokens es tu propia sesión.

`navori doctor` las acompaña con dos avisos accionables: que el id declarado tenga su archivo
(`missingLocalSkills`) y que la `description` lleve trigger (`triggerlessSkills`). Son
sugerencias, no bloqueos — nunca cambian el veredicto.
