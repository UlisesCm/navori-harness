# Spec 0010 — Harness global (base sólida por-máquina en `~/.claude`)

> Estado: **F1 implementado** · 2026-07-30 · Baseline (operaciones-seguras + idioma-rol +
> formato-respuesta) entregado por hook con gate; comandos `navori global
> init/render/doctor/uninstall`; invariante de huella-cero con guard estructural. F2 (omisión
> opt-in) y F3 (doctor cross-scope) pendientes. Deriva del issue #150 (decisiones de
> producto parqueadas de #124, @RicardoMarin7). Alcance elegido con Ulises: **MVP lean —
> solo identidad, aditivo**. La "voz de navori", el sistema de features/app-builder y el
> review 4R del #124 quedan **fuera** (ver §9).
>
> Objetivo: instalar una **base de harness repo-agnóstica una sola vez por máquina** en el
> directorio global de Claude Code (`~/.claude`), para que Claude entre a **cualquier**
> proyecto —incluso uno sin `navori.config.json`— con guardrails, idioma/rol, memoria y
> doctrina de orquestación ya puestos, en vez de "perdido". Es **opt-in explícito** y **se
> hace a un lado solo** cuando el repo trae su propia config navori (§3.1).

## 1. Motivación

Hoy navori configura **cada repo por separado**: la identidad (idioma-rol, operaciones
seguras, protocolo de memoria, orquestación) se materializa dentro del `CLAUDE.md` y `.claude/`
de cada repo en `render`. Consecuencias:

1. **Un repo sin config navori no hereda nada** — Claude arranca sin guardrails ni doctrina.
2. **Duplicación** de la misma identidad repo-agnóstica en N repos.
3. **Máquina nueva** = re-configurar repo por repo.

La tesis del harness global: existe un piso de doctrina que es **igual para todos los
proyectos y personal-de-máquina** (no policy de equipo). Ese piso debe vivir **una vez** en
`~/.claude`, que Claude Code carga en **toda** sesión, y ser **aditivo** — no toca ni degrada
lo que los repos ya traen.

## 2. El problema de diseño (y su resolución)

El #150 marcó el riesgo real: un harness global dejaría `language/engines/plugins` en **3
lugares** (`NavoriConfig` + `WorkspaceConfig` + un `GlobalConfig` nuevo) sin reconciliar con
la capa `workspace` que **ya existe**. Análisis del código:

### 2.1 `workspace` y `global` son ejes distintos, no el mismo

| | `workspace` (ya existe) | Harness global (esta spec) |
|---|---|---|
| Qué es | Perfil de **policy** (valores semilla) para un grupo de repos | Los **assets de identidad en sí**, cargados en runtime |
| Dónde | `~/.navori/workspaces/<name>/workspace.json` (`workspace.ts:40-62`) | Config en `~/.navori/global.json`; render a `~/.claude/` |
| Cómo aplica | Se **aplana al `navori.config.json` del repo en `init`** (`init.ts:222-234`). No es capa viva en render. | Claude Code lo carga nativo en cada sesión. Nunca se aplana al repo. |
| Contenido | `language/engines/plugins/branchBase/prTarget/commits` | Bloques de prosa repo-agnósticos + permisos personales |

El workspace comparte **valores** (qué idioma, qué engines) que se copian al config del repo;
el global hace que **la prosa universal viva físicamente una vez**. Son **complementarios**.

### 2.2 Separación de responsabilidades → cero triple-duplicación

La regla que evita la trampa de los "3 lugares": **el scope global NO re-almacena
`language/engines/plugins` como policy.**

- **Global** = identidad repo-agnóstica y personal (idioma-rol, operaciones-seguras, protocolo
  engram, orquestación, permisos personales).
- **Workspace** = sigue siendo la semilla de config para un grupo de repos.
- **Repo** (`navori.config.json`) = el **stack** (engines, preset, plugins por dependencia).

Global posee identidad; repo posee stack; workspace siembra valores. No se solapan.

### 2.3 Aditivo, no sustractivo (la decisión que simplifica el MVP)

El #124 mezclaba dos cosas: *"instala tu identidad una vez"* (cómodo) y *"los repos dejan de
duplicarla → ahorro de tokens"* (que trae el problema del falso-positivo cross-scope y un
**costo de portabilidad**: un repo que *omite* sus bloques globales deja de ser autocontenido,
y un compañero sin `navori global` clona y recibe un harness degradado).

**El MVP se queda solo con el eje aditivo y seguro:**

