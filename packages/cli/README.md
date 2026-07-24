# navori

Multi-agent harness + SDD scaffolder for Claude Code (and other AI engines).

`navori` lleva tu setup de Claude Code (agentes, skills, hooks, CLAUDE.md, AGENTS.md) a múltiples repos con un solo comando — sin perder customización local, sin sobrescribir lo que ya tenías.

## Instalación

```bash
npm i -g navori
# o sin instalar
npx navori init
```

## Quick start

```bash
# Modo opinado: cero preguntas, todo configurado
cd ~/tu-repo
navori init --recommended

# Instalación máxima: todos los plugins + pre-commit hook + scan-monorepo + project block estricto
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
| `init` | Bootstrap del repo con detección automática + wizard (o `--recommended` sin preguntas, o `--full` para la instalación máxima) |
| `add <plugin>` | Activa un plugin y opcionalmente instala la tool externa |
| `configure <section>` | Ajusta una sección del config sin re-correr el wizard |
| `update` | Re-detecta el repo, refresca config y corre sync en un paso |
| `render` | Genera CLAUDE.md y `.claude/` desde el config (preview por default; `--apply` escribe). `--all` renderea todos los repos del registro global; `--prune` limpia los que ya no existen |
| `registry <sub>` | Registro global de tus repos con navori, para `render --all` (`ls`, `scan <dir>`, `add`, `remove`, `prune`) |
| `sync` | Refresca los managed blocks con conflict resolution + backups |
| `preset init <id>` | Scaffoldea un preset local en `.navori/presets/<id>/` |
| `scan` | Detecta workspaces nuevos en monorepos (`pnpm-workspace.yaml` / `package.json#workspaces`) |
| `doctor` | Audita el config + drift de cada managed block (CLAUDE.md **y AGENTS.md**), orden canónico, markers malformados, desincronización de monorepo y tools externas faltantes (`--strict` para CI) |
| `status` | Snapshot rápido: config, plugins activos, conteo de drift y próximos pasos |
| `bench` | Corre `render` en dry-run N veces y reporta latencias (detecta regresiones locales) |
| `workspace <sub>` | Gestiona workspaces cross-repo (`init`, `ls`, `show`, `rm`) |
| `ticket <sub>` | Gestiona tickets-as-files en un workspace (`new`, `list`, `show`, `archive`, `delete`) |
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
| `acli` | Leer tickets de Jira desde la terminal | `acli` |
| `gh` | GitHub Issues, PRs y workflow runs | `gh` |
| `jscpd` | Detección de duplicación en el diff | `jscpd` (opt-in) |
| `semgrep` | Security gate local | `semgrep` (opt-in) |
| `cognitive` | Guardrails de complejidad cognitiva | (ninguna) |

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
Y eliges: `skip-conflicts` (mantener tu edit), `apply-all` (pisar) o `abort`.

Backups automáticos en `~/.navori/backups/<timestamp>/` antes de cada `sync` (retención 30 días).

## Customización quirúrgica

Cambiar una sola cosa sin re-init:

```bash
navori configure plugins              # multiselect de plugins activos
navori configure quality-gate         # nuevo comando de quality gate
navori configure language en          # switch a inglés (fallback a es)
navori configure engines              # multiselect: claude / agents-md / cursor / copilot
navori configure branch-base main     # punto de fork / rama protegida
navori configure pr-target develop    # rama destino del PR (gh pr create --base)
navori configure workspace bonum      # asociar a un workspace
```

## Filosofía

- **Cero opinión sobre tu proceso**. El CLI detecta y propone; tú decides.
- **Coexiste con harness existente**. El modo `coexist` no toca nada que ya tenías.
- **Nunca pisa silenciosamente**. Hash en el marker + backups antes de cada write.
- **Read-only por default**. Las lecturas no piden permiso; lo destructivo sí.
- **Output legible siempre**. Texto + `--json` para piping en CI.
- **Bilingüe ready**. El schema soporta `language: es | en`. Hoy `es` está full; `en` cae en fallback honesto.

## Licencia

MIT.
