# Harness de workspace con arranque desde la raíz — Tasks

Un PR cierra #1143. Va un commit por lote, con `bun check` en verde después de cada uno. Las
rutas de test son relativas a `packages/cli/src/`. Cada caso nuevo lleva `// Covers: R…`
con los ids de su tarea.

## Lote 1 — `sync` deja de recrear lo que el modo omite (commit `fix(sync): …`)

- [ ] **T1** (R9) — `SyncTarget` (`commands/sync.ts`) gana `harnessScope` en sus dos
  construcciones de `resolveSyncTargets`: la ruta `--workspace` y el bucle. El valor sale de
  `config.monorepo.workspaceHarness`, igual que en `runRender`, y `renderSyncTarget` lo pasa
  a `renderClaudeEngine`. Sync no corre reconciliación ni borra nada; el borrado queda en
  `render`, con preview.
  · test: `commands/__tests__/sync-workspace-harness.test.ts` (nuevo)
  - "render → sync --apply → render bajo `minimal`: sync no crea `.claude/agents` ni
    `.claude/settings.json` en el workspace, no borra nada, y el segundo render reporta cero
    cambios"
  - "bajo `full`, sync sigue escribiendo el árbol completo del workspace"

## Lote 2 — piezas compartidas sin cambio de comportamiento (commit `refactor(render): …`)

- [ ] **T2** (R2) — Agregar a `engines/claude/index.ts` dos funciones exportadas:
  - `planClaudeSkills(cwd, config, { repoRoot })` con `loadActivePreset`,
    `resolveHarnessPlan` y `filterInventory`. Devuelve `skills` y `presetLoaded`, y no
    emite avisos.
  - `composeFreshClaudeSkill`, extraída de `applySubBlockInject`.

  `renderClaudeEngine` y `applySubBlockInject` pasan a usarlas. La salida de render no
  cambia.
  · test: `engines/claude/__tests__/workspace-skill-dedup.test.ts` (nuevo)
  - "`composeFreshClaudeSkill` da los mismos bytes que render en un directorio vacío, con
    plugin que inyecta y sin él"
  - "`planClaudeSkills` excluye lo que retira la matriz nativa, igual que el plan del
    engine"

- [ ] **T3** (R3) — Tres cambios de infraestructura:
  - `PristineOpts.requirePristine` (`lib/render/removable.ts`) gana `normalize`, que se
    aplica al contenido en disco antes de `hasUserWrittenText`.
  - `PendingRemoval` gana un `status` opcional, que `commitWrites` respeta.
  - La rama `skill-dir` de `collectOrphans` (`engines/shared/execute-plan.ts`) respeta
    `OrphanScan.expected`.
  · test: `lib/render/__tests__/removable-normalize.test.ts` (nuevo)
  - "una copia de un asset viejo, sin `type:` ni `maxWords:`, es `ours` con `normalize`"
  - "una clave de frontmatter agregada por el usuario la vuelve `modified`"
  - "texto en la zona de usuario la vuelve `modified`"
  · test: `lib/__tests__/removal-parity.test.ts` — sin caso nuevo; sigue verde.

## Lote 3 — `minimal` deja de duplicar lo de la raíz (commit `feat(render): …`)

- [ ] **T4** (R2, R3, R13) — Decisión y engine para `minimal`:
  - Crear `engines/shared/workspace-skills.ts` con `WorkspaceHarness`, `isTrimmedHarness`,
    `decideWorkspaceSkills` (reglas 1–3 del design) y `planOmittedSkillRemoval`. Este
    último borra la forma directorio y la forma plana con el criterio prístino único, y
    usa `status: "removed-trimmed"`.
  - `renderClaudeEngine` gana `workspaceSkills: { omitted, prune }`. Las omitidas salen de
    `harnessPlan.skills`, y §8.7 calcula `selectedLibs` con el plan sin filtrar.
  - `applySubBlockInject` trata un destino omitido como "vive en la raíz".
  - `buildSkillRows` excluye las omitidas del índice del workspace.
  - Las conservadas van a `trimmedKept`.
  · test: `engines/shared/__tests__/workspace-skills.test.ts` (nuevo)
  - "omite la de bytes iguales a la raíz"
  - "conserva la que interpola un `qualityGate` sobrescrito"
  - "conserva la que la raíz no planea"
  - "no omite si `rootHas` es falso"
  - "no omite nada si un preset no cargó"
  - "bajo `full` no omite nada"
  · test: `engines/claude/__tests__/workspace-skill-dedup.test.ts`
  - "una librería implícita del preset, omitida y con texto del usuario, sobrevive a §8.7"
  - "una copia prístina se quita con `removed-trimmed`; una sin marcador o de un navori
    más nuevo se conserva en `trimmedKept`"
  · test: `engines/claude/__tests__/inject-notice-scope.test.ts`
  - "un sub-bloque cuyo destino es una skill omitida no avisa y no reescribe la copia en
    disco"

