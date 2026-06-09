# navori-ai — Design Doc

> Paquete npm para replicar harness multi-agente + SDD en múltiples proyectos con soporte multi-engine (Claude Code, AGENTS.md universal, Cursor, Copilot).

---

## 1. Motivación

Actualmente el setup de harness (`.claude/AGENTS.md`, `agents/{leader,implementer,reviewer}.md`, `CHECKPOINTS.md`, `progress/`) + SDD (`specs/<feature>/{requirements,design,tasks}.md`) está hecho a mano por repo. Replicarlo en proyectos nuevos cuesta ~20 min y diverge con el tiempo (drift entre repos).

**Objetivo**: un solo comando que scaffoldee la infraestructura, permita actualizaciones controladas (`sync`), y se adapte al stack/workspace sin perder customizaciones.

**No-objetivo**: ser un framework runtime. Es un scaffolder + sincronizador, no una librería que corre código en producción.

---

## 2. Modelo mental: 5 capas

```
┌─────────────────────────────────────────────┐
│ 5. Engine adapters → .claude/ + AGENTS.md   │  ← OUTPUT (render)
├─────────────────────────────────────────────┤
│ 4. Project config (navori.config.json)      │  ← respuestas del init
├─────────────────────────────────────────────┤
│ 3. Workspace global (~/.navori/bonum.json)  │  ← reglas compartidas
├─────────────────────────────────────────────┤
│ 2. Stack preset (vite-react, nestjs, ...)   │  ← defaults por stack
├─────────────────────────────────────────────┤
│ 1. Core (universal harness primitives)      │  ← agentes, SDD, CHECKPOINTS
└─────────────────────────────────────────────┘
```

Cada capa superior **override** a la inferior. Customizaciones del usuario se preservan en `sync` mediante marcadores `<!-- navori:managed -->`.

### Capa 1 — Core (universal, engine-agnostic)

Primitives que no cambian entre stacks ni engines:

- `agents/{leader,implementer,reviewer,researcher,ticket-audit,commit-pr-pilot,explorer}.md` — prompts genéricos de roles, cada uno con frontmatter `model:` y `tools:` declarados
- `CHECKPOINTS.md` — template de checkpoints de calidad C1-C5 con greps auditables
- `specs/<feature>/{requirements,design,tasks}.md` — EARS template (R1, R2…)
- Convención `progress/<tipo>_<feature>.md` — anti-teléfono-descompuesto entre subagentes (subagente escribe a disco, devuelve `done -> <path>` en una línea)
- `progress/current.md` con secciones libres (Plan, Bitácora, Quality gate, Próximo paso) como estado primario de sesión
- Slash commands `/session:save` y `/session:resume` — checkpoint formal opt-in: generan `progress/checkpoints/<timestamp>_<slug>.md` con campos estructurados (state, phase, next_steps, blockers) cuando el usuario lo pide explícitamente. El día a día usa `current.md` libre; el checkpoint formal es para sesiones largas con interrupciones esperadas
- `AGENTS.md` como mapa de navegación con divulgación progresiva (tabla "Archivo | Cuándo leerlo")
- Hook `Stop` con `init.sh --fast` por default; quality gate completo opt-in
- Defaults de model routing por rol (override en cascada Preset → Workspace → Project):
  - `leader: opus` — razonamiento arquitectural
  - `implementer: sonnet` — balanceado
  - `reviewer: sonnet` — adversarial framing ("Do NOT trust the implementer. Verify independently.")
  - `researcher: haiku` — read-only, paralelizable
  - `ticket-audit: opus` — análisis profundo pre-implementación
  - `commit-pr-pilot: haiku` — mecánico
  - `explorer: haiku` — read-only
- Vocabulario de 4 estados de subagente: `DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT`
- Reglas universales: simplicidad > cleverness, commits atómicos, no commitear `.claude/`

### Capa 2 — Stack preset

Defaults por tecnología. Cada preset incluye:

- Tabla de naming (página, componente, adapter, service, hook, slice)
- Path aliases típicos
- Quality gate command sugerido (`pnpm tsc --noEmit && bun run lint`)
- "No hardcode" rules específicas (env vars, formato de fechas, URLs)
- Skeleton de secciones del `CLAUDE.md`

Presets iniciales:
- `vite-react-ts-mantine` (frontend Bonum dashboard/webapp)
- `nestjs-mongoose` (bonum-nexus)
- `express-microservice` (services--*)
- `nextjs` (bonum-ai-coach-frontend)
- `react-native-expo` (bonum--mobile--app)
- `custom` (sin preset, todo manual)

### Capa 3 — Workspace global

`~/.navori/workspaces/<nombre>.json` — reglas compartidas entre repos del mismo workspace.

Para Bonum:
- Diccionario de proyectos (paths, stacks, qué hace cada uno)
- Convenciones cross-repo (Jira via `acli`, idioma chat ES-MX / código EN, branch base)
- Variables `VITE_APP_*_URL` → servicio
- Plugins siempre activos (engram, acli)

Evita reescribir `~/.claude/CLAUDE.md` para cada repo nuevo.

### Capa 4 — Project config

`navori.config.json` checked-in al repo. **Fuente de verdad**: `render` reconstruye todo desde acá.

```json
{
  "name": "bonum-newrepo",
  "workspace": "bonum",
  "engines": ["claude", "agents-md"],
  "preset": "vite-react-ts-mantine",
  "qualityGate": "pnpm tsc --noEmit && bun run lint",
  "branchBase": "main",
  "commits": "conventional-es",
  "sdd": true,
  "harness": { "leader": true, "implementer": true, "reviewer": true },
  "plugins": ["engram", "acli", "deep-research"]
}
```

### Capa 5 — Engine adapters

Misma config → outputs distintos según engine.

Un solo `leader.md` core se materializa como:
- `.claude/agents/leader.md` (formato Claude Code)
- Sección en `AGENTS.md` (estándar emergente que Gemini/Cursor/Codex leen)
- `.cursor/rules/leader.mdc` (formato Cursor)
- `.github/copilot-instructions.md` (formato Copilot)

---

## 3. Comandos

| Comando | Propósito |
|---|---|
| `init` | Scaffold inicial interactivo |
| `add <plugin\|skill\|preset>` | Agregar módulo después (ej. `add semgrep`) |
| `remove <plugin>` | Quitar módulo limpio |
| `sync` | Pull updates del paquete sin pisar customizaciones (3-way merge) |
| `render` | Re-generar outputs por engine desde `navori.config.json` |
| `doctor` | Verifica quality gate corre, deps de plugins (engram, acli en PATH) |
| `preset list \| apply <name>` | Gestionar presets de stack |
| `workspace init <name>` | Crear/editar reglas globales compartidas |

