# Pi: igualar los resultados de Claude — Tasks

**Estado:** scaffold del 2026-10-14 (requirements con D-U1..D-U6, design revisado tras el challenge del
auditor B1–B2, C1–C6). Ninguna tarea iniciada. Este PR publica solo la spec; la implementación requiere su
propio workplan clasificado y aprobado.

Reglas de ejecución:

- Una sola entrega (E1) y un solo PR contra `dev`, con un commit por milestone. Workplan
  `0053-pi-igualar-claude-e1`; `tasks.md` es el tracking canónico.
- Cada prueba nueva lleva `// Covers: R<n>`. Los casos nombrados son planeados; los archivos marcados como
  nuevos se crean en su milestone.
- Rutas de prueba relativas a `packages/cli/src/`. "Binario real" = `dist/bundle/cli.js` del devDependency
  de Pi como proceso, con el modelo faux. "Modelo en vivo" = solo M7.
- Los milestones que tocan hooks, `settings` o assets corren además `bun run test:golden`,
  `bun run check:assets` y `bun run check:render`. Los espejos se regeneran con `navori render --apply`.
- Cada milestone corre `bun run check:fast` más sus A<n>; la entrega cierra con `bun check`, un recibo y un
  reviewer fresco.
- Las preguntas Q5 (Pi 1.2.0 con Node < 22.19) y Q6 (entrega de `sendMessage` con `willRetry`) se responden
  con una sonda al inicio de M1 y M4; si la respuesta contradice el diseño, se replantea con el usuario antes
  de seguir.

## E1 — Pi con resultados medidos e iguales a Claude en seguridad

Estimated LOC: 3200

### M1 — Runtime de Pi falla cerrado

- **A1** [observable] — Node viejo y Pi fuera de la lista dejan solo el bloqueo con la razón y la acción
  correctas; un control `enforced` sin veredicto evaluable bloquea y el ruido sin claves pasa ·
  `cd packages/cli && bun run test src/engines/pi/__tests__/runtime-version.test.ts src/engines/pi/__tests__/hook-bridge.test.ts src/lib/__tests__/pi-health.test.ts`
  → exit 0, 0 failed
- [ ] **T1** (R9, R10) — `runtime-version.ts`: `VERIFIED_PI_VERSIONS = ["1.2.0"]` reemplaza a
      `MIN_PI_VERSION`; función pura `runtimeAdmission(piVersion, nodeVersion)` con las cuatro razones de C7;
      export default de `extension-source.ts` delega en `registerNavori(pi, { pi, node })`, sin el `return` sin
      handlers; `registerRestrictedBlock` bloquea `bash`, `edit`, `write` y `powershell`; devDependency de Pi a
      `1.2.0` · effect: behavior · test: `engines/pi/__tests__/runtime-version.test.ts`::"Node 22.18 registra
      solo el bloqueo restringido con la razón de Node y VERIFIED_PI_VERSIONS coincide con el devDependency"
- [ ] **T2** (R10) — `scanPiHealth` devuelve `versionUnverified` con `action` (`upgrade-pi`,
      `update-navori`, `install-verified`); `navori doctor` imprime versión, lista y acción en texto y `--json`
      · effect: behavior · test: `lib/__tests__/pi-health.test.ts`::"1.1.0 pide upgrade-pi, 1.3.0
      pide update-navori, 1.2.0-beta pide install-verified y 1.2.0 no reporta"
- [ ] **T3** (R11) — `bridgeVerdict` bloquea `outcome.aborted` en hooks `enforced`; `runBridgeScript`
      conserva los últimos 64 KiB y marca `truncated`; una línea con clave de veredicto que no parsea bloquea, el
      ruido sin claves conserva su semántica · effect: behavior · test:
      `engines/pi/__tests__/hook-bridge.test.ts`::"abort y veredicto ilegible bloquean; 200 KiB con deny al
      final bloquea; 200 KiB sin claves pasa"

### M2 — Modelo del hijo sin proveedor fijo

- **A2** [observable] — el render de `.pi/agents/<rol>.md` no contiene `openai-codex/` y el hijo usa el
  proveedor del padre · `cd packages/cli && bun run test src/engines/pi/__tests__/subagent.test.ts` → exit
  0, 0 failed
- [ ] **T4** (R12) — `engines/pi/index.ts` escribe `model` sin prefijo salvo que el valor ya traiga
      `proveedor/id`; `resolveModel` califica con `ctx.model.provider`; los mensajes de error y de `runChild`
      dejan de nombrar `openai-codex` · effect: behavior · test: `engines/pi/__tests__/subagent.test.ts`::"padre
      anthropic/x con rol y resuelve anthropic/y, openai/z queda literal e inexistente falla con la acción"

### M3 — Guardas: Markdown por bash, copias sobre rutas propias y catálogo de paridad

