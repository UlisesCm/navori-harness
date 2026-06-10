# Spec 0002 — Claude engine adapter: agents + skills + hooks + settings + scripts

**Status:** proposed
**Date:** 2026-06-10
**Driver:** Ulises Ciprés
**Validation case:** `~/Documents/dev/moonar/moonar-medusa-monorepo` (caso real con config v1, generación incompleta del harness)
**Depends on:** [Spec 0001](./0001-monorepo-render-per-workspace.md) — ortogonal, esta spec asume render single-workspace

## Problema

`navori.config.json` declara `engines: ["claude"]`, `harness.*`, `models.*`, `skills.*`, `sdd.*`, `progress.*`, `qualityGate.{fast,full}` y `plugins{}`. El render actual (`packages/cli/src/commands/render.ts`) solo consume `plugins` y los 4 bloques core hardcoded, y escribe **solo a `CLAUDE.md`**.

Resultado en `moonar-medusa-monorepo`: el config completo declara harness, plugins y qualityGate, pero el render produce 10 bloques managed en `CLAUDE.md` y **nada más**. No hay `.claude/agents/`, `.claude/skills/`, `.claude/settings.json`, `.claude/hooks/` ni `.claude/scripts/`. Los `models.*` y `harness.*` son no-ops. `qualityGate` queda en el config sin materialización ejecutable.

## Casos de uso primarios

1. **Fresh install** — repo sin `.claude/` previo. Usuario corre `navori init` + `navori render` y obtiene harness completo y reproducible.
2. **Replace install** — repo con `.claude/` previo (a mano o de otro generador). Usuario elige `replace` en `init`, navori respalda todo a `~/.navori/migrations/<ts>/` y arranca limpio.
3. **Coexistencia ligera** (secundario) — modo `coexist` ya existe en `init` y skipea render. No requiere trabajo adicional en esta spec.

## Modelo de diseño: managed + user-section

Cada archivo generado (excepto `settings.json` y core JSON) tiene **dos zonas**:

1. **Zona managed (`navori-base`)** — bloque inamovible delimitado por marcadores. Idéntica byte-a-byte en TODAS las instalaciones que comparten preset + plugins. `sync` la reconstruye desde el bundle; el usuario nunca la edita (o si lo hace, queda en estado conflict y `sync` se rehúsa hasta resolver).
2. **Zona user (`user-base`)** — área libre fuera del bloque managed. El usuario escribe lo específico de su proyecto (paths legacy, anti-patterns del stack, reglas de equipo). Navori jamás la pisa.

Este modelo ya funciona para `CLAUDE.md` (10 bloques managed + texto libre alrededor). Esta spec lo extiende a agents, skills y hooks/scripts.

```md
---
name: leader
description: ...
model: opus
---

<!-- navori:managed id="leader-base" hash="..." version="0.0.1" source="@navori/core" -->
# Agente Líder — base navori
... contenido fijo idéntico en todas las instalaciones ...
<!-- /navori:managed id="leader-base" -->

## Reglas del proyecto
<!-- user: agregá acá lo específico de tu repo -->
```

### Preguntas base — bootstrap inicial de la user-section

`init` ejecuta una capa adicional de prompts (después de la preview-edit existente) que recolectan datos estructurales del proyecto. Las respuestas:

- Se persisten en `navori.config.json` (nuevos campos del schema, ver § Schema cambios).
- Se interpolan via `{{config.path.to.value}}` (mecanismo ya implementado en `render-plan.ts:44`) en plantillas que pueblan la user-section inicial de agents/skills.
- Después de init, el usuario puede editar libremente la user-section materializada — navori no la re-genera (no hay `sync` de user-section).

Ejemplos de preguntas base:
- "¿Qué carpetas considerás legacy?" → `project.legacyPaths[]`
- "¿Cuáles son las áreas críticas que requieren review extra?" → `project.criticalAreas[]`
- "¿Cuál es tu test runner?" → `project.testRunner`
- (Las que aporte cada plugin via `plugin.json#prompts[]`)