---

## 4. Flujo `init` (UX propuesto)

```
$ npx navori-ai init

? Nombre del proyecto: bonum-newrepo
? Workspace al que pertenece: bonum (heredar global.json)
? Engines a generar: [multi-select]
  ◉ Claude Code (.claude/)
  ◉ AGENTS.md (universal — Gemini/Codex/Cursor lo leen)
  ◯ Cursor (.cursor/rules/)
  ◯ Copilot (.github/copilot-instructions.md)
? Stack preset:
  ❯ vite-react-ts-mantine
    nestjs-mongoose
    express-microservice
    nextjs
    react-native-expo
    custom
? Quality gate command: pnpm tsc --noEmit && bun run lint
? Branch base: main
? Convención de commits: conventional-es
? Activar SDD (specs/<feature>/{requirements,design,tasks}.md)? Sí
? Activar multi-agent harness (leader/implementer/reviewer)? Sí
? Plugins requeridos: [multi-select]
  ◉ engram         (memoria persistente)
  ◉ acli           (Jira CLI)
  ◯ semgrep        (security gate local)
  ◯ frontend-design
  ◉ deep-research

✓ .claude/ generado
✓ AGENTS.md generado
✓ CLAUDE.md creado con placeholders {{NAMING}}, {{FLOW_DATOS}}
✓ navori.config.json guardado
✓ Plugins instalados/verificados (doctor sugiere `brew install acli`)
```

---

## 5. Plugins como bundles

Cada plugin = paquete con 4 piezas opcionales:

```
plugins/engram/
├── settings.fragment.json    # se merge a settings.json
├── claude-md.block.md        # se inserta en CLAUDE.md sección Engram
├── skill.md                  # skill que se copia a .claude/skills/
├── hook.sh                   # opcional (SessionStart, etc.)
└── doctor.sh                 # verifica que esté instalado/funcional
```

Activar `engram` en un repo nuevo: `navori-ai add engram` → queda **idéntico** al de los demás.

Plugins iniciales:
- `engram` — memoria persistente
- `acli` — Jira CLI (lecturas)
- `semgrep` — security gate local opt-in
- `frontend-design` — skill de diseño UI distintivo
- `deep-research` — skill de investigación multi-source
- `verify` — verificación E2E manual
- `code-review` — review estructurado del diff
- `ticket-state-machine` — opt-in para reanudabilidad estricta en sesiones largas. Reemplaza `progress/current.md` libre por una FSM formal (`idle → triage → analysis → research → planning → impl → review → pr-ready → done`, con `blocked` como modifier). Solo instalar en proyectos donde la reanudabilidad sea dolor crónico.

---

## 6. Multi-engine: estrategia

**Source of truth**: `navori.config.json` + plantillas en el paquete.

**Render targets**:
- `.claude/` (Claude Code)
- `AGENTS.md` (estándar emergente — Gemini, Codex, Cursor lo leen)
- `.cursor/rules/` (Cursor nativo)
- `.github/copilot-instructions.md` (Copilot)

`navori-ai render` re-genera todos los outputs desde la config. Si agregás un engine después, `render --engines cursor` solo agrega ese sin tocar los demás.

**Decisión**: el core es engine-agnostic desde día 1, aunque al principio solo se use Claude. Migrar después es trabajo doble.

**Artefactos adicionales que `render` produce**:
- `.claude/skill-registry.md` — índice de skills disponibles con `name`, `description`, `path`, `mtime`, `size` y `fingerprint` (sha1 de contenido). El leader y los subagentes lo leen como tabla de contenidos en lugar de scanear `.claude/skills/`. `navori-ai doctor` valida que el registry está sincronizado contra el filesystem real.
- Equivalentes per-engine cuando aplique (ej. sección del registry incrustada en `AGENTS.md` para engines sin auto-discovery de skills).

**Decisión sobre quality gate runtime**: el harness corre el quality gate **solo en el hook `Stop`** (al cerrar sesión). NO se genera hook `PostToolUse` que valide tras cada `Edit/Write`. Razón: tus repos varían demasiado en velocidad de typecheck/tests; un hook automático que es valioso en `bonum-webapp` puede ser insufrible en otro repo. Quien quiera detección temprana lo agrega manualmente a su `settings.local.json`.

---

## 7. Resolución de configuración (prioridad)

1. CLI flags / respuestas interactivas (más fuerte)
2. `navori.config.json` (project local)
3. Workspace global (`~/.navori/workspaces/<nombre>.json`)
4. Stack preset defaults
5. Core defaults (más débil)

---

## 8. Tradeoff principal: ¿quién gana en `sync`?

Cuando el `CLAUDE.md` del repo y el preset del paquete divergen:

| Modelo | Pros | Contras |
|---|---|---|
| **Paquete autoritativo** | Consistencia entre repos | Rígido — customizaciones van como overrides en config |
| **Repo autoritativo** | Flexibilidad total | Drift entre proyectos, paquete deja de aportar valor |
| **Híbrido (recomendado)** | Lo mejor de ambos | Requiere disciplina en marcadores |

**Decisión recomendada**: híbrido. Secciones marcadas con marcadores `navori:managed` se sincronizan en `sync`; el resto del `CLAUDE.md` es del usuario. Implementación concreta del formato + algoritmo de sync: ver **§14**.

Funciona en la práctica (lo hace `eslint-config-*` con extends, Renovate con presets, etc.).

---

## 9. Lo que hace esto sostenible

- **`sync` con 3-way merge**: cuando mejorás `leader.md` core, los repos viejos pueden traer la mejora sin perder customizaciones. Sin esto, el paquete se vuelve write-once y dejás de mantenerlo.
- **`doctor` honesto**: detecta cuando el quality gate ya no corre, cuando `acli` no está en PATH, cuando engram falta. Sin él, los harness se degradan en silencio.
- **Multi-engine desde día 1**: el core es engine-agnostic. Renderizar a más engines después es trivial.
- **Workspace global**: evita repetirte. Una sola fuente para diccionario de proyectos, convenciones cross-repo.

---

## 10. Open questions / pendiente decidir

