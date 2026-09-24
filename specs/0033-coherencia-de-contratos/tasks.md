# Coherencia de contratos del harness — Tasks

Un solo PR para el issue #1016 (regla del repo: un PR por issue). Cada lote termina en un commit
con el gate completo en verde. Así el PR se puede revisar lote por lote. Después de cada lote que
toque assets, corre `navori render --apply` y `bun run check:render`.

Orden de los lotes:

- **A** va primero: la evidencia es la base de todo lo demás.
- **B** no comparte archivos con A, así que puede correr en paralelo con él.
- **C** abre con una sonda manual que decide entre el puntero y el fallback.
- **D** va después de A, porque ambos editan `implementer.md` y `publisher.md`.
- **E** cierra el PR: el inventario declara el estado final de los controles de C y D.

## Lote A — Evidencia: atribución y vigencia (F01, F02)

- [x] **T1** (R1, R2, R3, R4) — Tres estados de atribución.
  - `verify-before-done` define los tres estados, sin la fila "a failure outside that list
    predates you".
  - `implementer`, `reviewer` y `review-diff` citan esa definición sin repetirla ni asignar
    origen por ubicación.
  - Test: `lib/__tests__/failure-attribution.test.ts`, con `// Covers: R1, R2, R3, R4`. Incluye
    los patrones prohibidos en todo asset renderizable y las fixtures de consumidor no editado,
    preexistente en archivo editado y sin baseline.
- [x] **T2** (R5, R6, R7) — Receipt v2 en `lib/diagnose/receipt.ts`.
  - La cabecera guarda `base`, `gate` e `inputs`; `LOCKFILES` sale de `lib/diagnose/detect.ts`.
  - `check` devuelve `fresh` o `stale` con sus causas, sin cambiar `status` ni el exit code.
  - El publisher ya no borra el receipt consumido: lo renombra a `receipt.consumed.txt`, y
    `commands/receipt.ts` agrega `--include-consumed`.
  - Test: `lib/diagnose/__tests__/receipt.test.ts`, con `// Covers: R5, R6, R7`. Cubre los
    casos sin cambios, drift, rebase sin cambios propios (sigue `fresh`), gate cambiado,
    lockfile cambiado, cabecera v1, y consumido con y sin flag.
- [x] **T3** (R6, R8) — Una sola regla de vigencia en la prosa.
  - `verify-before-done` la define; `cierre-sesion`, `publisher`, `reviewer` e `implementer` la
    citan. "This turn" deja de ser el criterio.
  - `publisher` exige `"fresh":true` o corre el gate, y deja de pedir el gate completo tras un
    rebase que no cambió los archivos del diff. `cierre-sesion` usa `--include-consumed`.
  - Test: `lib/__tests__/receipt-wiring.test.ts` (extendido), con `// Covers: R6, R8`.

## Lote B — Base declarada (F06)

- [x] **T4** (R18, R19) — Cambiar `origin/main` por `{{branchBase}}`.
  - En la prosa: `architect` (sección Method) y `solution-design` (paso 1, con su `maxWords`
    ajustado).
  - En el snippet de `scoped-gate`: `{{shq:branchBase}}`, con fallback declarado en stderr y
    salida distinta de cero cuando no hay ninguna ref.
  - En la skill del preset `turbo-workspaces`.
  - Test: `lib/__tests__/branch-base-assets.test.ts`, con `// Covers: R18, R19`. Incluye el
    render con `branchBase: "develop"` y el snippet en un repo temporal sin remoto.

## Lote C — Skills locales en Codex (F03)

- [ ] **T5** (R9) — Sonda manual contra Codex real.
  - Un `SKILL.md` puntero en `.agents/skills/<id>/` que remite a `.claude/skills/<id>/SKILL.md`.
    Se observa si Codex lo lista, lo carga y sigue la redirección y sus enlaces a `references/`.
  - El resultado queda en el contrato `codex-skill-body-redirect` de
    `lib/diagnose/host-contracts.ts`: `verified` con su evidencia, o `refuted`.
  - Si falla, T6 implementa el fallback de D2 (copia generada con marcador y enlaces reescritos)
    en vez del puntero. Pídele la sonda al usuario si no hay un binario de Codex disponible.
  - Test: el test existente de `host-contracts` valida que la nueva entrada esté bien formada,
    con `// Covers: R9`.
