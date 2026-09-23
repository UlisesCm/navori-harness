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
# (engram siempre activo, +gh si el repo tiene remote de GitHub)
cd ~/tu-repo
navori init --recommended

# + proveedores externos (tgrep, codegraph, semgrep, jscpd, acli) + pre-commit hook +
# scan-monorepo + project block estricto — requiere instalar los binarios de esos proveedores
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
| `sync` | Refresca todos los engines configurados con conflict resolution + backups |
| `preset init <id>` | Scaffoldea un preset local en `.navori/presets/<id>/` |
| `scan` | Detecta workspaces nuevos en monorepos (`pnpm-workspace.yaml` / `package.json#workspaces`) |
| `doctor` | Audita el config + drift de cada managed block (CLAUDE.md **y AGENTS.md**), orden canónico, markers malformados, desincronización de monorepo y tools externas faltantes (`--strict` para CI) |
| `status` | Snapshot rápido: config, plugins activos, conteo de drift y próximos pasos |
| `audit` | Reporta cómo corrió el harness de verdad: atribución de tokens y huecos de adherencia en tus sesiones |
| `bench` | Corre `render` en dry-run N veces y reporta latencias (detecta regresiones locales) |
| `workspace <sub>` | Gestiona workspaces cross-repo (`init`, `ls`, `show`, `rm`) |
| `ticket <sub>` | Gestiona tickets-as-files en un workspace (`new`, `list`, `show`, `archive`, `delete`) |
| `dominio <sub>` | Base de conocimiento durable del workspace (`init`, `list`, `show`, `reindex`, `doctor`, `inject`) |
| `global <sub>` | Harness base por máquina en `~/.claude` (`init`, `render`, `doctor`, `uninstall`) — opt-in explícito y aditivo |
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
| `codegraph` | Descubrimiento estructural de código vía MCP | `codegraph` binary |
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

## Harness defensivo (read-only por default)

El harness que genera `navori` trae permisos seguros desde el arranque, para que tengas menos prompts en lo cotidiano sin bajar la guardia en lo peligroso:

- **Las lecturas no piden confirmación**: `git status/diff/log/show`, `ls`, `cat`, `grep`, `Read`/`Glob`/`Grep`, etc. corren sin interrumpirte.
- **Lo destructivo pide confirmación** (`ask`): `rm -rf`, `git push --force`, `git reset --hard`, `git clean -f`, `chmod -R`, …
- **Lo catastrófico se rechaza** (`deny`): `rm -rf /`, `sudo rm`, `mkfs`, …
- Un hook `guard-destructive` actúa como backstop adicional.

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

## Harness global por máquina (opt-in)

Todo lo de arriba es por repo. Cuando abres una sesión **fuera** de un repo con navori (un scratch,
un repo ajeno, tu `~`), no hay harness: ni doctrina de orquestación, ni skills, ni agentes. La capa
global cubre ese hueco. No la confundas con `render --all` de la sección anterior: aquélla empuja tu
harness a los repos que **ya** tienen navori; ésta cubre las sesiones que no están en ninguno.

Es **opt-in de huella cero**: si nunca corres `navori global init`, no existe `~/.navori/global.json`
y navori no escribió un solo byte en tu máquina.

```bash
navori global init                        # wizard: bloques del baseline + permisos personales.
                                          # Preview: sin --apply no escribe un solo byte
navori global init --apply                # escribe lo que el preview mostró
navori global init --recommended --apply  # headless (CI): sin preguntas, selección recomendada
navori global doctor                      # audita: drift del hook, gate, plugin, permisos y versión
navori global render --apply              # re-renderiza tras un bump del CLI (preview sin --apply)
navori global uninstall                   # la retira por completo
```

El `init` pregunta dos cosas: **qué bloques** componen el baseline (los que declaran `globalSafe`)
y **qué permisos personales** quieres en `~/.claude/settings.json` — ése es el único camino de UI
para `permissions`. Re-inicializar **preserva** lo que ya habías elegido: no te resetea a los
defaults. Sin TTY (CI, pipe) cae solo al camino de `--recommended`, y `--lang es|en` fija el idioma
del baseline y de los prompts.

Qué escribe el `init --apply`, y nada más:

- `~/.navori/global.json` — el manifest: idioma, bloques del baseline y tus permisos globales.
- `~/.claude/skills/navori/` — el plugin `navori@skills-dir` con los 8 agentes, las 11 skills y el
  hook del baseline. Claude Code lo carga sin marketplace ni paso de instalación; las skills globales
  se invocan `/navori:<nombre>` (tras un render, `/reload-plugins` o sesión nueva).
- `~/.claude/settings.json` — **solo** la clave `permissions`, y solo si declaraste permisos globales
  en el manifest. Con la config por default ni siquiera lo crea.

Respeta `CLAUDE_CONFIG_DIR`: si lo tienes seteado, el plugin va ahí en vez de a `~/.claude`.

**El baseline se hace a un lado solo.** El hook corre en `SessionStart` y busca un `navori.config.json`
hacia arriba desde el directorio de la sesión: si lo encuentra, no emite nada — manda el harness del
repo, que es más específico. Por eso el baseline viaja dentro de un hook y no como bloque estático en
`~/.claude/CLAUDE.md`: ese archivo se carga siempre y no podría cederle el paso a nadie.

`navori global uninstall` retira **solo lo que navori escribió**: el plugin, el manifest y los permisos
que quedaron registrados como suyos. Un permiso que ya tenías en tu `settings.json` nunca se vuelve de
navori, así que el uninstall no se lo lleva.

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