- [x] ~~Formato config: `json` vs `yaml` vs `js` (con tipos)~~ → **RESUELTO 2026-06-09: JSON con JSON Schema.** Ver §13.
- [x] ~~¿Empaquetar como monorepo (core + plugins separados) o paquete único?~~ → **RESUELTO 2026-06-09: monorepo pnpm workspaces.** Ver §15.
- [ ] ¿Soportar presets custom del usuario en `~/.navori/presets/`?
- [x] ~~Estrategia de versionado: ¿semver estricto en core? ¿plugins versionados independiente?~~ → **RESUELTO 2026-06-09: semver independiente por package.** Ver §15.
- [x] ~~¿CLI nativo (Node) o también ofrecer `npx` sin install global?~~ → **RESUELTO 2026-06-09: ambos vía npm package.** Ver §15.
- [ ] Telemetría opt-in para saber qué plugins/presets se usan más
- [ ] Tests del scaffolder — ¿snapshot de outputs por preset?
- [x] ~~¿Modo `--dry-run` para `init`/`sync` que solo muestre diff sin escribir?~~ → **RESUELTO 2026-06-09: sí, `--dry-run` en `sync`.** Ver §14.6.

---

## 11. Próximos pasos

1. Definir qué va exactamente en **Core** vs **Preset** vs **Workspace** para el caso Bonum (extraer del estado actual de `bonum-dashboard`, `bonum-webapp`, `bonum-nexus`). **Avance**: investigación 2026-06-09 con 9 harness clasificados — ver §12.
2. ~~Diseñar el esquema completo de `navori.config.json` con todos los campos.~~ **RESUELTO 2026-06-09**: ver §13.
3. ~~Decidir formato de marcadores `<!-- navori:managed -->` y cómo se comporta `sync` en conflictos.~~ **RESUELTO 2026-06-09**: ver §14.
4. Prototipo del `init` (solo Claude Code, sin plugins) para validar UX antes de generalizar.
5. Empaquetar primer plugin (engram) como prueba del bundle format.

---

## 12. Decisiones tomadas en investigación (2026-06-09)

Síntesis de 9 harness auditados: bonum-webapp, bonum-dashboard, navori-dashboard-template, alertaciudadana_backend, alertaciudadana_app, moonar-medusa-monorepo, betta-tech/ejemplo-harness-subagentes (externo), Gentleman-Programming/gentle-ai (externo), superpowers (externo).

### Patrones convergentes — confirmados como Core sin debate

Aparecen en ≥6 de 9 fuentes:
1. Anti-teléfono-descompuesto (`progress/<tipo>_<feature>.md` + `done -> <path>` en una línea)
2. AGENTS.md como mapa con divulgación progresiva
3. `progress/current.md` + `progress/history.md` como par de estado de sesión
4. `feature_list.json` con invariantes verificadas (cap de `in_progress`, acceptance criteria)
5. Hook `Stop` con `init.sh --fast` por default
6. `CHECKPOINTS.md C1-C5` con greps auditables
7. Frontmatter YAML estricto en agentes (`name`, `description`, `tools`, `model`)
8. SDD opt-in con lista negativa explícita ("NO aplica a: bugfixes UI, copy, refactor aislado")
9. Quality gate definido en 4 capas (CLAUDE.md canónico, CHECKPOINTS auditable, settings.json automático, package.json `validate`)
10. Scripts diff-vs-branch con skip silencioso (jscpd, semgrep, cognitive-complexity)

### Decisiones de juicio (4 preguntas abiertas resueltas)

| # | Pregunta | Decisión | Razón |
|---|---|---|---|
| D1 | ¿State machine de 8 fases para reanudabilidad? | `current.md` libre como default + slash commands `/session:save` y `/session:resume` para checkpoint formal cuando el usuario lo pida. Plugin `ticket-state-machine` para FSM completa opt-in. | Simplicidad por default; opt-in cuando se necesita |
| D2 | ¿Tabla central de model routing o frontmatter? | Frontmatter `model:` en cada agente del Core + cascada de override (Preset → Workspace → Project) | Encaja en las 5 capas existentes; cero código extra |
| D3 | ¿Skill registry indexado o paths planos? | Skill registry indexado: `render` genera `.claude/skill-registry.md` con paths + mtime + size + fingerprint. `doctor` valida sync. | Control declarativo del catálogo; anticipa crecimiento de skills |
| D4 | ¿PostToolUse hook auto en cada Edit? | NO. Solo Stop hook con quality gate al cerrar sesión. | Tus repos varían demasiado en velocidad; quien quiera detección temprana lo agrega manual |

### Ideas únicas adoptadas de cada fuente externa

- **De betta-tech**: tabla "Cuándo leerlo" en cada fila de AGENTS.md; Stop hook indestructible con `tail -20` si falla; contrato de 1 línea del reviewer.
- **De gentle-ai**: skill registry con fingerprint; delegation stop rules cuantificadas (4-file rule, 20-tool-call rule, 2-file-write rule); proposal question round antes de SDD (3-5 preguntas producto pre-propose); convención "leader pasa path exacto, no resumen" al subagente.
- **De superpowers**: framing adversarial del reviewer ("Do NOT trust the implementer. Verify independently."); vocabulario de 4 estados de subagente (`DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT`); provenance check en worktrees (solo limpiar lo que el harness creó).

### Anti-patterns descartados

1. `settings.local.json` como artefacto generado → navori genera `settings.json` base limpio; `.local.json` queda gitignored y crece orgánico.
2. Reglas de dominio/stack duplicadas en 4-5 archivos → una fuente de verdad por convención, los demás referencian via marker.
3. Skills de librería copiados en cada repo → centralizar como plugins.
4. Agentes Core de 500+ líneas mezclando protocolo universal con conocimiento de stack → agentes Core ≤200 líneas; el resto va al preset/workspace via marker.
5. Persona/preferencias del autor hardcodeadas en Core → persona y voz son workspace-level.
6. Skills siempre cargados aunque no apliquen → preset declara `auto` vs `opt-in` por skill.

### Hallazgo monorepo (de moonar-medusa-monorepo)

Los monorepos requieren tratamiento especial:
- `navori.config.json` debe soportar `monorepo.workspaces[]`
- `render` scaffoldea un `CLAUDE.md` por workspace (lente stack-specific) además del root
- Convención: agentes leen `apps/<name>/CLAUDE.md` cuando trabajan en ese workspace
- El skill-registry distingue skills root vs per-workspace

---

## 13. Schema completo de `navori.config.json`

