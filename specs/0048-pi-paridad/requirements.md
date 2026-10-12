# Pi paridad — Requirements

**Estado:** borrador solicitado por el usuario el 2026-10-11. Abrir esta spec no autoriza workplans de
entrega, implementación ni publicación.
**Base:** `origin/dev` en `e7596c35`. Continúa la spec 0047 (Pi first), cuyo ciclo funcional está
mergeado; no reabre su evidencia.

## Context

Con 0047 Pi completa el ciclo de Navori, pero solo con el subconjunto mínimo de garantías: el resto de
los controles que Claude y Codex aplican mediante hooks, los plugins habilitados y tres roles core no
existen en Pi, y varios no figuran siquiera en el catálogo de controles. Un usuario que elige Pi pierde,
sin aviso, protecciones como el bloqueo de comandos destructivos o el gate antes de commit. Esta spec
cierra esas brechas o las declara con su frontera real.

Se conserva la doctrina de 0047 y 0039: el contrato es el resultado, no la cantidad de hooks; nativo
primero; cada control declara `enforced`, `advisory` o `unsupported` con su límite.

## Evidencia inicial

- `packages/cli/src/engines/shared/engine-capabilities.ts`, tipo `ControlId`: 11 controles. No incluye
  `guard-destructive`, `quality-gate-pre-commit`, `pr-publisher-confirm`, `comment-draft-confirm`,
  `master-accept-confirm`, `subagent-no-background`, `managed-drift-watch`, `routing-watch`,
  `model-advisor`, `stop-verify-reminder`, `worktree-reclaim` ni `audit-mode-*`, aunque todos se emiten
  para Claude y varios para Codex (`.codex/hooks/`).
- `ENGINE_CAPABILITIES.pi.unsupportedSurfaces`: `claude-hook-parity` y `additional-analytic-roles`
  (auditor, architect y publisher no admitidos).
- `ENGINE_CAPABILITIES.pi.controls`: `handoff-shape`, `compact-advice` y `general-purpose-confirm`
  `unsupported`; `markdown-ownership` y `analytic-write-tools` solo `advisory`.
- `renderPiEngine` en `packages/cli/src/engines/pi/index.ts` construye el contexto del adaptador con
  `plugins: []`: ninguna skill, inyección de prosa ni hook de un plugin habilitado llega a Pi. Solo
  `mcpRoleDiagnostics` los menciona.
- `PI_EXTENSION_SOURCE` (`packages/cli/src/engines/pi/extension-source.ts`) maneja `session_start`,
  `before_agent_start`, `tool_call` y `tool_result`; no hay manejador de fin de sesión.
- `docs/pi.md`, “Not executed by automation”: la comparación RED/GREEN del contexto always-on, el smoke
  en vivo más allá de un dispatch del implementer y el cierre en una sesión Pi en vivo están pendientes.
- `npm view @earendil-works/pi-coding-agent version` → `1.1.0` el 2026-10-11: sigue siendo la versión
  en la que `child-mcp-grants` quedó `deferred`.

## Requirements (EARS)

- **R1** — The system SHALL declarar, para Pi, el estado (`enforced`, `advisory`, `unsupported`) y la
  frontera de cada hook core y de cada unidad de plugin que Navori emite para otro engine, y SHALL
  fallar la verificación del inventario si alguno queda sin declarar.
- **R2** — WHEN el agente principal o un hijo de Pi invoque el bash integrado con un comando que la
  política destructiva compartida bloquea, the system SHALL impedir su ejecución antes de que corra y
  devolver un diagnóstico que nombre la regla y la ruta permitida.
- **R3** — WHEN el agente principal o un hijo de Pi intente modificar un archivo generado por Navori
  fuera de `navori render`/`sync`, mediante herramientas de edición o bash, the system SHALL bloquear la
  escritura y nombrar el comando de render que la reemplaza.
- **R4** — WHEN se invoque desde Pi un `git commit` o `git push`, the system SHALL ejecutar antes el
  gate `qualityGate.fast` configurado y SHALL bloquear la operación si el gate falla o no puede correr.
- **R5** — WHEN se invoque desde Pi una operación publicadora (crear un PR, publicar un comentario o
  review, crear un issue, aceptar o cerrar un master plan), the system SHALL exigir la confirmación
  observable del usuario en el padre interactivo mostrando el contenido a publicar; denegación,
  cancelación o UI ausente SHALL impedirla.
- **R6** — IF un hijo de Pi sin UI intenta una operación de R5 THEN the system SHALL rechazarla en el
  hijo y devolverla al padre con el comando exacto para su aprobación.
- **R7** — WHEN un hijo `implementer` o `reviewer` de Pi termine, the system SHALL validar que su
  handoff canónico exista y cumpla la forma compartida antes de reportar éxito, y SHALL reportar el
  resultado como fallido si no cumple.
