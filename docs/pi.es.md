> [English](pi.md) | [Español](pi.es.md) | [简体中文](pi.zh-CN.md)

# Agente de programación Pi

Pi es un motor opcional de Navori. Renderiza recursos del proyecto que pertenecen a Navori para Pi y agrega la herramienta de extensión `navori_subagent` para los roles admitidos. Pi conserva la propiedad de la confianza del proyecto, MCP, la autenticación del proveedor y sus recursos de agente a nivel de usuario.

Esta guía documenta únicamente el estado verificado. El contrato comprobado por máquina (versiones, matriz de soporte y capacidades admitidas en tiempo de ejecución) se analiza desde `packages/cli/src/engines/pi/__tests__/first-class-e2e.test.ts`.

## Requisitos y configuración

- Versión mínima de Pi compatible: **1.1.0**
- Versión de Pi probada: **1.4.0**

El mínimo está definido en `MIN_PI_VERSION` (`packages/cli/src/engines/pi/runtime-version.ts`). La versión probada es la dependencia de desarrollo `@earendil-works/pi-coding-agent` fijada en `packages/cli`. El mínimo también cubre la evidencia de aceptación, que lee `structuredContent.exit_code` del bash integrado de Pi, y las capacidades admitidas del entorno de ejecución hijo (consulta [Admisiones de tiempo de ejecución](#admisiones-de-tiempo-de-ejecución)), verificadas únicamente con la versión 1.4.0. Pi 1.1–1.3 carga la extensión completa, pero `navori_subagent` rechaza los hijos con un mensaje de «actualiza Pi».

Pi se considera **no verificado** si está por debajo del mínimo, es una versión preliminar (por ejemplo, `1.2.0-rc.1`) o reporta una versión que no se puede analizar. Un Pi no verificado carga la extensión únicamente en modo de bloqueo de escritura: se bloquean `bash`, `edit`, `write` y `powershell`; `read`, `grep`, `find` y `ls` siguen disponibles; la primera llamada bloqueada muestra un aviso por proceso, y `navori_subagent` no se registra. Las versiones estables superiores al mínimo siguen admitidas; todavía no hay un límite superior declarado, así que una incompatibilidad futura se resolverá publicando uno.

La versión mínima de Node.js para Pi es **22.19.0 o posterior**. Este repositorio de Navori requiere actualmente Node.js **24 o posterior**, así que usa el requisito más alto del repositorio al ejecutar su CLI. Consulta la [guía de inicio rápido de Pi](https://pi.dev/docs/latest/quickstart).

Habilita Pi en la configuración del proyecto:

```json
{
  "engines": ["pi"]
}
```

Después renderiza los recursos del proyecto y revisa los cambios propuestos antes de aplicarlos:

```sh
navori render
navori render --apply
```

Inicia Pi en el proyecto y revisa o acepta su solicitud de confianza del proyecto. Renderizar archivos no activa los recursos de un proyecto que aún no es de confianza. Al cargarse, la extensión verifica Node.js y `VERSION` del paquete de Pi importado; un Pi no verificado recibe el modo de bloqueo de escritura descrito arriba. Esto no es una negociación universal del host mediante `pi --version`; las pruebas de tiempo de ejecución ejercitan el paquete de Pi fijado.

## Matriz de soporte

Cada fila corresponde a un control de Pi de `ENGINE_CAPABILITIES.pi.controls`. `enforced` significa que la extensión de confianza del proyecto Pi verifica el límite; `advisory` significa que la señal es contexto o una advertencia y nunca constituye un límite de permisos; `unsupported` significa que Navori no proporciona ese control en Pi.

| Control | Estado | Límite |
| --- | --- | --- |
| `plan-gate` | enforced | Con `harness.planTiers` activado, la extensión controla únicamente las llamadas de implementador a `navori_subagent`. Las llamadas directas al shell y a las herramientas de Pi omiten este control. |
| `master-plan` | advisory | Con `harness.masterPlan` activado, antes de iniciar cada agente se agrega una línea de estado acotada. Es solo contexto, no un límite de permisos. |
| `markdown-ownership` | advisory | Con `harness.scribeOwnsMarkdown` activado, se bloquea la edición o escritura directa de Markdown con Pi en los hijos implementadores. Las escrituras con bash y procesos del entorno pueden omitirlo. |
| `handoff-shape` | enforced | Al terminar un hijo `navori_subagent` de `implementer` o `reviewer`, la extensión de confianza valida su handoff canónico (debe ser reciente respecto a la instantánea del dispatch). Si falta, está desactualizado o no es válido, devuelve `isError`. Las llamadas directas al shell o a herramientas, y los demás roles, omiten este control. |
| `handoff-consumer` | enforced | Se verifican las llamadas de `navori_subagent` de `reviewer` que incluyen explícitamente una función. Las llamadas directas al shell y a herramientas omiten este control. |
| `analytic-write-tools` | advisory | Las listas de herramientas permitidas por rol son capacidades visibles para el modelo, no entornos aislados del sistema operativo, del sistema de archivos ni de la red. Scout y reviewer conservan `write`. |
| `local-skill-discovery` | enforced | `project.localSkills` se proyecta como referencias bajo `.agents/skills/<id>` y solo se escriben cuando Codex no está habilitado. |
| `acceptance-evidence` | enforced | La extensión registra como evidencia del workplan los códigos de salida observados por el host para el bash integrado de Pi (llamadas del padre, del hijo y anidadas; Pi 1.1.0+). Si `PI_SESSION_ID` está definido, `plan update` rechaza `cumplido` sin esa evidencia. Falla de forma cerrada: si se reemplaza la herramienta bash o falta `exit_code`, no registra nada. |
| `repeat-failure-advice` | advisory | Después de tres fallas idénticas del bash integrado, se agrega una advertencia. Nunca bloquea ni altera el resultado, y no se muestra si falta `exit_code`. |
| `compact-advice` | unsupported | Pi no ejecuta scripts de hooks de Navori, así que no se inyectan consejos sobre el tamaño del contexto después de un dispatch de publisher. |
| `general-purpose-confirm` | unsupported | Pi no ejecuta scripts de hooks de Claude y su lista de `navori_subagent` no tiene un rol general-purpose que confirmar. |

Pi también detecta de forma nativa las skills de proyecto de confianza en `.agents/skills/`. Cuando se seleccionan Pi y Codex, Codex es dueño de los destinos compartidos y Pi no los duplica. Pi no copia ni ejecuta scripts de hooks de Claude y Codex.

## Admisiones de tiempo de ejecución

Cada fila corresponde a una capacidad del entorno de ejecución hijo de `ENGINE_CAPABILITIES.pi.runtimeAdmissions`. Las capacidades `admitted` están verificadas en Pi 1.4.0; las capacidades `deferred` no están disponibles.

| Capacidad | Decisión | Límite |
| --- | --- | --- |
| `child-mcp-off` | admitted | `--no-mcp` desactiva el MCP integrado de Pi únicamente en el hijo. No es un entorno aislado del sistema operativo; el padre conserva su MCP. |
| `child-model-selection` | admitted | `--model <provider/id>` selecciona el modelo del hijo. No redefine el esfuerzo ni el razonamiento. |
| `child-tool-allowlist` | admitted | `--tools` es una lista de herramientas permitidas visible para el modelo, no un aislamiento. `--no-mcp` cierra la exposición indirecta a MCP. |
| `child-ipc-relay` | admitted | Node IPC (`stdio` `ipc`) del hijo al padre informa el comando rechazado exacto. Nunca aprueba nada; consulta [Reenvío de aprobaciones](#reenvío-de-aprobaciones). |
| `child-mcp-grants` | deferred | Los hijos se ejecutan con `--no-mcp`. Pi 1.1.0 conecta cada servidor MCP habilitado y los enumera todos en la instrucción del hijo, por lo que no se pueden verificar los permisos MCP por rol. Los roles que necesitan MCP no están disponibles en hijos. |
| `session-end-event` | admitted | `session_shutdown` se ejecuta únicamente al salir limpiamente o usar `/new`, en el padre. Un SIGKILL no dispara nada, así que la siguiente sesión hace la limpieza. Recargar, reanudar y bifurcar no terminan la sesión. |
| `settle-boundary-entries` | admitted | `agent_before_settle` agrega una entrada visible al final de la ejecución del agente. Nunca establece `continue`, así que no puede forzar otra solicitud al modelo. |

## Ciclo de vida de la sesión

Esto se ejecuta únicamente en la sesión padre; los hijos no hacen nada. Todas las fallas son silenciosas y nunca hacen fallar la sesión.

- **Salir o usar `/new`** (`session_shutdown` con motivo `quit` o `new`):
  1. `worktree-reclaim` se ejecuta con un límite de 12 s, solo si existe `.claude/worktrees`. La integración de Pi conserva cualquier worktree con trabajo no publicado o archivos ignorados bajo `.navori/state/`.
  2. `audit-mode-close` se ejecuta con un límite de 3 s y sella únicamente un registro de auditoría existente.
- **Recargar, reanudar y bifurcar**: no se ejecuta nada.
- **Recordatorio de verificación** (`agent_before_settle`, solo cuando está definido `hooks.verifyOnStop`): si el árbol tiene cambios sin confirmar, se agrega como `custom_message` visible un recordatorio fijo en español para ejecutar el quality gate y hacer commit. No dispara otra solicitud al modelo.

## Puente de hooks

La extensión de confianza ejecuta mediante un puente los scripts compartidos de hooks de Navori. El contrato es el siguiente:

- **Carga útil.** El puente envía una carga útil con formato de Claude: `hook_event_name`, `tool_name` (`Bash`, `Edit` o `Write`), `tool_input`, `cwd`, `session_id`, `permission_mode` y `agent_id`/`agent_type` en los hijos. La copia del script se identifica como Pi por su ruta bajo `/.pi/navori/`, no por la carga útil.
- **Ubicación.** Los scripts se copian a `.pi/navori/hooks/<id>.sh`, y el conjunto proviene de `PI_HOOK_BINDINGS` (`engines/pi/hook-bindings.ts`):
  - `guard-destructive`: `tool_call`, bash, `enforced`, padre e hijos.
  - `subagent-no-background`: `tool_call`, bash, `enforced`, solo hijos.
  - `managed-drift-watch`: `tool_result`, bash, edit y write, `advisory`, padre e hijos.
  - `worktree-reclaim` y `audit-mode-close`: `session_shutdown`, solo padre, `lifecycle`.
  - `stop-verify-reminder`: `agent_before_settle`, solo padre, `advisory`, se instala únicamente con `hooks.verifyOnStop`.

  La sección [Protecciones](#protecciones) describe qué bloquea cada uno.
- **Shell.** Los scripts se ejecutan bajo bash, según la configuración de shell de Pi. Nunca se usa el `shellPath` del proyecto. Si no existe bash o solo está disponible el respaldo `sh`, se bloquean todos los scripts `enforced` y se indica qué acción tomar.
- **Ejecución.** Los scripts no interactivos se ejecutan en paralelo, cada uno con su propio límite de tiempo. Gana el primer bloqueo.
- **Veredicto.** Solo un objeto JSON en stdout con `hookSpecificOutput`, `systemMessage` o `continue` cuenta como veredicto. El resto de stdout es ruido y solo se conservan hasta 64 KiB. Se conserva el inicio y el final de stderr.

| Resultado del script | `enforced` (`tool_call`) | `advisory` (`tool_result`) | `lifecycle` |
| --- | --- | --- | --- |
| código de salida 0, sin JSON de veredicto | permitir | nada | nada |
| código de salida 2 | bloquear, motivo = stderr | advertencia = stderr | nada |
| JSON `permissionDecision` deny | bloquear | nada | nada |
| JSON `permissionDecision` ask | preguntar | nada | nada |
| JSON `permissionDecision` allow, contexto o mensaje | permitir | advertencia = contexto | nada |
| decisión JSON desconocida, `updatedInput` o `continue` false | bloquear | nada | nada |
| código de salida distinto de 0 o 2, señal, timeout, no se pudo iniciar o falta bash | bloquear | nada | nada |

Las fallas de los scripts `advisory` y `lifecycle` son silenciosas. El cierre ante fallas solo se aplica a los scripts `enforced`.

**Manifiesto v2.** `.pi/navori.json` tiene `schemaVersion: 2`, con `hooks` (las vinculaciones del puente), `ownedPaths` (rutas propiedad de Navori) y `permissionRules` (`ask` y `deny`). Protección contra degradación: una versión de Navori que solo admite v1 considera ajeno el formato v2 y se rehúsa a escribir recursos de Pi; esta CLI también se rehúsa a escribir sobre un esquema más reciente. Se sigue reconociendo un manifiesto v1 y un render lo actualiza. Si el manifiesto no se puede leer, está mal formado o no es v2, la extensión bloquea `bash`, `edit` y `write` porque no puede evaluarlos; las lecturas siguen disponibles.

**Powershell (D-U3).** La herramienta `powershell` de Pi ejecutaría comandos fuera de la política de shell compartida. Por eso Navori la quita de las herramientas activas en `session_start` con `setActiveTools` y bloquea cualquier llamada a `powershell` en `tool_call`. En Windows, usa la herramienta `bash`; requiere Git for Windows (Git Bash).

### Latencia

Por llamada de bash a través del puente, con todos los scripts vinculados ejecutándose en paralelo: p50 26.7 ms, p95 31.1 ms, máximo 34.6 ms (macOS, n=60). Medido por `packages/cli/src/engines/pi/__tests__/first-class-latency.test.ts`.

## Plugins

Un plugin habilitado llega a Pi mediante `renderPiEngine` (`packages/cli/src/engines/pi/index.ts`) y `plugin-projection.ts`. Se omite un plugin que la matriz de superposición marque como nativo en Pi. Esto es lo que proyecta un plugin habilitado:

- **Skills sobre skills.** Una skill de plugin con `injectInto: .claude/skills/<id>/SKILL.md` se convierte en un subbloque administrado de `.agents/skills/<id>/SKILL.md`. Pi solo lo escribe cuando Codex no está en `engines`; con Codex activo, Codex escribe esa skill y Pi nunca la duplica.
- **Texto de roles.** Una skill de plugin con `injectInto: .claude/agents/<role>.md` se agrega a `.pi/agents/<role>.md`, interpolada y adaptada para Pi. Un plugin que declara `mcpServer` no aporta texto de rol: los hijos de Pi se ejecutan con `--no-mcp`.
- **Bloques de orquestador y AGENTS.md.** Una skill inyectada en `.claude/agents/orchestrator.md` y los bloques `managed` del plugin se convierten en subbloques del `AGENTS.md` compartido. Pi solo los escribe si ningún otro motor habilitado es dueño de ese archivo (`ownsAgentsMd`); de lo contrario se conserva la salida de ese propietario.
- **Scripts.** Los scripts de plugin se copian a `.pi/navori/scripts/<dest>` como copias ejecutables propias de Pi, incluso si Codex está activo. Un script se instala únicamente cuando una fila del puente lo ejecuta o cuando la extensión de hooks del plugin se incorpora a una copia de hook de Pi instalada. Se omiten los destinos duplicados.
- **Hooks.** Los hooks `PreToolUse`/`Bash` de plugin usan la gramática que traduce Codex. Se convierten en filas de manifiesto v2 en `.pi/navori.json` que apuntan a `.pi/navori/scripts/<dest>`: `tool_call`, `bash`, alcance `all`, `enforced`, no interactivos y con el timeout del manifiesto. Si un hook no se puede traducir, se informa como advertencia y no se instala.
- **Extensiones de hooks.** Una entrada `hookExtensions` de plugin que apunta a un hook central de Claude se convierte en un subbloque administrado de la copia de Pi, `.pi/navori/hooks/<hook>`, y se elimina de nuevo cuando se deshabilita el plugin.

La propiedad, el respaldo y la depuración usan el plan compartido de render, igual que en los demás motores: las salidas del plugin son rutas propiedad de Navori, el plan informa su ruta de respaldo y se depura un script de `.pi/navori/scripts/` cuando ya no tiene vinculaciones. Al deshabilitar un plugin se quitan sus subbloques de `.agents/skills/<id>/SKILL.md` y se depuran sus salidas de Pi.

Por unidad, los estados en el [Inventario de paridad](#inventario-de-paridad) son:

| Unidad del plugin | Estado en Pi | Qué significa en Pi |
| --- | --- | --- |
| Subbloque de skill (`.agents/skills`, `AGENTS.md`) | `advisory` | Texto que lee el modelo; nada lo hace cumplir. |
| Script de plugin ejecutado por un hook | `enforced` | Protección para llamadas a la herramienta `bash` únicamente; no es un entorno aislado. |
| Hook de plugin | `enforced` | Los mismos límites que la protección compartida; solo se aplica mientras está cargada la extensión. |
| `settingsFragment` | `n/a` | Solo reglas `allow`, que Pi no traduce (igual que Codex). |
| Servidor MCP | `advisory` | Render advierte si el servidor falta o está deshabilitado en la configuración MCP de Pi. |
| Skill MCP de plugin en un rol hijo | `unsupported` | Los hijos se ejecutan con `--no-mcp`, así que no se inyecta el texto. |
| Skill en un rol que Pi no renderiza (por ejemplo, `publisher`) | `unsupported` | Pendiente del trabajo de roles en la especificación 0048 R14 y M11. |
| Script de protección tgrep y extensión de hook `tgrep-search-lane` | `enforced` (protección) | El script se instala bajo `.pi/navori/scripts/`. La ruta se ejecuta dentro de la copia de protección de Pi (`.pi/navori/hooks/guard-destructive.sh`) mediante el puente. Solo cubre grep/rg y falla de forma abierta si tgrep, su servidor o el índice no están disponibles. |

Render advierte si el servidor MCP de un plugin falta o está deshabilitado en la configuración MCP nativa de Pi. Navori nunca escribe la configuración MCP de Pi.

## Protecciones

Las protecciones de Navori son políticas textuales. Pi no tiene un sistema de permisos, así que cada regla compara el texto de una llamada y funciona como una protección, no como un entorno aislado. Las filas correspondientes aparecen como `enforced (seatbelt)` en el [Inventario de paridad](#inventario-de-paridad).

**Comandos destructivos y reglas deny (`guard-destructive`).** Las reglas destructivas compartidas y las reglas de permisos compartidas `deny` bloquean tanto al padre como a cada hijo. Las reglas `deny` se traducen a prefijos de tokens durante el render, con la misma traducción que usa Codex. Sus reglas `ask` se confirman en el padre (consulta las reglas compartidas `ask` más adelante).

La copia de Pi agrega tres reglas que solo existen ahí:

- **Plano de control.** Se bloquean los verbos de escritura (`>`, `>>`, `>|`, `tee`, `sed -i`, `rm`, `mv`, `cp`, `ln`, `dd`, `install`, `truncate`, `chmod`, `git checkout|restore`) y los intérpretes en línea (`python -c`, `node -e`, `perl -i`, `ruby -e`, `php -r`) cuando nombran `.pi/navori/**`, `.pi/extensions/**`, `.pi/settings.json` o `.pi/navori.json`. Las lecturas siguen permitidas.
- Se bloquea `pi --no-extensions` (o `-ne`) desde bash. Esa forma inicia Pi sin extensión, puente ni hooks.

**Archivos administrados (ruta de `edit` y `write`).** La extensión normaliza la ruta como lo hacen las propias herramientas de Pi: quita un `@` inicial, expande `~`, convierte espacios Unicode en espacios comunes, resuelve la ruta respecto al proyecto y sigue enlaces simbólicos. Después:

- Bloquea el plano de control y cada entrada `ownedPaths` de `.pi/navori.json`, incluidos los destinos que todavía no existen.
- En archivos mixtos (`AGENTS.md`, `CLAUDE.md`, skills, `.claude/`, `.codex/`, `.cursor/rules/` e instrucciones de Copilot), solo se reconoce un bloque administrado con la gramática real de marcadores: un marcador de apertura y otro de cierre con el mismo id, ambos en la columna 0 y fuera de una cerca de código. Se bloquea `write` si el archivo contiene un bloque administrado. Se bloquea `edit` si `oldText` cae dentro de uno o si la edición tiene una forma que la ruta no reconoce. El texto fuera de los bloques, incluida la sección de usuario, sigue siendo editable.
- Un marcador citado a mitad de línea o un marcador de apertura sin cierre no forman un bloque. Si una ruta de archivo mixto no es un archivo regular o supera 4 MiB, se bloquea.
- Los archivos ajenos `.pi/agents/*.md` siguen siendo editables con `edit`. Brecha conocida: la ruta de shell nombra los siete archivos de rol de Navori (`scout`, `implementer`, `reviewer`, `scribe`, `auditor`, `architect`, `publisher`), un superconjunto; por eso se bloquea la escritura por shell de un archivo de usuario con uno de esos nombres hasta que Navori renderice ese rol.

**Aviso de deriva (`managed-drift-watch`).** Después de una llamada a bash, edit o write, el observador revisa los bloques administrados bajo las raíces de Pi, incluida `.pi/navori/`. Mantiene su propia línea base en `.navori/state/hooks/managed-drift-stamp-pi`, así que nunca consume el informe que vería una sesión de Claude concurrente. La deriva aparece como advertencia en el resultado de la herramienta. Nunca bloquea.

**Clases de evasión.** Las filas de protección enumeran estas formas de evadirla (`PI_SEATBELT_BYPASSES`):

- `sh -c`, `eval`, `xargs` o un comando ofuscado.
- Un script escrito en disco y luego ejecutado.
- `pi --no-extensions` en una forma que la regla no cubre.
- Herramientas MCP con capacidad de escritura del padre (`mcp__github__*`).
- Extensiones de terceros que modifican la entrada de la herramienta después del controlador de Navori.

Las reglas destructivas tienen sus propias brechas: entrar al plano de control con `cd` y luego hacer una escritura relativa (`cd .pi/navori && echo x > navori.json` pasa), construir con variables una ruta del plano de control y usar variantes `mkfs.<fs>` como `mkfs.ext4`. La regla compartida deny `mkfs` solo coincide con el token exacto: se bloquea `mkfs /dev/sda`, pero no `mkfs.ext4 /dev/sda`.

**Orden de las verificaciones (`tool_call`).** En cada llamada, la extensión sigue este orden: (1) bloquea una llamada a `powershell`; (2) lee el manifiesto y, si no se puede leer o no es v2, bloquea `bash`, `edit` y `write`; (3) pasa `edit` o `write` por la ruta de archivos administrados; (4) ejecuta los scripts del puente y detiene la llamada si hay un bloqueo `enforced`; (5) solicita una confirmación combinada para la declaración `--approved-by` y cada veredicto `ask`. La confirmación queda vinculada a la entrada exacta que vio el usuario; si cambia, se rechaza.

**Control de commit y push (`quality-gate-pre-commit`).** Pi no tiene hooks nativos de git, así que la copia de Pi controla tanto `git commit` como `git push`. Ejecuta `qualityGate.fast` con un límite de 600 s. Si el control falla, se bloquea la llamada en el padre y en un hijo. Si falta el ejecutor del control, se bloquea en un hijo o sin interfaz; en el padre con interfaz se pregunta. El script solo existe cuando está definido `qualityGate.fast`. El límite de tamaño del archivo de progreso (`progress/current.md`) también se aplica al hacer push, no solo al hacer commit. Los límites de los roles deben superar al del control: cada rol con `bash` tiene un límite de al menos el del control + 10 min (20 min). Los límites por rol están en `PI_ROLE_TIMEOUT_MS`, en `packages/cli/src/engines/pi/role-tools.ts`: `implementer` 30 min, `publisher` 40 min, `scribe`, `reviewer`, `auditor` y `architect` 20 min cada uno. `scout` no tiene `bash` y conserva 10 min.

**Confirmaciones de publicación.** Estos scripts preguntan antes de cualquier operación de publicación y muestran el contenido:

- `pr-publisher-confirm` pregunta en cada `gh pr create` (Pi no tiene una solicitud del host, así que la copia de Pi siempre pregunta).
- `comment-draft-confirm` pregunta para borradores de comentarios y revisiones; `master-accept-confirm`, para aceptar y cerrar el plan maestro.
- La aprobación de un archivo de contenido queda vinculada al sha256 de ese archivo. La extensión vuelve a verificar los resúmenes después de la confirmación y antes de permitir la llamada. Rechaza la llamada si el contenido cambia, se crea o se elimina después de la confirmación, o no se puede leer.
- Los contenidos creados por shell, stdin y contenidos en línea se muestran en la confirmación, pero no quedan vinculados a un hash.

**Reglas compartidas `ask`.** El puente recopila los veredictos `ask` de cada script y de las reglas de permisos compartidas `ask`. Después, la extensión muestra una sola confirmación para la declaración `--approved-by` y para todos esos veredictos, vinculada a la llamada exacta.

- Un bloqueo siempre gana sobre una pregunta: los scripts `enforced` se ejecutan primero, así que una llamada que se bloqueará nunca llega al usuario.
- La confirmación ocurre en el padre. Se rechaza en un hijo (cuando está definido `NAVORI_PI_CHILD_DEPTH`) y el comando exacto se reenvía al padre (consulta [Reenvío de aprobaciones](#reenvío-de-aprobaciones)). La confirmación escrita funciona en la TUI y en modo RPC (que proporciona un contexto de interfaz real). En modo sin interfaz o de impresión, la llamada se rechaza.
- `publisher` está admitido y sujeto a todas las reglas anteriores: sus operaciones de publicación se rechazan en el hijo, se reenvían al padre y se confirman ahí.

**Diálogo de confirmación (primero denegar).** El padre muestra un diálogo de entrada de texto (`ctx.ui.input`) con el título "Navori approval required", el comando exacto, sus motivos y la instrucción de escribir `yes, run it`. Solo se aprueba ese texto exacto, sin espacios al inicio o al final. Enter vacío, Escape, cualquier otro texto, un timeout o un error del diálogo rechazan la llamada. No se usa un selector, así que ninguna opción puede quedar resaltada de antemano. Después de la confirmación, la extensión vuelve a verificar el estado del repositorio y los resúmenes de los contenidos; si alguno cambió, rechaza la llamada y vuelve a solicitar aprobación.

## Hallazgos de doctor

Cuando el motor está habilitado, `navori doctor` reporta estos hallazgos de Pi. Todos son informativos: ninguno cambia el resultado `ok` de doctor, y la extensión ya falla de forma cerrada en cada caso. Si no existe el ejecutable `pi` o no se puede leer el archivo de configuración, no hay nada que verificar y no se considera un error.

- **Versión no verificada**: el Pi instalado está por debajo del mínimo, es una versión preliminar o no se puede analizar.
- **Powershell predeterminado**: el `defaultTools` efectivo (el `.pi/settings.json` del proyecto o, en su defecto, la configuración del usuario) selecciona `powershell`.
- **Extensiones ajenas**: entradas de extensiones del proyecto distintas de la propia de Navori, provenientes de `.pi/extensions/` y de la configuración `extensions` del proyecto.

## Subagentes de Navori

Una vez cargada la extensión de confianza del proyecto, Pi expone la herramienta `navori_subagent`. Roles admitidos y sus listas de herramientas de Pi (de `packages/cli/src/engines/pi/role-tools.ts`):

- `scout`: `read, grep, find, ls, write`
- `implementer`: `read, grep, find, ls, bash, edit, write`
- `reviewer`: `read, grep, find, ls, bash, write`
- `scribe`: `read, grep, find, ls, bash, edit, write`; solo se admite cuando `harness.scribeOwnsMarkdown` está activado, y en ese caso el implementador requiere que el rol `scribe` esté habilitado
- `auditor`: `read, grep, find, ls, bash, write`
- `architect`: `read, grep, find, ls, bash, write`; no puede iniciar subagentes anidados en Pi (`navori:if-not onPi`)
- `publisher`: `read, grep, find, ls, bash`; sus operaciones de git commit y push ejecutan el quality gate, y sus operaciones de publicación requieren la confirmación del padre (consulta [Protecciones](#protecciones))

La herramienta requiere `role` y una `task` no vacía; `feature` es opcional, excepto para `reviewer`, que requiere un slug explícito de función Navori para verificar el handoff; `implementer`, `reviewer` y `scribe` requieren `feature`. Se conservan las instrucciones y descripciones de los roles. Se usa un modelo configurado cuando corresponde a un modelo `codexMap` concreto; de lo contrario, el hijo hereda el modelo Pi seleccionado. Cada rol tiene una lista explícita de herramientas Pi; si falta una asignación o no se reconoce, se falla de forma cerrada en vez de habilitar las herramientas predeterminadas. Los hijos nunca reciben permisos MCP (consulta `child-mcp-grants`).

### Reenvío de aprobaciones

Un hijo sin interfaz no puede aprobar una operación. Cuando el comando Bash de un hijo declara una aprobación humana (`--approved-by`) y se rechaza, el hijo envía al padre el comando exacto rechazado por el canal IPC de Node. El padre valida cada mensaje: debe coincidir con el esquema esperado, no superar 8 KiB y el padre acepta como máximo 5 por hijo. Las solicitudes aceptadas aparecen en `details.parentApprovals` del resultado de `navori_subagent`, con una línea en su contenido. El reenvío solo informa; el rechazo sigue vigente.

Sin IPC, el padre recupera el comando de los argumentos `tool_execution_start` del mismo `toolCallId`, y la llamada termina con error, nunca con éxito. El bash del modelo no hereda el canal.

### Validación del handoff al terminar el hijo

Al iniciar el hijo, la extensión toma una instantánea del handoff canónico: `impl_<feature>.json` para `implementer` y `review_<feature>.json` para `reviewer`. Cuando termina el hijo, si el handoff falta o no cambió desde la instantánea (mismo contenido y mtime), se considera obsoleto.

- `implementer` ejecuta `navori handoff check <feature> --for orchestrator`. Una advertencia `head` también provoca una falla.
- `reviewer` ejecuta `navori handoff check <feature> --produced-by reviewer --since <dispatch time>`. El sidecar y el veredicto deben ser válidos, y la evidencia sellada debe verificarse con una revisión iniciada en el dispatch o después.

Cualquier falla, incluida la imposibilidad de leer la verificación, devuelve `isError` con el motivo y la salida del hijo (falla de forma cerrada). No se valida `scribe` al terminar el hijo; solo se aplica el requisito de `feature`.

## Límites y ejecuciones sin interfaz

- Los hijos están limitados a un nivel, tres procesos concurrentes y diez minutos cada uno.
- La salida del hijo se trunca a 64 KiB; se informa del truncamiento, pero no se trata como cancelación.
- La cancelación envía `SIGTERM` y escala a `SIGKILL` después de cinco segundos. También se terminan los descendientes que sobrevivan al proceso líder.
- El hijo no registra otra herramienta `navori_subagent`.
- Los hijos sin interfaz no pueden aprobar operaciones. La extensión rechaza solicitudes de aprobación de un hijo y devuelve el comando a la sesión padre para que el usuario lo apruebe ahí. La confianza no equivale a aprobación: el hijo recibe `--approve` con alcance de proceso solo después de que el padre de confianza haya cargado la extensión.
- Estos límites, listas de herramientas y `--no-mcp` no crean un entorno aislado del sistema operativo. Los procesos hijos heredan el entorno, la autoridad sobre el sistema de archivos y la red del usuario, y el directorio de agente de Pi.

## Comparación en vivo con Claude

El lector de M5 vincula los hijos de Pi confirmados con sus ID de invocación y conserva los fallos posteriores al arranque.
M6 añade `navori audit --by-engine --published-from <bare>`: la evidencia de Git o de la transcripción que no esté disponible sigue sin estarlo, y las observaciones mínimas que falten producen `inconclusive`. La correlación es descriptiva; no otorga autoridad a ningún actor ni establece un revisor independiente.

El driver de solo desarrollo del repositorio es [scripts/bench/run-live.ts](../scripts/bench/run-live.ts).
Prepara dos checkouts reales de Git a partir del mismo fixture, 60 archivos de búsqueda, un remoto bare local
y un doble local de `gh`. Su preflight `auth status` explica que la publicación local no requiere autenticación de GitHub;
no lee credenciales ni se autentica contra GitHub. Los comandos no soportados siguen saliendo con estado 64. El fixture usa `npm test` como comando de gate seguro; el script de pruebas del paquete
ejecuta `node --test` sin dependencias. Las referencias publicadas son `claude/benchmark` y `pi/benchmark`.
La configuración de Git y las plantillas son locales al fixture. Los engines nativos conservan su acceso normal
al sistema de archivos y a la red, y sus permisos nativos; este driver no es un sandbox del sistema operativo.

La preparación no inicia ningún modelo:

```bash
bun scripts/bench/run-live.ts prepare
```

Copia la `root` física devuelta en `NAVORI_BENCH_ROOT`. Tras obtener una autorización separada para las cuentas, los modelos y el presupuesto de gasto, inicia un engine desde la terminal POSIX del operador:

```bash
NAVORI_LIVE_BENCH=1 bun scripts/bench/run-live.ts launch --root "$NAVORI_BENCH_ROOT" --engine claude --model sonnet
NAVORI_LIVE_BENCH=1 bun scripts/bench/run-live.ts launch --root "$NAVORI_BENCH_ROOT" --engine pi --model provider/model
```

Ejecútalos en secuencia. El driver requiere soporte nativo de `--session-id` (observado en Claude Code
2.1.309 y Pi 1.3.0); esta observación no amplía las admisiones de tiempo de ejecución verificadas por las pruebas del SDK fijado.
Los roles del fixture de Claude usan Sonnet; Pi hereda el provider/modelo explícito seleccionado.
El flag de ejecución no es un tope monetario. El operador controla las aprobaciones nativas y el límite de gasto autorizado.
Las herramientas MCP están deshabilitadas para esta comparación; las configuraciones de seguridad nativas siguen activas.

Mientras el padre está abierto, usa otra terminal para obtener el siguiente prompt exacto:

```bash
bun scripts/bench/run-live.ts task --root "$NAVORI_BENCH_ROOT" --engine claude --task 2
```

Repite para las tareas 3–5 y para Pi, pegando cada prompt devuelto en ese engine. La tarea 2 activa la
prueba de paginación que ya falla en **bytes rastreados**, lo que invalida el gate en caché de la tarea 1. Durante la tarea 5,
ejecuta `/compact` cuando el padre se pause y envía otro turno. Cierra cada padre al terminar sus cinco tareas.
El driver nunca proporciona respuestas de aprobación ni usa un flag de omisión de permisos.

```bash
bun scripts/bench/run-live.ts collect --root "$NAVORI_BENCH_ROOT"
```

La recolección ejecuta `navori audit --by-engine --published-from` contra el directorio privado de auditorías de esta corrida
(`NAVORI_AUDITS_ROOT`), sin `--all-repos`, porque el lector de auditoría rechaza ese flag junto con
`--by-engine`. La cohorte acotada admite solo los encabezados de sesión asignados a esta corrida. La verificación
de fuentes nativas sigue a cargo del lector de auditoría.
Las observaciones parciales conservan sus métricas y fallos; las etiquetas de etapa faltantes no pueden obtener `pass`.
Las etiquetas no demuestran la ejecución de la tarea. `comparisonVerification: unverified` mantiene separada la verificación del operador de las cinco tareas reales y de los modelos reales del resultado métrico K1.
Si no se lanzó ningún modelo o falta alguna fuente, el resultado es `inconclusive`.
Registra el resultado real, las versiones nativas, los modelos resueltos reales y los resultados de paridad scripted en
`specs/0053-pi-igualar-claude/evals.md`. La comparación tiene n = 1, admite modelos distintos y no equivale a una aprobación correlacionada
ni a una revisión independiente. La preparación local no es la aceptación en vivo.

El resultado parcial en vivo (solo Claude Code, Pi no ejecutado, `inconclusive`, sin afirmación de paridad) se registra en
[evals.md](../specs/0053-pi-igualar-claude/evals.md).

## Inventario de paridad

`PI_PARITY` (`packages/cli/src/engines/shared/pi-parity.ts`) enumera cada unidad que Navori emite para otros motores (hooks centrales, reglas de permisos compartidas y componentes del manifiesto de plugins) y lo que Pi ofrece actualmente para cada una. Cada fila tiene un estado:

- `enforced`: bloquea o requiere algo que Pi no puede omitir por sí solo. Una fila de política textual que bloquea es una protección, no un entorno aislado (Pi no tiene un sistema de permisos), y debe enumerar sus clases de evasión.
- `advisory`: informa sin bloquear o cubre solo parte de la forma.
- `unsupported`: una brecha, con su motivo.
- `n/a`: la unidad no aplica a Pi, con el motivo correspondiente.

Una unidad sin fila hace fallar la prueba de inventario (`pi-parity.test.ts`), que indica cuál falta. Una fila sigue como `unsupported` hasta que el cambio que la implementa la actualiza junto con su código y sus pruebas.

<!-- pi-parity:start -->
<!-- Generated from `PI_PARITY` (`packages/cli/src/engines/shared/pi-parity.ts`). Do not edit by hand: `first-class-e2e.test.ts` pins it. -->

Clases de evasión de cada fila de protección (una protección es una verificación textual, no un entorno aislado):

- sh -c / eval / xargs / comando ofuscado
- un script escrito en disco y luego ejecutado
- pi --no-extensions fuera de la forma cubierta
- herramientas MCP con capacidad de escritura del padre (mcp__github__*)
- extensiones de terceros que modifican la entrada de la herramienta después del controlador de Navori

| Unidad | Estado | Clase | Límite |
|---|---|---|---|
| `hook:audit-mode-close` | advisory | — | solo sella un registro existente: Pi nunca abre un registro de audit-mode (el hook `audit-mode-trigger` no es compatible), así que no hace nada hasta que se inicie uno. Las fallas son silenciosas |
| `hook:audit-mode-trigger` | unsupported | — | Pi nunca abre un registro de audit-mode mediante este hook (fuera del alcance de la especificación 0048, no es un objetivo de diseño) |
| `hook:bash-outcome-watch` | advisory | control `repeat-failure-advice` | — |
| `hook:comment-draft-confirm` | enforced | protección (clases de evasión anteriores) | un contenido en línea o ilegible solo se muestra como comando. No se muestran los contenidos stdin (`-F -`) ni una ruta construida por el shell (`$VAR`, `$(…)`). Hay una ventana entre la verificación y la ejecución. Las formas indirectas de shell lo omiten |
| `hook:engram-write-guard` | n/a | — | Solo Codex: los hijos de Pi se ejecutan con `--no-mcp`, así que no hay permisos de engram que proteger (`child-mcp-grants` está aplazado) |
| `hook:general-purpose-confirm` | unsupported | control `general-purpose-confirm` | — |
| `hook:guard-destructive` | enforced | protección (clases de evasión anteriores) | política textual sobre la cadena del comando: reglas destructivas del script compartido, reglas de permisos compartidas `deny`, escrituras al plano de control de Pi (`.pi/navori/**`, `.pi/extensions/**`, `.pi/settings.json`, `.pi/navori.json`) y `pi --no-extensions`. Las reglas compartidas `ask` responden `ask` (su propia fila) |
| `hook:implementer-no-markdown` | advisory | control `markdown-ownership` | — |
| `hook:managed-drift-watch` | advisory | — | nunca bloquea y solo detecta bloques con marcador hash (AGENTS.md, skills, copias de hooks); la extensión, el manifiesto y los archivos de roles no tienen hash por bloque y están protegidos por la protección y la ruta de edit/write. La deriva que no puede evaluar pasa inadvertida |
| `hook:master-accept-confirm` | enforced | protección (clases de evasión anteriores) | cubre `navori master part\|delivery-baseline\|delivery-queue\|delivery-criterion … --approved-by`, `master close`, `delivery-review\|decision\|publication\|revoke` y `delivery-slice --refresh`; las formas indirectas de shell (`sh -c`, un script en disco) la omiten. La confirmación es una protección, no un entorno aislado |
| `hook:master-plan-context` | advisory | control `master-plan` | — |
| `hook:model-advisor` | unsupported | — | En Pi, el modelo se elige con `/model` y se pasa a los hijos (especificación 0047 R17); no hay una carga útil de cambio de modelo por turno sobre la que avisar |
| `hook:plan-gate` | enforced | control `plan-gate` | — |
| `hook:pr-publisher-confirm` | enforced | protección (clases de evasión anteriores) | solo se instala cuando el rol publisher está habilitado; un contenido en línea o ilegible solo se muestra como comando. Las formas indirectas de shell lo omiten |
| `hook:quality-gate-pre-commit` | enforced | protección (clases de evasión anteriores) | solo con `qualityGate.fast` configurado (sin fila en otro caso, igual que en Claude y Codex); el resultado corresponde al árbol de trabajo en ese momento. Las formas indirectas de shell (`sh -c`, un script en disco) lo omiten; no detecta un hook externo al agente (la propia terminal del usuario) |
| `hook:role-guard` | n/a | — | Solo Codex: Claude y Pi restringen los roles mediante su lista de herramientas permitidas, no con un hook (`HOOK_ENGINES`) |
| `hook:routing-watch` | unsupported | — | Se vuelve `advisory` solo cuando el puente asigna los nombres de herramientas y campos de carga útil de Pi al contrato del script, y agrega `additionalContext` como bloque al resultado (especificación 0048 E1 M2/E3); nunca bloquea |
| `hook:session-start-context` | advisory | — | Solo aporta contexto, no es un límite; se omite la inyección si ocurre cualquier error |
| `hook:stop-verify-reminder` | advisory | — | Nunca bloquea ni establece `continue`, así que no genera otra solicitud al modelo; un recordatorio por ejecución del agente; si falla, no muestra nada |
| `hook:subagent-no-background` | enforced | protección (clases de evasión anteriores) | política textual sobre la cadena del comando, solo hijos: el padre puede ejecutar tareas en segundo plano |
| `hook:subagent-stop-handoff` | enforced | control `handoff-shape` | — |
| `hook:worktree-reclaim` | advisory | — | mismo umbral que en Claude (limpio, publicado, PR integrado), además: se conserva un worktree con archivos ignorados bajo `.navori/state/`. Pi no crea worktrees; un SIGKILL no dispara eventos y la siguiente sesión hace la limpieza. Las fallas son silenciosas |
| `permission-rule:class:allow-not-translated` | n/a | — | Pi no tiene sistema de permisos, así que no hay lista allow que traducir (igual que Codex) |
| `permission-rule:class:bash-ask` | enforced | protección (clases de evasión anteriores) | prefijos de tokens: se descarta un patrón con comodín interno y un `*` unido al último token se reduce al token exacto (`git clean -f*` pregunta por `git clean -f`, no por `-fd`); una regla de bloqueo gana sobre una pregunta |
| `permission-rule:class:bash-deny` | enforced | protección (clases de evasión anteriores) | prefijos de tokens: se descarta un patrón con comodín interno o una entrada que no sea Bash (su propia fila); un `*` unido al último token se reduce al token exacto |
| `permission-rule:class:prompt-amendment` | n/a | — | Enmienda persistente exclusiva de Codex "no volver a preguntar"; Pi no tiene reglas de solicitud |
| `permission-rule:dropped:Agent(orchestrator)` | n/a | — | La lista de roles de Pi no tiene un rol orchestrator para iniciar, así que no hay nada que prohibir |
| `permission-rule:narrowed:Bash(git branch --delete*)` | enforced | protección (clases de evasión anteriores) | familia git-destructive-prefix: el prefijo solo coincide con el destino literal (un `*` final unido se reduce al token exacto) |
| `permission-rule:narrowed:Bash(git clean -d*)` | enforced | protección (clases de evasión anteriores) | familia git-destructive-prefix: el prefijo solo coincide con el destino literal (un `*` final unido se reduce al token exacto) |
| `permission-rule:narrowed:Bash(git clean -f*)` | enforced | protección (clases de evasión anteriores) | familia git-destructive-prefix: el prefijo solo coincide con el destino literal (un `*` final unido se reduce al token exacto) |
| `permission-rule:narrowed:Bash(git push --force*)` | enforced | protección (clases de evasión anteriores) | familia git-push-force: el prefijo solo coincide con el destino literal (un `*` final unido se reduce al token exacto) |
| `permission-rule:narrowed:Bash(git reset --hard*)` | enforced | protección (clases de evasión anteriores) | familia git-destructive-prefix: el prefijo solo coincide con el destino literal (un `*` final unido se reduce al token exacto) |
| `permission-rule:narrowed:Bash(git stash clear*)` | enforced | protección (clases de evasión anteriores) | familia git-destructive-prefix: el prefijo solo coincide con el destino literal (un `*` final unido se reduce al token exacto) |
| `permission-rule:narrowed:Bash(git stash drop*)` | enforced | protección (clases de evasión anteriores) | familia git-destructive-prefix: el prefijo solo coincide con el destino literal (un `*` final unido se reduce al token exacto) |
| `permission-rule:narrowed:Bash(mkfs*)` | enforced | protección (clases de evasión anteriores) | familia mkfs: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm --force --recursive $HOME/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm --force --recursive --no-preserve-root*)` | enforced | protección (clases de evasión anteriores) | familia rm-no-preserve-root: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm --force --recursive /*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm --force --recursive ~/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm --force -R $HOME/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm --force -R --no-preserve-root*)` | enforced | protección (clases de evasión anteriores) | familia rm-no-preserve-root: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm --force -R /*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm --force -R ~/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm --force -r $HOME/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm --force -r --no-preserve-root*)` | enforced | protección (clases de evasión anteriores) | familia rm-no-preserve-root: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm --force -r /*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm --force -r ~/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm --no-preserve-root*)` | enforced | protección (clases de evasión anteriores) | familia rm-no-preserve-root: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm --recursive $HOME/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm --recursive --force $HOME/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm --recursive --force --no-preserve-root*)` | enforced | protección (clases de evasión anteriores) | familia rm-no-preserve-root: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm --recursive --force /*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm --recursive --force ~/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm --recursive --no-preserve-root*)` | enforced | protección (clases de evasión anteriores) | familia rm-no-preserve-root: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm --recursive -f $HOME/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm --recursive -f --no-preserve-root*)` | enforced | protección (clases de evasión anteriores) | familia rm-no-preserve-root: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm --recursive -f /*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm --recursive -f ~/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm --recursive /*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm --recursive ~/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -R $HOME/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -R --force $HOME/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -R --force --no-preserve-root*)` | enforced | protección (clases de evasión anteriores) | familia rm-no-preserve-root: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -R --force /*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -R --force ~/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -R --no-preserve-root*)` | enforced | protección (clases de evasión anteriores) | familia rm-no-preserve-root: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -R -f $HOME/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -R -f --no-preserve-root*)` | enforced | protección (clases de evasión anteriores) | familia rm-no-preserve-root: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -R -f /*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -R -f ~/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -R /*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -R ~/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -Rf $HOME/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -Rf --no-preserve-root*)` | enforced | protección (clases de evasión anteriores) | familia rm-no-preserve-root: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -Rf /*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -Rf ~/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -f --recursive $HOME/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -f --recursive --no-preserve-root*)` | enforced | protección (clases de evasión anteriores) | familia rm-no-preserve-root: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -f --recursive /*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -f --recursive ~/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -f -R $HOME/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -f -R --no-preserve-root*)` | enforced | protección (clases de evasión anteriores) | familia rm-no-preserve-root: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -f -R /*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -f -R ~/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -f -r $HOME/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -f -r --no-preserve-root*)` | enforced | protección (clases de evasión anteriores) | familia rm-no-preserve-root: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -f -r /*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -f -r ~/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -fR $HOME/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -fR --no-preserve-root*)` | enforced | protección (clases de evasión anteriores) | familia rm-no-preserve-root: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -fR /*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -fR ~/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -fr $HOME/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -fr --no-preserve-root*)` | enforced | protección (clases de evasión anteriores) | familia rm-no-preserve-root: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -fr /*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -fr ~/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -r $HOME/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -r --force $HOME/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -r --force --no-preserve-root*)` | enforced | protección (clases de evasión anteriores) | familia rm-no-preserve-root: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -r --force /*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -r --force ~/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -r --no-preserve-root*)` | enforced | protección (clases de evasión anteriores) | familia rm-no-preserve-root: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -r -f $HOME/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -r -f --no-preserve-root*)` | enforced | protección (clases de evasión anteriores) | familia rm-no-preserve-root: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -r -f /*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -r -f ~/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -r /*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -r ~/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -rf $HOME/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -rf --no-preserve-root*)` | enforced | protección (clases de evasión anteriores) | familia rm-no-preserve-root: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -rf /*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (rm de raíz, home y sistema, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `permission-rule:narrowed:Bash(rm -rf ~/*)` | enforced | protección (clases de evasión anteriores) | familia rm-recursive-root-home: el prefijo solo coincide con el destino literal; las reglas numeradas del mismo script (root/home/system rm, `--no-preserve-root`, variantes mkfs) bloquean las demás formas |
| `plugin-hook-extension:tgrep/tgrep-search-lane` | enforced | protección (clases de evasión anteriores) | protección textual solo para segmentos grep/rg; falla de forma abierta (auditada como fail-open) cuando el índice no está disponible |
| `plugin-managed:acli/acli-protocol` | advisory | — | Pi escribe el archivo AGENTS (con includePluginBlocks) solo cuando ni Codex ni agents-md son sus propietarios; entonces prevalece la salida de ese propietario. El bloque es texto: Pi lo lee, nada lo hace cumplir |
| `plugin-managed:codegraph/codegraph-search-v2` | advisory | — | Pi escribe el archivo AGENTS (con includePluginBlocks) solo cuando ni Codex ni agents-md son sus propietarios; entonces prevalece la salida de ese propietario. El bloque es texto: Pi lo lee, nada lo hace cumplir |
| `plugin-managed:tgrep/tgrep-search-v2` | advisory | — | Pi escribe el archivo AGENTS (con includePluginBlocks) solo cuando ni Codex ni agents-md son sus propietarios; entonces prevalece la salida de ese propietario. El bloque es texto: Pi lo lee, nada lo hace cumplir |
| `plugin-mcp-server:codegraph` | advisory | — | que esté configurado no significa que esté conectado: no se detectan --no-mcp, -builtin:mcp ni extensiones que reemplacen el MCP nativo; solo se leen los nombres de servidores y `enabled`. Navori nunca escribe la configuración MCP de Pi |
| `plugin-mcp-server:engram` | advisory | — | que esté configurado no significa que esté conectado: no se detectan --no-mcp, -builtin:mcp ni extensiones que reemplacen el MCP nativo; solo se leen los nombres de servidores y `enabled`. Navori nunca escribe la configuración MCP de Pi |
| `plugin-script:tgrep/guard-search-routing.sh` | enforced | protección (clases de evasión anteriores) | solo búsquedas de contenido (grep/rg); falla de forma abierta si falta tgrep, su servidor no está ejecutándose o no hay índice |
| `plugin-settings:acli` | n/a | — | solo reglas `allow`: Pi no tiene sistema de permisos y no traduce allow, igual que Codex |
| `plugin-settings:codegraph` | n/a | — | solo reglas `allow`: Pi no tiene sistema de permisos y no traduce allow, igual que Codex |
| `plugin-settings:engram` | n/a | — | solo reglas `allow`: Pi no tiene sistema de permisos y no traduce allow, igual que Codex |
| `plugin-settings:gh` | n/a | — | solo reglas `allow`: Pi no tiene sistema de permisos y no traduce allow, igual que Codex |
| `plugin-settings:tgrep` | n/a | — | solo reglas `allow`: Pi no tiene sistema de permisos y no traduce allow, igual que Codex |
| `plugin-skill:acli/acli-comment-channel-publisher` | advisory | — | solo son indicaciones; nada las hace cumplir. Con el rol publisher deshabilitado no existe un archivo de rol y el texto no se renderiza |
| `plugin-skill:codegraph/codegraph-access-v2-architect` | unsupported | — | codegraph declara un servidor MCP y los hijos de Pi usan --no-mcp, así que no se inyecta el texto de architect; render nombra el rol (`mcpRoleDiagnostics`) |
| `plugin-skill:codegraph/codegraph-access-v2-auditor` | unsupported | — | codegraph declara un servidor MCP y los hijos de Pi usan --no-mcp, así que no se inyecta el texto de auditor; render nombra el rol (`mcpRoleDiagnostics`) |
| `plugin-skill:codegraph/codegraph-access-v2-implementer` | unsupported | — | codegraph declara un servidor MCP y los hijos de Pi usan --no-mcp, así que no se inyecta el texto de implementer; render nombra el rol (`mcpRoleDiagnostics`) |
| `plugin-skill:codegraph/codegraph-access-v2-orchestrator` | advisory | — | Pi escribe el archivo AGENTS (con includePluginBlocks) solo cuando ni Codex ni agents-md son sus propietarios; entonces prevalece la salida de ese propietario. El bloque es texto: Pi lo lee, nada lo hace cumplir |
| `plugin-skill:codegraph/codegraph-access-v2-reviewer` | unsupported | — | codegraph declara un servidor MCP y los hijos de Pi usan --no-mcp, así que no se inyecta el texto de reviewer; render nombra el rol (`mcpRoleDiagnostics`) |
| `plugin-skill:engram/engram-auditor-extension` | unsupported | — | engram declara un servidor MCP y los hijos de Pi usan --no-mcp, así que no se inyecta el texto de auditor; render nombra el rol (`mcpRoleDiagnostics`) |
| `plugin-skill:engram/engram-implementer-extension` | unsupported | — | engram declara un servidor MCP y los hijos de Pi usan --no-mcp, así que no se inyecta el texto de implementer; render nombra el rol (`mcpRoleDiagnostics`) |
| `plugin-skill:engram/engram-orchestrator-extension` | advisory | — | Pi escribe el archivo AGENTS (con includePluginBlocks) solo cuando ni Codex ni agents-md son sus propietarios; entonces prevalece la salida de ese propietario. El bloque es texto: Pi lo lee, nada lo hace cumplir |
| `plugin-skill:engram/engram-reviewer-extension` | unsupported | — | engram declara un servidor MCP y los hijos de Pi usan --no-mcp, así que no se inyecta el texto de reviewer; render nombra el rol (`mcpRoleDiagnostics`) |
| `plugin-skill:gh/gh-comment-channel-publisher` | advisory | — | solo son indicaciones; nada las hace cumplir. Con el rol publisher deshabilitado no existe un archivo de rol y el texto no se renderiza |
<!-- pi-parity:end -->

## Comandos del ciclo

El ciclo verificado, en orden:

1. Ejecuta `navori render` y luego `navori render --apply` para instalar los recursos de Pi.
2. Inicia Pi en el proyecto de confianza. El contexto de Navori (AGENTS.md y la instantánea operativa) se carga al inicio.
3. Aprueba el workplan con `navori plan update <feature> --decision approved --date <YYYY-MM-DD>` y actualiza el índice de aceptación que lee la extensión. `navori plan render <feature>` vuelve a escribir el Markdown del workplan y también escribe el índice de aceptación. Si el índice no tiene una línea para la función, falla la evidencia de aceptación con el error `run navori plan render <feature>, then rerun the command`.
4. Inicia los roles con `navori_subagent` (`role`, `task` y, cuando se requiere, `feature`).
5. Ejecuta los comandos de aceptación mediante el bash integrado de Pi. Cuando `PI_SESSION_ID` está definido, el host registra cada código de salida observado como evidencia.
6. `navori plan update <feature> --progress <ID>=cumplido --json` cierra un criterio únicamente si hay evidencia registrada. Sin ella, el comando termina con un código distinto de cero y nombra el criterio.
7. Deshabilita con `navori render --apply --prune` después de cambiar `engines`. Solo se depuran recursos propiedad de Navori; los archivos ajenos y los productos del trabajo se conservan.

## Resultado de e2e sin credenciales

La automatización lo ejecutó con `bun run --cwd packages/cli test src/engines/pi/__tests__/first-class-e2e.test.ts` en el entorno de ejecución Pi 1.4.0 fijado. La prueba ejecuta dentro del proceso el CLI compilado (render, workplan aprobado, `plan update`), el ciclo real del agente SDK de Pi y la tubería de herramientas, procesos Pi `pi` reales iniciados por la extensión renderizada, las herramientas bash y write integradas de Pi, git y el sistema de archivos. Cubre instalación, aprobación sin interfaz, rechazo, un flujo hijo de más de 256 KiB, dispatch de implementer/scribe/reviewer con el modelo del padre, registro de evidencia, el recibo, actualización y deshabilitación.

Límites, expresados claramente:

- No usa un modelo en vivo. El proveedor falso demuestra la tubería, nunca el cumplimiento del modelo.
- No ejecuta un proceso TUI ni RPC. El padre corre en el proceso; la aprobación se realiza mediante el ejecutor real de extensiones de Pi con un `ui.input` simulado, así que no se prueba la representación del diálogo.
- "Recibo" es el cierre compartido de `plan update ... cumplido` sobre la evidencia registrada por el host.
- No usa OAuth en vivo. No se leen, almacenan ni usan credenciales reales.

## No ejecutado por automatización

- **Comparación de contexto siempre activa (RED/GREEN, modelo en vivo)**: no ejecutada. El diseño la requiere (consulta [design.md](../specs/0047-pi-first/design.md)); está pendiente.
- **Prueba rápida con modelo en vivo**: parcial; consulta [evals.md](../specs/0047-pi-first/evals.md). La prueba manual confirmó que se cargó el contexto inicial de `AGENTS.md` y que se hizo un dispatch implementer mediante `navori_subagent`. Aún no cubrió nada más. La prueba en vivo pendiente de 0048 está registrada en [evals.md](../specs/0048-pi-paridad/evals.md).
- **Cierre en una sesión Pi en vivo**: no ejecutado.

## MCP nativo y confianza del proyecto

Pi ofrece soporte MCP nativo, incluidos servidores a nivel de usuario en `~/.pi/agent/mcp.json` y servidores a nivel de proyecto en `.pi/mcp.json`. Pi controla la confianza de los recursos del proyecto. Revisa el proyecto antes de otorgarle confianza; consulta las guías de Pi sobre [configuración de MCP](https://pi.dev/docs/latest/mcp), [configuración](https://pi.dev/docs/latest/settings) y [seguridad y confianza](https://pi.dev/docs/latest/security).

Navori conserva la configuración MCP tanto del usuario como del proyecto. No crea ni migra ninguno de esos archivos, no agrega un servidor MCP, no cambia la opción `builtin:mcp` de Pi ni instala una extensión MCP aparte. Configura los servidores mediante el mecanismo nativo de Pi y mantén las credenciales fuera de la configuración del proyecto.

La confianza es una decisión explícita de Pi. Navori no aprueba automáticamente el proyecto padre ni usa `-e` para omitir la confianza.

### Diagnóstico MCP para plugins

Se verifica la configuración MCP nativa de Pi para cada plugin que declara un servidor MCP. La verificación es de solo lectura e informativa: lee `${PI_CODING_AGENT_DIR:-~/.pi/agent}/mcp.json` y `.pi/mcp.json`, y registra únicamente los nombres de servidores, `enabled` y si una entrada define un transporte (`command`, `url` o `type`). Nunca copia valores como env o tokens ni escribe en ninguno de esos archivos. Para comparar nombres de servidores, `-` y `_` se consideran equivalentes. Una entrada del proyecto que define un transporte reemplaza la entrada global del mismo nombre; una entrada que solo establece `enabled` activa o desactiva la global.

Al renderizar, si un servidor no está configurado o está deshabilitado, se genera una advertencia con la acción `pi mcp add <id> -- <command> <args...>`. Un servidor habilitado solo en `.pi/mcp.json` también genera una advertencia, que indica que solo tendrá efecto si el proyecto es de confianza. Si el archivo no contiene JSON válido, la advertencia muestra un mensaje fijo con la ruta, nunca el texto del analizador.

Al iniciar la sesión, la extensión Pi del padre repite la verificación. Si un servidor está habilitado solo en `.pi/mcp.json` y el proyecto no es de confianza (`ctx.isProjectTrusted()`), muestra un aviso durante ese inicio de sesión para indicar que el servidor no tendrá efecto hasta que se otorgue confianza al proyecto (`/trust`). Si hay errores, la verificación es silenciosa y no se ejecuta en sesiones hijas.

El diagnóstico informa que un servidor está configurado, no conectado. No puede detectar `--no-mcp` ni una extensión MCP que reemplace el soporte MCP de Pi.

## OAuth de ChatGPT Plus/Pro

Pi es dueño del flujo OAuth y las credenciales de la suscripción a ChatGPT. Inicia Pi de forma interactiva en el proyecto de confianza, ejecuta `/login openai-codex` (o `/login` y selecciona la opción de suscripción OpenAI ChatGPT Plus/Pro), luego usa `/model` para elegir un modelo `openai-codex` disponible y envía una instrucción inocua. Consulta la [guía de autenticación de proveedores](https://pi.dev/docs/latest/providers) y la [guía de modelos](https://pi.dev/docs/latest/models) de Pi.

Navori no lee, copia, genera, actualiza ni registra el `auth.json` de Pi, y no usa silenciosamente una clave API de OpenAI como alternativa. Si falla la autenticación, usa el flujo `/login` de Pi; no proporciones credenciales a Navori. Las pruebas automatizadas del entorno de ejecución no usan credenciales; la autenticación de cuenta se verifica manualmente.

## Prueba manual

La prueba en vivo es la única evidencia de que el diálogo TUI se representa y de que el modelo cumple el contrato. La prueba e2e sin credenciales no demuestra ninguno de esos puntos. Ejecútala en un proyecto cuyos recursos Pi sean de confianza y registra cada paso en [evals.md](../specs/0048-pi-paridad/evals.md).

1. Verifica `pi --version`; debe ser 1.4.0 o posterior.
2. Inicia Pi de forma interactiva y ejecuta `/login`; selecciona el inicio de sesión de suscripción ChatGPT Plus/Pro `openai-codex`. Navori no inspecciona archivos de credenciales.
3. Ejecuta `/model` y selecciona el modelo que usarán los hijos.
4. Ejecuta `navori render --apply`.
5. Aprueba el plan: `navori plan update <feature> --decision approved --date <YYYY-MM-DD>`.
6. Implementación: inicia `implementer` con `navori_subagent`; su handoff debe validarse.
7. Documentación: inicia `scribe` para la documentación.
8. Revisión: inicia `reviewer` con la función.
9. Haz commit y push a través del quality gate.
10. Confirma el PR en el diálogo TUI y revisa el contenido que muestra.
11. Cierra el criterio: `navori plan update <feature> --progress A<n>=cumplido`. Solo tiene éxito si hay evidencia registrada.

Estado actual: **aún no se ejecutó**. La evidencia va en [evals.md](../specs/0048-pi-paridad/evals.md).

Consulta la [especificación del motor Pi](../specs/0040-pi-engine/requirements.md) y la [primera especificación de Pi](../specs/0047-pi-first/requirements.md) para ver los requisitos y el estado de implementación y revisión.
