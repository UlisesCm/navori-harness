# Spec 0005 — Scope global + modo ambiente

> **Estado**: draft.
> **Objetivo de release**: v0.4.0 (después de features 0004).
> **Framing**: navori es tool-for-self. Hoy navori es "harness donde ya estuve,
> no harness donde estoy": en una máquina limpia `~/.claude` queda vacío y toda
> la identidad (idioma-rol, engram, ponytail, permisos) se duplica repo por repo.
> Este spec le da a navori un **segundo scope** (la persona, no solo el proyecto)
> y hace que el harness **se mantenga solo** sin dejar de exigir consentimiento
> para escribir.
> **Origen**: este spec **eleva §4.5 y §4.7 de `ponytail-lessons` a ciudadanos de
> primera**. §4.5 (hooks SessionStart/statusline, P1) era "valor concreto para el
> plugin schema"; aquí es el motor del modo ambiente. §4.7 (config cascade
> `env > ~/.config > default`, P2) era "hasta que alguien pida override personal";
> aquí el override personal ES el producto. También materializa §4.19 ("global
> config + project config sin colisión") que quedaba en P3 "solo documentar".

---

## 0. Resumen ejecutivo

Dos mitades, un objetivo: que navori acompañe donde estás, no solo donde estuviste.

- **Mitad 1 — Scope global.** navori rendea un **segundo target**: `~/.claude/` (la
  identidad de la persona), no solo el `CLAUDE.md`+`.claude/` del repo. Fuente de
  verdad: `~/.navori/global.json` (sibling de `~/.navori/workspaces/` y los backups
  que ya viven ahí). Cada bloque y plugin declara un `scope` (`global | repo |
  either`) y cada render filtra por él. La identidad deja de duplicarse.
- **Mitad 2 — Modo ambiente.** Un hook `SessionStart` corre `navori status --json`
  en silencio e inyecta **una línea** **solo si hay algo que decir** (drift, update,
  colisión de scope, o un repo project-shaped sin navori) para que el agente ofrezca
  el fix. Los comandos siguen siendo la API explícita; el ambiente solo los sugiere.

Regla dura que cruza todo el spec: **detectar y ofrecer es automático; escribir
siempre requiere consentimiento**. Un scaffolder que se auto-instala es malware con
buenas intenciones.

---

## 1. Motivación y problema

El dolor es concreto y cotidiano:

1. **Máquina limpia = harness vacío.** `npm i -g navori` no deja nada en
   `~/.claude`. Cada repo nuevo re-materializa idioma-rol, protocolo engram,
   protocolo ponytail y la allowlist de permisos. Es la copia N-veces que navori
   existe para eliminar (`ponytail-lessons §4.2`), pero a nivel persona.
2. **Colisión con un `~/.claude` hecho a mano.** Un usuario con su propio
   `~/.claude/CLAUDE.md` (protocolo de orquestación artesanal) + cualquier repo
   rendereado por navori termina con **dos protocolos de orquestación
   promediándose** en la misma sesión — Claude Code carga ambos archivos. Es
   exactamente la colisión que `blocks.exclude` (PR #116) parcha **desde el repo**;
   nada la parcha **desde el lado global**.
3. **Mantenimiento manual.** `doctor` / `sync` / `init` son comandos que la gente
   olvida hasta que algo se rompe. El harness no se avisa a sí mismo.

`rootOnly` (issue #70) ya insinúa la solución: hay bloques (`idioma-rol`,
`orquestacion`…) marcados como "no dupliques esto en cada workspace del monorepo".
Ese flag es el embrión de un **scope**. Este spec lo generaliza de "root vs
workspace del monorepo" a "persona vs proyecto".

---

## 2. Mitad 1 — Scope global

### 2.1 `navori global init`

Wizard corto, **sin stack detection** (no hay stack en la persona):

1. idioma / rol.
2. plugins de scope global (engram, ponytail — los que declaran `allowedScopes`
   incluyendo `global`).
3. allowlist de permisos.
4. engines (gateado por capabilities, §2.5).

Escribe `~/.navori/global.json` (**source of truth**) y rendea `~/.claude/` con la
**misma maquinaria de marcadores/hash/backup** que el repo, apuntada a otra raíz:

- `~/.claude/CLAUDE.md` — solo bloques `scope: global`.
- `~/.claude/settings.json` — permisos (deep-merge, misma lógica que el repo).
- `~/.claude/skills/…` — skills globales.

**Adopción de un `~/.claude` artesanal.** Reusa el flujo coexist/replace-with-backup
que `init` ya tiene: el contenido existente se preserva como **user-section**
(fuera de marcadores, intocable) y solo las partes estandarizables se vuelven
managed. La adopción nunca destruye: primero backup (política de 30 días), después
inyecta marcadores **alrededor** de lo que había.

### 2.2 Contrato de scope

**Decisión.** Cada bloque managed y cada plugin declaran `scope` como metadata del
manifest. Es la generalización de `rootOnly`:

| Categoría | Bloques | Scope |
|---|---|---|
| **Identidad (persona)** | `idioma-rol`, `formato-respuesta`, `arranque-sesion`, `cierre-sesion`, protocolo engram, protocolo ponytail, permisos | `global` |
| **Proceso / stack (proyecto)** | `orquestacion`, `sdd`, `tipado-fuerte`, presets, gates (jscpd/semgrep/cognitive) | `repo` |
| **Ambiguo (raro)** | `operaciones-seguras` (guard universal que el repo puede endurecer) | `either` |

- El render en cada scope **filtra por `scope`**: el render global emite solo
  `global` (+ `either`); el render repo emite solo `repo` (+ `either`).
- Los plugins declaran `allowedScopes: ["global"] | ["repo"] | ["global","repo"]`.
  `engram`/`ponytail` → `["global"]` (identidad); `jscpd`/`semgrep` → `["repo"]`.
- `either` es el único caso donde ambos targets podrían emitir el mismo id; ahí
  gana la posición de cascada (§2.3) y el doctor vigila (§2.4).

### 2.3 Posición en la cascada — **decisión**

La cascada actual (`docs/architecture.md`) es de 5 capas:
`core → preset → workspace → project → engine`.

**Decisión: global se inserta entre Workspace y Project.**

```
core → preset → workspace → GLOBAL → project → engine
                  (org)     (persona)  (repo)
```

Rationale en dos partes:

1. **Precedencia por especificidad.** La persona (global) es más específica que la
   org (workspace) pero menos que un repo puntual (project). Para cualquier bloque
   elegible en varios scopes, **project overridea global, global overridea
   workspace**. `workspace = org, global = persona`: perteneces a una org, tu
   identidad personal especializa los defaults de la org.
2. **Global no es solo una capa de composición: es un segundo render TARGET.** El
   contrato de scope (§2.2) parte cada bloque a exactamente un scope, así que en la
   práctica global y project **nunca emiten el mismo id** — Claude Code fusiona
   `~/.claude/CLAUDE.md` + el `CLAUDE.md` del repo en runtime, y navori **garantiza
   que no se pisen**. La posición de cascada solo decide precedencia para los raros
   `scope: either` y para heredar defaults (un repo puede leer defaults de la
   persona para campos que no setea).

No debajo de core: core son los defaults de navori, global los de la persona (la
persona especializa la herramienta, no al revés). No encima de workspace: donde
identidad de persona y convención de org se solapan (ej. idioma), la persona gana
→ más específica → debajo.

### 2.4 Doctor cross-scope (la killer feature)

`doctor` pasa a ver **las dos capas a la vez**: lee `~/.claude` **y** el repo.
Detecta:

- **Mismo id activo en ambos** (colisión de duplicación) — ej. `idioma-rol`
  rendereado en `~/.claude/CLAUDE.md` **y** en el repo.
- **Placement que viola scope** — ej. un bloque `scope: global` presente en el
  repo, o un `scope: repo` en `~/.claude`.

Salida: warning con **sugerencia concreta y accionable**:

```
⚠ colisión de scope: 'idioma-rol' activo en ~/.claude Y en ./CLAUDE.md
  → este bloque es scope:global. Elige una fuente:
    • repo-side:  agrega "idioma-rol" a blocks.exclude (per PR #116)
    • global-side: navori global sync --remove idioma-rol
  Recomendado: excluir en el repo (la identidad vive en ~/.claude).
```

`blocks.exclude` (la válvula de #116, con `EXCLUDABLE_BLOCK_IDS` = todos los core y
`SECURITY_BLOCK_IDS` para los de postura de seguridad) es exactamente el mecanismo
repo-side que el doctor sugiere. Este spec agrega la **contraparte global-side**.

`navori global sync` / `global doctor` / `global status` **espejan** los comandos
del repo, apuntados a `~/.navori/global.json` + `~/.claude`.

### 2.5 Gate EngineCapabilities

El scope global es **per-engine**: Claude Code tiene nivel usuario (`~/.claude`);
un engine sin nivel usuario (p.ej. un adapter instruction-only) **se saltea**.
Esto conecta con `ponytail-lessons §4.1`: el `EngineCapabilities` model gana un
flag nuevo `userScope: boolean`. `navori global init` solo rendea para engines con
`userScope: true`; para el resto, no-op con nota. (Dependencia: §4.1 hoy es
propuesta, no está construido — ver tensiones en el PR.)

---

## 3. Mitad 2 — Modo ambiente

El harness se mantiene solo; los comandos siguen siendo la API explícita.

### 3.1 Hook SessionStart (rendereado por navori en settings)

navori rendea en `settings.json` un hook que corre `navori status --json` en
silencio (**<500ms**, per targets de spec 0003 §3.3) e inyecta **una sola línea**
de `additionalContext` **solo cuando hay algo**:

- drift managed detectado,
- update disponible (bundle avanzó),
- colisión de scope (§2.4),
- directorio project-shaped sin `navori.config.json` (nudge, §3.3).

Ejemplo de la única línea inyectada:

```
navori: hay drift en 2 bloques managed. Ofrece al usuario correr `navori sync`.
```

El agente entonces ofrece el fix **conversacionalmente** ("¿corro `navori sync`?").
Si no hay nada, el hook **no inyecta nada** (disciplina de contexto de spec 0003
§3.2.6: silencio por default).

- **Matchers**: `startup|resume|clear|compact` (per §4.5: sin `resume|compact` el
  estado se pierde a mitad de sesión — bug clase entera).
- **Wrapping defensivo**: `command -v node >/dev/null 2>&1 && … || exit 0`
  (per §4.5 y spec 0003 §3.6.4). Nunca romper un SessionStart.

### 3.2 Política de auto-sync

**Decisión.** Knob de config `sync.auto`:

| Valor | Comportamiento |
|---|---|
| `"clean-blocks"` (default) | Bloques con **hash intacto** (nunca editados a mano) se auto-actualizan al SessionStart. Los backups de 30 días lo hacen zero-risk. |
| `"never"` | Nunca auto-sync; el hook solo avisa. |
| `"all"` | Auto-sync también de bloques editados (agresivo, opt-in explícito). |

Regla invariante: **un bloque con hash divergente (editado a mano) SIEMPRE
pregunta**, sin importar `sync.auto`. El auto-sync solo toca lo que navori sabe que
nadie tocó.

### 3.3 Nudge de init (hard rule)

El hook detecta un directorio **project-shaped** (`package.json`, `pyproject.toml`,
`go.mod`, `Cargo.toml`…) **sin** `navori.config.json` → inyecta un nudge → el
agente **ofrece** `navori init --recommended`.

**HARD RULE (va literal en el spec):** la detección y el ofrecimiento son
automáticos; **las escrituras siempre requieren consentimiento del usuario**. Un
scaffolder que se auto-instala es **malware con buenas intenciones**. El hook nunca
corre `init`; solo pone la oferta en boca del agente, que espera el sí.

### 3.4 Statusline badge (opcional, declarativo)

Generalización del statusline pattern de ponytail (§4.5). Declarativo: navori genera
el script a partir de una descripción, no a mano.

```
[navori ✓]          — todo en orden
[navori drift:2]     — 2 bloques con drift
[navori update]      — bundle avanzó
[navori ⚠scope]      — colisión cross-scope
```

Opt-in: `navori global init` ofrece configurarla (self-onboarding, §4.5); el
usuario acepta o no.

---

## 4. No-goals (v1)

| No-goal | Por qué |
|---|---|
| **Multi-machine sync** (dotfiles manager) | navori no es un gestor de dotfiles. `~/.navori/global.json` es local; sincronizarlo entre máquinas es problema del usuario (git, chezmoi, lo que sea). |
| **Auto-writes sin consentimiento — jamás** | Ver §3.3. Ni una escritura sin sí explícito. |
| **Scope global para engines non-Claude** | Gateado por `EngineCapabilities.userScope` (§2.5). Follow-up cuando otro engine con nivel usuario entre al workflow real. |
| **Telemetría** | El status es local; nada se reporta a ningún lado. |
| **Features a scope global** | Las features (spec 0004) siguen **repo-scoped**: un workflow multi-fase opera sobre un proyecto, no sobre la persona. `allowedScopes` de features = `["repo"]`. |

---

## 5. Plan incremental

### Fase P0 — Scope metadata + global init + render

| Item | Resultado |
|---|---|
| §2.2 campo `scope` en bloques + `allowedScopes` en plugins | Cada asset sabe a qué target pertenece |
| §2.3 global como capa de cascada (target `~/.claude`) | Engine parametrizado por layout de scope |
| §2.1 `navori global init` + render a `~/.claude` | Máquina limpia deja de estar vacía |
| §2.1 adopción de `~/.claude` artesanal (coexist/backup) | Migración no destructiva |

**Cierre P0**: en una máquina limpia, `navori global init` deja identidad en
`~/.claude`; un repo nuevo ya no la duplica.

### Fase P1 — Doctor cross-scope + hook de status

| Item | Resultado |
|---|---|
| §2.4 doctor lee ambas capas + sugiere `blocks.exclude` / global-side | Colisión detectada y remediable |
| §2.4 `global sync/doctor/status` espejo | Paridad de comandos |
| §3.1 hook SessionStart `navori status --json` (una línea) | El harness se avisa |

**Cierre P1**: la colisión de la Motivación §1.2 se detecta sola y el doctor dice
exactamente qué correr.

### Fase P2 — Auto-sync + nudge + statusline

| Item | Resultado |
|---|---|
| §3.2 `sync.auto: clean-blocks` | Bloques limpios se actualizan solos |
| §3.3 nudge de init (con hard rule de consentimiento) | Repos sin navori se ofrecen, nunca se auto-instalan |
| §3.4 statusline badge declarativo | Estado visible sin correr comandos |

**Cierre P2**: el harness se siente vivo — te avisa, se ofrece, se mantiene — sin
escribir nunca sin permiso.

---

## 6. Ejemplo completo

**Máquina limpia → identidad global:**

```
$ npm i -g navori
$ navori global init
  ? idioma / rol → es / senior architect
  ? plugins globales → engram, ponytail
  ? permisos (allowlist) → [git, gh, npm, rg, fd, …]
  ? engines → claude (userScope ✓)
  ✓ ~/.navori/global.json  (source of truth)
  ✓ ~/.claude/CLAUDE.md     (solo bloques scope:global: idioma-rol, engram, ponytail)
  ✓ ~/.claude/settings.json (permisos)
```

**Repo nuevo → CLAUDE.md más liviano:**

```
$ cd ~/dev/nuevo-repo && navori init --recommended
  … detecta stack nextjs
  ✓ CLAUDE.md — proceso/stack (orquestacion, sdd, tipado-fuerte, gates)
    identidad NO duplicada: la hereda de ~/.claude en runtime
```

**Escenario de colisión (usuario con `~/.claude` artesanal previo):**

```
$ navori doctor
  ⚠ colisión de scope: 'orquestacion' activo en ~/.claude Y en ./CLAUDE.md
    tu ~/.claude (hecho a mano) trae su propio protocolo de orquestación;
    navori rendea el suyo en el repo → dos protocolos promediándose.
    → este bloque es scope:repo. La identidad de ~/.claude no debería
      orquestar. Opciones:
        • prefiere navori en el repo: quita la orquestación de ~/.claude
        • prefiere la tuya: agrega "orquestacion" a blocks.exclude (PR #116)
```

**Flujo ambiente diario:**

```
[nueva sesión en el repo]
  hook SessionStart → navori status --json (120ms) → hay update en 'sdd'
  agente: "El bloque sdd avanzó de v0.3.1 a v0.4.0. ¿Corro `navori sync`?"
  usuario: "sí, hazlo"
  → sync actualiza solo el bloque limpio, backup previo. Statusline: [navori ✓]
```

---

## 7. Decisiones tomadas

| Pregunta | Decisión | Implicaciones |
|---|---|---|
| **Q1** ¿Dónde vive la source of truth global? | `~/.navori/global.json` | Sibling de `~/.navori/workspaces/` y backups que ya existen. Misma maquinaria marker/hash/backup, otra raíz. |
| **Q2** ¿Global es capa nueva o target nuevo? | **Ambas**: capa entre workspace y project **+** segundo render target (`~/.claude`) | El scope contract garantiza no-overlap; la cascada solo decide `either` y herencia de defaults. |
| **Q3** ¿Qué es identidad vs proceso? | Identidad → `global`; proceso/stack → `repo`; `operaciones-seguras` → `either` | §2.2. Generaliza el `rootOnly` de #70. |
| **Q4** ¿Auto-sync por default? | `clean-blocks` (solo hash intacto) | Bloques editados siempre preguntan. 30-day backups = zero-risk. |
| **Q5** ¿El nudge puede escribir? | **Nunca sin consentimiento** | Hard rule §3.3. Detectar/ofrecer automático; escribir jamás. |
| **Q6** ¿Global para todos los engines? | Solo con `EngineCapabilities.userScope` | Claude sí; el resto se saltea (§2.5). |

---

## 8. Referencias

- `docs/architecture.md` — cascada de 5 capas que este spec extiende a 6.
- `docs/research/ponytail-lessons.md` §4.5 (hooks SessionStart/statusline, P1→P0),
  §4.7 (config cascade env>file>default, P2→P0), §4.19 (global+project sin
  colisión, P3→materializado), §4.1 (`EngineCapabilities`, dependencia).
- PR #116 (`fix/hook-gates-and-block-exclude`) — `blocks.exclude` /
  `EXCLUDABLE_BLOCK_IDS` / `SECURITY_BLOCK_IDS`: la válvula repo-side que el doctor
  cross-scope sugiere. Este spec agrega la contraparte global-side.
- `specs/0001-monorepo-render-per-workspace.md` — el `rootOnly` (#70) y el modelo de
  render por raíz parametrizada son la base técnica del segundo target.
- `specs/0003-v0.2-quality-velocity-tokens.md` §3.3 (perf <500ms), §3.2.6
  (disciplina de contexto en hooks), §3.6.4 (hooks defensivos).
- `specs/0004-features.md` — sibling; las features quedan repo-scoped (no-goal §4).

---

## 9. Cierre

navori deja de ser "harness donde ya estuve" para ser "harness donde estoy": la
identidad vive una sola vez en la persona, el proceso en cada repo, y el harness se
avisa a sí mismo sin escribir jamás sin permiso. El scope global no es una feature
nueva grande — es reconocer que ya había **dos** lugares donde navori tenía que
rendear, y que hasta ahora solo atendía uno.
