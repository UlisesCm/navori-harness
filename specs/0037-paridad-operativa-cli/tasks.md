# Paridad operativa Claude / Codex CLI — Tasks

**Estado:** T1 y T2 aprobados y completos; 17 tareas pendientes. El usuario
autorizó iniciar el Lote A (T1–T2) después de sincronizar `main`; esta autorización no cubre otros
lotes, campañas live/pagadas, instalaciones, cambios de trust ni publicación.
**Diseño:** [design.md](design.md), veredicto CONCERNS y resoluciones en [review.md](review.md).

## Cómo ejecutar

- Empezar cada lote con base actualizada que incluya #1084 y snapshot estable de SHA/binarios.
  No repetir la investigación #1082 sin cambio relevante; Spec 0036 conserva ownership del estado.
- Cada tarea sigue el ciclo implementer → scribe cuando corresponda → reviewer fresco. La excepción
  de preflight concedida a architect/auditor durante la redacción de la spec fue estrecha y no evita
  el check obligatorio al consumir un handoff producido.
- Los casos V/L están definidos en [validation.md](validation.md). Cada test automatizado lleva
  `// Covers: Rn` con los requisitos que prueba; los registros manuales/live declaran esos IDs.
  Las rutas de test abreviadas son relativas a `packages/cli/src/`.
- Un checkbox solo se marca al entregar su artefacto, evidencia y revisión; escribir este plan no
  cumple tareas. `blocked` o `not-supported` se conservan como resultados, nunca como tests verdes.
- Una limitación demostrada puede cerrar una tarea de diagnóstico, pero no una implementación
  prometida ni una capacidad como verificada. T10 tiene una salida condicionada explícita.
- Lotes A–D pueden avanzar sin certificar perfiles live. E precede a emisión de políticas de rol;
  G requiere cambios relevantes y autorización separada de campaña. H depende de todos sus insumos.
  No ejecutar en paralelo tareas con archivos compartidos; resolver por lote/encargo.

## Lote A — Base reproducible y diagnóstico honesto

- [x] **T1** (R1, R3, R14, R18) — Registrar snapshot inicial con procedencia CLI global/build/host,
  SHA, cwd y estado de configuración; reconciliar Spec 0035, helpers vigentes de Spec 0036 y
  documento #1082 integrado por #1084. Publicar diferencias reales de binario y guía de uso del
  build evaluado, sin instalarlo. Actualizar evidencia histórica sin presentarla como receipt.
  · pruebas: **V01, V03, V14, V18**; fixture de misma semver/distinto contenido y revisión de
  `docs/research/codex-plan-gate-1082.md` — `Decision and upgrade criteria`.
  · salida: baseline versionado y dependencias confirmadas; no probe #1082 repetido.

- [x] **T2** (R1, R2, R3) — Ampliar `commands/doctor.ts` — `buildEngineInventory`/`scanCodexHealth`
  con `provenance` y `engineEvidence` aditivos por engine/ubicación. Conservar inventario declarado,
  campos y exit codes existentes; distinguir ausencia de asset, permiso denegado y ejecución no
  observada. Mismo registro resuelto para hooks que render/trust, no suma ciega de manifests.
  · pruebas: **V01–V03**, `commands/__tests__/codex-doctor.test.ts` — procedencias distintas,
  etapas no inferidas, workspace incompleto, errores operativos no verdes.
  · depende de: T1.

## Lote B — Contratos de workflow veraces

- [ ] **T3** (R13, R14, R21) — Condicionar prosa de planificación por engine en la fuente managed;
  Codex advisory sin promesa deny, Claude conserva enforcement. Reconciliar explicación de handoff
  en `ENGINE_CAPABILITIES` y pruebas de declaraciones. Mantener criterio de reapertura #1082,
  sin implementar gating selectivo ni volver a corregir su razón ya integrada.
  · pruebas: **V13, V14, V21**, `control-inventory.test.ts` y `hook-claims-vs-scripts.test.ts` —
  prosa/declaración/registro coherentes y Claude sin cambios de decisión.
  · depende de: T1.

