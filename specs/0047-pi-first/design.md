# Pi first — Design

**Estado:** investigación y challenge independiente realizados; límites conservadores y tres enmiendas aceptados por el usuario el 2026-10-09. E1 no ha iniciado. Workplans de entrega, implementación, revisión de shipping, aceptación runtime y publicación siguen pendientes de sus gates; no es un veredicto de runtime aprobado.

## Approach

Extender el engine Pi de 0040 sobre los contratos compartidos del harness. Pi obtiene soporte por ciclos funcionales verificados, no por contar archivos, agentes o hooks equivalentes a Claude. Mantener el criterio de 0039: nativo primero y calidad > tokens > velocidad. E1/E2 priorizan las cinco brechas confirmadas G1–G5; E3/E4 conservan mejoras posteriores del borrador, sin bloquear la entrega de parches.

Se descarta reescribir 0040 porque borraría la separación entre MVP y garantías nuevas. También se descarta copiar scripts Claude o construir un intérprete universal de hooks: sus eventos, herramientas y permisos no tienen contratos equivalentes.

La documentación instalada de Pi 1.1.0 es evidencia inicial, no una promesa de compatibilidad ilimitada con `0.87.1+`. Cada consumidor de una API verifica la versión soportada y un probe del comportamiento. Se conserva la compatibilidad existente donde las pruebas la sostengan; las incompatibilidades se diagnostican sin ocultar controles inactivos. **R1, R2.**

## Components

- `packages/cli/src/engines/pi/index.ts`, `extension-source.ts`, `trust-source.ts`, `runtime-version.ts`: proyección y runtime Pi; extender responsabilidades existentes, sin nuevo engine. **R2–R6, R9–R11, R13–R14.**
- `packages/cli/src/engines/shared/engine-capabilities.ts`, `ENGINE_CAPABILITIES.pi`, y el inventario de solapamiento existente: declarar soporte real y admisión. No crear un segundo registro con los mismos datos. **R1, R2, R6, R10.**
- `packages/cli/src/engines/shared/harness-plan.ts`, `resolveHarnessPlan`, y `execute-plan.ts`, `commitWrites`: inventario y escrituras neutrales compartidos. **R3, R9, R11.**
- CLI `plan`, `handoff`, `receipt` y sus implementaciones actuales: conservar validadores y formatos; extender detección/evidencia del host solo donde haga falta. **R6–R8.**
- Captura/reportes `audit` existentes: agregar la fuente Pi sin alterar significado de métricas ni duplicar un minero. La localización exacta se confirma antes del milestone que la consume. **R12.**
- `packages/cli/src/engines/pi/__tests__/`: casos de aceptación propuestos descritos en tasks; no confundirlos con las pruebas existentes del MVP/parser. **R1–R19.**
- `renderPiEngine`, composición de instrucciones compartidas y ownership de `AGENTS.md`: contexto operativo autónomo y deduplicado cuando hay otros engines; sin modificar archivos ajenos. **R16.**
- `PI_EXTENSION_SOURCE`, `runChild` y contexto nativo de dispatch: selección explícita de proveedor/modelo y parser incremental acotado. **R17, R19.**

## Decisions

### D1 — Matriz de admisión antes del mecanismo (R1, R2)

Inventariar unidades realmente emitidas y consumidas, incluidos bloques de contexto y plugins. Cada equivalente nativo exige fuente oficial, versión y verificación. Lo desconocido no cuenta como soporte ni como cero. El primer milestone fija probes y actualiza el inventario existente antes de ampliar el runtime. Un retiro usa ownership/prune existentes.

### D2 — Ciclo de roles completo, no otro orquestador (R3, R4, R6)

Ampliar el roster de `navori_subagent` solo a los roles core habilitados que el flujo del proyecto necesita. No copiar el catálogo de Claude por simetría. Reutilizar instrucciones y contratos de handoff existentes: el hilo principal coordina y los hijos no registran dispatch recursivo. E1 ofrece herramientas/skills core y lanza hijos con `--no-mcp` nativo; un rol configurado dependiente de MCP es indisponible con diagnóstico accionable, no se admite silenciosamente ni recibe defaults amplios. Las nuevas operaciones que requieran aprobación se rechazan en el hijo headless y vuelven al padre interactivo TUI/RPC conforme a D3; no se reenvía consentimiento ni se crea un subsistema de autorización/delegación.