Formato: **JSON con JSON Schema** (decisión 2026-06-09, §10). El archivo vive en la raíz del repo, checked-in. Es la fuente de verdad: `render` reconstruye todo desde acá.

### 13.1. Estructura completa (con anotaciones)

```jsonc
{
  "$schema": "https://navori.dev/schema/navori.config.v1.json",

  // === Identidad ===
  "name": "bonum-dashboard",
  "version": "1.0.0",                        // schema version del archivo (no del repo)
  "workspace": "bonum",                       // matches ~/.navori/workspaces/bonum.json

  // === Engines a renderizar ===
  "engines": ["claude", "agents-md"],         // ["claude", "agents-md", "cursor", "copilot"]

  // === Preset de stack ===
  "preset": "vite-react-ts-mantine",          // determina defaults de Capa 2

  // === Convenciones del repo ===
  "branchBase": "develop",                    // base para diff-vs-branch y PRs
  "commits": "conventional-es",               // "conventional", "conventional-es", "free"

  // === Quality gate ===
  "qualityGate": {
    "fast": "pnpm tsc --noEmit",              // Stop hook --fast (~2s)
    "full": "pnpm tsc --noEmit && bun run lint && bun run test:unit"  // gate completo
  },

  // === Spec-Driven Development ===
  "sdd": {
    "enabled": true,
    "specsDir": "specs",
    "applyWhen": [
      "scope > 2 days",
      "touches access control or auth flow",
      "cross-service or cross-app change"
    ],
    "doesNotApplyTo": [
      "UI bugfixes",
      "copy / i18n changes",
      "isolated refactor",
      "tokens / theme tweaks"
    ]
  },

  // === Roles del harness multi-agente (override del Core) ===
  "harness": {
    "leader": true,
    "implementer": true,
    "reviewer": true,
    "researcher": true,
    "ticketAudit": true,
    "commitPrPilot": true,
    "explorer": true
  },

  // === Model routing (override de los defaults del Core, §2 Capa 1) ===
  // Si se omite, hereda los defaults: leader=opus, implementer=sonnet, reviewer=sonnet,
  // researcher=haiku, ticket-audit=opus, commit-pr-pilot=haiku, explorer=haiku.
  "models": {
    "reviewer": "opus"                        // este repo prefiere reviewer en Opus
  },

  // === Plugins activos ===
  "plugins": {
    "engram": { "enabled": true },
    "acli": { "enabled": true },
    "deep-research": { "enabled": true },
    "code-review": { "enabled": true },
    "verify": { "enabled": true },
    "frontend-design": { "enabled": true },
    "semgrep": { "enabled": false },
    "ticket-state-machine": { "enabled": false }
  },

  // === Skills: auto-cargadas vs opt-in ===
  // "auto": Claude las considera siempre al inicio de sesión
  // "optIn": solo cuando el usuario las invoca explícitamente
  "skills": {
    "auto": ["session-save", "session-resume", "verify-before-done"],
    "optIn": ["new-feature", "debug-error", "review-diff", "pr-create"]
  },

  // === Persistencia de progreso ===
  "progress": {
    "dir": "progress",
    "currentFile": "current.md",
    "historyFile": "history.md",
    "checkpointsDir": "progress/checkpoints",   // donde /session:save escribe
    "archiveAfterDays": 30
  },

  // === Monorepo (opcional) ===
  "monorepo": {
    "enabled": false,
    "tool": "pnpm",                             // "pnpm" | "turbo" | "nx" | "rush"
    "workspaces": []
  }
}
```

### 13.2. Defaults heredados de Core / Preset / Workspace

El config que el usuario escribe es **mínimo**: solo lo que difiere de los defaults. La cascada de resolución es:

1. **Core defaults** (más débil): structure del JSON con todos los campos y defaults razonables
2. **Preset defaults**: el preset declara `qualityGate`, `branchBase`, `skills.auto`, etc.
3. **Workspace defaults**: `~/.navori/workspaces/<key>.json` puede override engines, plugins, model routing
4. **Project config** (más fuerte): este archivo
5. **CLI flags** (más fuerte aún): overrides puntuales

`navori-ai doctor` muestra el config **resuelto** (config efectivo tras la cascada) para que sea fácil ver qué default vino de dónde.

### 13.3. Ejemplo mínimo — proyecto nuevo con preset

Lo que un usuario realmente escribe al hacer `navori-ai init` en un repo nuevo:

```json
{
  "$schema": "https://navori.dev/schema/navori.config.v1.json",
  "name": "bonum-newrepo",
  "workspace": "bonum",
  "engines": ["claude"],
  "preset": "vite-react-ts-mantine"
}
```

Todo lo demás se hereda. ~80 líneas resueltas a partir de 6.

### 13.4. Ejemplo monorepo — moonar-medusa-monorepo

```json
{
  "$schema": "https://navori.dev/schema/navori.config.v1.json",
  "name": "moonar-medusa-monorepo",
  "workspace": "moonar",
  "engines": ["claude", "agents-md"],
  "preset": "monorepo-turbopnpm",
  "branchBase": "main",
  "qualityGate": {
    "fast": "pnpm turbo typecheck --filter=...[HEAD]",
    "full": "pnpm turbo typecheck lint test --filter=...[HEAD]"
  },
  "monorepo": {
    "enabled": true,
    "tool": "turbo",
    "workspaces": [
      {
        "name": "backend",
        "path": "apps/backend",
        "preset": "medusa-v2",
        "qualityGate": {
          "fast": "pnpm --filter @moonar/backend typecheck",
          "full": "pnpm --filter @moonar/backend validate"
        }
      },
      {
        "name": "storefront",
        "path": "apps/storefront",
        "preset": "nextjs-medusa-sdk",
        "qualityGate": {
          "fast": "pnpm --filter @moonar/storefront typecheck",
          "full": "pnpm --filter @moonar/storefront validate"
        }
      },
      {
        "name": "photo-service",
        "path": "apps/backend/photo-service",
        "preset": "fastapi-python",
        "qualityGate": {
          "fast": "ruff check .",
          "full": "ruff check . && pytest"
        }
      }
    ]
  },
  "sdd": {
    "enabled": true,
    "applyWhen": ["touches checkout flow", "touches pricing", "cross-app change"],
    "doesNotApplyTo": ["UI tweaks", "copy", "theme tokens"]
  }
}
```

`render` genera: un `CLAUDE.md` raíz + un `CLAUDE.md` por workspace (lentes stack-specific). Hooks monorepo-aware (typecheck per workspace) los genera el preset `monorepo-turbopnpm`.

