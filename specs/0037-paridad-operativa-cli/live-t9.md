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