Para resolver G2 se elige admitir el scribe existente cuando `scribeOwnsMarkdown` está habilitado: es una extensión del dispatch actual, no un agente nuevo. La alternativa de escribir Markdown desde el principal cambia la separación de responsabilidades vigente y se descarta para este parche. La revisión consume el handoff y el diff conjunto de código/documentación; no se usa Bash para evadir el bloqueo. Ninguna configuración admitida puede prohibir Markdown sin habilitar su productor o diagnosticar la incompatibilidad antes de iniciar la tarea. **R18.**

Conservar profundidad 1, máximo 3 hijos simultáneos, timeout de 10 minutos y escalamiento SIGTERM → SIGKILL tras 5 segundos. El cleanup abarca grupo de procesos y descendientes incluso tras salir el líder; no cancelar el escalamiento solo por el cierre del líder si sobreviven descendientes. El límite de salida acumulada no se conserva: se reemplaza por parsing incremental con registro individual máximo de 8 MiB y texto final máximo de 64 KiB medidos en bytes. No retener deltas ni resultados de herramientas ya consumidos; memoria retenida O(límite de registro + límite de respuesta), independiente del total de eventos. Respetar UTF-8 entre chunks, LF/CRLF y EOF; rechazar JSON malformado, settlement abortado y salida no exitosa. Truncación limita el reporte y no autoriza declarar una tarea completa. **R4, R19.**

El parche local `childParser` es candidato a reutilización, no una aceptación: verificar el diff vigente, sus pruebas, cleanup y compatibilidad con eventos reales antes de integrarlo. Handoff parcial conserva dudas, verificación pendiente y límites alcanzados; no equivale a aprobación. Validar el handoff canónico con la CLI compartida antes de scribe/reviewer. Un resultado textual del hijo no prueba que ese archivo exista.

### D3 — Aprobación humana separada de trust (R5)

Usar los puntos de extensión y diálogos nativos de Pi para las confirmaciones Navori pertinentes; no implementar un permiso universal para toda herramienta. Plan, master-plan y publicación conservan sus aprobaciones aplicables. Credenciales, deploys e infraestructura siguen requiriendo opt-in humano.

`--approve` significa trust de recursos, nunca aprobación del plan o de una operación. La confirmación observable pertenece al padre interactivo TUI/RPC y queda ligada a la operación/plan y objeto/estado aplicables mediante los contratos existentes de plan aprobado/handoff. Denegación, cancelación, cambio del objeto/estado o UI ausente impiden autorización. JSON/print sin UI y los hijos headless rechazan nuevas operaciones pendientes de aprobación y las devuelven al principal. No introducir consentimiento reenviable, tokens de autorización ni un subsistema de delegación; su alcance no se extiende a otra operación.

### D4 — Evidencia observada por el host (R7, R8)

Probar primero, con probes versionados, el contrato terminal real de éxito/fallo de Bash y su cwd efectivo en principal e hijos, incluidas herramientas reemplazadas/anidadas. No inferir éxito de texto, de `isError` por sí solo, de un registro de handler ni de la afirmación del modelo. Correlacionar comando exacto, llamada y resultado terminal y capturar el estado del árbol al terminar. Registrar la observación de evidencia en hijos independientemente del guard de dispatch/profundidad exclusivo del padre, o consumir explícitamente sus eventos correspondientes en el padre; ese guard no debe suprimir observación.

Reutilizar el formato y validación neutral de evidencia/receipt. Conectar eventos terminales nativos con comando/cwd/HEAD/árbol/sesión y criterio, usando el estado compartido; no invocar un hook de Claude ni simular `CLAUDE_CODE_CHILD_SESSION`. La misma tarea ejecutada por el principal o por un hijo debe producir evidencia verificable dentro del camino Pi soportado. Una sesión Pi identificada sin señal suficiente rechaza el cierre verificado, en lugar de degradar silenciosamente a `engine-without-signal`. Mantener explícito el comportamiento de terminales humanas y otros engines sin atribuirles evidencia Pi.

