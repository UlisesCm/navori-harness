# navori-ai

Multi-agent harness + SDD scaffolder for Claude Code (and other AI engines).

`navori-ai` lleva tu setup de Claude Code (agentes, skills, hooks, CLAUDE.md, AGENTS.md) a múltiples repos con un solo comando — sin perder customización local, sin sobrescribir lo que ya tenías.

## Instalación

```bash
npm i -g navori-ai
# o sin instalar
npx navori-ai init
```

## Quick start

```bash
# Modo opinado: cero preguntas, todo configurado
cd ~/tu-repo
navori-ai init --recommended

# O wizard interactivo con detección de stack
navori-ai init
```

El `init` detecta automáticamente del repo:
- **Nombre** del proyecto (de `package.json`, `pyproject.toml`, `Cargo.toml`, git remote o basename)
- **Stack**: framework (Next.js, Vite, NestJS, Expo, etc.), UI, forms, state, test
- **Preset sugerido** basado en el stack (ej. `vite-react-ts-mantine`, `nextjs-apollo`, `bun-keystone`)
- **Quality gate** compuesto de los scripts del `package.json`
- **Branch base** del git (`origin/HEAD`, fallback main/master/develop)
- **Infraestructura Claude existente** (`.claude/`, `CLAUDE.md`, `AGENTS.md`, agents, skills) — ofrece coexistir o reemplazar con backup

Y genera:
- `navori.config.json` — fuente de verdad del repo
- `CLAUDE.md` con managed blocks que el CLI mantiene sincronizados

## Comandos

| Comando | Qué hace |
|---|---|
| `init` | Bootstrap del repo con detección automática + wizard |
| `add <plugin>` | Activa un plugin + opcionalmente instala la tool externa |
| `configure <section>` | Ajusta una sección del config sin re-correr el wizard |
| `update` | Re-detecta el repo, refresca config y corre sync en un paso |
| `render` | Genera CLAUDE.md con los managed blocks |
| `sync` | Refresca managed blocks con conflict resolution + backups |
| `doctor` | Inspecciona config + reporta procedencia de cada managed block |
| `workspace <sub>` | Gestiona workspaces cross-repo (init, ls, show, add-repo) |
| `ticket <sub>` | Gestiona tickets-as-files en un workspace (new, list, show) |

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
navori-ai add engram          # te ofrece instalar la tool externa si falta
navori-ai add engram --skip-install   # solo registra el plugin
```

## Workspace + tickets cross-repo

Si un ticket toca varios repos (frontend + backend + microservicio), el workspace te da un punto único:

```bash
# Crear workspace
navori-ai workspace init bonum --description "Bonum platform"

# Registrar repos del workspace
navori-ai workspace add-repo bonum --name webapp --path ~/dev/bonum/webapp --stack vite-react-ts-mantine
navori-ai workspace add-repo bonum --name backend --path ~/dev/bonum/nexus --stack nestjs

# Crear ticket
navori-ai ticket new bonum BNM-123 --title "Checkout flow rebuild"

# En cada repo que tocás el ticket, agregá una referencia:
# echo "ticket: BNM-123" >> progress/current.md

# Ver el ticket + en qué repos aparece
navori-ai ticket show bonum BNM-123
```

El workspace también guarda defaults heredables:
```bash
navori-ai init --workspace bonum    # hereda engines, plugins, branchBase, etc.
```

Storage: `~/.navori/workspaces/<name>/` (manifest + tickets/ + backups/).

## Managed blocks con versionado

Cada bloque que `navori-ai` inyecta en tu `CLAUDE.md` lleva metadata:

```html
<!-- navori:managed id="idioma-rol" hash="3fbef743" version="0.0.1" source="@navori/core" -->
contenido sincronizado
<!-- /navori:managed id="idioma-rol" -->
```

- **`hash`**: detecta si vos editaste el bloque (sync te avisa antes de pisar)
- **`version`**: cuando se publica una nueva versión de `@navori/core` o un plugin, `sync` reporta "update available"
- **`source`**: qué paquete es dueño del bloque (`doctor` te muestra la procedencia de cada uno)

Si modificás un managed block a mano y después corrés `sync`, vas a ver:
```
Conflict in 'idioma-rol':
  - tu versión
  + versión del Core
```
Y elegís: `skip-conflicts` (mantener tu edit), `apply-all` (pisar) o `abort`.

Backups automáticos en `~/.navori/backups/<timestamp>/` antes de cada `sync` (retención 30 días).

## Customización quirúrgica

Cambiar una sola cosa sin re-init:

```bash
navori-ai configure plugins              # multiselect de plugins activos
navori-ai configure quality-gate         # nuevo comando de quality gate
navori-ai configure language en          # switch a inglés (fallback a es)
navori-ai configure engines              # multiselect: claude / agents-md / cursor / copilot
navori-ai configure workspace bonum      # asociar a un workspace
```

## Filosofía

- **Cero opinión sobre tu proceso**. El CLI detecta y propone; vos decidís.
- **Coexiste con harness existente**. Modo `coexist` no toca nada que ya tenías.
- **Nunca pisa silenciosamente**. Hash en el marker + backups antes de cada write.
- **Output legible siempre**. Texto + `--json` para piping en CI.
- **Bilingüe ready**. Schema soporta `language: es | en`. Hoy solo `es` está full; `en` cae en fallback honesto.

## Licencia

ISC.
