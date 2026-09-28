# Paridad operativa CLI — Validation contract

Este archivo especifica pruebas futuras; **no registra ejecuciones aprobadas**. Los resultados
históricos y sus límites están en [evidence.md](evidence.md). IDs V estables permiten conectar
requisitos, diseño, tareas y evidencia sin depender de números de línea.

## Niveles de evidencia

1. **Unit/contract:** serialización, registro y decisiones de scripts sobre fixtures.
2. **Integration:** render/lifecycle sobre repos temporales Claude-only, Codex-only y dual.
3. **Live CLI:** el host invoca la herramienta/control dentro de una sesión real y aislada.
4. **Comparación de comportamiento:** tareas emparejadas evaluadas con la misma rúbrica.

Ningún nivel implica automáticamente el siguiente. `pass`, `fail`, `blocked`, `not-run` y
`not-supported` son resultados diferentes. No hay porcentaje agregado que borre estas diferencias.

## Catálogo de pruebas

Rutas relativas a `packages/cli/src/`. Casos y archivos nuevos indicados como **nuevo** se crean
en sus tareas, no en esta sesión. Cada caso automatizado incluye `// Covers: Rn` con sus IDs reales;
cada registro live incluye el campo `requirements`. Se amplía la suite existente antes de duplicarla.

