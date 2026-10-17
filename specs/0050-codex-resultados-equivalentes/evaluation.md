# Registro de evaluación viva — M7

## Protocolo requerido

La aceptación comparativa definida por A10 requiere cuatro escenarios por engine (Claude y Codex):

1. `bug-regression`: reproducir una regresión y observar la corrección.
2. `two-module-feature-and-review`: cambiar dos módulos y obtener review independiente vigente.
3. `resume-after-state-change`: cambiar evidencia/diff y verificar que el estado anterior se rechace antes de reverificar el nuevo.
4. `subagent-approval-route`: observar origen nativo del hijo, ruta por el principal, grant humano de un solo uso y efecto nativo completado.

Cada registro debe conservar versión del host, modelo y effort efectivos o `unknown`, estado/outcome, evidencia compacta, intentos y fallas, duración y consumo cuando esté disponible. Los controles requeridos y la review independiente deben proceder de la ejecución correspondiente. No se atribuye causalidad al modelo. La suite determinista A10 valida el formato y los rechazos; no sustituye estas ocho ejecuciones.

## Evidencia M7 disponible

El comando de captura registra únicamente observación de inicio con fase `observation-only`. Mantiene `pending`/`failed`, controles en pending, consumo `unavailable`, y no inventa producer, reviewer ni efecto de aprobación. El comando no ejecuta las fixtures. Para Codex puede observar metadatos de selección del inicio; para Claude puede consultar versión. Ninguno de esos datos demuestra que el escenario se ejecutó. La separación correctiva dejó los owners genéricos de evidencia/receipt en su comportamiento reusable y la evaluación de outcomes como diagnóstico; no conectó registros metadata-only con una ruta de éxito ni implementó dispatch nativo.

Los comandos A9 y A10 mantienen sus prefijos deterministas originales y agregan el consumer de producción actual. Se ejecutaron literalmente:

```text
cd packages/cli && bun run test src/lib/plan/__tests__/plan-gate.test.ts src/lib/codex/__tests__/profile-dispatch.test.ts && cd ../.. && bun packages/cli/src/index.ts codex evaluation validate --records .navori/state/handoffs/0050-live-evaluation.json --cwd .
exit 1 (prefijo determinista 88/88 exit 0; consumer: {ok:false,current native-auth evaluation records unavailable or redirected})

cd packages/cli && bun run test src/lib/codex/__tests__/outcome-evaluation.test.ts && cd ../.. && bun packages/cli/src/index.ts codex evaluation validate --records .navori/state/handoffs/0050-live-evaluation.json --cwd .
exit 1 (prefijo determinista 4/4 exit 0; consumer: mismo rechazo)

bun packages/cli/src/index.ts codex evaluation validate --records .navori/state/handoffs/0050-live-evaluation.json --cwd .
exit 1 (rechazo esperado: registros native-auth actuales ausentes; no se creó registro de prueba)
```

La corrección de separación previa restauró a HEAD los cuatro owners genéricos y los dos owners de pruebas de política retirados. Cinco suites afectadas pasaron 175/175; A15 pasó 47/47; `navori gate fast` pasó con exit 0. En esa etapa el bundle midió 1,505,727 bytes (1,470.4365234375 KiB), límite 1,536,000 bytes y margen 30,273 bytes. Estas pruebas verificaron la separación y el rechazo de entonces, no aceptación viva. El precursor actual B2/R13 tiene su propia medición más abajo. T6, T11, T12 y A9/A10/A13 vivos permanecen pendientes; la corrección técnica tiene alcance acotado y no convierte el resultado original en SPEC_OK ni autoriza publicación.

La evidencia histórica anterior registró A10 5/5, A9 89/89 y A15 47/47 en otra ejecución. El A16 del codec fue 19/19 y el bundle de entonces 1,506,801 bytes; ambos se conservan como evidencia previa, no se repitieron en esta corrección. El smoke standalone frío de Node v24.20.0 y Bun 1.4.2 descrito abajo también es histórico.

## Precursor B2/R13 actual

La verificación actual del precursor del hook pasó A17 33/33 y A15 51/51. Los prefijos deterministas de A9 y A10 pasaron 91/91 y 4/4, respectivamente. Los comandos compuestos exactos terminaron con exit 1 al ejecutar el consumer de producción, que rechazó la ausencia de registros native-auth actuales:

```text
cd packages/cli && bun run test src/lib/plan/__tests__/plan-gate.test.ts src/lib/codex/__tests__/profile-dispatch.test.ts && cd ../.. && bun packages/cli/src/index.ts codex evaluation validate --records .navori/state/handoffs/0050-live-evaluation.json --cwd .
exit 1 (prefijo determinista 91/91 exit 0; consumer: {ok:false,reasons:[current native-auth evaluation records unavailable or redirected]})

cd packages/cli && bun run test src/lib/codex/__tests__/outcome-evaluation.test.ts && cd ../.. && bun packages/cli/src/index.ts codex evaluation validate --records .navori/state/handoffs/0050-live-evaluation.json --cwd .
exit 1 (prefijo determinista 4/4 exit 0; mismo rechazo)

bun packages/cli/src/index.ts codex evaluation validate --records .navori/state/handoffs/0050-live-evaluation.json --cwd .
exit 1 (registros current native-auth ausentes; no se escribieron records sintéticos)

cd packages/cli && bun run test src/lib/codex/__tests__/profile-dispatch.test.ts src/commands/__tests__/codex-profile.test.ts src/lib/codex/__tests__/host-observation.test.ts
exit 0 (A17 33/33; fixtures deterministas)

cd packages/cli && bun run test src/lib/codex/__tests__/native-integration.test.ts src/lib/codex/__tests__/approval-controller.test.ts src/lib/codex/__tests__/host-observation.test.ts
exit 0 (A15 51/51; contratos deterministas)
```

`navori gate fast` pasó con exit 0. `bun run build` y `bun run check:size` midieron un único `index.js` de 1,510,082 bytes (1,474.689453125 KiB), límite 1,536,000 bytes y margen 25,918 bytes. El probe descriptivo del principal y de query/claim de catálogo tomó aproximadamente 1.1 s y dos procesos. No ejecutó ni activó el hook ni observa aplicación efectiva en todos los roles. El presupuesto configurado es query total 8 s, supervisor 11 s y hook nativo 15 s.

El hook es concurrente: otro deny gana y otra reescritura/configuración nativa puede cambiar el par efectivo. El protocolo PreToolUse `permissionDecision: allow` solo permite la reescritura de la llamada; no concede autorización humana de T6. Timeout, crash, skip, estado untrusted o hook inválido exterior pueden dejar pasar los argumentos originales. Un evento manual, metadata persistida o fixture no sustituye una observación nativa propia del par realmente aplicado. No se hizo render/activación/confianza del hook, native child turn, efecto ni full gate. T6/T11/T12 y la aceptación viva permanecen pendientes; este precursor determinista no certifica A9/T11.

### Corrección actual del supervisor

La suite A17 pasó 45/45 tras añadir casos con PATH restringido para ausencia de Node/CLI, salida parcial con fallo/señal, JSON inválido (`[]` y primitivas), objeto exacto `{}` y emisión de una sola respuesta JSON. A15 pasó 51/51. `navori gate fast` pasó con exit 0 y el bundle se mantuvo en 1,510,082 bytes (1,474.689453125 KiB), límite 1,536,000 bytes y margen 25,918 bytes. Los tests prueban las rutas del supervisor; no ejecutan el hook en Codex ni validan la respuesta de fallos del host exterior.

El preview normal de CLI fuente y dist mostró inicialmente tres deltas: los dos mirrors autorizados de `model-advisor` y uno de Pi, limitado a hash managed/serialización de helpers. Root aplicó el renderer normal dentro del alcance aprobado y resolvió el drift Pi con una pasada normal de Node dist. El preview scoped final informa 0 pendientes; ambos mirrors `model-advisor` y el mirror Pi coinciden con su salida generada. La configuración cambió únicamente `branchBase`/`prTarget` de `dev` a `main`; seis perfiles reviewer/publisher usan `origin/main`, `--target main` y los publishers `--base main`. A17=45/45 sigue como evidencia fresca; fast y scoped están verdes y el tamaño es 1,510,082 bytes. No hubo cambio de trust, activación del hook, turno nativo ni efecto. La revisión fresca de fuente sigue pendiente.

## Smoke de empaquetado

Se copió el `index.mjs` standalone medido a un directorio temporal aislado, sin `node_modules`, assets ni repo, y se ejecutó `--help` para ejercitar startup/decoders:

| Runtime | Versión | Resultado | Duración | RSS máximo |
|---|---:|---:|---:|---:|
| Node | v24.20.0 | exit 0 | 243.5 ms | 98,205,696 bytes |
| Bun | 1.4.2 | exit 0 | 259.3 ms | 88,408,064 bytes |

Es una muestra fría única por runtime. No hay baseline previo para comparar arranque o memoria; Node 22 y el layout completo publicado no se probaron. Los límites de descompresión y errores de integridad sí tienen pruebas deterministas en A16.

## Preflight fijo de perfil: resultado actual

A17 y A15 pasaron 52/52 cada una. `navori gate fast` y el chain `check:scoped` pasaron; el render generado reportó 0 pendientes. El bundle midió 1,514,590 bytes (1,479.091796875 KiB), límite 1,536,000 bytes, margen 21,410 bytes. No se repitió A16 ni el smoke previo.

El comando `bun packages/cli/src/index.ts codex profile probe --cwd .` salió con exit 1 por opt-in ausente, `consumed:false`, cero procesos y cero turnos. Un preflight separado de fixture owned verificó únicamente la configuración cargada y un exit de procesos reconocido: claim consumido, cero turnos, siete nombres de rol y el par efectivo no soportado/no renderizado, así que dejó la selección pending. No inició thread/turn, UI o efecto; no demuestra aplicación por rol, permiso humano ni aceptación viva. T6/T11/T12, A9/A10/A13 y los ocho outcomes siguen pendientes; no hay full gate, receipt ni autorización de publicación.

## Corrección acotada de contratos de verificación

El baseline `main` comparable, aportado por la coordinación, fue 196/0; la corrida del árbol actual reprodujo 182/14 y la corrección terminó con 204/0 en siete suites: hook-output 45, doctor 51, target-render 1, removal-parity 28, native-overlap 48, audit/collect 26 y golden 5. No se afirma que esta corrección haya ejecutado `main` ni el gate completo. El gate `fast` pasó con exit 0 (AST 5/5, lint y TypeScript); `check:render` pasó con 0 pendientes; el bundle mide 1,514,590 bytes (1,479.091796875 KiB) frente al límite de 1,536,000.

La asociación de hooks ahora conserva el comando/invocación real y elige solo guardas literales y aliases fijos; las rutas no soportadas se mantienen visibles y negativas. Las excepciones de listeners permanecen default-deny y acotadas a los owners de controller/verifier aprobados, con eliminación exacta del catálogo controlado. La generación oficial actualizó solo los dos golden snapshots Claude/Codex para el header, audit y bloque PreToolUse de `model-advisor`. No se modificaron reglas de producción ni se debilitó el inventario. T6/T11/T12 y las obligaciones vivas de aprobación, selección all-role y ocho outcomes siguen pendientes; el gate completo de envío y la aprobación final no están verdes.

## Checkpoint borrador E4

El gate completo operativo más reciente terminó con exit 0: 433 suites, 8,849 pruebas aprobadas, 2 omitidas y ninguna fallida; se ejercitaron 150 módulos y se registró una excepción documentada del umbral de cobertura. Lo ejecutó el reviewer independiente del mantenimiento de escalamiento, no el producer de este checkpoint. El log es `.navori/state/gate/full-20261014T232403559Z.log`. Ese reviewer no emitió veredicto ni receipt de publicación para el diff completo de E4; el resultado del gate no sustituye esa revisión.

La ruta de escalamiento soportada se instaló por el mecanismo normal y una sola invocación normal reconoció el opening E4 y consumió su marcador permanente. Esto confirma el acknowledgement de workflow; no constituye aprobación humana, fuente T6 ni permiso para un efecto protegido.

El usuario autorizó preparar un checkpoint de PR borrador dirigido a `main`. Para publicarlo todavía se requiere una revisión E4 independiente del diff completo y su receipt. El borrador no cerrará la entrega ni autorizará merge. T6, T11, T12 y los criterios vivos A9, A10 y A13 permanecen pendientes; tampoco se acreditan los ocho outcomes autenticados.

## Enmienda M7 — evidencia de T11/A9

La implementación focal conserva el target opt-out y crea una fixture opt-in aislada desde
su snapshot de solo lectura. La fixture elimina todo MCP heredado del target antes de
iniciar el host y verifica la configuración MCP efectiva vacía. A18 exacto pasó 137/137 y
golden 5/5 (83.85s y 9.51s) y root lo registró cumplido tras corregir cobertura exacta de
roles; su evidencia anterior de 136/136 es histórica. A19 pasó 9/9 en una ejecución root
fresca y fue registrado. El gate `fast` final terminó con exit 0 en
`.navori/state/gate/fast-20261016T200523122Z.log`. Las suites incluyen exclusión MCP real
de fixture, refresh/replay, límites y cleanup, validación del supervisor y esquemas de
procedencia; son evidencia determinista, no aceptación native all-role.

