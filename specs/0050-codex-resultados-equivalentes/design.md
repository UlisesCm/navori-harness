# Codex: resultados equivalentes y perfiles actuales — Design

## Estado de M4 (T8–T10)

M4 implementa resolución de perfil, proyección del inventario del proyecto y diagnósticos de
catálogo. La evidencia registrada para esta entrega es A7 (33 pruebas en 2 archivos), A8
(18 pruebas en 3 archivos) y `bun run check:fast` con exit 0; el bundle fue de 1473.4 KB
frente al límite de 1500 KB. Esto valida el contrato determinista de resolución, render y
doctor. No demuestra selección efectiva ni aplicación de modelo/esfuerzo en el host.

E1/M1, E2/M2 y E3/T7 están integrados. E4/M4 (T8–T10) se envió como entrega parcial en
PR #1320; ese envío no completó las obligaciones originales de E3/E4. T6/E3 sigue pendiente;
T11/A9, T12/A10 y la aceptación viva R17 también. M4 no cierra esas obligaciones.
La sonda nativa corregida del 2026-10-14 solo acredita la selección del contexto de inicio
descrita abajo. No ejecutó un turno, no probó aprobación ni demuestra aplicación de perfiles
por rol, retención efímera, aceptación viva o gate de envío. La revisión y los gates se
registran por entrega en `tasks.md`; no se infieren de esta sonda.

## Enfoque

La entrega integrada M4 extiende los resolvers de perfiles y el renderer/doctor existentes;
no añade un registry. El host conserva el control sobre su modelo efectivo. El render y el
doctor comparten la proyección de perfiles para el principal, los roles habilitados y los
TOML nativos locales. Las garantías de autorización, dispatch exclusivo y evaluación viva
siguen pendientes de M6/M7 en el cierre final de E4.

## Componentes y anchors

- `ENGINE_CAPABILITIES` y `CODEX_PARITY` en `packages/cli/src/engines/shared/engine-capabilities.ts` y `packages/cli/src/engines/shared/codex-parity.ts`: capacidades acotadas por versión, superficie y evidencia — R1, R2, R17.
- `executeReceipt`, `evidenceIdentity` y `checkReceipt` en `packages/cli/src/commands/receipt.ts` y `packages/cli/src/lib/diagnose/receipt.ts`: evidencia de aceptación e invalidación — R3, R4.
- `evaluatePlanGate` y `DispatchSchema` en `packages/cli/src/lib/plan/gate.ts`: handoff, revisión actual y preparación de dispatch — R5, R8, R13.
- Guardas de publicación, reglas y flujo de aprobación de Codex: autorización ligada a acción/destino/diff y devolución desde subagente — R6, R7, R16.
- `resolveCodexProfile`, `projectCodexProfiles` y `scanModelProfileProvenance` en `packages/cli/src/lib/assets/model-profile.ts`: selección por campo, proyección/provenance y lectura contenida de agentes locales — R9, R11, R12, R14.
- `inspectCodexCatalog`, `highestOfFamily` y `resolveCodexModelValue` en `packages/cli/src/lib/codex/model-catalog.ts`: orden numérico, evidencia de catálogo y candidatos degradados — R10, R15, R18.
- `buildCodexConfigToml` en `packages/cli/src/engines/codex/build-config-toml.ts` y renderer de agentes: intención administrada del proyecto para futuros inicios, con preservación de campos del usuario — R12, R13, R16.

Los anchors existentes de la tabla describen componentes integrados cuando así se indica;
no son evidencia de las garantías runtime pendientes. Los componentes de control M6 existen,
pero sus rutas de producción permanecen fail-closed hasta establecer una fuente aislada. M7
añade un precursor opt-in de reescritura por hook y observación/claim acotados; no completa
selección efectiva por todos los roles ni la evaluación viva.

## Contratos y decisiones

### Perfiles y precedencia

La intención durable permanece en `navori.config.json`; resolución y provenance se derivan para render, doctor y dispatch. La precedencia es por campo: override explícito de Codex por rol, mapping Codex explícito aplicable, default derivado del perfil Claude y finalmente herencia declarada. Se conserva `models.codexMap`; cualquier ampliación debe representar overrides por rol/esfuerzo sin duplicar configuración global. Un pin de modelo no reemplaza por sí mismo la regla del esfuerzo.

Defaults implementados: Opus medium → Sol medium; Sonnet medium → Luna high; Haiku → Luna conservando esfuerzo. Otros esfuerzos permanecen configurados; por ejemplo, Sonnet low continúa low y Sonnet high continúa high. Los overrides explícitos y pins prevalecen solo en su campo, por lo que un pin o mapping de modelo no suprime la conversión Sonnet medium → high.