## Decisiones tomadas (DT-1 a DT-6)

### DT-1 — Markers en archivos shell (hooks, scripts)

**Decisión:** usar markers shell `# navori:managed start ...` / `# navori:managed end`.

```sh
#!/bin/bash
# navori:managed start id="quality-gate-fast" hash="abc123" version="0.0.1" source="@navori/core"
${QUALITY_GATE_FAST}
# navori:managed end id="quality-gate-fast"

# user: agregá tus checks adicionales abajo
```

**Por qué:** coherente con CLAUDE.md, permite user-section libre. Requiere extender `marker.ts` con un parser/inyector adicional que reconoce `#`-comments además de `<!-- -->`. La función `injectManagedSection` recibe un nuevo parámetro `commentStyle: "html" | "shell"`.

### DT-2 — `.claude/settings.json` navori-owned completo

**Decisión:** navori escribe el archivo completo en cada render. El usuario nunca lo edita. Per-user / per-machine permissions van a `settings.local.json` (gitignored, navori NO lo toca).

**Por qué:** JSON no soporta comentarios estándar; markers JSON sería frágil. `settings.local.json` ya es el escape válido del lado de Claude Code. Si en el futuro hace falta extensión, sale en spec aparte como `settings.user-extra.json` mergeado en render.

**Detección de overwrite peligroso:** si existe `.claude/settings.json` sin un marcador `"$navori": { "managed": true, "version": "..." }` en el top-level, render NO escribe y aborta con un mensaje pidiendo correr `init` en modo `replace` o agregar el marcador manualmente. Esto protege harnesses preexistentes.

### DT-3 — Granularidad de bloques managed en agents/skills

**Decisión:** un bloque grande por agent/skill por default (`id="leader-base"`). Soporte opt-in para sub-bloques cuando un plugin necesite agregar su pieza al agent (`id="leader-protocol-engram"`).

**Por qué:** el 95% de los agents tienen un único bloque base estable. Sub-bloques son necesarios solo cuando un plugin (ej. engram) extiende un agent (leader) con su contribución específica. Schema soporta ambos:

```json
// plugin.json
{
  "skills": [{
    "id": "engram-protocol-leader",
    "file": "skills/engram-protocol-leader.md",
    "injectInto": ".claude/agents/leader.md",   // opcional — si está, es sub-bloque
    "recommendedAgent": "leader"
  }]
}
```

### DT-4 — Forma de las "preguntas base"

**Decisión:** declaradas en JSON, tanto en `@navori/core/core-assets/prompts.json` (genéricas) como en cada `plugin.json#prompts[]` (específicas del plugin).

```json
// @navori/core/core-assets/prompts.json
{
  "prompts": [
    {
      "key": "project.legacyPaths",
      "question": { "es": "¿Qué carpetas considerás legacy?", "en": "Which folders are legacy?" },
      "type": "string-list",
      "placeholder": "ej: src/legacy, lib/old"
    },
    {
      "key": "project.criticalAreas",
      "question": { "es": "¿Qué áreas requieren review extra?", "en": "Which areas need extra review?" },
      "type": "string-list",
      "optional": true
    }
  ]
}
```

**Por qué:** el core lleva las genéricas (paths, áreas, test runner); los plugins suman las suyas (engram → "¿qué proyecto en engram?", semgrep → "¿reglas custom?"). El wizard de init las recolecta secuencialmente después del preview-edit loop.

### DT-5 — Identidad del proyecto: dónde se persiste

**Decisión:** campos nuevos en `navori.config.json` (extiende schema). Render las interpola en las plantillas via `{{config.project.X}}`.

```json
// navori.config.json
{
  "project": {
    "legacyPaths": ["src/legacy"],
    "criticalAreas": ["src/auth", "src/billing"],
    "testRunner": "vitest"
  }
}
```

