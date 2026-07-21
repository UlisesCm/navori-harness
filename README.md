<div align="center">

# navori

**Multi-agent harness + SDD scaffolder for Claude Code (and other AI engines).**

[![npm](https://img.shields.io/npm/v/navori?color=8b5cf6)](https://www.npmjs.com/package/navori)
[![CI](https://github.com/UlisesCm/navori-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/UlisesCm/navori-harness/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/navori)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/navori?color=8b5cf6)](./LICENSE)

</div>

`navori` lleva tu setup de Claude Code —agentes, skills, hooks, `CLAUDE.md`, `AGENTS.md`— a cualquier repo con **un comando**, y lo mantiene al día sin pisar tu customización local ni sobrescribir lo que ya tenías.

```bash
npx navori init           # wizard con detección de stack
# o, sin preguntas:
npx navori init --recommended
# o, instalación máxima (todos los plugins + pre-commit hook + project block estricto):
npx navori init --full
```

> 📦 npm: [`navori`](https://www.npmjs.com/package/navori) · 📖 Referencia completa del CLI: [`packages/cli/README.md`](./packages/cli/README.md)

---

## El problema

Cuando armas un buen harness para tu agente (agentes especializados, skills, hooks, quality gates, convenciones de SDD), ese conocimiento vive en `.claude/` y `CLAUDE.md` de **un** repo. Replicarlo a otros es copiar-pegar, y mantenerlos sincronizados cuando algo cambia es manual y se pudre con el tiempo.

`navori` convierte ese harness en algo **versionado y reproducible**: una `navori.config.json` checked-in describe el repo, y el CLI reconstruye todo desde ahí — con marcadores `<!-- navori:managed -->` que separan lo que el CLI mantiene de lo que es tuyo.

## Qué genera

A partir de `navori init`:

- **`navori.config.json`** — la fuente de verdad del repo (stack, preset, plugins, quality gate, librerías detectadas).
- **`CLAUDE.md`** con *managed blocks* versionados que el CLI sincroniza (y deja intacto lo que escribes fuera de ellos).
- **`.claude/`** con agentes, skills, hooks y `settings.json` — read-only por default, con guard contra comandos destructivos.

## Cómo funciona

**Cascada de 5 capas** — cada una refina la anterior, lo específico gana:

```
Core  →  Preset  →  Workspace  →  Project config  →  Engine adapters
```

- **Core** — baseline universal: agentes, skills, hooks, protocolo SDD.
- **Preset** — capa por stack, con bases neutras (`vite-react-ts`, `express`) y variantes especializadas encima (Next.js, NestJS, Express+Mongoose, Vite+Mantine, Astro, Medusa, background-worker…).
- **Library skills** — skills modulares **transversales a presets**, inyectadas por *detección de dependencia*: un repo recibe `socketio`, `mongoose`, `redux-toolkit`, `formik`, `zod`, etc. cuando trae esa dependencia, sin importar el preset.
- **Workspace** — defaults heredables y tickets cross-repo cuando un cambio toca varios repos.
- **Project config** — tus overrides en `navori.config.json`.
- **Engine adapters** — el core es *engine-agnostic*: hoy renderiza a Claude Code (`.claude/`), con soporte para `AGENTS.md` universal, Cursor y Copilot.

**Modelo de sincronización** — los managed blocks llevan `hash`, `version` y `source`. `sync` reporta updates disponibles y avisa antes de pisar un bloque que editaste a mano; hay backups automáticos antes de cada write.

## Comandos

| Comando | Qué hace |
|---|---|
| `init` | Bootstrap con detección de stack + wizard (o `--recommended` sin preguntas, o `--full` para la instalación máxima) |
| `update` | Re-detecta el repo, refresca el config y corre el engine completo — *bring me up to date* |
| `render` | Genera `CLAUDE.md` + `.claude/` desde el config (preview por default; `--apply` escribe) |
| `sync` | Refresca los managed blocks con conflict resolution + backups |
| `add` / `configure` | Activa un plugin / ajusta una sección del config sin re-init |
| `doctor` / `status` | Audita config + drift (`--strict` para CI) / snapshot rápido |
| `workspace` / `ticket` | Config y tickets cross-repo |
| `preset` / `scan` / `backup` / `migrations` / `bench` | Presets locales, monorepos, restore, benchmark |

→ Tabla completa, presets y plugins en [`packages/cli/README.md`](./packages/cli/README.md).

## Estructura del monorepo

```
navori-harness/
├─ packages/
│  ├─ cli/            # el CLI `navori` (publicado a npm)
│  ├─ core/           # @navori/core — managed assets (agentes, skills, presets, hooks), bundleados al CLI
│  └─ plugins/        # engram · acli · gh · jscpd · semgrep · cognitive
├─ apps/
│  └─ website/        # landing + docs (Astro, deploy a GitHub Pages)
└─ pnpm-workspace.yaml
```

`@navori/core` y los plugins se **empaquetan dentro del CLI** en build (no se publican por separado): un solo `npm i -g navori` trae todo.

## Desarrollo

Requiere **Node ≥ 20** y **pnpm**.

```bash
pnpm install
pnpm -r build                 # build de todos los paquetes

cd packages/cli
pnpm test                     # suite de vitest (quality gate)
pnpm build                    # bundlea CLI + assets
pnpm check:size               # guard de tamaño del bundle

# probar el binario local sin publicar:
node dist/index.js init --cwd /ruta/a/un/repo
```

**Quality gate** antes de cerrar cambios en el CLI: `cd packages/cli && pnpm test`.

## Releases

Releases manuales: bump de `packages/cli/package.json` → commit `chore(release): navori vX.Y.Z` → tag `vX.Y.Z` → `npm publish` desde `packages/cli`. El website lee la versión del `package.json` del CLI y se redespliega vía GitHub Actions.

## Licencia

[MIT](./LICENSE)
