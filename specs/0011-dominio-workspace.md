# Spec 0011 — Dominio: base de conocimiento del workspace

> Estado: **F1 implementado** · 2026-07-30 · Comandos `navori dominio
> init/list/show/reindex/doctor` + `inject` (machine, para el hook SessionStart)
> shippeados (`commands/dominio.ts`, `lib/dominio.ts`). F2 (export/import
> cross-máquina y `dominio export/import <repo>` para compartir vía git) pendiente.
> Alcance elegido con Ulises en sesión.
>
> Objetivo: dar un **hogar persistente y explícito** a los hechos **durables y transversales
> a un workspace** (arquitectura, reglas de negocio, migraciones, gotchas, glosario) — el tipo
> de conocimiento que hoy los agentes reaprenden mal en cada repo. Es **exclusivo del
> workspace** (no repo-local) y arranca **machine-local con export opcional a git**.

## 1. Motivación

Caso real que dispara la feature (Ulises, Bonum): hubo una **migración de modelo** — ya no
existen las entidades `coachee` y `coach`; ahora es **`user-profile.kind = coachee`**. Ese
cambio toca **nexus (backend), webapp, dashboard y mobile a la vez**. Consecuencia: los agentes
**se equivocan seguido** — asumen el modelo viejo — porque ese hecho **no tiene dónde vivir**:

- **Engram** lo puede guardar, pero es **opaco** (DB, no markdown editable), **per-usuario** y
  **scope por proyecto** — no hay un canon transversal que todos los repos del workspace vean.
- **CLAUDE.md / progress / specs** son **por-repo**: repetir el mismo hecho en N repos es
  duplicación que diverge.
- El hecho es **durable y de workspace** (aplica a toda la constelación de repos), no de una
  sesión ni de un ticket.

La tesis: existe una clase de conocimiento **"lo que es verdad sobre este negocio/arquitectura,
transversal a los repos"** que necesita un **canon curado, en markdown, inyectado en cada
sesión de cualquier repo del workspace**. Eso es el **Dominio**.

## 2. Qué es (y qué no)

**Dominio** = base de conocimiento **del workspace**, curada, en markdown plano, con **índice +
un archivo por tema**, que se **inyecta al inicio de sesión** en todos los repos miembro del
workspace.

- **Es el anti-engram donde importa**: markdown editable a mano y revisable, no una DB opaca.
- **Es transversal**: un hecho se escribe **una vez** para todo el workspace, no por-repo.
- **Es curado**: no es el firehose de la sesión; son hechos promovidos, canónicos, estables.

**No es:**

- **No es repo-local.** Se descartó el scope por-repo (decisión de sesión). El conocimiento
  específico de un repo sigue en su `CLAUDE.md` (zona de usuario) / `progress/` / engram.
- **No reemplaza a engram en bloque.** Engram sigue siendo la memoria de trabajo per-repo y el
  scratch de sesión. El Dominio se lleva **solo lo durable-y-transversal-al-workspace** (§7).
- **No es un grafo/MCP.** Es markdown + un índice + un hook de inyección. Simplicidad sobre
  cleverness (regla del proyecto).

> **Desambiguación de nombre (importante).** La palabra "dominio" ya aparece en el harness en
> dos lugares: la **zona de usuario** no-managed del `CLAUDE.md` (`marker.ts:543`, "escribe aquí
> el dominio… de tu repo") y los "errores tipados por dominio" (spec 0003). Aquí **Dominio (con
> mayúscula)** = esta base de conocimiento **del workspace**. La zona de usuario del CLAUDE.md
> sigue siendo repo-local y distinta. El comando y el skill se llaman `dominio` sin colisión de
> `id` (viven en namespaces propios: comando CLI y skill).

## 3. Decisiones ya tomadas (sesión 2026-07-30)

1. **Scope: exclusivo del workspace.** Sin dominio repo-local.
2. **Persistencia: híbrida** — fuente de verdad **machine-local** en `~/.navori/workspaces/
   <name>/dominio/` (F1). Se le suma un **protocolo de portabilidad inspirado en engram**
   (§4.2): (a) **migrar toda la config del workspace** a otra máquina/backup, y (b) **compartir**
   con el equipo vía git. Requisito explícito de Ulises: *"me gusta que sea local, pero que haya
   un comando que me ayude a migrar toda mi configuración de workspace."*
3. **Escritura: doctrina + skill.** El agente promueve por **regla del harness** (tras un
   descubrimiento durable y transversal), más un **skill `/dominio`** para curar el índice.