`models.codexProfiles` es opcional y usa el nombre TOML nativo exacto como clave. Permite
configurar `model`, `effort` o ambos de forma independiente; `orchestrator` nombra el
principal y está reservado. El mapping heredado `models.codexMap` continúa disponible. El
esfuerzo de perfiles Claude no se transforma para Claude o Pi; la regla Sonnet medium →
high y los overrides por nombre se aplican en la resolución de Codex. Pi conserva su
consumidor explícito de modelo `codexMap`.

Cada registro de perfil identifica rol, ámbito (principal/subagente), fuente, familia o pin, esfuerzo de entrada y destino, catálogo y estado. Los estados `candidate`, `configured`, `observed`, `degraded`, `unknown` y `pending` son distintos. `observed` requiere dato del host ligado al inicio o dispatch correspondiente. Una entrada de catálogo no demuestra soporte de esfuerzo ni disponibilidad runtime.

### Frescura y frontera de dispatch

En M4, el catálogo local se inspecciona para producir candidatos durante render/doctor. El
resolver puede recibir provenance opcional con fuente, timestamp y contexto; sin esos datos
el estado queda `unknown`. Su cache, metadatos internos, mtime o slugs no prueban frescura.
Los valores opcionales de provenance no son por sí mismos evidencia autenticada del host.
Sin esos datos queda `unknown`; catálogo ausente, inválido o sin entradas compatibles queda
`degraded`. Formatos desconocidos se diagnostican y no se comparan lexicográficamente ni se
adivinan IDs. La comparación numérica cubre versiones dentro del formato conocido.

Cada preparación tiene identidad propia, rol y acción. Solo un consumidor puede reclamar y consumir esa identidad; otra acción, rol o consumidor concurrente no puede reutilizarla. El diseño requiere probar dos consumidores sobre el mismo record, además de cruces de rol/acción. No se presupone que TTL, escritura atómica o eliminación tolerante a ausencia proporcionen exclusividad.

### Principal, aprobación y ciclo de vida

El principal es propiedad del host. La configuración project-managed expresa intención
para futuros inicios; conserva los campos del usuario y valores más nuevos de la misma
familia. El inventario lee perfiles TOML del proyecto dentro del checkout, incluidos los
locales, que no administra ni reescribe. Solo observación del host ligada al contexto
iniciado probaría el modelo efectivo; M4 no recoge tal observación. Por tanto, los perfiles
configurados/candidatos/renderizados se distinguen de `observed`; sin observación, aplicación
queda `pending` y el remedio es iniciar un contexto Codex nuevo y verificar allí modelo y
esfuerzo. No se cambia una sesión en curso.

Un subagente devuelve una solicitud concreta. El principal puede tramitarla o acreditar una autorización humana/host previamente concedida que cubra exactamente la acción y alcance. El principal no genera consentimiento por redactar un registro. Handoff, receipt o hash vinculan contenido y estado, pero no autentican por sí mismos a quien autorizó. Una denegación no habilita retries con otra herramienta; superficies no verificadas quedan declaradas sin cobertura.

### Integración nativa M6 del cierre E4 — implementación fail-closed; fuente positiva pendiente

M6 conserva el comando opt-in por proyecto, la conexión nativa confinada, el efecto privado
fijo y el controlador/launcher. El predicado de disponibilidad de fuente es sin inputs y
siempre devuelve unavailable en esta implementación; protege el comando, el runner nativo directo, el controlador, el
launcher y el efecto privado. Por ello, las rutas de producción fallan cerrado antes de
bootstrap, UI o publicación. TTY, environment, JSON del caller, flags y el navegador por
defecto nunca constituyen prueba de fuente humana. La evidencia es determinista: no hubo
bootstrap, decisión humana ni efecto live, y no se afirma que una fuente aislada ni una
publicación positiva estén implementadas o validadas. El engine conserva tools y agentes para
la ejecución ordinaria. La única frontera de efecto prevista sigue siendo una publicación
fija de PR; no se expone API pública de `grant`, `approved`, `publish-token` ni ejecución
genérica. La solicitud/relay existente continúa en estado pending: la mediación no es
consentimiento. El ownership de preparación, observación y evaluación de perfiles sigue
futuro en M7.

La meta admitida para habilitar autorización es un controlador parent de navegador operado
por una persona y separado de las rutas de tools/browser soportadas por el agente. Aún no hay
prueba de aislamiento del contexto invocador ni de un contexto de navegador separado que
permita habilitarlo. La fuente futura no debe ser un callback externo sin resolver ni una
interfaz `accept` definida por el caller. La frontera objetivo usa HTTP built-in ligado a
loopback en puerto aleatorio, credenciales criptográficas independientes por ejecución y
solicitud, guardadas solo en memoria del parent, y bootstrap directo al navegador del sistema
fuera de tools nativas del agente. La credencial del fragmento se elimina de inmediato del
historial y permanece en memoria del navegador. No pasa por cookies, storage persistente,
environment, streams del agente, logs, evidencia o assets externos. La superficie exige Host
y Origin ligados de forma estricta, bearer y CSRF; no admite CORS, wildcard, aprobación por
GET ni endpoint de comando genérico.

