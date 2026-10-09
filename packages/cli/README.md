# navori

Multi-agent harness + SDD scaffolder for Claude Code (and other AI engines).

`navori` lleva tu setup de Claude Code (agentes, skills, hooks, CLAUDE.md, AGENTS.md) a múltiples repos con un solo comando — sin perder customización local, sin sobrescribir lo que ya tenías.

También renderiza un harness Codex completo: `AGENTS.md`, skills en
`.agents/skills/`, agentes y hooks en `.codex/`, y MCP project-local.

### Perfiles de engines

```jsonc
// Paridad completa para ambos proveedores
{ "engines": ["claude", "codex"] }

// Claude completo + guía AGENTS.md ligera para Codex y otras herramientas
{ "engines": ["claude", "agents-md"] }

// Solo guía universal, con el menor número de archivos
{ "engines": ["agents-md"] }
```

`codex` ya incluye y administra `AGENTS.md`; no necesitas combinarlo con
`agents-md`. Si ambos aparecen en un config, el adapter Codex toma precedencia
para evitar bloques duplicados.

## Instalación

```bash
npm i -g navori
# o sin instalar
npx navori init
```

## Quick start

```bash
# Modo opinado: cero preguntas, harness completo sin instalar software externo
# (engram siempre activo, +gh si el repo tiene remote de GitHub).
# Avisa si falta el binario de algún plugin habilitado y cómo instalarlo.
cd ~/tu-repo
navori init --recommended

# + proveedores externos (tgrep, semgrep, jscpd, acli) + pre-commit hook +
# scan-monorepo + project block estricto — requiere instalar los binarios de esos proveedores.
# También avisa si falta algún binario y cómo instalarlo, sin instalarlo nunca.
navori init --full

# O wizard interactivo con detección de stack
navori init
```

El `init` detecta automáticamente del repo:
- **Nombre** del proyecto (de `package.json`, `pyproject.toml`, `Cargo.toml`, git remote o basename)
- **Stack**: framework (Next.js, Vite, NestJS, Express, Astro, etc.), UI, forms, state, test
- **Preset sugerido** según el stack (ej. `vite-react-ts-mantine`, `nextjs`, `express-mongoose`)
- **Quality gate** compuesto de los scripts del `package.json`
- **Branch base** del git (`origin/HEAD`, fallback main/master/develop)
- **Infraestructura Claude existente** (`.claude/`, `CLAUDE.md`, `AGENTS.md`, agents, skills) — ofrece coexistir o reemplazar con backup

Y genera:
- `navori.config.json` — fuente de verdad del repo
- `CLAUDE.md` con managed blocks que el CLI mantiene sincronizados
- `.claude/` con agentes, skills, hooks y settings

### Aviso opcional de actualización

En comandos interactivos, navori puede avisar si detecta una versión más nueva. La
consulta al registro de npm se ejecuta en segundo plano y no bloquea el comando;
por eso, la primera ejecución solo inicia la actualización de la caché y el aviso
puede aparecer en una ejecución posterior. Se limita a una consulta y un aviso
cada 24 horas. No se muestra en CI, en modo JSON ni en comandos de ayuda o versión.

Para desactivarlo, define `NAVORI_NO_UPDATE_NOTIFIER=1`. El aviso recomienda el
comando de actualización según el instalador detectado, con `npx` como alternativa.
No instala ni actualiza automáticamente y tampoco ejecuta `render`: después de
actualizar navori, corre `navori render --apply` para aplicar los cambios a tu
harness.

#### Avisos de actualización de herramientas de plugin

Plugins como `engram` pueden declarar `latestRelease` en su manifest para recibir
avisos cuando existe una versión más nueva. El aviso aparece al final del contexto de
arranque, en un espacio reservado de 300 caracteres, una vez cada 24 h por versión.

La consulta se ejecuta:
- **Fuente**: `api.github.com/repos/<owner>/<repo>/releases/latest` o
  `registry.npmjs.org/<package>/latest` (sin token, solo un User-Agent `navori/<version>`)
