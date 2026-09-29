# T9 live probe — resultado inconcluso

Fecha de congelamiento: `2026-09-28T21:32:03Z` (UTC). La campaña fue autorizada únicamente para T9/L03-L04, usando autenticación existente con configuración aislada, fixture desechable y MCP stub local. No se modificó trust/configuración global, no se instalaron componentes ni se publicó nada.

## Identidad congelada

| Componente | Identidad |
|---|---|
| Host | `/opt/homebrew/bin/codex`, `codex-cli 0.158.0`, SHA-256 `788a818fbb9596869c7a487554507cb8bdca17584b8671112b23f9e225ba35c8` |
| Navori | `/opt/homebrew/bin/navori`, `0.10.1`, SHA-256 `61dc37b2c8c2f1ea8d6bb5226e09f0fa2da066b8ac12b9ddbc513b805fed9e8a`; no usado por el fixture |
| Checkout | `cc10ab3889e27f7f356b6eab98c02b432a2a1dd4`; configuración SHA-256 `5a24e72f1316e8b336a72dc7ad346c3d8e18af581a83b26c698297a6e867ffd3`; cero cambios de source por T9 |
| Fixture | `/tmp/navori-spec0037-t9.FkPZdk`, repositorio Git desechable; stub SHA-256 `3be29726189f664a12ee29f2271ff3e2ae7d9faa7a5c29a306a16bd5d1ef526c`; configuración de rol SHA-256 `a6a84e7cc67c4e35667febd059cf20d5e716b2012d0de848cd1572c0e851ebf0`; efecto del stub: contador sintético en memoria |

Invocaciones: `codex exec --json --ephemeral --ignore-user-config -C <fixture>` con opciones `-c` solo para la invocación; no se solicitaron bypasses explícitos de sandbox/aprobación. No se leyó ni copió configuración personal o material de autenticación. No se conserva salida JSONL cruda, transcript, identificadores de cuenta ni credenciales.

## Observaciones por caso

| Caso | Esperado | Observado | Exit/status |
|---|---|---|---|
| Smoke | `T9_READY`, sin herramienta | `thread.started`, `turn.started`, mensaje exacto `T9_READY`, `turn.completed` | `0`, observado |
| L03 selección de rol | Un hijo `t9_probe` y challenge `ROLE_T9_PROBE_7C` | Sin evento de hijo ni challenge; stderr reportó `collab spawn failed: Fatal error: failed to load model context ... invalid thread-store request: no rollout found for thread id`. El proceso padre terminó con exit `0`. Perfil y modelo/effort efectivos no observados. | `0`, bloqueado por infraestructura |
| L03 filtro MCP | Marcador de lectura presente y escritura denegada por `disabled_tools` | Se observó un item `mcp_tool_call` iniciado/completado; la respuesta final no incluyó el marcador de lectura. No hubo evidencia utilizable de lista de herramientas ni de filtros efectivos. Invocaciones de escritura no observadas. | `0`, no verificado |
| L04 eventos de hooks | Correlación de eventos pre/post/start/stop y decisiones | No se observaron callbacks `PreToolUse`, `PostToolUse`, `SubagentStart` ni `SubagentStop`. Eventos thread/turn/item no los sustituyen. | No ejecutado |

## Límites y conclusión

La campaña no certifica selección de perfiles, modelo/effort, composición o monotonicidad de filtros MCP, ni eventos/decisiones de hooks. Tampoco cubrió perfil negativo con hijo default, allowlist más estrecha del padre/usuario, servidor deshabilitado u otros perfiles habilitados. El error de spawn con exit `0` no se reintentó con modo no efímero ni permisos más amplios; no se llamó a herramientas de escritura ni se ampliaron permisos.

**Resultado T9 L03/L04: inconcluso, no pass.** La evidencia no permite afirmar garantía de selección de perfil, filtros MCP o routing/guard de hooks. Las pruebas live siguen siendo evidencia manual y no son dependencias implícitas de CI.

