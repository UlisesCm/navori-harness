# Spec 0010 — Harness global (base sólida por-máquina en `~/.claude`)

> Estado: **F1 implementado** · 2026-07-30 · Baseline (operaciones-seguras + idioma-rol +
> formato-respuesta) entregado por hook con gate; comandos `navori global
> init/render/doctor/uninstall`; invariante de huella-cero con guard estructural. Deriva del
> issue #150 (decisiones de producto parqueadas de #124, @RicardoMarin7). Alcance elegido con
> Ulises: **MVP lean — solo identidad, aditivo**. La "voz de navori", el sistema de
> features/app-builder y el review 4R del #124 quedan **fuera** (ver §9).
>
> **Revisión 2026-08-31 (§8 rehecha).** Auditoría del F1 en disco contra esta spec: 9 huecos,
> de los cuales §4 estaba **desactualizada** (ver la nota ahí). Fases nuevas: **FA** cierra la
> fiabilidad de F1, **FB** lleva skills y subagentes al scope global vía **plugin
> `@skills-dir`**, **FC** es el doctor cross-scope (ex-F3). La **ex-F2** (omisión opt-in de
> bloques en el repo) queda **descartada** — ver §9.
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
| `arranque-sesion` | ~~`{{branchBase}}`~~ **ninguna** | **Corregido 2026-08-31: el asset ya no interpola nada.** Sigue OUT, pero por la razón de fondo, no por la mecánica: habla de `progress/current.md`, `navori doctor` y `navori.config.json`, que en un repo sin navori no existen. Es el caso que motiva `globalSafe` (FA1) — hoy pasaría el check de `{{` de `composeBaseline` e inyectaría prosa repo-específica en toda sesión. |

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
- **~~F2~~ — descartada.** Omisión opt-in de bloques en el repo. Ver §9.
- **~~F3~~ — renumerada a FC** (abajo), y simplificada: sin F2 no hay `scope: both`, así que
  el falso-positivo que la bloqueaba desaparece.

### FA — Cerrar F1 de verdad (fiabilidad)

Cinco unidades sin diseño nuevo. **FA2 y FA3 son las urgentes**: hoy no hay forma de saber si
el baseline se está inyectando.

- **FA1 — `globalSafe` declarado en el asset.** `composeBaseline` valida hoy por regex `/\{\{/`
  (`global-render.ts:62`), que mide interpolación, no seguridad global. Sumar `globalSafe?:
  boolean` a `CoreManagedAsset` (mismo precedente que `rootOnly`) y validar contra el atributo;
  la regex queda como red secundaria. Re-auditar los 10 assets y §4.
  *Pruebas:* (1) rechaza un id sin `globalSafe` aunque no interpole — el caso `arranque-sesion`;
  (2) test de inventario que recorre `CORE_MANAGED_ASSETS` y falla si un asset `globalSafe`
  contiene `{{` o un token repo-específico (`progress/`, `navori.config.json`, `navori doctor`),
  para que la auditoría no pueda volver a envejecer en silencio; (3) `DEFAULT_GLOBAL_BLOCKS` ⊆
  los `globalSafe`.
  > **FB revisó dos de esas reglas** (ver abajo): la de `{{` pasó de "no interpola" a "no deja
  > un `<not configured: …>` al renderizar en scope global", y `progress/`/`.claude/` salieron
  > de la lista de tokens repo-específicos porque los agentes que el plugin instala crean esos
  > archivos ellos mismos. `navori.config.json`, `navori doctor` y `specs/` siguen dentro.
- **FA2 — Marcador y hash en el hook.** El hook dice "MANAGED BY NAVORI" sin `version=` ni hash,
  y `global doctor` solo compara `config.version` contra el CLI (`global.ts:150`): un hook
  editado a mano, o un asset que cambió dentro de la misma versión, es invisible. Es la única
  excepción no declarada al modelo de marcadores del resto de navori.
  *Pruebas:* (1) round-trip render → doctor limpio; (2) editar una línea a mano → doctor
  reporta drift y nombra el archivo; (3) cambiar un asset del baseline sin bumpear versión →
  doctor reporta drift (hoy invisible); (4) `render --apply` reconcilia.
