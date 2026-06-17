# Recipe — autoría de SKILL.md en navori

> Convención para escribir skills que navori bundlea (core, presets, plugins).
> Implementa spec 0003 §3.2.1 (output discipline) y §3.2.2 (triggers).
> Enforced por `packages/cli/src/lib/__tests__/skill-caps.test.ts`.

## Frontmatter

```yaml
---
name: nextjs-app-router
description: Reglas para Next.js App Router — Server vs Client Components. Aplica antes de tocar app/.
type: reference
# maxWords: 520   # opcional — override del cap del tipo
---
```

| Campo | Requerido | Qué es |
|---|---|---|
| `name` | sí | id de la skill (kebab-case). |
| `description` | sí | una línea con **trigger de activación** (ver abajo). |
| `type` | sí | `behavior` \| `reference` \| `tool`. |
| `maxWords` | no | sube el cap del tipo cuando la longitud está justificada. |

## Caps por tipo

El body (todo lo que sigue al frontmatter) tiene un cap de palabras. Los tokens
se gastan cada vez que la skill se carga, así que se mantienen ajustadas.

| Tipo | Cap | Cuándo |
|---|---|---|
| `behavior` | ≤200 | dicta cómo actúa el agente (ej. `verify-before-done`). |
| `reference` | ≤500 | documenta un patrón/stack (ej. `mantine-ui-patterns`). |
| `tool` | ≤300 | envuelve una herramienta externa. |

Si una skill excede su cap el test falla. Para excederlo a propósito, declará
`maxWords: N` — el override es explícito, no silencioso. Hoy lo usan
`loop-back-debug` y `verify-before-done` (behavior de protocolo, ~970-980
palabras) y `astro-islands` (509).

## Triggers en `description`

Claude Code carga una skill **on-demand** leyendo su `description`. Una
description sin trigger queda always-on o no se activa cuando debería. Incluí
un verbo de activación:

- ✅ `Aplica antes de tocar src/api/.`
- ✅ `Usar cuando definas contratos HTTP.`
- ✅ `Use when the user edits app/.`
- ❌ `Reglas de Medusa.` (sin trigger)

El test acepta los verbos comunes es/en (`Aplica`, `Usar`, `cuando`,
`antes de`, `Use when/this`).

## Qué NO se hace en v0.2

- **Variantes inline filtrables** (skills con modos) — documentado como recipe
  aparte para v0.3; no hay caso real todavía (spec 0003 §3.2.3).