- **A3** [observable] — el implementer Pi no escribe Markdown por bash; `cp`/`mv`/`install`/`git mv`/`ln`
  sobre rutas propias bloquean en las tres copias sin falsos positivos; Claude y Pi deciden igual en las
  filas `script` del catálogo ·
  `cd packages/cli && bun run test src/engines/pi/__tests__/first-class-guards.test.ts src/engines/shared/__tests__/guard-catalog-parity.test.ts src/lib/__tests__/ && bun run test:golden && bun run check:assets && bun run check:render`
  → exit 0, 0 failed
- [ ] **T5** (R7) — fila `implementer-no-markdown` en `PI_HOOK_BINDINGS` (`scope: "child"`, `enforced`,
      condicionada a `scribeOwnsMarkdown`); se borran el check TS de `.md`, `isDoctrinePath` y
      `PI_IMPLEMENTER_DOCTRINE_PREFIXES`; check fail-closed `manifest-skew`; `markdown-ownership` de Pi pasa a
      `enforced` en `engine-capabilities.ts` y `pi-parity.ts` · effect: behavior · test:
      `engines/pi/__tests__/first-class-guards.test.ts`::"implementer Pi no escribe Markdown por bash y un
      manifiesto sin la fila bloquea con la ruta de re-render"
- [ ] **T6** (R8) — `guard-destructive.sh` suma `cp`, `mv`, `install`, `ln` al fast path y a
      `nv_pi_candidate`; partial `_partials/copy-dest.sh` extrae el destino (redirecciones, `&`, `-t`, rutas
      absolutas del proyecto); `nv_owned_paths={{shq:navoriOwnedPaths}}` interpolado desde el inventario del
      render; anclaje exacto; `mv`/`git mv` con fuente propia bloquea; comentarios "WHY IT IS SOUND" y "NOT
      COVERED" reescritos; goldens `claude.snap` y `codex.snap` actualizados en el mismo commit · effect:
      behavior · test: `engines/pi/__tests__/first-class-guards.test.ts`::"cp x CLAUDE.md sin otro token del
      fast path bloquea, cp CLAUDE.md /tmp/x y skills del usuario pasan, y las fuentes de rutas propias
      coinciden"
- [ ] **T7** (R2, R6, R7, R8) — catálogo K4 en `engines/shared/__tests__/fixtures/guard-catalog.ts` con
      `layer` y `expect` por engine; la prueba de paridad corre las filas `script` contra la copia Claude y
      contra la copia Pi por el puente real, y verifica las filas específicas de cada engine · effect: tests ·
      test: `engines/shared/__tests__/guard-catalog-parity.test.ts`::"Claude y Pi toman la misma decisión y
      ruta en cada fila script del catálogo"

### M4 — Contexto repuesto tras compactar

- **A4** [observable] — tras cada compactación hay exactamente un `navori-context` posterior, también tras
  un reintento por overflow · `cd packages/cli && bun run test src/engines/pi/__tests__/first-class-context.test.ts`
  → exit 0, 0 failed
- [ ] **T8** (R5) — `injectContext` deduplica por marcador posterior a la última `compaction`; handler
      `session_compact` en el padre con entrega por defecto (sin `deliverAs`); `before_agent_start` repone si la
      última compactación no tiene marcador · effect: behavior · test:
      `engines/pi/__tests__/first-class-context.test.ts`::"compactación en reposo, con willRetry y dos seguidas
      dejan un marcador por compactación y ninguno sin compactar"

### M5 — Hijos atribuibles y razón del plan gate visible

- **A5** [observable] — dos hijos concurrentes y uno fallido aparecen como tres dispatches distinguibles; el
  padre como proceso `pi` real recibe la razón del plan gate ·
  `cd packages/cli && bun run test src/engines/pi/__tests__/first-class-audit.test.ts src/engines/pi/__tests__/first-class-e2e.test.ts`
  → exit 0, 0 failed
- [x] **T9** (R3) — `runChild` exporta `NAVORI_PI_PARENT_SESSION`, `NAVORI_PI_CHILD_ID`,
      `NAVORI_AUDIT_HOST=pi`, `NAVORI_AUDIT_SESSION_ID` y `NAVORI_AUDIT_AGENT_ID`; `bridgePayload` usa la
      sesión padre y el id del hijo; `cli-event.ts` acepta `host: "pi"` y `agentId` opcional · effect: behavior
      · test: `engines/pi/__tests__/first-class-audit.test.ts`::"hooks y eventos cli de cada hijo llevan su
      agentId y la sesión padre"
      - Verificado #1361: identidad exacta exportada al proceso hijo y compartida con K2, hooks,
        eventos CLI y evidencia de aceptación. La prueba SDK/CLI conserva IDs nativos con `:`;
        el lector sólo atribuye invocaciones únicas confirmadas por el transcript y conserva IDs
        públicos ordinales. El writer Pi usa el log privado existente; no crea spool ni actores.
