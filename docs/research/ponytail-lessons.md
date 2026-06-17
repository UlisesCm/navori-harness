# Lecciones de ponytail para navori

> Auditoría del repo [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail)
> (commit en `main`, snapshot 2026-06-15) desde la perspectiva de navori.
>
> El objetivo no es copiar ponytail — es destilar las decisiones de diseño y
> tácticas operativas que nos ahorran semanas de iteración propia y nos sirven
> como sanity check de los modelos que ya definimos en `specs/0001`/`0002`.

---

## TL;DR

Ponytail es un plugin/skill mono-propósito que entrega **una sola regla**
("modo dev lazy / YAGNI") a **13 harnesses de agentes distintos** desde un solo
repo. No es un scaffolder como navori: es el **contenido** que un scaffolder
distribuiría. Comparten audiencia, no producto.

Las tres cosas que más nos importan, en una línea cada una:

1. **Confirma el modelo "plugin = bundle (skill + commands + hooks + manifest por engine)"** que ya pusimos en core; lo ejecutan exacto y con menos abstracción.
2. **Su `scripts/check-rule-copies.js` es el dolor que justifica navori** — están parchándolo con un guardián de CI en vez de un source-of-truth. Es exactamente el wedge.
3. **Su separación entre adaptadores con hooks y adaptadores "instruction-only"** es una clasificación que nuestro core ya necesita declarar y rendear distinto, y aún no lo hicimos explícito.

Todo lo demás (modos lite/full/ultra, statusline, sub-skills, benchmark
reproducible, marca) son ideas individuales que se pueden aplicar selectivamente
sin tocar la arquitectura.

---

## 1. Qué es ponytail (contexto)

- **Producto:** plugin de "lazy senior dev mode" — fuerza al agente a recorrer una escalera YAGNI (¿existe en stdlib? ¿es feature nativa? ¿es una línea?) antes de escribir cualquier código.
- **Forma:** una skill principal (`ponytail`) + 4 sub-skills (`-review`, `-audit`, `-debt`, `-help`) + 5 commands TOML + 2 hooks Node + adaptadores por engine.
- **Distribución:** 13 hosts soportados — Claude Code, Codex, OpenCode, Gemini/Antigravity CLI, Copilot CLI, Pi, Cursor, Windsurf, Cline, Kiro, Aider, VS Code+Codex, y `AGENTS.md` genérico.
- **Madurez:** versión 4.6.0, tests por engine (`tests/*.test.js`), CI con `npm test`, marca consistente (logo, tagline "He says nothing. He writes one line. It works."), benchmark reproducible con promptfoo.
- **Tamaño total:** ~100 archivos en `main`. No es gigante. Es denso.

Lo más útil para nosotros: cada engine tiene **su propia carpeta o archivo**, y
todos apuntan al mismo `skills/` + `hooks/` físicos por symlink lógico (ruta
relativa). Es decir: **la fuente es una, los adaptadores son delgados**. Esa es
exactamente la regla que dejamos en `docs/agent-portability.md` de su lado
("Adapter Rule: Keep adapters thin").

---

## 2. Mapa rápido del repo ponytail

```
.
├── skills/
│   ├── ponytail/SKILL.md           # skill madre, lazy senior dev
│   ├── ponytail-review/SKILL.md    # review diff por over-engineering
│   ├── ponytail-audit/SKILL.md     # audit repo entero
│   ├── ponytail-debt/SKILL.md      # cosecha comentarios `ponytail:`
│   └── ponytail-help/SKILL.md
├── commands/
│   └── *.toml                      # 5 commands (Claude Code TOML format)
├── hooks/
│   ├── hooks.json                  # Claude Code
│   ├── copilot-hooks.json          # Copilot CLI
│   ├── ponytail-activate.js        # SessionStart
│   ├── ponytail-mode-tracker.js    # UserPromptSubmit
│   ├── ponytail-instructions.js    # build de instrucciones por modo
│   ├── ponytail-config.js          # resolver env/config/default
│   ├── ponytail-runtime.js         # adapter Claude/Codex/Copilot
│   ├── ponytail-statusline.sh
│   └── ponytail-statusline.ps1
├── .claude-plugin/{plugin,marketplace}.json
├── .codex-plugin/plugin.json
├── .github/plugin/{plugin,marketplace}.json    # Copilot CLI
├── .opencode/{plugins,command}/
├── pi-extension/                   # npm package extension para Pi
├── gemini-extension.json
├── .agents/plugins/marketplace.json
├── .cursor/rules/ponytail.mdc      # instruction-only
├── .windsurf/rules/ponytail.md     # instruction-only
├── .clinerules/ponytail.md         # instruction-only
├── .kiro/steering/ponytail.md      # instruction-only
├── .github/copilot-instructions.md # instruction-only (fallback)
├── AGENTS.md                       # universal, fuente canónica del ruleset
├── docs/agent-portability.md       # tabla host → archivos → notas
├── benchmarks/
│   ├── promptfooconfig.yaml
│   ├── arms/{baseline,caveman,ponytail}.js
│   ├── prompts.json
│   └── results/*.md                # versionados por fecha
└── scripts/check-rule-copies.js    # guard contra drift de copias
```

---

## 3. Comparación navori ↔ ponytail (mapa mental)

