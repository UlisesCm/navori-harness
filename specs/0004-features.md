# Spec 0004 — Features: workflows multi-fase que orquestan skills

> **Estado**: draft.
> **Objetivo de release**: v0.3.0.
> **Framing**: navori es tool-for-self. Este spec agrega **un** tipo de asset
> nuevo — el más grande desde los presets — porque hay un patrón real (app-builder)
> que hoy vive como skill suelta y no encaja en ninguna capa del modelo.
> **Origen**: el patrón "skill madre + sub-skills" de `docs/research/ponytail-lessons.md §4.4`
> es el embrión de esta idea; una *feature* lo lleva un nivel arriba.

---

## 0. Resumen ejecutivo

Hoy navori tiene cinco piezas: **agentes** (roles), **skills** (docs de referencia/comportamiento
de propósito único), **bloques managed** (secciones regeneradas de `CLAUDE.md`),
**plugins** (integraciones de herramientas) y **presets** (bundles por stack).
Ninguna modela **"un workflow guiado, multi-fase, que orquesta N skills hacia un
entregable único, con un quality gate entre fases"**.

Ese objeto existe en la práctica: el skill `app-builder` del usuario lleva de
*definición de producto → arquitectura → implementación → store-ready* en 12 fases,
cada una componiendo varias skills (`app-ia`, `store-ship`, `ship-docs`, `ui:*`…)
con un gate humano o mecánico entre cada una. Está forzado dentro del formato de
una skill porque no hay otro lugar. Este spec le da un lugar: la **feature**.

Una feature **no introduce runtime nuevo**. Es contenido managed que el orquestador
(leader) existente ejecuta. La feature solo le dice al leader *qué skills y qué
agentes usar en cada fase, y qué gate pasar antes de avanzar*.

---

## 1. Motivación y problema

Una skill es de **propósito único**: un trigger, un cuerpo corto (≤200–500 palabras
por el cap de `spec 0003 §3.2.1`), un verbo. `nextjs-app-router` documenta un patrón;
`store-ship` envuelve una herramienta. La skill madre de ponytail (§4.4) ya estira
ese modelo: gobierna comportamiento continuo y despacha a sub-skills que son verbos
puntuales (`/ponytail-review`, `/ponytail-audit`). Pero incluso ahí las sub-skills
son **hermanas independientes**, no **fases ordenadas con un gate entre ellas hacia
un entregable común**.

Lo que falta modelar:

- **Orden y gate.** La fase N solo arranca si el gate de N−1 pasó. Una skill no
  tiene el concepto de "fase anterior aprobada".
- **Composición, no duplicación.** Una feature *reusa* skills existentes por id
  (`app-ia`, `astro`, `store-ship`) — no re-documenta su contenido.
- **Un entregable.** Todas las fases empujan hacia una cosa (una app en stores),
  no hacia N cosas sueltas.
- **Carga on-demand del conjunto.** El doc de orquestación pesa; no puede ser
  always-on. Debe cargar por trigger y traer sus fases solo cuando corren.

`app-builder` demuestra que el patrón es real y que el formato "skill" no le queda:
16 KB de SKILL.md + 6 archivos de `references/` es una skill deformada para caber.

---

## 2. Modelo

Una **feature** es un bundle de tres partes:

| Parte | Archivo | Rol |
|-------|---------|-----|
| Manifiesto | `feature.json` | id, displayName, description (con **triggers**), phases[] |
| Orquestación | `FEATURE.md` | el contrato que lee el leader: rol, reglas duras, tabla de fases, result contract |
| Docs por fase | `phases/<n>-<slug>.md` | detalle de una fase, cargado solo cuando esa fase corre |

Cada entrada de `phases[]` declara:

- **`objetivo`** — qué produce la fase.
- **`skills`** — ids de skills existentes que compone (reuso, no copia).
- **`gate`** — condición a cumplir para avanzar (comando mecánico o aprobación humana).
- **`artifacts`** — qué deja escrito (archivos + topic keys de Engram).
- **`model` / `effort`** (opcional) — tier sugerido al delegar esa fase.

Además de `phases[]`, el manifiesto declara **`kind`**: `bootstrap | in-repo`
(default `in-repo`). Una feature `in-repo` opera sobre un proyecto existente. Una
feature `bootstrap` **crea el proyecto** — su output es el repo mismo (app-builder:
la fase de scaffold es parte de la feature, no un prerequisito). La distinción
importa porque cambia el camino de activación (ver §3.2).

