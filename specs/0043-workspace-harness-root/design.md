# Harness de workspace con arranque desde la raíz — Design

Extiende `specs/0018-harness-por-workspace/design.md`. Toda referencia a código es
`archivo` + símbolo, verificada contra `origin/main` (`d1ffe68d`, `git fetch origin main`
el 2026-10-06). Revisado tras el challenge `solution_review_spec-0043.md` (F1–F14); cada
hallazgo se resuelve en la sección que lo cita.

## Lo que ya existe

- **El recorte de 0018.** `renderClaudeEngine` (`packages/cli/src/engines/claude/index.ts`)
  recibe `harnessScope?: "minimal" | "full"`; bajo `minimal`, `harnessPlan` vacía `agents`
  y `hooks` y conserva **todas** las skills del inventario filtrado (`resolveHarnessPlan` →
  `filterInventory`): core + workflow + extras de preset + librerías. Esa es la duplicación
  de #1143.
- **La reconciliación de 0018.** `reconcileTrimmedWorkspace` + `WORKSPACE_TRIMMED_PATHS`
  (`commands/render.ts`) borra con `planOrphanRemoval` (`lib/render/removable.ts`), que solo
  pide marcador, y respalda con `createBackup`. `.claude/skills` no está en la lista.
- **Comparar contra lo que navori renderiza en limpio ya es un patrón.**
  `renderManagedFile` (`engines/shared/render-managed-file.ts`) con `existingContent: null`
  da los bytes frescos de una unidad. Codex lo usa en `freshRender`
  (`engines/codex/index.ts`), y `OrphanScan.expected` (`engines/shared/execute-plan.ts`,
  spec 0041 R13) lo usa para exigir `requirePristine` antes de borrar.