- [ ] **T4** (R15, R18) — Corregir la fuente `managed/orquestacion.md` — `The mechanics` y
  referencias dependientes: check de handoff antes de consumir producto existente, no antes del
  primer investigador/productor. Mantener plan precondition separada y usar el resolver de estado
  vigente. Regenerar espejos, no parchear únicamente AGENTS/CLAUDE generados.
  · pruebas: **V15, V18**, `handoff-wiring.test.ts`/`lib/handoff/__tests__/check.test.ts` — primer
  despacho permitido, consumidor inválido rechazado/válido aceptado, plan sigue requerido.
  · depende de: T1.

## Lote C — Plugins Codex completos, sin alterar política Claude

- [ ] **T5** (R4, R6, R20) — Compartir descriptor/identidad de scripts del adapter Claude y emitir
  placements `.codex/scripts` desde fuente de plugin. Integrar hooks Semgrep/jscpd en la misma
  resolución de config/trust; admitir solo forma traducible y advertir otras. Preservar orden core,
  includes, quoting, workspace, legacy Claude y plugins deshabilitados. Inventariar las familias
  de comandos cubiertas por `TRIGGER_RE`/`is_scan_trigger`; jscpd no se amplía a push/PR.
  · pruebas: **V04, V06, V20**, nuevo `engines/codex/__tests__/plugin-gates.test.ts` y suites
  managed/lifecycle — Codex-only sin `.claude`, dual sin duplicados, ruta con espacios/worktree,
  comando no traducible advertido, hash/config calculados desde el mismo registro.
  · depende de: T1; integrar inventario con T2 antes de aceptar el lote.

- [ ] **T6** (R5, R6) — Preservar decisiones #510 y mejorar fidelidad del resultado/terminal de
  ambos scanners. Capturar exit original antes de cleanup; no reportar block para error que permite,
  ni allow por cleanup exitoso tras findings; jscpd exit1 ambiguo no afirma clones confirmados.
  Conservar cache/base/includes y tratar timeout externo como inconcluso, sin watchdog nuevo.
  · pruebas: **V05, V06**, `lib/__tests__/plugin-gate-hooks.test.ts` — positivos, negativos,
  errores, ausencia, señales, terminal y sentinel; entradas pareadas Claude/Codex.
  · depende de: T5 para paridad del script materializado.

- [ ] **T7** (R18, R20) — Completar ciclo de actualización/retiro de plugins y revisión trust para
  los nuevos registros/scripts. Verificar contenido manual, backup fallido, antirollback,
  configuración ajena intacta e idempotencia; no aceptar trust automáticamente ni copiar scripts
  desde el árbol Claude. Registrar cambios de índices/hashes cuando se agrega/quita plugin.
  · pruebas: **V18, V20**, `plugin-scripts-managed.test.ts`, `plugin-lifecycle.test.ts`,
  `commands/__tests__/codex-trust.test.ts` — upgrade desde release/base conservada y segunda render.
  · depende de: T5–T6.

## Lote D — Profundidad de orquestación sin costo always-on duplicado

- [ ] **T8** (R7, R18, R23) — Materializar `.codex/orchestrator.md` como referencia managed desde
  el playbook fuente existente, fuera de `.codex/agents`. Adaptar enlaces/condicionales y conservar
  todas las secciones y extensiones según D4; no nuevo perfil, skill ni modelo del principal.
  Medir antes/después de bytes always-on y contexto compuesto.
  · pruebas: **V07, V18, V23**, `render-codex.test.ts`, `skills-assets.test.ts`,
  `skill-caps-composed.test.ts`, `check:doc-budgets` — contenido semántico navegable, sin self-link,
  duplicación ni pérdida de caps; Claude conserva referencia/user-section.
  · depende de: T1; coordinar fuente de orquestación con T4 antes de regenerar.

## Lote E — Roles y permisos: viabilidad antes de emitir garantías

- [ ] **T9** (R8, R9, R10, R11) — Con autorización separada de campaña, verificar selección real
  de perfiles y composición de filtros MCP en runtime CLI fijado. Ejecutar L03/L04 con stub y
  metadata, incluidos hijo default, allowlist padre/usuario más estrecha, disabled_tools y servidor
  deshabilitado. Separar nombres por evento, no extrapolar PreToolUse a PostToolUse. Sin autorización
  o acceso seguro queda bloqueada, no se simula éxito ni se sustituye por otro runtime.
  · pruebas: **V08–V11, L03, L04**; esperado filtros: cero ampliaciones respecto a restricción
  heredada. Entregar registro de viabilidad por ruta/versión, no configuración global cambiada.
  · depende de: T1; precondición de T10/T11 donde requieren hechos del host.