- [ ] **T6** (R9, R10, R11, R12) — `classifyLocalSkills` y el puntero.
  - `classifyLocalSkills` vive en `engines/codex/local-skill-pointer.ts` y reparte los ids en
    `emit`, `missing` y `foreign`.
  - El adapter de Codex emite, por `extraFiles`, solo los ids de `emit`, y su `orphanScans`
    protege los ids declarados.
  - `commands/render.ts` manda `missing` y `foreign` a sus `warnings`. `commands/doctor.ts` los
    reporta y, en repos sin el engine `claude`, sugiere mover la skill.
  - Tests, con `// Covers: R9, R10, R11, R12`:
    - `engines/codex/__tests__/local-skills.test.ts`: la fuente queda byte-idéntica, la
      `description` se sincroniza y el id retirado se poda con backup.
    - `engines/codex/__tests__/local-skill-pointer.test.ts`: los tres conjuntos son disjuntos.
    - `commands/__tests__/render-local-skills.test.ts`: el archivo foráneo queda byte-idéntico
      y se emite su aviso exacto.

## Lote D — Consumo de handoffs (F04, F05)

- [ ] **T7** (R13, R14, R15, R16, R24) — `navori handoff check <feature> [--for scribe] [--json]`.
  - Esquema zod único en `lib/handoff/schema.ts` (`REQUIRED_IMPL_KEYS` más `head` opcional) y
    comprobaciones en `lib/handoff/check.ts`.
  - El subcomando se registra en `commands/handoff.ts` y en `index.ts`.
  - Con `scribeOwnsMarkdown: false` valida `impl_<feature>.md`.
  - Test: `lib/handoff/__tests__/check.test.ts`, con `// Covers: R13, R14, R15, R16, R24`.
    - Casos que fallan: ausente, JSON inválido, otro feature, worktree o rama equivocados, y
      paths absolutos, con `..`, con symlink que escapa o bajo `progress/`.
    - Sin `head` da un warning.
    - Con el flag apagado valida el `.md`.
- [ ] **T8** (R13, R17) — Instrucciones en la prosa y permiso.
  - `orquestacion` y `orchestrator` ejecutan `navori handoff check` antes de despachar al scribe o
    al reviewer.
  - `scribe` corre el preflight con `--for scribe` y la cadena solo avanza con `"status":"ok"`.
  - `implementer` registra `head`.
  - `progress-dirs.ts` resuelve `--dir` por engine y `settings-base.json` agrega
    `Bash(navori handoff check:*)`. El hook `subagent-stop-handoff.sh` sigue siendo advisory.
  - Test: `lib/__tests__/handoff-wiring.test.ts`, con `// Covers: R13, R17`. Incluye el render
    de Codex con `--dir .codex/progress` y la paridad entre la lista `required` del hook y
    `REQUIRED_IMPL_KEYS`.

## Lote E — Inventario de controles (backlog 5)

- [ ] **T9** (R20, R23) — `controls` y `analyticWriteTools` en `ENGINE_CAPABILITIES`
  (`engines/shared/engine-capabilities.ts`).
  - Cada control lleva estado, razón y evidencia; `enforced` sin evidencia no compila.
  - Test: `engines/shared/__tests__/engine-capabilities.test.ts` (extendido), con
    `// Covers: R20, R23`.
- [ ] **T10** (R21) — `lib/diagnose/control-gaps.ts` alimenta a `doctor` y a `i18n`.
  - Se borra `lib/plan/gate-support.ts` y su test se migra conservando la cita a la spec 0032
    R17.
  - Un control no enforced sale como `info`; pasa a `warn` solo si el usuario encendió su flag.
  - Test: `lib/diagnose/__tests__/control-gaps.test.ts`, con `// Covers: R21`.
- [ ] **T11** (R22, R23) — Contraste contra el render real.
  - Se renderizan los cinco engines en un directorio temporal, con todos los flags encendidos y
    una skill local.
  - Para cada engine y control, lo declarado debe coincidir con lo que se registró. Las tools de
    escritura de `auditor`, `scout`, `reviewer` y `architect` deben coincidir con
    `analyticWriteTools`.
  - Test: `engines/__tests__/control-inventory.test.ts`, con `// Covers: R22, R23`. El test lee
    los archivos renderizados, no otra declaración del mismo módulo.

## Cierre

- [ ] **T12** — Versionar `docs/research/auditoria-profunda-agentes-skills-2026-09-23.md` en el PR
  de la spec, porque el issue y `requirements.md` lo citan.
  - Test: `bun run check:links` en verde.
- [ ] **T13** — Trazabilidad.
  - Cada `R1`–`R24` aparece en al menos un `// Covers:` y en una tarea de este archivo.
  - Test: `grep -rn "Covers:.*R<n>"` por cada id, con la salida en el receipt del reviewer del
    último lote.