- **FA3 — Doctor ejecuta el gate.** Hoy solo verifica que el archivo exista. El hook necesita
  `node` o `jq` para emitir el JSON (`global-render.ts:123-125`); sin ninguno hace `exit 0`
  mudo — realista con nvm, donde `node` entra al PATH desde `.zshrc` y un Claude Code lanzado
  desde el app bundle de macOS puede no tenerlo. Correrlo en dos tmpdirs (con y sin
  `navori.config.json`) y verificar emisión/defer, más detección de `node`/`jq` ausentes.
  *Pruebas:* los dos casos del gate **vía doctor**; `PATH` recortado → doctor falla con mensaje
  accionable, no en verde; hook presente pero no registrado se distingue de hook ausente.
- **FA4 — Autoría de los permisos y `uninstall` simétrico.** `applyGlobalRender` mergea
  `permissions` en `settings.json` y `uninstallGlobalRender` (`global-render.ts:391`) nunca los
  quita. No es trivial: `deepMerge` dedupea, así que post-merge no se distingue quién puso qué —
  misma clase de autoría que #538. Persistir en `global.json` el set exacto que navori escribió,
  en el momento del merge, y retirar solo esa intersección.
  *Pruebas:* (1) install → uninstall deja `settings.json` **byte-idéntico** al pre-install;
  (2) permiso preexistente que navori también declara → sobrevive; (3) permiso agregado por el
  usuario después del install → sobrevive; (4) dos `render --apply` con `permissions` distintos
  → el registro se actualiza sin acumular huérfanos.
- **FA5 — `init` interactivo + preview.** §6 prometía "interactivo o `--recommended`"; hoy `init`
  acepta solo `--lang` (`global.ts:44`) y escribe sin preview, y el campo `permissions` del
  schema solo se llena editando el JSON a mano. Multiselect de bloques `globalSafe` + prompt de
  permisos (patrón de `init` de repo), `--recommended` headless, `--apply` con preview default.
  *Pruebas:* e2e contra el CLI construido (patrón de `global-render.test.ts:409`):
  `--recommended` no promptea; sin `--apply` no escribe y el preview nombra hook/settings/bloques;
  `init` sobre instalación existente preserva la selección y no la resetea a los defaults.

### FB — Skills y subagentes globales, como plugin `@skills-dir`

Es lo que hace que un repo sin navori herede un harness **operativo** y no solo 37 líneas de
prosa que describen guardrails inexistentes.

**Spike ejecutado (2026-08-31) — resultado que define el diseño.** La precedencia de Claude Code
NO es uniforme entre agentes y skills:

| Asset | Precedencia | Consecuencia para navori |
|---|---|---|
| Subagentes | `.claude/agents/` (prio 3) **gana** a `~/.claude/agents/` (prio 4) | Instalarlos sueltos sería seguro |
| Skills | **personal gana a project** — *"with a `deploy` skill in both `~/.claude/skills/` and your project's `.claude/skills/`, `/deploy` runs the personal one"* | Instalarlas sueltas **eclipsaría las del repo**, user-sections incluidas, en silencio y en los 15+ repos Bonum |

La salida no es renunciar a las skills: es **empaquetar todo como plugin**. Un directorio bajo
`~/.claude/skills/` con `.claude-plugin/plugin.json` se carga como `navori@skills-dir` *"on the
next session, with no marketplace and no install step"*, y soporta el layout completo:

```
~/.claude/skills/navori/
├── .claude-plugin/plugin.json     name: "navori"
├── skills/     → las 12 base, invocables como /navori:<nombre>
├── agents/     → los 7 invocables + leader.md
└── hooks/hooks.json  → el gate del §3.1 se muda aquí
```

Cuatro propiedades que salen del mecanismo, no de cuidado nuestro:

1. **Las skills no pueden eclipsar.** *"Plugin skills are namespaced as `/plugin-name:skill-name`,
   so the original `/skill-name` and the plugin copy both remain available rather than one
   overriding the other."*
2. **Los agentes heredan el gate gratis.** *"Project and user `.claude/agents/` definitions
   override same-named plugin agents."* Repo con navori → gana el del repo. Repo sin navori →
   el del plugin es el único. Es la semántica de defer del §3.1 sin walk-up ni detección.
3. **`uninstall` es borrar un directorio** — *"There is no `uninstall` step because nothing was
   installed from a marketplace"* — más un `claude plugin disable navori@skills-dir` que el
   usuario gana sin que lo construyamos.
4. **El gate sale de `settings.json`.** Con `hooks/hooks.json` en el plugin, el merge de hooks
   desaparece; en `settings.json` solo quedan los `permissions` (el `settings.json` de plugin
   acepta únicamente `agent` y `subagentStatusLine`).