La conexión nativa requiere ligar el scope inmutable a request/thread/turn/item, acción y PR:
destino, head, base, IDs de objetos, contenido, título, body y draft. Solo una decisión
outstanding, de un uso, puede consumirse atómicamente antes de resolver la autorización nativa
y ejecutar el efecto. La conexión exige un origen pending observado del child en la misma
sesión antes de aceptar la llamada nueva del parent; un callback solo del parent no abre UI
ni efecto. Rechazo, cancelación y timeout cierran la solicitud; si cambia el scope queda
pending. El bootstrap humano y el acceso al controlador deben quedar fuera de las rutas de
tools/browser soportadas del agente; `isatty`, environment o JSON del caller no prueban
identidad humana. El límite de amenaza es un writer local confiable: no se afirma protección
contra un controlador/browser comprometido, debugging del OS por el mismo usuario ni agentes
con acceso irrestricto al OS. La finalización exige status nativo canónico y valida el campo
opcional de éxito booleano; conserva por separado el status nativo normalizado, el estado del
efecto y el veredicto final. Status fallido, cancelado, desconocido, ausente o malformado, y
resultado explícitamente no exitoso/malformado, no se presentan como completados: tras un
posible efecto quedan inciertos. También quedan inciertos al cerrar conexión o vencer deadline
después de un posible efecto; se reconcilian solo en modo read-only y no se reintentan.
Callback de dynamic tool o aprobación exacta de comando solo sirven si usan el efecto fijo
retenido y demostrado; la invocación o el callback `accept` por sí solos no autentican
consentimiento.

La futura preparación y claim de perfil en M7 usa un snapshot nativo completo y puntual ligado a
query, contexto, preparación y hora observada; no inventa `validUntil` ni cambia el resolver
compartido o la cache existente. Refresh ocurre en startup y dispatch futuros. La claim liga
rol, acción y contexto, y cada preparación tiene un solo consumidor. La correlación de child
requested/resolved incluye call, parent y child auténticos, además del mapping observado de
rol/fuente de perfil para cada fila principal/core/extra/local. Hilos de rol a nivel superior
no sustituyen esa relación. Para R14, la selección de modelo y effort observada al iniciar un
contexto Codex se vincula a ese contexto real; no basta el setting solicitado, metadata de
thread persistida ni telemetría de inferencia por turno. Falta, null o discordancia mantiene
la aceptación pendiente.

La reproducción nativa corregida envió y esperó `initialize` id 1 y luego `thread/start` id 2.
Codex seleccionó `gpt-6.1-sol` con `config.model_reasoning_effort` `medium` en 1.127 s el
2026-10-14 UTC; no hubo turno ni aprobación. El timeout anterior de 25 s fue un mismatch del
ID de initialize del cliente, que nunca envió `thread/start`. La reproducción demuestra solo
selección de contexto al inicio, no inferencia, aplicación de perfiles por rol, aprobación ni
retención efímera. La instrumentación de producción debe tener diagnósticos finitos y
sanitizados.

Los records antiguos pueden seguir leyéndose como historia, pero no prueban garantías nuevas cuando les faltan los vínculos requeridos. Al reanudar se recupera tarea y siguiente paso; las aprobaciones, revisiones y evidencia se revalidan contra estado actual. A7/A8 no cubren startup, dispatch, aplicación en vivo ni la aceptación R17; no afirman equivalencia de calidad entre modelos.

## Atributos de calidad y fallos

| Atributo | Criterio futuro | Evidencia requerida |
|---|---|---|
| Confiabilidad | Ningún criterio pasa con evidencia ausente, fallida u obsoleta | Casos negativos de evidencia y receipt |
| Control humano | Ninguna acción se publica sin autorización aplicable, vinculada y de un solo uso | Principal sin fuente, replay, cambio de diff/destino |
| Cobertura de roles | Cada rol habilitado tiene modelo y esfuerzo cotejados; ninguno requerido queda unknown/pending para aceptación | Inventario explícito de main, core, extras y locales |
| Compatibilidad | Se preservan pins, contenido user-owned, configuración global y trust | Snapshots antes/después y casos offline |
| Mantenibilidad | Render, doctor y dispatch comparten la resolución y provenance | Tests de consistencia de perfil |

Fallas de receipt o revisión obsoletos dejan el criterio pendiente hasta revalidación. Catálogo viejo, inválido, ausente o sin fuente de frescura produce degraded/unknown. Rechazo de modelo/esfuerzo deja pending y requiere decisión humana. Un host que mantiene otro principal conserva estados requested/configured separados de observed. Un consumidor duplicado no obtiene permiso por haber leído primero el record.

## Compatibilidad