Rechazar criterios obsoletos o de otro worktree. No autoejecutar comandos de aceptación desde Navori. La evidencia es una garantía dentro del camino observado, no protección criptográfica frente a un proceso con la autoridad del usuario. La misma limitación aplica a los controles heredados.

### D5 — Skills y MCP nativos, acceso efectivo explícito (R9, R10)

Reutilizar `.agents/skills` y descubrimiento progresivo para skills core en E1; la integración de `localSkills` corresponde a E3, sin dos cuerpos divergentes. Resolver colisiones y ownership cuando conviven Claude/Codex/Pi.

Pi conserva transporte, conexión, OAuth y precedencia MCP. E1 mantiene MCP apagado en hijos con `--no-mcp`, sin desactivar MCP personal del principal ni tocar credenciales. E3 habilita MCP nativo únicamente después de verificar grants por rol en herramientas directas, discovery, codemode y llamadas anidadas, preservando configuración, precedencia y disablement del usuario. Primero aprovechar configuración nativa existente. Si un plugin habilitado necesita registro de servidor de sesión, usar la API nativa únicamente tras verificar precedencia, disablement y ciclo de vida; no escribir configuraciones personales ni secretos.

Probar la superficie efectiva de cada hijo: `--tools` por sí solo no elimina MCP y codemode puede invocar herramientas indirectamente. Aplicar filtros soportados y verificar discovery/nested calls; una herramienta desconocida no amplía el acceso. Si un plugin o una herramienta no puede mantener su contrato, diagnosticar unsupported en vez de exponer defaults amplios.

### D6 — Operación observable sin duplicar contexto (R11–R14)

Conservar serializers, digest/ownership y `commitWrites`, incluidos dry-run y fallos parciales. El snapshot de engines no Pi no cambia. No tocar recursos globales.

Usar eventos de sesión/resultado nativos para audit y contexto. Identidad explícita de sesión, rol y worktree; estado acotado, deduplicado tras reload/resume. No incorporar transcripciones completas, prompts ni valores de credenciales a logs. Publicar cobertura/incompletitud de métricas. Aviso de atasco aditivo; falla abierta del aviso. No crear un compactor o sesión Navori paralelos.

### D7 — Entregas verticales y definición de primera clase (R15)

E1 entrega un ciclo Pi-only utilizable con contexto, herramientas/skills core, código/documentación, herencia de modelo y ejecución acotada; cierra con revisión independiente observada y receipts/gates existentes bajo verificación humana/host. No presupone enforcement Pi-native de evidencia antes de E2 ni permite afirmaciones de éxito sin evidencia. E2 entrega ese enforcement de cierre evidenciado; E3 integra `localSkills` y plugins/MCP solo con grants efectivos verificados y diagnósticos fail-closed; E4 entrega operación auditable y smoke integral. Cada entrega tiene una demostración observable, no solo un esquema o infraestructura.

No declarar Pi “primera clase” hasta pasar el smoke integral, las fronteras negativas de aprobación/acceso y la no regresión de otros engines. La integración live de un modelo puede ser un smoke manual del usuario; las pruebas automáticas no necesitan su cuenta. Evaluar costo de contexto y resultados en escenarios comparables antes de admitir capas always-on nuevas.

### D8 — Contexto autónomo y modelo efectivo (R16, R17)

Reutilizar la composición neutral de instrucciones para emitir contexto que Pi descubre nativamente. En Pi-only, Navori proporciona `AGENTS.md` bajo ownership compartido; en multiengine, se coordina un único escritor y no se duplica el cuerpo emitido por Codex. Preservar archivos ajenos y diagnosticar colisiones; no sobrescribirlos ni depender de `CLAUDE.md` o `.claude/skills` inexistentes. Probar transiciones Pi → Pi+Codex → Pi, desactivación, contenido ajeno/colisiones de `AGENTS.md` y render parcial bajo ownership compartido: preservar y deduplicar con un único escritor coordinado, sin añadir otro writer. Verificar que las instrucciones emitidas usan las rutas de skills realmente disponibles. El contexto de arranque debe explicar planificación, handoffs, revisión y cierre, no inyectar manuales completos.