- [ ] **T10** (R11, R18, R20) — Solo para casos representables y probados por T9, compartir
  derivación de grants MCP con distinción `tools` ausente/herencia frente a allowlist explícita;
  emitir configuración por perfil sin ampliar filtros heredados ni tocar servidores ajenos.
  Conservar escritura legítima de informes y full-access vigente. Si T9 demuestra falta de
  representación segura, cerrar únicamente como **limitación documentada sin traducción habilitada**
  para ese caso; R11 permanece brecha visible, nunca capacidad cumplida. Un merger global requiere
  decisión de alcance nueva, no entra por este checkbox.
  · pruebas: **V11, V18, V20**, nuevo `engines/codex/__tests__/role-mcp-policy.test.ts` —
  campo ausente, allowlist sin grant, wildcard, filtro más estrecho y config usuario intacta;
  registro live T9 sustenta los casos habilitados.
  · depende de: T9.

- [ ] **T11** (R8, R9, R10) — Ajustar normalizador/matchers únicamente con eventos realmente
  observados por T9. Mantener nombre crudo/evento/rol desconocido y documentar ruta soportada de
  dispatch o fallback genérico explícito, sin atribuirle grants/modelos/guards del perfil.
  Markdown-ownership no se certifica con hijo default; desconocido nunca se convierte en implementer.
  · pruebas: **V08–V10**, `codex-hook-payloads.test.ts`/`control-inventory.test.ts` — fixtures
  redactados por evento y negativos de rol; correlación con L03/L04.
  · depende de: T9; si un evento no se observa, omitir adaptación y dejar limitación visible.

## Lote F — Modelos, herramientas y skills verificables

- [ ] **T12** (R12) — Informar procedencia explicit/mapped/inherited de modelo y effort sin
  convertir omisión de architect en error ni forzar modelo raíz por orchestrator. Conservar overrides
  y mapeo actual; preparar baseline architect/reviewer para T16 sin elegir modelos nuevos.
  · pruebas: **V12**, `model-profile.test.ts`/`render-codex.test.ts` — herencia, overrides,
  mapeo y ausencia de cambio global.
  · depende de: T1–T2.

- [ ] **T13** (R3, R16, R19) — Completar diagnóstico operativo read-only de tgrep/CodeGraph/Engram
  reutilizando scans existentes: CLI vs MCP, índice/frescura vs resultado, lectura vs escritura
  con identidad runtime. Reportar CA/permisos/sesión inválida como no verificado; no instalar,
  iniciar servidores, reindexar, crear sesiones Engram ni escribir memoria de producción.
  · pruebas: **V03, V16, V19**, fixtures en `codex-doctor.test.ts`; **L02/L08** completan la
  evidencia real bajo autorización, sin reinterpretar fixture como consulta live.
  · depende de: T2.

- [ ] **T14** (R17, R18) — Ampliar cobertura de render/discovery de skills compartidas y políticas
  de invocación, manteniendo source único y roots propios de cada host. Incluir explícita, implícita
  permitida y prohibida por metadata; no sumar otra capa always-on.
  · pruebas: **V17, V18**, `skill-trigger.test.ts`/`local-skills.test.ts`; **L07** en T15 verifica
  cumplimiento real y control negativo.
  · depende de: T1.

## Lote G — Campaña emparejada y decisiones con evidencia

- [ ] **T15** (R4, R5, R8, R9, R11, R16, R17, R18, R19) — Ejecutar campaña autorizada L01–L05,
  L07–L08 sobre snapshots finales. Interceptar operaciones de publicación con fakes sin efectos
  reales; separar contratos duros de datos no observables. Reusar T9 solo si config/ruta/versiones
  siguen frescas. Escritura Engram solo en aislamiento oficialmente soportado; de lo contrario
  blocked. No ejecutar L06 salvo nueva condición de reapertura, cubierta por T3/T17.
  · pruebas: **V04, V05, V08, V09, V11, V16–V19**, registros **L01–L05, L07–L08** completos.
  · depende de: lotes A–F aplicables y autorización explícita de consumo/trust aislado.