| ID | Requisitos | Caso, ubicación y criterio |
|---|---|---|
| V01 | R1 | `commands/__tests__/codex-doctor.test.ts` — dos binarios con la misma versión y contenido distinto producen procedencias distintas; ruta con espacios, symlink e información inaccesible no se confunden |
| V02 | R2 | `commands/__tests__/codex-doctor.test.ts` — plugin declarado pero no materializado; script presente sin registro; registro sin trust; trust sin ejecución: ninguna transición implícita, incluye workspace monorepo |
| V03 | R3 | `commands/__tests__/codex-doctor.test.ts` — CA, permisos de log/sqlite, herramienta ausente, timeout y red inaccesible dan causa y estado no verificado, no pass |
| V04 | R4 | `engines/codex/__tests__/plugin-gates.test.ts` (**nuevo**) — render Semgrep/jscpd Codex-only sin `.claude`, dual y plugins deshabilitados; comandos resuelven sus assets y no se duplican registros |
| V05 | R5 | `lib/__tests__/plugin-gate-hooks.test.ts` — por scanner/operación: exit, stderr, terminal de auditoría y sentinel concuerdan; verde permite, findings bloquean, error distinguible no bloquea pero dice no validado; jscpd exit1 ambiguo bloquea sin afirmar clones. Cleanup conserva exit original; ausencia omisión advertida; señal/timeout externo inconcluso, no deny supuesto. Complementar con L05 |
| V06 | R6 | `lib/__tests__/plugin-gate-hooks.test.ts` — parejas Claude/Codex conservan base divergente, staged/unstaged/untracked, includes, invalidación por contenido/base y worktree; cache roja/error nunca se reutiliza como verde |
| V07 | R7 | `engines/codex/__tests__/render-codex.test.ts` y `lib/__tests__/skills-assets.test.ts` — referencia resuelve secciones de delegación frugal, ejecución continua/caps, anti-broken-telephone, artefactos y cierre; ningún despacho de orchestrator ni copia completa always-on |
| V08 | R8 | L03 — cada rol real del roster aparece aplicado con instrucciones distintivas y configuración efectiva; dato no observable impide certificar ese eje, no se sustituye por la etiqueta de tarea |
| V09 | R9 | L03 negativo + `engines/__tests__/control-inventory.test.ts` — hijo default o rol desconocido no certifica markdown-ownership ni paridad de perfil; fallback queda explícitamente limitado |
| V10 | R10 | `lib/__tests__/codex-hook-payloads.test.ts` — fixtures redactados por evento/versión observada; desconocido se conserva; correlación con L04 para cada evento, no alias especulativo |
| V11 | R11 | `engines/codex/__tests__/role-mcp-policy.test.ts` (**nuevo**) — `tools` ausente conserva herencia; allowlist explícita sin grant no hereda servidor; wildcard explícito conserva alcance. L03 verifica lectura sí/escritura no/informe sí y perfil amplio contra padre/usuario restrictivo, `disabled_tools`, servidor deshabilitado: ningún permiso excluido reaparece. Si no puede preservarse, no habilitar traducción para ese caso ni certificarla |
| V12 | R12 | `lib/assets/__tests__/model-profile.test.ts` y `engines/codex/__tests__/render-codex.test.ts` — explícito/mapeado/heredado, overrides y ausencia de imposición de modelo raíz por el perfil orchestrator; L09 sustenta decisión architect/reviewer |
| V13 | R13 | `engines/__tests__/control-inventory.test.ts` y `lib/__tests__/hook-claims-vs-scripts.test.ts` — plan-gate Codex advisory, sin registro selectivo falso y prosa coherente; Claude conserva su control |
| V14 | R14 | L06 — reapertura solo con evidencia selectiva de host; deny general y marcador ilegible no satisfacen aceptación. Sin cambio relevante, revisar registro #1082 y documentar no soportado sin repetir consumo |
| V15 | R15 | `lib/__tests__/handoff-wiring.test.ts` y `lib/handoff/__tests__/check.test.ts` — primer architect/scout/auditor/productor no exige impl; consumidor rechaza JSON ausente/inválido y acepta válido; plan requerido se verifica separadamente |
| V16 | R16 | L02 — tgrep descubre cambio sintético reciente con scan sin índice; CodeGraph encuentra relación conocida, reporta estado/versiones y distingue respuesta CLI de MCP; no servidor ni índice creado por el diagnóstico |
| V17 | R17 | `lib/assets/__tests__/skill-trigger.test.ts`, `engines/codex/__tests__/local-skills.test.ts` + L07 — explícita positiva; activación permitida positiva; invocación implícita prohibida negativa; catálogo/source conservados |
| V18 | R18 | Suites existentes `engine-parity`, `codex-rules`, `codex-trust`, `codex-hook-payloads`, `lifecycle-hooks`, `session-start-hook`, `handoff-contract` y L01/L04/L08: todos los contratos vigentes permanecen; conteos 7/24/12 son baseline, no constantes de producto |
| V19 | R19 | L08 — lectura positiva separada de escritura con identidad runtime; ausencia/invalidación retorna no verificado y cero intentos de fabricar identidad; producción nunca es destino de la escritura de prueba |
| V20 | R20 | `engines/claude/__tests__/plugin-scripts-managed.test.ts`, `commands/__tests__/plugin-lifecycle.test.ts`, `commands/__tests__/codex-trust.test.ts` — upgrade desde release/base guardada, segunda render idempotente, retiro de plugin/engine seguro, user sections y hooks ajenos intactos; nuevo hash pide revisión, no aprobación automática |
| V21 | R21 | `lib/__tests__/hook-claims-vs-scripts.test.ts` + revisión de matriz documental — cada estado publicado se reconcilia con V02/L01; diferencias intencionales y fortalezas visibles; sin promesa absoluta |
| V22 | R22 | L09 — misma base/tarea/rúbrica en ambos hosts, resultados individuales incluidos; calidad, fallos duros, tiempo y costo disponible separados; registro incompleto jamás es victoria |
| V23 | R23 | `lib/__tests__/skill-caps-composed.test.ts`, `engines/codex/__tests__/render-codex.test.ts`, `bun run check:doc-budgets` — bytes antes/después, presupuesto compuesto con instrucciones de usuario/padre/nested, playbook no duplicado; p50/p95 solo con muestra registrada |

## Protocolo live seguro

No se ejecuta por redactar esta spec. Cada campaña requiere autorización del usuario sobre consumo
y efectos locales. Fijar SHA, binarios efectivos, modelos, effort, configuración, trust y scripts;
no correr sobre un checkout que otra sesión está cambiando. No usar modelos equivalentes por nombre
como sustituto de registrar IDs reales. Para aislar diferencias del harness, mantener modelo fijo
dentro de cada host al comparar baseline/cambio; el contraste entre proveedores es descriptivo.

Usar repos/fixtures descartables y homes aislados con trust revisado explícitamente, sin copiar
secretos ni sobrescribir configuración personal. Nunca desactivar permisos, TLS ni revisión de
hooks para conseguir verde. Un deny de la infraestructura se registra y detiene esa prueba.
Sin push, PR, commit o memoria real: interceptores locales inocuos simulan efectos y cuentan
sentinels; invocaciones live usan el comando exacto registrado en la cobertura y el fake binario.
La ausencia de sentinel demuestra bloqueo de esa llamada, no de todos los caminos de publicación.

