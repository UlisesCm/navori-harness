# codegraph: costo neto frente a búsqueda textual (spec 0039 T31, R33/R34)

**Veredicto: `quitar-del-default`.** Ningún brazo de codegraph baja la mediana de contexto
acumulado frente al brazo textual; los dos la suben. Medición primaria (rep1, 15 tareas):
`maxFiles: 4` **+7.1%**, `maxFiles: 12` **+32.8%**, contra el umbral pre-registrado de **−15%**.
Las réplicas 2 y 3 dan el mismo veredicto.

- Fecha de corrida: 2026-10-01 (02:37–02:51 UTC del 2026-10-02).
- Pre-registro: `docs/research/claude-first-verificacion.md` § "Pre-registro / R34", commit
  `90918ed4` (2026-09-30). Esta medición es posterior y no cambia ningún criterio.
- Tareas y referencias congeladas antes de la primera corrida medida:
  `tasks.json` sha256 `88dd85d29fb2242ebcca4820a1d1f3aba8f1cc2a28535289b58b3ec41bba0a3f`,
  sellado 2026-10-02T02:37:17Z. La primera corrida medida terminó a las 02:37:32Z.

## 1. Montaje

| Elemento | Valor |
| --- | --- |
| Checkout medido | worktree desechable `navori-harness-t31-measure`, `origin/main` @ `a5d2647f` (detached) |
| Índice codegraph | `codegraph init -y .` solo en ese worktree: 601 archivos, 9,189 nodos, 36,828 aristas (12.0 s) |
| codegraph | 1.6.0, `CODEGRAPH_MCP_TOOLS=explore`, `CODEGRAPH_EXPLORE_DEDUP=0` (igual que el `.mcp.json` que renderiza navori), más `NO_DAEMON`, `NO_WATCH` y `NO_UPDATE_CHECK` |
| Claude Code | 2.1.287, `claude -p` |
| Modelo | alias `sonnet`, resuelto a `claude-sonnet-5-5` en el `modelUsage` de las 135 corridas |
| Tope | `--max-turns 30`, `--max-budget-usd 3` por corrida. Ninguna corrida llegó al tope |

**Por qué Sonnet.** Es el modelo por defecto de los agentes de descubrimiento del harness
(`scout`, `implementer`) y el que usó el protocolo de `search-v2-results.md` §9. Fijarlo evita
mezclar el efecto de la herramienta con el del modelo.

**Flags comunes a los tres brazos.** `--model sonnet --output-format stream-json --verbose
--no-session-persistence --setting-sources project --settings cfg/settings.json
--strict-mcp-config --tools Read,Grep,Glob,Bash`.

- `cfg/settings.json` es `{"disableAllHooks": true}`. Así ningún hook del repo inyecta contexto
  ni bloquea.
- `--no-session-persistence` mantiene las corridas fuera de `~/.claude/projects`. No contaminan
  las ventanas de `navori audit` de R43.
- Permisos por `--allowedTools` y no por el `settings.json` del proyecto. El workspace no es de
  confianza, así que el allowlist del proyecto se ignora (el bloqueo de §4.2 de
  `search-v2-results.md`). Allowlist: `Read`, `Grep`, `Glob` y `Bash` de solo lectura (`tgrep`,
  `grep`, `find`, `ls`, `cat`, `head`, `tail`, `sed -n`, `wc`, `git log`, `git grep`).
  Resultado: **0 `permission_denials`** en las 135 corridas.
- El contexto de sistema es el mismo en los tres brazos: CLAUDE.md del proyecto y del usuario,
  incluido el bloque "Code discovery routing".

**Diferencias entre brazos.** Solo cambian la herramienta disponible y `maxFiles`:

| Brazo | `--mcp-config` | Extra en `--allowedTools` |
| --- | --- | --- |
| (a) textual | `{"mcpServers":{}}` | ninguno |
| (b) `cg4` | codegraph vía `proxy.mjs 4` | `mcp__codegraph__codegraph_explore` |
| (c) `cg12` | codegraph vía `proxy.mjs 12` | `mcp__codegraph__codegraph_explore` |

**Cómo se fija `maxFiles`.** codegraph no expone una variable de entorno para `maxFiles`.
`proxy.mjs` es un proxy MCP por stdio que:

- reescribe `arguments.maxFiles = N` en cada `tools/call` de `codegraph_explore`;
- quita `maxFiles` del `inputSchema` publicado, así el modelo no lo elige;
- registra cada llamada en `raw/proxy-cg{4,12}.log`.

El modelo nunca pidió un `maxFiles` (las 30 llamadas llegaron con `requestedMaxFiles: null`).

**Concurrencia.** Una tarea a la vez, con sus tres brazos en paralelo (3 sesiones como máximo).

## 2. Métricas

Salen del mismo minero que `navori audit`. `metrics.ts` importa `sumTokens` desde
`packages/cli/src/lib/audit/parse.ts` del checkout medido y lo aplica a los eventos `assistant`
del `stream-json`, que tienen la misma forma que una línea de transcript.

- **Contexto acumulado:** `input + cache_read + cache_creation` sumado sobre los mensajes
  asistente únicos por `message.id`, con la regla de deduplicación de `sumTokens`.
- **Turnos:** mensajes asistente únicos. Es la definición de `turns` en `parse.ts`
  (`uniqueAssistantMessages`).
- **Mediana:** nearest-rank, `sorted[ceil(0.5·n) − 1]`, igual que `quantile` en
  `lib/audit/report.ts`. Con n = 15 coincide con la mediana clásica (el 8.º valor).
- **Corrección:** binaria. Una respuesta es correcta solo si contiene todos los "hechos
  requeridos" de la referencia. Se calificó a ciegas: las respuestas se barajaron con ids
  opacos (`blind-repN.txt`), se calificaron (`grades-repN.json`) y solo después se cruzaron con
  el brazo (`blind-repN-key.json`).
- **Secundaria:** pico de contexto por mensaje (`contextPeakOf`), llamadas por herramienta y
  bytes de resultado.

`stream-json` emite `output_tokens` parciales en los eventos `assistant`. Por eso ninguna
métrica de contexto usa `output`. El costo sale de `total_cost_usd` del evento `result`.

## 3. Tareas y referencias (escritas antes de correr)

Las 15 tareas son de descubrimiento puro sobre el repo, de solo lectura. A cada prompt se le
agrega el mismo sufijo: *"This is a read-only question about the repository in the current
working directory. Do not modify any file. Answer in at most ~150 words, citing file paths (and
line numbers when you can)."*

Mezcla de tipos:

- definición y comportamiento: T01, T02, T09, T10;
- constantes: T03, T04, T05;
- definición y llamadores o impacto: T06, T11;
- flujo: T07, T08;
- shell, fuera del índice de codegraph: T12;
- rutas y configuración: T13, T15;
- enumeración: T14.

Cada tarea tiene un prompt y una referencia con el código real, congelados en `tasks.json`. Aquí van el tipo y los hechos requeridos con que se calificó (binario: todos los hechos o incorrecta).