- [ ] **T16** (R12, R22, R23) — Comparar comportamiento con misma base/tareas/rúbrica y tres
  repeticiones por host/caso según L09. Separar calidad, pasos omitidos, tiempo y costo disponible;
  conservar todos los resultados. Registrar decisión architect/reviewer conservar/cambiar/no
  concluyente. Cualquier experimento de effort cambia una sola variable y requiere autorización;
  no aplicar cambios de perfil automáticamente al terminar la comparación.
  · pruebas: **V12, V22, V23, L09** — datos completos y resultados invertidos incluidos; costo
  ausente no cero, no claim estadístico ni modelo equivalente por tier.
  · depende de: T12/T15 y autorización de campaña.

## Lote H — Matriz final, no regresión y entrega

- [ ] **T17** (R2, R3, R13, R14, R21) — Publicar matriz por capacidad/host/versión con estado y
  enlace a evidencia, fortalezas y diferencias intencionales. Reconciliar README, prosa managed y
  ejemplo de Engram startup; `SessionStart` de Codex no instala por sí mismo la integración de
  memoria. Mantener plan-gate advisory y criterios de reapertura aun al cerrar otros ejes.
  · pruebas: **V02, V03, V13, V14, V21** — revisión cruzada contra inventario y campañas, sin
  capacidad promovida por mera presencia de archivo/trust ni promesa de paridad completa.
  · depende de: T2/T3 y resultados disponibles de T9–T16; bloqueos permanecen visibles.

- [ ] **T18** (R18, R20, R23) — Ejecutar regresión final en base/diff estables para Claude-only,
  Codex-only, dual, worktree y workspace; cerrar budgets/contexto, migración e idempotencia.
  Pasar quality gate completo del repo y revisión fresca, o documentar deuda según sus reglas;
  nunca usar los 960 tests históricos ni el gate de esta redacción como receipt de implementación.
  · pruebas: **V18, V20, V23**, suites existentes enumeradas en validation y `bun run check`.
  · depende de: todos los cambios de implementación a entregar y T17.

- [ ] **T19** (R1, R21, R22) — Preparar entrega versionada con procedencia del build comprobado,
  matriz final, guía Warp (`cd` al repo antes del CLI), rollback/trust explícito y capacidades que
  sigan advisory/no soportadas. Alinear recomendación de distribución con el binario realmente
  evaluado; no reinstalar global, abrir PR, publicar release ni hacer push sin autorización del
  flujo de entrega. Registrar comparación final sin porcentaje global engañoso.
  · pruebas: **V01, V21, V22** — revisión de procedencia, enlaces y consistencia de afirmaciones
  con evidencia. Un resultado parcial se etiqueta parcial.
  · depende de: T17–T18.

## Matriz de trazabilidad

| Requisito | Tareas | Prueba principal |
|---|---|---|
| R1 | T1, T2, T19 | V01 |
| R2 | T2, T17 | V02 |
| R3 | T1, T2, T13, T17 | V03 |
| R4 | T5, T15 | V04 |
| R5 | T6, T15 | V05 |
| R6 | T5, T6 | V06 |
| R7 | T8 | V07 |
| R8 | T9, T11, T15 | V08 |
| R9 | T9, T11, T15 | V09 |
| R10 | T9, T11 | V10 |
| R11 | T9, T10, T15 | V11 |
| R12 | T12, T16 | V12 |
| R13 | T3, T17 | V13 |
| R14 | T1, T3, T17 | V14 |
| R15 | T4 | V15 |
| R16 | T13, T15 | V16 |
| R17 | T14, T15 | V17 |
| R18 | T1, T4, T7, T8, T10, T14, T15, T18 | V18 |
| R19 | T13, T15 | V19 |
| R20 | T5, T7, T10, T18 | V20 |
| R21 | T3, T17, T19 | V21 |
| R22 | T16, T19 | V22 |
| R23 | T8, T16, T18 | V23 |

## Definition of done del programa

Cada tarea entregada tiene revisión/evidencia, cada requisito tiene resultado explícito y la matriz
final no oculta brechas. Todas las capacidades declaradas verificadas pasan sus positivos y negativos
en el runtime indicado; unsupported/blocked no cuentan como pass. El usuario recibe también lo que
ya funciona y lo preservado. La spec puede estar completa mientras este tablero permanece sin iniciar.