No se reescriben pins ni mappings `codexMap` explícitos. El cambio del default Sonnet medium a Luna high se muestra en preview y release notes, sin afirmar equivalencia de calidad ni cambiar automáticamente a Sol si Luna no cumple. Los registros previos siguen como historia, pero no se promueven a evidencia vigente. El render usa managed markers, backup y escritura atómica existentes; no edita bloques generados por shell ni cambia trust, archivos globales o políticas de permisos.

## Estrategia de pruebas

Los casos unitarios y de integración se añaden a suites existentes o a los paths futuros declarados en `tasks.md`. Cada test incorpora `// Covers: R<n>`. Las suites mockeadas y los validadores prueban contratos deterministas, no comportamiento vivo del host. Las obligaciones finales A5/A6/A9/A10 y las superficies de navegador requieren evidencia de la integración en su superficie de producción; no se dan por cerradas con mocks. Ninguna prueba lee el home real ni llama APIs externas salvo el protocolo nativo vivo, explícito y acotado de A9/A10.

La evaluación final es un protocolo vivo futuro con cuatro fixtures controlados: (1) regresión de bug pequeño, (2) feature de dos módulos seguida por review independiente, (3) reanudación después de cambio de evidencia/diff, y (4) solicitud de aprobación iniciada por subagente. Para cada engine y escenario se registran versión del host, modelo y effort efectivos o unknown, criterios, resultado y evidencia compacta; también reintentos y duración, y consumo cuando el host lo expone. Métricas de costo pueden decir “no disponible”; evidencia requerida ausente falla aceptación. Se conserva cada fallo y no se mezclan correcciones con la evidencia de una corrida. No se infiere causalidad de cambiar la familia Sonnet medium por Luna high.

## Fuentes oficiales