- [ ] **T5** (R3, R9) — `runRender` (`commands/render.ts`), en sus dos rutas, y `sync`:
  - Calculan la decisión una vez, antes de escribir, con `planClaudeSkills`.
  - `rootHas` sale del disco más el plan de la raíz en la ruta completa (la raíz se escribe
    primero), y solo del disco en `--workspace` y en `sync --workspace`.
  - `render` pasa `prune: true`; `sync` pasa `prune: false`.
  - `countRenderStatuses` cuenta `removed-trimmed` y `ws.trimmed`.
  - El resumen imprime una línea de conteo por workspace (`lib/i18n.ts`, es/en), y
    `buildRenderJson` expone `trimmedKept`.
  - Actualizar el caso existente "bajo el default, el workspace recibe CLAUDE.md y skills, y
    nada más".
  · test: `commands/__tests__/render-workspace-harness.test.ts`
  - "bajo `minimal` el workspace no lleva las idénticas a la raíz y sí las de su preset y
    librerías"
  - "la raíz conserva exactamente su set"
  - "fixture moonar (presets `medusa` y `nextjs`, `qualityGate` sobrescrito, frontmatter
    viejo): omite, conserva y reporta lo esperado"
  - "`render --workspace` sin raíz renderizada no omite nada"
  - "el preview imprime la línea de conteo y no borra"
  - "segundo render: cero cambios"
  · test: `commands/__tests__/status-render-pending.test.ts`
  - "tras actualizar a esta versión con copias duplicadas, el render pendiente es > 0; tras
    aplicar, 0 y drift 0"
  · test: `commands/__tests__/sync-workspace-harness.test.ts`
  - "sync bajo `minimal` no recrea las omitidas y no borra nada"

## Lote 4 — `root` en el engine Claude (commit `feat(claude): …`)

- [ ] **T6** (R5, R6) — `decideWorkspaceSkills`, ahora con la regla 4:
  - core/workflow: gana la raíz;
  - librería/preset: se sube con el id original o como `slug-id`;
  - guardia `rootHas(finalName)` y `blocked` para destinos ajenos;
  - `workspaceSlug`, `rootPruneCandidates` y `hoistTransform`, con el recorte a
    `SKILL_LISTING_CHAR_CAP`.
  · test: `engines/shared/__tests__/workspace-skills.test.ts`
  - "una core/workflow nunca se sube, aunque difiera"
  - "dos workspaces con bytes iguales suben una sola con el id original"
  - "con bytes distintos, cada uno sube `slug-id`"
  - "si la raíz la planea distinta, el aporte va con `slug-id`"
  - "un destino de la raíz sin marcador va a `blocked` y no se omite del workspace"
  - "sin `rootHas(finalName)` no se omite"
  - "reordenar `workspaces[]` no cambia nombres"
  - "`@moonar/backend` da `moonar-backend` y un choque de slug cae al `path`"
  - "la descripción reescrita no pasa el tope"
  - "`rootPruneCandidates` queda vacío si un preset no cargó"

- [ ] **T7** (R4, R12, R13) — `renderClaudeEngine` con `harnessScope: "root"` en un
  workspace:
  - sin skills, sin `skills-index` y sin bootstrap nuevo de `progress/`;
  - las copias se quitan con `planOmittedSkillRemoval`;
  - `buildContextoMonorepoBody` agrega la variante `root` (es/en): las skills y la
    configuración viven en la raíz y, si el `qualityGate` del workspace difiere del de la
    raíz, nombra sus comandos `fast` y `full`.
  · test: `engines/claude/__tests__/workspace-root-scope.test.ts` (nuevo)
  - "bajo `root` el workspace queda con `CLAUDE.md` y nada más"
  - "el bloque dice que las skills viven en la raíz, en es y en"
  - "con `qualityGate` propio, el bloque nombra sus comandos; sin él, no"
  - "sin `skills-index` en el workspace"