En la primera ejecución root detuvo la sonda antes de inferencia por
`native-principal-overrides-unverified` relacionado con MCP. La admisión fue corregida
excluyendo MCP del target antes del startup de fixture. Root registró hashes 10/10 de las
configuraciones target/global/roles intactos tras las sondas.

Un auditor encontró que contar candidatos podía marcar completo un inventario con dos
filas `architect` y ninguna fila `local`, aunque ambos hooks fueran válidos. La regresión
real del owner reprodujo ese falso positivo con dos architects y cero locales. La
aceptación ahora exige cobertura exacta uno-a-uno de roles configurados y candidatos
autenticados, además de call/context únicos en baseline y refresh. El caso adversarial
corregido falla antes de refresh y el control positivo aislado conserva inventario,
herencia/pins, refresh distinto, control `agents.enabled`, exclusión MCP, joins de hooks y
replay. El cierre por lectura del auditor confirmó el cambio.

La ejecución live A9 más reciente tiene identidad
`04c77226a2d6878732cbd7e6e48af08119956987aac0ff9c94856308f3225bc3` y permanece pending:
`native-profile-selection-or-hook-call-unverified`. El prefijo determinista de esa corrida
pasó 121/121; hubo un request de turno principal con `gpt-6.1-sol/medium`, cero children,
refresh pendiente, cleanup no verificado, 60,584 bytes y 43 frames. Los contadores
collab/activity/hook/spawn/joined fueron cero; se registraron dos mensajes de agente y
cuatro otros mensajes. `modelReported=blocked/tool_unavailable` es solo diagnóstico y no
establece causa ni capacidad del host. Root verificó intactas 10/10 configuraciones
protegidas tras la ejecución. T11 no está completa.

Los prefijos A9 previos también tuvieron fallas deterministas antes de `--live`: uno falló
1/121 por marcador PID ausente, y otro falló 1/121 en el caso de herencia esperado `allow`
que obtuvo el deny `profile-hook-unavailable-stale-invalid-or-consumed` a los 8,139 ms.
El foco original de herencia pasó aislado; no hay causa establecida para el deny ni se
modificaron límites. Estos fallos no son resultados nativos ni consumieron turnos.

La autorización vigente deja una ejecución adicional con turnos de hasta 180 segundos; la
última A9 consumió un turno. No se infiere autorización para reintentar el mismo estado
semántico mediante un cambio de hash documental. Root debe establecer una causa comprobable
antes de decidir si procede otra ejecución. No hubo retry automático.

La admisión determinista reproduce `agents.enabled` desde el config privado cargado y
valida el wire nullable normalizado de siete campos; defaults de modelo/esfuerzo solo
pueden estar ausentes o ser null. El positivo deriva enabled de la configuración privada y
rechazos para valores missing/false/invalid se detienen antes del turno. El timeout
original del supervisor también se reprodujo: 22 invocaciones síncronas tardaron 33.908 s
frente al límite original de 15 s. Se dividieron los casos y se esperó el drenaje del owner
interrumpido sin elevar timeouts. La procedencia acepta explícitamente headers 0.162.1 y
0.163.0 con invariantes idénticas de rol, parent, sesión, path y git directory.

T11/A9 continúa pendiente hasta que exista evidencia native completa de inventario y
refresh con cero pendientes y cleanup confirmado. T6, T12, A10 y A13 también siguen
pendientes; esta enmienda no cierra E4 ni sustituye el full gate y review pendientes.

## Extensión del lector de binding — aceptación A20 registrada por root

Con autorización de alcance, se añadió compatibilidad exacta para headers nativos 0.162.1
y 0.163.0 al lector `review-edit-binding.sh`, su prueba y las salidas generadas aprobadas.
La focal de implementación pasó 47/47 (38 lector + 9 procedencia), el golden Codex pasó
1/1 y el renderer Node actualizó solo `.codex/hooks/role-guard.sh` con 90 archivos sin
cambios. El gate fast final del implementer pasó con exit 0 en
`.navori/state/gate/fast-20261016T203915005Z.log`. El auditor contrastó el diff sin findings,
pero esto no es aprobación de envío. En esa verificación el hook original seguía pinned a
0.162.1; la activación posterior autorizada se registra abajo.