### 13.5. Ejemplo microservicio backend — alertaciudadana_backend

```json
{
  "$schema": "https://navori.dev/schema/navori.config.v1.json",
  "name": "alertaciudadana-backend",
  "workspace": "navori",
  "engines": ["claude"],
  "preset": "bun-keystone",
  "branchBase": "dev",
  "commits": "conventional-es",
  "qualityGate": {
    "fast": "bun run compile",
    "full": "bun run validate"
  },
  "models": {
    "reviewer": "opus"
  },
  "plugins": {
    "semgrep": { "enabled": true },
    "ticket-state-machine": { "enabled": false }
  },
  "sdd": {
    "enabled": true,
    "applyWhen": [
      "touches access control",
      "touches Keystone hooks with side effects",
      "touches PII or auth flow"
    ],
    "doesNotApplyTo": [
      "UI tweaks (no aplica - es backend)",
      "isolated query refactor",
      "i18n / copy changes"
    ]
  }
}
```

### 13.6. Reglas de validación clave

El JSON Schema enforcea:
- `name`: requerido, kebab-case
- `engines`: al menos uno de la lista permitida
- `preset`: debe existir en el registry de presets del paquete
- `workspace`: si se especifica, el archivo `~/.navori/workspaces/<workspace>.json` debe existir (warning suave si no)
- `models.<role>`: debe ser `"opus"`, `"sonnet"` o `"haiku"` (sin versiones — navori resuelve a la última estable)
- `monorepo.workspaces[].path`: debe existir en el filesystem (error duro)
- `qualityGate.fast` y `qualityGate.full`: requeridos si se override; si se omiten, hereda del preset
- `sdd.applyWhen` y `sdd.doesNotApplyTo`: arrays de strings; sirven para que el leader decida modo SDD vs task-acotada (también se inyectan al `CLAUDE.md` generado)

### 13.7. Lo que NO va en el config (intencionalmente)

- Skills paths absolutos — todo es relativo al repo o al paquete del plugin
- Versiones de modelos (`claude-opus-4-7`) — navori-ai resuelve a la última estable, sin pinning manual
- Convenciones de naming, estructura `src/`, reglas anti-hardcode — todo eso vive en el preset y se inyecta al `CLAUDE.md` con marcadores `<!-- navori:managed -->`
- Credenciales, tokens, paths de usuario — `settings.local.json` queda gitignored y crece orgánico

---

## 14. Sistema de marcadores y `sync` (modelo híbrido)

Decisiones cerradas 2026-06-09 tras investigación de `gentle-ai/filemerge` + análisis de divergencias en `bonum-dashboard`, `bonum-webapp`, `moonar-medusa-monorepo`.

### 14.1. Formato del marcador (Markdown)

```html
<!-- navori:managed id="<section-id>" hash="<sha1-8>" [condition="<config-path>"] -->
contenido sincronizado
<!-- /navori:managed id="<section-id>" -->
```

**Atributos**:
- `id` (requerido): identificador único en kebab-case (ej. `idioma-rol`, `formato-respuesta`, `engram-protocol`)
- `hash` (escrito por `sync`, leído en próximo `sync`): SHA-1 truncado a 8 chars del contenido entre marcadores. Sirve para detectar si el usuario editó dentro del bloque
- `condition` (opcional): ruta del `navori.config.json` (ej. `features.i18n`, `monorepo.enabled`, `sdd.enabled`, `plugins.engram.enabled`). El bloque solo se renderiza si el path resuelve a truthy. Sintaxis estricta: solo path, sin operadores `&&` `||` `==`

**Ejemplo con condition**:
```html
<!-- navori:managed id="no-hardcode-i18n" hash="a3f8c2bd" condition="features.i18n" -->
- Strings UI: keys de i18n, nunca literales hard-coded en JSX
<!-- /navori:managed id="no-hardcode-i18n" -->
```

### 14.2. Catálogo inicial de marcadores Core (Top 5 confirmados)

Estas son las secciones que tu workspace Bonum tiene **idénticas** entre repos y por tanto se manejan como managed:

| `id` | Contenido | Fuente canonical |
|---|---|---|
| `idioma-rol` | "Código/JSDoc inglés. Chat ES-MX. Rol Tech Lead Senior. ¿lo más simple?..." | bonum-dashboard CLAUDE.md:3-5 |
| `formato-respuesta` | Bloque bug fix + code review con `[CRÍTICO]/[ALTO]/[MEDIO]` | bonum-dashboard CLAUDE.md:108-122 |
| `engram-protocol` | mem_save proactivo, mem_search al inicio, mem_session_summary obligatorio | bonum-dashboard CLAUDE.md:126-132 |
| `tipado-fuerte` | `any` prohibido + `unknown` + narrowing + `// any justificado: <razón>` | bonum-webapp AGENTS.md:58 (versión completa) |
| `cierre-sesion` | 5 pasos: quality gate → history.md → vaciar current → sin temporales → commit Conventional | bonum-dashboard AGENTS.md cierre |

El comando del quality gate dentro de `cierre-sesion` se interpola desde `qualityGate.full` del config.

### 14.3. Secciones explícitamente NO managed (zona del usuario)

Confirmado por el análisis de divergencias: pisar estas secciones destruye contexto crítico del proyecto:

1. **Stack** — versiones reales, deuda técnica, "Cypress existe pero no es CI gate aún"
2. **Quality gate con notas contextuales** — "lint reporta ~61 warnings: OK", "tsc falla con 15+ errores preexistentes"
3. **Flujo de ticket / `feature_list.json`** — el corazón del workflow del equipo

El CLI nunca genera marcadores managed dentro de estas secciones, aunque el preset las scaffoldee inicialmente.

### 14.4. Formato del marcador (JSON — `settings.json`)

Para `settings.json` y otros JSON, el merge usa **deep merge recursivo** con un escape hatch:

```jsonc
// fragment del preset
{
  "permissions": {
    "__replace__": {
      "Bash(pnpm:*)": "allow",
      "Bash(git:*)": "allow"
    }
  }
}
```

El sentinel `__replace__` fuerza reemplazo atómico de ese sub-objeto (resuelve el caso "el usuario tenía `sdd-*: allow` con wildcard y el nuevo preset trae permisos explícitos — sin `__replace__` el wildcard sobrevive como clave stale").

Sin sentinel = deep merge normal (las claves del usuario sobreviven).

### 14.5. Algoritmo de `Merge` (Markdown)

