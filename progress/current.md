# Sesión actual

**Estado:** `idle`. `main` en `acc31ca`, working tree limpio, espejo verificado, **0 issues abiertos**.
Los 17 de la auditoría a ciegas (#495–#511) cerrados en 4 PRs, los cuatro con CI en verde.
Tests 2124 → **2642**.

## SIGUIENTE PASO: descongelar el rollout

La condición que fijó Ulises era **cero issues abiertos + versión estable**. Lo primero ya se cumple.
Falta publicar, y hay una razón concreta para publicar ANTES de tocar los 15 repos: **el fix de
`Bash(sg:*)` no llega a ninguno hasta que se publique** — los repos renderizan con el `navori`
instalado, no con este árbol.

Orden: bump del CLI → `chore(release)` directo a `main` → tag → `gh workflow run deploy-website.yml`
→ `npm publish` (manual, OTP de Ulises).

**Límite que hay que decir ANTES del rollout, no después.** Por el hueco de #440 un `render` **no
actualiza las zonas de usuario ya escritas**: los tokens viejos necesitan el chequeo de `doctor` y
corrección **a mano**. Ir **per-repo, NUNCA `--all`**.

## Qué cambió de verdad (más que los 17 parches)

Las defensas describían el peligro por su **forma textual** en vez de por su **semántica**, y ninguna
verificaba que pudo hacer su trabajo. Los cinco fixes reales quitaron la dependencia de la forma:
normalizar flags antes de evaluar, exigir marcador de autoría, eliminar el alias ambiguo, detectar el
fence sin cerrar, y mover el heredoc a una función para que el quoting no dependa de un conteo.

**Seis guards nuevos que atacan CLASES, no instancias:**

| Guard | Qué impide |
|---|---|
| `removal-parity.test.ts` | una cuarta ruta de borrado con criterio propio (declara las 12 existentes) |
| `hook-claims-vs-scripts.test.ts` | que un asset atribuya a un hook una capacidad que su script no tiene |
| `asset-command-permissions.test.ts` | que el harness ordene un comando sin permiso en settings |
| `cited-paths-exist.test.ts` (ensanchado) | que un asset cite un **encabezado** inexistente, no solo una ruta |
| `check-coverage-floor.mjs` | que un módulo nuevo entre a 0% diluido en el agregado |
| `repo-config-gate.test.ts` | que el gate local deje de cubrir lo que CI exige (deriva de `ci.yml`) |

## La patología de tests, encontrada SEIS veces

Un test que congela la **forma de la implementación** en vez de verificar la **regla**. En tres casos
no solo no atrapaba el bug: **lo protegía** — corregir el código rompía el test.

- `guard-destructive.test.ts`: 30 casos de `rm`, los 30 con `-rf`. Eje del target agotado, eje de
  flags inexistente.
- `gate-hook-worktree.test.ts`: `it("semgrep BLOCKS…")` con `toBe(1)`. La suite tenía escrito que
  bloquear era 1, cuando `PreToolUse` bloquea con 2.
- `build-settings.test.ts`: `expect(allow).toContain("Bash(sg:*)")` — aseveraba el agujero.
- `schema-publish.test.ts`: `$id` fijado a un dominio NXDOMAIN.
- `protocol-coherence.test.ts`: la cadena literal de la redacción ambigua de R1.
- `removal-parity.test.ts`: symlink como *hijo*, nunca como *raíz*.

**Y yo produje una séptima**, con el patrón fresco: sembré el directorio intermedio para probar un
guard, cuando la condición real del hook era `[ -f "$log_file" ]` (el archivo destino). Quitar el
guard dejaba 56/56 verde. Lo atrapó el reviewer con lo único que lo atrapa: **mutar producción y
comprobar el rojo**. Razonar sobre el fixture no basta.

## Hechos de método verificados esta jornada (no re-investigar)

- **`gh pr create` inmediatamente tras el push deja el evento sin encolar.** CI no arranca. Lo
  reemiten `reopened` (cerrar/reabrir el PR) o `synchronize` (un push). Pasó en #514, #515 y #516;
  #513 fue la excepción. **No es facturación ni latencia** — el repo es público (minutos ilimitados).
- **`vitest` corre `tsup` en su `globalSetup` y ese build limpia `dist/`.** Dos suites concurrentes
  hacen que los e2e ejecuten un binario a medio escribir: medido **7 003 s contra 55 s de baseline**,
  con 28 fallos inexistentes. Correr un archivo aislado antes de creer un fallo.
- **La carga de daemons de macOS** (`contactsdonationagent` al 75%) dispara `Test timed out in
  15000ms` en masa. Usar `npx vitest run --testTimeout=90000`.
- **Un `git stash` en un worktree compartido se lleva el trabajo de todos los agentes activos.**
  Pasó; se recuperó con `pop`. Prohibido en los encargos desde entonces.
- **Cambiar de rama en un árbol con implementers activos** arrastra su trabajo sin commitear a la
  otra rama. Lo hice yo con `git checkout main`; se recuperó. Operaciones de git solo en árboles sin
  agentes.
- **Un agente que muere a mitad de una mutación deja producción rota.** Encontré `nukeStaleThing`
  con `rmSync` recursivo sembrado en `lib/semver.ts`. Los encargos ahora exigen aplicar y restaurar
  en el MISMO turno, con `git diff --stat` de confirmación.
- **Los conflictos de rebase en `.claude/` y `CLAUDE.md` NO se resuelven a mano**: son espejo. Tomar
  la versión de `main` y regenerar con `render:apply`. Cinco conflictos → cero decisiones.

## Notas heredadas

- Tres ramas locales mergeadas por borrar: `fix/bloque-assets`, `fix/bloque-config`,
  `fix/bloque-perdida-datos` (más las ~60 anteriores de PRs ya mergeados, de 127).
- `~/.navori/backups` acumula fixtures de test históricos. **Filtrar por prefijo, no por edad.**
- La ruta de los repos Bonum del `~/.claude/CLAUDE.md` global está desactualizada; siguen pendientes
  los PRs de bonum-webapp (#639, #640, #559) y el rebind de SonarCloud.