A20 exacto fue completado por root en sesión de ejecución `13800`: 47/47 pruebas y 5/5
goldens, exit 0. La focal de implementación no sustituía ese comando. Root inició el full run `44919`, luego lo interrumpió
con SIGINT propio (exit 130); `.navori/state/gate/full-20261016T201511993Z.log` conserva las
fallas previas a la interrupción. No está aprobado ni certificado y no hay receipt. La
validación de inventario root `97331` terminó en 55 ms con esperado 18, encontrado 19 y un
extra: `packages/cli/src/lib/codex/native-integration.ts`. Después, A21 removal-parity pasó
29/29 y se registró por el CLI original compatible; esto no afirma que se modificara ni
excluyera ese path. No presentar
este full run, el contraste del auditor ni la focal como review o readiness aprobadas.

A18 (137/137 + golden 5/5) y A19 (9/9) anteriores son evidencia previa a la extensión del
lector. La A18 posterior se renovó tras el guard y root la registró 137/137 + 5/5, sesión
`51893`. T11/A9 sigue pending con identidad
`04c77226a2d6878732cbd7e6e48af08119956987aac0ff9c94856308f3225bc3`; la extensión de review
no explica ni cambia el resultado native, no consume el turno restante y no habilita una
nueva sonda.

Root registró A21 removal-parity cumplida (sesión `69571`, 29/29, exit 0, 8.45s). Por
separado, el artefacto de metadata sin turno confirma una lectura en Codex 0.162.1: principal
`gpt-6.1-sol`, `multiAgentVersion: v2`, `toolMode: code_mode_only`, principal presente en
catálogo, cero notificaciones de thread/turn y salida nativa reconocida. La admisión de A9
espera `V1`/`close_agent`; la
metadata `V2`/`code_mode_only` no satisface ese requisito. En ese punto el pase de diseño
root seguía en curso. La revisión posterior de fuentes descartó el cierre secuencial como
inviable bajo el default de 60 s × 8 (480 s frente al límite 180 s), y el enfoque residente
no acredita cierre aceptable tras eviction; no se eligió un cambio de contrato. El checkpoint
parcial fue autorizado con T11/A9 pendiente. Esta metadata no acredita selección de
subagentes ni consume el turno nativo restante. A20/A21 no cierran A9/T11; fresh full y
revisión de envío siguen pendientes.

## Estado del checkpoint parcial autorizado

El usuario autorizó activar el lector de edición/review en el checkout original y preparar
un checkpoint parcial para PR dirigido a `main`, con T11/A9 pendiente. El productor de
activación cambió únicamente `packages/core/core-assets/hooks/_partials/review-edit-binding.sh`
y `.codex/hooks/role-guard.sh`, aceptando exactamente headers 0.162.1/0.163.0 y manteniendo
el resto de las guardas de identidad, rol, thread, root, parent, source hash/cwd, ownership,
fingerprint, base e independencia. El build Node, preview, apply soportado, `bash -n`,
`git diff --check` y fast gate del checkout original terminaron exit 0. El apply solo
actualizó el mirror `.codex/hooks/role-guard.sh` (90 archivos sin cambios; Pi escrito: ninguno),
preservó el contenido 0054 y los hashes de los tres archivos dirty preexistentes. No se
ejecutó aún una revisión nativa con el reader activado.

El full gate previo al guard terminó exit 0 en
`.navori/state/gate/full-20261016T210818650Z.log`: 436 archivos, 9,227 pruebas aprobadas,
2 omitidas, 0 fallidas, cinco AST checks, piso de cobertura de 154 módulos aprobado;
coverage statements 84.37%, branches 79.1%, functions 89.37%, lines 85.91%. Este es el
resultado histórico del árbol previo al guard; la fresh full del árbol actual sigue pendiente.
El full run interrumpido `44919` (SIGINT/130) también permanece como evento histórico
separado. La salida indica cinco AST checks, no cinco goldens adicionales. A20 exacto (47
pruebas + 5 goldens), A21 removal-parity (29/29), A19 y A18 renovada (137/137 + 5/5,
sesión `51893`) están registradas. No hay todavía review de envío, receipt, commit o PR.