### 2.1 Dónde aterriza en el harness generado

**Decisión: la feature se renderiza dentro del namespace de skills**, no en un
`.claude/features/<id>/` propio.

Razón dura: Claude Code **solo autodescubre** `.claude/skills/`, `.claude/agents/`
y `.claude/commands/`. Un directorio `.claude/features/` no lo carga nadie —
requeriría un mecanismo de discovery que Claude Code no tiene, o inyectar el índice
always-on en `CLAUDE.md` (rompe el objetivo de tokens). El `FEATURE.md` **es** una
skill madre: cargar-por-trigger es exactamente el comportamiento que ya da
`.claude/skills/`. Por eso:

```
.claude/skills/<id>/
  SKILL.md            ← el FEATURE.md rendereado como skill madre (frontmatter con triggers)
  phases/
    0-product.md      ← reference, cargada on-demand cuando la fase corre
    1-scaffold.md
    ...
```

Esto es lo que `app-builder` ya hace hoy de facto (SKILL.md + `references/`). La
feature formaliza ese shape y lo hace **managed**. El tipo de asset es distinto
en la **fuente**; en el **target** reusa el canal de discovery que ya funciona.

### 2.2 Fuente: nuevo eje `core-assets/features/`

**Decisión: las features viven en un directorio top-level `core-assets/features/<id>/`,
NO dentro de un preset.**

Una feature compone skills que pertenecen a **presets distintos** (`app-ia` es
IA de producto, `store-ship` es entrega, `astro` es un preset de stack). No puede
ser propiedad de un solo preset sin acoplarlo a todos los demás. Es un eje paralelo
a `presets/`, `agents/`, `lib-skills/`, `managed/`.

```
packages/core/core-assets/
  agents/  managed/  lib-skills/  presets/
  features/
    app-builder/
      feature.json
      FEATURE.md
      phases/*.md
```

---

## 3. Cómo se activa

**Decisión: el camino primario es project config `features[]` vía `navori add feature <id>`.**

Las features son pesadas y específicas del proyecto — no conviene tener `app-builder` en
cada repo Next.js. La activación es **opt-in explícita a nivel repo**, no heredada
del preset por default.

| Vía | Estado | Cuándo |
|-----|--------|--------|
| `features[]` en `navori.config.json` + `navori add feature <id>` | **primaria (v0.3)** | el repo opta explícitamente por la feature |
| `navori init --feature <id>` (solo `kind: bootstrap`) | **primaria (v0.3)** | proyecto nuevo desde carpeta vacía (ver §3.2) |
| `extras.features` en un preset | follow-up | un preset que *siempre* quiere una feature (raro) |
| `navori init` sugiere features según stack | follow-up | UX de descubrimiento |

### 3.1 Extensión de schema

Consistente con `SkillsSchema` (auto/optIn) y `plugins` (record de `{enabled}`),
pero arrancamos lean como un array de ids — sin config por-feature en v1:

```ts
// packages/cli/src/lib/schema.ts — NavoriConfigSchema
features: z.array(z.string()).default([]),   // ids de features activas
```

Y el eje opcional en el manifiesto de preset (`extras`), simétrico a
`managed/agents/skills/hooks`:

```jsonc
// preset.json → extras
"features": ["app-builder"]   // v0.3: solo referencia por id, la feature vive en core-assets/features/
```

Un record `{ enabled, config }` estilo plugins queda como follow-up si aparece
el caso de parametrizar una feature (ej. saltarse fases opcionales). Hoy no existe.

### 3.2 Features de bootstrap: `navori init --feature <id>`

El modelo "primero el proyecto, después la feature" tiene un huevo-y-gallina con
las features `kind: bootstrap`: app-builder existe para crear la app, pero
`navori add feature` exige un `navori.config.json` que todavía no existe. Sin un
camino bendecido, el usuario paga dos pasos de ceremonia (`init` + `add feature`)
antes de poder hacer la primera pregunta de producto.

**Decisión: `navori init --feature <id>` es el camino de primera clase para
features de bootstrap.** En una carpeta vacía, un solo comando: corre el init
normal (baseline + preset `custom` si no hay stack que detectar — no hay código
aún), agrega la feature a `features[]` y renderiza. El usuario abre Claude Code
y la fase 0 (producto) arranca antes de que exista una línea de código, que es
exactamente el orden correcto. El scaffold del stack es una fase de la propia
feature; cuando esa fase corre, `navori update` re-detecta el stack real y
ajusta el preset.

Reglas:

- `init --feature` con una feature `in-repo` → error claro (esa feature espera
  un proyecto; usa `navori add feature`).
- `add feature` con una feature `bootstrap` en un repo ya inicializado → válido
  con warning: las fases de scaffold reportan "ya existe" y se saltan por gate.
- `kind` no agrega schema nuevo en el config del repo — es metadata del
  manifiesto de la feature, el CLI la lee de `feature.json`.

---

## 4. Render + sync

Las features son **contenido managed** — mismo modelo que los bloques (`hash` +
`version`), aplicado al `SKILL.md` y a cada `phases/*.md`:

- El `SKILL.md` rendereado lleva markers managed navori; `sync` detecta drift de
  contenido (edición manual) y drift de versión (la feature avanzó) igual que
  cualquier skill managed (ver `render-managed-file.ts`).
- **`doctor`** reporta:
  - *feature drift*: `SKILL.md`/`phases/*` editados a mano fuera de markers, o
    versión del bundle desactualizada.
  - *skills sin resolver*: una fase referencia una skill id que navori no puede
    materializar (no está en el catálogo bundleado ni en `project.localSkills`).
    Warning, no error — la skill puede ser global del usuario (`~/.claude/skills/`)
    o venir de un CLI externo (`ui-skills`).
  - *invariants*: reusa el mecanismo de `spec 0003 §3.1.1` — la feature declara
    en su manifiesto strings que deben aparecer literales en el output (ej. los
    ids de fase), y falla CI si el render se comió una fase.

Provenance (si se reactiva de `0003 §3.6.2`): cada `SKILL.md`/`phases/*` declara
`plugin: "feature:app-builder"` para uninstall preciso.

---

## 5. Relación con agentes (sin runtime nuevo)

Las fases de una feature las ejecuta el **orquestador existente (leader)**. La
feature **no** trae su propio motor de ejecución: el `FEATURE.md` es el *contrato*
que el leader lee para saber, por fase, **qué skills cargar y a qué agente delegar**.

- El leader ya sabe delegar a `implementer`, `reviewer`, `researcher`, etc.
  (agentes de `spec 0002`). La feature solo mapea fase → `(skills[], model/effort)`.
- El gate por fase lo evalúa el leader con el mismo criterio que ya usa para
  cerrar un checkpoint: evidencia de comando o aprobación humana.
- Esto es idéntico al `orchestration.md` de app-builder (coordinador que delega
  fases y valida gates). Lo que cambia es que ese protocolo pasa de estar
  hardcodeado en una skill a ser el shape estándar de **toda** feature.

Consecuencia: **no** se agrega un rol de agente nuevo, ni un comando de runtime,
ni estado persistente nuevo más allá de los topic keys de Engram que la feature
ya declara por fase.

---

## 6. Costo de tokens

Alineado con `spec 0003 §2.2` y `§3.2`:

- El `SKILL.md` de la feature carga **on-demand por trigger** (description con
  triggers explícitos), nunca always-on. El always-on real es solo `name+description`
  en el índice de skills, igual que cualquier skill.
- Los `phases/*.md` son **references**: se cargan solo cuando esa fase corre, no al
  activar la feature. Una feature de 12 fases no mete 12 docs al contexto — mete uno
  por fase, cuando toca.
- **Nuevo `type: feature`** en la disciplina de output (`0003 §3.2.1`): el `FEATURE.md`
  no cabe en el cap `behavior` (≤200) ni `reference` (≤500). Se le asigna un cap
  propio (propuesta: ≤400 palabras el `SKILL.md` de orquestación — tabla de fases +
  reglas duras; el detalle vive en `phases/*`, cada uno bajo su propio cap `reference`).

---

## 7. No-goals (v1)

| No se hace | Por qué |
|------------|---------|
| Marketplace de features | Tool-for-self. Features internas al workflow Bonum. |
| Dependencias cross-feature (feature A requiere B) | Superficie especulativa; ninguna feature real lo necesita hoy. |
| Fases condicionales / DAG | Las fases son **lineales y ordenadas**. Ramas condicionales (app-builder tiene "tiers" en fase 8) se modelan *dentro* del doc de fase, no como grafo. |
| Runtime propio de feature | El leader ejecuta; ver §5. |
| Config por-feature parametrizable | `features: string[]` lean; record `{enabled,config}` es follow-up si aparece el caso. |
| `.claude/features/` como directorio discovery | Claude Code no lo carga; se renderiza como skill (§2.1). |
| Resolver skills externas (ui-skills CLI, globales) | navori solo materializa lo que bundlea; el resto es warning en doctor, no error. |