Inspirado en `InjectMarkdownSection` de gentle-ai, con **protección contra pérdida de trabajo** agregada:

```
función Merge(existing_file, section_id, new_content, condition_truthy):
  open  = `<!-- navori:managed id="${section_id}"`
  close = `<!-- /navori:managed id="${section_id}" -->`

  # FASE 1: reparación de orphans (heredado de gentle-ai)
  existing_file = stripOrphanMarkers(existing_file, section_id)

  # FASE 2: condition gate
  si NO condition_truthy:
    # el bloque no aplica a este proyecto → eliminar si existía
    devolver removeBlock(existing_file, section_id)

  # FASE 3: localizar bloque existente
  match = findBlock(existing_file, section_id)

  si match es null:
    # primera adopción: append al final con marcadores nuevos
    new_hash = sha1(new_content)[:8]
    devolver existing_file + "\n\n" + open + ` hash="${new_hash}" -->` + "\n" + new_content + "\n" + close + "\n"

  # FASE 4: detección de modificación del usuario
  current_content = extractContent(match)
  expected_hash = extractHashFromOpenMarker(match)
  actual_hash = sha1(current_content)[:8]

  si actual_hash != expected_hash:
    # USUARIO EDITÓ DENTRO DEL BLOQUE
    si new_content == current_content:
      # no hay cambio del Core; mantenemos lo del usuario y actualizamos el hash
      devolver replaceHashInMarker(existing_file, section_id, actual_hash)
    sino:
      # CONFLICTO: hay edición del usuario + cambio del Core
      lanzar ConflictError(section_id, current_content, new_content)

  # FASE 5: replace silencioso (no hubo edición del usuario)
  new_hash = sha1(new_content)[:8]
  devolver replaceBlock(existing_file, section_id, new_content, new_hash)
```

### 14.6. Comportamiento de `navori-ai sync`

**Default = interactivo**. Muestra qué va a cambiar y pregunta antes de aplicar.

```bash
$ navori-ai sync
[1/3] CLAUDE.md
  managed:idioma-rol         no changes
  managed:formato-respuesta  UPDATE (Core v1.2 → v1.3)
    - [CRÍTICO] ... # rompe build/security/data
    + [CRÍTICO] ... # rompe build, security o pérdida de datos
  managed:tipado-fuerte      CONFLICT (you edited this block)
    your version  : 12 lines
    Core version  : 14 lines
    suggested 3-way diff: ./tmp/navori-sync-conflict-tipado-fuerte.md

[2/3] .claude/AGENTS.md      no changes
[3/3] .claude/settings.json  ADD permissions.Bash(pnpm:check:*)

Backup será creado en: .navori/backups/2026-06-09T14-32-11/

Apply changes? [a]ll / [s]elect / [c]onflicts only / [d]iff / [q]uit:
```

**Flags**:
- `sync --apply --yes` — aplica todo sin preguntar (CI/automatización). Si hay conflicto, falla con exit 1
- `sync --dry-run` — solo muestra, nunca aplica
- `sync --only <id1,id2>` — sincroniza solo los IDs listados
- `sync --resolve <id>=mine|theirs` — resuelve conflictos no-interactivos
- `sync --no-backup` — saltea backup (no recomendado)

### 14.7. Backup automático

Cada `sync --apply` (o aprobación interactiva) crea:

```
.navori/
└── backups/
    ├── 2026-06-09T14-32-11/
    │   ├── CLAUDE.md
    │   ├── .claude/AGENTS.md
    │   └── .claude/settings.json
    └── 2026-06-08T09-12-44/
        └── ...
```

- Solo se copian los archivos que `sync` va a modificar (no todo el repo)
- `.navori/backups/` queda **gitignored** por default (lo agrega `init`)
- Auto-purga de backups con más de **30 días** al inicio de cada `sync` (configurable en `navori.config.json` → `sync.backupRetentionDays`)
- `navori-ai restore <timestamp>` revierte a un backup específico

### 14.8. Escritura atómica de archivos

Heredado de `gentle-ai/writer.go`. Toda escritura usa:

1. Escribir a tempfile en el mismo directorio (`<file>.navori.tmp.XXXX`)
2. `fsync` del tempfile
3. `rename` atómico al destino
4. `fsync` del directorio padre

Si el proceso muere a mitad, el archivo destino queda en su estado anterior. **Garantiza el invariante "no corrompir archivos"** que es parte del quality gate del CLI.

**Defensas adicionales**:
- No seguir symlinks (escribir al destino real, no al symlink target inesperado)
- Tamaño máximo del archivo: 16 MB (defiende contra archivos accidentalmente enormes)

### 14.9. Catálogo de casos edge cubiertos (tomados de gentle-ai)

El `Merge` de v1 cubre todos estos casos sin tirar error:

| Caso | Comportamiento |
|---|---|
| Archivo vacío | Crea el bloque |
| Archivo sin marcadores | Append al final con separador |
| Bloque existente bien formado | Replace in-place |
| Múltiples marcadores en el mismo archivo | Solo toca el del `id` target |
| Orphan opener (open sin close) | Strip + append nuevo |
| Orphan closer (close sin open) | Strip + reintenta |
| Marcadores anidados accidentales | El inner se consume como contenido del outer; orphan cleanup al final |
| CRLF (Windows line endings) | Se normaliza a LF sin acumular `\r` |
| Content sin trailing newline | Se agrega automáticamente |
| Triple newlines tras eliminación | Se colapsan a doble |
| String que contiene "navori:managed" pero no como marker | Ignorado (solo procesa `<!--` al inicio de línea) |
| Content vacío + bloque existe | Elimina el bloque |
| Content vacío + bloque no existe | No-op |
| Sección con `condition` falsy | Elimina el bloque si existía |
| Hash mismatch + content idéntico | Solo actualiza hash, no contenido |
| Hash mismatch + content distinto | **Conflicto explícito** (3-way diff) |

### 14.10. Lo que NO soporta v1 (intencional)

- **YAML / TOML mergers**: solo Markdown + JSON. Cuando se implemente el engine adapter de Cursor/Codex, se agregan
- **`<!-- navori:user -->` explícito**: zona del usuario es implícita (todo lo no-managed). YAGNI
- **Operadores en `condition`** (`&&`, `||`, `==`, `!`): solo path → truthy/falsy. Si un caso real lo requiere, se agrega después
- **Migración de marcadores legacy** (`<!-- gentle-ai:... -->` u otros): no es prioritario; si aparece, el algoritmo de orphan-cleanup ya los maneja como "marcadores desconocidos" → no los toca
- **Versionado del schema del marker** (`hash` no es schema version): el algoritmo es estable; si cambia, se hace migración explícita con un nuevo prefijo (`<!-- navori-v2:managed -->`)

