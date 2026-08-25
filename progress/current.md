# Sesión actual

**Estado:** `idle`. PR #486 **mergeado** (`5c3658a`), branch borrada, `main` al día y espejo
verificado con `check:render`. Tablero en **CERO issues abiertos**.

## SIGUIENTE PASO: publicar 0.7.0

Es el único paso que destraba el modo audit fuera de este repo: hoy **solo funciona con el binario
local**. El `navori` publicado es 0.6.1 y no trae el subcomando `audit` (entró en #485, después del
tag). Requiere OTP de Ulises, así que es manual.

Con eso se cumple también la condición (b) del descongelamiento del rollout — la (a), cero issues
abiertos, **ya se cumplió**.

Proceso (memoria `navori-release-process`): bump CLI → commit `chore(release)` directo a main → tag
→ `gh workflow run deploy-website.yml` → `npm publish`.

## Pendientes menores, sin issue abierto

- **El reporte de audit se firma `generado por navori@0.0.0`** en vez de la versión real. Cosmético,
  detectado al leer el primer reporte real. Cabe en el próximo ciclo que toque `lib/audit/report.ts`.
- **Sin causa confirmada:** de ~6 mensajes enviados tras activar audit-mode, solo 1 llegó al log. Los
  mensajes entregados *mid-turn* podrían no disparar `UserPromptSubmit` como un prompt normal.
  **Verificar antes de tocar nada** — no parchear sobre la hipótesis.
- **60 branches locales con PR ya mergeado** (de 127). No pesan en disco pero ensucian. Si se
  limpian: cruzar contra PRs mergeados, nunca por nombre.

## Primer reporte de audit real (sesión 4b14e371)

428k tok facturables en 1h47m: arranque 63k (15%) · razonamiento 141k (33%) · contexto de trabajo
223k (52%). `cache_read` acumulado 29.3M. Marcó 17/17 skills y 8/8 agentes sin usar — consecuencia
directa de que esta sesión corrió sin subagentes, no de un defecto del harness.

## Gotchas vigentes, verificados esta sesión

- **`git merge-base --is-ancestor` NO sirve para saber si una branch se mergeó aquí**: los PRs van
  con squash y responde "no mergeado" para el 100%, incluidas las que shipearon hace días. Lo que
  decide: `git log origin/main --grep="(#<PR>)"`. `git diff --stat origin/main <branch>` tampoco
  sirve: mide que la branch está ATRASADA, no que le falte entregar.
- **`invariants[]` de un plugin NO son nombres de tools** — son load-bearing substrings que deben
  sobrevivir al render (`doctor.ts:1091`).
- **`tools:` acepta patrones a nivel servidor** (`mcp__<server>__*`), confirmado en doc oficial. La
  doc de `UserPromptSubmit`, en cambio, corta con "[Content truncated]" y `/hooks-reference` da 404.
- **Un test con payload sintético no puede desmentir la suposición sobre el formato de la entrada
  real** — si el test y el código comparten el error, ambos pasan. Solo el dogfood lo destapa.
- **Las skills tienen cap de palabras** (spec 0003 §3.2.1; `type: behavior` = 200). Mover contenido
  de CLAUDE.md a una skill lo dispara: condensar, no subir el cap.
- **Dentro de un pipe del Bash tool, `basename`/`wc`/`tr` pueden salir `command not found`** mientras
  `git`/`grep`/`awk` sí resuelven, produciendo tablas INVENTADAS sin fallar. Para auditorías,
  `python3`.

## Idioma: regla afinada por Ulises

**Código y prompts en inglés; la interacción con el usuario en español.** Por eso los mensajes del
hook pasaron a inglés (son prompts para el agente), los patrones de detección siguen en español (son
input del usuario) y el i18n del reporte quedó intacto.

## Regla de trabajo vigente

> Un hallazgo se vuelve issue **solo** si (a) necesita una decisión que no es del agente, (b) no
> cabe en el ciclo que lo encontró, o (c) se va a olvidar y duele. Si el fix cabe en el diff
> abierto y no requiere decisión: **se arregla ahí y se cuenta en el cuerpo del PR**, sin ticket.

## Límite que hay que decir ANTES del rollout

Por el hueco de #440, un `render` **no actualiza las zonas de usuario ya escritas** — se congelan con
la redacción que las creó. Los tokens viejos necesitan el chequeo de `doctor` y corrección **a mano**.
Cuando toque: **per-repo, NUNCA `--all`**.

## Notas heredadas

- `~/.navori/backups` acumula fixtures de test históricos. **El filtro seguro es por prefijo, no por
  edad.**
- La ruta de los repos Bonum del `~/.claude/CLAUDE.md` global está desactualizada, y siguen
  pendientes los PRs del repo externo bonum-webapp (#639, #640, #559) más el rebind de SonarCloud.