> El baseline global es una capa que se inyecta **debajo** de la sesión (vía el hook con gate,
> §3.1). Es **puramente aditiva**: los repos siguen autocontenidos e intactos. Render de repo
> **no omite nada** y **no cambia un solo byte**.

Beneficio de fondo: **el falso-positivo de bloques `both` desaparece del MVP**, porque global
carga contenido repo-agnóstico que los repos no re-emiten como policy propia — no hay dos
marcadores idénticos que un doctor cross-scope confunda con duplicado. El ahorro-de-tokens
por-omisión y el doctor cross-scope quedan como **Fase 2/3 opcionales** (§8), con su tradeoff
explícito.

### 2.4 Invariante: huella cero sin opt-in

**Requisito duro (Ulises): si no instalas el harness global, no se nota ni un cambio.** La
versión del CLI que trae esta feature debe comportarse **byte-idéntico** a la anterior en
**todos** los flujos existentes mientras `~/.navori/global.json` no exista:

- `navori render`, `doctor`, `status`, `sync`, `init`, `add` de repo → **output y archivos
  idénticos**. Cero líneas nuevas, cero prompts nuevos, cero warnings de "global no instalado".
- **Ningún** archivo se escribe en `~/.claude` salvo tras `navori global init` explícito.
- El path de render del repo (`render-plan.ts`, engine adapters) **no se modifica** en F1
  (ver §3). La feature global vive **solo** en código nuevo que nadie ejecuta sin opt-in.

Todo lo global está **gateado por la existencia de `~/.navori/global.json`**: sin ese archivo,
los comandos `navori global *` son lo único que lo menciona, y solo si los invocas a mano. Esta
invariante se blinda con un test de no-regresión: **el render de un repo produce bytes
idénticos con y sin la feature global presente en el binario** (§8, F1).

## 3. Modelo de composición del baseline global

Para respetar la invariante de §2.4, **F1 no añade ningún atributo a los assets del core ni
toca el path de render del repo.** El baseline global se compone por **selección de bloques
existentes por `id`**:

- `~/.navori/global.json` lleva `blocks.include: string[]` — los `id` de bloques del core que
  forman el baseline (p. ej. `["idioma-rol", "operaciones-seguras", ...]`).
- `navori global render` toma **esos mismos bloques del core** (los que ya existen en
  `CORE_MANAGED_ASSETS`, `render-plan.ts:36-90`), valida que **ninguno interpole
  `{{project.*}}`** (§4), y los emite dentro del hook con gate (§3.1).
- El render de repo **ni se entera**: sigue emitiendo lo que emite hoy. Un bloque en
  `blocks.include` se rendea en el repo **y** puede componer el baseline global — no son
  mutuamente excluyentes en F1, y como el gate hace defer dentro de repos navori, **nunca hay
  doble emisión** (repo sin navori → solo el hook; repo con navori → solo el repo).

Esto mantiene la feature global como **código estrictamente nuevo y aditivo**: cero cambios al
motor de render existente.

> **Deferido a F2 — el atributo `scope` y la omisión.** La "omisión de bloques en el repo"
> (para ahorro de tokens) sí requeriría un atributo `scope`/`omit` en los assets del core y
> modificar el render del repo — precedente: `rootOnly`/`omitRootOnly` (`render-plan.ts:20-34`,
> `260-273`). Eso es opt-in por-repo, cambia el output del repo, y por tanto **no** entra al
> MVP: rompería la invariante de huella-cero. Se difiere a F2. `scope: "both"` y el doctor
> cross-scope van con F3.

## 3.1 El gate: instalación explícita y aplicación condicional

Tres requisitos duros del diseño:

1. **Explícita** — el harness global NUNCA se instala solo. Es opt-in vía `navori global
   init`. `navori init` de repo jamás toca `~/.claude`.
2. **Se omite cuando hay config local** — si la sesión corre en un repo con
   `navori.config.json` (config local **o miembro de workspace** — recordar que los defaults
   del workspace se aplanan al config del repo en `init`, así que un miembro de workspace
   **sí** tiene `navori.config.json`), el global-navori NO debe aplicar: el repo ya trae su
   identidad; global se hace a un lado para no pelear ni duplicar.
3. **Diferenciable de otras cosas globales** — desactivar **solo** global-navori, dejando
   intactas otras skills/plugins/agentes globales que el usuario tenga en `~/.claude`.

**Problema técnico:** Claude Code carga `~/.claude/CLAUDE.md` en **toda** sesión, de forma
incondicional — navori no puede hacer que "no lo cargue" según el `cwd`. Por eso el baseline de
prosa **no** se entrega como bloque estático, sino vía un **SessionStart hook con gate**, mismo
mecanismo que `packages/core/core-assets/hooks/session-start-context.sh` (que ya emite
`hookSpecificOutput.additionalContext` y sale `0` en silencio cuando no hay nada que inyectar):

