# Sesión actual

**Estado:** **PR #486 abierto** (`feat/audit-cableado-mcp-worktree` → `main`), 5 commits atómicos,
gate completo verde. Sesión 2026-08-25: primer uso real del modo audit, que destapó su propio
bloqueador y tres hallazgos más.

## SIGUIENTE PASO

1. **Mergear #486** — https://github.com/UlisesCm/navori-harness/pull/486
2. **Publicar 0.7.0.** Es el paso que de verdad destraba el modo audit: hasta entonces NO funciona
   en ningún repo consumidor, solo con el binario local de este. Requiere OTP de Ulises.
3. **El tablero está en CERO issues abiertos** — la condición (a) del descongelamiento del rollout
   ya se cumplió. Falta (b) versión estable, que es exactamente el punto 2.

## Lo que entró en #486

1. **`audit-mode-trigger.sh` ordenaba un comando inexistente.** El hook resuelve el `navori` del
   PATH (el PUBLICADO), y `audit` entró en #485 *después* del tag `v0.6.1`. Citty imprime el help y
   **sale con código 0** → falso positivo silencioso: el agente reporta una grabación que nunca
   arrancó. Ahora introspecciona la línea `USAGE` antes de ordenar nada.
2. **Cableado MCP, capa 3.** Un plugin podía inyectar prosa en un agente pero no la capacidad:
   `tools:` es una allowlist que cubre MCP, y `researcher`/`explorer` cargaban CodeGraph sin poder
   llamarlo. `engines/claude/agent-mcp-tools.ts` deriva `mcp__<pluginId>__*` al frontmatter.
3. **`codegraph-protocol` de 589 → 197 tok** (~392 menos por arranque de subagente; ~34k en una
   sesión de 88). Era ~85% duplicado de la skill `codegraph-rung`.
4. **Reclamo de worktrees.** El pilot detecta y reporta; el orquestador pregunta y remueve.

## Limpieza hecha esta sesión (fuera del PR)

**27 worktrees / 7.6 GB borrados.** El repo pasó de ~8 GB a **347 MB**. Los 27 verificados uno por
uno: 0 archivos sin commitear, PR `MERGED`, y commit squash presente en `origin/main`.

**Quedan 60 branches locales con PR ya mergeado** (de 127 totales). No pesan en disco pero ensucian;
mismo método si se limpian: cruzar contra PRs mergeados, nunca por nombre.

## Gotchas nuevos, verificados hoy

- **`git merge-base --is-ancestor` NO sirve para saber si una branch se mergeó en este repo**: los
  PRs van con squash, así que responde "no mergeado" para el 100% de las branches, incluidas las que
  shipearon hace días. Lo que decide: `git log origin/main --grep="(#<PR>)"`.
- **`git diff --stat origin/main <branch>` tampoco sirve**: mide que la branch está ATRASADA (main
  avanzó), no que le falte entregar. Daba 80–170 líneas en branches perfectamente mergeadas.
- **`invariants[]` de un plugin NO son nombres de tools** — son load-bearing substrings que deben
  sobrevivir al render (`doctor.ts:1091`). Derivar tools de ahí admite basura y se queda corto.
- **`tools:` acepta patrones a nivel servidor** (`mcp__<server>__*`), confirmado en la doc oficial.
- **Dentro de un pipe del Bash tool, `basename`/`wc`/`tr` pueden salir `command not found`** mientras
  `git`/`grep`/`awk` sí resuelven. Un loop de shell que dependa de ellos produce una tabla INVENTADA
  sin fallar ruidosamente. Para auditorías, `python3`.
- **Las skills tienen cap de palabras** (spec 0003 §3.2.1; `type: behavior` = 200). Mover contenido
  de CLAUDE.md a una skill lo dispara: hay que condensar, no subir el cap.

## Idioma: regla afinada por Ulises hoy

**Código y prompts en inglés; la interacción con el usuario en español.** Por eso los 4 mensajes del
hook pasaron a inglés (son prompts para el agente) pero los patrones de detección siguen en español
(son el input que teclea el usuario) y el i18n del reporte del CLI quedó intacto.

## Regla de trabajo vigente

> Un hallazgo se vuelve issue **solo** si (a) necesita una decisión que no es del agente, (b) no
> cabe en el ciclo que lo encontró, o (c) se va a olvidar y duele. Si el fix cabe en el diff
> abierto y no requiere decisión: **se arregla ahí y se cuenta en el cuerpo del PR**, sin ticket.

## Límite que hay que decir ANTES del rollout

Por el hueco de #440, un `render` **no actualiza las zonas de usuario ya escritas** — se congelan
con la redacción que las creó. Los tokens viejos necesitan el chequeo de `doctor` y corrección
**a mano**. Cuando toque: **per-repo, NUNCA `--all`**.

## Notas heredadas

- `~/.navori/backups` acumula fixtures de test históricos. **El filtro seguro es por prefijo, no
  por edad.**
- La ruta de los repos Bonum del `~/.claude/CLAUDE.md` global está desactualizada, y siguen
  pendientes los PRs del repo externo bonum-webapp (#639, #640, #559) más el rebind de SonarCloud.