- **Las podas de skills del engine.** §8.6, §8.7 y §8.8 de `renderClaudeEngine` borran por
  registro estático, a través de `commitWrites`, que respalda y reporta cada borrado con
  `status: "removed-condition-false"`. §8.7 considera seleccionado todo id de
  `harnessPlan.skills` (#1094) y borra lo demás con `planDirSkillRemoval` sin `pristine`.
- **Quién lee el modo hoy.**
  - `runRender`, en sus dos rutas.
  - `scanStaleHarness` (`lib/diagnose/stale-harness.ts`).
  - `workspaceMinimalHarness` en `commands/doctor.ts`.
  - **No** lo lee `renderSyncTarget` (`commands/sync.ts`): llama a `renderClaudeEngine` sin
    `harnessScope`, así que `sync --apply` reescribe agentes, hooks y settings bajo
    `minimal` (confirmado en el challenge, punto 1).
- **`status` cuenta lo pendiente con `countRenderStatuses`** (`commands/render.ts`). Cuenta
  el `written` de cada engine, borrados incluidos, pero no `WorkspaceRenderResult.trimmed`
  (F4).
- **Claude Code y las skills** (doc oficial, consultada el 2026-10-06,
  https://code.claude.com/docs/en/skills):
  - Carga las skills de proyecto *"in the directory where you start it and in every parent
    directory up to the repository root"*. Una sesión abierta dentro del workspace sigue
    viendo las skills de la raíz.
  - Las skills anidadas cargan en diferido. Si chocan de nombre con una de la raíz, *"both
    stay available"* y aparecen calificadas (`apps/web:deploy`).
  - `name` es el nombre del comando y solo cae al nombre del directorio si falta.
- **Hay skills de preset por workspace.** `effectiveConfigForWorkspace`
  (`lib/workspace/monorepo.ts`) permite sobrescribir `preset`, `qualityGate` y librerías, y
  los presets incluidos traen skills propias: `medusa.json` trae `medusa-modules` y
  `medusa-api-routes`; `nextjs.json` trae `nextjs-app-router`, `nextjs-data-fetching` y
  `new-resource`.
- **Medición de campo del challenge** (`cmp` de los `SKILL.md` en disco):
  - Copias byte-idénticas a la raíz: 13 por workspace en moonar y 14 en navori-health.
  - Varias copias difieren solo por claves de frontmatter que asset nuevos agregaron
    (`type:`, `maxWords:`), con el mismo `version=`.

## Decision drivers

Derivados de `docs/DIRECTION.md` y de las áreas críticas del config:

1. **Invariante 4.** Lo del usuario es intocable. Las skills traen zona de usuario
   (`asset.userTemplate`), así que solo se borra lo que no lleva nada del usuario.
2. **Invariante 5.** Todo borrado se ve en un preview antes de ocurrir.
3. **Invariante 7.** Un solo pipeline. Ningún borrador nuevo, un solo productor de plan y
   un solo criterio de autoría.
4. **Invariante 3.** La decisión depende solo de `navori.config.json` y de los assets.
5. **Área crítica.** Ante la duda, se conserva.

## Opciones

- **A — Solo agregar `root`.** Deja `minimal`, que es el default, con 13–14 copias
  idénticas por workspace. Se descarta sola; queda como parte de C.
- **B — Solo deduplicar `minimal`.** No cumple la aceptación de #1143: el workspace sigue
  con `.claude/`. Se descarta sola.
- **C — B + A en un PR (elegida).** Una decisión pura de qué skills escribe cada workspace,
  alimentada por un único productor de plan y consumida por render, sync y doctor.
- **Dedup por id (Q3 literal).** Se descarta: `core-assets/lib-skills/vitest.md` interpola
  `{{qualityGate.fast}}` y el workspace puede sobrescribir `qualityGate`. Con el mismo id
  puede haber bytes distintos.

## Approach

`monorepo.workspaceHarness: "minimal" | "full" | "root"`, default `minimal`. Es **un solo
valor para todo el monorepo** (`MonorepoSchema`): un repo con unas apps de arranque en raíz
y otras de arranque en app no se puede expresar, igual que en 0018.

| | workspace Claude | workspace Codex | raíz |
|---|---|---|---|
| `full` | todo, sin cambios | todo, sin cambios | sin cambios |
| `minimal` | `CLAUDE.md` + las skills cuyos bytes frescos difieren de la raíz o que la raíz no tiene | sin cambios (decisión del usuario) | sin cambios |
| `root` | solo `CLAUDE.md` | solo `AGENTS.md` | + las skills de librería y de preset de los workspaces; core/workflow: gana la raíz |

## Components

- `packages/cli/src/lib/config/schema.ts` — `MonorepoSchema.workspaceHarness` pasa a
  `z.enum(["minimal", "full", "root"]).default("minimal")`, con JSDoc y `.describe()`. Se
  regenera `apps/website/public/schema/navori.config.v1.json` con `bun run gen:schemas` —
  cubre R1.
- `packages/cli/src/lib/config/config.ts` — `readConfig`: cuando un issue de zod es un enum
  inválido, el `ConfigError` agrega una pista estable ("puede venir de un navori más nuevo:
  actualiza"). Sirve para la siguiente adición de enum; los CLIs ya publicados no se pueden
  arreglar (ver Failure modes) — cubre R1.
- `packages/cli/src/engines/claude/index.ts`:
  - `planClaudeSkills(cwd, config, { repoRoot })` (nuevo, exportado) es el único productor
    del plan de skills. Hace `loadActivePreset` + `resolveHarnessPlan` + `filterInventory`
    y devuelve `{ skills, presetLoaded, warnings }`. Lo usan el propio
    `renderClaudeEngine`, `runRender`, `sync` y `doctor` (F6). Las advertencias se emiten
    solo desde el render del engine, nunca desde el productor compartido.
  - `composeFreshClaudeSkill` (nuevo, exportado) devuelve los bytes frescos de una skill
    con sus sub-bloques `injectInto`. Se extrae de `applySubBlockInject`, sin duplicar
    lógica.
  - `renderClaudeEngine` acepta `harnessScope: "root"` y dos opciones nuevas,
    `workspaceSkills` y `rootHoist`.
  - §8.7 calcula `selectedLibs` desde el plan **previo** al filtro (F2).
  - Las podas usan el criterio prístino único.
  - `buildSkillRows` gana una lista de exclusión (R13).
  - `buildContextoMonorepoBody` gana la variante `root` (R12).
  - Cubre R2–R6, R12, R13.
- `packages/cli/src/engines/shared/workspace-skills.ts` (nuevo) — decisión pura y piezas
  compartidas por Claude y Codex para que `jscpd` no vea dos copias (F14):
  - `WorkspaceHarness` y `isTrimmedHarness`;
  - `workspaceSlug`;
  - `decideWorkspaceSkills`;
  - `planOmittedSkillRemoval`, parametrizado por directorio de skills;
  - `hoistTransform`, que reescribe el frontmatter.
  - Cubre R2, R3, R5, R6, R8.
- `packages/cli/src/lib/render/removable.ts` — `PristineOpts.requirePristine` gana
  `normalize?: (onDisk: string) => string`, que se aplica antes de `hasUserWrittenText`
  (F3) — cubre R3, R7.
- `packages/cli/src/engines/shared/execute-plan.ts` — cambios en el pipeline compartido:
  - `PendingRemoval` gana un `status` opcional, que `commitWrites` usa en vez de
    `removed-condition-false`, para que el reporte diga "duplicada en la raíz" (F8);
  - la rama `skill-dir` de `collectOrphans` respeta `OrphanScan.expected`;
  - cubre R3, R7, R8.
- `packages/cli/src/engines/codex/index.ts` — `renderCodexEngine` gana `harnessScope` y
  `rootHoist`. Bajo `root`, el plan del workspace queda vacío y `extraFiles` emite solo
  `AGENTS.md`. `orphanScans` agrega `.codex/config.toml` y `.codex/rules/navori.rules` con
  `expected`. La raíz recibe lo subido — cubre R8.
- `packages/cli/src/commands/render.ts` — `runRender`, en sus dos rutas:
  - calcula la decisión una vez, antes de escribir;
  - pasa `harnessScope`, `workspaceSkills` y `rootHoist`;
  - corre `reconcileTrimmedWorkspace` bajo `isTrimmedHarness`, más un barrido de
    `.claude/skills` y `.claude/` vacíos (F13);
  - `countRenderStatuses` cuenta `ws.trimmed` como pendiente (F4);
  - el resumen agrega una línea por workspace con los conteos (F8).
  - Cubre R3, R4, R7, R9.
- `packages/cli/src/commands/sync.ts` — `SyncTarget` gana `harnessScope` y `workspaceSkills`
  en sus dos construcciones (ruta `--workspace` y bucle). `renderSyncTarget` los pasa con
  `prune: false`. **sync no borra nada nuevo**: deja de recrear lo que el modo omite, y el
  borrado queda en `render`, con preview (F4) — cubre R9.
- `packages/cli/src/lib/diagnose/stale-harness.ts` y `packages/cli/src/commands/doctor.ts` —
  `isTrimmedHarness` en vez de `=== "minimal"`. Además:
  - restos bajo `root`;
  - invariantes contra el texto del workspace más el de la raíz;
  - evidencia e inventario sacados de `planClaudeSkills` más la decisión;
  - nota informativa bajo `full`.
  - Cubre R10, R11.
- `packages/cli/src/lib/i18n.ts` — variante `root` de `blocks.monorepo`, nota de `full` y
  línea de conteo de recorte, en es/en — cubre R11, R12.

## Contracts

**Schema (R1).** El cambio es aditivo y estricto (no `tolerantEnum`); ver Failure modes.

**Productor único de plan (F6):**

```ts
export function planClaudeSkills(
  cwd: string,
  config: NavoriConfig,
  opts: { repoRoot: string },
): { skills: readonly PlannedSkill[]; presetLoaded: boolean };
```

Codex usa el mismo patrón con `planCodexSkills`: la misma llamada con la que
`renderCodexEngine` arma su `plan`, extraída de ahí.

**Decisión pura** (`engines/shared/workspace-skills.ts`):

```ts
export type WorkspaceHarness = "minimal" | "full" | "root";
export function isTrimmedHarness(mode: WorkspaceHarness): boolean; // minimal | root

export type SkillKind = "core" | "workflow" | "preset" | "library";

export interface HoistedSkill {
  /** Final directory name and marker id at the root: the original id or `slug-id`. */
  id: string;
  source: PlannedSkill;
  /** Effective config of the source workspace — what the bytes were rendered with. */
  config: NavoriConfig;
  /** Set only for `slug-id`: sanitized workspace name for the description prefix. */
  workspaceName?: string;
}

export interface WorkspaceSkillDecision {
  /** Workspace path → ids of planned skills that workspace does not write. */
  omitted: ReadonlyMap<string, ReadonlySet<string>>;
  /** Skills the root adds. Only workspaces under `root` contribute. */
  hoisted: readonly HoistedSkill[];
  /** Root dirs a previous hoist may have left (see "Limpieza de lo subido"). */
  rootPruneCandidates: readonly HoistedSkill[]; // ver Addendum 2026-10-07
  /** Hoists skipped because the root path belongs to someone else, for the report. */
  blocked: ReadonlyArray<{ workspace: string; id: string; reason: "foreign" | "modified" | "newer" }>;
}

export function decideWorkspaceSkills(input: {
  mode: WorkspaceHarness;
  root: { config: NavoriConfig; skills: readonly PlannedSkill[]; presetLoaded: boolean };
  workspaces: ReadonlyArray<{
    ws: MonorepoWorkspace;
    config: NavoriConfig;
    skills: readonly PlannedSkill[];
    presetLoaded: boolean;
  }>;
  kindOf: (skill: PlannedSkill) => SkillKind;
  /** Fresh bytes of one skill under one config, for ONE engine. */
  render: (skill: PlannedSkill, config: NavoriConfig) => string;
  /**
   * The root WILL hold a navori-owned skill dir with this final name after this run.
   * Answered from disk only, plus the root plan when this run renders the root first.
   */
  rootHas: (finalName: string) => boolean;
  /** Authorship of an existing root skill dir not in the root plan (`navoriAuthorship`). */
  rootAuthorship: (finalName: string) => "absent" | NavoriAuthorship;
}): WorkspaceSkillDecision;
```

**Reglas, en orden:**

1. Bajo `full` no se omite ni se sube nada.
2. Si el preset de un workspace no cargó, o el de la raíz no cargó, ese workspace no omite
   ni sube nada y `rootPruneCandidates` queda vacío.
3. Bajo `minimal`, una skill se omite si y solo si se cumplen las tres condiciones:
   - la raíz la planea con el mismo id;
   - los bytes coinciden: `render(skill, wsConfig) === render(rootSkill, rootConfig)`;
   - `rootHas(id)`.
4. Bajo `root`, para cada skill del workspace:
   - **core/workflow:** se omite si `rootHas(id)`. La raíz gana sin variantes, por decisión
     del usuario (R5).
   - **library/preset** que la raíz planea con los mismos bytes: se omite si `rootHas(id)`.
   - **library/preset** que la raíz no planea, o planea con bytes distintos: se agrupa por
     id con los aportes de los demás workspaces `root`.
     - Si todos coinciden entre sí y la raíz no la planea, el nombre final es el id
       original.
     - En cualquier otro caso, cada aporte se llama `slug-id`.
     - Si ya existe en la raíz un directorio con ese nombre final y no es de navori
       (`rootAuthorship` ≠ `ours`/`absent`), el aporte va a `blocked` y no se sube.
     - Si se sube, se omite del workspace solo si `rootHas(finalName)`.
   - Lo que no cumple su guardia **no se omite**: el workspace lo sigue escribiendo y el
     reporte lo muestra. R4 se cumple en el siguiente render completo (F1).

**`workspaceSlug(ws, all)`:**

1. Toma `ws.name` en minúsculas y reemplaza cada tramo fuera de `[a-z0-9]` por `-`,
   recortando los guiones de los extremos (`@moonar/backend` da `moonar-backend`).
2. Si dos workspaces dan el mismo slug, ambos usan el slug de su `path`.
3. Si aun así chocan, se agrega un sufijo numérico en el orden de `monorepo.workspaces[]`.

**Opciones de `renderClaudeEngine`:**

- `harnessScope?: WorkspaceHarness`. El default sigue siendo `full`; la raíz nunca lo
  pasa.
- `workspaceSkills?: { omitted: ReadonlySet<string>; prune: boolean }`.
  - Las omitidas salen de `harnessPlan.skills` antes de `collectPlan`.
  - Con `prune: true` (`render`), cada copia omitida en disco, en forma directorio o plana,
    pasa por `planOmittedSkillRemoval`.
  - Con `prune: false` (`sync`), no se tocan.
  - `selectedLibs` de §8.7 se calcula con el plan **sin** filtrar, así que una omitida
    nunca la poda §8.7 con el criterio débil (F2).
- `rootHoist?: { skills: readonly HoistedSkill[]; pruneCandidates: readonly HoistedSkill[] }` (ver Addendum 2026-10-07).
  Solo lo pasa el render de la raíz, en todo modo mientras haya `monorepo` declarado.
  - Las subidas entran a `harnessPlan.skills` y se renderizan con la config de su
    workspace.
  - Las `slug-id` usan `hoistTransform`: `name` pasa a `slug-id` y `description` se
    antepone con el nombre saneado del workspace (`sanitizeProjectValue`), recortando el
    original para no pasar `SKILL_LISTING_CHAR_CAP` (`lib/assets/skill-meta.ts`).
  - `pruneCandidates`, menos lo deseado en esta corrida, pasa por
    `planOmittedSkillRemoval`.
  - `config.project.libraries` de la raíz no se toca (R5).

**Criterio prístino único (F2, F3).** Toda eliminación de esta spec usa
`navoriAuthorship(path, managedId, { verifyHash: true, requirePristine: { expected, normalize } })`.
Esto vale para copias omitidas, restos de `root`, lo subido que se poda y los skills de
Codex. Los parámetros son:

- `expected`: los bytes frescos de la unidad (`composeFreshClaudeSkill`, o `freshRender` en
  Codex).
- `normalize`: re-renderiza el contenido en disco (`renderManagedFile` con
  `existingContent = onDisk`). Así, las claves de frontmatter que son del asset se
  refrescan antes de comparar; las claves y la zona del usuario sobreviven a ese
  re-render y siguen contando.

Una copia de un asset viejo (sin `type:` ni `maxWords:`) queda prístina. Una con una clave
o un párrafo del usuario, no. Solo `ours` se borra. `foreign`, `modified` y `newer` se
conservan, no se reescriben y se reportan.

El 0018 de directorios (`reconcileTrimmedWorkspace` → `planOrphanRemoval`) **no** se
extiende a skills. Sigue siendo el único sitio que borra solo con marcador, para agentes,
hooks y settings. Ver NOT in scope.

**Reporte (F8).** Los borrados de esta spec llevan
`PendingRemoval.status = "removed-trimmed"`. Lo conservado viaja en
`WorkspaceRenderResult.trimmedKept` (con la misma razón que `KeepReason`), no en
`warnings`, y `buildRenderJson` lo expone. El resumen humano imprime una línea por
workspace, *"apps/api: 13 skills duplicadas de la raíz quitadas, 2 conservadas"*, y lista
las rutas solo de las conservadas. `countRenderStatuses` suma `removed-trimmed` y
`ws.trimmed`, así que `status` ve el recorte pendiente (F4).

## Decisions

- **Bytes frescos para decidir y el disco normalizado para borrar.** La decisión usa bytes
  frescos: no depende del estado del disco y dos máquinas deciden igual con el mismo
  config. El borrado mira el disco, porque es ahí donde vive lo del usuario, pero
  normalizado: si no, la deriva de frontmatter (F3, medida en moonar) dejaría copias
  conservadas para siempre y #1143 no se cumpliría en la práctica.
- **Un solo productor de plan, consumido por el engine, `runRender`, `sync` y `doctor`
  (F6).** El `resolveHarnessPlan` sin `filterInventory` de `reportMissingLocalSkills` no es
  la fuente: un id que la matriz nativa retira (§8.7e) haría que la decisión y el engine
  discreparan.
- **La decisión se calcula una vez por corrida, antes de cualquier escritura.** Preview y
  apply ven las mismas entradas, así que lo que muestra uno es lo que hace el otro (F6). En
  la ruta completa, la raíz se escribe primero, y si `commitWrites` de la raíz lanza,
  `runRender` aborta antes del bucle de workspaces.
- **`sync` no borra (F4, alternativa adoptada).** `sync` pasa `harnessScope` y la decisión
  con `prune: false`. Deja de recrear lo omitido y no agrega borrados fuera de su preview.
  El que reconcilia es `render` (y `update`, que es un render), con preview y conteo.
- **Core/workflow: gana la raíz (decisión del usuario, R5).** Una variante por workspace de
  `review-diff` sería otra skill casi idéntica en el listado de la raíz: el mismo ruido que
  #1143 quiere quitar. Lo que se pierde es el gate propio del workspace, que esas skills
  interpolan. Lo recupera R12: bajo `root`, el `CLAUDE.md` del workspace dice que sus
  skills viven en la raíz y, si su `qualityGate` difiere del de la raíz, nombra sus
  comandos `fast` y `full`. `buildContextoMonorepoBody` en la raíz solo lista nombre, ruta
  y preset.
- **`slug-id` solo para librería/preset en conflicto.** Si se le da el nombre original al
  primer aporte, reordenar `workspaces[]` renombraría skills. `ws:id` choca con el
  separador que Claude Code usa para sus variantes calificadas. Se reescribe `name` porque
  el comando sale de `name`, no del directorio.
- **Índice de skills (F12, R13).** Bajo `minimal`, el índice del workspace excluye las
  omitidas: ya están en el índice de la raíz, que siempre carga, y listarlas dos veces es
  contexto duplicado. Bajo `root`, el workspace no lleva índice. La raíz lista lo subido con
  su nombre final.
- **Sub-bloques de plugin.** `applySubBlockInject` trata un destino omitido como "vive en
  la raíz": no avisa (#676) y no reinyecta en la copia vieja. Si reinyectara, el segundo
  render nunca llegaría a cero.
- **Codex: `root` sí, `minimal` no** (decisión del usuario). Bajo `root` el modo hace lo
  que el usuario declaró, así que no hace falta probar si Codex alcanza `.codex/` anidado.
  `.agents/skills` del workspace se poda con la rama `skill-dir` usando `expected`.
- **`agents-md`, `cursor`, `copilot` y Pi no cambian.** Su archivo por workspace es el
  análogo del `CLAUDE.md`. Pi escribe skills solo si `codex` no está en `engines`
  (`renderPiEngine`), así que no compite con la poda de Codex.

## Failure modes

- **La raíz no tiene el destino.** Pasa con `render --workspace` o `sync --workspace` en un
  repo cuya raíz nunca recibió lo subido, o cuando la escritura de la raíz falla. Lo
  resuelve la guardia `rootHas(finalName)` de las reglas 3 y 4 (F1):
  - en esas rutas se responde solo desde el disco;
  - el workspace conserva todo lo que la raíz no tenga con ese nombre final;
  - el siguiente render completo converge.
- **Destino ocupado en la raíz por algo ajeno.** Por ejemplo, una skill local del usuario o
  una copia adoptada (#1114). El aporte va a `blocked`, no se sube, el workspace lo
  conserva y el reporte lo dice (F10).
- **Preset que no carga.** Aplica la regla 2: no se omite ni se sube nada y la limpieza se
  congela, igual que §8.7.
- **Copia no prístina.** Se conserva, no se reescribe y se reporta en `trimmedKept`. El
  usuario puede actuar: borrarla o mover su texto.
- **CLI viejo leyendo `root` (F11).**
  - El anti-retroceso no interviene: compara `version=` de marcadores
    (`navoriAuthorship` → `isDowngrade`), y un valor de config no tiene versión.
  - La carga sí falla: `readConfig` hace `safeParse` y lanza
    `ConfigError("Validation failed …")` en todo comando. Eso incluye los que
    `core-assets/settings/settings-base.json` preaprueba para agentes (`navori doctor`,
    `status`, `audit`, `receipt`, `handoff`), así que los flujos de agente con un CLI
    global viejo también caen.
  - La pista de T9 solo existe en CLIs nuevos; los publicados no se pueden arreglar.
  - Se mantiene estricto: un fallback silencioso a `minimal` recrearía skills en los
    workspaces de quien tenga un CLI viejo, que es churn sobre un valor que gobierna
    borrados.
  - Mitigación textual: el cuerpo del PR y la nota de release llevan *"Antes de poner
    `workspaceHarness: "root"`, actualiza navori en todo el equipo, en CI y en el CLI
    global que usan los agentes: una versión anterior rechaza el config completo."*
  - Los editores marcan `root` hasta que se despliegue el schema del website.
- **`render --workspace X` bajo `root`** no refresca lo subido en la raíz; el siguiente
  render completo lo hace. Es el contrato actual de `--workspace`.
- **Directorios vacíos (F13).** Después de los borrados, `removeEmptyDirs` barre
  `.claude/skills` y `.claude/` del workspace, y solo los quita si quedaron vacíos.
  `progress/`, escrito por el bootstrap de una sola vez, es del usuario y queda; R4 habla de
  `.claude/`.

## Migration

El default es `minimal`, así que el primer `update` o `render` tras el upgrade cambia repos
que no tocaron su config (F9):

1. **Preview.** `render` y `update` (`runRender(cwd, true)` antes de aplicar) muestran,
   por workspace, la línea de conteo y la lista de lo conservado con su razón. `status`
   reporta el recorte como render pendiente.
2. **Apply.** `commitWrites` respalda exactamente lo que borra (#405); `navori backup` lo
   restaura.
3. **Tamaño.** Lo medido en disco es el techo: hasta 13 por workspace en moonar y 14 en
   navori-health, unas 68 en los dos repos. El criterio prístino normalizado deja
   desaparecer también las copias que solo tienen deriva de frontmatter. T14 publica el
   número real en el PR.
4. **Salidas.** `workspaceHarness: "full"` vuelve al comportamiento previo byte a byte.
   No hay un "minimal sin dedup": la copia idéntica no aporta nada, porque una sesión
   abierta dentro del workspace también ve las skills de la raíz (doc citada).
5. **Lo que `minimal` no arregla.** Siguen las copias del workspace que difieren de verdad
   (gate propio, preset propio), y con ellas los choques calificados del tipo
   `apps/web:review-diff`. Para eso existe `root`.

La nota de release (`apps/website/src/content/releases.ts`) se escribe en el PR de release,
como siempre. El cuerpo de este PR lleva el número de T14 y el texto del CLI viejo.

## Testing strategy

Cada test responde a un riesgo nombrado arriba.

- **Dedup por bytes, no por id (R2).** Se omite la idéntica. Se conserva la que interpola
  un `qualityGate` sobrescrito y la que solo existe en el workspace.
- **El borrado respeta al usuario (R3, R7, F2, F3).**
  - Una copia prístina se borra y queda en el backup.
  - Una copia de un asset viejo, sin `type:` ni `maxWords:`, cuenta como prístina y se
    borra.
  - Sobreviven y se reportan en `trimmedKept`: una con una clave de frontmatter del
    usuario, una con texto en la zona de usuario, una sin marcador y una de un navori más
    nuevo.
  - Una skill de librería implícita del preset, omitida y con texto del usuario, sobrevive
    (el camino de §8.7).
- **Fixture moonar (F14).** Dos workspaces con preset propio (`medusa`, `nextjs`), uno con
  `qualityGate` sobrescrito y copias con frontmatter viejo. Se verifica qué se omite, qué se
  conserva y qué se sube, en `minimal` y en `root`.
- **Guardia de no-pérdida (R3, R4, F1).** `render --workspace` en `minimal` y en `root`,
  con la raíz sin renderizar o sin lo subido, conserva todas las skills del workspace.
- **La raíz no pierde nada y gana lo justo (R5).** Su set de skills bajo `minimal` no
  cambia. Bajo `root` gana solo librería/preset, nunca variantes core, y `contexto-proyecto`
  queda byte-idéntico.
- **Colisiones deterministas (R6).**
  - Bytes iguales dan una sola skill con el id original; bytes distintos dan `slug-id`.
  - `name` y `description` se reescriben, y la descripción no pasa
    `SKILL_LISTING_CHAR_CAP`.
  - Reordenar `workspaces[]` no renombra nada.
  - Un destino ajeno en la raíz va a `blocked`.
- **Transiciones (R7, R9).** `full` → `root`, `root` → `minimal` y un conflicto que
  desaparece. En `full` → `root` no queda ningún `.claude/`, ni siquiera vacío.
- **Idempotencia en todos los caminos (R9, F4).**
  - Render dos veces da cero cambios en el segundo.
  - Render → `sync --apply` → render también da cero, y `sync` no borra nada.
  - `status` reporta pendiente > 0 justo después de cambiar el modo, y 0 tras aplicar.
- **Codex (R8).** Bajo `root` queda solo `AGENTS.md` y se conserva un `config.toml` con
  claves del usuario. Bajo `minimal`, el árbol Codex no cambia.
- **doctor (R10, R11).** Sin `missing` por lo omitido, sin falsos rojos de invariantes y
  con los restos de `root` reportados. Bajo `full` aparece la nota y el veredicto no cambia.
- **Avisos e índice (R13).** No hay aviso de sub-bloque para un destino omitido. El índice
  del workspace excluye lo omitido y el de la raíz lista lo subido.
- **Inventario de borrados.** `removal-parity.test.ts` sigue verde y no aparece ningún
  sitio de borrado fuera de `commitWrites` y `reconcileTrimmedWorkspace`.

## NOT in scope

- **Recortar Codex bajo `minimal`.** Es decisión del usuario.
- **Pi, `agents-md`, `cursor` y `copilot` bajo `root`.** Ver Decisions.
- **Endurecer a prístino el recorte de directorios de 0018.** Hoy borra agentes, hooks y
  settings solo con marcador, con backup. Es el mismo riesgo que aquí se evita para skills,
  pero precede a esta spec y cambia `minimal` para todos. Va como follow-up.
- **`.claude/scripts` en `WORKSPACE_TRIMMED_PATHS`.** Aunque #637 les dio marcador. Va como
  follow-up; `scanStaleHarness` los sigue reportando.
- **Un `slug-id` huérfano en la raíz por renombrar o quitar un workspace (F10).**
  - `rootPruneCandidates` sale del config actual. Encontrar un slug viejo exigiría escanear
    directorios, que §8.7 rechaza con razón: con un plan incompleto se borrarían skills
    válidas.
  - El impacto es acotado: solo existen `slug-id` para skills de librería/preset en
    conflicto, y el resto conserva su marcador, sin borrarse nunca a ciegas.
  - El cuerpo del PR documenta el borrado manual.
- **`navori configure workspace` para elegir el modo.** Hoy no escribe `workspaceHarness`.
- **La mitad de `status` de #1143.** Ya está en `main` (`computeRenderPending`); aquí solo
  se extiende el conteo.

## Addendum 2026-10-07 — `rootPruneCandidates` es `HoistedSkill[]`

El diseño tipaba `rootPruneCandidates` y `pruneCandidates` como `ReadonlySet<string>`. El
código usa `readonly HoistedSkill[]` (`engines/shared/workspace-skills.ts`): el planificador
de borrado (`planOmittedSkillRemoval`) necesita, además del nombre del directorio, lo que
hace falta para juzgar si el archivo sigue intacto, y un set de strings no lo lleva. La
semántica no cambia: sale del config actual y queda vacío si un preset no cargó.