### 14.11. Recomendación de adopción gradual

Para los repos existentes (`bonum-dashboard`, `bonum-webapp`, etc.) que ya tienen `CLAUDE.md` escrito a mano:

1. **`navori-ai init --adopt`** detecta secciones que coinciden con los managed Core por fingerprint de contenido (similar a `StripLegacyPersonaBlock` de gentle-ai pero más conservador)
2. Pregunta una por una: "Detected section matching `idioma-rol`. Wrap with managed marker? [y/n]"
3. Solo wrappea las aceptadas. El resto queda como user-customized
4. `sync` posterior funciona normal

Esto evita el "todo o nada" que mata la adopción en repos vivos.

---

## 15. Distribución, arquitectura del CLI y plan v1/v2

Decisiones cerradas 2026-06-09 tras investigación de engram (Go + brew + MCP + TUI Catppuccin + Cloud dashboard) y gentle-ai (Go + brew + scoop + TUI Bubbletea primaria), adaptadas al stack Node/TS del usuario.

### 15.1. Stack técnico

- **Runtime**: Node.js 20+ (compatible con bun)
- **Lenguaje**: TypeScript con `tsup` como bundler (genera CJS + ESM, zero config)
- **Framework CLI**: `citty` (ESM nativo, moderno) o `commander` (más maduro). Decisión final en bootstrap del proyecto
- **Prompts interactivos**: `@clack/prompts` (no Ink en v1 — prompts simples bastan para el wizard secuencial de `init`)
- **Validación de schema**: `zod` para `navori.config.json` + JSON Schema generado para IDE autocomplete
- **Atomic file writes**: `proper-lockfile` o implementación propia (tempfile + rename + fsync) — ver §14.8
- **Detección de package manager**: leer `packageManager` field de `package.json` o lockfile detection
- **`open`** (v10+) para abrir browser en v2 cuando se agregue web UI

### 15.2. Distribución vía npm

**Canal único en v1**: `npm` registry público como `navori-ai`.

```bash
# Instalación global (uso recurrente)
npm i -g navori-ai
pnpm add -g navori-ai
bun add -g navori-ai

# Uso ocasional sin install
npx navori-ai init
pnpm dlx navori-ai init
bunx navori-ai init
```

**Razones de la elección** (vs brew/binary):
- Tu workspace ya tiene Node en cada máquina dev (cero fricción de instalación)
- `npx` permite usar el CLI sin instalar (útil para máquinas de equipo o validación rápida)
- Cero overhead de mantenimiento (sin Homebrew tap, sin Scoop bucket, sin GoReleaser, sin code signing en macOS, sin Apple Developer Program)
- `npm update -g navori-ai` actualiza nativo

**Si en el futuro crece la audiencia**: agregar Homebrew tap como canal secundario. Pero no es v1.

### 15.3. Estructura del proyecto: monorepo pnpm workspaces

```
navori-ai/
├── packages/
│   ├── cli/                      # @navori/cli — el binario publicado en npm como `navori-ai`
│   │   ├── src/
│   │   │   ├── commands/         # init, sync, render, doctor, add, remove, preset, workspace
│   │   │   ├── core/             # algoritmo de merge §14, validation §13, layered config resolver
│   │   │   ├── prompts/          # wizards con @clack/prompts
│   │   │   └── index.ts
│   │   └── package.json
│   ├── core/                     # @navori/core — primitives universales (agentes, CHECKPOINTS template, etc.)
│   │   └── core-assets/          # .md files con marcadores managed
│   ├── presets/                  # @navori/preset-* — uno por stack
│   │   ├── vite-react-ts-mantine/
│   │   ├── nestjs-mongoose/
│   │   ├── nextjs/
│   │   ├── express-microservice/
│   │   ├── react-native-expo/
│   │   ├── bun-keystone/
│   │   ├── medusa-v2/
│   │   ├── monorepo-turbopnpm/
│   │   └── custom/
│   ├── plugins/                  # @navori/plugin-* — bundles opcionales
│   │   ├── engram/
│   │   ├── acli/
│   │   ├── semgrep/
│   │   ├── ticket-state-machine/
│   │   └── ...
│   └── schema/                   # @navori/schema — JSON Schema de navori.config.json
└── pnpm-workspace.yaml
```

**Razones del monorepo**:
- Presets y plugins se versionan **independientemente** del CLI core. Actualizar el preset `vite-react-ts-mantine` no fuerza release del CLI
- Tests del scaffolder se pueden hacer por preset sin tocar el CLI
- Usuarios avanzados pueden depender de `@navori/preset-*` directamente sin pasar por el CLI

**Versionado**:
- `@navori/cli`: semver estricto. Breaking changes = major.
- `@navori/preset-*` y `@navori/plugin-*`: semver independiente. Compatibilidad declarada via `peerDependencies` con `@navori/cli`.
- `@navori/schema`: semver atado al `version` field del propio `navori.config.json`. Migration scripts para cada bump.

### 15.4. Modos de operación del CLI

```bash
# Modo interactivo (default sin subcomando explícito)
navori-ai                     # wizard inteligente: detecta estado del repo y propone acción
navori-ai init                # wizard de inicialización con @clack/prompts

# Modo script / CI (todo via flags)
navori-ai init --workspace bonum --preset vite-react-ts-mantine --engines claude --yes
navori-ai sync --apply --yes
navori-ai render --engines claude,agents-md
navori-ai doctor --json

# Comandos principales
init [flags]                       # scaffold inicial
add <plugin|skill|preset>          # agregar módulo después
remove <plugin>                    # quitar módulo limpio
sync [--apply|--dry-run|--yes]     # 3-way merge §14
render [--engines <list>]          # re-generar outputs desde navori.config.json
doctor [--json]                    # health check (config resuelto, plugins, external tools)
preset list|apply <name>           # gestionar presets
workspace init <name>              # crear/editar reglas globales compartidas
config show [--resolved]           # imprimir config (raw o post-cascada)
```

**`--yes`** salta confirmaciones interactivas (CI/automation).
**`--json`** outputs estructurados para piping (`navori doctor --json | jq ...`).

### 15.5. State global del CLI: `~/.navori/`

