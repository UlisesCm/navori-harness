# Auditoría accionable con paridad Codex — Design

**Signals:** contrato compartido cross-engine, datos sensibles, identidad concurrente y lifecycle de hooks/colector.
**Estado:** propuesta para challenge; no es un veredicto ni una implementación.

## Approach

Extender el audit existente con adaptadores explícitos, disponibilidad por métrica y eventos mínimos de resultados en sus logs. Reportes derivados unen ejecuciones, reviews y receipts; no hay nuevo board, base de datos, daemon ni dependencia. Prioridad: verdad y seguridad; luego consumo/velocidad/calidad; finalmente escala medida.

### Decision drivers

- `docs/DIRECTION.md` / North Star, No-metas e invariantes 3, 5, 7, 9: endurecer lo existente, calidad antes de tokens/velocidad, opt-in y no ejecutar herramientas del agente.
- `docs/EXTENDING.md` / escalera de ownership: evitar doctrina always-on nueva; contratos técnicos viven en código y esta spec.
- `AGENTS.md` / Operations on data and infrastructure y SDD: no mutaciones históricas ni servicios reales; tests trazables y review del diff.
- R1–R22: paridad de significado, privacidad, atribución demostrable y comparaciones que no conviertan ausencia en éxito.

### Options

1. **Patrón actual reparado, métricas solo por sesión.** Viable para corregir host, permisos y errores inmediatos; barato y reversible. Se descarta como solución completa: `audit/snapshot.ts` / `RangeSnapshot` no tiene outcome ni cohortes, y no satisface R16–R19.
2. **Extensión localizada del audit — recomendada.** Agregar contratos tipados a los adaptadores actuales y eventos de resultado al mismo log; persistir proyecciones en los comandos que ya validan sidecars/receipts. Permite recuperación histórica read-only y entrega incremental. Costo: actualizar consumidores de JSON y probar contexto cross-engine; reversión: mantener readers viejos, desactivar captura nueva sin borrar logs.
3. **Nueva abstracción de ledger normalizado dentro de audit.** Viable si múltiples consumidores necesitaran reconstruir cada request y outcome durablemente; ofrecería replay e índices uniformes. Requiere nuevo esquema, backfill y doble ownership de eventos que hoy poseen hooks/CLI. No elegida: R16 puede conservar outcomes en el log actual; no hay evidencia de consumidores que justifique esa superficie. No se propone un servicio alternativo prohibido como falsa opción.

## What already exists

Verificado con `git fetch origin main` el 2026-10-03: `origin/main=def644035da9ca834110f528424a638f82352e22`, anterior a la release base `72332f7b`. Los anchors siguientes existen en ambos refs salvo la excepción explícita.

- `packages/cli/src/lib/audit/parse.ts` / `sumTokens`, `parseSession`, `attachHookEvents`: ownership de uso Claude y unión de hooks. `parseCodexSession` existe en main, pero `readCodexRollout` y `discovery.ts` / `resolveCodexRollout` solo en release; no trasladar conclusiones sobre esa capacidad a main.
- `audit/model.ts` / `SessionAudit`, `AuditReport`: contrato de reporte; release usa schemaVersion 10.
- `audit/discovery.ts` / `findMarkedSessions`, `repoCoverage`: índice por marker y cobertura; extensión suficiente para selección de fuentes, no para outcome.
- `audit/cli-event.ts` / `appendCliEvent`: append exacto con protección de symlink del archivo; solo contexto Claude hoy.
- `handoff/review-schema.ts` / `ReviewSidecarSchema`, `logReview`: sidecar validado y hash. Findings no registra reviews sin hallazgos: no sirve como historia completa de rondas.
- `diagnose/receipt.ts` / `ReceiptResult`, `signReceipt`, `checkReceipt`: evidencia de diff/gate; `checkReceipt` realiza fetch y `signReceipt` escribe objetos git. Audit no debe llamarlos para enriquecer reportes.
- `audit/report.ts` / `buildReport`, `audit/signals.ts` / `reviewerGateLifecycle`, `audit/snapshot.ts` / `buildSnapshot`, `compareSnapshots`: reporte, señales y snapshots numéricos aprovechables.
- `audit/collect.ts` / `flattenOtlp`, `startReceiver`, `audit/launchd.ts` / `installLaunchAgent`, `uninstallLaunchAgent`: único receptor existente y declaración supervisada.

## Components and ownership