- **Frecuencia**: máximo una solicitud por herramienta por día, reservada bajo un lock
- **Red**: la carga de red ocurre en un worker detached en segundo plano; la sesión
  nunca espera
- **Caché**: `~/.navori/tool-versions/` (similar a `~/.navori/update-notice/`)
- **CI**: sin red — ni refrescos ni avisos

Desactívalo junto con el aviso de navori: `NAVORI_NO_UPDATE_NOTIFIER=1`.

**Limitaciones:**
- Codex en sandboxes sin red no obtiene refrescos ni avisos.
- pi no tiene hooks de sesión: ahí los avisos solo aparecen en `navori doctor`.
- Si el aviso no cabe en su reserva, se muestra un puntero a `navori doctor` y el aviso
  se reintenta en la siguiente sesión (no se marca como entregado).
- `doctor` muestra todos los avisos como filas informativas, sin aplicar `--strict`.

Si un cierre abrupto deja bloqueado el aviso, solo intervendrás si el lock persiste
más de un minuto. En ese caso, detén todos los procesos `navori` y elimina
`~/.navori/tool-versions/lock` o `~/.navori/update-notice/lock`; conserva los archivos
de caché de ambos directorios.

## Comandos

| Comando | Qué hace |
|---|---|
| `init` | Bootstrap del repo con detección automática + wizard (o `--recommended` sin preguntas y sin instalar software externo, o `--full` para sumar proveedores externos + política estricta) |
| `add <plugin>` | Activa un plugin y opcionalmente instala la tool externa |
| `remove <plugin>` | Desactiva un plugin y limpia sus bloques managed, sub-bloques y scripts |
| `configure <section>` | Ajusta una sección del config sin re-correr el wizard |
| `adopt <path>` | Toma un archivo de `.claude/` que escribiste a mano bajo gestión de navori: lo envuelve en un bloque managed sin reescribir su contenido (preview por default) |
| `update` | Re-detecta el repo, refresca config y corre sync en un paso |
| `render` | Genera los archivos nativos de cada engine configurado (preview por default; `--apply` escribe). `--all` renderea todos los repos del registro global; `--prune` limpia los que ya no existen |
| `registry <sub>` | Registro global de tus repos con navori, para `render --all` (`ls`, `scan <dir>`, `add`, `remove`, `prune`) |
| `sync` | Refresca todos los engines configurados con conflict resolution + backups. Los bloques en conflicto se resuelven con `--interactive` (diff, keep-mine / accept-new) o en bloque con `--accept-new` / `--keep-mine`. Los archivos completos sin marcador se resuelven archivo por archivo en modo interactivo (diff, keep / accept); `--accept-new-files` acepta en bloque los resolvibles |
| `preset init <id>` | Scaffoldea un preset local en `.navori/presets/<id>/` |
| `scan` | Detecta workspaces nuevos en monorepos (`pnpm-workspace.yaml` / `package.json#workspaces`) |
| `doctor` | Audita el config + drift de cada managed block (CLAUDE.md **y AGENTS.md**), orden canónico, markers malformados, desincronización de monorepo y tools externas faltantes (`--strict` para CI). Informativo, sin afectar `--strict`: versiones instaladas con problema conocido (`externalTool.versionAdvisory`) y avisos de versiones nuevas de herramientas (`navori tools notice`) |
| `status` | Snapshot rápido: config, plugins activos, conteo de drift y próximos pasos |
| `audit` | Reporta cómo corrió el harness de verdad: atribución de tokens, huecos de adherencia y outcomes de revisión y receipt; disponibilidad de herramientas por ventanas; eficiencia y ciclo de vida por tarea aceptada. `--snapshot` guarda una foto nombrada del rango y `--compare` la contrasta con otra por cohorte, con causas y evidencia |
| `receipt <sub>` | Recibo de los bytes revisados antes de publicar: `sign` (`--feature <id>`, `--gate-ran scoped\|full`, `--spec <dir> --milestone <Mn>`), `check`, `gate --spec <dir> --milestone <Mn>` (decide si el milestone necesita el gate acotado o el completo) y `review begin` / `review seal --nonce <n>` (sidecar de revisión con identidad de contenido). Flags comunes: `--target <ref>`, `--dir <path>`, `--json` |
| `spec <classify\|check> <feature>` | `classify` decide si una spec sale en 1 PR o en una PR por entrega (umbrales de `sdd.deliveries`); `check` valida su `tasks.md`: milestones, criterios, cobertura y entregas verticales. Flags: `--cwd`, `--json` |
| `tools notice [--ack <pluginId@x.y.z,…>]` | Emite los avisos de versiones de herramientas externas pendientes para el hook de arranque; `--ack` los marca como entregados |
| `handoff <check>` | Valida el handoff del implementer (`impl_<feature>.json`) antes de despachar al siguiente agente (`navori handoff check <feature> [--for scribe] [--dir <path>] [--cwd <checkout>] [--json]`) |
| `plan <sub>` | Planificación por niveles (`harness.planTiers`): `classify [--files\|--diff]` mide complejidad y nivel de una tarea, `render`/`update` mantienen el workplan Markdown en sync con su JSON, `check` valida su esquema y reglas, `gate` es el hook `PreToolUse(Agent)` que niega el despacho sin workplan válido |
| `master <sub>` | Flujo guiado del plan maestro por etapas (`init`, `ux`, `mode`, `template`, `check`, `advance`, `status`, `part`, `close`) y entregas de sus partes: `delivery-slice`, `delivery-check`, `delivery-baseline`, `delivery-queue`, `delivery-criterion`, `delivery-review`, `delivery-present`, `delivery-decision`, `delivery-publication`, `delivery-revoke`. Las que autorizan o aprueban llevan `--approved-by` |
| `bench` | Corre `render` en dry-run N veces y reporta latencias (detecta regresiones locales) |
| `workspace <sub>` | Gestiona workspaces cross-repo (`init`, `ls`, `show`, `link`, `add-repo`, `set-default`, `render`, `rename`, `delete`) |
| `ticket <sub>` | Gestiona tickets-as-files en un workspace (`new`, `list`, `show`, `archive`, `delete`) |
| `dominio <sub>` | Base de conocimiento durable del workspace (`init`, `list`, `show`, `reindex`, `doctor`, `inject`) |
| `codex <sub>` | Comandos específicos de Codex; hoy `trust` aprueba los hooks del proyecto en `~/.codex/config.toml` |
| `backup <sub>` | Lista y restaura backups de `~/.navori/backups/` |
| `migrations <sub>` | Lista y restaura migraciones de `~/.navori/migrations/` |