- [ ] **T10** (R3) — `execute` de `navori_subagent` devuelve `isError` con `details` (K2: `agentId`,
      `parentSession`, `head`, `worktreeTree`, `handoff`, `outcome`, `failure`) en toda falla posterior al spawn;
      `engines/pi/denials.ts` con `PI_EXTENSION_DENIALS` · effect: behavior · test:
      `engines/pi/__tests__/first-class-audit.test.ts`::"un hijo que falla tras el spawn cuenta como dispatch
      failed con su diagnóstico"
      - Avance #1361: resultado K2 para éxito y fallas posteriores al spawn, incluidos cancelación,
        timeout, JSONL inválido, salida no cero, fallback de aprobación y handoff inválido. El lector
        correlaciona fallas sólo con K2 completo que coincide con padre, rol e invocación; no publica
        diagnósticos ni metadatos de Git. Faltan el catálogo `PI_EXTENSION_DENIALS` y A5 completo;
        M5 sigue pendiente.
- [ ] **T11** (R4) — `runNavori` captura stderr acotado; `checkDispatch` lanza el texto exacto de
      `navori plan gate`; `ENOENT` de `navori` da el mensaje de PATH; fase e2e con el padre como proceso
      `pi --mode json -p` y `harness.planTiers: true` · effect: behavior · test:
      `engines/pi/__tests__/first-class-e2e.test.ts`::"padre pi real sin plan aprobado recibe BLOCKED by
      plan-gate con la razón y con plan verde el hijo corre"

### M6 — Comparación por engine en `navori audit`

- **A6** [observable] — `navori audit --by-engine --json` produce K1 con `unavailable` distinto de cero,
  `inconclusive` por mínimos y publicaciones sin aprobación correlacionada contadas ·
  `cd packages/cli && bun run test src/lib/audit/__tests__/engine-benchmark.test.ts src/lib/audit/__tests__/publications.test.ts`
  → exit 0, 0 failed
- [ ] **T12** (R1, R2) — `lib/audit/engine-benchmark.ts` (nuevo): `benchmarkByEngine` con las siete métricas,
      `controlOf` para normalizar denegaciones y `result: pass | fail | inconclusive` con los mínimos de R2 ·
      effect: behavior · test: `lib/audit/__tests__/engine-benchmark.test.ts`::"métrica sin datos es
      unavailable, sin publicación o sin denegación dirigida el resultado es inconclusive"
- [ ] **T13** (R1, R2) — `lib/audit/publications.ts` (nuevo): `readPublications` empareja tips publicados del
      remoto con `pr-publisher-confirm` y `review-outcome` correlacionado por `contentIdentity`; commits con gate
      verde desde el reflog · effect: behavior · test: `lib/audit/__tests__/publications.test.ts`::"un push de un
      diff cambiado tras la aprobación cuenta como publicación sin aprobación correlacionada"
- [ ] **T14** (R1) — `commands/audit.ts` agrega `--by-engine` y `--published-from` con salida Markdown y
      `--json`; `pi-session.ts` lee hijos `pi-<role>-<toolCallId>`, `isError`, compactaciones y `navori-context`;
      `collectInjectedContext` conserva la fuente de `SessionStart` en Claude · effect: behavior · test:
      `lib/audit/__tests__/engine-benchmark.test.ts`::"sesiones Claude y Pi sintéticas producen la tabla lado a
      lado con compactaciones repuestas por engine"

### M7 — Corrida en vivo y documentación

- **A7** [observable] — la corrida en vivo de las cinco tareas queda registrada en `evals.md` con `result`,
  la salida de la prueba de paridad y las limitaciones; `docs/pi.md` refleja el estado entregado ·
  `NAVORI_LIVE_BENCH=1 bun scripts/bench/run-live.ts` → tabla K1 con `result` distinto de vacío, pegada en
  `specs/0053-pi-igualar-claude/evals.md`
- [ ] **T15** (R2) — `scripts/bench/run-live.ts` y `scripts/bench/fixture/` (paquete Node sin dependencias,
      `planTiers`, `scribeOwnsMarkdown`, plugin `tgrep`, remoto bare y `gh` de prueba) con las cinco tareas
      fijas; exige `NAVORI_LIVE_BENCH=1`, nunca corre en CI · effect: tests · test:
      `lib/audit/__tests__/engine-benchmark.test.ts`::"la salida del fixture sin credenciales es inconclusive y
      no pass"
- [ ] **T16** (R2) — corrida en vivo en Claude y Pi con el mismo modelo disponible por engine; tabla, versión
      de Pi, modelos, resultados invertidos y limitaciones (n = 1, aprobación correlacionada distinta de revisor
      independiente) en `evals.md` · effect: docs · test: `specs/0053-pi-igualar-claude/evals.md`::"Corrida en
      vivo"
- [ ] **T17** (R6, R7, R8, R10) — `docs/pi.md`: matriz de soporte, routing de búsqueda ya activo, Markdown
      por bash, copias sobre rutas propias, versiones verificadas y sus acciones; tabla de paridad generada desde
      `PI_PARITY` · effect: docs · test: `docs/pi.md`::"Parity inventory"
