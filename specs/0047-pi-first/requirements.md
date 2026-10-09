# Pi first — Requirements

**Estado:** límites y tres enmiendas de la spec aceptados por el usuario el 2026-10-09; no implementado. La aceptación no autoriza workplans de entrega, implementación, aceptación runtime ni publicación.
**Base:** `origin/dev` en `e3183d84`. Complementa la spec 0040; no modifica su evidencia ni declara cerrado su smoke manual.

## Context

Pi debe permitir completar el ciclo de Navori con garantías verificadas: contexto suficiente, aprobación aplicable, implementación, documentación, revisión y cierre respaldado por evidencia. No basta con que cargue la extensión. El contrato es el resultado esperado del harness, no las funciones, hooks ni el roster de Claude. Como en la spec 0039, Navori complementa lo que el host no hace; no replica sus capacidades nativas. Calidad > tokens > velocidad.

La prioridad de soporte de Pi no retira Codex ni convierte la implementación de Claude en una especificación para Pi. Esta revisión incorpora la solicitud de parches del usuario y conserva un solo tablero en 0047. Abrir esta spec no autoriza su implementación, publicación o despliegue.

## Evidencia inicial

- `specs/0040-pi-engine`, requisitos R1–R10: MVP de render, tres roles, límites de procesos, MCP/auth nativos y gates acotados.
- `packages/cli/src/engines/shared/engine-capabilities.ts`, `ENGINE_CAPABILITIES.pi`: roles adicionales, skills locales y evidencia de aceptación pendientes; varios controles no soportados.
- `specs/0039-claude-first/requirements.md`, “Alcance y decisiones”: admisión nativo primero y soporte explícito por engine.
- Documentación oficial instalada de Pi **1.1.0**, consultada en esta sesión: README; `docs/extensions.md`, “Follow the extension contracts”, “UI and modes”; `docs/skills.md`, “Understand how skills load”; `docs/security.md`, “Understand project trust”; `docs/mcp.md`, “Control tool exposure”, “Permissions”. Fuente upstream: [Pi coding-agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent). Las rutas `main` son mutables: la entrega que dependa de una API debe registrar versión y probe ejecutable.

Pi ya ofrece skills progresivas, MCP, autenticación, sesiones y puntos de extensión. No trae subagentes ni plan mode integrados según su README. Trust no es un sandbox ni aprobación de producto. `--tools` no excluye automáticamente todo MCP; codemode y discovery requieren verificar el acceso efectivo.

## Brechas confirmadas y evidencia de partida

La revisión directa y los dispatches fallidos sin artefactos son antecedentes históricos. El 2026-10-09 un scout independiente mediante CLI, acotado y de solo lectura, aportó investigación y challenge; tras la síntesis del orquestador, el usuario aceptó los límites conservadores y las tres enmiendas. Esto no es un receipt de revisión de shipping ni evidencia runtime A1–A7. Referencias a símbolos y casos estables:

- **G1 — Contexto autónomo:** `renderPiEngine` en `packages/cli/src/engines/pi/index.ts` no emite contexto principal; un dry-run con `engines: ["pi"]` devolvió cero destinos `AGENTS.md`/`CLAUDE.md`. El repo multiengine oculta la carencia porque otro engine genera `AGENTS.md`. **R16.**
- **G2 — Documentación sin salida:** `.pi/agents/implementer.md`, prohibición de Markdown, y `PI_EXTENSION_SOURCE`, `ROLE_TOOLS`/handler `tool_call`: se exige scribe mientras la extensión admite solo tres roles. Con `scribeOwnsMarkdown: true` falta una ruta soportada que cierre la documentación. **R18.**
- **G3 — Cumplimiento sin prueba:** `packages/cli/src/commands/plan.ts`, `evidenceRequired` y rama `engine-without-signal`, permiten `cumplido` sin evidencia en Pi. **R7, R8.**
- **G4 — Límite acumulado:** `PI_EXTENSION_SOURCE`, `runChild`, en el checkout principal revisado acumula JSONL y termina al superar 256 KiB. El parche local del worktree 0047 introduce `childParser` incremental; no está integrado ni aceptado por esta spec. **R4, R19.**
- **G5 — Modelo no heredado:** `PI_EXTENSION_SOURCE`, `runChild`, omite `--model` cuando el rol no tiene override, sin transmitir la identidad activa del padre. Coincidir con defaults no demuestra herencia. **R17.**