| Componente/anchor                                                                                 | Responsabilidad propuesta                                                                                | Requisitos         |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------ |
| Hooks core / `audit-mode-trigger`, `session-start-context`, `_partials/audit-log`; renderer Codex | Host/ID autoritativos, metadata mínima, writers privados; render, no edición manual de mirrors           | R1, R9–R11         |
| `audit/discovery.ts` / resolvers y coverage                                                       | Validar identidad/formato, recovery derivado, población por host, filtrado temprano e índice por corrida | R2, R3, R8, R21    |
| `audit/parse.ts` / adaptadores + `audit/model.ts`                                                 | Usage allowlisted, identidad de ejecución, dedup, ventanas y disponibilidad                              | R4–R7              |
| `audit/cli-event.ts` / `appendCliEvent`; primitivas audit locales                                 | Contexto exacto y escritura segura reutilizada por CLI/receiver                                          | R9–R11, R16        |
| `commands/handoff.ts` / log-review; `commands/receipt.ts` / execute                               | Capturar resultado validado mínimo antes de desaparecer sidecars/receipts                                | R16–R18            |
| `audit/report.ts`, `signals.ts`, `snapshot.ts`                                                    | Denominadores, outcomes, toll, cohortes y recomendaciones                                                | R6, R14–R20        |
| `audit/collect.ts`, `launchd.ts`; `commands/audit.ts`, `global.ts`                                | Validación OTLP, límites/cierre, lifecycle transaccional y salud                                         | R10, R12, R13, R22 |

## Contracts and decisions

### D1 — Fuente e identidad, no rutas como prueba (R1–R3, R8–R9)

Un marker declara host, runtime session ID y cwd. Resolver devuelve host declarado/recuperado/desconocido, fuente, adapter/version y motivo; una ruta `.codex` solo es pista para localizar. Se confirma con forma de registros e identidad raíz del archivo; registros heredados no cambian el propietario. Conflicto header/formato/ID = wrong-format o identity-conflict, no sesión válida vacía. Históricos sin host recuperan únicamente desde metadata verificable; nunca reescriben archivos. Archivos vacíos, truncados antes de metadata o metadata ambigua permanecen desconocidos.

Rango de cobertura: sesiones cuya **primera activación audit o inicio host** está en `[from,to)`, ambos timestamps normalizados UTC; mtime no representa inicio. Exponer cobertura de activación distinta de actividad durante rango. Roots y children separados, identities deduplicadas; población no enumerable = null con razón. Reportar numerator y denominator, no esconder markers recuperables o huérfanos.

Contexto CLI explícito `{host,sessionId}` por opciones del comando o `NAVORI_AUDIT_HOST` + `NAVORI_AUDIT_SESSION_ID`; precedencia opciones > par completo env > fallback host validado. Claude conserva `CLAUDE_CODE_SESSION_ID`; Codex puede usar `CODEX_SESSION_ID`/`CODEX_THREAD_ID` únicamente después de confirmar coincidencia con marker e identidad del rollout. Evidencia metadata-only del coordinador: ambas variables coinciden con runtime ID en root actual; no se asume lo mismo en children. Si sesión raíz y thread difieren se requiere relación explícita verificada, nunca elegir por recencia. Conflictos rechazan captura. Validar contra header exacto y checkout/repo; no latest. Los hooks pasan datos del payload a los comandos que invocan. **Un export dentro del hook no modifica el entorno del futuro shell Codex**: CLI invocado por el agente debe recibir contexto explícito desde contexto de sesión generado, sin repetirlo en prosa general. Si un host no permite propagación estructurada, declararla parcial y testear el camino explícito; no deducir ID de cwd. Parámetros de audit no alteran identidad funcional de receipts.

### D2 — Disponibilidad compatible y usage por proveedor (R4–R7)

Agregar `metricAvailability` tipado, por familia/componente con `observed|partial|unavailable|unsupported|invalid`, razón estable, fuente y adapter. Valores sin observación = null en JSON nuevo; cero solo con observación válida. No convertir indiscriminadamente cada modelo interno: adaptar fronteras report/snapshot y garantizar que todos los agregadores lean disponibilidad. Cambio de nullability exige schemaVersion 11; readers aceptan 10 sin inventar disponibilidad. `TokenTotals` interno Claude observado puede mantenerse numérico; vista pública de uso es nullable por componente. Sin evidencia, JSON viejo de Codex con cero es legacy-unknown.