El diagnóstico del host V2 hace que A9 siga pending, sin inferencia adicional. El catálogo
privado observado es `gpt-6.1-sol`, V2, `code_mode_only`, mientras que el escenario aprobado
requiere V1 `close_agent`. Fuentes oficiales del tag
[`rust-v0.162.1`](https://github.com/openai/codex/tree/rust-v0.162.1) muestran que V2 no
registra CloseAgent ([spec_plan.rs](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/core/src/tools/spec_plan.rs#L1300-L1428));
la capacidad por defecto es tres hijos ([config/mod.rs](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/core/src/config/mod.rs#L257-L261));
un estado terminal puede seguir residente y eviction tiene un ciclo propio
([residency.rs](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/core/src/agent/control/residency.rs#L174-L228)).
El unload default de 60 segundos ([config/mod.rs](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/core/src/config/mod.rs#L3930-L3931))
hace que ocho cierres secuenciales tarden al menos 480 segundos, antes de inferencia o
refresh, y excedan los 180 segundos autorizados. La evidencia de eviction examinada no
publica el cierre aceptado; `Completed`, `NotLoaded`, archive y salida del proceso no lo
sustituyen. Attachment del hijo efímero exacto permanece unknown, no demostrado imposible.

El guard de refresh ahora vuelve a comparar `liveProfileSnapshot.identity` justo antes de
solicitar el refresh. Si el target cambió después de baseline, rechaza con
`target-profile-inputs-changed` antes de un segundo turno. El caso prueba un solo
`principalTurnRequests`, un `turn/start` y cleanup reconocido. La focal roja previa de 15 s
pasó 1/1 tras el guard; el grupo de cambio de target, paralelo y positivo baseline+refresh
pasó 3/3. No se elevaron deadlines ni se alteraron hooks/modelo/esfuerzo. Este arreglo de
inputs obsoletos es evidencia determinista y no explica la selección/hook faltante del A9
live, que permanece pending.

No se implementó una aceptación V2 viable y el usuario no autorizó cambiar contrato o
presupuesto. Una ejecución nativa de hasta 180 segundos sigue sin usar y no se inició una
nueva sonda. T11/A9, T6, T12, A10, A13 y E4 permanecen pendientes. El checkpoint parcial
está autorizado para preparación; review independiente, receipt, commit y apertura del PR
siguen pendientes.

## Partición A22 del control de binding de reviewer

La última corrida reviewer full, `full-20261016T230611569Z.log`, quedó roja: 9,226 pruebas
pasaron, 1 falló y 2 se omitieron. La única falla fue timeout del caso monolítico de roles
a 25,816 ms. La medición de diagnóstico separó 18,363 ms en 36 invocaciones de hook y 1,173
ms en dos comparaciones TypeScript, pero puede perturbar el tiempo observado; el origen del
timeout sigue desconocido y no se clasifica como deuda introducida ni preexistente.

El control aprobado reagrupó esos controles en 17 casos independientes. Conserva los 18
payloads originales y las dos verificaciones TypeScript; añade un positivo del mismo destino
antes de revocar su índice exacto. Mantiene el hook real bajo Bash y Zsh, una fixture de
linked worktree fuera de OS temp, remoción del mismo índice físico, los otros 25 casos y el
límite de 15 s. Son 19 payloads × 2 shells = 38 invocaciones estructurales inferidas del
código, no una nueva medición instrumentada. No hubo cambios al hook de producción, shell
matrix, timeout, worker, cobertura ni prioridades de casos.

El productor A22 pasó el comando exacto en dos archivos: 80/80, ejecución `88165`, 120.35 s.
Root ejecutó su A22 independiente y pasó 80/80 en dos archivos, ejecución `68929`, 166.40 s;
source CLI registró A22 cumplida (`updated: true`). El gate fast vigente pasó en
`.navori/state/gate/fast-20261017T003515123Z.log` (exec `51719`): AST 5/5, lint y TypeScript.
El full reviewer rojo precede esta partición y no certifica el árbol actual; hace falta un
full fresco independiente y receipt de fase 1 antes de que publisher prepare el borrador PR.
El issue #1314 fue diferido por el usuario y queda fuera de este checkpoint parcial.

A22 solo valida la partición determinista del control; no demuestra A9 ni selección native.
T11/A9, T6/T12/A10/A13 y E4 permanecen pendientes. La ejecución de inferencia autorizada
por hasta 180 s continúa sin uso; no se hicieron sondas ni se alteró el contrato.
