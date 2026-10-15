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
