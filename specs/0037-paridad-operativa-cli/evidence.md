# Paridad operativa CLI — Evidence

## Procedencia y límites

Auditoría histórica del 2026-09-28 sobre el checkout y Codex CLI 0.158.0 / Claude Code 2.1.283.
Su base fue `ea59ee5cc9a3dd0a6890752b121feeb8a5d9cccd`, inicialmente igual a `origin/main`.
Durante esa auditoría, `main` y `origin/main` locales avanzaron por actividad externa a
`131067295be01fa7b5410acea403b9702bae339c` (#1084); el fetch falló por DNS y la actualidad remota
quedó **unverified**. El checkout cambió concurrentemente: aquellos resultados no son receipt ni
comparación reproducible de base contra rama.

La nueva captura de implementación T1 usa HEAD `131067295be01fa7b5410acea403b9702bae339c`, que
incluye #1084. Véase [baseline.md](baseline.md) para procedencia, diferencias de binario, evidencia
aceptada y límites de esa captura. No reemplaza ni promueve a verificación runtime los hallazgos
históricos de la auditoría.

El informe original está en `.codex/progress/audit_deep_codex_claude_parity_20260928.md` (ignorado).
Este documento conserva los hallazgos necesarios para trabajar aunque ese scratch desaparezca.
Las rutas de código de las tablas son relativas al repo; el texto después de `—` es ancla estable.

## Lo que ya funciona y debe conservarse

| Superficie | Evidencia de la auditoría | Límite de la conclusión |
|---|---|---|
| Perfiles | 7 TOML Codex generados y válidos | No prueba selección efectiva del rol por el host |
| Skills | 24 skills compartidas en ambos árboles | Discovery/activación live pendiente |
| Core hooks | 12 registros y trust calculado como Trusted por doctor del build | No prueba que todos hayan disparado en una sesión |
| Render | Sin drift; checks de render/assets/budgets verdes | No implica inventario exacto de plugins |
| tgrep | Consulta real con `--no-index` | No se midió aceleración de servidor/índice |
| CodeGraph | `status` y `explore` reales; 523 archivos, 7608 nodos, 29541 aristas | Consulta CLI, no MCP de esta sesión; índice 1.5.0 / binario 1.6.0 |
| Contratos sintéticos | 960 tests / 69 archivos aprobados | No son smokes del host |
| Guard y reglas | Guards compartidos, traducción shell ask/deny y omisiones advertidas | No frontera de seguridad universal ni equivalencia con allow de Claude |

La suite completa observada tuvo 5393 pass, 14 fail, 1 skip y 4 errores no capturados; parte de los
fallos fue `EPERM` al escuchar en localhost y parte timeout. Sin base comparable, no se clasifican
como regresiones nuevas ni deuda preexistente. Semgrep encontró errores de CA y permisos de log;
no terminó un escaneo real. jscpd no se corrió como gate en esa auditoría. No hubo gate completo verde.

## Hallazgos trazables

| ID / prioridad | Hecho y propietario actual | Requisitos |
|---|---|---|
| A1 / alta | `packages/plugins/semgrep/plugin.json` y `packages/plugins/jscpd/plugin.json` — scripts/hooks apuntan al árbol Claude; `packages/cli/src/engines/codex/build-config-toml.ts` — `buildCodexConfigToml` consume hooks core y MCP, no ese contrato de scripts/hooks de plugins | R4–R6 |
| A2 / alta | `packages/cli/src/engines/codex/hook-registrations.ts` — `CODEX_HOOK_REGISTRATIONS`; `packages/cli/src/engines/shared/engine-capabilities.ts` — `ENGINE_CAPABILITIES`: plan-gate advisory/no registrado, mientras `packages/core/core-assets/managed/planificacion.md` promete deny | R13, R14, R21 |
| A3 / alta | `packages/cli/src/engines/codex/compat.ts` — `adaptHarnessTextForCodex` redirige el playbook a AGENTS; `packages/cli/src/engines/codex/index.ts` — `buildAgentsMdRequest` no incorpora su profundidad | R7, R23 |
| A4 / alta | `packages/cli/src/engines/codex/index.ts` — `buildAgentToml` no traduce frontmatter `tools`; los perfiles heredan herramientas MCP, no las listas de lectura de Claude | R11, R20 |
| A5 / alta | #1082 observó hijo `default` para etiqueta `implementer`; `packages/core/core-assets/hooks/implementer-no-markdown.sh` — condición `agent_type` depende del rol real | R8–R10 |
| M1 / media | Binario global y dist local anunciaban 0.10.1 pero tenían contenido/comandos distintos; `packages/cli/src/index.ts` — registro de subcomando `codex` sí existe en fuente | R1, R3 |
| M2 / media | `packages/cli/src/commands/doctor.ts` — `buildEngineInventory` agrega assets de plugins sin comprobar materialización por engine; `ENGINE_CAPABILITIES` contiene explicación desactualizada de handoff | R2, R3, R21 |
| M3 / media | `navori.config.json` — `models`/`effort` omiten architect; herencia válida, no agente roto. Tier mapping no certifica calidad; reviewer usa low | R12, R22 |
| M4 / media | `AGENTS.md` — `The mechanics` exige handoff antes de todo dispatch; `packages/cli/src/commands/handoff.ts` — `checkHandoff` necesita salida del implementer | R15 |
| M5 / media | `README.md` — promesa de paridad completa; `packages/plugins/engram/skills/engram-orchestrator.md` — ejemplo Codex sin startup hook confunde capacidades host e integración Engram | R19, R21 |
| Operación | tgrep sin servidor; CodeGraph índice/versiones; Semgrep CA/permisos; Engram `unknown_session`; app-server sin acceso a sqlite del home | R3, R16, R19 |
| No regresión / costo | Perfiles, skills, reglas, trust y presupuesto AGENTS; diferencias intencionales de eventos y controles | R17, R18, R20, R22, R23 |

## Dependencias y #1082

- Spec 0035 es el baseline de integración ya realizada. Revalidar su estado al empezar cada lote;
  sus checkboxes no sustituyen una prueba live ni se borran por los nuevos hallazgos.
- Spec 0036 es dueña de la raíz de estado engine-neutral; consumir sus helpers cuando corresponda.
  No crear un tercer almacén ni copiar su migración en esta spec.
- Evidencia #1082 disponible originalmente en el objeto git `39981e00`, archivo
  `docs/research/codex-plan-gate-1082.md`, encabezados `Result`, `Controls and limitation` y
  `Decision and upgrade criteria`. **Integrada por #1084 en `13106729`, el HEAD del baseline T1**;
  consultar `git show 13106729:docs/research/codex-plan-gate-1082.md`. Esta precisión no altera la
  procedencia de la auditoría anterior ni convierte el probe histórico en receipt.
- Ese probe observó `PreToolUse` con `collaborationspawn_agent`, `message` y `task_name`, sin rol
  tipado. No pudo leer el marcador sintético del mensaje; esto no demuestra cifrado. Deny general:
  cero hijos; allow: un hijo; etiqueta implementer: rol default. Son observaciones de esa ruta y
  versión, no afirmaciones universales sobre Codex.
- Al iniciar implementación, incorporar la base que ya contiene #1084 y conservar su procedencia
  durable antes de reutilizarla como evidencia de aceptación. No repetirlo solo para producir otro informe;
  repetir únicamente tras cambio
  relevante de host/ruta o para resolver una pregunta que el probe no respondió.

## Fuentes oficiales consultadas para la auditoría

Referencias consultadas el 2026-09-28. Son documentación viva; T1 verifica versiones y fecha al
reanudar implementación. Las observaciones locales anteriores no se atribuyen a estos proveedores.

| Fuente | Contrato utilizado |
|---|---|
| [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) | Perfiles TOML, configuración/instrucciones por rol y herencia |
| [Codex skills](https://learn.chatgpt.com/docs/build-skills) | Discovery `.agents/skills` y política de invocación |
| [Codex hooks](https://learn.chatgpt.com/docs/hooks) | Registro/trust, payloads y límites de cobertura; no garantiza la ruta específica de #1082 |
| [Codex config](https://learn.chatgpt.com/docs/config-file/config-basic) | Precedencia/cwd y configuración de proyecto |
| [Codex AGENTS](https://learn.chatgpt.com/docs/agent-configuration/agents-md) | Presupuesto de instrucciones compuesto |
| [Codex rules](https://learn.chatgpt.com/docs/agent-configuration/rules) | Prefijos y decisiones de comandos, no permisos Claude equivalentes |
| [Codex MCP CLI](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) | Servidores y filtros de herramientas |
| [Codex app-server](https://learn.chatgpt.com/docs/app-server) | Inspección de configuración/hooks/skills; no usar como sustituto silencioso del CLI evaluado |
| [Claude subagents](https://code.claude.com/docs/en/sub-agents) | Roles, herramientas y perfiles |
| [Claude skills](https://code.claude.com/docs/en/skills) | Semántica de skills de comparación |
| [Claude hooks](https://code.claude.com/docs/en/hooks) | Contratos de eventos/decisiones de comparación |
| [Microsoft tgrep](https://github.com/microsoft/tgrep) | Scan sin índice y frescura |
| [CodeGraph](https://github.com/colbymchenry/codegraph) | Interfaces CLI/MCP y estado del índice |
| [Semgrep CLI](https://docs.semgrep.dev/cli-reference) | Flags, baseline y clasificación de errores |

## Qué no constituye evidencia

## T5 — Gates de calidad por engine

El inventario de comandos implementado para las familias de hooks es acotado: Semgrep
reconoce `git commit`, `git push` y `gh pr create`; jscpd reconoce únicamente `git commit`.
La detección compartida acepta espacio inicial, wrappers simples (`(`, `\\`, `command`),
prefijos `VAR=value`, opciones globales de Git y comandos compuestos separados por `&&`, `||`,
`;`, `|` o nueva línea. No inspecciona dentro de `sh -c`, `eval` ni formas ofuscadas; es un
detector de disparadores, no una frontera de seguridad ni una prueba de cobertura live.

Los fixtures de T5 verifican que Codex renderiza sus propios scripts y registros de hooks,
que el render dual deja intactos los bytes del script Claude, que deshabilitar el plugin quita
las salidas Codex y que las formas de hook no traducibles se omiten con advertencia. También
comprueban que el preflight de trust es de solo lectura: una configuración de proyecto distinta
del render propuesto no coincide, y el render conserva contenido ajeno o de versión posterior.
Estos resultados son fixtures sintéticos; no se ejecutó campaña live ni se afirma equivalencia
operativa entre engines.

La verificación registrada por T5 fue `cd packages/cli && bun lint` (exit 0): 150 pruebas
dirigidas en siete suites, typecheck, formato y `check:render` pasaron. No se cambió trust global,
no se instaló ni publicó nada y no se ejecutó ningún gate live.

### Aclaración del contrato de errores encontrada al diseñar

`packages/plugins/semgrep/scripts/check-semgrep.sh` y
`packages/plugins/jscpd/scripts/check-jscpd.sh` — `PreToolUse EXIT CONTRACT` documentan una decisión
intencional de #510: findings → exit 2 (bloquea); errores distinguibles → exit 1 (reporta y permite).
jscpd además comparte exit 1 para clones y algunos crashes, por lo que el wrapper bloquea ambos.
No se puede prometer a la vez conservar esa conducta y bloquear todos los errores. R5 conserva
las decisiones actuales, mejora su fidelidad diagnóstica y no cuenta errores como scans aprobados.
Cambiar errores a fail-closed requeriría una decisión de política separada; no se oculta en el port
Codex. La terminación por timeout del host tampoco equivale a una decisión emitida por el script.

### Límites de las inferencias

Un `ok:true`, archivo presente, contador de perfiles, hook Trusted, alias sintético o checklist
completo no demuestra ejecución efectiva. Un bloqueo de sandbox en esta sesión no demuestra un
fallo en Warp. La versión de un modelo no mide calidad. El contenido de un scratch o una memoria
no sustituye fuente/versiones y un registro redactado reproducible para aceptar implementación.

## T7 — Retiro seguro y revisión de trust

Las pruebas dirigidas cubren la paridad de retiro Codex/Claude y las advertencias de hooks residuales
(A1: 5 archivos, 152 pruebas); trust, fallo de backup y TOML ajeno en un home falso aislado (A2:
2 archivos, 19 pruebas); y migración desde antes de T5, idempotencia y preservación al retirar en
Claude (A3: 2 archivos, 19 pruebas). `bun typecheck` y `bun lint` pasaron. Las pruebas respaldan la
preservación de archivos modificados y ajenos, la revisión de bytes de scripts y las señales del
doctor; no se modificó ningún home real de Codex ni se afirma paridad live de Codex. El quality gate
completo del repositorio pasó y la revisión fresca resultó APPROVED (commit `9c8cc3c5`). El
`test:coverage` del implementer registró 316 archivos de tests y 5,786 pruebas. La verificación de hash es opt-in (`verifyHash`) y solo se usa en las rutas
de scripts de plugin.

### Limitaciones residuales aceptadas por el reviewer

- `render --prune`, `health` y `doctor` no verifican hash: un bloque editado a mano ahí se sigue
  borrando, igual que en main.
- Un script sin hash guardado, o editado fuera del bloque, cuenta como propio.
- El orphan scan de plugins en execute-plan ahora conserva archivos con hash real no coincidente
  (más estricto que main).
- Observación menor, no bloqueante: los avisos "kept … file" en `engines/claude/index.ts` no usan i18n.