- **R8** — WHEN un hijo de Pi intente lanzar un comando en segundo plano, the system SHALL bloquearlo e
  indicar ejecutarlo en primer plano o reportar `BLOCKED`.
- **R9** — WHEN una herramienta de Pi deje un bloque gestionado de Navori con drift, the system SHALL
  añadir un aviso acotado al resultado sin alterarlo ni bloquear la herramienta.
- **R10** — WHEN la sesión principal de Pi termine, the system SHALL ejecutar el reclamo de worktrees y
  el cierre del log de audit-mode activo con las mismas reglas de seguridad de Claude, sin borrar
  worktrees con trabajo no publicado.
- **R11** — WHEN un turno del agente principal de Pi termine con cambios sin commitear, the system SHALL
  añadir un recordatorio de verificación acotado sin bloquear el turno.
- **R12** — WHEN se habilite un plugin y Pi esté activo, the system SHALL emitir sus skills y su prosa
  inyectada en las ubicaciones nativas de Pi bajo el ownership, backup y prune compartidos, sin duplicar
  lo que Codex ya posee cuando ambos engines están activos.
- **R13** — WHEN un plugin habilitado declare un servidor MCP y Pi esté activo, the system SHALL
  diagnosticar si el servidor no está configurado en la configuración MCP nativa de Pi, con la acción
  para registrarlo, sin escribir configuración ni credenciales del usuario.
- **R14** — WHEN un proyecto habilite los roles `auditor`, `architect` o `publisher`, the system SHALL
  permitir despacharlos con `navori_subagent` conservando instrucciones, modelo y una lista explícita de
  herramientas; el `publisher` SHALL quedar sujeto a R4, R5 y R6.
- **R15** — IF la extensión no puede evaluar un control `enforced` (error, payload desconocido o versión
  no verificada) THEN the system SHALL denegar la operación con un diagnóstico accionable; IF falla un
  control `advisory` THEN the system SHALL omitir el aviso sin alterar el resultado.
- **R16** — WHEN se rendericen Pi junto con Claude o Codex, the system SHALL dejar byte a byte idénticos
  los outputs de esos engines y usar una sola fuente para la política destructiva y el gate de cada
  engine.
- **R17** — The system SHALL verificar con un modelo en vivo un ciclo Pi-only completo —instalación,
  plan aprobado, implementación, documentación, revisión, commit con gate, PR confirmado y cierre con
  evidencia— y registrar el resultado RED/GREEN del contexto always-on en `evals.md`.
- **R18** — WHEN el agente principal de Pi invoque el bash integrado con un comando que las reglas
  `ask` compartidas de permisos marcan para confirmación (como `git reset --hard`, `git push --force`,
  `rm -r` o `git branch -D`), the system SHALL exigir la confirmación observable del usuario antes de
  ejecutarlo, y IF lo invoca un hijo sin UI THEN SHALL rechazarlo y devolverlo al padre como en R6.
  Los comandos que las reglas `deny` compartidas prohíben (como `sudo rm` o `mkfs`) SHALL bloquearse
  en Pi como en R2, derivados de la misma fuente.

## Decisiones del usuario (2026-10-11)

- **D-U1** — Se acepta que los hooks compartidos de Claude y Codex cambien de bytes (brazo `pi`, rutas
  `.pi/`, condición `onPi`) sin cambiar su comportamiento; los goldens se actualizan de forma explícita.
- **D-U2** — R8 se implementa en `subagent-no-background.sh` y bloquea `&`, `nohup`, `setsid` y `disown`
  también en subagentes de Claude.
- **D-U3** — En Windows, la herramienta `powershell` de Pi se bloquea (fail-closed) mientras no pase por
  la política compartida.
- **D-U4** — Las reglas `ask` destructivas de los permisos compartidos entran al alcance (R18).
- **D-U5** — El recordatorio de R11 conserva el texto fijo en español del script compartido.

## Límites de alcance

- No prometer equivalencia de los scripts de Claude: un mecanismo distinto vale si cumple el resultado
  y su prueba. Contar hooks no es aceptación.
- Nativo primero: si Pi ofrece una capacidad (permisos, confirmación, MCP), se usa y se documenta en vez
  de replicarla.
- No escribir `.pi/mcp.json`, `~/.pi/agent/*` ni credenciales; no instalar extensiones comunitarias.
- MCP en hijos (`child-mcp-grants`) sigue `deferred`: Pi 1.1.0 es la versión vigente y no permite
  verificar grants por rol. Se reabre con una versión de Pi que lo permita, mediante el probe de 0047.
- `routing-watch` y `model-advisor` se evalúan en R1; solo se implementan si el inventario demuestra
  que su señal existe en los eventos de Pi. `general-purpose-confirm` y `engram-write-guard`/`role-guard`
  (Codex) no aplican mientras Pi no tenga un rol general-purpose ni grants de engram en hijos.
- Las fronteras de 0047 se conservan: límites de procesos, `--no-mcp` en hijos y trust distinto de
  aprobación.