## Corrida 2 (sin `--ephemeral`)

Requisitos: R8, R9, R10, R11 (V08–V11, L03, L04). Fecha de congelamiento: `2026-09-29T15:49:21Z`
(UTC); 8 invocaciones de `codex exec` entre `15:50Z` y `15:59Z`. Campaña autorizada solo para
T9/L03-L04, con la autenticación Codex existente, `--ignore-user-config`, sin `--ephemeral`, fixture
desechable, MCP stub local y hooks stub propios del fixture. Los rollouts de sesión se escribieron en
el home de Codex (autorizado). No se conserva JSONL crudo, transcript, prompt ni dato de cuenta.

### Incidente: trust persistido

Durante la invocación 8, el CLI de Codex persistió `trust_level = "trusted"` para la ruta del
fixture desechable en la configuración global de Codex del usuario, pese a que la campaña prohibía
persistir trust. El fixture fue borrado después por el usuario; la limpieza de esa entrada global
está pendiente por parte del usuario. Los resultados de la invocación 8 pudieron ejecutarse bajo
trust de proyecto persistido.

### Identidad congelada

| Componente | Identidad |
|---|---|
| Host | `codex-cli 0.158.0`, SHA-256 `788a818fbb9596869c7a487554507cb8bdca17584b8671112b23f9e225ba35c8` (igual que la corrida 1) |
| Navori | `0.10.1`, SHA-256 `61dc37b2c8c2f1ea8d6bb5226e09f0fa2da066b8ac12b9ddbc513b805fed9e8a`; no invocado por el fixture |
| Checkout | `cdade8cea126d9ce18fc35c619ecd06fddb3a778`; configuración SHA-256 `5a24e72f1316e8b336a72dc7ad346c3d8e18af581a83b26c698297a6e867ffd3`; cero ediciones del repo |
| Fixture | repositorio Git desechable con nonce sintético; MCP stub SHA-256 `a9ab7a89d2d4372b82faec7bca15370e0de77447e58d86f5b400ceff94c01775`; hook stub SHA-256 `1c71e11cd6d2635bcbb07207590baf9c9b1d8746581494c8e3a22bb716799851` (deniega solo si `agent_type == "implementer"` y la entrada escribe `.md`) |
| Roster real | Copia byte a byte de los `.codex/agents/*.toml` renderizados (architect, auditor, implementer, publisher, reviewer, scout, scribe), sin orchestrator |

Modelo/effort efectivos leídos de `turn_context` del rollout propio de cada hijo (metadata del host),
no de la autodeclaración.

### Observaciones por caso