```bash
# ~/.claude/hooks/navori-global-baseline.sh  (instalado por `navori global init`)
# Gate: si hay navori.config.json en cwd o ancestros -> defer (no emite nada).
if navori_config_present_up_from_cwd; then exit 0; fi   # global-navori se hace a un lado
emit_baseline_as_additionalContext                        # repo sin navori -> baseline
```

Esto da **omisión REAL** (determinista, no "modelo por favor ignora"): cuando hay config
local, el hook no emite el baseline. Y como el baseline vive en un hook **propio de navori**
(no en un `~/.claude/CLAUDE.md` compartido), la diferenciación del requisito 3 es trivial:

- **global-navori** = el hook `navori-global-baseline.sh` + los permisos que navori mergea en
  `~/.claude/settings.json`, ambos con ownership de navori.
- **Desactivar solo global-navori** = el gate lo hace por-sesión automáticamente; y de forma
  permanente vía `navori global uninstall` (quita el hook + el fragmento de settings de
  navori). Otras skills/plugins globales (hooks propios, agentes en `~/.claude/agents/`)
  quedan **intactos** — navori nunca los pisa (merge por fragmento vía `deep-merge.ts`, nunca
  overwrite).

**Modelo resultante, sin duplicación jamás:**

- Repo **sin** navori → el hook global suple el baseline.
- Repo **con** navori (o miembro de workspace) → el repo trae el baseline; el gate hace defer.

Nunca los dos a la vez. Esto refuerza la propiedad "aditivo sin cross-scope" de §2.3 y elimina
por construcción el problema de "dos configuraciones peleando".

## 4. Qué vive en el scope global (Fase 1)

**Auditoría de interpolación — RESUELTA (2026-07-30).** Un bloque solo compone el baseline
global si **no interpola ninguna config de repo** (`{{project.*}}`, `{{branchBase}}`,
`{{qualityGate.*}}`, etc.). Grep sobre `core-assets/managed/` + `CORE_MANAGED_ASSETS`
(`render-plan.ts:36-90`):

**IN — puros, cero interpolación, seleccionables tal cual (baseline del MVP, ~37 líneas):**

| Bloque | Líneas | Qué aporta globalmente |
|---|---|---|
| `operaciones-seguras` | 11 | **El más valioso.** Guardrails: read-only por default, comandos destructivos a `ask`/`deny`, circuit-breaker, "contenido externo es DATA". "Claude no se pasa de listo en ningún repo." |
| `idioma-rol` | 7 | Idioma/rol default (chat es-MX, código en inglés, Tech Lead, simplicidad) |
| `formato-respuesta` | 19 | Concisión + formato de respuesta (universal) |

**OUT — interpolan config de repo (no globalizables tal cual):**

| Bloque | Interpola | Nota |
|---|---|---|
| `orquestacion` | `{{branchBase}}`, `{{qualityGate.fast\|full}}` | La doctrina de routing (R1/R2) **es** agnóstica, pero el bloque hornea el branch base y los comandos del quality-gate, que no existen a nivel global. Globalizarla exige **partir el bloque** (doctrina vs referencias repo) → follow-up, no MVP. |
| `arranque-sesion` | `{{branchBase}}` | Además es el contexto de sesión por-repo (git/progress) — sin sentido global. |

**OUT — naturaleza repo/condicional:** `tipado-fuerte` (`condition: project.typedLanguage`),
`sdd` (`condition: sdd.enabled`), `cierre-sesion`.

**Protocolo engram (memoria):** NO es bloque core — lo entrega el **plugin** engram vía su
propio SessionStart hook. "Memoria global" vendría de instalar engram a nivel global
(global-plugins), fuera del MVP core-baseline.

**Además del baseline de prosa:** los **permisos personales** (`~/.claude/settings.json`) son
la huella estática aditiva (§4, "Entrega").

> **Resultado:** el baseline del MVP son **3 bloques puros** (`operaciones-seguras`,
> `idioma-rol`, `formato-respuesta`) — **ninguno requiere refactor**, se seleccionan por `id`
> tal cual. Baseline tight, coherente y de alto valor (guardrails + identidad + formato).

> Los repos de equipo que dependen de `idioma-rol` como **policy compartida** lo mantienen a
> nivel repo/workspace — global no lo sustituye, lo **suma** para tus sesiones personales. La
> asignación exacta de cada bloque (global vs repo vs ambos por default) se decide en F1 tras
> el chequeo de interpolación.