Inspirado en gentle-ai pero adaptado:

```
~/.navori/
├── state.json                    # CLI state: workspaces conocidos, presets custom registrados, último check de update
├── workspaces/                   # config compartido por workspace (§2 Capa 3)
│   ├── bonum.json
│   ├── moonar.json
│   └── navori.json
├── presets/                      # presets custom del usuario (opcional, v1.x)
│   └── <custom-preset>/
├── backups/                      # snapshots de archivos antes de sync (§14.7)
│   ├── 2026-06-09T14-32-11/
│   └── ...
└── cache/
    ├── update-check.json         # timestamp del último check a npm registry
    └── plugin-doctors/           # results recientes de doctor.sh por plugin
```

**Convención**: cualquier archivo bajo `~/.navori/` es del usuario; el CLI nunca purga nada salvo backups con >30 días.

### 15.6. Scope global vs workspace

```bash
navori init                        # --scope=project (default) — escribe en el repo actual
navori workspace init bonum        # --scope=global  — escribe en ~/.navori/workspaces/bonum.json
navori add engram --scope=global   # agrega plugin a todos los repos del workspace activo
navori add engram                  # agrega plugin solo al repo actual
```

### 15.7. Plugins y external tools

Distinción formal:

- **Plugin (`@navori/plugin-*`)**: bundle de archivos en npm que el CLI copia/inyecta en el repo. Siempre se instala (los archivos llegan)
- **External tool**: binario del sistema que algunos plugins requieren (`semgrep`, `jscpd`, `acli`, MCP servers como `engram`)

**Flujo de `navori add <plugin>`**:

```
1. CLI descarga @navori/plugin-<name> de npm (peer del CLI core)
2. CLI copia archivos del plugin a .claude/ (settings fragment, claude-md block, skill, hook, doctor)
3. CLI ejecuta plugins/<name>/doctor.sh para verificar external tool
4. SI external tool faltante:
   - Muestra: "semgrep no está instalado. Comando sugerido: brew install semgrep"
   - Pregunta: "¿Lo instalo por vos? [s/n/skip]"
   - SI 's': ejecuta el comando (pide confirmación de sudo si lo necesita)
   - SI 'n' o 'skip': continúa. El plugin queda activo. Los hooks usan skip silencioso (command -v <tool> || exit 0).
5. Actualiza navori.config.json con el plugin registrado
6. Reporta resumen + estado del doctor
```

**Casos por tool**:

| Tool | Tipo | Comando install sugerido |
|---|---|---|
| `acli` | Binary CLI | `brew install acli` |
| `semgrep` | Binary CLI | `brew install semgrep` |
| `jscpd` | npm CLI | `pnpm add -g jscpd` |
| `engram` | MCP server | `brew install gentleman-programming/tap/engram && claude plugin install engram` |
| Plugins solo-archivos (verify, code-review, deep-research, frontend-design) | — | Sin external tool |

### 15.8. Auto-update check (silencioso, con cache 24h)

En cada ejecución, el CLI:

1. Lee `~/.navori/cache/update-check.json`
2. Si `lastCheckAt < now - 24h`: hace `npm view navori-ai version` con timeout 3s
3. Si hay versión nueva, muestra **banner** al final del comando:
   ```
   📦 navori-ai 1.3.0 disponible (corres 1.2.5)
      Actualizá con: npm update -g navori-ai
   ```
4. Actualiza `lastCheckAt`

**No hay re-exec automático**. El usuario corre `npm update -g` cuando quiere (más seguro en npm que en Go, donde el `syscall.Exec` es atómico).

**Desactivable**: `NAVORI_NO_UPDATE_CHECK=1` o `~/.navori/state.json` → `updateCheck: false`.

### 15.9. Lo que va en v2 (NO MVP)

Diferidas explícitamente para acotar el scope inicial:

1. **Web UI local** — `navori ui` levanta servidor Hono local en `localhost:PORT` + abre browser. Sirve React SPA embebida en el paquete. Casos de uso: diff visual de sync, gestor de presets, dashboard de workspaces, historia de operaciones. **Stack target v2**: Hono + React 18 + Vite + Tailwind + WebSocket nativo Node para eventos en vivo. Razón de diferir: el CLI + TUI cubre 80% del valor; la web UI tiene sentido cuando hay estado mutable continuo, que un scaffolder no tiene.

2. **Plugin Claude Code marketplace + MCP server propio** — repo separado `navori-ai-claude-plugin` (o subdir) con `.mcp.json` que apunta al CLI en modo `navori mcp`. SKILL.md "ALWAYS ACTIVE" inyectando convenciones del harness. Tools MCP: `mcp__navori__sync`, `mcp__navori__doctor`, `mcp__navori__add`. Razón de diferir: el CLI scaffoldea `.claude/` perfecto sin necesidad de MCP; el plugin marketplace agrega distribución, no valor funcional.

3. **TUI rica con Ink** — solo si el feedback de v1 dice que `@clack/prompts` es insuficiente (wizard ramificado con preview, navegación atrás/adelante, etc.). Migrable sin breaking changes.

4. **Telemetría opt-in** — tracking de qué presets/plugins se usan para priorizar mantenimiento.

5. **Homebrew tap** — solo si la audiencia crece más allá del workspace Bonum/navori personal.

### 15.10. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| `npm install -g` con permisos en Mac (requiere sudo) | Documentar uso de `pnpm`, `bun` o `nvm` que evitan permisos globales. Banner en `init` si detectamos install con sudo |
| Mac users sin Node | Documentar `pnpm dlx navori-ai init` como alternativa (funciona sin install global). Si crece audiencia, Homebrew tap en v2 |
| Versionado entre `cli` y `preset-*` se desincroniza | `peerDependencies` declarados. `doctor` valida compatibilidad. Error claro si hay mismatch |
| Update check bloquea el comando | Timeout 3s + fallo silencioso. Nunca bloquea por más de 3s |
| Backups crecen sin control | Auto-purga >30 días en cada `sync`. Configurable en `navori.config.json` → `sync.backupRetentionDays` |
| Atomic write falla en filesystems exóticos (NFS, etc.) | Fallback documentado: si rename atómico no es posible, escribir directo + warning |

---

## Referencias / inspiración

- `eslint-config-*` con extends — modelo de capas + override
- `create-vite`, `create-next-app` — UX del init interactivo
- Renovate config presets — workspace shared rules
- `degit` — scaffolding desde templates
- AGENTS.md spec — estándar emergente multi-engine