- [ ] **T8** (R5, R6, R13) — `renderClaudeEngine` en la raíz gana
  `rootHoist: { skills, pruneCandidates }`:
  - lo subido entra a `harnessPlan.skills` con la config de su workspace, y las `slug-id`
    pasan por `hoistTransform`;
  - `buildSkillRows` las lista con su nombre final;
  - los candidatos que ya no se desean pasan por `planOmittedSkillRemoval`.
  · test: `engines/claude/__tests__/workspace-root-scope.test.ts`
  - "la raíz escribe lo subido y `contexto-proyecto` queda byte-idéntico"
  - "una `slug-id` lleva `name` y `description` reescritos"
  - "el índice de la raíz lista lo subido con su nombre final"
  - "un candidato ya no deseado se poda y uno con texto del usuario se conserva"

## Lote 5 — `root` en el config (commit `feat(config): …`)

- [ ] **T9** (R1) — `MonorepoSchema.workspaceHarness` (`lib/config/schema.ts`) pasa a
  `z.enum(["minimal", "full", "root"]).default("minimal")`, con JSDoc y `.describe()`.
  `readConfig` (`lib/config/config.ts`) agrega al `ConfigError` la pista de "valor de un
  navori más nuevo" cuando un issue es un enum inválido. Regenerar el JSON Schema con
  `bun run gen:schemas`.
  · test: `lib/config/__tests__/schema.test.ts`
  - "`root` valida, el default sigue siendo `minimal` y cualquier otro valor se rechaza"
  · test: `lib/config/__tests__/config.test.ts`
  - "un enum desconocido produce el error con la pista de actualizar"
  · test: `lib/__tests__/schema-publish.test.ts` — sin caso nuevo.

- [ ] **T10** (R4, R7, R9) — Cableado de `root` en `runRender` y `sync`:
  - pasan `rootHoist` a la raíz en todo modo con `monorepo` declarado;
  - `reconcileTrimmedWorkspace` corre bajo `isTrimmedHarness` (misma lista que `minimal`);
  - después, `removeEmptyDirs` barre `.claude/skills` y `.claude/`, solo si quedaron
    vacíos;
  - las comparaciones `=== "minimal"` de `commands/render.ts` pasan a `isTrimmedHarness`.
  · test: `commands/__tests__/render-workspace-harness.test.ts`
  - "`full` → `root`: el workspace queda sin `.claude/`, lo ajeno se conserva y se
    reporta, y la raíz gana lo subido"
  - "`render --workspace` bajo `root` con una raíz sin lo subido conserva todas las skills
    del workspace"
  - "`root` → `minimal` devuelve las skills al workspace y poda lo subido en la raíz"
  - "un conflicto que desaparece renombra `slug-id` al id original sin dejar restos"
  - "fixture moonar bajo `root`: suben `medusa-*` y `nextjs-*` y ninguna variante core"
  - "render → sync --apply → render bajo `root`: cero cambios y sync no borra nada"
  · test: `commands/__tests__/status-render-pending.test.ts`
  - "justo después de cambiar a `root`, pendiente > 0; tras aplicar, 0 y drift 0"

## Lote 6 — `root` en Codex (commit `feat(codex): …`)

- [ ] **T11** (R8) — `renderCodexEngine` (`engines/codex/index.ts`) gana `harnessScope` y
  `rootHoist`. El plan sale de `planCodexSkills`, extraído del armado actual de `plan`.
  - Bajo `root` en un workspace, el plan queda vacío y `extraFiles` emite solo `AGENTS.md`.
  - `orphanScans` agrega `.codex/config.toml` y `.codex/rules/navori.rules` con
    `expected`.
  - La raíz recibe lo subido en `.agents/skills`, con `decideWorkspaceSkills` y
    `hoistTransform` compartidos.
  - Bajo `minimal` y `full`, el engine ignora `harnessScope`. `renderNonClaudeEngines`
    (`commands/render.ts`) pasa las opciones.
  · test: `engines/codex/__tests__/codex-root-scope.test.ts` (nuevo)
  - "bajo `root` el workspace queda solo con `AGENTS.md`"
  - "un `.codex/config.toml` con claves del usuario fuera del bloque se conserva"
  - "la raíz recibe lo subido en `.agents/skills`"
  - "bajo `minimal` el árbol Codex del workspace es idéntico al de antes"
  - "engines claude+codex+agents-md: segundo render con cero cambios"