| Dimensión | ponytail | navori |
|---|---|---|
| Tipo de producto | Skill distribuible | Scaffolder de harness completo |
| Audiencia | Dev individual que quiere "modo lazy" en cualquier agente | Dev/equipo que quiere replicar harness multi-agente + SDD en N repos |
| Fuente de verdad | `AGENTS.md` + `skills/ponytail/SKILL.md` (con guard de copias) | `navori.config.json` (render reconstruye todo) |
| Multi-engine | Render manual a 13 carpetas + guard de drift | Render programático desde core engine-agnostic |
| Composición | 1 plugin = bundle de (skill + commands + hooks + manifests por engine) | Igual modelo, formalizado en core (`@navori/core`) |
| Updateability | `npm pull` + reinstalar plugin | `navori sync` con marcadores `<!-- navori:managed -->` |
| Modos | lite/full/ultra/off persistidos en flag file | n/a (cada plugin lleva su propio modo) |
| Benchmark | promptfoo + arms baseline/caveman/ponytail, n=10 | n/a |

Conclusión del cuadro: **navori es el siguiente nivel de lo que ponytail está
haciendo a mano**. Si ponytail llega a 30 hosts soportados, su
`check-rule-copies.js` ya no escala. Para nosotros, eso es validación de
mercado.

---

## 4. Lecciones aplicables (categorizadas)

Cada lección tiene: **qué hacen**, **por qué funciona**, **cómo aplicaría a
navori**, y **prioridad sugerida** (P0 = blockear sin esto, P1 = next major,
P2 = nice-to-have, P3 = explorar después).

### 4.1 — Adaptadores por host: tabla declarativa + Adapter Rule

**Qué hacen.** El doc `docs/agent-portability.md` es una tabla concreta
host → archivos → notas. Define **explícitamente** dos tiers:

- **Hook-capable hosts**: Claude Code, Codex, OpenCode, Pi, Gemini CLI, Copilot CLI. Tienen plugin con session activation, mode switching, commands y statusline.
- **Instruction-only hosts**: Cursor, Windsurf, Cline, Kiro, Copilot editor, Aider, Antigravity (vía AGENTS.md), VS Code+Codex. Solo cargan un archivo de reglas, sin runtime.

Y declaran la "Adapter Rule": **keep adapters thin; when a host supports
skills or hooks, point it at the existing `skills/` and `hooks/` files**.

**Por qué funciona.** Hace explícito qué se puede hacer y qué no en cada host
sin tener que leer cada manifest. Reduce el costo de soportar un host nuevo
a "agregar una fila".

**Cómo aplicaría a navori.**

- En `@navori/core` definir un type `EngineCapabilities`:
  ```ts
  type EngineCapabilities = {
    instructions: boolean;       // siempre true
    hooks: boolean;              // SessionStart / UserPromptSubmit / etc.
    skills: boolean;             // skill loader nativo
    slashCommands: boolean;      // /command
    statusline: boolean;         // status bar custom
    modeSwitching: boolean;      // permite cambiar comportamiento en runtime
  };
  ```
- Cada engine adapter declara sus capabilities; render aplica solo los assets que el host soporta.
- Generar la tabla `docs/engines.md` a partir del schema, no a mano.

**Prioridad: P0.** Sin esto nuestro modelo "5 capas en cascada" se cae al
primer engine instruction-only.

### 4.2 — Source of truth única + guard de copias (el dolor que justifica navori)

**Qué hacen.** El archivo `scripts/check-rule-copies.js` (≈60 líneas) hace dos
cosas:

1. **Equivalencia de copias compactas**: compara byte-a-byte (con
   normalización de frontmatter) `AGENTS.md` contra:
   - `.cursor/rules/ponytail.mdc`
   - `.windsurf/rules/ponytail.md`
   - `.clinerules/ponytail.md`
   - `.github/copilot-instructions.md`
   - `.kiro/steering/ponytail.md`
2. **Invariantes en SKILL.md**: lista 5 frases load-bearing que **deben**
   aparecer literalmente tanto en `SKILL.md` como en `AGENTS.md`. Si una se
   borra al editar, CI rompe.

```js
const INVARIANTS = [
  'naive heuristic',
  'ONE runnable check',
  'flimsier algorithm',
  'input validation at trust boundaries',
  'Lazy code without its check is unfinished',
];
```

Y el comentario propio del autor lo confiesa:

> `// ponytail: canary, not full equality. […] Upgrade path: generate the copies from SKILL.md if this ever misses a real drift.`

Es decir: **él sabe que el approach correcto es generar desde fuente única, y
está esperando a tener N+1 hosts para construirlo**. Navori es ese N+1.

**Por qué funciona (a la escala que están).** Con 5 copias y un repo activo, la
detección de drift es barata; el costo de generar/templar todo desde una fuente
no se justifica todavía.

**Por qué se rompe.** En cuanto agregas un host instruction-only más, o
distintos sabores por idioma, o presets internos por equipo, el guard se vuelve
inmantenible y la generación es la única salida.

**Cómo aplicaría a navori.**

- `@navori/core` ya tiene la fuente canónica del ruleset interno; falta el caso de uso "ruleset reutilizable que se renderea idéntico a N targets de adaptador".
- Conviene **incorporar la idea del invariant check** dentro de `navori doctor`: cada plugin puede declarar `invariants: string[]` y doctor falla si alguna se pierde tras un render.
- Sería el primer plugin **importado del ecosistema externo**: empaquetar ponytail como `@navori/plugin-ponytail` sería un caso de uso real para validar nuestra abstracción.

**Prioridad: P0** para invariant check en doctor. **P1** para "import external skill/ruleset as navori plugin".

### 4.3 — Bundle único = skill + commands + hooks + manifests por engine

**Qué hacen.** El "plugin" ponytail es **un solo bundle conceptual** que se
materializa así por engine:

| Engine | Manifest | Hooks | Commands | Skills |
|---|---|---|---|---|
| Claude Code | `.claude-plugin/plugin.json` + `marketplace.json` | `hooks/hooks.json` apunta a `hooks/*.js` | `commands/*.toml` | `skills/*/SKILL.md` |
| Codex | `.codex-plugin/plugin.json` | Reusa `hooks/hooks.json` | `commands/*.toml` (skills `@`) | Reusa `skills/` |
| OpenCode | `.opencode/plugins/ponytail.mjs` (server plugin) | n/a (inyecta vía transform) | `.opencode/command/*.md` | Reusa `skills/` |
| Pi | `pi-extension/index.js` (npm) | Reusa `hooks/` runtime | Skills nativas | Reusa `skills/` |
| Gemini CLI | `gemini-extension.json` apunta a `AGENTS.md` | n/a | Reusa `commands/*.toml` | Reusa `skills/` |
| Copilot CLI | `.github/plugin/{plugin,marketplace}.json` | `hooks/copilot-hooks.json` | Skills | Reusa `skills/` |

**El truco clave**: el plugin **no duplica** ninguna pieza compartida. Los
manifests apuntan con rutas relativas a la **misma carpeta `skills/` y
`hooks/`** del repo raíz. Eso es exactamente el modelo "plugin como bundle de 4
piezas opcionales" que tenemos decidido (ver CLAUDE.md).

**Cómo aplicaría a navori.**

- Confirmar el contrato del plugin manifest:
  ```ts
  type PluginManifest = {
    name: string;
    version: string;
    description: string;
    skills?: SkillRef[];        // ref a archivos SKILL.md
    commands?: CommandRef[];    // refs a /command files
    hooks?: HookSpec[];         // por evento, multi-runtime (node/bash/ps)
    settingsFragment?: object;  // se mergea sobre baseline
    claudeMdBlock?: string;     // bloque que el render inserta entre marcadores
    doctorChecks?: DoctorCheck[];
  };
  ```
- Por engine, el render decide cuáles de las piezas declarar/copiar/transformar.
- Mismo bundle, render por engine: **ese es el invariante**.

**Prioridad: P0.** Ya está en plan, esto solo lo valida.

### 4.4 — Sub-skills como compañeras de la skill principal

**Qué hacen.** No es solo `ponytail`. Es:

- `ponytail` — la regla viva, activa por defecto.
- `ponytail-review` — review de diff por over-engineering.
- `ponytail-audit` — review de repo entero.
- `ponytail-debt` — cosecha de marcadores `ponytail:` en código.
- `ponytail-help` — quick reference de comandos.