| # | Caso | Esperado | Observado | Exit | Clasificación |
|---|---|---|---|---|---|
| 1 | Smoke | `T9_READY` sin herramientas | `T9_READY`; gpt-6-sol/medium | `0` | observado |
| 2 | L03 hipótesis `--ephemeral` | Spawn de hijo funciona sin `--ephemeral` | Hijo `t9_probe` creado; sin error `no rollout found` | `0` | observado, hipótesis confirmada |
| 2 | L03 selección `t9_probe` | Challenge del rol; modelo/effort del rol | Challenge exacto; hijo gpt-6-luna/low (padre gpt-6-sol/medium) | `0` | observado |
| 2 | L03 negativo hijo default | `task_name "implementer"` sin `agent_type` no aplica el rol | Sin rol (`NONE`); hereda modelo/effort del padre | `0` | observado |
| 7 | L03 roster real (7 roles) | Cada rol con sus instrucciones y modelo/effort renderizados | Roles 7/7 por metadata (`agent_role`, modelo/effort coinciden con los TOML). Challenge 6/7: el reviewer respondió `# Tools` aunque su rollout contiene `# Reviewer Agent` | `0` | observado (reviewer certificado solo por metadata) |
| 3 | L03 MCP, rol con `mcp_servers` parcial (sin `command`) | Cero ampliaciones | El host descarta el rol completo (`invalid transport`, `unknown agent_type`); el hijo default sustituto heredó el filtro del padre | `0` | observado (rol parcial no representable) |
| 4 | L03 MCP, rol amplio vs `disabled_tools`, allowlist `enabled_tools` y servidor deshabilitado del padre | Cero ampliaciones | Rol aplicado; `write_note` UNAVAILABLE, servidor deshabilitado nunca arrancó; stub sin llamadas de escritura | `0` | observado, cero ampliaciones |
| 8 | L03 MCP, rol que estrecha (`enabled_tools=["read_note"]`) y añade servidor | Estrechamiento aplicado | Rol aplicado, pero el hijo siguió viendo `write_note` y la llamada llegó al stub; el servidor añadido no arrancó. `mcp_servers` del rol ignorado en ambas direcciones | `0` | observado (posible trust persistido, ver incidente) |
| 5 | L03 restricción en capa proyecto | Capa proyecto cargada y compuesta con rol | Capa no cargada; requiere trust persistido (prohibido) | `0` | bloqueado |
| — | L03 restricción en capa usuario | Cero ampliaciones | Requiere editar la config global o un `CODEX_HOME` aislado sin auth | — | no ejecutado |
| 6 | L04 `PreToolUse` | Pre por llamada con tool, call id, rol | Observado en padre (spawn/wait) e hijos (`Bash`, `apply_patch`); hijos con `agent_type` y `agent_id` top-level; el spawn trae `tool_input.agent_type` solo si el padre lo pasó | `0` | observado |
| 6 | L04 `PostToolUse` | Post separado de Pre | Post observado en llamadas permitidas; el `apply_patch` denegado tuvo Pre y ningún Post | `0` | observado (Pre distinto de Post) |
| 6 | L04 `SubagentStart`/`SubagentStop` | Eventos por hijo con rol | Start y Stop por hijo con `agent_type` (`implementer`, `scribe`, `default`) y `agent_id`; sin tool/call id | `0` | observado |
| 6 | L04 Markdown implementer | Deny | Pre `apply_patch` sobre `.md` con `agent_type=implementer` denegado (exit 2, sin Post); archivo no creado | `0` | observado |
| 6 | L04 Markdown scribe | Allow | Pre/Post allow; archivo creado | `0` | observado |
| 6 | L04 lectura positiva | Allow | `Bash` de lectura del implementer permitido con Pre/Post | `0` | observado |
| 6 | L04 default no normalizado | Hijo sin rol distinto de implementer | Hijo con `task_name "implementer"` sin `agent_type` llega como `agent_type="default"` y su `.md` se permite; `agent_type` no registrado se rechaza sin hijo | `0` | observado |

### Límites

- Roles registrados solo por `-c agents.<rol>.config_file` (capa de sesión); no se probó el
  descubrimiento de `.codex/agents/*.toml` del proyecto.
- La composición MCP se probó solo contra restricciones del padre en capa de sesión. Proyecto
  (bloqueada) y usuario (no ejecutada) quedan sin verificar.
- "Cero ampliaciones" no demuestra composición monotónica: el bloque `mcp_servers` del rol no tuvo
  efecto observable, y un bloque parcial invalida el rol completo.
- El challenge del reviewer no coincidió; su certificación descansa en metadata.
- Hooks registrados vía `-c hooks.*` con bypass de trust por invocación; la ruta con trust
  revisado y los scripts reales de navori no se ejecutaron.
- La invocación 8 pudo correr bajo trust persistido (incidente arriba).

### Conclusión

**L03: observado** para selección de rol (roster real 7/7 por metadata), modelo/effort efectivos,
negativo default y cero ampliaciones frente a restricciones del padre en capa de sesión;
**bloqueado/no ejecutado** para capas proyecto/usuario. **L04: observado** para los cuatro eventos
por separado, deny del implementer, allow de scribe y lectura, y default no normalizado. **Hipótesis
`--ephemeral`: confirmada.** Es un registro de viabilidad por ruta/versión, no un pass global.