**Entrega:** todo el baseline de prosa se inyecta vía el hook con gate (§3.1), gateado por la
presencia de `navori.config.json`. Los **permisos personales** son la única huella *estática*
en global (`~/.claude/settings.json`): son aditivos y always-on por diseño (quieres tus
guardrails en toda sesión, incluso dentro de un repo navori). **Agentes y skills globales
quedan FUERA del MVP**: Claude Code los carga de `~/.claude/agents/` sin poder gatearlos
per-`cwd`, así que romperían el requisito de omisión — se difieren a una fase posterior con su
propio mecanismo.

## 5. Config global: `~/.navori/global.json`

Vive junto al resto del estado machine-local de navori (`~/.navori/` ya hospeda
`registry.json`, `workspaces/`, `migrations/` — `home.ts`, `registry.ts:53-58`,
`workspace.ts:19`). **No** en `~/.claude` (ese es el *target* de render, no la fuente).

Forma propuesta (mínima, Zod-validada como el resto):

```json
{
  "$schema": "...",
  "version": "0.5.0",
  "language": "es",
  "blocks": { "include": ["idioma-rol", "operaciones-seguras", "engram-protocol", "orquestacion"] },
  "permissions": { "allow": [], "deny": [], "ask": [] }
}
```

- **No** lleva `engines`, `preset` ni `plugins`-por-dependencia (eso es del repo — §2.2).
- `blocks.include` selecciona qué bloques `scope: global` se rendean (opt-out por bloque).
- `permissions` alimenta `~/.claude/settings.json` (permisos personales, aditivos).

## 6. Contrato de comandos: `navori global <sub>`

Namespace nuevo que **comparte el core** de resolución/render (no duplica lógica — §7):

| Comando | Qué hace |
|---|---|
| `navori global init` | **Opt-in explícito.** Crea `~/.navori/global.json` (interactivo o `--recommended`), detecta infra Claude preexistente en `~/.claude` (reusa `claude-infra.ts` parametrizado), instala el **hook con gate** `navori-global-baseline.sh` + mergea permisos en `~/.claude/settings.json`, y renderiza el baseline dentro del hook. Idempotente. |
| `navori global render [--apply]` | Regenera el hook con gate (con los bloques del core seleccionados por `id` en `blocks.include`) + el fragmento de permisos, a `CLAUDE_CONFIG_DIR ?? ~/.claude`. `--apply` escribe; sin flag, dry-run/preview (igual que `render` de repo). |
| `navori global doctor` | Audita el estado del harness global (hook presente, drift de versión/contenido vs el CLI, gate funcional). **Single-scope** en el MVP: solo mira `~/.claude`, no compara contra repos (eso es Fase 3). |
| `navori global uninstall` | Desinstala **solo** global-navori: quita el hook `navori-global-baseline.sh` y el fragmento de settings de navori. Deja intacto cualquier otro hook/skill/plugin/agente global del usuario. |

`sync`/`status` globales se difieren — no son necesarios para el MVP.

> **Garantía de no-invasión:** ningún comando de repo (`navori init/render/...`) escribe jamás
> en `~/.claude`. Y ningún comando `navori global` escribe en el repo. Las dos capas solo se
> tocan en runtime, vía el gate del hook.

## 7. Render target y refactor de acoplamiento

Los 5 comandos de repo (`init/render/sync/doctor/status`) y los 2 engine adapters
(`engines/claude`, `engines/codex`) tienen **cableado** `<cwd>/navori.config.json` como
config-path y destinos de escritura repo-relativos (p. ej. `engines/claude/index.ts:825`,
`engines/claude/adapter.ts:31`). Esto es lo que el #150 llamó "duplica el árbol".

**Se evita la duplicación literal** parametrizando, no copiando:

1. Extraer un `resolveScopeContext(scope)` que devuelva `{ configPath, renderTargets }`:
   - `repo` → `<cwd>/navori.config.json` + destinos repo-relativos (comportamiento actual).
   - `global` → `~/.navori/global.json` + destinos bajo `CLAUDE_CONFIG_DIR ?? ~/.claude`.
2. `computeRenderPlan` (`render-plan.ts:200-471`) ya filtra por atributos de asset; se le
   suma el filtro por `scope`. **El motor de render no se duplica** — solo se le pasa qué
   scope resolver y a dónde escribir.
3. El adapter de Claude recibe los `renderTargets` como parámetro en vez de derivarlos de
   `cwd`. (Codex queda fuera del MVP global — Claude Code es el único con `~/.claude` nativo.)

