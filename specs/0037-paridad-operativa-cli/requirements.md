# Paridad operativa Claude / Codex CLI — Requirements

**Fecha:** 2026-09-28 · **Estado:** especificación; implementación no autorizada en esta sesión.
**Madurez:** spec redactada, diseño por architect y challenge por auditor completados. Veredicto
CONCERNS con dependencias explícitas; implementación sin iniciar y sujeta a autorización posterior.
**Base del checkout:** `ea59ee5cc9a3dd0a6890752b121feeb8a5d9cccd`.
**Referencia adicional:** `131067295be01fa7b5410acea403b9702bae339c` (`origin/main` local actualizado
por otra actividad durante la sesión). El fetch propio falló por DNS; no se garantiza actualidad remota.

## Context

Ulises usa Claude Code y Codex CLI desde Warp. El harness ya genera e integra muchos componentes
en ambos hosts, pero generar archivos, registrar controles y observarlos actuar son cosas distintas.
Esta spec convierte la auditoría del 2026-09-28 en trabajo verificable, conserva sus resultados
positivos y corrige las brechas restantes. No promete respuestas idénticas entre modelos.

Complementa [Spec 0035](../0035-paridad-codex/requirements.md); no reabre sus tareas terminadas.
Coordina con [Spec 0036](../0036-engine-neutral-state/requirements.md) sin introducir otra raíz de
estado. La investigación #1082 se reutiliza con su revisión exacta: quedó integrada por #1084 en
`13106729`, posterior a la base del checkout de esta spec.
El registro duradero de observaciones y documentación está en [evidence.md](evidence.md).

## Alcance y decisiones conservadoras

- Objetivo: equivalencia observable de los contratos soportados, no identidad de modelos,
  herramientas internas, eventos de ciclo de vida ni texto de respuestas.
- Hosts iniciales: Claude Code CLI y Codex CLI, arranque desde el repo en Warp. App, IDE y cloud
  no quedan certificados por estas pruebas. Cada ejecución registra las versiones efectivas.
- Configuraciones: Claude-only, Codex-only y dual-engine; también worktree y repo con espacios.
- Se conserva la decisión de Spec 0035: `danger-full-access`, `on-request`, revisor `user` en el
  setup generado. No se cambia la sandbox administrada por el host ni el trust global.
- Plan-gate Codex sigue advisory. La falta de soporte verificable es un resultado válido, no
  permiso para inventar enforcement o bloquear indiscriminadamente toda delegación.
- Sin instalaciones, actualizaciones globales, reindexado, publicación, cambios de modelos
  pagados ni pruebas live con consumo en esta sesión de especificación.

## Requirements (EARS)

### Evidencia y diagnóstico

- **R1** — WHEN se produce un diagnóstico de paridad, el sistema SHALL identificar la procedencia
  del ejecutable efectivo mediante ruta resuelta, versión y huella/build disponible, junto con
  revisión del harness, cwd y versión del host; un dato inaccesible se identifica como desconocido.
- **R2** — WHEN doctor informa una capacidad por engine, el sistema SHALL distinguir declaración,
  materialización, registro, trust y ejecución observada sin promover una etapa a otra por inferencia.
- **R3** — IF una comprobación no puede completarse por permisos, red, autenticación, runtime o
  dependencia ausente, THEN el diagnóstico SHALL devolver un estado explícito no verificado con
  causa, sin presentarlo como control efectivo ni como escaneo limpio.

### Gates de plugins

- **R4** — WHERE Semgrep o jscpd están habilitados, el render Codex SHALL materializar y registrar
  sus scripts/hooks mediante los contratos existentes de plugins, sin requerir un árbol `.claude`
  en una instalación Codex-only.
- **R5** — WHEN un gate habilitado evalúa una operación cubierta, el control SHALL preservar la
  decisión Claude para el resultado observado: findings bloqueantes impiden la operación, errores
  distinguibles se reportan como no validado con la decisión vigente, y binario ausente se reporta
  como omisión advertida. Un resultado ambiguo no se etiqueta como findings confirmados; ni un
  error ni una omisión cuentan como escaneo aprobado.
- **R6** — WHEN se adapta un gate de plugin a Codex, el sistema SHALL conservar baseline,
  invalidación de caché, selección de archivos/includes, resolución en worktrees y decisiones Claude
  para entradas equivalentes, excepto diferencias documentadas y probadas del host.

### Orquestación, delegación y permisos

- **R7** — WHEN el agente principal consulta la referencia de profundidad de orquestación, el
  harness SHALL ofrecer el playbook completo compartido y navegable en ambos engines, sin
  autorreferencias vacías, sin duplicarlo íntegramente en always-on y sin despachar un orchestrator.
- **R8** — WHEN se valida un despacho de rol nombrado en un host soportado, la evidencia SHALL
  identificar el rol realmente aplicado, instrucciones distintivas y modelo/effort efectivos o
  su imposibilidad de observación; `task_name` por sí solo no cuenta como selección de perfil.