`bun run --cwd packages/cli test src/engines/pi/__tests__` pasó 46 pruebas/8 archivos en el checkout principal y 62 pruebas/8 archivos en el worktree con el parche local. Son antecedentes del MVP/parser, no evidencia de A1–A7. Los probes de runtime existentes usan Pi 0.87.1; Pi instalado reportó 1.1.0. La carga actual no demuestra compatibilidad integral con esa versión. El gate general alcanzó cobertura pero terminó por timeout a los 180 segundos; no se declara verde. La CLI instalada no reconoció `navori gate`; la verificación de implementación deberá usar una CLI compatible del checkout o ejecutar literalmente el gate configurado, comprobando que sí corrió.

## Requirements (EARS)

- **R1** — The system SHALL registrar, en el inventario de solapamiento existente, el equivalente nativo verificado, decisión de admisión, versión/fuente y límite de cada unidad distribuida para Pi antes de emitirla como complemento.
- **R2** — WHEN se active el engine Pi, the system SHALL diagnosticar incompatibilidad de la versión/API contra las versiones probadas sin declarar activos controles cuya semántica no haya sido verificada.
- **R3** — WHEN un proyecto habilite roles core de Navori, the system SHALL permitir despachar sus roles configurados mediante Pi conservando instrucciones, modelo y acceso explícito, salvo el orquestador que SHALL permanecer en el hilo principal. En E1 los hijos SHALL usar `--no-mcp` nativo; los roles configurados que requieran MCP SHALL diagnosticarse como indisponibles con una acción para retomarlos, sin admisión silenciosa ni defaults amplios.
- **R4** — IF un hijo falla, se cancela o alcanza un límite THEN the system SHALL devolver estado parcial o fallido acotado y terminar sus procesos sin declarar completa la tarea.
- **R5** — WHEN una operación requiera aprobación humana, the system SHALL exigir confirmación observable en el padre interactivo TUI/RPC, ligada a la operación o plan aplicable y su estado. Denegación, cancelación, cambio de objeto/estado o UI ausente SHALL impedir autorización con diagnóstico accionable. Los hijos headless SHALL rechazar nuevas operaciones que requieran aprobación y devolverlas al principal; `--approve`/project trust SHALL NOT suplir consentimiento operativo. Reutilizar contratos existentes de plan aprobado/handoff, sin autorización transferible ni subsistema de delegación.
- **R6** — WHEN se despache un consumidor de un handoff de implementación, the system SHALL validar el artefacto canónico antes del despacho y rechazar datos ausentes o inválidos dentro del camino de orquestación soportado.
- **R7** — WHEN el host observe una ejecución exitosa cuyo comando coincida exactamente con un criterio de aceptación, the system SHALL registrar evidencia correlacionada con criterio, comando, directorio, HEAD, huella del árbol y sesión, sin ejecutar el comando desde Navori.
- **R8** — WHEN se cierre un milestone o entrega desde Pi, the system SHALL usar el contrato compartido de receipts y gates para rechazar evidencia ausente, obsoleta o correspondiente a otro árbol.
- **R9** — WHEN se configure una skill local para Pi, the system SHALL hacerla descubrible mediante las ubicaciones nativas sin duplicar su cuerpo ni alterar recursos del usuario.
- **R10** — WHEN un plugin habilitado requiera herramientas MCP en Pi, the system SHALL usar el transporte nativo y verificar el acceso efectivo por rol, incluyendo discovery y codemode, sin ampliar permisos ni sobreescribir configuración o credenciales del usuario. La habilitación MCP en hijos corresponde a E3, solo tras verificar grants directos e indirectos por rol y preservar precedencia, disablement y configuración del usuario.
- **R11** — WHEN se instalen, actualicen o retiren recursos Navori para Pi, the system SHALL preservar recursos ajenos o editados y aplicar el ownership, backup y prune compartidos sin cambiar outputs de otros engines.
- **R12** — WHEN audit capture una sesión Pi, the system SHALL correlacionar hilo principal, hijos y controles en el formato compartido con datos acotados y sin secretos, distinguiendo métricas no disponibles de valores cero.
- **R13** — WHEN Pi inicie, reanude o recargue una sesión Navori, the system SHALL cargar el contexto operativo pertinente sin duplicaciones ni mezclar sesiones, ramas o worktrees.
- **R14** — WHEN se verifiquen tres fallos consecutivos con la misma firma de un comando en una sesión y agente, the system SHALL emitir un aviso aditivo acotado sin sustituir el resultado ni bloquear la herramienta por una falla del aviso.
- **R15** — The system SHALL verificar un ciclo funcional Pi-only de instalación, planificación aprobada, implementación de código y documentación, revisión y receipt, seguido de actualización y desactivación, mediante un smoke reproducible sin credenciales de usuario ni recursos aportados por otro engine.
- **R16** — WHEN un proyecto nuevo configure únicamente el engine Pi, the system SHALL proporcionar instrucciones operativas y skills descubribles por Pi sin requerir archivos generados por Claude o Codex.
- **R17** — WHEN se despache un hijo sin modelo explícito de rol, the system SHALL transmitir la identidad exacta de proveedor y modelo activa en el padre, sin sustituirla por defaults del nuevo proceso; un override explícito SHALL prevalecer.
- **R18** — WHEN una tarea requiera código y documentación con `scribeOwnsMarkdown` habilitado, the system SHALL ofrecer una ruta soportada de producción de Markdown y revisión del diff combinado sin usar Bash como evasión ni requerir un rol no disponible.
- **R19** — WHEN el flujo JSONL acumulado de un hijo supere 256 KiB manteniendo cada registro dentro de su límite, the system SHALL procesarlo incrementalmente sin cancelar por volumen acumulado y devolver el último resultado completo con truncación explícita y límites de memoria.