4. **Relación con engram (refinada en §7):** el Dominio se lleva lo durable-transversal; engram
   conserva memoria per-repo y scratch. El re-encuadre de la doctrina de engram se **difiere a
   F2** para mantener F1 puramente **aditivo** (no desestabiliza los invariantes de engram que
   `doctor` verifica).

## 4. Modelo de persistencia (híbrido)

### 4.1 Fuente de verdad (F1): machine-local, junto al workspace

Vive en `~/.navori/workspaces/<name>/dominio/`, **exactamente el mismo patrón que los
`tickets`** que ya viven ahí (`workspace.ts:163`, `writeWorkspace` crea `ticketsDir`). Se
resuelve con la maquinaria existente: `resolveWorkspaceUri("workspace://<name>/dominio/…")`
(`workspace.ts:265-274`) y `workspaceDirectory(name)` (`workspace.ts:78-80`).

```
~/.navori/workspaces/bonum/
├── workspace.json          # ya existe (name, repos[], defaults, ticketsDir)
├── tickets/                # ya existe (precedente de asset compartido)
└── dominio/                # NUEVO
    ├── DOMINIO.md          # índice — 1 línea por entrada (patrón MEMORY.md)
    ├── user-profile-model.md   # ← "coachee/coach ya no existen; kind=coachee"
    ├── auth-cross-service.md
    └── glosario.md
```

> **Por qué machine-local en F1 y no git directo:** Bonum es una **constelación de repos
> separados, sin git raíz común**. No hay un lugar git natural compartido. `~/.navori/
> workspaces/<name>/` es el **único árbol hoy compartido entre repos del mismo workspace** y ya
> tiene precedente (tickets). Arranca funcionando el día 1, cero repo-ancla que designar.
> Tradeoff aceptado: en F1 es **personal** (no lo ve el equipo) hasta el export de F2.

> **Distinción arquitectónica (evita confundirlo con la capa "workspace" de la cascada).** La
> capa 3 de las 5 capas (`docs/architecture.md:8-35`) — los `defaults` del workspace — se
> **aplana** al `navori.config.json` del repo en `init` (spec 0010 §2.1, `init.ts:222-234`): es
> una **semilla**, se copia una vez y deja de ser capa viva. El **Dominio es lo contrario: una
> capa VIVA**, no se aplana a ningún repo; se **resuelve e inyecta en cada sesión** desde el store
> del workspace. Consecuencia de diseño: el Dominio **no vive en `navori.config.json`** ni se
> materializa en `.claude/` del repo — vive solo en el store del workspace y llega por inyección
> (§6). Esto lo mantiene DRY (un hecho, un lugar) y siempre-fresco (editas el store, la próxima
> sesión ya lo ve, sin re-render).

### 4.2 Portabilidad: protocolo de export/import (inspirado en engram)

Engram resuelve **exactamente este problema** (estado machine-local que necesita viajar y
compartirse) con un protocolo de **dos niveles** que tomamos como referencia:

| Nivel de engram | Mecanismo | Análogo en navori |
|---|---|---|
| `engram export/import <file>` | Vuelca **todo** a un JSON; import lo recrea | **Migrar** (§4.2.1): `navori workspace export/import` — bundle del **árbol completo** del workspace, para máquina nueva/backup |
| `engram sync` + `.engram/` | `chunks/<hash>.jsonl.gz` + `manifest.json` (`id`, `created_by`, `created_at`) commiteados a git; import **idempotente por id** | **Compartir** (§4.2.2): `navori dominio export/import <repo>` — markdown + `manifest.json` commiteado a un repo |

**Divergencia deliberada del formato de engram.** Engram comprime a `.jsonl.gz` porque serializa
una **DB SQLite** (binaria, opaca, miles de observaciones). El Dominio de navori es **markdown
plano** — que git ya mergea bien y que el usuario quiere **leer/editar a mano** (todo el punto
anti-engram). Así que navori **NO** adopta los chunks gzip; adopta las **ideas buenas** del
protocolo:

- **`manifest.json`** con `formatVersion` + por-entrada `{ id, updated_by, updated_at, checksum }`
  (schema en §5.2) — provenance y reconciliación (igual que el manifest de chunks de engram lleva
  `created_by`).
- **Import idempotente por `id`** — aplica solo lo nuevo/cambiado, sin duplicar (como engram
  aplica los chunks que aún no ha visto).