- **R9** — IF una ruta de despacho solo crea hijos genéricos o no permite probar la selección del
  perfil, THEN el harness SHALL declarar esa ruta no verificada/no equivalente y ofrecer únicamente
  un mecanismo alternativo explícito cuya limitación se documente, sin certificar los guards por rol.
- **R10** — WHEN se normalizan eventos de delegación para hooks y telemetría, el adaptador SHALL
  usar contratos medidos por evento y versión, conservando nombres desconocidos como tales;
  observar PreToolUse no certifica PostToolUse ni SubagentStart.
- **R11** — WHERE un rol tiene restricciones MCP representables por el host, el perfil generado
  SHALL expresar esas restricciones y demostrar lectura permitida/escritura prohibida donde aplica,
  sin eliminar la escritura legítima de artefactos ni cambiar la política global de filesystem.
- **R12** — WHEN se informa o configura un perfil, el harness SHALL distinguir valores explícitos,
  mapeados y heredados de modelo/effort, conservar overrides y registrar una decisión evaluada para
  architect y reviewer, sin afirmar equivalencia de calidad por nombre de tier.
- **R13** — WHILE no exista evidencia live de gating selectivo previo al spawn, el harness SHALL
  mantener plan-gate Codex advisory y comunicarlo coherentemente en capacidades, diagnósticos y prosa.
- **R14** — IF se propone elevar plan-gate a enforced, THEN la aceptación SHALL exigir un negativo
  sin hijo para implementer no conforme y positivos para implementer conforme y colaboración de
  otro rol, con rol y apertura de workplan verificables, versión fijada y trust aislado autorizado.
- **R15** — WHEN se inicia una investigación o primer productor, el workflow SHALL permitir ese
  despacho sin exigir un handoff de implementación inexistente, manteniendo el check obligatorio
  al consumir un handoff producido y separándolo de la precondición de planificación.

### Herramientas, skills y no regresión

- **R16** — WHEN se verifica búsqueda textual o estructural, la validación SHALL probar resultados
  correctos de tgrep y CodeGraph, reportar frescura/disponibilidad del índice y distinguir consulta
  CLI de invocación MCP sin instalar, iniciar servidores ni reindexar como efecto lateral.
- **R17** — WHEN se valida una skill compartida, la validación SHALL comprobar tanto render/discovery
  como invocación explícita y comportamiento de activación permitido por sus metadatos, sin tratar
  un inventario de archivos como prueba de ejecución.
- **R18** — WHEN cambia el adaptador, la suite SHALL preservar las capacidades ya verificadas:
  generación de perfiles/skills, reglas shell, guard destructivo, contexto de inicio, trust/hash,
  límites de contexto y ciclo de handoff/worktree según la semántica propia de cada host.
- **R19** — WHEN se verifica Engram, el diagnóstico SHALL separar conectividad/lectura de escritura
  con identidad runtime válida; una identidad ausente o inválida se reporta sin inventar IDs,
  registrar sesiones desde el modelo ni atribuir automáticamente el fallo al adaptador.

### Compatibilidad, documentación y cierre

- **R20** — WHEN una actualización cambia artefactos managed o definiciones de hooks, la migración
  SHALL preservar contenido del usuario, backups y guard antirollback, informar los cambios que
  requieren revisar trust y dejar su autorización explícita fuera del render automático.
- **R21** — WHEN se publica la matriz de compatibilidad, la documentación SHALL asociar cada
  capacidad con host/versión, estado y evidencia, incluir fortalezas y límites, y eliminar promesas
  de paridad completa no respaldadas, incluyendo la afirmación obsoleta sobre startup hooks Codex.
- **R22** — WHEN se compara comportamiento Claude/Codex, la validación SHALL ejecutar escenarios
  emparejados sobre una base y criterios idénticos, registrar calidad, omisiones de workflow,
  tiempo y costo disponible por separado, y conservar fallos, omisiones y resultados invertidos.
- **R23** — WHEN se extrae el playbook o amplía la integración, la validación SHALL registrar bytes
  always-on antes/después y comprobar los presupuestos del harness y del contexto compuesto,
  sin interpretar tokens, latencia o ahorro estimados como mediciones reales.

## Criterio de aceptación global

Cada R tiene tareas en [tasks.md](tasks.md) y pruebas identificadas en [validation.md](validation.md).
La asignación a tareas se hizo después del diseño y su challenge independiente.
La spec puede implementarse por lotes sin declarar paridad total: un lote cierra con evidencia de su
alcance, revisión fresca y gate aplicable; las limitaciones de host quedan visibles. Los contratos
duros soportados requieren todos sus positivos y negativos; una prueba bloqueada no cuenta como
pass. El cierre del programa exige publicar también las capacidades todavía advisory/no verificadas.