## Presets

Un preset aporta skills y reglas específicas del stack además del core. El `init` te sugiere uno según lo que detecta.

**Presets oficiales (incluidos):**

| Preset | Stack |
|---|---|
| `vite-react-ts` | Vite + React + TS (SPA, agnóstico de UI-lib) |
| `vite-react-ts-mantine` | Vite + React + TS + Mantine (SPA) |
| `nextjs` | Next.js (App Router) |
| `react-native-expo` | React Native + Expo (app móvil) |
| `astro` | Astro (static / SSR) |
| `nestjs` | NestJS (backend) |
| `express` | Express (backend, agnóstico de DB) |
| `express-mongoose` | Express + Mongoose (backend) |
| `fastapi-python` | FastAPI (backend, Python) |
| `bun-keystone` | Keystone 6 + Prisma (backend, Bun) |
| `background-worker` | Worker de fondo (jobs + colas: agenda / bullmq / amqplib) |
| `medusa` | Medusa.js v2 (backend) |
| `monorepo-turbopnpm` | Monorepo con Turborepo + pnpm workspaces |

Los presets **neutros** (`vite-react-ts`, `express`) traen las skills genéricas del stack sin atarte a una lib; los especializados (`…-mantine`, `…-mongoose`) agregan las skills de esa capa encima.