**Interpolación: el modo `globalFallback`.** El inventario de los 8 agentes y las 12 skills
desmiente el supuesto de que los agentes de escritura no son globalizables:

| Placeholder | Naturaleza | Resolución global |
|---|---|---|
| `{{models.X}}`, `{{effort.X}}` | Config del **harness**, no del repo | `global.json` los lleva igual que el repo; `omitUnresolvedKeyLines` ya cubre el frontmatter |
| `{{project.criticalAreas}}`, `{{project.legacyPaths}}` | Repo, con fallback genérico **ya escrito** | `placeholders.ts:38-40`, sin cambios |
| `{{sdd.specsDir}}` | Default sano (`specs/`) | sin cambios |
| `{{qualityGate.fast\|full}}`, `{{branchBase}}`, `{{prTarget}}` | Repo de verdad | **`globalFallback`** (abajo) |

Los tres últimos NO se resuelven detectando: un archivo en `~/.claude` es estático y la detección
es por-`cwd`, en tiempo de sesión. Y no se arreglan inyectándolos por el hook, porque un subagente
arranca con su propio contexto y no vería el `additionalContext` de la sesión principal. La salida
es que el agente global **derive** en vez de traer horneado: *corre el quality gate del proyecto —
si el repo declara uno en su `CLAUDE.md`, ese; si no, derívalo de `package.json`/`Makefile` y
declara cuál corriste*. Es un `SOFT_FALLBACKS` paralelo en `placeholders.ts`, no un motor nuevo.
La simetría lo justifica: el agente global solo corre en repos sin navori, donde por definición no
hay gate declarado que hornear.

**Esto retira el follow-up de "partir `orquestacion`"**: existía solo mientras la única salida
fuera la pureza de interpolación. Con `globalFallback`, el bloque entra completo al baseline — y
tiene que entrar, porque sin la doctrina de routing instalas 7 agentes que el orquestador no sabe
cuándo lanzar.

*Pruebas:* (1) inventario — **todo** asset de `core-assets/agents/` y `core-assets/skills/`
renderiza en modo global sin dejar un solo `<not configured: …>`; es la red que impide que un
placeholder nuevo se cuele sin fallback global (#375 y #445 ya causaron esa clase de bug en el
path de repo); (2) el agente global renderizado **no** contiene un comando de quality gate
literal, y sí la instrucción de derivarlo; (3) en un repo **con** navori, `.claude/agents/` queda
byte-idéntico con y sin harness global instalado — extiende el guard de huella-cero a FB;
(4) round-trip: `global init` completo → `uninstall` deja `~/.claude/skills` como estaba, skills
propias del usuario incluidas; (5) `plugin.json` válido contra `claude plugin validate`.

*Costos, dichos completos:* las skills globales se invocan `/navori:<nombre>` (irrelevante para
invocación por modelo, cosmético para slash); una org con `blockedMarketplaces: [{source:
"skills-dir"}]` o `strictKnownMarketplaces` lo bloquea — FC debe detectarlo; los cambios que no
son de `SKILL.md` piden `/reload-plugins` tras `render --apply`; las sesiones de Cowork y cloud
no leen `~/.claude/skills/`, así que el harness global no alcanza routines. Y mover el hook de
`settings.json` al plugin **es una migración** para instalaciones F1 existentes → entrada en
`navori migrations`.