Antes de lanzar cada hijo, resolver el modelo efectivo: override de rol explícito o identidad proveedor/modelo del contexto padre. Pasarla explícitamente al proceso/SDK; omitir el argumento no equivale a heredar. Si falta la identidad o el modelo no está disponible, devolver diagnóstico en lugar de cambiar de proveedor silenciosamente. No transmitir credenciales por argumentos ni registrar secretos. Effort/thinking no se redefine en este parche.

## Quality attributes

Matriz específica del proyecto; los tests `first-class-*` son propuestas de aceptación, no resultados ejecutados. El responsable es el componente propietario; implementación y revisión verifican sus pruebas.

| Atributo                   | Criterio medible                                                                                                                                              | Fuente de evidencia                                                | Test                                                                                                                                          | Responsable                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Compatibilidad autónoma    | Pi-only descubre contexto operativo y skills sin recursos Claude/Codex; multiengine no duplica instrucciones y preserva archivos ajenos.                      | Render aislado y discovery del runtime soportado.                  | `first-class-context.test.ts`::Pi-only bootstrap and multiengine ownership (R16).                                                             | Renderer Pi + composición compartida |
| Completitud funcional      | Una tarea de código y Markdown con ownership activado produce ambos y revisión conjunta sin bypass ni rol inaccesible.                                        | Fixture de ciclo y handoffs/diff observados.                       | `first-class-roles.test.ts`::code and documentation reviewed together (R18).                                                                  | Dispatch Pi + handoffs compartidos   |
| Confiabilidad de evidencia | Solo comando exacto exitoso y evidencia del árbol vigente permiten cierre; ausencia, fallo, comando distinto, otro worktree y evidencia obsoleta se rechazan. | Eventos terminales reales y validadores de aceptación/receipt.     | `first-class-evidence.test.ts`::parent and child evidence; `first-class-receipts.test.ts`::reject missing failed and stale evidence (R7, R8). | Evidencia compartida + eventos Pi    |
| Robustez de ejecución      | Procesar más de 256 KiB acumulados sin cancelación artificial, registros ≤8 MiB y respuesta ≤64 KiB; abort/timeout nunca resultan en éxito.                   | JSONL por chunks, límites y lifecycle del runtime.                 | `first-class-lifecycle.test.ts`::bounded incremental stream and cancellation (R4, R19).                                                       | Runtime Pi                           |
| Compatibilidad de modelos  | Override explícito prevalece; sin override se transmite exactamente proveedor/modelo del padre aun si el default global es distinto.                          | Argumentos efectivos y fixture SDK/runtime.                        | `first-class-roles.test.ts`::explicit model and exact parent inheritance (R17).                                                               | Dispatch Pi                          |
| Mantenibilidad             | No añadir copia de hooks, motor de planes/receipts ni transporte/auth propios.                                                                                | Diff del milestone y revisión de responsabilidades frente a D1–D8. | Revisión de diseño/diff: una prueba automática no demuestra por sí sola ausencia de duplicación semántica.                                    | Adaptador Pi + revisión de diseño    |

## Contracts

- Estados de control existentes: enforced exige denegación/activación observada en runtime y frontera documentada; advisory no se vende como permiso; unsupported exige razón.
- Extensiones y tool allowlists no son aislamiento OS. El proceso conserva autoridad de usuario, entorno, shell y acceso a extensiones.
- `tool_call` puede bloquear; los handlers de nested `executeTool` también participan en el pipeline según Pi 1.1.0. Verificar con MCP/codemode real de fixture antes de depender de ello.
- Confirmaciones y evidencias no se reconstruyen de una frase del modelo. Formatos compartidos siguen siendo la fuente de verdad.
- Ningún cambio de archivos/agentes/plugins ni configuración de otro engine se admite fuera del milestone aprobado.

## Failure modes