**¿Tu stack no tiene preset oficial?** No pasa nada. El `init` instala el harness completo (agentes, gates, protocolo, SDD) y funciona desde ya — solo te quedas sin los skills específicos del stack. El init te avisa, te deja en el baseline (`preset: custom`) y te sugiere cubrir el gap con un preset local.

**Presets locales** — crea uno checked-in al repo bajo `.navori/presets/<id>/`:

```bash
navori preset init sveltekit
# ✓ .navori/presets/sveltekit/  (manifest + managed/stack.md + skills/)
# ✓ navori.config.json → preset: sveltekit
# → edita las plantillas y corre 'navori render --apply'
```

La resolución es **local → bundled**: si tienes un preset local con el mismo id que uno oficial, gana el local. Así puedes override un preset incluido sin tocar el paquete.

## Plugins disponibles

| Plugin | Para qué | External tool |
|---|---|---|
| `engram` | Memoria persistente entre sesiones | `engram` binary |
| `codegraph` | Descubrimiento estructural de código vía MCP; opt-in explícito (no incluido en `--full`) | `codegraph` binary |
| `tgrep` | Descubrimiento textual de código vía CLI indexado | `tgrep` binary |
| `acli` | Leer tickets de Jira desde la terminal | `acli` |
| `gh` | GitHub Issues, PRs y workflow runs | `gh` |
| `jscpd` | Detección de duplicación en el diff | `jscpd` (opt-in) |
| `semgrep` | Security gate local | `semgrep` (opt-in) |

