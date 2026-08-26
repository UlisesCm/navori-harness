# Sesión actual

**Estado:** `idle`. Tablero en **0 issues abiertos, 0 PRs abiertos**. `main` en `fbddc4a`, espejo
verificado, gate completo verde (2124 tests).

## SIGUIENTE PASO: publicar 0.7.0

Es lo único pendiente, y es manual (OTP de Ulises). Destraba tres cosas de un golpe:

1. **El modo audit fuera de este repo.** Hoy solo funciona con el binario local: el `navori`
   publicado es 0.6.1 y no trae el subcomando `audit`. En cualquier otro repo el hook cae en su
   rama de "no se pudo confirmar" — que es correcto, pero significa que el feature no está.
2. **El aviso de `check:assets`**, que se apaga solo al publicar (hoy avisa por `navori audit`).
3. **La condición (b) del descongelamiento del rollout.** La (a) —cero issues— ya se cumplió.

Proceso (memoria `navori-release-process`): bump CLI → commit `chore(release)` directo a main → tag
→ `gh workflow run deploy-website.yml` → `npm publish`.

## Lo que se cerró en esta jornada

**PRs mergeados:** #486, #487, #491, #492, #493. **Issues cerrados:** #488, #489, #490.

- **#486** — 5 defectos del modo audit, encontrados usándolo: el hook ordenaba un comando ausente
  del binario publicado (y citty **sale 0** ante subcomando desconocido → falso positivo
  silencioso); el log escribía prompts vacíos; el cableado MCP no llegaba al `tools:` del agente;
  `codegraph-protocol` de 589→197 tok; reclamo de worktrees.
- **#488** — cuatro copias de "leer mi propia versión"; la de `audit` usaba
  `process.env.npm_package_version`, inexistente fuera de un script npm.
- **#490** — check que avisa cuando un asset cita un subcomando aún no publicado.
- **#489** — **refutó su propia premisa**: el log no perdía prompts (ver abajo).

**Limpieza:** 27 worktrees / **7.6 GB** borrados; el repo pasó de ~8 GB a 347 MB.

## Hechos verificados sobre Claude Code (no re-investigar)

- **El payload de `UserPromptSubmit`** es
  `{cwd, hook_event_name, permission_mode, prompt, prompt_id, session_id, transcript_path}`.
  La clave del texto es **`prompt`**; **`user_prompt` NUNCA existió**.
- **Los mensajes escritos mientras el agente trabaja NO son prompts**: se encolan
  (`type:"queue-operation"`, `operation:"enqueue"` + un `remove` al consumirse) y se entregan
  dentro del turno. **No disparan `UserPromptSubmit`.** Un hook no puede verlos; el transcript sí.
- **`tools:` de un subagente acepta patrones a nivel servidor** (`mcp__<server>__*`). Habilitar MCP
  son 3 capas: servidor en `.mcp.json`, permiso en settings, y la tool en `tools:` — un
  `permissions.allow` NO concede una tool, solo silencia su prompt.
- **La doc oficial de hooks no sirve para `UserPromptSubmit`**: corta con "[Content truncated]"
  justo en esa sección y `/hooks-reference` da 404. La de sub-agents sí carga completa.

## Gotchas de método (los que más costaron)

- **Un test con payload sintético no puede desmentir la suposición sobre el formato de la entrada
  real.** Si el test y el código comparten el error, ambos pasan: 70 tests de hooks no vieron el
  bug del prompt vacío. Solo el dogfood lo destapó.
- **Un guard que envuelve `grep` en try/catch puede ser un falso verde.** `url.pathname` queda
  percent-encoded; bajo `Dev - Docs` daba `Dev%20-%20Docs`, grep fallaba y el catch lo reportaba
  como "sin coincidencias". Usar `fileURLToPath`, y tratar solo el exit 1 como vacío. **Todo guard
  nuevo lleva un test anti-false-green** que verifique que encuentra algo conocido.
- **`git merge-base --is-ancestor` NO sirve aquí**: los PRs van con squash, responde "no mergeado"
  para el 100%. Lo que decide: `git log origin/main --grep="(#<PR>)"`. `git diff --stat` tampoco:
  mide que la branch está atrasada, no que le falte entregar.
- **`invariants[]` de un plugin no son nombres de tools** — son load-bearing substrings que deben
  sobrevivir al render (`doctor.ts:1091`).
- **Las skills tienen cap de palabras** (spec 0003 §3.2.1; `behavior` = 200). Mover contenido de
  CLAUDE.md a una skill lo dispara: condensar, no subir el cap.
- **Dentro de un pipe del Bash tool, `basename`/`wc`/`tr` pueden salir `command not found`** y los
  globs de zsh (`--include=*.ts`) fallan. Para auditorías, `python3`.
- **`actions/checkout` no trae tags**: cualquier check que compare contra un tag necesita
  `fetch-depth: 0` o se salta a sí mismo en silencio.

## Idioma: regla vigente (dictada por Ulises)

**Código y prompts en inglés; la interacción con el usuario en español.** Los mensajes del hook son
prompts → inglés. Los patrones de detección son input del usuario → español. El i18n del reporte
(`pick(lang, es, en)`) queda intacto.

## Regla de trabajo vigente

> Un hallazgo se vuelve issue **solo** si (a) necesita una decisión que no es del agente, (b) no
> cabe en el ciclo que lo encontró, o (c) se va a olvidar y duele. Si el fix cabe en el diff
> abierto y no requiere decisión: **se arregla ahí y se cuenta en el cuerpo del PR**, sin ticket.

## Límite que hay que decir ANTES del rollout

Por el hueco de #440, un `render` **no actualiza las zonas de usuario ya escritas** — se congelan con
la redacción que las creó. Los tokens viejos necesitan el chequeo de `doctor` y corrección **a mano**.
Cuando toque: **per-repo, NUNCA `--all`**.

## Pendientes menores, sin issue

- **60 branches locales con PR ya mergeado** (de 127). No pesan en disco pero ensucian. Si se
  limpian: cruzar contra PRs mergeados, nunca por nombre.
- El audit no aprovecha `prompt_id` (identidad estable por prompt, sirve para detectar faltantes).

## Notas heredadas

- `~/.navori/backups` acumula fixtures de test históricos. **El filtro seguro es por prefijo, no por
  edad.**
- La ruta de los repos Bonum del `~/.claude/CLAUDE.md` global está desactualizada, y siguen
  pendientes los PRs del repo externo bonum-webapp (#639, #640, #559) más el rebind de SonarCloud.