Cada sub-skill es **un trigger discreto** (`/ponytail-review`, etc.), con su
propio prompt afilado al verbo. El frontmatter de cada SKILL.md tiene un
campo `description` agresivo con triggers en lenguaje natural ("Use when the
user says 'what can we delete', 'is this over-engineered'...").

**Por qué funciona.** Convierten un concepto (YAGNI) en un **set de
herramientas** que el agente puede invocar según contexto. La skill madre
gobierna comportamiento continuo; las sub-skills son verbos puntuales.

**Cómo aplicaría a navori.**

- Recomendar (y opcionalmente scaffoldear) un patrón **"skill madre +
  sub-skills"** en presets pesados.
- El preset `medusa` ya tiene 2 skills; el siguiente paso natural es definir
  el patrón "madre + verbos derivados" como convención de preset.
- En el render de `.claude/`, sugerir/validar que toda skill madre tenga
  triggers en su description (no solo una descripción narrativa).

**Prioridad: P2.** Es un hábito de diseño de presets, no de la CLI.

### 4.5 — Hooks pattern: SessionStart + UserPromptSubmit + statusline

**Qué hacen.** Dos hooks Node muy chicos, ambos con fallback silencioso si
`node` no está en PATH:

```jsonc
// hooks/hooks.json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "startup|resume|clear|compact",  // 4 eventos
      "hooks": [{
        "type": "command",
        "command": "command -v node >/dev/null 2>&1 && node \"${CLAUDE_PLUGIN_ROOT}/hooks/ponytail-activate.js\" || exit 0",
        "commandWindows": "if (Get-Command node ...) { node \"$env:CLAUDE_PLUGIN_ROOT\\hooks\\ponytail-activate.js\" }",
        "timeout": 5,
        "statusMessage": "Loading ponytail mode..."
      }]
    }],
    "UserPromptSubmit": [/* ponytail-mode-tracker.js */]
  }
}
```

El `SessionStart` hook hace **tres cosas**:

1. Escribe flag `~/.claude/.ponytail-active` con el modo activo.
2. Emite el ruleset filtrado por modo como `additionalContext` para la sesión.
3. **Detecta statusline faltante y le pide al agente que ofrezca configurarla** ("STATUSLINE SETUP NEEDED: ..."). El plugin se auto-instala su statusline preguntando al usuario.

El statusline (`ponytail-statusline.sh`) lee la flag file y pinta
`[PONYTAIL]` o `[PONYTAIL:ULTRA]` con color en la barra. ~10 líneas de bash.

**Por qué funciona.**

- `||exit 0` evita errorear el SessionStart cuando node no está disponible (Nix/nvm sin shell interactivo). Es el fallo más común y lo manejan al toque.
- El nudge de statusline es **self-onboarding**: el plugin pide su propio status visual sin que el usuario tenga que leer docs.
- Los 4 matchers (`startup|resume|clear|compact`) garantizan reactivación tras compaction y resumes, que es donde más se pierden agentes.

**Cómo aplicaría a navori.**

- **Patrón hook obligado por plugin**: cuando un plugin declara `mode`/`level`/`state`, navori puede generar automáticamente:
  - Un hook SessionStart que escribe la flag y emite contexto.
  - Un hook UserPromptSubmit que detecta comandos `/<plugin>` y cambia la flag.
  - Un statusline opcional (declarativo: el plugin describe qué pintar, navori genera el script).
- **Wrapping defensivo automático**: cualquier hook que navori renderee debe llevar el `command -v node || exit 0` (o el equivalente para bash/python) por default. Hoy se nos puede olvidar y romper sesiones.
- **Cobertura de matchers**: nuestros docs deberían recomendar `startup|resume|clear|compact` como el set por defecto para hooks de "estado persistente". Sin `resume|compact` se pierde el modo cuando el usuario reanuda — bug clase entera.

**Prioridad: P1.** Es valor concreto que podemos meter en el plugin schema
sin romper compatibilidad.

### 4.6 — Modos lite/full/ultra/off con flag file + filtrado del SKILL body

**Qué hacen.** El usuario corre `/ponytail ultra`. El hook `UserPromptSubmit`
lo intercepta, escribe `ultra` en `~/.claude/.ponytail-active`. La próxima
sesión, `SessionStart` lee la flag y **filtra el SKILL.md body por modo**:

```js
// hooks/ponytail-instructions.js — filterSkillBodyForMode
return body.split('\n').filter(line => {
  // Solo las filas de la tabla intensity con label `**lite**|**full**|**ultra**`
  // y los ejemplos `- lite: ...` se filtran. El resto va literal.
  const tableLabel = line.match(/^\|\s*\*\*(.+?)\*\*\s*\|/);
  if (tableLabel) {
    const labelMode = normalizeMode(tableLabel[1].trim());
    if (labelMode) return labelMode === effectiveMode;
  }
  // ... similar para "- lite:" examples
  return true;  // todo lo demás se queda
}).join('\n');
```

Reglas clave del diseño:

- **El SKILL.md vive con las 3 variantes inline**, no son 3 archivos. El filtrado pasa cuando se inyecta.
- Solo se filtran las **filas de tabla con label `**lite**|**full**|**ultra**`** y los bullets `- <mode>: ...`. **Todo lo demás es invariante**.
- "off" no filtra: directamente no inyecta nada.
- Persistencia local al usuario (`~/.claude/.ponytail-active`), no al repo. Cambiar modo no afecta a otros usuarios.

**Por qué funciona.**

- El SKILL.md sigue siendo una **fuente de verdad legible** sin duplicación.
- El filtrado es declarativo (regex sobre la forma del markdown), no template engine. Cualquiera puede leer el SKILL.md crudo y entenderlo.
- Permite que el plugin tenga "perfiles de intensidad" sin convertirlo en 3 plugins.

**Cómo aplicaría a navori.**

- Definir en core un patrón **"variantes inline filtrables"** para skills/blocks que necesitan múltiples niveles. Documentarlo como receta, no como feature obligada.
- Útil para presets: ej. un preset "medusa" podría tener variantes `strict|relaxed` en el mismo SKILL.md y `navori render --variant strict` filtraría las filas que no aplican.
- **Cuidado con el over-engineering**: no convertir esto en un template engine completo. La fuerza de ponytail aquí es exactamente que **no es** un engine — son 2 regex.

**Prioridad: P2.** Útil pero no urgente. Documentarlo como receta antes de
construirlo.

### 4.7 — Resolución de config en cascada (env > file > default)

**Qué hacen.** `hooks/ponytail-config.js` define un resolver de 3 niveles:

```
1. PONYTAIL_DEFAULT_MODE env var (highest priority)
2. ~/.config/ponytail/config.json   (XDG, with Windows fallback to %APPDATA%)
3. 'full' (default)
```

Con `XDG_CONFIG_HOME` respetado como override de carpeta. Comportamiento
estándar Unix, **sin sorpresas**.

**Cómo aplicaría a navori.** Ya tenemos `navori.config.json` checked-in. La
pieza que **no** tenemos resuelta es: ¿qué hace navori cuando el usuario quiere
override **personal** (no checked-in)? Ponytail nos da el patrón:

- `navori.config.json` = config del proyecto (commited).
- `~/.config/navori/config.json` = override personal (no commited).
- `NAVORI_*` env vars = override de proceso (CI, scripts).

Aplicar en `navori init/render/doctor` cuando lean cualquier valor con
preferencia de usuario.

**Prioridad: P2.** No es urgente hasta que tengamos el primer reporte de
"quiero esto local pero no en el repo".

### 4.8 — Bridge cross-engine sin duplicar runtime (createRequire)

**Qué hacen.** El plugin de OpenCode es ESM (`.mjs`) pero el resto del runtime
es CommonJS (`.js`). En vez de duplicar:

```js
// .opencode/plugins/ponytail.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { getPonytailInstructions } = require('../../hooks/ponytail-instructions');
const { getDefaultMode, normalizePersistedMode } = require('../../hooks/ponytail-config');
```

Y el pi-extension (`.js` ESM) hace lo mismo. **Una sola fuente de verdad para
"qué dice el ruleset filtrado por modo X", reusada por 4 engines**.

**Cómo aplicaría a navori.** Cuando navori empiece a renderizar runtime
código por engine (no solo markdown), defender el invariante "un solo módulo
de lógica, N adaptadores delgados". El truco `createRequire` es el ejemplo
canónico.

**Prioridad: P3.** Lo veremos cuando metamos hooks dinámicos / scripted.

### 4.9 — Adaptadores instruction-only: sabor por host pero misma fuente

**Qué hacen.** Los hosts sin runtime (Cursor, Windsurf, Cline, Kiro, Copilot
editor) **solo cargan archivos de reglas**. Ponytail los soporta así:

- `.cursor/rules/ponytail.mdc` — frontmatter `alwaysApply: true`, descripción Cursor-style.
- `.windsurf/rules/ponytail.md` — markdown plano.
- `.clinerules/ponytail.md` — markdown plano.
- `.kiro/steering/ponytail.md` — Kiro frontmatter.
- `.github/copilot-instructions.md` — texto puro.

**El cuerpo es idéntico al de `AGENTS.md`**; lo único que cambia es el
frontmatter por host. El `check-rule-copies.js` valida que el body matchea
después de strippear el frontmatter.

**Cómo aplicaría a navori.**

- Cada engine adapter en navori-core debe poder declarar:
  - `outputPath: string` (dónde escribir)
  - `frontmatter?: object | (ruleset) => string` (wrapping por host)
  - `bodyTransform?: (ruleset) => string` (rara vez necesario)
- El "ruleset" es el body canónico; el render aplica frontmatter por host.
- Para Cursor el frontmatter incluye `alwaysApply: true`; para Kiro un campo distinto. Cada uno declara su forma.

**Prioridad: P0.** Sin esto no soportamos hosts instruction-only, que son
la mayoría.

### 4.10 — La convención `ponytail:` comment + skill que la cosecha

**Qué hacen.** Cualquier shortcut deliberado se marca en el código:

```python
# ponytail: global lock, per-account locks if throughput matters
with global_lock:
    ...
```

```html
<!-- ponytail: browser has one -->
<input type="date">
```

Y la sub-skill `/ponytail-debt` los **cosecha en un ledger**:

```
src/foo.py:42 — global lock used. ceiling: contention at >100 rps. upgrade: shard per account.
src/bar.js:88 — naive substring search. no-trigger.
```

Las que no nombran upgrade path se taggean `no-trigger` (red flag: lo que
silenciosamente se pudre).

**Por qué funciona.** Convierte "later = never" en un problema observable.
El shortcut no es un bug, es un dato — siempre que tenga ceiling + trigger
explícitos.

**Cómo aplicaría a navori.**

- Proponer una convención **`navori:`** (o mejor, **`@todo:` agnóstica**) para shortcuts deliberados en código rendereado por navori. Ej:
  ```markdown
  <!-- navori:managed -->
  ## Roles
  <!-- /navori:managed -->
  ```
  Ya usamos `<!-- navori:managed -->` para regiones gestionadas; podríamos extenderlo a marcadores **dentro de regiones gestionadas** que sobreviven al sync (anclas semánticas).
- Un comando `navori debt` o `navori shortcuts` que lista marcadores en el repo. Útil para presets que generan código con shortcuts intencionales.
- **Más importante**: la lección de fondo es que **un shortcut sin upgrade trigger es deuda silenciosa**. Documentarlo en nuestro propio CLAUDE.md como regla de equipo.

**Prioridad: P2** para el comando. **P0** para internalizar la regla.

### 4.11 — Benchmark reproducible (promptfoo + arms)

**Qué hacen.** `benchmarks/promptfooconfig.yaml` define 3 arms (baseline /
caveman / ponytail), 5 tareas, 3 modelos (Haiku/Sonnet/Opus), 10 runs por
celda, mediana reportada. Reproducible con `npx promptfoo eval -c
benchmarks/promptfooconfig.yaml`. Resultados versionados en
`benchmarks/results/YYYY-MM-DD-*.md` con análisis crudo de cada iteración del
prompt.

El README abre con:

> **80-94% less code · 3-6× faster · 47-77% cheaper**
> Median of 10 runs across Haiku, Sonnet, and Opus. [Reproduce it yourself.](benchmarks/)

Es **el marketing más fuerte que puede tener una skill/plugin de IA**. Number
agresivo + "haz tú la prueba" + paper-trail de iteraciones.

**Cómo aplicaría a navori.**

- Esto **no se construye antes de tener el primer caso de uso real**, pero hay que tenerlo en el roadmap.
- Métricas plausibles para navori:
  - **Time-to-harness**: minutos desde `npm i navori` hasta primer `git commit` de `.claude/` funcional, vs hacerlo a mano.
  - **Diff churn**: líneas modificadas tras 30 días de uso de un harness instalado por navori vs harness manual (proxy de "qué tan bien envejece").
  - **Drift count**: cuántos `<!-- navori:managed -->` blocks divergen tras 1 mes (con/sin `sync`).
- Cómo medirlo: necesitamos un repo de fixtures + un test suite que corra `navori init` con configs distintos y mida outputs.

**Prioridad: P2.** Importante para narrativa de v1.0, no para v0.x.

### 4.12 — Marketing / branding como parte del producto

**Qué hacen.** Tagline ("He says nothing. He writes one line. It works."),
personaje memorable (el dev del ponytail), logo light/dark, badges, ejemplos
visuales en README con "antes/después", FAQ con tono ("Does it scale? — The
code you never wrote scales infinitely. Zero bugs, zero CVEs, 100% uptime
since forever."). El brand color (`#111111`) y el icono están **dentro del
package.json** en `interface.brandColor`.

**Por qué funciona.** Hace que un plugin técnico se sienta como **producto**.
La identidad reduce fricción de adopción más que cualquier doc.

**Cómo aplicaría a navori.**

- La landing en `apps/website/` ya existe. Aprovecharla para crear identidad.
- Definir un tagline para navori en una línea ("Replicate your AI harness across every repo in 30 seconds").
- En cada plugin distribuido por navori, considerar un campo `interface` en el manifest (brandColor, icon, displayName, defaultPrompt) que el host use cuando lo soporte. Ponytail ya lo hace; nosotros podemos formalizarlo.

**Prioridad: P3.** Marketing es importante pero no urgente hasta producto estable.

### 4.13 — Output discipline: "code first, ≤3 lines de explicación"

**Qué hacen.** El SKILL madre dicta:

> Code first. Then at most three short lines: what was skipped, when to add it.
> No essays, no feature tours, no design notes. If the explanation is longer than
> the code, delete the explanation.

Y lo refuerza con un pattern explícito: `[code] → skipped: [X], add when [Y].`

Su benchmark v2 documenta que esto **redujo 70s/iteración** porque el agente
dejó de deliberar sobre qué no construir.

**Cómo aplicaría a navori.**

- Lección directa para nuestros **propios prompts internos** (CLAUDE.md de proyecto, skills generadas por navori): poner topes de output explícitos. "Code first, X líneas máximo, no essays" no es retórica, es performance.
- En la skill de "render" / "sync" de navori, considerar un `output_discipline` declarativo en cada skill: max words por sección, formato del cierre.

**Prioridad: P2.** Aplicable como **convención de skills generadas**, no como feature.

### 4.14 — Ship-and-question en la misma respuesta (anti-stall)

**Qué hacen.** Otra regla del SKILL madre:

> Complex request? Ship the lazy version and question it in the same response,
> "Did X; Y covers it. Need full X? Say so." Never stall on an answer you can default.

El benchmark v1 mostró que sin esto el agente **se quedaba debatiendo** si
necesitaba o no la versión completa, antes de escribir nada. La regla
convierte la duda en un default + opt-in.

**Cómo aplicaría a navori.**

- En presets que generen skills/agents que **toman decisiones de diseño**, codificar este anti-patrón como regla por default.
- En la propia CLI: `navori init` debería **siempre** producir algo razonable y dejar el opt-in del extra como prompt opcional, no bloquear con preguntas.
- Ya lo hacemos en `init --recommended`; vale la pena formalizarlo como principio en docs.

**Prioridad: P2.**

### 4.15 — Boundaries explícitas (cuándo NO aplicar la skill)

**Qué hacen.** Cada SKILL.md tiene una sección `## Boundaries` literal:

```
"stop ponytail" / "normal mode": revert.
Ponytail governs what you build, not how you talk.
```

Y `## When NOT to be lazy`:

```
Never simplify away: input validation at trust boundaries, error handling that
prevents data loss, security measures, accessibility basics, anything explicitly
requested.
```

El SKILL no solo dice "qué hacer", también dice **"qué nunca tocar"** y **"cómo
salirse"**.

**Cómo aplicaría a navori.**

- Convención obligatoria para skills de presets generados: sección **Boundaries** explícita.
- Doctor check: warning si una skill madre no tiene sección de boundaries / off-switch.

**Prioridad: P2.**

### 4.16 — Auto-test mínimo por skill (one runnable check)

**Qué hacen.** El SKILL madre dicta que **toda lógica no trivial deja UN check
ejecutable** detrás (assert-based demo, `__main__`, o un test mini). Sin
frameworks, sin fixtures. La frase es invariant (vive en el `check-rule-copies.js`):

> Lazy code without its check is unfinished.

Y específicamente para tests:

> No frameworks, no fixtures, no per-function suites unless asked. Trivial
> one-liners need no test, YAGNI applies to tests too.

**Cómo aplicaría a navori.**

- Lección de **diseño de skills**: cualquier skill que genere código no trivial debería tener una sección que obligue al agente a dejar un check. Es una pieza de calidad que reduce regresiones sin costo significativo.
- Aplicar a la propia CLI: nuestro CI ya tiene tests; vale la pena revisar que cada comando navori tenga al menos UN check ejecutable mínimo.

**Prioridad: P2** (como convención documentada).

### 4.17 — Soporte cross-platform por default en hooks

**Qué hacen.** Cada hook tiene su comando bash **y** su comando PowerShell:

```json
{
  "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/ponytail-activate.js\"",
  "commandWindows": "node \"$env:CLAUDE_PLUGIN_ROOT\\hooks\\ponytail-activate.js\""
}
```

Y la statusline tiene `ponytail-statusline.sh` + `ponytail-statusline.ps1`.

Hay un test dedicado `tests/hooks-windows.test.js`.

**Cómo aplicaría a navori.**

- Ya teníamos esto en mente (`win32` install commands en plugins) pero no lo tenemos enforcado.
- Doctor check: warning si un plugin declara hooks sin variante Windows.
- Generador: cuando navori genere un hook desde el plugin manifest, generar **ambas** variantes automáticamente.

**Prioridad: P1.**

### 4.18 — Tests por engine, no solo unit

**Qué hacen.** `tests/` tiene archivos dedicados por adapter:

```
behavior.test.js
commands.test.js
copilot-plugin.test.js
correctness.test.js
gemini-extension.test.js
hooks-windows.test.js
hooks.test.js
opencode-plugin.test.js
```

Cada test valida que el manifest de **ese engine** está bien formado, que las
rutas existen, que el shape del export coincide con lo que el host espera.

**Cómo aplicaría a navori.**

- Tener un test por engine adapter es disciplina barata y atrapa todo el set de bugs "renombré un archivo y un engine quedó roto".
- Cuando navori soporte engine N, agregar `tests/engines/engine-N.test.js` debería ser parte del checklist de "soportar engine nuevo".

**Prioridad: P1.**

### 4.19 — Patrón "global config + project config" sin colisión

**Qué hacen.** El sistema de modos vive en `~/.claude/.ponytail-active` (per
user), no en `.claude/` del repo. El config de `defaultMode` vive en
`~/.config/ponytail/config.json` (per user), no en el repo. **Nada de
ponytail se commitea al repo del usuario** salvo los archivos de
instrucciones que el adapter generó (Cursor rules, copilot-instructions, etc.,
que son **del repo, no del plugin**).

**Cómo aplicaría a navori.**

- Reglas de oro:
  - Estado mutable del plugin → carpeta del usuario.
  - Output rendereado por navori → carpeta del repo, en regiones marcadas.
  - Source of truth (`navori.config.json`) → carpeta del repo, commited.
- Ya está en nuestro CLAUDE.md ("Nunca commitear `.claude/`"). Vale la pena reforzarlo en docs.

**Prioridad: P3.** Ya cubierto, solo documentar más claro.

### 4.20 — Versionado del plugin separado de la CLI

**Qué hacen.** `package.json` raíz = `4.6.0`. Los manifests por engine **todos
declaran la misma versión**. Eso permite que el host muestre versión y que el
mantainer cuente major bumps de la skill como producto independiente.

**Cómo aplicaría a navori.**

- Cuando navori soporte plugins externos, cada plugin tiene **su propia versión** independiente de la CLI.
- El registry/marketplace de navori (futuro) debería incluir versión por plugin.

**Prioridad: P2** (cuando construyamos plugin registry).

---

## 5. Anti-patrones de ponytail (qué NO copiar)

No todo es para imitar. Cosas que están bien para ellos pero **mal para
nosotros**:

### 5.1 — Mantener N copias del ruleset y guard de canary

Ya lo dijimos: su `check-rule-copies.js` es exactamente lo que navori existe
para eliminar. Nosotros no debemos terminar con el mismo script. Si nos
vemos manteniendo más de **una** copia del mismo body, es síntoma de que
falta un renderer dedicado.

### 5.2 — Duplicar manifests sin generador

`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`,
`.github/plugin/plugin.json`, `.opencode/...`, `gemini-extension.json` — los 5
declaran name+version+description casi idénticos. Cuando bumpean a `4.7.0` van
a tener que tocar 5 archivos a mano (o lo bumpea CI). Para navori: **el
manifest es output**, no source. El source es `navori.config.json`; los
manifests por engine se generan en `render`.

### 5.3 — SKILL.md con frontmatter narrativo gigante

Su `description` en el frontmatter es de 6 líneas con todos los triggers
posibles. Es necesario para que el host lo encuentre, pero se vuelve
inmantenible. Mejor: el manifest del plugin declara `triggers: string[]` y
navori los renderiza al frontmatter del SKILL.md según el dialecto del host.

### 5.4 — Configurar dotfiles del usuario por hook

El nudge "STATUSLINE SETUP NEEDED: agregá esto a `~/.claude/settings.json`"
es elegante pero **toca el dotfile global del usuario**. Si navori sugiriera
eso, choca con `update-config` (skill del harness) y con CLAUDE.md global. En
nuestro caso, los settings del usuario son **terreno del usuario**; navori
nunca propone modificarlos sin opt-in explícito por comando.

### 5.5 — Mezclar runtime y output en la misma carpeta

`hooks/` contiene tanto **runtime** (`.js` que ejecuta el host) como
**bash/ps scripts** que el host invoca. Funciona pero confunde. Para navori,
mantener separación: `runtime/` ejecutable vs `templates/` markdown.

---

## 6. Lecciones de producto (no técnicas)

### 6.1 — Mono-propósito vence multi-propósito en plugins

Ponytail hace **una cosa**. Por eso pueden tener un tagline, un benchmark
agresivo, una marca. Navori no es un plugin, es un scaffolder — pero los
plugins que **distribuyamos** desde navori deberían tender al mono-propósito.

### 6.2 — Reproducibilidad mata marketing genérico

"80-94% menos código" con `npx promptfoo eval` en la raíz del repo es 100×
más fuerte que cualquier slide. Para navori, el equivalente sería un
fixture-repo + script de un comando que mida lo que prometemos.

### 6.3 — Self-onboarding > docs

El statusline-nudge se auto-instala vía hook. El plugin pide su propia
configuración sin que el usuario abra docs. Pensemos a `navori doctor`
como vehículo de **self-onboarding automatizado** (no solo de diagnóstico).

### 6.4 — Tests por engine son la primera línea de defensa al soportar más hosts

Cada engine que soportamos sube el costo marginal de mantenimiento. Tests
dedicados son lo que mantiene ese costo flat.

### 6.5 — La adopción multi-engine **es** la tesis

13 hosts soportados, 1 producto. Para navori la apuesta es la misma: si
solo soportamos Claude Code, somos `gh repo template`. La defensa de navori
es el set de adapters.

---

## 7. Roadmap propuesto: cómo incorporar esto en navori

### Fase A — Inmediato (próximas iteraciones, P0)

| Lección | Acción concreta | Spec sugerido |
|---|---|---|
| 4.1 Adaptadores capability-aware | Tipo `EngineCapabilities` en `@navori/core`; render filtra por capability | nuevo spec `0003-engine-capabilities` |
| 4.2 Invariants check en doctor | `plugin.invariants: string[]` + check de `navori doctor`; falla si una desaparece tras render | extender `0002` o nuevo `0004` |
| 4.3 Bundle plugin formalizado | Documentar el manifest del plugin con las 4-6 piezas + cuáles son opcionales | doc `docs/plugin-manifest.md` |
| 4.9 Instruction-only adapters bien tipados | Cada adapter declara `frontmatter` y `outputPath`; render escribe homogéneo | parte del spec 0003 |

### Fase B — Corto plazo (P1)

| Lección | Acción concreta |
|---|---|
| 4.5 Hook pattern por default | Generador automático de SessionStart+UserPromptSubmit+statusline desde plugin manifest cuando declara `mode`. Wrapping defensivo del comando (`command -v <runtime> \|\| exit 0`) por default. |
| 4.17 Cross-platform hooks | Generador emite siempre `commandWindows` cuando un plugin declara hooks tipo `command`. |
| 4.18 Tests por engine | Plantilla `tests/engines/<engine>.test.ts`. Cada nuevo adapter incluye uno. |

### Fase C — Mediano plazo (P2)

| Lección | Acción concreta |
|---|---|
| 4.4 Skill madre + sub-skills | Convención documentada en `docs/preset-patterns.md`; opcional: scaffolder `navori add skill --with-verbs review,audit`. |
| 4.6 Variantes inline filtrables | Documentar como receta. Opcional: `navori render --variant <name>` que activa una columna del SKILL.md. |
| 4.7 Cascada env > file > default | Aplicar a cualquier valor mutable del usuario en la CLI. Doc en `docs/config-resolution.md`. |
| 4.10 Comando `navori debt` / `shortcuts` | Cosechar marcadores intencionales en el repo. |
| 4.11 Benchmark reproducible | Repo fixture + script `pnpm bench`. Métricas: time-to-harness, drift count, diff churn. |
| 4.13 Output discipline en skills | Convención: cada skill madre incluye sección "Output" con tope explícito. |
| 4.14 Ship-and-question | Convención documentada para skills que toman decisiones de diseño. |
| 4.15 Boundaries explícitas | Doctor warning si una skill no declara off-switch / boundaries. |
| 4.16 One runnable check | Recomendación para skills generadas por presets. |
| 4.20 Versionado independiente | Cuando soportemos registry de plugins. |

### Fase D — Largo plazo / explorar (P3)

| Lección | Acción concreta |
|---|---|
| 4.8 Bridge cross-engine de runtime | Cuando rendereemos código ejecutable cross-engine (no solo markdown). |
| 4.12 Marketing/branding | Tagline, brand identity en landing. Pre-requisito: producto estable. |
| 4.19 Estado mutable per-user | Reforzar en docs; ya está cubierto en práctica. |

---

## 8. Quick wins (cosas que podemos meter sin discutir)

Lista corta, sin necesidad de spec:

1. **Wrapping defensivo de hooks generados**: prefijar siempre con `command -v <runtime> >/dev/null 2>&1 || exit 0`. Una línea, evita errors silenciosos.
2. **Matchers de hooks por default**: para SessionStart usar `"matcher": "startup|resume|clear|compact"`, no solo `startup`. Es la única forma de sobrevivir a compaction.
3. **`commandWindows` obligatorio para todo hook generado**: incluso si solo es la traducción literal con `$env:VAR`.
4. **Convención `<!-- engine:managed -->` (o `navori:managed` ya existente) reforzada**: regla "managed bloques son renderables, todo lo demás del archivo es del usuario".
5. **CLAUDE.md de cada preset incluye sección Boundaries**: "qué no tocar / cómo desactivar".
6. **Doc `docs/engines.md` (o `docs/agent-portability.md`)**: tabla host → archivos → capabilities → notas, **generada desde core**.
7. **Variable de env `NAVORI_*` declarativa**: ya por documentación, antes de implementarla — definir naming convention.

---

## 9. Preguntas abiertas / cosas a discutir

Estas no se resuelven de leer ponytail; necesitan decisión:

1. **¿Ponytail debería ser el primer plugin externo en el registry de navori?** Es un caso de uso real y validaría la abstracción. Costo: necesitamos primero el contrato de plugin manifest formalizado (Fase A).
2. **¿Hasta qué punto navori reescribe vs reusa archivos de plugins?** Ponytail rusa `skills/` y `hooks/` tal cual desde manifests por engine. Nosotros tenemos dos opciones:
   - **Pass-through**: plugin trae `skills/`, navori solo manifesta dónde están.
   - **Render**: plugin declara abstracto, navori escribe a la convención del engine.
   - Mixto probablemente, pero hay que decidir cuándo aplica cada uno.
3. **¿Hooks generados dinámicamente o estáticos?** Ponytail los tiene estáticos y los reusa. Navori podría generarlos por engine. Generación da flexibilidad; estático da menor superficie de bug.
4. **¿`navori sync` debería validar invariantes?** Si declaramos invariants por plugin, sync es el momento natural para checkearlos. Pero también podría romperse silenciosamente en el flujo "edit-rebase-sync".
5. **¿Variantes/modos como feature del core o como receta de preset?** Filtrar SKILL.md por modo es elegante pero core-features siempre tienen costo. Mejor empezar como receta, promover a feature si hay demanda.

---

## 10. Cierre

Ponytail no es nuestro competidor — es nuestro **proof of concept**.
Confirma que el dolor multi-engine existe, que se puede resolver con un
patrón "bundle + adapters thin", y que la disciplina técnica
(check-rule-copies, tests por engine, hooks con fallback) se vuelve crítica
al pasar de 3 a 13 hosts soportados.

Para navori, las acciones de mayor leverage son:

- **Cerrar la Fase A (P0)**: capabilities por engine + invariants en doctor + manifest del plugin formal.
- **Empaquetar ponytail como plugin externo de navori** una vez Fase A esté lista. Si funciona, valida la abstracción con un autor externo de verdad.
- **Internalizar la disciplina operativa**: hooks defensivos, matchers completos, cross-platform por default. Son baratos y previenen clases enteras de bugs antes de que aparezcan.

Lo que **no** debemos copiar: la duplicación de manifests y rulesets. Eso
es el problema que justifica navori. Si caemos en lo mismo, no hay
producto.