## Lote 7 — doctor (commit `feat(doctor): …`)

- [ ] **T12** (R10) — Diagnóstico de los modos recortados:
  - `scanStaleHarness` (`lib/diagnose/stale-harness.ts`) reporta `trimmed-workspace` bajo
    `root`: cualquier archivo en `.claude/` del workspace, y `.codex/` y `.agents/skills`
    si `codex` está activo. Bajo `minimal` sigue igual.
  - En `commands/doctor.ts`, `workspaceMinimalHarness` pasa a `isTrimmedHarness`, y en modo
    recortado los invariantes del workspace se buscan en su texto más el de la raíz.
  - `buildEngineEvidence` y `buildEngineInventory` usan `planClaudeSkills` más la decisión.
  · test: `lib/diagnose/__tests__/stale-harness.test.ts`
  - "bajo `root`, un resto en `.claude/` del workspace se reporta"
  - "bajo `root`, un workspace sin `.claude/` no reporta nada"
  · test: `commands/__tests__/monorepo-plugin-invariants.test.ts`
  - "un invariante que vive en una skill de la raíz no da falso rojo en un workspace
    `minimal` ni `root`"
  · test: `commands/__tests__/doctor-workspace-harness.test.ts` (nuevo)
  - "la evidencia de un workspace `minimal` o `root` no marca `missing` agentes, hooks ni
    skills omitidas"

- [ ] **T13** (R11) — Bajo `full`, `doctor` muestra una nota informativa (es/en en
  `lib/i18n.ts`): hooks, agentes, settings y `.mcp.json` del workspace no se usan si la
  sesión arranca en la raíz. No cambia el veredicto ni el código de salida.
  · test: `commands/__tests__/doctor-workspace-harness.test.ts`
  - "bajo `full` aparece la nota y el veredicto es el mismo; bajo `minimal` y `root` no
    aparece"

## Evidencia del PR (no es gate de merge)

- [ ] **T14** — `navori render` en preview en moonar-medusa-monorepo y navori-health, bajo
  `minimal` y bajo `root`. El cuerpo del PR publica, por workspace, cuántas skills se
  quitan, cuántas se conservan (con razón) y cuántas se suben (con nombre). El
  comportamiento ya queda probado en CI por el fixture moonar de T5 y T10. Si los números
  contradicen el design, se corrige el design en el mismo PR, pero la medición no bloquea
  el merge.
  · sin test: es evidencia de campo.

## Trazabilidad

| R | Tareas | Tests |
|---|---|---|
| R1 | T9 | `schema.test.ts`, `config.test.ts`, `schema-publish.test.ts` |
| R2 | T2, T4 | `workspace-skill-dedup.test.ts`, `workspace-skills.test.ts` |
| R3 | T3, T4, T5 | `removable-normalize.test.ts`, `workspace-skill-dedup.test.ts`, `render-workspace-harness.test.ts` |
| R4 | T7, T10 | `workspace-root-scope.test.ts`, `render-workspace-harness.test.ts` |
| R5 | T6, T8 | `workspace-skills.test.ts`, `workspace-root-scope.test.ts` |
| R6 | T6, T8 | `workspace-skills.test.ts`, `workspace-root-scope.test.ts` |
| R7 | T10 | `render-workspace-harness.test.ts` |
| R8 | T11 | `codex-root-scope.test.ts` |
| R9 | T1, T5, T10 | `sync-workspace-harness.test.ts`, `render-workspace-harness.test.ts`, `status-render-pending.test.ts` |
| R10 | T12 | `stale-harness.test.ts`, `monorepo-plugin-invariants.test.ts`, `doctor-workspace-harness.test.ts` |
| R11 | T13 | `doctor-workspace-harness.test.ts` |
| R12 | T7 | `workspace-root-scope.test.ts` |
| R13 | T4, T7, T8 | `inject-notice-scope.test.ts`, `workspace-root-scope.test.ts` |