> **ENTREGADO** (#546). Cinco cosas salieron distintas del boceto, todas hacia abajo en alcance
> o hacia arriba en honestidad:
>
> 1. **`settings.json` queda solo con `permissions`, y a menudo ni se crea.** Con el gate dentro
>    del plugin, una config sin permisos declarados produce un merge idéntico a lo que ya hay en
>    disco, así que `applyGlobalRender` no escribe: reescribir el archivo machine-wide del
>    usuario para no cambiar nada es un backup, un reformateo y un mtime que nadie pidió.
> 2. **La migración F1→FB deja copia restaurable.** `createMigrationSnapshot` (la mitad genérica
>    extraída de `createMigrationBackup`) copia el hook suelto y `settings.json` a
>    `~/.navori/migrations/<ts>/claude-global/` antes de borrarlos; se recuperan con
>    `navori migrations restore <ts> claude-global --cwd ~/.claude`. El orden importa: la
>    migración corre ANTES de planear settings, o el merge reescribiría el registro recién
>    quitado.
> 3. **`blocks.include` se actualiza solo si nadie lo tocó.** Una instalación F1 lleva los 3
>    bloques escritos explícitamente, así que el default del schema no la alcanza; el render
>    sube esa selección a la nueva **solo** cuando es idéntica a la que F1 shippeó.
> 4. **El manifest lleva `author`.** Sin él `claude plugin validate --strict` avisa, y ese aviso
>    es un error bajo la bandera contra la que la prueba 5 valida. Nada más entra ahí: cualquier
>    clave extra —incluido el marcador de autoría de navori— la reporta el validador.
> 5. **Los fallbacks globales son cortos y sin backticks.** Los assets envuelven estos
>    placeholders en code spans (``not on `{{branchBase}}` ``): un backtick dentro cierra el span
>    antes de tiempo. Y `{{prTarget}}` solo aterriza 22 veces en un agente, así que una frase
>    aquí es un párrafo allá. Las dos reglas están puestas como test.

### FC — Doctor cross-scope (ex-F3)

Sin F2 no existe `scope: both`, y con él desaparece el falso-positivo que la bloqueaba. Queda algo
chico y honesto: `navori doctor` detecta si hay harness global instalado y avisa de **choques
reales** — un agente del plugin ensombrecido de forma no intencional, un permiso global que
contradice un `deny` del repo, drift del hook, y el caso `@skills-dir` bloqueado por managed
settings. Nada más.

*Pruebas:* (1) repo sin global instalado → doctor no menciona la capa global en absoluto (huella
cero también en el output); (2) agente homónimo en ambos scopes → un aviso que nombra la
resolución de precedencia; (3) `deny` de repo contra `allow` global de la misma regla → aviso;
(4) global sano + repo sano → cero ruido.

### FD — Documentación

`navori global` no aparece en el README ni en el website: `commandOrder`
(`apps/website/src/content/commands.ts:432`) documenta 8 de 20 comandos. En una feature **opt-in**
eso es fatal — hay que pedirla explícitamente y nada la anuncia. Entrada `global` con sus 4
subcomandos, sección en el README, párrafo en `DIRECTION.md`. Y el guard que cierra la clase
entera: **un test que falla si un subcomando registrado en `index.ts` no está en `commandOrder`**,
igual que `subcommand-inventory.test.ts` hace contra `CLAUDE.md`.

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
- **Omisión de bloques (ex-F2) — DESCARTADA** (2026-08-31, con Ulises). Un repo con navori que
  declara `useGlobalHarness: true` y omite de su render los bloques que ya carga el global.
  Se descarta porque **el valor se evaporó y el costo sigue ahí**: el ahorro que perseguía era
  evitar la doble emisión, y el gate de F1 (§3.1) ya la elimina por construcción. Lo que
  quedaría es adelgazar el `CLAUDE.md` de un repo que *sí* tiene navori, a cambio de romper que
  sea autocontenido — un compañero sin `navori global init` clona y recibe un harness degradado,
  sin ningún aviso. Ese tradeoff se paga en soporte, no en tokens. Además arrastraba `scope:
  "both"` al core, que era la única razón por la que FC tenía un falso-positivo que resolver.
- **Skills globales sueltas en `~/.claude/skills/` — DESCARTADO** por el spike de FB: en skills
  **personal gana a project**, así que eclipsarían las del repo (user-sections incluidas) en
  silencio. El scope global entrega skills solo vía plugin `@skills-dir`, que las namespacea.
- **`scope: both`:** ya no hace falta — era un requisito de la ex-F2.
- **Agentes y skills globales:** fuera del **MVP** — Claude Code no los gatea per-`cwd`, así que
  romperían el requisito de omisión-cuando-hay-config-local. **Ya no es un no-objetivo: es FB**,
  y el mecanismo propio que pedía resultó ser el plugin `@skills-dir` (la precedencia de plugin
  hace el trabajo del gate).

## 10. Riesgos y decisiones abiertas

- **Interpolación:** ~~riesgo~~ **resuelto** (§4): 3 bloques puros componen el baseline sin
  refactor. ~~`orquestacion` queda fuera hasta partirla (doctrina agnóstica vs referencias
  repo) — follow-up~~ **Retirado en FB**: con el modo `globalFallback` el bloque entra completo
  y no hay que partirlo. El follow-up existía solo mientras la única salida fuera la pureza de
  interpolación.
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
