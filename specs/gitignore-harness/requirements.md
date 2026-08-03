# Gestión del `.gitignore` del harness — Requirements

## Context

navori hoy **no gestiona** el `.gitignore` del repo destino (confirmado: no existe escritor en mainline; el código de la rama stale `feat/agente-auditor` nunca se mergeó). Cada repo mantiene su bloque a mano, divergente por versión y por repo. Esto causa dos problemas: (1) artefactos machine-local (`.claude/settings.local.json`, `.claude/worktrees/`, `.codegraph/`) que **nunca** deberían commitearse quedan a merced del usuario, y (2) no hay forma declarativa de expresar la política "ignora todo el harness" (repos Bonum) vs "versiona el harness pero ignora lo local" (repos self-hosted como navori-harness).

Esta feature introduce la generación y **reconciliación** de un bloque managed en `.gitignore`, gobernada por una flag de config de tres modos. Fuente del issue: #313.

## Decisiones de producto ya tomadas (no re-litigar)

- **Modelo de la flag: enum de 3 modos** `gitignoreHarness: "off" | "local" | "full"`. Descarta el modelo binario de la rama stale (todo-o-nada) que no cubre el repo self-hosted.
- **Default `off`**: back-compat total. Los ~20 repos existentes con `.gitignore` hand-written no ven ningún cambio hasta activar la flag por repo (roll-out controlado, cero sorpresa).
- **Marcadores managed (flavor `shell`), no texto plano**: habilita reconciliación segura (quitar paths obsoletos, actualizar el bloque) preservando lo que el usuario tenga fuera del bloque. La rama stale usaba append de texto plano con dedup por línea → no podía reconciliar.

## Los dos cubos de paths

- **Cubo A — machine-local / runtime** (SIEMPRE ignore cuando el modo ≠ `off`): `.claude/settings.local.json`, `.claude/worktrees/`, `.claude/progress/`, `.codegraph/`, `.navori/`. Origen: `backupExclude` del engine Claude + convenciones de `CLAUDE.md` + check de codegraph de `doctor`.
- **Cubo B — harness versionable** (solo en modo `full`): derivado de `ENGINE_OUTPUTS` filtrado por `config.engines` — `.claude/`, `CLAUDE.md`, `navori.config.json`, `.mcp.json`, `AGENTS.md`, `.codex/`, `.agents/`, `.cursor/`, `.github/copilot-instructions.md`, colapsado a su directorio ancestro vía `engineOwnedPaths()`.

## Requirements (EARS)

- **R1** — El schema de `navori.config.json` SHALL aceptar un campo raíz opcional `gitignoreHarness` con valores `"off" | "local" | "full"` y default `"off"`; cualquier otro valor SHALL fallar la validación.
- **R2** — WHEN `navori render --apply` corre con `gitignoreHarness ≠ "off"`, el sistema SHALL escribir o actualizar un bloque managed (flavor `shell`) en el `.gitignore` de la raíz del repo con las entradas del/los cubo(s) que correspondan al modo.
- **R3** — WHEN el modo es `"local"` o `"full"`, el bloque managed SHALL contener todas las entradas del Cubo A (machine-local / runtime).
- **R4** — WHEN el modo es `"full"`, el bloque managed SHALL contener además las entradas del Cubo B derivadas de `config.engines` en ese momento (un engine ausente del config no aporta sus paths).
- **R5** — WHEN el bloque ya existe y las entradas derivadas cambian (cambió el modo o `config.engines`), el sistema SHALL reescribir SOLO la región del bloque managed —agregando y quitando entradas— sin modificar ninguna línea del `.gitignore` fuera del bloque.
- **R6** — IF el `.gitignore` no existe y el modo ≠ `"off"`, THEN el sistema SHALL crearlo conteniendo el bloque managed.
- **R7** — IF el bloque managed fue editado a mano (hash drift), THEN el sistema SHALL preservarlo sin sobrescribir (status `user-modified-skipped`), salvo que se pase `--force`, consistente con el resto de bloques managed.
- **R8** — WHILE `gitignoreHarness` es `"off"` (o ausente), el sistema SHALL NOT crear, modificar ni leer para reconciliar el `.gitignore` (status quo exacto).
- **R9** — WHEN `gitignoreHarness ≠ "off"`, `navori render` sin `--apply` (preview) SHALL listar el `.gitignore` en el reporte de engine files con su status (`created` / `updated` / `unchanged`), sin escribir a disco.
- **R10** — WHEN `navori doctor` corre con `gitignoreHarness ≠ "off"`, el sistema SHALL reportar como drift si el bloque managed del `.gitignore` falta o difiere de las entradas derivadas del config actual.
- **R11** — El sistema SHALL localizar (ES/EN) el header del bloque y los mensajes de reporte, y SHALL regenerar los JSON Schema publicados (`pnpm gen:schemas`) para incluir el nuevo campo.