**Por qué:** el config es la source-of-truth; cualquier cambio en estos campos debería propagar a la próxima generación de plantillas. Como las plantillas pueblan la user-section una sola vez, los cambios posteriores requieren editar el archivo destino directamente (acepto el tradeoff).

### DT-6 — Navegación atrás en el wizard

**Decisión (parcial cumplida en A.5):** preview-y-editar final cubre el caso real "me equivoqué en algún campo". Para esta spec NO se agrega "← atrás" granular por step; el preview loop ya cubre el 80% del caso.

**Pendiente:** si las preguntas base de DT-4 son numerosas (>5), agregar un sub-preview-loop específico para ellas antes del save.

## Schema cambios

### `NavoriConfigSchema` (extensión)

```ts
const ProjectSchema = z.object({
  legacyPaths: z.array(z.string()).default([]),
  criticalAreas: z.array(z.string()).default([]),
  testRunner: z.string().optional(),
  // Plus campos arbitrarios que aporten plugins via prompts
}).passthrough();

export const NavoriConfigSchema = z.object({
  // ... existentes ...
  project: ProjectSchema.optional(),
}).passthrough();
```

### `PluginManifestSchema` (extensión)

```ts
const HookEntrySchema = z.object({
  event: z.enum(["PreToolUse", "PostToolUse", "Stop"]),
  matcher: z.string().optional(),     // regex Claude Code para tool name
  command: z.string(),                // shell command
  timeout: z.number().int().positive().optional(),
  statusMessage: z.string().optional(),
});

const ScriptEntrySchema = z.object({
  src: z.string(),                    // path relativo dentro del plugin
  dest: z.string(),                   // path relativo dentro de .claude/scripts/
  exec: z.boolean().default(true),    // chmod +x al copiar
});

const SkillEntrySchema = z.object({
  id: z.string(),
  file: z.string(),
  recommendedAgent: z.enum(AGENT_ROLES).optional(),
  injectInto: z.string().optional(),  // si está, es sub-bloque managed dentro de ese archivo
});

const PromptEntrySchema = z.object({
  key: z.string().regex(/^[a-z][a-zA-Z0-9_.]*$/, "key debe ser config path"),
  question: z.object({ es: z.string(), en: z.string() }),
  type: z.enum(["string", "string-list", "boolean", "number"]),
  placeholder: z.string().optional(),
  optional: z.boolean().default(false),
});

const PluginManifestSchema = z.object({
  // ... existentes ...
  settingsFragment: z.record(z.unknown()).optional(),
  hooks: z.array(HookEntrySchema).optional(),
  scripts: z.array(ScriptEntrySchema).optional(),
  skills: z.array(SkillEntrySchema).optional(),
  prompts: z.array(PromptEntrySchema).optional(),
});
```

Todos los campos nuevos son opcionales — plugins existentes (`engram`, `gh`, etc.) siguen funcionando sin tocarlos.

## Componentes a tocar

### Nuevos archivos

- `packages/cli/src/engines/claude.ts` — engine adapter principal. Orquesta render de agents, skills, hooks, scripts, settings, progress.
- `packages/cli/src/engines/index.ts` — registry de engines (solo `claude` por ahora).
- `packages/cli/src/lib/shell-marker.ts` — versión de `marker.ts` para comentarios `#`.
- `packages/cli/src/lib/prompts-loader.ts` — carga `prompts.json` del core + de plugins habilitados.
- `packages/core/core-assets/agents/{leader,implementer,reviewer,researcher,ticket-audit,commit-pr-pilot,explorer}.md` — 7 plantillas de agents con bloque managed + user-section placeholder.
- `packages/core/core-assets/skills/{verify-before-done,loop-back-debug}.md` — 2 skills genéricas con managed + user.
- `packages/core/core-assets/hooks/quality-gate-pre-commit.sh` — hook template.
- `packages/core/core-assets/settings/settings-base.json` — base de `.claude/settings.json`.
- `packages/core/core-assets/prompts.json` — preguntas base genéricas.