Uso Codex se proyecta desde campos numéricos/IDs versionados, jamás contenido. Request/response identificado preferido; eventos `token_count` acumulados son fallback, no sumandos adicionales. Desglose publicado incluye input total, input no cacheado derivado solo cuando inclusión está confirmada, cache-read, cache-write y output. Reasoning incluido en output se expone como subconjunto, no se añade. En el protocolo Codex v0.160.0, `TokenUsage.cache_write_input_tokens` es un campo reconocido con valor predeterminado de serde; un número positivo observado se conserva, y si el miembro se omite en el registro, cache-write queda null/no disponible/no observado, no `unsupported` ni cero observado. Se conserva la restricción matemática de que, con input observado igual a cero, cache-write no puede ser positivo. Reservar `unsupported` para una capacidad demostrablemente ausente en el proveedor o versión identificados. La evidencia de `TokenUsageRecord` incluye identidades de thread/turn/session/root-turn/response, pero una secuencia de snapshots acumulados o reiniciados sin propiedad atribuible no permite inferir balance inicial ni sumar importes por respuesta: la métrica queda conservadoramente parcial/no disponible. [Protocolo oficial Codex v0.160.0](https://raw.githubusercontent.com/openai/codex/rust-v0.160.0/codex-rs/protocol/src/protocol.rs). Valores deben ser enteros finitos no negativos y consistentes; discrepancias marcan parcial.

Identidad: `{host,threadId,responseId}` para uso; `{threadId,turnId}` y call IDs para actividad. Copias entre archivos se deduplican en ámbito del reporte usando IDs de origen; padre/child se atribuyen por metadata estable, no por timestamps reescritos. Contadores acumulados aislados generan deltas únicamente dentro de una secuencia identificada; un reset abre segmento nuevo y no imputa el saldo inicial desconocido. Totales y deltas nunca se suman juntos; faltan IDs/ownership = consumo observado parcial no atribuido, excluido de tokens por tarea. Children asociados no se suman de nuevo al root si ese total ya los incluye. Modelos mezclados se desglosan; precios/cuotas no inferidos.

Ventana wall-clock usa mínimo/máximo de timestamps de actividad propia y start/stop válidos. Idle no es activo. Intervalos activos se unen para evitar doble conteo paralelo; ausencia de pares inicio/fin = parcial. Líneas/error counts separados por fuente más total; línea final incompleta de archivo vivo se distingue de corrupción.

### D3 — Escritura privada y minimización (R10–R11, R13)

Asset: transcripts, prompts y reportes locales. Actor: proceso local no confiable o input/log hostil. Boundary: hook/CLI/OTLP hacia filesystem de audit. Amenazas: exposición local, escritura fuera de root y contaminación de métricas.

Enumeración de writers: `commands/audit.ts` start/stop/arm/spool-drain/report/copia session.log/sessions.txt; `_partials/audit-log.sh` hooks/spools; `audit-mode-trigger.sh` prompt metadata; `cli-event.ts`; `collect.ts`; `snapshot.ts` write/save-baseline/copy; `launchd.ts` logs de supervisor/plist temporal. Todos los destinos nuevos privados 0700/0600 desde creación, no después. No chmod directorios padres del usuario ni archivos existentes. Reusar destino existente solo si regular seguro y privado; si no, advertir y saltar captura/export sensible. No sobreescribir symlinks; validar componentes directorio y raíz, abrir archivos con no-follow/exclusive cuando corresponda, verificar fd y cerrarlo siempre. Exportar snapshot público requiere acción explícita; default privado.

Eventos nuevos guardan IDs/timestamps, contadores, enums y hashes; no prompt/output/tool scripts. Hooks guardan prompt tipo/longitud y metadata de transcript, no texto. Reportes default omiten initialPrompt y ejemplos libres; contenido humano requiere `--include-human-content` explícito por generación (no always-on), destinos privados y sin snapshot compartible. Históricos se leen sin expandir contenido ni copiar session.log crudo por defecto. Categorías diagnósticas allowlisted; nunca free-form reason como clave de snapshot.

El hook pasa a la CLI el contexto explícito `{root, host, cwd, sessionId}`. Antes de cualquier escritura, la CLI valida la solicitud y el marker `.armed` privado, cuyo payload contiene `{ts, cwd}`, contra la raíz y el proyecto canónicos. Luego crea el reclamo fijo `.armed.claim` de forma privada y exclusiva; si falla o el resultado es ambiguo, no se inicia ni se limpia un reclamo de propiedad incierta. Bajo el reclamo confirmado, se vuelve a leer y validar la generación originalmente observada, incluida su identidad `dev/ino/size`; solo esa generación se consume. En `finally`, la CLI comprueba token propio e identidad privada antes de retirar su reclamo. La limpieza debe quedar confirmada antes del inicio ordinario; si falla, no se inicia. La armación puede quedar consumida aunque el inicio posterior falle.

Este protocolo cubre consumidores cooperantes en filesystem local verificado; no promete exclusión general en filesystems de red ni transaccionalidad frente a escrituras hostiles del mismo usuario, carreras de ancestros o reutilización ABA de la identidad observable. Un crash o una limpieza no confirmada puede dejar `.armed.claim` y bloquear futuras activaciones implícitas hasta inspección y retiro explícitos por un operador. No hay recuperación automática, TTL/PID heurístico, reparación con chmod ni borrado automático de reclamos existentes.

OTLP loopback mantiene receiver existente: nombres/atributos allowlisted, IDs validados, límites body 8 MiB, string metadata 256 bytes y máximo 1,000 records por request; campos desconocidos rechazados/descartados con contadores, no persistidos. No autentica emisor local: residual riesgo documentado de falsificación por un proceso que conoce ID; no afirmar integridad criptográfica. No ampliar red ni introducir tokens secretos en esta spec.

### D4 — Lifecycle observable y acotado (R12, R21–R22)

Control launchd inyectable. Consulta cargado debe distinguir not-found de error; un error no autoriza remover/reemplazar. Si job cargado, bootout y comprobar ausencia antes de borrar declaración o reemplazar. Fallo preserva plist y error con salida no exitosa; bootstrap fallido no es instalación saludable. Fake controller + HOME temporal; nunca pruebas contra launchd real. Stdout/stderr supervisor nuevos se precrean privados; existentes inseguros no se cambian.

Discovery filtra header/rango antes del fallback, índice de paths una vez por reporte con presupuesto; reader incremental de líneas evita split de archivos completos. Cotas iniciales: línea 1 MiB, 100,000 eventos retenidos por sesión, 10,000 sesiones por reporte e índice máximo 100,000 paths. Omitir/truncar marca parcial y cuenta pérdida; resultados truncados no son mejora. Validar presupuestos mediante benchmark sintético, no por prueba con datos personales.

Los miners se ejecutan solo para la población explícita de sesiones Claude elegibles; las familias solicitadas exponen únicamente su evidencia correspondiente. Activación usa una pasada acotada para nombres técnicos canónicos y después una pasada semántica compartida; Search/CodeGraph y sus subagents comparten una sola pasada. El parser ordinario conserva su recorrido aparte. Entradas inmutables reservan presupuesto antes de retenerse; el tail unido de assistant conserva sus últimos 1,500 caracteres, se cobra por longitud UTF-8 y se limpia al terminar cada archivo. La enumeración de archivos también es incremental y acotada. Además de los límites anteriores, cada reporte limita facts a 100,000, bytes técnicos a 256 y cada fact normalizado a 2,048 bytes.

La secuencia admitida conserva paridad numérica: una línea JSON malformada se excluye del conteo de eventos como antes, pero vuelve parcial la evidencia. Omisiones de filas válidas, paradas tempranas, UTF-8 inválido, líneas sobredimensionadas o límites de estado suprimen correlaciones diferidas que podrían cambiar. Ratios, grados y ceros parciales quedan null; población ausente/no disponible no equivale a población admitida y completa sin eventos, que sí observa cero. Bytes leídos son la suma real por lectura (incluida lectura adelantada); pérdidas se reportan por pasada y no representan eventos lógicos únicos. Esto no promete integridad universal de fuentes, protección ABA o de filesystems de red, ni límites globales de I/O, tiempo, RSS, facturación u outcomes.

Mediciones sintéticas observadas en procesos seriales frescos, Node v24.20.0, Darwin arm64. En el parser, cada corrida procesó y leyó 524,288,000 bytes; RSS se muestreó antes y después de cada uno de diez archivos, no como pico continuo. Se retuvieron 10 facts, 10 paths y 10 sesiones, sin pérdidas.

| Corrida del parser | Tiempo          | Delta RSS muestreado |
| ------------------ | --------------- | -------------------- |
| 1                  | 937.955208 ms   | 39,141,376 B         |
| 2                  | 960.589458 ms   | 40,648,704 B         |
| 3                  | 1,000.009584 ms | 39,206,912 B         |
| Mediana            | 960.589458 ms   | 39,206,912 B         |

Comando reproducible para esas tres corridas: `cd packages/cli && NAVORI_AUDIT_BENCHMARK=1 bun run test -- src/lib/audit/__tests__/parse.test.ts -t 'benchmarks ten synthetic 50MiB rollouts'`.

| Probe del miner |    Entrada / bytes leídos | Pasadas completas |        Tiempo | Delta RSS muestreado | Retenido y pérdida                                                     |
| --------------- | ------------------------: | ----------------: | ------------: | -------------------: | ---------------------------------------------------------------------- |
| Completo        | 19,516,000 / 37,884,000 B |             3 / 3 | 125.698541 ms |         38,600,704 B | 17 facts, 1 path; sin pérdidas                                         |
| Parada temprana |    12,240,000 / 131,072 B |             0 / 2 |   0.627875 ms |            163,840 B | 17 facts; remainder desconocido, ≥2 omisiones de lectura entre pasadas |

El probe completo midió RSS antes y después del miner síncrono, no pico continuo. El probe temprano usó topes de 30 facts y 20 eventos; retuvo 17 facts. Su omisión de facts fue cero: el contador inferior ≥2 registra intentos de lectura omitidos entre pasadas, no filas lógicas distintas, y corresponde al límite de eventos. No se suma como pérdida del presupuesto de facts. Son casos medidos en este host, sin inferir mejora causal o universal. La aceptación enfocada pasó 639 pruebas y omitió 1 benchmark opt-in; lint y tipos pasaron. El bundle medido fue 1,228,783/1,228,800 B (17 B libres).

La revisión independiente de T8 aprobó miners acotados y alineación con main. El gate completo pasó: 7,750 pruebas aprobadas, 2 omitidas, 361 archivos, piso de cobertura de 118 módulos (1 excepción documentada) y bundle de 1,228,783/1,228,800 B. El probe más reciente usó Node v26.10.0 en Darwin arm64; los valores de Node v24.20.0 anteriores son mediciones históricas y no se presentan como nuevas. RSS se muestreó antes y después, no como pico continuo. Esta aprobación es de alcance T8, no de toda la PR ni de T9+; la revisión semántica completa de la PR sigue pendiente.

Receiver: caches LRU máximo 1,024 IDs y TTL 30 min, sin caché de hechos de autorización: existencia/seguridad del marker se revalida al escribir. 32 conexiones activas, timeout de request 30 s, cierre idempotente elimina ambas señales, cierra sockets/listener y devuelve contadores. Spools acotados de eventos metadata con pérdida visible; jamás podar logs históricos automáticamente. Salud muestra RSS/proceso/store metadata, no diagnostica fuga desde KeepAlive. Retención solo propuesta read-only; autorización futura independiente.

### D5 — Outcomes mínimos, no certificación nueva (R14–R18)

`handoff log-review` emite al log de sesión **una revisión aunque findings=0**, con feature, hash del sidecar, verdict normalizado, counts por severidad y timestamp de observación. El timestamp de logging NO es el timestamp de revisión. Sidecar original carece de evidencia del diff revisado: legacy/missing permanece `uncorrelated`, aunque logging y receipt coincidan con HEAD actual.

Para nuevas corridas, el **productor reviewer** captura un fingerprint verificable antes de examinar el diff y lo valida al completar la revisión, antes de emitir el sidecar. La evidencia opcional versionada del sidecar contiene algoritmo, fingerprint del contenido revisado, base, head, identidad gate/inputs y timestamps de producción; el algoritmo determinista incluye blobs de working/index y paths seguros, no solo HEAD. Si el contenido cambia durante la revisión, no existe evidencia correlacionable del diff final: se requiere revisión nueva o resultado `uncorrelated`; no se reetiqueta APPROVED con fingerprint final. No basta añadir un hash calculado únicamente al terminar/loggear ni un hash declarado sin validación del productor.

`log-review` valida forma/procedencia y comprueba que fingerprint producido sigue correspondiendo al contenido local; nunca crea ni repara la evidencia ausente. La proyección del receipt usa el mismo algoritmo/identidad de contenido y su manifest verificable. Audit exige igualdad de evidencia **producer-time** review/receipt para aceptación. Mismatch, algoritmo desconocido o evidencia insuficiente conservan la revisión como observación sin aceptación, sin afectar la autoridad funcional existente de review/receipt. Esta extensión toca schema opcional y protocolo del productor reviewer; la frontera de implementación debe incluirlos, no inferir correlación solo en report.

`receipt sign/check` emite la proyección del resultado que **ya calculó** el comando: status/fresh/stale, feature, base/head, identidad de inputs/gate y hash del receipt cuando disponible; no ejecuta checks adicionalmente ni persiste comandos/files/errors libres. Audit report nunca llama `checkReceipt` porque dispara fetch. Un fallo de observación no cambia resultado del comando. Con exact context faltante, evento no se escribe y cobertura queda desconocida. Eventos se deduplican por feature+diff+tipo+hash/evidence identity; dos sesiones no crean dos rondas por releer sidecar idéntico.

Aceptación = review APPROVED correlacionado + receipt ok/fresh del **mismo diff**, denominada aceptación local técnica, no cierre Jira/merge. Review legacy/missing producer-time evidence, mismatch, desconocido/stale gate/conflicto = tarea no aceptada. Gate inexistente no es pass. Primer review conocido no implica primera aprobación si historia está incompleta. Gate fallido solo desde evento de ejecución/resultado verificable; ausencia receipt no prueba fallo de tests. Branches/duraciones para sample floor vienen únicamente de gates correlacionados, sin sumar sesiones vacías.

Unidad tarea `{repo identity,feature}` con revisiones de diff; reuso del slug después de aceptación inicia episodio nuevo identificable, o ambiguo si faltan boundaries. Eventos de trabajo/etapa proceden de plan/handoff explícitos con sesión+feature; una sesión puede tener varias features y su usage no se reparte por porcentaje inventado. Tokens por tarea únicamente para intervalos atribuibles; tiempos hasta aceptación usan inicio observado, abiertas son censuradas. Esperas humanas/CI solo cuando están identificadas; restante es tiempo sin clasificar, no tiempo activo. Persistir outcomes mínimos en el log existente protege contra consumo/limpieza de fuentes efímeras sin crear un board.

#### Addendum D5 — decisiones de T9a (evidencia del productor)

- **Verbos**: viven bajo `navori receipt review begin|seal <feature>`; `begin` sella antes de leer el diff y `seal` valida al terminar, antes de emitir el sidecar.
- **Identidad**: `navori-content/v1` hashea solo el working tree; `indexDiverges` se reporta fuera del hash.
- **Stamps por nonce**: cada `begin` produce un stamp identificado por nonce; `seal` lo exige con `--nonce`. Exit 2 = el contenido cambió durante la revisión; cualquier otra negativa, exit 1.
- **B1/B2**: B1 rechaza sellar si ya existe evidencia o si el sidecar es más antiguo que el stamp (mtime del archivo stamp, no `startedAt`, para evitar flakes por mtime grueso). B2: con `qualityGate.full` vacío o ausente no se emite campo `gate` en stamp, evidencia ni evento, y esa evidencia nunca satisface la aceptación local técnica (gate inexistente no es pass). Aparte, por la base de D5, evidencia ausente o inválida deja la revisión `uncorrelated`.
- **featureKey**: el evento guarda `sha256(repo + NUL + feature)`, no el feature en claro.
- **Tally**: los eventos `*-outcome` se excluyen del conteo de eventos de uso/tally.
- **Publisher**: `handoff check --for publisher` emite WARN (no fallo) si falta la evidencia de review.
- **Límite de confianza residual**: un agente con shell puede forjar el stamp y el sidecar; `begin` no prueba el orden de lectura. Es atestación del productor, no certificación.

#### Addendum D5 — decisiones de T9b

- **Proyección del receipt**: `receipt sign/check` proyecta el outcome con un observer que no lanza. El sandwich compara fingerprint+head, no base, porque el fetch de inspect mueve `origin/<target>`. `sign` cuenta como fresh.
- **Sin contexto de audit**: no se calcula ni se escribe nada. Con `qualityGate.full` vacío no se emite `gate` y nunca se acepta.
- **Join puro** (`outcomes.ts`): se indexa por nonce; la última ronda correlacionada por fingerprint decide (B3) y se exige igualdad de la tupla de identidad completa.
- **Episodios**: fingerprint nuevo tras aceptación = episodio n+1; sin boundaries es ambiguo; sin inicio observado, left-censored; abierto, censurado.
- **Report**: clave aditiva `outcomes` en v11, con availability `outcomes.review` y `outcomes.receipt`. La etiqueta sale de `featureKey` (el slug crudo es irrecuperable por diseño). El report nunca llama `checkReceipt` ni lanza git.

#### Addendum D5 — decisiones de T10a

- **Contrato dispatch-outcome**: payload cerrado `{schemaVersion 1, featureKey hex64, stage 'implement', spawn? tool_use_id acotado}`, veredicto solo `allow`. Lo emite `navori plan gate` únicamente en allow resuelto desde una apertura `workplan:` (nunca nivel-0 ni deny). La emisión es fail-safe: ocurre tras fijar el exit code y un fallo no lo altera.
- **Sesión**: se toma del payload del hook y se valida contra la identidad ambiente (R9); contradicción = no se escribe.
- **Vínculo spawn↔run**: `tool_result.tool_use_id` ↔ `toolUseResult.agentId`, incluido `async_launched`. Los runs anidados cuentan como no vinculados.
- **Dispatch sin confirmar**: nunca abre tarea, episodio ni boundary (B1).
- **Codex**: dispatches no vinculables; availability parcial, nunca cero.
- **Report**: `outcomes.dispatch` con availability y conteos de huérfanos (`dispatchWithoutRounds`, `roundsWithoutDispatch`, `unconfirmed`). Dedup por (sesión, spawn, featureKey); sin spawn no se deduplica y cuenta como unconfirmed.
- **Decisiones adoptadas**: alcance de tokens solo `implementer`, con `reviewer` como follow-up; worktrees externos quedan como residual visible vía conteos de huérfanos; espera humana = idle entre turnos solo en Claude, estratificada por host.
- **Orden de split**: se invierte; primero el emisor (T10a), luego las métricas R17/R18 (T10b).

### D6 — Comparación y acción (R15, R17–R20)

Snapshot formato 2 conserva métricas numéricas, disponibilidad, N y cohortes: repo por identificador hash local no path/nombre; host, modelo exacto/familia explícita, rol, régimen realmente cargado, tipo/unidad trabajo y cobertura. Snapshot v1 sigue legible; dimensiones faltantes = legacy-unknown y delta descriptivo. No utilizar generatedBy como versión activa. Modelo mixto/desconocido no se imputa a uno conocido.

Comparación preflight por métrica: mismas dimensiones conocidas, población equivalente, cobertura completa de observables requeridos y rango no superpuesto. Muestra insuficiente según piso específico = inconclusa; sin piso preregistrado solo descriptiva, con N/p50/p90. No prometer causalidad ni equivalencia por N grande. Pisos Spec 0039 intactos. Mostrar trade-offs calidad/tokens/velocidad, no score único.

Hook work=sum; toll por evento/fase=max concurrente observado, secuenciales separados; sin IDs/grupos confiables toll parcial. Dos hooks paralelos 100 ms = work 200/toll 100. Tool count Codex wrapper no equivale a operaciones internas; sin fuente estructurada, nested calls unavailable. Nunca inspeccionar/ejecutar scripts para inferirlas.

Recomendaciones rankean mecanismo con impacto observado (tokens atribuibles, tiempo bloqueante o ocurrencias/N), evidencia y cobertura; no mezclar unidades en puntuación inventada. Separar hechos, hipótesis y próximo probe; failures/repeticiones no son automáticamente retrabajo de código. Causas sin impacto medible permanecen pistas.

## Incremental boundaries

Primer corte puede entregar host/formato/contexto/coverage y disponibilidad mínima sin construir outcomes/usage completos; no declarar paridad ni éxito total. Contrato availability y schemaVersion se introducen en ese corte con tests de lectores JSON, sin refactor global de todos los contadores internos. Siguientes fronteras: writers/lifecycle/OTLP; usage/ownership; outcomes/cohortes; budgets/benchmarks. Estas son fronteras arquitectónicas, no tareas ni orden de dispatch obligatorio; cada diff conserva lectores antiguos y no publica zeros falsos mientras faltan capacidades.

## Testing strategy and quality/security matrix

Los tests nuevos referencian `// Covers: R<n>`; fixtures sintéticos/metadata saneada, nunca prompts reales. Implementer y reviewer son responsables de ejecución y gate.

| Atributo                 | Criterio observable                                                                                                               | Evidencia/test propuesto                                                                                                                                                                                      | R         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Identidad/compatibilidad | Wrong-host no devuelve ceros válidos; 2 sesiones concurrentes no cruzan eventos; recovery no escribe original                     | hooks render→start→discovery; `discovery.test.ts` wrong-format/ambiguous/missing; `cli-event.test.ts` explícito/conflicto/symlink                                                                             | R1–R3, R9 |
| Exactitud                | 1 request = 1 imputación; inherited/resume/reset/duplicados no inflan; reasoning no se suma                                       | `parse.test.ts` fixtures multi-thread y counters; observed-zero vs unavailable; source errors y ventana 10 min                                                                                                | R4–R7     |
| Cobertura                | numerator/denominator mismo intervalo, roots separados; null no entra en mediana                                                  | `discovery.test.ts` mixed/codex-only/midnight/missing; report JSON schema10/11 y metric N                                                                                                                     | R6, R8    |
| Privacidad/path          | creación bajo umask 000 sigue 0700/0600; sentinel sensible ausente; symlink y destino existente inseguro no mutados               | HOME aislado writers CLI/hooks/spool/receiver/snapshots/export/supervisor; raw-copy off                                                                                                                       | R10–R11   |
| Integridad/lifecycle     | inválidos/oversized descartados; bootout fallido preserva plist y no reporta éxito                                                | `collect.test.ts` malicious attrs/body/IDs; `launchd.test.ts` fake status/error/reinstall                                                                                                                     | R12–R13   |
| Estadística/velocidad    | ramas vacías no habilitan floor; paralelo work200/toll100; wrappers no tratados como Bash                                         | `reviewer-lifecycle.test.ts`; report missing-hook/call coverage/paralelo                                                                                                                                      | R14–R15   |
| Outcomes                 | review sin findings capturado; mismo diff requerido; duplicate no nueva ronda; fuente perdida sigue observable; abierto censurado | tests producer review + command review/receipt + report: cambio después de review antes de log-review, cambio durante review, legacy/missing evidence, multi-feature, stale/diff-change/reuse-slug/no-context | R16–R18   |
| Comparabilidad/acción    | legacy/mezcla/incompleto/overlap nunca mejora causal; señales llevan evidencia/N                                                  | `snapshot.test.ts` v1/v2/cohort mismatch; signals ranking factual-vs-hypothesis                                                                                                                               | R19–R20   |
| Recursos                 | índice una corrida, retained events/caches/connections no exceden cotas; shutdown vuelve listeners a baseline                     | synthetic benchmark 10×50 MiB: registrar RSS/elapsed y bytes, no depender de tiempos CI; assert budget/truncation + receiver churn                                                                            | R21–R22   |

Controles seleccionados: [NIST SSDF 1.1 PW.8.2](https://csrc.nist.gov/pubs/sp/800/218/final), pruebas negativas ejecutables de límites y errores; [OWASP ASVS 5.0.0 V14 Data Protection / V16 Security Logging and Error Handling](https://github.com/OWASP/ASVS/releases/tag/v5.0.0), minimización/permisos y metadatos seguros. Consulta 2026-10-03: fuente NIST accesible; detalle de IDs ASVS no accesible desde navegador, **[SIN VERIFICAR]** números de controles específicos; no se inventan ni se declara conformidad. SLSA no aplica a este cambio sin nueva cadena de build. Residual: fuentes locales pueden ser manipuladas por mismo usuario, campos host evolucionan, históricos seguirán incompletos.

## Open questions and conservative assumptions

- **CONCERN:** fixtures observados no garantizan versiones futuras Codex. Adapter identifica forma/versión y rechaza desconocidos; no bloquea el corte seguro inicial.
- **CONCERN:** JSON consumers externos no enumerados. Bump explícito y legacy reader; release notes deben advertir nullability, no mantener ceros como compatibilidad falsa.
- **CONCERN:** contexto cross-engine no se propaga por magia desde hook. Test end-to-end CLI con runtime ID explícito es obligatorio; ausencia de mecanismo automático = cobertura parcial visible.
- **Asumido:** aceptación local técnica satisface unidad inicial; merge/regresión remota no disponible, sin integrations remotas implícitas.
- **Asumido:** default metadata-only y nueva escritura privada; ninguna migración ni chmod histórico autorizado.
- **Asumido:** budgets iniciales son ajustables con benchmark sin retirar el límite; no se afirma mejora RSS antes de medir.
- R4/R5 requieren casos por familia/version observada; si counters carecen ownership, el resultado correcto es parcial, no una imputación estimada. R18 no exige clasificar esperas no observables. No es necesario cambiar requirements para estas interpretaciones.

## Durable knowledge and exclusions

Destino propuesto: contratos de audit y fixtures en repo; límites/recovery/disponibilidad en documentación audit; metadata-only en doctrina existente solo si requiere uso operativo. No promover al Dominio: no es regla business cross-repo.

Fuera: nuevos servicios/DB/board, migración/retención/chmod históricos, scripts transcript ejecutados o persistidos, llamadas Jira/GitHub/fetch desde report, billing exacto, quality score único, reducir sample T44, cambios dual-workflow/release. Ningún servicio real será instalado o detenido por pruebas.