---

## 8. Plan incremental

### Fase P0 — Modelo + render (mínimo viable)

| Item | Resultado |
|------|-----------|
| Schema: `features[]` en config + `extras.features` en preset | opt-in por repo |
| `FeatureManifestSchema` (Zod) + `feature.json` de `app-builder` | fuente validada |
| Render: `core-assets/features/<id>/` → `.claude/skills/<id>/` managed | discovery on-demand |
| `type: feature` en output discipline + cap propio | tokens bajo control |

**Cierre**: `app-builder` deja de ser una skill deformada y pasa a ser la primera
feature managed, rendereada idempotente.

### Fase P1 — Sync, doctor, activación

| Item | Resultado |
|------|-----------|
| `navori add feature <id>` | activación primaria |
| Doctor: feature drift + skills sin resolver + invariants | drift atrapado |
| Sync interactivo sobre `SKILL.md`/`phases/*` | edición manual preservada |

**Cierre**: una feature se activa, se sincroniza y `doctor` reporta su salud como
cualquier otro asset managed.

### Fase P2 — Ergonomía (si hay caso)

- `navori init` sugiere features según stack detectado.
- Record `{enabled,config}` para parametrizar fases opcionales.
- Provenance por feature para `uninstall` preciso.

---

## 9. Ejemplo completo: feature `app-builder`

Manifiesto (recortado):

```jsonc
{
  "$schema": "https://navori.dev/schema/navori.feature.v1.json",
  "id": "app-builder",
  "displayName": "App builder (React Native, idea → stores)",
  "description": "Trigger: build a mobile app, app from scratch, crear una app. Phased end-to-end app creation, product definition through store-ready.",
  "type": "feature",
  "kind": "bootstrap",
  "phases": [
    { "n": 0, "slug": "product",  "objetivo": "Documento de definición de producto",
      "skills": ["cognitive-doc-design"], "gate": "usuario aprueba el documento",
      "artifacts": ["docs/product-definition.md"], "model": "fable" },
    { "n": 1, "slug": "scaffold", "objetivo": "Monorepo + app booteando",
      "skills": ["typescript"], "gate": "app bootea en device", "model": "haiku" },
    { "n": 4, "slug": "ui-nav",   "objetivo": "Navegación + pantallas core + auth",
      "skills": ["app-ia", "react-19", "typescript"], "gate": "usuario recorre flujos", "model": "sonnet" },
    { "n": 8, "slug": "web",      "objetivo": "Páginas públicas / web app",
      "skills": ["astro", "tailwind-4"], "gate": "URLs públicas live", "model": "sonnet" },
    { "n": 10, "slug": "store",   "objetivo": "Submission a stores como código",
      "skills": ["store-ship"], "gate": "eas submit OK en ambas stores", "model": "sonnet" }
  ],
  "invariants": ["0-product", "1-scaffold", "4-ui-nav", "8-web", "10-store"]
}
```

Tabla de fases resultante (subconjunto — la real tiene 12):

| # | Fase | Compone skills | Gate | Model |
|---|------|----------------|------|-------|
| 0 | Product | cognitive-doc-design | usuario aprueba doc | fable |
| 1 | Scaffold | typescript | app bootea en device | haiku |
| 4 | UI + nav | app-ia, react-19, typescript | usuario recorre flujos | sonnet |
| 8 | App web | astro, tailwind-4 | URLs públicas live | sonnet |
| 10 | Store ship | store-ship | eas submit OK | sonnet |

Rendereado a `.claude/skills/app-builder/SKILL.md` (madre, con triggers) +
`.claude/skills/app-builder/phases/{0-product,1-scaffold,…}.md`. El leader lo
carga cuando el usuario dice "crear una app", ejecuta fase por fase, y no arranca
la fase N sin el gate de N−1.

---

## 10. Referencias

- `docs/research/ponytail-lessons.md §4.4` — "skill madre + sub-skills", embrión del modelo.
- `docs/architecture.md` — modelo de 5 capas; features son un asset de Core/Preset (capas 1–2) que se activa en Project config (capa 4) y se rinde por el engine adapter (capa 5).
- `specs/0002-claude-engine-adapter.md` — agentes que ejecutan las fases.
- `specs/0003-v0.2-quality-velocity-tokens.md §3.2` — disciplina de tokens y triggers on-demand.
- `~/.claude/skills/app-builder/` — feature de referencia (shape, no contenido).
</content>
</invoke>