### Archivos a modificar

- `packages/cli/src/commands/render.ts` — invocar engine adapter en lugar de solo `computeRenderPlan` para CLAUDE.md.
- `packages/cli/src/commands/init.ts` — agregar capa de preguntas base después del preview-edit loop.
- `packages/cli/src/lib/schema.ts` — añadir `project` (DT-5).
- `packages/cli/src/lib/plugins.ts` — extender `PluginManifestSchema` (DT-1 a DT-4).
- `packages/cli/src/lib/marker.ts` — refactor para soportar `commentStyle: "html" | "shell"` (DT-1).
- `packages/cli/src/lib/backup.ts` — backup recursivo de `.claude/` excluyendo `settings.local.json` y `progress/`.
- `packages/cli/src/commands/doctor.ts` — reportar drift de agents/skills via version frontmatter.
- `packages/plugins/{jscpd,semgrep,gh,engram}/plugin.json` — declarar sus hooks/scripts/skills.
- `packages/plugins/{jscpd,semgrep}/scripts/check-*.sh` — los scripts que hoy bonum-dashboard tiene a mano.

## Plan de commits (Tanda C → G)

| # | Commit | Toca | Riesgo |
|---|---|---|---|
| C1 | `feat(schema): extender PluginManifestSchema (settingsFragment, hooks, scripts, skills, prompts) + project en NavoriConfig` | `plugins.ts`, `schema.ts` + tests | bajo |
| C2 | `feat(marker): soportar comentarios shell (# navori:managed start/end)` | `marker.ts`, `shell-marker.ts` + tests | bajo |
| D1 | `feat(core): plantillas para 7 agents con bloque managed + user-section` | `core-assets/agents/*.md` | bajo |
| D2 | `feat(core): skills genéricas (verify-before-done, loop-back-debug)` | `core-assets/skills/*.md` | bajo |
| D3 | `feat(core): plantillas de settings base + hook qualityGate-pre-commit + prompts.json` | `core-assets/{settings,hooks,prompts.json}` | bajo |
| E1 | `feat(cli): engine adapter Claude — escribe .claude/ completo con backup` | nuevo `engines/claude.ts`, `engines/index.ts` + cambios en `render.ts` | **alto** |
| E2 | `feat(cli): inicializar progress/current.md + progress/history.md si no existen` | `engines/claude.ts` | bajo |
| E3 | `feat(cli): backup extendido — cubrir .claude/ excluyendo settings.local + progress` | `backup.ts` | medio |
| E4 | `feat(init): preguntas base post preview-edit con interpolación al config` | `init.ts`, `prompts-loader.ts` | medio |
| F1 | `feat(plugins): jscpd + semgrep declaran sus hooks + scripts (check-*.sh portados de bonum-dashboard)` | `plugins/jscpd/`, `plugins/semgrep/` | medio |
| F2 | `feat(plugins): gh + engram declaran sus settingsFragment + skills` | `plugins/gh/`, `plugins/engram/` | bajo |
| G1 | `feat(doctor): reportar drift de agents/skills via version frontmatter` | `doctor.ts` | bajo |

Cada commit es verde por sí solo (tests propios). El usuario verá cambios reales en lo que se renderiza a partir de **E1**.

## Tests por agregar

| Test | Cubre |
|---|---|
| `engines/claude.test.ts` | snapshot del árbol generado para un config completo |
| `shell-marker.test.ts` | inject/remove en scripts shell, idempotencia |
| `plugins.test.ts` | parser acepta los 5 campos nuevos opcionales y rechaza shape inválido |
| `backup.test.ts` | backup de `.claude/` excluye `settings.local.json` y `progress/` |
| `prompts-loader.test.ts` | merge de prompts del core + plugins habilitados |
| Extensión `cli.e2e.test.ts` | `init --recommended` produce estructura `.claude/` esperada |
| Extensión `cli.e2e.test.ts` | segundo `render` sin cambios = idempotente (no overwrites, no backups extra) |