- [Codex hooks](https://learn.chatgpt.com/docs/hooks): eventos y resultados de hooks; verificar de nuevo las capacidades por versión en cada entrega.
- [Modelos e inferencia de Codex](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference): fuentes de catálogo disponibles; una entrada no equivale a disponibilidad runtime.

Las sondas y matrices de la Spec 0041 son antecedentes versionados, no aceptación automática de esta spec ni evidencia universal para todo host. La reproducción puntual descrita arriba no sustituye la evaluación A9/A10 ni autoriza un reclamo universal.

## Fuera de alcance

- Igualar razonamiento, herramientas, hooks, transcripts, prompts, diffs, costo o decisiones internas entre engines.
- Crear un runner genérico, broker de modelos, capa always-on, servidor MCP o API de ejecución genérica.
- Descargar catálogos, añadir OAuth/API o cambiar trust, configuración global u otros engines.
- Afirmar que los paths de integración propuestos o sus efectos ya existen antes del cierre de E4.

## Estado parcial de M7 y codec del bundle

La implementación M7 agrega observación acotada del catálogo y del inicio del principal, preparación metadata-only con claim exclusivo y un evaluador diagnóstico. La consulta privada conserva identidad de conexión y pares soportados; objetos importados o clonados no certifican propiedad. El reducer de eventos nativos solo emite candidatos cuando encuentra relaciones de llamada, actividad y rol-parent compatibles. No implementa dispatch activo de hijos. La selección observada al inicio se distingue de ejecución; la preparación consumida queda pending y no otorga permisos.

El evaluador fija cuatro fixtures por engine y registra fase `observation-only`, estados `pending`/`failed`, controles pendientes, consumo no disponible y evidencia de independencia ausente. Rechaza JSON importado y casos incompletos, pero siempre devuelve `ok:false` mientras falten fuente nativa actual, ejecución, controles y review independiente. Por ello, sus pruebas deterministas no son la aceptación viva A10.

Para respetar el límite actual del bundle, el build transforma exactamente los valores raw de `PI_BRIDGE_SOURCE` y los fragmentos de `renderPiExtensionSource` en `bridge-source.ts` y `extension-source.ts`. El plugin identifica las declaraciones con el parser TypeScript en la entrada, antes de minificación, y aplica reemplazos mapeados por spans; no busca nombres minificados. Cada valor se valida como UTF-8 reversible, se comprime Brotli/base64 y lleva longitud y SHA-256. El decoder embebido en el mismo `index.js` limita tamaño/codificación y verifica integridad antes de devolver texto. El renderer interpolado reconstruye `String.raw({raw: fragments}, ...originalExpressions)` con diez expresiones, preservando orden de evaluación y coerción. Las pruebas comparan renderer/settings completos en el mismo modo de build y casos de errores, símbolos, `undefined` y coerción.

La transformación no modifica las fuentes legibles de Pi, dependencias, checker ni configuración global. La medición anterior fue 1,506,801 bytes (1,471.4853515625 KiB); es evidencia histórica del codec y no se repitió en la corrección. La corrección de separación previa al precursor B2/R13 midió 1,505,727 bytes (1,470.4365234375 KiB), bajo el límite 1,536,000 bytes por 30,273 bytes. El smoke frío aislado de `--help` en Node 24.20.0 y Bun 1.4.2 también es histórico. El precursor B2/R13 registró una medición posterior en su sección. No se midió baseline comparativo de arranque/memoria, Node 22 ni el layout completo publicado.

La fuente de autorización positiva de M6 continúa deshabilitada. Tampoco se implementó entrega activa de subagentes ni se produjeron los ocho outcomes vivos de A10. La corrección retiró los imports/refusals específicos de esta spec de los owners genéricos de evidencia y receipt, y retiró el veto universal de opt-in de perfiles. Los cuatro owners genéricos y los dos owners de prueba de política obsoleta quedaron iguales a HEAD. La aceptación combina cada prefijo determinista original con el consumer de producción existente; este rechaza la falta de evidencia nativa actual, por lo que A9/A10/A13 siguen pendientes. La preparación de perfil sigue metadata-only y la validación de outcomes no es una fuente de éxito. La corrección no crea dispatch, provenance positiva ni aceptación final; tampoco cierra T6/T11/T12.

## Precursor nativo B2/R13 — hook opt-in para perfiles futuros

La implementación agrega una fila de proyecto opt-in para `Agent/spawn_agent` en PreToolUse, después de los grupos publicados de core/plugins y sin reordenar filas existentes. El modo fijo `codex-pretool-profile` de `model-advisor` se procesa antes del skip advisory habitual. Los mirrors generados se alinearon mediante el renderer normal; no se cambió trust/configuración global ni se activó el hook.

El supervisor lee JSON acotado y valida una respuesta CLI fija. Si el CLI falla, el hook responde deny; si acepta la preparación, devuelve `hookSpecificOutput` de PreToolUse con `permissionDecision: allow` y `updatedInput` que preserva el mensaje opaco, el rol nativo y los demás campos de entrada. Ese `allow` es el protocolo nativo de reescritura para la llamada de herramienta; no es consentimiento humano, grant de publicación ni una respuesta de PermissionRequest. El payload grande cruza por FD3 y no por argumentos de entorno.

La preparación consume un único registro `wx` indexado por checkout canónico, sesión y call ID. UUID, rol o acción distintos no generan una segunda oportunidad para la misma llamada. El record liga tree/config/inventario, catálogo cerrado y par deseado actuales, además del digest de la acción original. Un error posterior, salida perdida o deny concurrente deja el intento consumido e incierto. No expone runner arbitrario, RPC inyectable ni efecto.

La query de catálogo tiene deadline total de 8 segundos y limpieza de request/proceso/timer; el supervisor tiene 11 segundos dentro del límite nativo de 15 segundos. El hook paralelo no serializa otros hooks ni gana precedencia: otro deny prevalece y otra reescritura o configuración nativa de rol puede cambiar el par solicitado. Errores recuperables propios producen deny, mientras timeout/crash/skip/untrusted/invalid del hook exterior nativo pueden fallar abierto con los argumentos originales. Si no aparece un evento nativo propio que confirme la aplicación del par realmente efectivo, la selección sigue pending/uncertain.

El reducer de candidatos exige IDs exactos de call/activity y rechaza identidades Thread/call/activity en conflicto antes de deduplicar; el fallback del par renderizado local usa las mismas reglas. Candidatos puros, un envelope CLI manual y metadata persistida no autentican un evento host. Codex puede aplicar configuración de rol nativa que sobreescriba el par pedido, por lo que la aceptación futura debe observar el par del evento propio. Un probe descriptivo separado del principal y de query/claim de catálogo tomó aproximadamente 1.1 segundos y dos procesos; no activa el hook ni prueba aplicación por rol.

La evidencia A17 es determinista (33/33), al igual que A15 (51/51); no se ejecutó el hook activado o renderizado, no se cambió trust y no hubo turno nativo de hijo ni efecto. La source guard de M6 permanece en `false`. Los prefijos deterministas A9/A10 pasaron 91/91 y 4/4, pero sus comandos compuestos terminaron con exit 1 por falta de registros native-auth actuales. El bundle midió 1,510,082 bytes (1,474.689453125 KiB), margen de 25,918 bytes bajo el límite de 1,536,000. El A16 de codec y el smoke Node/Bun descritos antes son evidencia histórica, no reejecutada en este precursor.

### Corrección acotada de respuesta del supervisor

La revisión de la primera iteración encontró que el supervisor podía fallar sin respuesta nativa y que `Object.keys` trataba arreglos/primitivas vacíos como opt-out. La corrección captura stdout antes de reenviarlo: si falta el CLI o termina con fallo, señal o salida parcial errónea mientras la shell continúa, descarta esa salida y emite un único deny nativo. Si el supervisor ya emitió un deny válido, la shell lo reenvía una sola vez. Solo un objeto JSON plano no nulo, no arreglo y sin claves propias permite opt-out; arrays, booleanos, números, null, strings y JSON inválido se niegan. El header ahora diferencia los modos advisory de lifecycle del modo fijo de rewrite/deny. A17 pasa 45/45; A15 51/51; `navori gate fast` está verde; el bundle sigue en 1,510,082 bytes (1,474.689453125 KiB) con 25,918 bytes de margen.

Este resultado valida rutas deterministas de error del supervisor, no el manejo de fallos externos del hook nativo: timeout, crash, skip o hook invalid/untrusted del host aún puede dejar pasar argumentos originales. El preview normal inicial de CLI fuente y dist produjo tres deltas: los dos mirrors `model-advisor` autorizados y un mirror Pi fuera de alcance. La propuesta Pi solo reflejaba hash managed y serialización de formato de dos helpers. El renderer normal corrigió después los mirrors autorizados y alineó Pi; la sección siguiente registra ese estado final. En ese estado el hook aún no se había activado y la revisión fresca seguía pendiente; la activación posterior se registra en la actualización de checkpoint.

### Alineación de configuración y salidas generadas

`navori.config.json` fija `branchBase` y `prTarget` en `main`; solo cambiaron esos dos campos. El renderer normal de Node dist dejó current las salidas aprobadas. Los seis perfiles reviewer/publisher de Claude/Codex/Pi indican `origin/main`, `--target main` y, en publishers, `--base main`. Ambos mirrors `model-advisor` contienen el bloque fuente corregido. El primer check scoped halló drift del mirror Pi; el apply normal de Node dist lo resolvió y el preview final reportó 0 pendientes, con diff Pi contra HEAD vacío. El delta Pi era hash managed y serialización de formato de helpers existentes, sin cambio runtime. A17=45/45; fast y scoped están verdes; el bundle mide 1,510,082 bytes. La revisión fresca sigue pendiente; T6/T11/T12 y la aceptación viva permanecen bloqueados.

### Preflight fijo de perfil — resultado pending

`codex profile probe --cwd` toma solo el checkout, consume un intento `wx` por escenario antes de abrir procesos y conserva consumed-uncertain ante error; el mismo escenario no se reintenta cambiando IDs/estado. Reutiliza confinamiento local existente para revisar configuración cargada de MCP/apps/browser/computer, catálogo nativo actual e inventario/resolución principal/core/extra/local. El límite total es 180 s, hasta 12 roles, una oportunidad prospectiva de principal y una de spawn/child-turn por rol en secuencia, con 2 MiB/2048 frames compartidos entre los dos owners de preflight y cero retries. No se afirma límite duro de tokens/costo. El cierre solo cuenta con evento de salida reconocido; que `kill` retorne no demuestra limpieza.

El comando no expone thread/turn start, thread/read/history, command/exec, respuesta de permiso ni creación de child. Si no puede verificar el conjunto de controles nativos, debe quedar pending y detenerse antes de inferencia. El preflight real de la fixture verificó únicamente configuración cargada/confinamiento declarado y salida de procesos reconocida: cero turnos, claim consumido, siete nombres de rol y par actual no soportado/no renderizado, por lo que la selección quedó pending. Esto no demuestra confinamiento de shell a nivel kernel, herencia efectiva en children, trust del hook ni selección por todos los roles. En el checkout actual el comando terminó exit 1 con opt-in requerido, cero procesos y cero turnos; el startup-only default sigue igual.

La corrección pasó A17/A15 52/52 cada una; fast/scoped y render terminaron sin findings/pendientes, y el bundle midió 1,514,590 bytes (1,479.091796875 KiB), con 21,410 bytes bajo el límite. No se habilitó admisión, turnos, UI, autorización humana ni efecto. T6/T11/T12, los ocho outcomes y la review final continúan pendientes.

## Enmienda M7 — consumidor enfocado T11/A9

El comando `codex profile probe --live` autoriza únicamente una fixture propia y aislada.
Antes de inicializar el host en esa fixture, elimina todas las definiciones MCP heredadas
del target y exige configuración MCP efectiva vacía. La proyección del target se lee sin
opt-in y permanece opt-out; los roots, snapshots e identidades del target y de ejecución
se mantienen separados. La identidad de intento liga checkout canónico, snapshot relevante
y escenario; una repetición del mismo snapshot se rechaza, y un cambio relevante constituye
una identidad distinta. La fase baseline observa el inventario y la fase refresh realiza un
dispatch adicional del perfil seleccionado tras el cambio controlado, dentro del mismo
intento.

El presupuesto agregado de preparación, catálogo, dispatch y cierre es 180 segundos, hasta
12 roles, 2 MiB de salida y 2048 frames, con cero retries automáticos y tiempo reservado
para cleanup. Admission exige restricciones nativas reconocidas y cargadas; claves
desconocidas reflejadas por el host no bastan. Todo evento aceptado requiere joins exactos
de identidad de target/fixture, parent, child, role, call, receiver/activity y fuente del
hook. Los candidates se derivan de llamadas nativas reales y del contexto del hook
autenticado; caller JSON, nombres, pares solicitados o timing no sustituyen esa evidencia.

La intención del hook usa anotación interna versionada por campo (`set` con valor o
`inherit`), derivada de la proyección única vigente y revalidada tras refresh. `inherit` solo
es válido cuando la proyección lo declara explícitamente, sin override o diagnóstico
conflictivo; null ambiguo no autoriza herencia. El supervisor real valida el esquema exacto,
rol y correspondencia entre anotación y campos nativos, elimina la anotación antes de
reenviar la respuesta y mantiene la comparación de argumentos opacos. La intención autoriza
resolución del host, pero nunca prueba el valor efectivo.

La selección observada del principal al inicio puede servir como origen para la herencia
solo porque el owner de esta ejecución fija las solicitudes de turno del principal y no
puede cambiar ese par durante la sonda. El hijo debe aportar su selección observada propia y
catálogo soportado. Los perfiles mixtos `set`/`inherit` quedan pendientes cuando no se ha
demostrado la precedencia nativa pertinente. El allowlist de procedencia acepta exactamente
headers 0.162.1 y 0.163.0, conservando invariantes de rol, parent, sesión, path y git
directory.

Esta extensión añade un owner live enfocado sobre el precursor, que ya dejaba explícito que
no cubría T11 ni selección efectiva all-role. El owner conserva `pending` cuando la
admisión, selección, refresh o cleanup no están demostrados; el flujo continúa opt-in y
fail-closed. No cambia `outcome-evaluation.ts`, T6, T12 ni las obligaciones de A10/A13.

La admisión del owner exige que el host refleje `agents.enabled: true` desde la
configuración privada cargada. La lectura nativa usa el wire normalizado nullable de siete
campos: `enabled`, `max_concurrent_threads_per_session`, `max_depth`,
`job_max_runtime_seconds`, `default_subagent_model`,
`default_subagent_reasoning_effort` e `interrupt_message`. Los defaults de modelo/esfuerzo
solo se admiten ausentes o `null`; claves desconocidas, aliases no verificados y tipos
incorrectos mantienen la ejecución pendiente o la detienen antes del turno.

La aceptación requiere cobertura uno-a-uno de cada rol configurado y candidato autenticado,
incluidos locales, además de call/context únicos para baseline y refresh. Repetir un rol
válido con IDs nuevos no satisface el inventario. Cada fase produce además un reporte
estructurado de outcome/reason con esquema cerrado; solo se considera el mensaje completo
del agente ligado al parent y turno nativos actuales. Reports ausentes/malformados quedan
unavailable y conflictos ambiguous; nunca sustituyen hooks, selección, refresh o cleanup
nativos. Un reporte del modelo `blocked/tool_unavailable` es diagnóstico no autoritativo.

Al 2026-10-16 queda una ejecución de inferencia autorizada disponible, con presupuesto de
hasta 180 segundos; la sonda vigente no consume esa siguiente ejecución mediante cambios de
documentación. Un nuevo intento requiere que root establezca una causa concreta; cambiar
el hash documental no autoriza repetir el mismo estado semántico. El límite agregado de
180 segundos, 12 roles, 2 MiB, 2048 frames y cero retries se mantiene, sin límite duro de
tokens/costo.

### Lector de edición/review y barrera de envío

Se autorizó ampliar el lector `review-edit-binding.sh`, su prueba y las salidas generadas
aprobadas para reconocer headers 0.162.1 y 0.163.0 sin relajar identidad, rol, parent,
ownership o ruta. La implementación focal pasó 47/47 (38 del lector y 9 de procedencia),
actualizó un golden Codex y el renderer Node cambió solo el mirror
`.codex/hooks/role-guard.sh` (90 archivos sin cambios). El hook del checkout
en ese momento el hook original seguía fijado a 0.162.1; la activación posterior, autorizada
por el usuario, se documenta en la actualización de checkpoint al final de esta sección.

A20 exacto fue completado por root con 47/47 pruebas y 5/5 goldens, exit 0. El full gate
completo sigue sin aprobación. El full run `44919` fue interrumpido con SIGINT propio,
exit 130, y su log conserva fallas anteriores a la interrupción; no es un gate verde ni un
receipt. El foco de inventario root `97331` falló en 55 ms: esperaba 18
paths y halló 19 por un elemento extra `packages/cli/src/lib/codex/native-integration.ts`.
Después de ese diagnóstico, root completó A21 con la suite removal-parity: 29/29, exit 0,
8.45s, registrada mediante el CLI original compatible. Esto acredita A21; no afirma que se
retirara o excluyera la ruta adicional del inventario. La extensión lectora no es review
aprobada ni readiness de envío.

### A21 removal-parity y diagnóstico separado de metadata sin turno

Root registró A21 cumplida: la ejecución `69571` pasó la suite removal-parity 29/29 en
8.45s y el CLI original compatible registró el resultado. Por separado, el artefacto
`.navori/state/handoffs/t11-model-metadata-no-turn-result.json` observa metadata sin turno.
En Codex 0.162.1, `initialize` y `model/list` devolvieron principal `gpt-6.1-sol`,
`multiAgentVersion: v2`, `toolMode: code_mode_only`; el catálogo contiene el principal, hubo
cero notificaciones de thread/turn y el proceso nativo cerró con salida reconocida. Esto
solo acredita metadata sin turno.

La admisión de la sonda A9 espera metadata `V1`/`close_agent`; la observación `V2`/
`code_mode_only` no satisface ese requisito. Root tiene un pase de diseño en curso para
entender la diferencia, sin solución elegida ni causa establecida. A9/T11 permanece
pendiente. No usar la metadata observada para rebajar el contrato ni para consumir la
ejecución nativa restante.

## Checkpoint parcial autorizado y límite de T11

El usuario autorizó activar el lector del checkout original y preparar un checkpoint parcial
dirigido a `main`, conservando A9/T11 pendiente. La activación aplicó la lista exacta
0.162.1/0.163.0 al lector fuente y su mirror renderizado. El preview/apply oficial actualizó
solo `.codex/hooks/role-guard.sh` (90 archivos sin cambios y ningún archivo Pi); se preservaron
las reglas 0054 y los tres archivos sucios preexistentes. El build Node, preview, apply,
`bash -n`, `git diff --check` y fast gate del checkout original pasaron. Esto no equivale a
una revisión nativa ni a aceptación T11.

El full gate que pasó exit 0 cubrió 436 archivos, 9,227 pruebas aprobadas, 2 omitidas y 0
fallidas; cinco chequeos AST y piso de cobertura en 154 módulos (statements 84.37%, branches
79.1%, functions 89.37%, lines 85.91%). Esa corrida precede al guard de refresh y es
histórica, no una verificación fresca del árbol actual; la fresh full y la review
independiente están pendientes. A18 se renovó tras el guard: 137 pruebas + 5 goldens, root
sesión `51893`, exit 0 y registrada. A19 (9/9), A20 (47 + 5 goldens) y A21 (29/29) están
registradas. Ninguno acredita selección native all-role ni sustituye receipt, review de
envío, commit o PR.

### Diagnóstico de ciclo de vida V2

La metadata privada observada en el host original es Codex 0.162.1, catálogo
`gpt-6.1-sol`, `multiAgentVersion: v2` y `toolMode: code_mode_only`; el escenario aprobado de
A9 espera V1 con `close_agent`. En las fuentes oficiales del tag
[`rust-v0.162.1`](https://github.com/openai/codex/tree/rust-v0.162.1), V2 no registra
`CloseAgent` ([spec_plan.rs](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/core/src/tools/spec_plan.rs#L1300-L1428));
un estado terminal puede seguir residente y eviction tiene su propio cierre
([residency.rs](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/core/src/agent/control/residency.rs#L174-L228)).
El unload por defecto es 60 segundos
([config/mod.rs](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/core/src/config/mod.rs#L3930-L3931));
ocho cierres secuenciales requieren al menos 480 segundos antes de contar inferencia o
refresh, sobre el límite agregado autorizado de 180 segundos.

La alternativa residente no resuelve el contrato demostrado: la capacidad V2 por defecto es
tres hijos, y la traducción examinada no ofrece para eviction el evento de cierre aceptado.
`Completed`, `NotLoaded`, archive y salida del proceso no prueban cierre de runtime ni
ausencia de trabajo latente. La unión de un hijo efímero exacto con el hook sigue unknown,
no está demostrada imposible. No se implementó una aceptación V2 viable ni se eligió un
cambio de contrato. No hubo inferencia adicional: queda una ejecución de hasta 180 segundos,
sin aumentar presupuesto, retries ni aceptar sustitutos de cierre. T11/A9 permanece
pendiente hasta evidencia que satisfaga el contrato vigente o una decisión explícita futura
que lo enmiende.

### Guard de refresh para snapshots obsoletos

Antes de iniciar el refresh, el owner vuelve a comparar la identidad de
`liveProfileSnapshot` con la admitida tras baseline. Si cambió la identidad del target,
rechaza con `target-profile-inputs-changed` antes de otro turno. El control determinista
confirma un solo `principalTurnRequests`, un `turn/start` y cleanup reconocido. La regresión
roja de 15 segundos pasó 1/1 después del guard; el grupo de target cambiado, caso paralelo
pending y positivo baseline+refresh pasó 3/3. El guard evita consumir evidencia obsoleta;
no determina la causa del A9 live pendiente ni modifica sus requisitos.
