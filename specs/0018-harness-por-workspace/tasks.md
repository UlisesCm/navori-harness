# Harness por workspace — solo lo que el motor alcanza — Tasks

## Lote 1 — el flag y el recorte

- [ ] **T1** (R1) — `MonorepoSchema` gana `workspaceHarness: z.enum(["minimal","full"]).default("minimal")`
  en `packages/cli/src/lib/schema.ts:89`, con el JSDoc que explica qué recorta y por
  qué el default es `minimal`. Regenerar el JSON Schema publicado con
  `pnpm gen:schemas`.
  · test: `src/lib/__tests__/schema.test.ts` — un config de monorepo sin el campo
  resuelve a `"minimal"`; `"full"` y `"minimal"` validan; cualquier otro string se
  rechaza. Con `// Covers: R1`.
  · test: `src/lib/__tests__/schema-publish.test.ts` ya falla si el JSON Schema
  publicado queda atrás — no requiere caso nuevo, sí correr `pnpm gen:schemas`.

- [ ] **T2** (R2, R3) — `renderClaudeEngine` gana la opción `harnessScope?: "minimal" | "full"`
  (default `"full"`, que es lo que hace hoy y lo que debe seguir haciendo el render
  de raíz). Bajo `"minimal"` se saltan los planes de `agents/`, `hooks/`,
  `scripts/`, `context/`, `planSettings` y `planMcpRegistration`; `CLAUDE.md` y
  `skills/` no cambian. Los dos call sites de workspace en
  `packages/cli/src/commands/render.ts:347,411` lo pasan desde
  `config.monorepo.workspaceHarness`; el de raíz (`:393`) no lo pasa nunca.
  · test: `src/commands/__tests__/render-workspace-harness.test.ts` — render de un
  monorepo con dos workspaces bajo `minimal`: existen `<ws>/CLAUDE.md` y
  `<ws>/.claude/skills/`; NO existen `<ws>/.claude/agents`, `/hooks`, `/scripts`,
  `/context`, `/settings.json` ni `<ws>/.mcp.json`. Y el `.claude/` de la RAÍZ
  conserva las seis piezas. Con `// Covers: R2`.
  · test: mismo archivo — bajo `"full"`, el árbol renderizado del workspace es
  idéntico al que produce el código actual (comparación contra el fixture dorado
  del monorepo). Con `// Covers: R3`.

## Lote 2 — la reconciliación

- [ ] **T3** (R4, R5) — `planOrphanRemoval` (`packages/cli/src/lib/removable.ts`)
  gana el caso "archivo bajo `<workspace>/.claude/` fuera del alcance de
  `minimal`": lo remueve si lleva marca de autoría de navori, lo conserva y lo
  reporta si no. Reusa la misma marca y el mismo reporte de conservados que el
  prune de engines retirados; no introduce un segundo mecanismo de propiedad.
  · test: `src/lib/__tests__/removable.test.ts` — un `<ws>/.claude/agents/reviewer.md`
  escrito por navori se remueve; un `<ws>/.claude/agents/mio.md` sin marca
  sobrevive y aparece en `keep` con su razón. Con `// Covers: R4, R5`.
  · test: `render-workspace-harness.test.ts` — render sobre un árbol previamente
  renderizado en `full` y luego cambiado a `minimal`: reporta las rutas removidas,
  y un segundo render seguido no reporta cambios ni borrados (idempotencia). Con
  `// Covers: R4`.

- [ ] **T4** (R6) — `scanOrphanedEngineOutputs` (`packages/cli/src/lib/health.ts`)
  detecta un `.claude/` que viva en un subdirectorio del repo que
  `monorepo.workspaces[]` no declara, y `doctor` lo reporta con la ruta y la
  versión del bloque managed más viejo que encuentre ahí — que es el dato que dice
  hace cuánto quedó congelado.
  · test: `src/lib/__tests__/health.test.ts` — un repo con `packages/cli/.claude/context/x.md`
  y sin `monorepo` declarado produce el hallazgo; el mismo directorio declarado
  como workspace no lo produce. Con `// Covers: R6`.

## Lote 3 — la prosa y el cierre

- [ ] **T5** (R7) — `packages/core/core-assets/managed/contexto-monorepo.md` gana,
  bajo `minimal`, la frase que dice que los agentes, hooks y settings del workspace
  son los de la raíz del repo. Sin ella, un colaborador que abre `apps/api/` ve un
  `.claude/` con solo `skills/` y lo lee como harness a medio instalar. El asset es
  core, así que la redacción no puede citar rutas de un engine concreto
  (`cited-paths-exist` y `render-codex` lo rechazan).
  · test: `src/engines/claude/__tests__/render-monorepo.test.ts` — el `CLAUDE.md`
  de un workspace bajo `minimal` contiene la cláusula; bajo `full` no. Con
  `// Covers: R7`.

- [ ] **T6** — rollout y medición del recorte: `navori render` en
  moonar-medusa-monorepo y navori-health, y reportar en el PR el conteo real de
  archivos removidos contra los 38 y 57 que predice el design. Si el número no
  cuadra, el diagnóstico tenía un hueco y eso se escribe antes de mergear.
  · sin test: es la verificación de campo del design, no comportamiento nuevo.