## Riesgos identificados

| Riesgo | Mitigación |
|---|---|
| Pisar `.claude/settings.json` preexistente | DT-2: detección via marcador `"$navori"`, render aborta si no está |
| Hook con `jq` no portátil a Windows | hook template documenta requirement; doctor reporta `jq` ausente |
| Drift silencioso de agents post-bootstrap | version frontmatter + doctor (commit G1) |
| Plugin malicioso con `scripts.dest` fuera de `.claude/` | mismo containment check que `managed.file` actual en `plugins.ts:131` |
| User edita zona managed por error | `sync` detecta hash drift y marca conflict (mecanismo existente para CLAUDE.md) |
| Backup gigante en repos con muchos agents/skills | `backup.ts` limita retención (commit E3) |

## Out of scope (entregas posteriores)

- Engine adapters non-Claude (`agents-md`, `cursor`, `copilot`).
- SDD (`sdd.applyWhen` + `specs/` generation).
- Monorepo workspaces (spec 0001 — ortogonal).
- Presets reales con cascada (`preset` como string libre por ahora).
- `agentAssignments` consumer (hoy se persiste pero no afecta render).
- `settings.user-extra.json` extension (si hace falta, spec aparte).
- Markers user-section editables (hoy es texto libre, no rastreado).

## Caso de validación: moonar-medusa-monorepo

Config target después de E4:

```json
{
  "name": "moonar",
  "engines": ["claude"],
  "preset": "monorepo-turbopnpm",
  "language": "es",
  "branchBase": "main",
  "commits": "conventional-es",
  "qualityGate": {
    "fast": "pnpm run typecheck",
    "full": "pnpm run typecheck && pnpm run lint && pnpm run test:unit"
  },
  "harness": {
    "leader": true,
    "implementer": true,
    "reviewer": true,
    "researcher": false,
    "ticketAudit": false,
    "commitPrPilot": false,
    "explorer": false
  },
  "models": { "leader": "opus", "implementer": "sonnet", "reviewer": "opus" },
  "plugins": {
    "cognitive": { "enabled": true },
    "engram": { "enabled": true },
    "gh": { "enabled": true },
    "jscpd": { "enabled": true },
    "semgrep": { "enabled": true }
  },
  "project": {
    "legacyPaths": [],
    "criticalAreas": ["apps/backend/src/api", "apps/storefront/src/checkout"],
    "testRunner": "vitest"
  }
}
```

`render` produce:

```
CLAUDE.md                                        (managed blocks + user-section)
.claude/
  settings.json                                  (navori-owned, hooks de qualityGate + jscpd + semgrep)
  settings.local.json                            (NO tocado — del usuario)
  agents/
    leader.md                                    (managed leader-base + sub-bloques de engram/gh + user-section)
    implementer.md
    reviewer.md
  skills/
    verify-before-done.md                        (core)
    loop-back-debug.md                           (core)
  hooks/
    quality-gate-pre-commit.sh                   (managed + user-section)
  scripts/
    check-jscpd.sh                               (de plugin jscpd)
    check-semgrep.sh                             (de plugin semgrep)
progress/
  current.md                                     (vacío con header — solo si no existía)
  history.md                                     (vacío con header — solo si no existía)
```

## Open questions

1. **Sub-bloques managed en agents (DT-3)**: ¿el orden de inserción es determinístico cuando 2 plugins inyectan al mismo agent? Propuesta: orden alfabético del plugin id, documentado.
2. **Modelos por agent (`models.*`)**: ¿Claude Code soporta `model: opus` en frontmatter del agent en la versión actual? Verificar antes de E1; si no, fallback a settings.json sección agents (cuando exista).
3. **Hooks `Stop`**: el `qualityGate.full` ¿debería materializarse como hook `Stop` o solo como protocolo en el agent? Propuesta: hook `Stop` opcional (default off) controlado por flag en config.