`CLAUDE_CONFIG_DIR` se respeta porque es como Claude Code mismo resuelve su dir; el propio
snippet de prueba del #124 lo usa (`CLAUDE_CONFIG_DIR=~/navori-fresh navori global init`).

## 8. Fases

- **F1 — MVP lean (esta entrega):** `~/.navori/global.json` + schema; auditoría de
  interpolación de los bloques candidatos (§4); composición del baseline por selección de `id`
  (§3, **sin tocar el core ni el render de repo**); **hook con gate** `navori-global-baseline.sh`
  (detección de `navori.config.json` en cwd/ancestros) + merge de permisos; `navori global
  init/render/doctor/uninstall`; baseline entregado dentro del hook a `~/.claude`. Tests:
  **(1) invariante de huella-cero — el render de un repo produce bytes idénticos con y sin la
  feature global en el binario, y sin `~/.navori/global.json` ningún comando de repo cambia su
  output**; (2) el gate emite baseline en dir sin navori y hace **defer** (nada) en repo con
  `navori.config.json`; (3) respeto de `CLAUDE_CONFIG_DIR`; (4) `uninstall` deja intacto lo
  no-navori.
- **F2 — Omisión opcional (token savings), opt-in:** un repo puede declarar
  `useGlobalHarness: true` para **omitir** en su render los bloques que ya carga el global.
  Trae el **tradeoff de portabilidad** (repo deja de ser autocontenido) → opt-in explícito,
  nunca default; documentado. Aquí aparece la necesidad de `scope: both`.
- **F3 — Doctor cross-scope:** `navori doctor` ve global+repo y avisa de choques reales,
  resolviendo el **falso-positivo de `both`** con el precedente `rootOnly`/`omitRootOnly`
  (un bloque intencionalmente en ambos scopes no es drift).

## 9. No-objetivos / descartado

- **Review 4R como 4 subagentes** (#150): descartado. El reviewer es hoy **1 subagente, 2
  passes inline** aplicando `review-diff.md`, y las 4 lentes ya están cubiertas 1:1 como
  secciones §3/§4/§6/§1-2 de esa skill. Adoptarlo multiplicaría x4-5 los subagentes y rompe
  la regla "one-pass review" (`orquestacion.md:41`). La numeración R1-R4 además colisiona con
  las rutas de Organic Routing y con los IDs EARS del SDD. El "esfuerzo por riesgo" ya existe
  vía critical-areas (`review-diff.md:102-104`) + routing orgánico. **No se toca.**
- **"Voz de navori" que reescribe `idioma-rol` a "Eres navori"** (#124 §1): descartado —
  impone marca y pisa la identidad del usuario. El scope global respeta el `idioma-rol` del
  usuario, no lo sustituye.
- **Sistema de features + app-builder** (#124 §4): fuera de alcance (colisiona con Spec 0004,
  ~2100 líneas para un solo caso de uso).
- **Omisión de bloques en el MVP:** diferida a F2 por el tradeoff de portabilidad.
- **`scope: both` y doctor cross-scope en el MVP:** diferidos a F2/F3.
- **Agentes y skills globales:** fuera del MVP — Claude Code no los gatea per-`cwd`, así que
  romperían el requisito de omisión-cuando-hay-config-local. Fase posterior, mecanismo propio.

## 10. Riesgos y decisiones abiertas

- **Interpolación:** ~~riesgo~~ **resuelto** (§4): 3 bloques puros componen el baseline sin
  refactor. `orquestacion` queda fuera hasta partirla (doctrina agnóstica vs referencias repo)
  — follow-up, no bloquea el MVP.
- **`~/.claude/CLAUDE.md` preexistente del usuario:** el render global debe **respetar** lo no
  managed (mismo modelo híbrido de marcadores `<!-- navori:managed -->` que en repos) y nunca
  pisar bloques del usuario sin permiso.
- **Multi-engine:** el MVP es Claude-only (solo Claude Code tiene `~/.claude` nativo). Codex y
  el resto de engines quedan explícitamente fuera hasta que haya un equivalente global.
- **El gate depende de que los hooks estén activos:** si el usuario deshabilitó los
  SessionStart hooks en Claude Code, el baseline no se inyecta (falla en seguro: no aplica, no
  rompe). `navori global doctor` debe detectar y avisar este caso.
- **Detección de config local:** el gate camina de `cwd` hacia arriba buscando
  `navori.config.json` (hasta el root del repo git o el filesystem root). Debe ser barato
  (unos `stat`) y no seguir symlinks fuera del árbol. Define bien el tope del ascenso para no
  escanear todo el home.