## Límites de alcance

- Reutilizar renderer, CLI, planes, handoffs, receipts, audit y `.navori/state`; no mantener un workflow paralelo.
- Ampliar el adaptador de 0040, no reemplazarlo por un framework genérico de hooks.
- No implementar OAuth, transporte MCP, gestor de sesiones, compactor o sandbox nuevos.
- No prometer equivalencia de todos los scripts Claude. Cada control declara enforced/advisory/unsupported y su frontera real. Un mecanismo distinto es válido si satisface las pruebas del resultado; contar roles, hooks o archivos no es aceptación.
- Prioridad de parches: E1 resuelve G1/G2/G4/G5 y E2 resuelve G3; E3/E4 conservan el alcance posterior del borrador de primera clase, pero no son prerrequisito para entregar esos parches. E1 cierra con revisión independiente observada y receipts/gates existentes, verificados por humano/host; el enforcement Pi-native de evidencia de aceptación R7/R8 llega en E2. El bootstrap nunca permite afirmar éxito sin evidencia.
- E1 admite herramientas/skills core con MCP nativo apagado únicamente en hijos mediante `--no-mcp`; roles dependientes de MCP permanecen indisponibles hasta E3. No desactivar MCP personal del principal ni modificar credenciales; `localSkills` se integra en E3.
- No instalar extensiones comunitarias o recursos globales, ni migrar credenciales.
- No añadir dispatch anidado/background en esta spec; conservar límites del MVP salvo decisión posterior sustentada.
- Memoria persistente no se presupone nativa: evaluar el plugin existente y su acceso por MCP antes de agregar instrucciones always-on. No agregar avisos de compactación que dupliquen el comportamiento nativo sin evidencia de una brecha.