> `codegraph` y `tgrep` se retiraron brevemente el 2026-09-15 y se reintrodujeron el
> 2026-09-16 (#838) con una integración que los hace trabajar entre sí — acta en
> [`docs/research/tgrep-como-funcionaba.md`](https://github.com/UlisesCm/navori-harness/blob/main/docs/research/tgrep-como-funcionaba.md).

Activar uno:
```bash
navori add engram          # te ofrece instalar la tool externa si falta
navori add engram --skip-install   # solo registra el plugin
```

## Planificación por niveles (`harness.planTiers`)

Con `harness.planTiers: true` en `navori.config.json`, `navori plan classify` mide la
complejidad de una tarea (señales como dinero/credenciales/PII, dependencia nueva, migración de
esquema, o tocar una ruta de `project.criticalPaths`) y la ubica en un nivel 0–3. El hook
`PreToolUse(Agent)` (`navori plan gate`) niega el despacho de un subagente sin el workplan que su
nivel exige, y escala la exigencia tras dos rechazos seguidos. Si `navori` falta o su build no tiene el
subcomando `plan`, el hook no tiene veredicto y, en modos que muestran el prompt, pide
confirmación en vez de dejarte sin salida (en `bypassPermissions`, `dontAsk` o `plan` sigue
bloqueando). `navori plan classify --diff`
corre el mismo clasificador contra `git diff --name-only <base>...HEAD` para avisar cuando el
trabajo se salió del nivel que el workplan declaró.

`project.criticalPaths` (array de globs) es opcional: sin él, `classify` solo detecta el criterio
"toca un área crítica" cuando se declara explícitamente con `--criticalArea`, en vez de inferirlo
de los archivos tocados.

El agente `architect` ya no tiene un flag `harness.architect` — renderiza siempre, con
`models.architect`/`effort.architect` (`opus`/`xhigh` por default) ajustando su tier. Un config
que todavía trae `harness.architect` falla con un aviso de clave retirada en vez de ignorarla en
silencio; `navori configure migrate` la quita.

## Entregas de specs (`sdd.deliveries`)

Una spec grande no tiene por qué salir en una sola PR. `navori spec classify <feature>` la mide
contra los umbrales de `sdd.deliveries` en `navori.config.json` (`splitMinTasks`, `splitMinLoc`,
`maxPrsPerSpec`; defaults 12 tareas, 1500 LOC estimadas y 4 PRs) y dice si sale en una PR o en una
PR por entrega. `navori spec check` valida el `tasks.md` contra su gramática:

- **`E<n>`**: entrega; una PR cada una.
- **`M<n>`**: milestone; cada uno se verifica y se commitea por separado.
- **`T<n>`**: tarea; declara los `R<n>` que cubre.

El gate completo corre una vez por PR, no una vez por milestone; el gate por milestone lo decide
`navori receipt gate`.

## Harness de workspaces (`monorepo.workspaceHarness`)

`monorepo.workspaceHarness` decide cuánto harness recibe cada workspace de un monorepo. Es un solo
valor para todo el repo:

- `minimal` (default): su archivo de contexto más las skills que la raíz no tiene ya. Una skill
  idéntica a la de la raíz no se duplica.
- `full`: todo, como antes de recortar.
- `root`: solo su archivo de contexto (`CLAUDE.md`, y `AGENTS.md` bajo Codex). La raíz escribe las
  skills de librería y de preset que declaran los workspaces.

`navori doctor` trata `minimal` y `root` como harness recortado, y avisa si el valor es `full`.

## Harness defensivo (read-only por default)

El harness que genera `navori` trae permisos seguros desde el arranque, para que tengas menos prompts en lo cotidiano sin bajar la guardia en lo peligroso:

- **Las lecturas no piden confirmación**: `git status/diff/log/show`, `ls`, `cat`, `grep`, `Read`/`Glob`/`Grep`, etc. corren sin interrumpirte.
- **Lo destructivo pide confirmación** (`ask`): `rm -rf`, `git push --force`, `git reset --hard`, `git clean -f`, `chmod -R`, …
- **Descartar trabajo sin commitear se bloquea** (`guard-destructive`, `exit 2`, sin aprobación posible): `git reset --hard`, `git checkout -f`, `git checkout -- .` (o `git checkout .`), `git restore <rutas>` sin `--staged`, y `git clean -f` (sin `-n`). El bloqueo depende del estado: si el árbol está limpio, no hay nada que perder y el comando pasa. Si el directorio destino no se puede inspeccionar (variable, sustitución o ruta inexistente), también bloquea. El mensaje indica la ruta para hacerlo de forma segura.
- **El `publisher` no reescribe historia**: tras un commit fallido no ejecuta `git reset` ni reescribe commits. Reporta con `git status` y `git log -1 --stat`, y la recuperación queda para el orquestador o el usuario.
- **Lo catastrófico se rechaza** (`deny`): `rm -rf /`, `sudo rm`, `mkfs`, …
- Un hook `guard-destructive` actúa como backstop adicional.

**Estado efímero fuera del árbol**: los dos hooks del harness (`managed-drift-watch.sh` y `routing-watch.sh`) escriben su estado en `<git-common-dir>/navori/` — fuera del árbol de trabajo, invisible a `git status`. Además, `render` y `sync` escriben un `.claude/.gitignore` versionado que ignora `progress/`, `worktrees/` y `settings.local.json`, impidiendo que esos paths aparezcan como untracked en `git status`. Si `codex` está habilitado, también genera `.codex/.gitignore` con solo entradas efímeras de ese directorio. Para repos actualizados, también ignora los archivos legacy `.claude/.managed-drift-stamp` y `.claude/.routing-watch/`. Nada que los engines necesiten se ignora.

## Workspace + tickets cross-repo

Si un ticket toca varios repos (frontend + backend + microservicio), el workspace te da un punto único:

```bash
# Crear workspace
navori workspace init bonum --description "Bonum platform"

# Registrar repos del workspace
navori workspace add-repo bonum --name webapp --path ~/dev/bonum/webapp --stack vite-react-ts-mantine
navori workspace add-repo bonum --name backend --path ~/dev/bonum/nexus --stack nestjs

# Crear ticket
navori ticket new bonum BNM-123 --title "Checkout flow rebuild"

# En cada repo que toca el ticket, agrega una referencia:
# echo "ticket: BNM-123" >> progress/current.md

# Ver el ticket + en qué repos aparece
navori ticket show bonum BNM-123
```

El workspace también guarda defaults heredables:
```bash
navori init --workspace bonum    # hereda engines, plugins, branchBase, etc.

# Ajustar un default sin editar el manifest a mano
navori workspace set-default bonum branchBase main
navori workspace set-default bonum prTarget develop      # PRs van a develop, no a main
navori workspace set-default bonum engines claude,cursor
navori workspace set-default bonum plugins.engram.enabled true
```

Y re-renderizar todos los repos del workspace de una vez:
```bash
navori workspace render bonum           # preview (no toca disco)
navori workspace render bonum --apply    # escribe en cada repo
```

Storage: `~/.navori/workspaces/<name>/` (manifest + tickets/ + backups/).

## Rollout global tras un bump de navori

Cuando actualizas el CLI (`npm i -g navori@latest`), el registro global mete los
cambios a **todos** tus repos en un comando — sin ir uno por uno:

```bash
navori render --all            # preview: qué cambiaría en cada repo del registro
navori render --all --apply     # escribe el render nuevo en todos
navori render --all --verbose   # además lista cada bloque managed que cambió, por repo
navori render --all --prune     # además limpia repos que ya no existen
```

El output es un registro autoexplicativo: header con el registro y el modo
(preview/apply), una línea por repo (`created`/`updated`/`conflict`/`removed`/`unchanged`),
un aviso que **nombra** los repos con bloques editados a mano (conflict, que el
render no pisa) y un roll-up `ok · changed · conflict · failed`.

El registro (`~/.navori/registry.json`) se puebla solo: cada `navori init` /
`navori update` te da de alta. Para arrancar con lo que ya tenías instalado,
escanéalo una vez:

```bash
navori registry scan ~/dev ~/otra-carpeta   # registra todo lo que tenga navori.config.json
navori registry ls                          # ver el registro (✓ presente / ✗ missing)
navori registry prune                       # quitar los que ya no existen
```

Es ortogonal a los workspaces: el registro es "qué repos existen"; el workspace
es el perfil de policy (branchBase/prTarget) que cada repo hereda.

## Managed blocks con versionado

Cada bloque que `navori` inyecta en tu `CLAUDE.md` lleva metadata:

```html
<!-- navori:managed id="idioma-rol" hash="3fbef743" version="0.0.1" source="@navori/core" -->
contenido sincronizado
<!-- /navori:managed id="idioma-rol" -->
```

- **`hash`**: detecta si editaste el bloque (sync te avisa antes de pisarlo)
- **`version`**: cuando se publica una nueva versión de `@navori/core` o un plugin, `sync` reporta "update available"
- **`source`**: qué paquete es dueño del bloque (`doctor` te muestra la procedencia de cada uno)

Si modificas un managed block a mano y después corres `sync`, vas a ver:
```
Conflict in 'idioma-rol':
  - tu versión
  + versión del Core
```
Y eliges `skip-conflicts`, resolución interactiva para bloques de `CLAUDE.md`, o `abort`.
Los conflictos de archivo completo nunca se pisan automáticamente.

Backups automáticos en `~/.navori/backups/<timestamp>/` antes de cada `sync` (retención 30 días).

## Customización quirúrgica

Cambiar una sola cosa sin re-init:

```bash
navori configure plugins              # multiselect de plugins activos
navori configure quality-gate         # nuevo comando de quality gate
navori configure language en          # switch a inglés (fallback a es)
navori configure engines              # multiselect: claude / codex / agents-md / cursor / copilot
navori configure branch-base main     # punto de fork / rama protegida
navori configure pr-target develop    # rama destino del PR (gh pr create --base)
navori configure workspace bonum      # asociar a un workspace
navori configure migrate              # renombra claves retiradas (el config vuelve a cargar)
```

`migrate` es la salida cuando un `navori.config.json` quedó bloqueado por claves retiradas de
`harness`/`models`/`effort`: cualquier otro comando aborta al leerlo, así que este lee el JSON
crudo, respalda el archivo y lo reescribe. Los renames 1:1 son automáticos; cuando dos claves
retiradas caen en la misma con valores distintos no se infiere nada — se pregunta, o se pasa por
`--scout=<modelo> --scout-effort=<nivel>`. `--dry-run` no escribe, y `--all` barre el registry
completo (preview salvo `--apply`).

## Extender el harness en tu repo

navori instala un baseline; lo que lo vuelve valioso en **tu** repo es el conocimiento que sólo
tú tienes. Hay cuatro destinos, ordenados de más barato a más caro en archivos, revisión y tokens
por sesión. Empieza arriba de la tabla: el escalón más barato suele ser además el más efectivo.

| Lo que tienes | Dónde va |
|---|---|
| Una regla de tu repo (un patrón propio, la convención de tu data layer) | la **user-section** de la skill que ya cubre el tema |
| Conocimiento que ninguna skill instalada cubre | **skill project-local** |
| Conocimiento de un stack, reusable entre repos | **preset local** (`navori preset init <id>`) |
| Envoltura de un binario o servidor MCP | **plugin** (va a navori, no a tu repo) |

**La user-section es el default.** Cada skill que navori renderiza trae un sentinel
`<!-- navori:user-section -->`; todo lo que escribas después es tuyo y `render`/`sync` no lo tocan
nunca. Cero archivos nuevos, cero config, y la regla queda donde el agente ya iba a mirar.

**Una skill project-local** son dos pasos:

```bash
# 1. la forma DIRECTORIO es la única que el host descubre.
#    Un `<id>.md` suelto en .claude/skills/ no se carga nunca.
mkdir -p .claude/skills/mi-skill && $EDITOR .claude/skills/mi-skill/SKILL.md

# 2. declara el id en navori.config.json:
#    "project": { "localSkills": ["mi-skill"] }
navori doctor   # valida que el archivo exista y que su description diga CUÁNDO usarla
```

Su frontmatter necesita `name`, `type` (`behavior` \| `reference` \| `tool`) y una `description`
con **trigger de activación**. El host carga las skills on-demand leyendo esa línea, así que un
*"Usar cuando…"* es lo que la pone a trabajar sola en el momento justo. `navori doctor` te avisa
cuando a una le falta, que suele ser el arreglo de mayor retorno: el contenido ya está escrito.

navori **nunca escribe dentro** de una skill project-local: no lleva bloque managed ni
user-section, es tuya entera.

→ Guía completa (con las cuatro preguntas que hacen fuerte a una propuesta):
[`docs/EXTENDING.md`](https://github.com/UlisesCm/navori-harness/blob/main/docs/EXTENDING.md).
Contrato del `SKILL.md`: [`docs/recipes/skill-authoring.md`](https://github.com/UlisesCm/navori-harness/blob/main/docs/recipes/skill-authoring.md).

## Filosofía

- **Cero opinión sobre tu proceso**. El CLI detecta y propone; tú decides.
- **Coexiste con harness existente**. El modo `coexist` no toca nada que ya tenías.
- **Nunca pisa silenciosamente**. Hash en el marker + backups antes de cada write.
- **Read-only por default**. Las lecturas no piden permiso; lo destructivo sí.
- **Output legible siempre**. Texto + `--json` para piping en CI.
- **Bilingüe ready**. El schema soporta `language: es | en`. Hoy `es` está full; `en` cae en fallback honesto.

## Licencia

MIT.