| ID | Escenario | Positivo / negativo y evidencia mínima |
|---|---|---|
| L01 | Arranque Codex/Claude desde el repo en Warp | Config efectiva, skills/hooks/MCP visibles y contexto de inicio; contraste desde cwd padre, proyecto sin trust y hook modificado. Sin inferir runtime de `doctor` solamente |
| L02 | tgrep + CodeGraph | Búsqueda textual y relación estructural conocida; servidor ausente/índice obsoleto/MCP no expuesto deben producir diagnóstico distinto, nunca reparación automática |
| L03 | Roles, modelo, effort y MCP | Todos los roles habilitados excepto orchestrator; challenge distintivo. Negativo etiqueta implementer con hijo default; MCP stub, filtros de padre/usuario más estrechos que perfil, disabled_tools y servidor deshabilitado: cero ampliaciones. Modelo/effort desde metadata/config efectiva, no autodeclaración. Este probe de composición de filtros precede a habilitar la traducción de grants |
| L04 | Hooks y routing | Correlacionar ID de llamada, evento, nombre de herramienta, rol y decisión para pre/post/start/stop por separado; Markdown prohibido al implementer real y permitido al scribe, positivos de lectura; desconocido no se normaliza a implementer |
| L05 | Scanners y operación protegida | Semgrep/jscpd fixtures rojo/verde/error/timeout/ausente; `git commit`, `git push`, `gh pr create` y demás entradas que el inventario de cobertura determine, siempre interceptadas sin efectos externos. Findings bloquean; errores distinguibles conservan fail-open vigente sin escaneo aprobado; exit1 ambiguo de jscpd bloquea con causa incierta; timeout host queda inconcluso hasta medir decisión. Solo se declara cubierta la ruta observada |
| L06 | Plan-gate condicional | Solo si cambió versión/ruta/contrato: implementer inválido → cero hijos; válido → un hijo; colaboración no implementer → un hijo. Entrada y rol verificables antes del spawn; de lo contrario permanece advisory |
| L07 | Skills | Skill de referencia explícita, skill de comportamiento con trigger, skill con implicit invocation deshabilitada; instrucciones cumplidas sin activación indebida en control negativo |
| L08 | Handoff, ciclo y memoria | Handoff inválido rechazado/válido aceptado; cleanup/reclaim conforme al evento propio del host; Engram con proveedor/identidad de prueba oficialmente soportados. Si no hay aislamiento seguro para escritura, blocked; no escribir en memoria personal |
| L09 | Calidad/costo comparados | Misma base y 3 repeticiones por host/caso: búsqueda, skill, diseño architect, implementación→review, negativo scanner, handoff inválido. Misma rúbrica de exactitud, cobertura de riesgos y pasos omitidos; incluir orden, duración, tokens/costo solo si el proveedor los expone |

## Registro y aceptación

Guardar evidencia duradera redactada en documentación del lote: fecha UTC, SHA, ruta/build/versión
del host, configuración efectiva no secreta, escenario, requisito, comando/protocolo, exit/status,
resultado esperado/observado, IDs de correlación sintéticos y causa de limitación. No persistir raw
prompts, credenciales, tokens de auth ni dumps completos del home. La ausencia de metadata de costo
se registra como no disponible, no cero. Las pruebas live no se vuelven dependencias implícitas de CI.

- Contratos duros: todos los casos positivos y negativos aplicables deben pasar; 1 fallo impide
  declarar esa capacidad verificada. Bloqueos/unsupported no son pass.
- Calidad: publicar resultados por escenario y repeticiones, no solo media; no se promete
  significancia estadística con 3 repeticiones ni identidad de respuestas.
- Rendimiento: medir duración separada de espera de permisos/instalación; comparar baseline/cambio
  dentro del mismo host. No fijar un porcentaje arbitrario sin baseline reproducible.
- Cierre de lote: reviewer fresco, suites específicas y gate del repo o deuda explícita aprobada
  conforme a sus reglas. No reutilizar el gate histórico como si certificara el diff nuevo.