| Tarea | Tipo | Hechos requeridos |
| --- | --- | --- |
| T01 | definition+behavior | function contextPeakOf in lib/audit/parse.ts; sum input + cache_read + cache_creation; maximum over single messages (not a sum) |
| T02 | definition+behavior | function quantile in lib/audit/report.ts; nearest-rank ceil(q*n)-1; no averaging (lower median) / null when empty — at least the no-averaging point |
| T03 | constant lookup | default 0.1; fable-5-1 0.025; mythos-5-1 0.025; opus-5-5 0.05 |
| T04 | cross-file constants | level 2 at score >= 8; floors force level 2 (at least 3 of the 5 floor names); critical area +3 |
| T05 | cross-file behavior | weights 0 / 1 / 2 for <=1 / 2 / >=3; first two path segments |
| T06 | definition+callers | splitToolList in lib/render/frontmatter.ts; paren-depth aware, Agent(scout, scribe) is one entry; both callers agent-mcp-tools.ts and frontmatter-merge.ts |
| T07 | flow | withAgentMcpTools/rewriteAgentTools in engines/claude/agent-mcp-tools.ts; no tools: line → unchanged (inherits all); old wildcard removed/superseded |
| T08 | flow+reuse | buildDesiredMcpServers; alwaysLoad only when true; doctor (scanMcpCoherence) reuses it |
| T09 | definition+behavior | isRemovableNavoriFile in lib/render/removable.ts; managed marker present; version not newer than CLI (anti-rollback) |
| T10 | behavior | compares projectPath with cwd; metric names codegraph.calls and codegraph.projectpath.mismatch; signals.ts |
| T11 | callers/impact | defined in lib/render/render-plan.ts; at least 3 of the 4 call sites (claude/index.ts, prose-harness.ts, canonicalManagedOrder, applyPlanWithSkips) |
| T12 | shell (non-indexed language | guard-destructive.sh; at least 4 managed paths; exit 2 |
| T13 | config/paths | ~/.navori/audits + NAVORI_AUDITS_ROOT; ~/.claude/projects + NAVORI_TRANSCRIPTS_ROOT |
| T14 | enumeration | packages/cli/src/index.ts; full list of 26 (at most 1 missing, none invented) |
| T15 | config literal | off/local/full; default off; lib/config/schema.ts |

## 4. Resultados

### 4.1 Resumen por brazo

La réplica 1 (rep1) es la **medición primaria**. Las réplicas 2 y 3 son de robustez. Se
decidió correrlas, con la misma configuración, después de ver las métricas de rep1 y antes de
calificarla.

| Réplica | Brazo | Mediana ctx acumulado | Δ vs textual | Mediana turnos | Correctas | Costo |
| --- | --- | ---: | ---: | ---: | :-: | ---: |
| **rep1** | textual | **53,665** | — | 3 | 14/15 | $1.079 |
| **rep1** | cg4 | **57,498** | **+7.1%** | 3 | 15/15 | $1.070 |
| **rep1** | cg12 | **71,288** | **+32.8%** | 3 | 15/15 | $1.179 |
| rep2 | textual | 53,803 | — | 3 | 14/15 | $0.547 |
| rep2 | cg4 | 58,354 | +8.5% | 3 | 15/15 | $0.680 |
| rep2 | cg12 | 71,366 | +32.6% | 3 | 14/15 | $0.688 |
| rep3 | textual | 53,640 | — | 3 | 15/15 | $0.586 |
| rep3 | cg4 | 71,465 | +33.2% | 3 | 14/15 | $0.723 |
| rep3 | cg12 | 53,001 | −1.2% | 3 | 14/15 | $0.639 |
| 3 réplicas (mediana de medianas por tarea) | textual | 53,640 | — | 3 | 43/45 | |
| 3 réplicas | cg4 | 57,511 | +7.2% | 3 | 44/45 | |
| 3 réplicas | cg12 | 56,802 | +5.9% | 3 | 43/45 | |

Métricas secundarias de rep1:

| Brazo | Pico de contexto (mediana) | Ctx acumulado (media) | Tareas con ≥1 `codegraph_explore` |
| --- | ---: | ---: | :-: |
| textual | 19,350 | 61,752 | — |
| cg4 | 21,789 | 59,537 | 5/15 |
| cg12 | 21,646 | 66,901 | 6/15 |

### 4.2 Por tarea

`ctx` es el contexto acumulado en tokens. `Δ` es la diferencia contra el brazo textual de la
misma tarea y réplica.


#### rep1

| Tarea | textual ctx | turnos | ok | cg4 ctx | turnos | ok | Δ cg4 | cg12 ctx | turnos | ok | Δ cg12 |
|---|---:|---:|:-:|---:|---:|:-:|---:|---:|---:|:-:|---:|
| T01 | 48,854 | 3 | ✓ | 52,858 | 3 | ✓ | +8% | 52,448 | 3 | ✓ | +7% |
| T02 | 71,659 | 4 | ✓ | 79,580 | 4 | ✓ | +11% | 77,444 | 4 | ✓ | +8% |
| T03 | 53,665 | 3 | ✓ | 57,498 | 3 | ✓ | +7% | 55,834 | 3 | ✓ | +4% |
| T04 | 87,627 | 5 | ✓ | 76,789 | 4 | ✓ | -12% | 76,823 | 4 | ✓ | -12% |
| T05 | 82,682 | 5 | ✓ | 72,308 | 3 | ✓ | -13% | 88,726 | 5 | ✓ | +7% |
| T06 | 48,332 | 3 | ✗ | 44,112 | 2 | ✓ | -9% | 44,412 | 2 | ✓ | -8% |
| T07 | 50,083 | 3 | ✓ | 43,932 | 2 | ✓ | -12% | 44,181 | 2 | ✓ | -12% |
| T08 | 95,169 | 5 | ✓ | 72,585 | 3 | ✓ | -24% | 72,573 | 3 | ✓ | -24% |
| T09 | 67,467 | 4 | ✓ | 44,081 | 2 | ✓ | -35% | 100,939 | 4 | ✓ | +50% |
| T10 | 49,566 | 3 | ✓ | 72,135 | 4 | ✓ | +46% | 72,135 | 4 | ✓ | +46% |
| T11 | 34,570 | 2 | ✓ | 34,945 | 2 | ✓ | +1% | 71,288 | 3 | ✓ | +106% |
| T12 | 66,018 | 4 | ✓ | 71,352 | 4 | ✓ | +8% | 55,020 | 3 | ✓ | -17% |
| T13 | 86,962 | 5 | ✓ | 79,747 | 4 | ✓ | -8% | 100,615 | 4 | ✓ | +16% |
| T14 | 31,025 | 2 | ✓ | 33,691 | 2 | ✓ | +9% | 33,689 | 2 | ✓ | +9% |
| T15 | 52,598 | 3 | ✓ | 57,446 | 3 | ✓ | +9% | 57,394 | 3 | ✓ | +9% |

#### rep2

| Tarea | textual ctx | turnos | ok | cg4 ctx | turnos | ok | Δ cg4 | cg12 ctx | turnos | ok | Δ cg12 |
|---|---:|---:|:-:|---:|---:|:-:|---:|---:|---:|:-:|---:|
| T01 | 48,962 | 3 | ✓ | 52,216 | 3 | ✓ | +7% | 52,461 | 3 | ✓ | +7% |
| T02 | 71,140 | 4 | ✓ | 58,354 | 3 | ✓ | -18% | 76,420 | 4 | ✓ | +7% |
| T03 | 53,803 | 3 | ✓ | 78,118 | 4 | ✓ | +45% | 55,536 | 3 | ✓ | +3% |
| T04 | 85,125 | 5 | ✓ | 76,717 | 4 | ✓ | -10% | 114,518 | 6 | ✓ | +35% |
| T05 | 82,929 | 5 | ✓ | 96,135 | 5 | ✓ | +16% | 71,366 | 4 | ✓ | -14% |
| T06 | 49,266 | 3 | ✓ | 44,358 | 2 | ✓ | -10% | 72,708 | 3 | ✓ | +48% |
| T07 | 50,007 | 3 | ✓ | 43,930 | 2 | ✓ | -12% | 44,019 | 2 | ✓ | -12% |
| T08 | 72,702 | 4 | ✓ | 72,599 | 3 | ✓ | -0% | 120,028 | 6 | ✓ | +65% |
| T09 | 67,515 | 4 | ✓ | 104,519 | 4 | ✓ | +55% | 102,110 | 4 | ✓ | +51% |
| T10 | 52,999 | 3 | ✓ | 72,725 | 4 | ✓ | +37% | 89,486 | 5 | ✓ | +69% |
| T11 | 34,572 | 2 | ✓ | 37,214 | 2 | ✓ | +8% | 37,214 | 2 | ✓ | +8% |
| T12 | 51,364 | 3 | ✗ | 54,391 | 3 | ✓ | +6% | 52,491 | 3 | ✗ | +2% |
| T13 | 111,495 | 6 | ✓ | 80,521 | 4 | ✓ | -28% | 100,829 | 4 | ✓ | -10% |
| T14 | 31,025 | 2 | ✓ | 33,691 | 2 | ✓ | +9% | 33,691 | 2 | ✓ | +9% |
| T15 | 72,353 | 4 | ✓ | 55,755 | 3 | ✓ | -23% | 56,802 | 3 | ✓ | -21% |

#### rep3

| Tarea | textual ctx | turnos | ok | cg4 ctx | turnos | ok | Δ cg4 | cg12 ctx | turnos | ok | Δ cg12 |
|---|---:|---:|:-:|---:|---:|:-:|---:|---:|---:|:-:|---:|
| T01 | 48,316 | 3 | ✓ | 53,088 | 3 | ✓ | +10% | 53,001 | 3 | ✓ | +10% |
| T02 | 88,697 | 5 | ✓ | 80,137 | 4 | ✓ | -10% | 56,182 | 3 | ✓ | -37% |
| T03 | 51,944 | 3 | ✓ | 57,511 | 3 | ✓ | +11% | 57,427 | 3 | ✓ | +11% |
| T04 | 84,746 | 5 | ✓ | 93,787 | 5 | ✓ | +11% | 76,670 | 4 | ✓ | -10% |
| T05 | 82,425 | 5 | ✓ | 72,314 | 3 | ✓ | -12% | 89,237 | 5 | ✓ | +8% |
| T06 | 108,990 | 6 | ✓ | 100,838 | 4 | ✓ | -7% | 44,414 | 2 | ✓ | -59% |
| T07 | 50,093 | 3 | ✓ | 43,888 | 2 | ✓ | -12% | 44,179 | 2 | ✓ | -12% |
| T08 | 94,068 | 5 | ✓ | 72,599 | 3 | ✓ | -23% | 72,563 | 3 | ✓ | -23% |
| T09 | 111,697 | 6 | ✓ | 43,908 | 2 | ✗ | -61% | 43,893 | 2 | ✗ | -61% |
| T10 | 52,995 | 3 | ✓ | 71,658 | 4 | ✓ | +35% | 71,147 | 4 | ✓ | +34% |
| T11 | 34,599 | 2 | ✓ | 37,214 | 2 | ✓ | +8% | 37,214 | 2 | ✓ | +8% |
| T12 | 47,780 | 3 | ✓ | 71,465 | 4 | ✓ | +50% | 52,856 | 3 | ✓ | +11% |
| T13 | 85,092 | 5 | ✓ | 77,846 | 3 | ✓ | -9% | 107,101 | 4 | ✓ | +26% |
| T14 | 31,025 | 2 | ✓ | 33,691 | 2 | ✓ | +9% | 33,691 | 2 | ✓ | +9% |
| T15 | 53,640 | 3 | ✓ | 57,269 | 3 | ✓ | +7% | 36,461 | 2 | ✓ | -32% |

#### Herramientas usadas (rep1)

| Tarea | textual | cg4 | cg12 |
|---|---|---|---|
| T01 | Grep×1 Read×1 | Grep×1 Read×1 | Grep×1 Read×1 |
| T02 | Grep×2 Read×2 | Grep×2 Read×2 | Grep×2 Read×2 |
| T03 | Grep×1 Read×1 | Grep×1 Read×1 | Grep×1 Read×1 |
| T04 | Grep×3 Read×1 | Grep×2 Read×1 | Grep×2 Glob×1 Read×1 |
| T05 | Grep×3 Read×2 | cg×1 Grep×1 | Grep×3 Read×2 |
| T06 | Grep×2 Read×1 | cg×1 | cg×1 |
| T07 | Grep×1 Read×1 | cg×1 | cg×1 |
| T08 | Grep×4 Read×1 | cg×1 Grep×1 | cg×1 Grep×1 |
| T09 | Grep×2 Read×1 | cg×1 | cg×1 Grep×1 Read×1 |
| T10 | Grep×2 | Grep×2 Read×1 | Grep×2 Read×1 |
| T11 | Grep×1 | Grep×1 | cg×1 Grep×1 |
| T12 | Grep×2 Read×1 | Grep×3 | Grep×2 |
| T13 | Grep×3 Glob×1 Read×2 | Grep×2 Read×2 | cg×1 Grep×1 Read×1 |
| T14 | Grep×1 | Grep×1 | Grep×1 |
| T15 | Grep×2 | Grep×2 | Grep×2 |

#### Respuestas calificadas como incorrectas

| Réplica | Tarea | Brazo | Motivo |
| --- | --- | --- | --- |
| rep1 | T06 | textual | Dio `parseToolsField` (`lib/audit/harness.ts`) en lugar de `splitToolList`; parser y llamadores equivocados |
| rep2 | T12 | textual | Dice que llama a `block` pero no da el mecanismo `exit 2` (hecho requerido) |
| rep2 | T12 | cg12 | Igual que la anterior |
| rep3 | T09 | cg4 | Nombra `navoriAuthorship` (helper interno) como la función única, no `isRemovableNavoriFile` |
| rep3 | T09 | cg12 | Igual, y admite no haber leído el caso `"ours"` ni los llamadores |

Hubo tres respuestas de T14 (rep1 cg12, rep2 cg12 y rep2 cg4) que dicen "27 subcomandos" pero
listan bien los 26. Se calificaron correctas porque el hecho requerido es la lista.

## 5. Veredicto bajo la regla pre-registrada

La regla: codegraph conserva el default solo si `cg4` o `cg12` bajan **≥ 15%** la mediana de
contexto acumulado frente al textual, con corrección **≥** la textual. Se necesitan ≥ 12 tareas
válidas.

- **Tareas válidas:** 15 de 15. Todas terminaron con `subtype: success`, sin tope de turnos y
  sin denegaciones. La medición es válida (15 ≥ 12).
- **Umbral:** 53,665 × (1 − 0.15) = **45,615** tokens. Un brazo tendría que quedar en 45,615 o
  menos.
- **cg4:** (57,498 − 53,665) / 53,665 = 3,833 / 53,665 = **+7.14%**. Sube el contexto en vez
  de bajarlo. **No cumple**, aunque su corrección (15/15) es ≥ la textual (14/15).
- **cg12:** (71,288 − 53,665) / 53,665 = 17,623 / 53,665 = **+32.84%**. **No cumple**, aunque
  su corrección (15/15) es ≥ la textual.
- **Ningún brazo cumple, así que el veredicto es `quitar-del-default`.**

Robustez. Ninguna réplica ni el agregado de las tres se acerca al umbral. El mejor valor
observado es cg12 en rep3, con −1.2%, y además con corrección menor que la textual (14/15
contra 15/15).

`conservar-con-maxFiles` tampoco tiene apoyo. `maxFiles` casi no cambia el tamaño del
resultado: la mediana es 26,079 caracteres por llamada con 4 y 26,207 con 12 (rango
25,840–26,372 en total). Este repo (601 archivos) cae en el tramo `fileCount < 5000` de
codegraph 1.6.0, con `maxOutputChars: 24000` y `defaultMaxFiles: 8`. Ese tope de salida domina
antes que `maxFiles`. Las diferencias entre `cg4` y `cg12` vienen de la varianza del
comportamiento del modelo, no del parámetro.

## 6. Hallazgos secundarios (exploratorios, NO pre-registrados)

No entran en la regla de decisión ni la modifican; son observaciones posteriores a la medición.

- **El modelo casi no elige codegraph en estas tareas.** Lo usó en 5 de 15 tareas (cg4) y 6 de
  15 (cg12) en rep1, y en 15 de 45 corridas por brazo en las tres réplicas. En el resto usó
  `Grep` y `Read` igual que el brazo textual. Esto pasó aunque el bloque de routing y la
  descripción de la herramienta lo empujan a usar codegraph.
- **Costo fijo por estar disponible.** En T14 los tres brazos siguieron la misma ruta (un
  `Grep`, 2 turnos). Aun así, los brazos con codegraph cargaron **+2,666 tokens** de contexto
  acumulado en las tres réplicas, unos **+1,333 por turno**. Viene del esquema de la
  herramienta y de las instrucciones del servidor MCP, y se paga en cada turno de cada sesión,
  se use o no la herramienta.
- **Cuando sí se llama, ahorra algo, pero menos del umbral.** Se pareó cada corrida que llamó a
  `codegraph_explore` con la textual de la misma tarea y réplica. La mediana de Δ es **−12.3%**
  en cg4 (n = 15) y **−9.6%** en cg12 (n = 15). La dispersión es alta, de −61% a +106%.
  Cada llamada devuelve unos 26 k caracteres. En una pregunta de búsqueda puntual eso pesa más
  que un `Grep` más un `Read` acotado (p50 de `Read` en la línea base de T9: 3,788 bytes).
- **Más barato y equivocado.** En rep3 T09, los dos brazos de codegraph respondieron con 2
  turnos y unos 44 k de contexto (−61%), pero nombraron la función equivocada. El resultado de
  codegraph mostró primero el helper interno `navoriAuthorship`.

## 7. Amenazas a la validez

1. **Tipo de tarea.** Son preguntas de localización y comprensión acotada en un repo
   TypeScript mediano (601 archivos). El argumento de codegraph pesa más en preguntas de flujo e
   impacto amplio y en repos grandes. El set las incluye (T07, T08, T11), pero no domina. El
   pre-registro no fija la mezcla de tareas.
2. **Solo hilo principal.** No se ofreció `Agent`, así que no hubo subagentes. En producción
   `codegraph_explore` llega sobre todo a `implementer` y `scout` vía `withAgentMcpTools`. El
   hallazgo del costo fijo por turno aplica igual ahí, pero no se midió.
3. **Proxy de `maxFiles`.** En producción el modelo ve `maxFiles` en el esquema y, si lo omite,
   codegraph usa el default del tramo (8 aquí, no 12). El proxy quita el parámetro y lo fuerza.
   Como el modelo nunca lo pasó y el tope de 24 k caracteres domina, el efecto esperado es nulo.
   Aun así, el esquema no es idéntico al de producción.
4. **Mismo CLAUDE.md en los tres brazos.** El brazo textual ve el bloque de routing que nombra
   a CodeGraph aunque la herramienta no exista. Así se cumple "mismo prompt en todos los
   brazos", pero no es exactamente lo que renderiza un repo con el plugin apagado.
5. **Hooks apagados y workspace sin confianza.** Hooks como `routing-watch` y `session-start`
   no corrieron, y los permisos vinieron de flags. Se hizo para aislar la variable. No se midió
   el costo de los hooks.
6. **Un solo modelo** (`claude-sonnet-5-5`). Otro modelo puede elegir codegraph con otra
   frecuencia.
7. **Varianza.** Las Δ por tarea oscilan mucho entre réplicas: T09 cg12 dio +50%, +51% y −61%.
   La mediana textual fue estable (53,640–53,803). Las medianas de codegraph no (cg4
   57,498–71,465; cg12 53,001–71,366). Con n = 15 por réplica, el veredicto descansa en que
   ninguna de las 6 medianas de brazo × réplica llega a −15%.
8. **Calificación.** Las referencias y la calificación las hizo el mismo agente. El cegado por
   brazo mitiga el sesgo, pero no hubo un segundo calificador. Hubo dos casos límite: T12, donde
   falta `exit 2`, y T14, donde el conteo dice 27. Moverlos no cambia el veredicto, porque el
   veredicto falla por contexto, no por corrección.
9. **Designación de la réplica primaria.** El protocolo no fija réplicas. rep1 se declaró
   primaria antes de correr rep2 y rep3, pero después de ver sus métricas sin calificar. Las
   tres réplicas dan el mismo veredicto, así que la elección no lo cambia.
10. **Concurrencia.** Los tres brazos de una tarea corrieron en paralelo y comparten caché de
    prompt. Eso afecta el costo en dólares, no el contexto acumulado.
11. **Fuera del índice.** T12 es shell, que codegraph no indexa. Es realista porque los hooks de
    navori son shell, pero favorece al textual en esa tarea. Sin T12, rep1 queda en cg4 +9.2% y
    cg12 +35.5% (mediana de 14, nearest-rank).

## 8. Costo

| Concepto | USD |
| --- | ---: |
| Sonda de contexto/herramientas (1 corrida) | 0.070 |
| rep1, 45 corridas | 3.328 |
| rep2, 45 corridas | 1.915 |
| rep3, 45 corridas | 1.948 |
| **Total** | **7.26** |

El costo sale de `total_cost_usd` de cada `result`. Indexar con codegraph no tiene costo de API.

## 9. Reproducción y artefactos

Los artefactos crudos de la corrida (no versionados) son:

- `tasks.json` y `tasks.sha256`: tareas y referencias, con hash y sello de tiempo.
- `proxy.mjs`: proxy MCP que fija `maxFiles`.
- `cfg/`: `mcp-none.json`, `mcp-cg4.json`, `mcp-cg12.json` y `settings.json`.
- `run.mjs`: corredor. `REP=repN node run.mjs [T01,…]`; omite las corridas ya completas.
- `metrics.ts`: extractor con `sumTokens` de `parse.ts` (`REP=repN bun metrics.ts`).
- `analyze.py`: medianas, Δ y corrección por réplica.
- `raw/`: `stream-json` crudo y stderr de las 135 corridas, logs del proxy y la sonda `probe1.jsonl`.
- `metrics-rep{1,2,3}.json`, `blind-rep{1,2,3}.txt`, `blind-rep{1,2,3}-key.json` y
  `grades-rep{1,2,3}.json`.

El worktree de medición se eliminó al terminar. Para volver a correr `run.mjs` o `metrics.ts`, hay que recrearlo: `git worktree add ../navori-harness-t31-measure a5d2647f --detach` y luego `codegraph init -y .`.

## 10. Siguiente paso (T32)

Registrar el veredicto `quitar-del-default` como fila de la matriz, con `evaluation.evidence`
apuntando a este documento. Según T32 y R35, codegraph pasa a plugin opt-in, y el grant de
`withAgentMcpTools` para `codegraph_explore` (R38) se retira del default.