- **Un archivo por entrada** (`<id>.md`) — dos personas agregan archivos distintos → **git no
  colisiona** (mismo truco que los chunks con nombre por hash de engram).

#### 4.2.1 Migrar toda la config del workspace (`navori workspace export/import`)

El requisito directo de Ulises. Empaqueta el **árbol completo** `~/.navori/workspaces/<name>/`
(`workspace.json` + `tickets/` + `dominio/`) en un bundle portátil (tar/zip) con un
`manifest.json` (version, created_by, created_at, contenido). `import` lo recrea en otra máquina.

> **El único dato NO portátil tal cual: `repos[]`.** El registro mapea cada repo a un **path
> absoluto canonicalizado**, machine-specific **por diseño** (`workspace.ts:214-221`, issue #76).
> `defaults` (language/engines/plugins/branchBase/…), `dominio/` y `tickets/` **sí** viajan
> limpios. Por eso `import` incluye un **paso de re-link**: recrea `defaults`+`dominio`+`tickets`
> y para `repos[]` mapea los paths a la máquina destino (reusando `navori workspace link`, que ya
> existe — `commands/workspace.ts:340`). Nunca escribe paths de otra máquina como válidos.

#### 4.2.2 Compartir el Dominio con el equipo (`navori dominio export/import <repo>`)

Para el conocimiento que **sí** quieres commitear y que el equipo le haga pull (precedente:
graphify commitea su grafo). Materializa el Dominio a `<repo>/docs/dominio/` (`docs/`, no
`.claude/`, porque **debe commitearse** — `.claude/` está gitignoreado por convención).

- **Owner** publica: `navori dominio export bonum-knowledge` → escribe `bonum-knowledge/docs/
  dominio/` (índice + `<id>.md` + `manifest.json`) + commit.
- **Compañero** consume: `navori workspace link` + `navori dominio import bonum-knowledge`
  reconstruye su `~/.navori/workspaces/<name>/dominio/` desde el `docs/dominio/` commiteado,
  **idempotente por `id`** (no pisa lo suyo si es más nuevo; reconcilia por `updated_at`).

## 5. Formato y esquemas

Espeja el patrón que ya funciona en el protocolo de memoria (índice `MEMORY.md` + un archivo por
hecho con frontmatter), pero **commiteable, curado y validado con Zod**.

### 5.1 Entrada (`<id>.md`) — la fuente de verdad

Frontmatter + cuerpo con el *porqué* y *cómo aplica*:

```markdown
---
id: user-profile-model      # = nombre de archivo (slug). Estable. Es la clave de reconciliación.
title: Modelo user-profile
type: migration             # architecture | business-rule | migration | gotcha | glossary
applies-to: [nexus, webapp, dashboard, mobile]   # repos afectados, o "all"
status: canonical           # canonical | deprecated | superseded
supersedes: []              # ids de entradas que esta reemplaza (cadena de historia)
updated: 2026-07-30
updated_by: ulises          # provenance (para import/merge, §4.2)
---

Las entidades `coach` y `coachee` **ya no existen** como colecciones/modelos separados.
Ahora es un único `user-profile` con discriminador **`kind`** (`kind=coachee`, `kind=coach`).

**Por qué:** migración de modelo <fecha/PR>. Unifica perfiles bajo una colección.
**Cómo aplica:** al tocar perfiles en cualquier repo, filtra por `user-profile.kind`, no
busques colecciones `coachees`/`coaches`. Los endpoints viejos `/coachees` están deprecados.
```

### 5.2 Esquemas (Zod), siguiendo el patrón del repo

navori no tiene dir central de schemas; cada lib define el suyo con `z.object` + `safeParse`
(lectura tolerante) y `parse` con `$schema` versionado (escritura) — ver `lib/workspace.ts:23-64`
y los *tolerant enums* forward-compat de `lib/schema.ts:17-45`. Se replica en un `lib/dominio.ts`:

- **`DominioEntrySchema`** — valida el frontmatter (arriba). `type`/`status` como `tolerantEnum`
  (descarta valores desconocidos en vez de romper, igual que el resto). `applies-to`:
  `z.array(z.string()).or(z.literal("all"))`.
- **`DominioManifestSchema`** — `{ $schema, formatVersion: 1, entries: [{ id, updated_by,
  updated_at, checksum }] }` para portabilidad (§4.2). El `$schema` lleva versión en la ruta
  (`https://ulisescm.github.io/navori-harness/schema/navori.dominio.v1.json`), como `navori.workspace.v1.json`.
- **Versionado de formato:** **no** hay sistema de migraciones de schema en navori (`navori
  migrations` es backup/restore de archivos, `commands/migrations.ts`; la compat se maneja con
  tolerant enums, no con upgrades). Por eso el Dominio versiona vía `formatVersion` + `$schema` +
  parsing tolerante — nada de migraciones aplicables hasta que se demuestre necesario.

### 5.3 Estrategia de `id`: slug legible, no hash

El `id` es un **slug kebab-case** (`user-profile-model`) que **es también el nombre de archivo**
(`user-profile-model.md`). Deliberadamente **no** un hash de contenido (como los chunks de
engram): el hash da unicidad pero **mata la editabilidad y el diff legible**, que es todo el
punto anti-engram. Reglas:

- El `id` es **estable**: renombrar el `title` no cambia el `id`. Reconciliación de import (§4.2)
  por `id` + `updated_at` (+ `checksum` para detectar cambios).
- **Colisión de slug** → sufijo `-2`. El skill valida unicidad antes de crear.
- Una entrada que **reemplaza** a otra usa `supersedes: [viejo-id]` y marca la vieja
  `status: superseded` (no se borra en silencio — la historia importa).

### 5.4 El índice es un CACHE derivable (resuelve concurrencia)

**`DOMINIO.md` no es fuente de verdad — es un índice reconstruible** desde el frontmatter de las
entradas (`title` + primer renglón del cuerpo + `status`). Esto da dos cosas:

- **Concurrencia sin locks pesados:** dos sesiones que agregan entradas escriben **archivos
  distintos** (`<id>.md`, escritura atómica vía `lib/atomic.ts:22 writeFileAtomic`) → sin
  conflicto. El único archivo compartido mutable es el índice, y como es **derivable**, se
  regenera: `navori dominio reindex` lo reconstruye desde los `<id>.md`. Si el índice queda
  desincronizado, no se pierde nada — se recomputa.
- **Doctor** puede verificar `índice == reindex(entradas)` y avisar si divergen (§9).

**Índice `DOMINIO.md`** (generado) — una línea por entrada, es lo que se **inyecta** (§6):

```markdown
# Dominio — workspace: bonum   ·   generado por `navori dominio reindex` · no editar a mano

- [Modelo user-profile](user-profile-model.md) — coach/coachee ya NO existen; es user-profile.kind
- [Auth cross-service](auth-cross-service.md) — el token de nexus se valida en sessions/calendar…
- [Glosario](glosario.md) — términos del negocio (mentee ≠ coachee, etc.)
```

## 6. Inyección al inicio de sesión

Punto de enganche: `packages/core/core-assets/hooks/session-start-context.sh` ya emite
`hookSpecificOutput.additionalContext` (`:11-16, 64-69`), inyecta branch + commits +
`progress/current.md`, y **deliberadamente NO inyecta engram** (`:18-20`, lo hace el plugin
engram). **Aquí se suma el índice del Dominio.**

### 6.1 Resolver CLI-mediado (no lógica de matching en bash)

La resolución "¿a qué workspace pertenece este `cwd`?" implica **parsear los `workspace.json` de
`~/.navori/workspaces/*/` y matchear paths absolutos canonicalizados** — demasiado frágil para
bash. Se centraliza en el CLI (testeable, una sola fuente): un subcomando
**`navori dominio inject`** que imprime el JSON `additionalContext` (índice del workspace del
`cwd`) o **nada** si no aplica. El hook lo invoca así:

```bash
# session-start-context.sh (fragmento nuevo)
# Pre-check BARATO: si no hay workspaces registrados, ni molestarse (caso 99%).
[ -d "$HOME/.navori/workspaces" ] || exit 0
# Delega la resolución al CLI; si el binario falla/no está, no rompe la sesión.
command -v navori >/dev/null 2>&1 && navori dominio inject 2>/dev/null || true
```

Decisiones de robustez:

- **Divergencia consciente de la convención "hooks sin binario".** Hoy ningún hook invoca
  `navori` (son bash puro a propósito). Aquí se justifica: la lógica de matching es genuinamente
  compleja y merece tests. Se blinda con: (a) **pre-check barato** que sale en el caso común sin
  workspace (huella-cero, §11-tests), y (b) **fallo-en-seguro** — si `navori` no está en PATH o
  falla, el hook sigue y la sesión arranca normal (`|| true`).
- **Repo en varios workspaces:** `navori dominio inject` los une (o prioriza el más específico);
  determinista, definido en TS, no en bash.
- **Solo el índice** se inyecta (no las entradas completas) — progressive disclosure.

### 6.2 Realidad multi-engine (SessionStart es Claude-only hoy)

navori es multi-engine, pero el lifecycle **SessionStart solo corre en Claude Code**:

| Engine | SessionStart | Inyección del Dominio en F1 |
|---|---|---|
| **Claude Code** | Sí (`engines/claude/adapter.ts:53` cablea hooks) | **Vía el hook (§6.1). Soporte completo.** |
| **Codex** | El hook se copia a `.codex/hooks/` pero **`build-config-toml.ts:23-51` solo cablea `PreToolUse`** — no wire-a SessionStart | **No inyecta al arranque.** Requiere cablear un evento SessionStart en `build-config-toml.ts` (F2). |
| **AGENTS.md / Cursor / Copilot** | No hay hooks — son *prose targets* (`prose-harness.ts:25-27,116-117` dropea "Claude-only concerns" a propósito) | **Sin lifecycle.** La única vía es texto estático en el managed block de prosa → snapshot en `render` (F3). |

**Decisión F1: inyección viva Claude-only.** Es donde vive el dolor (el harness de Ulises es
Claude Code). Para engines de prosa, F3 puede rendear un **snapshot estático del índice** dentro
de su managed block en `navori render` (con el costo de que queda stale hasta el próximo render —
aceptable para un índice). Codex-SessionStart es F2. Esto se documenta como límite explícito, no
como bug.

### 6.3 Presupuesto de tokens

Se inyecta **solo el índice** (1 línea por entrada). Los archivos por tema se leen **on-demand**
(vía el skill / lectura directa). Mantiene barata la inyección y respeta la doctrina de reducción
de contexto (specs 0005/0006). **Cap suave:** si el índice supera ~N entradas/líneas, `doctor`
avisa (§9) y F2 filtra por `applies-to` == repo actual (solo inyecta lo que aplica a este repo).

## 7. Doctrina + skill `/dominio`

Patrón copiado tal cual del par que ya existe para engram: **bloque managed (doctrina) + skill
inyectada en agente**, gobernado por invariantes + doctor (`engram-protocol.md` +
`engram-leader.md` + `plugin.json` invariants).

### 7.1 Skill `/dominio` (F1)

- Archivo: `packages/core/core-assets/skills/dominio.md`, frontmatter `type: behavior`.
- Registro: añadir `dominio` a `WORKFLOW_SKILLS` (`harness-assets.ts:35-39`) → aparece solo en
  el índice "Available skills" vía `buildSkillRows` (`skills-index.ts:26-70`).
- Qué gobierna: cómo **leer** (consultar el Dominio antes de asumir modelo/negocio), cómo
  **escribir** una entrada (frontmatter, índice, cuándo un hecho califica), y cómo **curar**
  (dedup, marcar `status`, actualizar en vez de duplicar).

### 7.2 Doctrina de promoción: criterios de inclusión y anti-patrones

El modo de morir de toda base de conocimiento es volverse un **basurero** (ruido que nadie lee y
que infla el contexto). La doctrina debe ser **restrictiva por defecto**. Una entrada califica
**solo si cumple las TRES**:

1. **Durable** — no cambia el próximo sprint. Un hecho estructural, no un estado transitorio.
2. **Transversal** — aplica a **≥2 repos** del workspace. Test mental: *"¿un agente en OTRO repo
   se equivocaría sin esto?"*
3. **Canónico** — es un **hecho/regla**, no una tarea, un log, ni una opinión.

**Anti-patrones (qué NUNCA va al Dominio):**

| No metas | Va en |
|---|---|
| Estado de ticket / progreso / TODOs | `progress/`, tickets |
| Scratch de sesión, notas de exploración | engram (scratch) |
| Detalle específico de **un solo** repo | `CLAUDE.md` (zona usuario) de ese repo |
| Preferencias personales / de estilo | engram `personal` / `~/.claude` |
| Algo volátil (versiones, números que cambian) | nada — o el código mismo |
| Secretos, tokens, credenciales | **nunca** (ni aquí ni en git) |

Regla de oro de tamaño: **una entrada = un hecho**, corta (el ejemplo `coachee` son ~10 líneas).
Si necesitas más de una pantalla, probablemente son varios hechos → sepáralos.

### 7.3 Curación y ciclo de vida (anti-staleness)

Un hecho canónico hoy puede dejar de serlo (la propia migración `coachee` algún día se supera).
El ciclo de vida vive en `status`:

- **`canonical`** — vigente. Es lo que se inyecta con énfasis.
- **`deprecated`** — todavía cierto pero en camino a desaparecer (ej. endpoint viejo aún vivo).
- **`superseded`** — reemplazado por otra entrada (`supersedes` apunta al reemplazo). **No se
  borra**: la cadena de historia evita que un agente "redescubra" el modelo viejo.

Reglas de curación (en el skill `/dominio`):

- **Actualizar > duplicar.** Antes de crear, busca una entrada existente del mismo tema y
  actualízala (sube `updated`/`updated_by`), no agregues una segunda.
- **Reindexar** tras cualquier cambio (`navori dominio reindex`, §5.4).
- **Detección de staleness (F3):** un scan que marca entradas cuyo cuerpo referencia símbolos/
  paths que ya no existen en los repos miembro → candidatas a revisión. Se integra con codegraph
  (spec 0009) si está disponible.

### 7.4 Relación con engram (re-encuadre — F2)

Decisión de sesión: *"dominio reemplaza engram para lo durable/commiteado."* Refinada al scope
workspace-exclusivo, queda **quirúrgica**: el Dominio se lleva lo **durable-transversal**;
engram conserva **memoria de trabajo per-repo** y **scratch de sesión**. En F2 se re-encuadra la
doctrina de engram (puntos exactos de edición: `engram-protocol.md:5-9`,
`engram-leader.md:11`, invariantes en `plugin.json:34`, referencias en `ticket-intake.md` /
`structural-search.md`) para que, **cuando el repo es miembro de un workspace con Dominio**,
"lo durable-transversal va al Dominio" en vez de a `mem_save`.

> **Por qué diferir el re-encuadre a F2:** tocar `plugin.json:34` `invariants: ["mem_save",
> "mem_session_summary"]` sin cuidado hace **fallar `doctor`** (`scanMissingInvariants`). F1 se
> mantiene **puramente aditivo** (filosofía de la spec 0010 §2.3): añade el Dominio y su
> inyección **sin tocar** la doctrina de engram. El caso `coachee` ya queda resuelto en F1 solo
> con agregar + inyectar.

## 8. Comandos `navori dominio <sub>`

Namespace nuevo, apoyado en la maquinaria de `workspace` (`commands/workspace.ts`):

| Comando | Fase | Qué hace |
|---|---|---|
| `navori dominio init [--workspace <name>]` | F1 | Crea `~/.navori/workspaces/<name>/dominio/` + `DOMINIO.md` vacío. Idempotente. Resuelve el workspace del `cwd` si no se pasa `--workspace`. |
| `navori dominio list` | F1 | Lista las entradas del Dominio del workspace activo (lee el índice). |
| `navori dominio show <entry>` | F1 | Imprime una entrada. |
| `navori dominio reindex` | F1 | Reconstruye `DOMINIO.md` (el índice) a partir de los archivos de entrada. |
| `navori dominio doctor` | F1 | Valida: índice existe, cada entrada del índice tiene su archivo (y viceversa), frontmatter válido, coherencia con el `manifest.json`. |
| `navori dominio inject` | F1 | **Comando de máquina** (lo llama el hook SessionStart): emite el índice del Dominio del workspace del `cwd` a stdout. Nunca lanza. |
| `navori workspace export <name> [--out <bundle>]` | F2 | **Migración/backup.** Empaqueta el árbol completo del workspace (`workspace.json`+`tickets/`+`dominio/`) + `manifest.json` (§4.2.1). |
| `navori workspace import <bundle>` | F2 | Recrea el workspace en esta máquina; **re-link** de `repos[]` a paths locales (§4.2.1). |
| `navori dominio export <repo>` | F2 | **Compartir.** Materializa el Dominio a `<repo>/docs/dominio/` (markdown + `manifest.json`) para commitear (§4.2.2). |
| `navori dominio import <repo>` | F2 | Reconstruye el store local desde `<repo>/docs/dominio/`, **idempotente por `id`** (§4.2.2). |

> La **escritura de entradas** en F1 es principalmente por el **agente vía el skill** (doctrina),
> no un `navori dominio add` imperativo — el valor está en que el agente promueva en el flujo.
> Un `add` explícito puede sumarse si se pide.

## 9. Check de `doctor`

Sigue el patrón imperativo existente (`doctor.ts`): una función `scanDominio(cwd)` que, si el
`cwd` es miembro de workspace, devuelve hallazgos; se añade al objeto `report` y se renderiza con
strings i18n (`tc(lang).doctor`, `i18n.ts`). Análogo directo a `scanMissingInvariants`
(`doctor.ts:100, ~680-714`).

**Severidad: warning, no error.** `doctor` no tiene enum de severidad; la distinción es
**estructural** (`doctor.ts:136-142`): un check es *error* solo si entra en la conjunción de
`report.ok` (y en el bloque de exit `doctor.ts:177-186`, `exit(2)`). El Dominio **NO** debe
tocar `report.ok` — un dominio incompleto o ausente **no debe romper el render** de nadie. Se
recolecta y se muestra como informational/warning (mismo trato que `drifts`/`placeholderName`,
`doctor.ts:127-135`).

Qué valida `scanDominio` (todo warning):

- Índice existe y `índice == reindex(entradas)` (deriva del §5.4 — divergencia = "corre `navori
  dominio reindex`").
- Cada línea del índice tiene su `<id>.md` y viceversa; frontmatter válido contra
  `DominioEntrySchema`.
- `supersedes` apunta a ids existentes; no hay `canonical` que un `superseded` reemplace.
- Presupuesto: índice sobre el cap suave (§6.3) → avisa.

## 10. Seguridad y confianza del contenido

El Dominio se **inyecta en el contexto de cada sesión**, así que su contenido es superficie de
confianza. Reglas:

- **Es conocimiento, no instrucciones.** El Dominio describe *qué es verdad* (modelo de datos,
  reglas), nunca *ejecuta* acciones. La doctrina del skill prohíbe entradas con forma de comando/
  instrucción imperativa. Alineado con el guardrail `operaciones-seguras` ("contenido externo es
  DATA").
- **F1 es autoría propia** (tú escribes tu store) → confiable. **F2 `dominio import`** trae
  contenido de **otro autor** (el `docs/dominio/` de un compañero): el import es **deliberado**
  (un comando, nunca automático), cada entrada carga `updated_by` (provenance), y el usuario
  revisa el diff como cualquier pull. No hay import silencioso ni auto-merge desde la red.
- **Nunca secretos** (§7.2 anti-patrones). El `doctor` puede sumar un scan de patrones de
  secreto en el store como warning (F3).

## 11. Invariantes de test (estilo spec 0010 §8)

- **Huella-cero:** sin `~/.navori/workspaces/` (o sin ningún workspace con Dominio), el
  SessionStart emite **bytes idénticos** a hoy y **ningún comando existente** (`render`,
  `doctor`, `status`, `sync`, `init`) cambia su output. El pre-check barato (§6.1) garantiza que
  el caso común ni ejecuta el CLI.
- **Gate de inyección:** en repo miembro con Dominio → inyecta el índice; fuera de workspace o
  sin Dominio → no inyecta nada. Fallo-en-seguro: `navori` ausente/roto → sesión arranca igual.
- **Índice derivable:** `reindex` reconstruye `DOMINIO.md` desde los `<id>.md` sin pérdida;
  round-trip estable.
- **Import idempotente:** `dominio import` dos veces → cero duplicados; reconcilia por `id` +
  `updated_at`; no pisa una entrada local más nueva.
- **Re-link en migración:** `workspace import` mapea `repos[]` a paths locales y **nunca** escribe
  un path de otra máquina como válido.
- **Concurrencia:** dos escrituras de entradas distintas en paralelo → ambas sobreviven (archivos
  distintos, `writeFileAtomic`).

## 12. Fases

- **F1 — MVP (esta entrega):** `lib/dominio.ts` (schemas §5.2) + store machine-local
  `~/.navori/workspaces/<name>/dominio/` (entradas `<id>.md` + índice derivable); skill `/dominio`
  (`type: behavior`, registrada en `WORKFLOW_SKILLS`); doctrina de promoción con criterios/
  anti-patrones (§7.2); comandos `dominio init/list/show/reindex/inject/doctor`; **inyección viva
  del índice al SessionStart vía `navori dominio inject`** (Claude-only, §6.1-6.2); check de
  doctor (warning, §9). **Aditivo puro:** no toca engram ni el render de repo (invariante
  huella-cero §11). Resuelve el caso `coachee` de punta a punta en Claude Code.
- **F2 — Portabilidad + compartir + re-encuadre de engram:** protocolo de export/import estilo
  engram (§4.2) — `workspace export/import` (migrar toda la config, con re-link de `repos[]`) y
  `dominio export/import <repo>` (compartir por git, `manifest.json` + import idempotente por
  `id`); re-encuadre quirúrgico de la doctrina de engram (§7.4) para repos de workspace; filtrado
  del índice por `applies-to` == repo actual (§6.3); Codex SessionStart (cablear en
  `build-config-toml.ts`).
- **F3 — Curación asistida + prosa:** detección de entradas stale (referencian código que ya no
  existe, vía codegraph); promoción sugerida desde engram/progress; snapshot estático del índice
  en managed block de prosa para AGENTS.md/Cursor/Copilot (§6.2); scan de secretos (§10);
  posible `doctor` cross-scope.

## 13. No-objetivos / descartado

- **Dominio repo-local:** descartado (decisión de sesión). Conocimiento de un solo repo → su
  `CLAUDE.md`/`progress`/engram.
- **Reemplazar engram en bloque:** no. Solo se lleva lo durable-transversal-al-workspace (§7.4).
- **Grafo/MCP/embeddings:** fuera. Markdown + índice + hook. Reproducible y simple.
- **Chunks gzip como los de engram:** descartado — reintroducen opacidad; el punto es markdown
  editable (§4.2, §5.3).
- **Migraciones de schema aplicables:** fuera — navori no las tiene (`navori migrations` es
  backup/restore); se versiona con `formatVersion` + `$schema` + parsing tolerante (§5.2).
- **Inyección viva en engines de prosa (AGENTS.md/Cursor/Copilot):** fuera de F1 — no tienen
  lifecycle; snapshot estático es F3 (§6.2).
- **Commit directo a git en F1:** diferido a F2 (no hay git raíz común en una constelación).
- **`navori dominio add` imperativo en F1:** el valor está en la promoción por doctrina del
  agente; un `add` explícito es opcional.

## 14. Riesgos y decisiones abiertas

- **Machine-local no se comparte ni migra hasta F2.** En F1 el Dominio es personal y vive solo en
  esta máquina. Aceptado: resuelve el dolor inmediato (agentes que se equivocan) ya; el protocolo
  de portabilidad (migrar/compartir, §4.2) es F2.
- **Formato de portabilidad: markdown+manifest vs chunks-gzip de engram.** Recomendación:
  markdown plano + `manifest.json` (no gzip), para no reintroducir opacidad y aprovechar que git
  ya mergea markdown (§4.2). Si se prefiere el formato exacto de engram (chunks), es una decisión
  a tomar — pero pierde la editabilidad a mano, que es el punto.
- **Re-link de `repos[]` en la migración.** El paso más delicado del `workspace import`: los paths
  absolutos son machine-specific (#76). Debe mapear/preguntar, nunca asumir paths de otra máquina.
- **Inyección para un compañero sin store local:** hasta que exista `dominio import` (F2), un
  compañero no recibe la inyección aunque el `docs/dominio/` esté commiteado. F2 lo cierra.
- **Tamaño del índice / tokens:** se inyecta solo el índice; si crece, filtrar por `applies-to`
  (F2). Vigilar el presupuesto (specs 0005/0006).
- **Colisión de nombre "dominio":** mitigada por desambiguación (§2) — vigilar que la doc no
  confunda la zona de usuario del CLAUDE.md con el Dominio de workspace.
- **Invariantes de engram en doctor:** el re-encuadre de F2 debe ajustar `plugin.json:34` y
  `scanMissingInvariants` juntos, o `doctor` falla.
- **Hook con dependencia del binario `navori` (§6.1):** rompe la convención actual de "hooks en
  bash puro". Mitigado con pre-check barato + fallo-en-seguro (`|| true`), pero es una decisión de
  diseño a validar. Alternativa (peor): reimplementar el matching de paths en bash.
- **Cobertura multi-engine desigual (§6.2):** en F1 la inyección viva es **Claude-only**. Codex
  (F2) y prosa (F3) llegan después. Riesgo de percepción ("mi Dominio no aparece en Cursor") →
  documentarlo como límite conocido, no bug.
- **El Dominio como basurero:** el riesgo #1 de toda KB. Mitigado por doctrina restrictiva +
  anti-patrones (§7.2) + `status`/curación (§7.3), pero requiere disciplina; vigilar en la
  práctica y ajustar el skill si crece ruido.
- **`navori dominio` vs `navori workspace dominio`:** decidir si el namespace es top-level
  (`navori dominio`) o subcomando de workspace (`navori workspace dominio`). Recomendación:
  top-level por ergonomía (`/dominio` es un concepto de primera clase), reusando el core de
  resolución de workspace.
