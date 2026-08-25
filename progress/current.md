# Sesión actual

**Estado:** branch `feat/audit-mode` (desde `main` @ `416d39e`). Sesión 2026-08-25: diseño cerrado
del modo audit + implementación WIP commiteada, **PAUSADA por decisión de Ulises** ("guarda
únicamente hasta el plan detallado y déjalo pendiente"). **NO hay PR y no debe abrirse** hasta que
Ulises retome.

## SIGUIENTE PASO: retomar el modo audit desde el WIP

- **Plan detallado (fuente de verdad):** `.claude/progress/plan_audit_mode.md` — reescrito hoy con
  el diseño final; supersede el plan post-hoc del 24-ago. Ahí están las 8 decisiones de Ulises y
  los hechos verificados contra doc oficial.
- **Memoria engram:** topic_key `navori-audit-mode-diseno-final` (decisiones + mediciones).
- El código WIP está commiteado en esta branch. Lo que falta se lista abajo.

### Las 8 decisiones (salieron de cuestionario 1x1, no re-litigar)

1. Alcance **completo e independiente** (tokens + adherencia). Se evaluó y descartó apoyarse en
   **AgentSight** (CLI Rust MIT/Apache, `brew install agentsight`, parsea los mismos transcripts).
2. **Solo sesiones MARCADAS** con audit-mode; sin auditoría retroactiva. Dentro de una sesión
   marcada se toma la sesión completa, no solo desde el gatillo.
3. **Confirmación humana explícita en ambos extremos.** El hook NO activa: inyecta
   `additionalContext` y el agente pregunta ("¿continuar?").
4. **Distribución global** (`packages/core`), **activación por sesión**.
5. **Log append-only inmutable**, uno por sesión. `.json`/`.md` son derivados regenerables.
6. **Si no cuesta tokens, se omite** (fuera: latencia de hooks, gates corriendo, routing).
7. Hooks SOLO en `UserPromptSubmit` + `SessionEnd`. Fail-open absoluto, test bash+zsh.
8. **Primero el audit, después** el fix del cableado MCP — ese bug es el caso de validación.

### Hecho y verificado (commiteado en esta branch)

- `packages/cli/src/lib/audit/{paths,model,parse,harness,signals,discovery,report}.ts`
- `packages/cli/src/commands/audit.ts` + registro en `index.ts` (1 import + 1 entrada)
- `packages/core/core-assets/hooks/audit-mode-{trigger,close}.sh` + registro en
  `harness-plan.ts` y `build-settings.ts`
- Tests: 40 unit (parse/signals/discovery) + 30 de hooks en **bash y zsh** = 70 nuevos, verdes.
- **Validado contra la sesión real `ec30221a`** (88 subagentes): 0 parseErrors en 4427 líneas,
  y **destapó solo el bug de codegraph como HIGH (~107k tokens)** — la prueba de calibración
  que Ulises pidió.

### Lo que FALTA para cerrar

1. **Test de integración del comando** (end-to-end contra el fixture, con `NAVORI_AUDITS_ROOT`).
2. **Suite completa en verde** — quedó 1 fallo por resolver (ver abajo) y falta correr
   `pnpm format:check` + `pnpm lint`.
3. Decidir si el copy de los hooks (hoy español hardcodeado) debe pasar por el i18n del render.

## ⚠️ Hallazgo que NO es del feature: render concurrente sobre el repo raíz

Durante la sesión, `CLAUDE.md` y todo `.claude/{agents,skills,hooks}` aparecieron modificados con
**solo el bump `version="0.6.0"` → `"0.6.1"`** en los marcadores managed (el `hash` no cambió).

Causa: hay una **sesión concurrente** en el worktree `wt-release-061` (branch `chore/release-0.6.1`)
y el `navori` **global es 0.6.1**; un render real corrió sobre el repo raíz a las 13:12 y dejó su
backup (`~/.navori/backups/navori-harness-2026-08-25T13-12-25-213-p54354-0`). Eso disparó el guard
de aislamiento de la suite (#424) — que contempla justo este falso positivo en su mensaje.

**Esos archivos NO se incluyeron en el commit de esta branch.** Antes de retomar, confirmar con la
otra sesión si ese render es intencional (release 0.6.1) o hay que revertirlo.

## Ajuste colateral que sí entró: bundle guard 800 → 900KB

`check:size` iba a explotar con cualquier feature nuevo: medido **792KB sin audit, 816KB con él**.
El comentario del guard promete headroom para cazar una dep pesada, y ese headroom ya estaba
gastado por crecimiento de primera parte. `audit` agrega ~24KB y **cero dependencias**. El nuevo
límite deja ~84KB de margen. La medición quedó documentada en el propio script.

## Gotcha nuevo, verificado hoy (bash vs zsh)

Con `HOME` fuera del entorno, **zsh lo repuebla desde la entrada de passwd y bash no**. El mismo
hook, por tanto, bail-out silencioso en bash y sigue adelante en zsh. Ambos cumplen el contrato
(exit 0, cero escrituras), pero un test que exija "sin output" en ambos shells falla. Está
documentado en `audit-hooks.test.ts`.

## LO PRIMERO QUE HAY QUE SABER: el rollout 0.6.0 sigue CONGELADO

**Criterio de salida dictado por Ulises (2026-08-24):** no se descongela hasta **(a) resolver
TODOS los issues abiertos** y **(b) garantizar una versión estable**. No lo propongas ni lo
arranques. Cuando toque: **per-repo, NUNCA `--all`**.

**Límite que hay que decirle ANTES del rollout:** por el hueco de #440, un `render` **no actualiza
las zonas de usuario ya escritas** — se congelan con la redacción que las creó. Los tokens viejos
necesitan el chequeo de `doctor` (#440) y corrección **a mano**.

## Regla de trabajo vigente

> Un hallazgo se vuelve issue **solo** si (a) necesita una decisión que no es del agente, (b) no
> cabe en el ciclo que lo encontró, o (c) se va a olvidar y duele. Si el fix cabe en el diff
> abierto y no requiere decisión: **se arregla ahí y se cuenta en el cuerpo del PR**, sin ticket.

## Issues abiertos (13)

**Decisiones de Ulises del 2026-08-24, dirección ya fijada:**

- **#461** `high` — 209 errores de tipos. Limpiar los 209 PRIMERO, después agregar `typecheck`
  al gate. (Ojo: `pnpm typecheck` ya existe y pasa limpio hoy.)
- **#462** — el `guard-destructive` bloquea prosa que *cita* comandos destructivos. Acotarlo a lo
  que se EJECUTA, no al texto que se escribe.
- **#458** — `.gitignore` es la única escritura del render que esquiva el punto de respaldo.
- **#459** — el cierre de marcador sigue con `indexOf` crudo.
- **#460** `low` — `MARKER_ID_ATTR_RE` más laxo que el parser.

**Tanda de optimización:** #377, #378, #379, #370.
**Testing:** #394 (golden snapshot por engine), #395 (repos fixture), #396 (benchmark — este
feature probablemente lo alimenta o lo cierra).
**Auditoría de reprocesos:** #401.

## Gotchas de proceso vigentes

- **Un fuente con un byte NUL es invisible para grep y opaco para `git diff`.**
- **La base se mueve durante un ciclo largo.** El receipt se ancla a `git diff HEAD`, NO a
  `origin/main`. El pilot rebasa y **re-corre el gate**.
- **Editar el body de un PR puede romper el auto-cierre del issue** (`Closes #<n>`).
- **`${PIPESTATUS[0]}` no existe en zsh** (es `$pipestatus[1]`).
- **Al aplicar un fix con script, no reuses la variable del path.**

## Notas heredadas

- `~/.navori/backups` acumula fixtures de test históricos. **El filtro seguro es por prefijo, no
  por edad.**
- La ruta de los repos Bonum del `~/.claude/CLAUDE.md` global está desactualizada, y siguen
  pendientes los PRs del repo externo bonum-webapp (#639, #640, #559) más el rebind de SonarCloud.
