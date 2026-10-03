# Paridad de garantías en Codex — Requirements

**Fecha:** 2026-10-02 · **Estado:** especificación; implementación no autorizada todavía.
**Base del checkout:** `origin/dev` (`6f5f4742`).
**Evidencia:** gap analysis del 2026-10-02 en `.navori/state/handoffs/scout_0041_{hooks,agents,context,codex_native,debt}.md`,
contrastado por el orquestador contra el repo (ver "Hallazgos verificados").
**Antecede:** Spec 0035 (paridad Codex, integrada en #1077), 0036 (estado neutral al engine),
0037 (paridad operativa CLI) y 0039 (Claude first).

## Context

La Spec 0039 fijó a Claude Code como engine de referencia. Codex recibe hoy el harness con huecos
que no son límites de Codex sino decisiones o deudas de navori: unidades que se marcan `unsupported`
o `advisory` sin probar que Codex no ofrezca el mecanismo, roles de solo lectura sin ninguna
contención, prosa que nombra herramientas exclusivas de Claude, y ningún test que impida que el
hueco crezca cuando se agrega una unidad nueva a Claude.

Esta spec no re-litiga Claude first. Define **paridad de garantías**: cada unidad que navori
distribuye da en Codex la misma garantía que en Claude —por el mismo mecanismo o por uno
equivalente nombrado—, o queda declarada como límite de Codex con fuente oficial verificable.
"Navori decidió no hacerlo" deja de ser un estado válido.

## Decisiones del usuario (2026-10-02)

- **D1** — Meta = paridad de garantías (arriba), impuesta por un test; Claude sigue siendo la
  referencia.
- **D2** — El sandbox global de Codex se mantiene en `danger-full-access`. La contención de los
  roles de solo lectura la da un hook por `agent_type`, no el sandbox.
- **D3** — `master-plan` y `context-intake` (#1088) entran al alcance en Codex, adaptados a sus
  primitivas.

## Hallazgos verificados (base de los requisitos)

| # | Hallazgo | Evidencia |
|---|---|---|
| H1 | Los roles de solo lectura pueden editar cualquier archivo en Codex | `.codex/config.toml` bloque `codex-config-base` con `sandbox_mode = "danger-full-access"`; ningún `.codex/agents/*.toml` declara `sandbox_mode`; `apply_patch` sin guard por rol |
| H2 | 5 hooks registrados en Claude no se registran en Codex, pero sus scripts se copian a `.codex/hooks/` | `plan-gate`, `pr-publisher-confirm`, `general-purpose-confirm`, `bash-outcome-watch`, `subagent-no-background` — `CODEX_HOOK_REGISTRATIONS` en `engines/codex/hook-registrations.ts` |
| H3 | El payload Codex de `PreToolUse(spawn_agent)` ya trae `tool_input.agent_type` | `nv_subagent_type` en `.codex/hooks/implementer-no-markdown.sh` |
| H4 | `AGENTS.md` nombra `SendMessage`, `TaskCreate` y "Claude Code 2.1.287" | bloques `orquestacion` y `sdd` renderizados en `AGENTS.md` |
| H5 | `architect.toml` no declara `model` | `.codex/agents/architect.toml` |
| H6 | navori declara Codex ≥0.145; el instalado es 0.160.0; hay eventos sin evaluar (`PreCompact`, `PostCompact`, `PermissionRequest`, `SubagentStart`) | comentarios de versión en `engines/codex/index.ts`; `codex --version`. Fuente oficial **sin verificar** |
| H7 | `navori codex trust` resuelve el config global con `HOME`, no con `CODEX_HOME` | `defaultCodexHomeConfigPath` en `lib/codex/trust.ts` |
| H8 | `master-plan`, `context-intake` y sus hooks se omiten en Codex | filas de skills y hooks en `engines/shared/native-overlap.ts`; #1088 |
| H9 | `.codex/agents/{implementer,reviewer,scribe}.toml` salen con marcadores `navori:if` sin resolver: el implementer Codex recibe a la vez la instrucción de reporte `md` y la `json` | `buildAgentToml` no llama `conditionOrchestration` (hallado por el architect, confirmado) |
| H10 | La superficie `engine-scripts` sigue declarada no soportada en Codex aunque `.codex/scripts/` se renderiza y registra | `unsupportedSurfaces` del engine Codex (hallado por el architect) |
| H11 | `.codex/scripts/guard-search-routing.sh` se copia y nada lo invoca; la extensión `tgrep` depende de `CLAUDE_PROJECT_DIR` y `.claude/scripts` | `.codex/config.toml` sin referencia; challenge 0041 A8 |

## Requirements (EARS)

### A — Contrato de paridad

- **R1** — The system SHALL asignar a cada unidad distribuida por el engine Claude (hook, agente,
  skill, bloque managed, regla de permiso, script de plugin, flujo de la matriz) exactamente un
  estado de paridad Codex: `igual` (misma garantía, mismo mecanismo), `equivalente` (misma
  garantía, mecanismo distinto nombrado en la fila) o `limite-codex` (Codex no ofrece la
  capacidad).
- **R2** — IF una fila tiene estado `limite-codex` sin URL de documentación o source oficial de
  Codex, versión de Codex y fecha de verificación THEN the parity check SHALL fallar nombrando la
  fila.
- **R3** — IF una unidad del inventario Claude no tiene fila de paridad Codex THEN the test suite
  SHALL fallar nombrando la unidad.
- **R4** — The system SHALL declarar una versión mínima de Codex igual a la más alta en la que se
  verificó una fila `igual` o `equivalente`, y WHEN la versión instalada es menor, `navori doctor`
  SHALL advertirlo con ambas versiones.
- **R5** — The system SHALL generar `docs/native-overlap.md` con la columna de paridad Codex, su
  mecanismo y su fuente, sin edición manual.

### B — Roles de solo lectura

- **R6** — WHEN un subagente Codex cuyo rol no es `implementer` ni `scribe` intenta modificar con
  `apply_patch` un archivo fuera de las rutas de artefacto que su rol declara (ruta normalizada,
  sin `..` ni symlinks que salgan del repo), the system SHALL denegar la llamada con un mensaje que
  nombre el rol y la ruta. Las escrituras por `Bash` quedan con la misma contención que en Claude
  (ninguna por ruta) y así se registran en la matriz.
- **R7** — The system SHALL derivar las rutas de artefacto permitidas por rol de una sola fuente
  compartida por los engines (p. ej. `.navori/state/handoffs/` para todos, `specs/<feature>/` para
  `architect` en nivel 3), no de una lista escrita en el script.
- **R8** — WHEN el payload no trae `agent_type` (hilo principal), the guard de R6 SHALL permitir la
  llamada.

### C — Hooks sin registrar en Codex

- **R9** — WHEN el orquestador despacha `implementer` por `spawn_agent` sin workplan aprobado y
  verde, the system SHALL impedir que el subagente arranque; WHEN el workplan está aprobado y
  verde, SHALL permitirlo (#1082). Ambos casos se prueban con un smoke real, para cada forma de
  payload de spawn que Codex 0.160.0 emita (multi-agent V1 y V2); una forma que no exponga el rol
  del hijo SHALL denegar el spawn en lugar de permitirlo.
- **R10** — WHEN un comando de publicación (`gh pr create`, `git push`) o un despacho del rol
  `general-purpose` requiere confirmación del usuario en Claude, the system SHALL obtener en Codex
  una confirmación explícita del usuario antes de ejecutarlo, por una regla `prompt` de
  `.codex/rules` o por deny-como-confirmación (el patrón de `comment-draft-confirm`), según lo que
  la verificación de R22 demuestre efectivo. The system SHALL NOT registrar un handler que apruebe
  solicitudes de permiso en nombre del usuario.
- **R11** — WHEN un comando `Bash` falla repetidamente en Codex, the system SHALL emitir el mismo
  aviso que `bash-outcome-watch` emite en Claude, usando el resultado que Codex exponga en
  `PostToolUse`.
- **R12** — WHEN un subagente Codex intenta lanzar trabajo en segundo plano que no se vuelve a
  esperar, the system SHALL dar la misma garantía que `subagent-no-background` da en Claude.
- **R13** — The Codex engine SHALL NOT copiar a `.codex/hooks/` un script que no registra ni
  incluye otro script registrado. WHEN `render --apply` retira uno ya instalado, SHALL usar el
  backup y la verificación de hash del prune existente; un script editado por el usuario SHALL
  conservarse y reportarse.

### D — Permisos

- **R14** — WHEN una regla `ask` o `deny` de Claude aplica a una herramienta distinta de `Bash`,
  the Codex engine SHALL traducirla a un mecanismo Codex con la misma garantía o registrarla como
  `limite-codex` según R1–R2; nunca SHALL descartarla en silencio.
- **R26** — WHEN la traducción de un patrón `ask` o `deny` a `prefix_rule` lo estrecha (cubre
  menos comandos que en Claude), the system SHALL registrar ese patrón como fila propia:
  `equivalente` si un hook registrado en Codex cubre el resto con test, `limite-codex` si no.
- **R15** — The Codex engine SHALL NOT traducir una regla `allow` a `prefix_rule` `allow` (que
  ejecuta fuera del sandbox), y SHALL registrar esa asimetría como fila de la matriz.

### E — Agentes

- **R16** — The Codex engine SHALL emitir `model` y `model_reasoning_effort` en cada
  `.codex/agents/*.toml` cuyo agente Claude declare un modelo.
- **R17** — WHEN un agente Claude declara despacho anidado (`Agent(scout, scribe)`), the Codex
  render SHALL mantener la profundidad de agentes en 1 e instruir la secuencia del orquestador
  (`scout` antes, `scribe` después), registrada como `equivalente`. The system SHALL NOT subir
  `agents.max_depth`: a profundidad 2 todo subagente recibe `spawn_agent` y un hijo sin rol
  escapa de los guards (challenge 0041 C2).
- **R31** — WHEN un subagente Codex llama a la herramienta de spawn (bajo multi-agent V2 los
  subagentes la reciben aunque `max_depth` sea 1), the system SHALL denegar la llamada nombrando
  el rol que llama.

### F — Contexto y prosa

- **R18** — The system SHALL NOT renderizar en `AGENTS.md`, `.codex/` ni `.agents/skills/` nombres
  de herramientas o versiones exclusivas de Claude Code (`SendMessage`, `TaskCreate`,
  `ToolSearch`, `Skill`, `AskUserQuestion`, "Claude Code <versión>"); cada mención se traduce a
  su equivalente Codex o se omite del render Codex.
- **R19** — IF una herramienta exclusiva de Claude aparece en el render Codex THEN the render test
  SHALL fallar nombrando el archivo y el bloque managed.

### G — master-plan en Codex

- **R20** — WHEN el usuario inicia o reanuda un master plan en Codex, the system SHALL ofrecer las
  skills `master-plan` y `context-intake` con sus confirmaciones de usuario y sus etapas, usando
  primitivas Codex en lugar de `AskUserQuestion` y del contexto inyectado por `SessionStart` de
  Claude.
- **R21** — WHEN un master plan está activo en Codex, the system SHALL inyectar su contexto al
  arrancar y pedir confirmación antes de aceptar una parte, con las mismas garantías que
  `master-plan-context` y `master-accept-confirm` dan en Claude.

### H — CLI y verificación

- **R22** — The system SHALL mantener en `docs/research/` una verificación de Codex fechada, con
  versión, URL oficial y resultado de sonda por capacidad usada en las filas `equivalente` y
  `limite-codex`; un blog o un resumen de terceros no cuenta como fuente.
- **R23** — WHEN `CODEX_HOME` está definido, `navori codex trust` y `navori doctor` SHALL leer y
  escribir `$CODEX_HOME/config.toml` en lugar de `~/.codex/config.toml`.
- **R27** — WHEN un hook registrado en `.codex/config.toml` no está Trusted para la ruta del
  config que Codex carga (incluido un worktree), `navori doctor` SHALL advertirlo nombrando el
  hook y el comando `navori codex trust` que lo resuelve.
- **R24** — WHEN existen transcripts de sesiones Codex del repo, `navori audit` SHALL incluirlos
  con el engine identificado, o registrar la auditoría Codex como `limite-codex` según R2.
- **R25** — The system SHALL ejecutar, con autorización del usuario, un smoke real en Codex por
  cada fila `igual` o `equivalente` que bloquea o pide confirmación, y registrar su resultado en la
  verificación de R22.

### I — Defectos actuales del render Codex

- **R28** — The Codex engine SHALL resolver los marcadores condicionales (`navori:if`) de cada
  agente antes de emitir `.codex/agents/*.toml`, y IF un `.toml` renderizado contiene un marcador
  sin resolver THEN the render test SHALL fallar nombrando el agente.
- **R29** — WHEN el plugin `tgrep` está habilitado, the Codex engine SHALL registrar su guard de
  ruteo de búsqueda con rutas neutrales al engine, de modo que en Codex bloquee la misma búsqueda
  recursiva por shell que bloquea en Claude.
- **R30** — The Codex engine SHALL declarar como no soportadas solo superficies que no renderiza;
  IF una superficie declarada no soportada tiene archivos renderizados THEN the test suite SHALL
  fallar.

## NOT in scope

- Cambiar el sandbox global de Codex (D2).
- Registrar `role-guard` en Claude: allí los roles de solo lectura tampoco tienen contención por
  ruta; queda como seguimiento para no mover el render Claude en esta spec.
- Subir `agents.max_depth` o fijar la versión multi-agent de Codex (R17, challenge 0041 C1/C2).
- Revertir Claude first o cambiar `docs/DIRECTION.md` salvo para nombrar la paridad de garantías.
- Paridad con engines distintos de Codex (Pi, Cursor, Copilot, AGENTS.md universal).
