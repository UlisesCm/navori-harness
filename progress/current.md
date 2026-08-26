# Sesión actual

**Estado:** `idle`. `main` en `f7bf659`, working tree limpio, espejo verificado. **17 issues abiertos
(#495–#511)**, todos de la auditoría a ciegas del 2026-08-26. Sin código cambiado en esa auditoría.

## ⚠️ LO PRIMERO: el rollout vuelve a estar bloqueado, y ahora con razón de peso

La condición (a) del descongelamiento era **cero issues abiertos**. Ya no se cumple, y no es
burocracia: **cuatro de los issues nuevos son de seguridad y afectan a todo repo onboardeado**.
Publicar o extender el rollout ahora propaga esos defectos a más repos.

## SIGUIENTE PASO: el bloque de seguridad (3 fixes chicos, impacto grande)

| # | Qué | Esfuerzo |
|---|---|---|
| **#509** | `rm -R ~/` y `rm -rf --no-preserve-root /` **pasan** el guard destructivo (matchea `[rf]` solo minúsculas; las flags largas rompen el matcheo) | bajo |
| **#495** | `Bash(sg:*)` pre-aprobado: en macOS es ast-grep, **en Linux es shadow-utils** → `sg <grupo> -c "…"` ejecuta cualquier cosa | **una línea** |
| **#510** | Los gates de semgrep y jscpd salen `exit 1`; un `PreToolUse` solo bloquea con `exit 2`. No bloquean nada | bajo |
| **#511** | El guard se satura (46,9 s con 2000 segmentos vs timeout de 10 s) y muere sin evaluar una regla | medio |

**#495 y #509 se anulan mutuamente en el peor sentido**: uno pre-aprueba ejecución arbitraria, el
otro deja pasar el borrado recursivo, y las `deny` rules de `settings.json` comparten el mismo punto
ciego (describen `-rf`, no la semántica).

Después: **pérdida de datos** — #497 (`global init` destruye `~/.claude/settings.json` sin backup),
#496 (`--prune` borra archivos ajenos), #498 (fence sin cerrar duplica todos los bloques).

Y sigue pendiente **publicar 0.7.0** (manual, OTP), pero conviene **después** del bloque de
seguridad, no antes.

## El patrón transversal (esto es lo que hay que entender, no los 17 bugs sueltos)

> Las defensas del harness describen el peligro por su **forma textual** (`-rf`, un nombre de
> binario, una lista de rutas) en vez de por su **semántica**, y **ninguna verifica que pudo hacer
> su trabajo**.

Un guard que no llegó a evaluar, un gate que salió 1, un backup vacío y un parser ciego producen
**la misma señal visible que el éxito**. Cualquier fix que solo tape un caso concreto sin atacar
esto deja viva la clase.

## Método de la auditoría (repetible, funcionó)

5 `auditor` en paralelo, un eje cada uno (assets / hooks / CLI / config / tests), con:
- **prohibición explícita** de leer `progress/`, usar engram o mirar `git log` — para que ningún
  hallazgo viniera contaminado por lo que la sesión ya sabía;
- **obligación de demostrar**: repro ejecutada, comando de verificación, o la mutación del código de
  producción que debería romper un test y no lo hace;
- ruta literal del archivo de salida en el encargo (sin eso, el host les prohíbe escribir .md).

Los reportes completos quedaron en `.claude/progress/audit_ciego_*.md`, que está **gitignored**: no
se versionan y se pierden al limpiar. La sustancia está en los 17 issues.

**Dos cruces que ningún auditor vio solo** (la síntesis no se delega):
1. El de CLI citó el `createBackup` del `--prune` como mitigación; el de tests lo mutó a
   `createBackup(cwd, [])` y la suite siguió **2124/2124 verde**. La red existe por suerte.
2. #503 apunta a código de ESTA misma jornada: `audit --start` escribe fuera de su raíz declarada,
   y el test que afirma ese contrato prueba **la mitad que no puede romperlo**.

## Hechos verificados sobre Claude Code (no re-investigar)

- **`PreToolUse` solo bloquea con `exit 2`.** Cualquier otro código ≠0 se muestra y **deja pasar**.
  Prueba interna: `guard-destructive.sh` sí bloquea y sale 2; los gates salen 1.
- **El payload de `UserPromptSubmit`** es
  `{cwd, hook_event_name, permission_mode, prompt, prompt_id, session_id, transcript_path}`.
  La clave del texto es **`prompt`**; `user_prompt` **nunca existió**.
- **Los mensajes escritos mientras el agente trabaja NO son prompts**: se encolan
  (`queue-operation`, `enqueue` + `remove`) y no disparan `UserPromptSubmit`. El transcript sí los ve.
- **`tools:` acepta patrones a nivel servidor** (`mcp__<server>__*`). Habilitar MCP son 3 capas y un
  `permissions.allow` **no** concede una tool, solo silencia su prompt.
- **El host prohíbe a los subagentes escribir .md de reporte.** El encargo con ruta literal rompe el
  empate (verificado: los 5 auditores sí escribieron). Ver #500.
- **`sg` es ast-grep en macOS (Homebrew) y shadow-utils en Linux.** No son intercambiables.
- **`/bin/bash` de macOS es 3.2.57**, donde `${var//pat/repl}` es cuadrático.

## Gotchas de método (los que más costaron)

- **Un test que no puede fallar no prueba nada.** Se repitió cuatro veces: payloads sintéticos que
  cargan la suposición equivocada del código; un guard cuyo `grep` fallaba en silencio bajo una ruta
  con espacios (`url.pathname` percent-encoded); un test que verifica que el borrado ocurrió pero no
  que el respaldo existe; un test de contrato que prueba la mitad inofensiva.
  **Todo guard nuevo lleva un test anti-false-green** que verifique que encuentra algo conocido.
- **`git merge-base --is-ancestor` NO sirve aquí** (squash merge → "no mergeado" para el 100%). Lo
  que decide: `git log origin/main --grep="(#<PR>)"`.
- **`invariants[]` de un plugin no son nombres de tools** — son load-bearing substrings del render.
- **Las skills tienen cap de palabras** (`behavior` = 200): mover contenido ahí lo dispara.
- **`actions/checkout` no trae tags** → un check que compara contra un tag se salta a sí mismo.
- **En un pipe del Bash tool, `basename`/`wc`/`tr` pueden salir `command not found`** y los globs de
  zsh (`--include=*.ts`) fallan. Para auditorías, `python3`.

## Idioma: regla vigente

**Código y prompts en inglés; la interacción con el usuario en español.** Los mensajes de hook son
prompts → inglés. Los patrones de detección son input del usuario → español. El i18n del reporte
queda intacto.

## Regla de trabajo vigente

> Un hallazgo se vuelve issue **solo** si (a) necesita una decisión que no es del agente, (b) no
> cabe en el ciclo que lo encontró, o (c) se va a olvidar y duele.

## Límite que hay que decir ANTES del rollout

Por el hueco de #440, un `render` **no actualiza las zonas de usuario ya escritas**. Los tokens
viejos necesitan el chequeo de `doctor` y corrección **a mano**. Cuando toque: **per-repo, NUNCA
`--all`**.

## Notas heredadas

- `~/.navori/backups` acumula fixtures de test históricos. **Filtrar por prefijo, no por edad.**
- 60 branches locales con PR ya mergeado (de 127).
- La ruta de los repos Bonum del `~/.claude/CLAUDE.md` global está desactualizada; siguen pendientes
  los PRs de bonum-webapp (#639, #640, #559) y el rebind de SonarCloud.