- Versión/API desconocida o evento insuficiente: diagnóstico y estado unsupported/advisory; nunca falsa equivalencia.
- Falta de UI: rechazar la operación que requiere aprobación, indicar cómo retomarla con UI; no bloquear indiscriminadamente investigación.
- Timeout, cancelación o resultado truncado: estado parcial explícito, cleanup idempotente y sin hijos huérfanos.
- MCP desconectado/disabled, herramienta desconocida o indirecta no filtrable: no ampliar acceso; informar qué función está indisponible.
- Reload/resume, eventos duplicados o trabajo simultáneo: separar identidades y evitar doble evidencia/avisos.
- Escritura parcial o digest inválido: preservar edits ajenos y backups; informar destinos afectados, sin prometer transacción multiarchivo.

## Testing strategy

Los casos propuestos están en tasks. Cubren runtime pinneado sin credenciales, Pi-only sin contexto de otros engines, roles/config/modelos, escritura y revisión de documentación, UI ausente, trust distinto de aprobación, handoffs inválidos, streams extensos/UTF-8/límites/cancelación, evidencia fallida/obsoleta, acceso MCP indirecto, multi-engine ownership, audit redaction y reload. Usar stubs para fallos deterministas y probes versionados del runtime real para resultados terminales/cwd efectivo de Bash, herramientas reemplazadas/anidadas, selección de modelo y exposición efectiva. Incluir consentimiento observado ligado a operación/plan/estado y sus negativos, hijos E1 sin MCP y roles MCP indisponibles, observación de hijos independiente del guard de dispatch, descendientes vivos tras salir el líder con escalamiento conservado, y transiciones Pi → Pi+Codex → Pi/desactivación/render parcial con contenido ajeno de `AGENTS.md` preservado. E1 verifica revisión independiente y receipts/gates existentes mediante humano/host; E2 verifica enforcement Pi-native, sin éxito sin evidencia en ninguna entrega. Un proveedor determinista de fixture evita usar cuentas reales; no omite el pipeline host que se pretende probar.

Cada test nuevo declara `// Covers: R<n>`. Al añadir contexto always-on, registrar en `evals.md` durante E1 una comparación aislada RED/GREEN: mismo proyecto/tarea/modelo, solo cambia el contexto Pi; escenarios de arranque Pi-only, planificación y cierre. Conservar resultados adversos. Esta evaluación complementa, no reemplaza, las pruebas de discovery y control ni el smoke integral.

La versión instalada 1.1.0 debe probarse explícitamente antes de anunciar soporte; el pin 0.87.1 no la certifica. A1 registra las versiones admitidas y pruebas reproducibles. No elevar la versión mínima ni agregar dependencias sin justificar el cambio en el workplan aprobado. El smoke A7 prueba el resultado funcional completo y sus negativos, no solo registro de herramientas.

## NOT in scope

Paridad por número de hooks, OAuth/transporte MCP propios, sandbox OS, nuevos agentes por conveniencia, recursión/background, instalación global/comunitaria, reemplazo de Codex, despliegue o publicación durante el scaffolding. Tampoco reescribir la historia de 0040.

## Revisión y gates pendientes

La revisión directa y los intentos fallidos de dispatch sin artefactos son historia, no revisión independiente. El 2026-10-09 se completó un scout independiente, acotado y de solo lectura mediante CLI, con challenge sobre fronteras de aprobación, acceso, evidencia, lifecycle y ownership; el orquestador sintetizó sus hallazgos y el usuario aceptó los límites conservadores y las tres enmiendas. B1 se aborda en la spec con consentimiento observable del padre interactivo TUI/RPC, ligado a la operación/plan y objeto/estado aplicables, y rechazo de nuevas operaciones pendientes de aprobación en hijos headless. B2 se aborda con `--no-mcp` en hijos E1 hasta verificar grants efectivos en E3. C5 se aborda delimitando el cierre E1 con revisión independiente observada y receipts/gates existentes frente al enforcement Pi-native de evidencia en E2; no se afirma un fix runtime.

El scout no es un receipt de reviewer de shipping ni evidencia runtime A1–A7, que permanece sin ejecutar. E1 no ha iniciado. La aceptación de límites de la spec no sustituye los workplans y aprobaciones de implementación por entrega ni los gates de revisión, runtime o publicación. El candidato local de parser permanece intacto, no aceptado y pendiente de su propio ciclo de revisión.
