# Inventario de lo que navori instala y ejecuta por defecto

Inventario de lo que el núcleo de navori escribe y ejecuta en un repo de usuario sin configuración adicional. Sirve de base para simplificar navori; las referencias son #1467, #1470 y #1455.

Base: `dev` en `65dbe3f00`, rama `docs/cleanup-inventory`. Estado: propuesta, no ejecutada. No se cortó código, configuración ni otros documentos.

## Método

- Render real: 14 repos scratch (preset `custom` y los 13 de `packages/core/core-assets/presets/`), engine `claude`, plugin `engram`, que es lo que escribe `navori init`. Comando: `navori render --apply --cwd <dir>` desde la worktree.
- Contexto de arranque: caracteres de `.claude/context/*.md` (Python). El hook `session-start-context.sh` se ejecutó en los directorios scratch para medir lo inyectado.
- Prosa: `wc -w` sobre la fuente (`packages/core/core-assets`) y sobre el render. Código: LOC sin tests.
- Tests: archivos `*.test.*` cuyo nombre contiene el elemento (`tgrep -F -l`). Es un proxy, no cobertura. Para engines se cuentan los archivos de test de su directorio. Varias filas de CLI coinciden en `classify.test.ts`, que es un test de clasificación de comandos.
- CI: `gh run view --json jobs` sobre corridas recientes de `dev` (push y PR).
- jey: solo lectura (`navori.config.json`, `.claude/`, `.navori/state/`, `.mcp.json`, `progress/history.md`). No se ejecutó ningún hook en jey.
- La columna "¿jey?" usa: sí (evidencia), parcial, instalado sin uso evidente, no verificado, no.

## 1. Instalación por defecto

Lo que escribe `navori init` en un repo nuevo: preset `custom`, engine `claude`, plugin `engram` (siempre activo).

| Elemento | Cantidad | Tamaño | Nota |
|---|---|---|---|
| Archivos escritos | 56 | — | incluye `CLAUDE.md`, `navori.config.json`, `.mcp.json`, `progress/` |
| `CLAUDE.md` | 1 | 1,024 palabras (≈914 en 7 bloques gestionados) | ver §3 |
| `.claude/context/` | 4 | 12,157 caracteres (1,820 palabras) | ver §2 |
| `.claude/skills/` | 18 | 15,696 palabras renderizadas | ver §4 |
| `.claude/agents/` | 8 | 16,203 palabras renderizadas | ver §5 |
| `.claude/hooks/` | 18 en disco, 15 registrados (17 registros) | ≈18,200 líneas en disco | ver §6 |
| `.claude/settings.json` | 1 | 18,818 bytes; 97 allow, 50 ask, 138 deny | permisos de seguridad |
| `.mcp.json` | 1 | servidor `engram` | plugin siempre activo |
| Binario `navori` | 29 comandos, 92 subcomandos | 20,186 LOC en `commands/` | no se escribe en el repo; ver §10 |

## 2. Contexto residente en SessionStart, por preset

| Preset | Contexto en `.claude/context/` (caracteres) | Inyectado por el hook (caracteres) | Archivos extra | Palabras extra |
|---|---|---|---|---|
| `custom` (default) | 12,157 | 8,338 | 0 | 0 |
| `astro` | 12,157 | 8,338 | +1 | +538 |
| `bun-keystone` | 12,157 | 8,338 | +6 | +3,115 |
| `express` | 12,157 | 8,338 | +2 | +988 |
| `express-mongoose` | 12,157 | 8,338 | +4 | +2,042 |
| `fastapi-python` | 12,157 | 8,338 | +1 | +516 |
| `medusa` | 12,157 | 8,338 | +2 | +690 |
| `monorepo-turbopnpm` | 12,157 | 8,338 | +1 | +397 |
| `nestjs` | 12,157 | 8,338 | +2 | +1,008 |
| `nextjs` | 12,157 | 8,338 | +3 | +1,802 |
| `react-native-expo` | 12,157 | 8,338 | +2 | +1,047 |
| `vite-react-ts` | 12,157 | 8,338 | +1 | +415 |
| `vite-react-ts-mantine` | 12,157 | 8,338 | +2 | +936 |
| `background-worker` | 12,157 | 8,338 | +3 | +1,313 |

Notas:

- Los cuatro archivos son idénticos en los 14 presets (mismo hash). Los presets no tocan el contexto de arranque; su peso va a skills y `CLAUDE.md`.
- "Palabras extra" cuenta los archivos que añade el preset. No cuenta las líneas que el preset escribe en `CLAUDE.md`, `navori.config.json` y `.claude/hooks/guard-destructive.sh`.
- El hook inyecta 8,338 caracteres (8,443 bytes). Presupuesto: 8,000. Inline: `10-orquestacion` y `20-agentes-disponibles`. Puntero: `30-arranque-sesion`, `40-cierre-sesion` y `progress/current.md`.
- Este repo (preset `custom`, `harness.planTiers` activo): 15,805 caracteres en `.claude/context/`, incluido `05-planificacion`. El hook inyecta 7,617 caracteres; `10-orquestacion` y `40-cierre-sesion` salen como puntero.
- jey (preset `custom`, `harness.masterPlan` activo): 12,846 caracteres. Estimado sin ejecutar el hook: `07-plan-maestro` y `10-orquestacion` inline (6,834); `20-agentes-disponibles` queda como puntero (8,440 supera 8,000).
- Prueba para #1455 (directorios scratch con solo esos archivos): con `10`, `20` y `30`, sin `40`, el hook sigue marcando `30` como puntero. `10` y `20` suman 7,750 caracteres y `30` pesa 1,318. Faltan ≈1,070 caracteres, no ~300. Hoy `40` ya es puntero, así que sacarlo del canal no libera espacio para `30`.

## 3. Bloques gestionados (CLAUDE.md y `.claude/context/`)

Tamaño: fuente / render. Las cifras de render difieren de la fuente porque se aplican condiciones e idioma.

| Bloque | Dónde aterriza | Tamaño | Condición | Tests | ¿jey? | Propuesta | Razón |
|---|---|---|---|---|---|---|---|
| `idioma-rol` | CLAUDE.md | 127 / 127 palabras | siempre | 1 | sí | conservar | identidad e idioma |
| `formato-respuesta` | CLAUDE.md | 142 / 142 | siempre | 1 | sí | conservar | formato de respuesta |
| `tipado-fuerte` | CLAUDE.md | 40 / 40 | `project.typedLanguage` | 0 | sí | conservar | corto y condicional |
| `operaciones-seguras` | CLAUDE.md | 289 / 289 | siempre | 4 | sí | conservar | seguridad: lectura por defecto |
| `sdd` | CLAUDE.md | 256 / 127 | `sdd.enabled` (default true) | 12 | sí | conservar; recortar con #1467 | protocolo de specs |
| `intake-tickets` | CLAUDE.md | 268 / 38 | siempre | 3 | sí | conservar | regla de tickets |
| `code-discovery-routing` | CLAUDE.md | 151 / 151 | siempre | 2 | sí | conservar | elige la herramienta de búsqueda |
| `orquestacion` | `.claude/context/10` | 1,188 / 6,144 caracteres | siempre | 29 | sí | conservar; recortar a 4.5–5 k caracteres | decide cuándo delegar; #1455 opción 2 |
| `agentes-disponibles` | `.claude/context/20` | computado / 1,606 caracteres | agentes habilitados | 10 | sí | conservar | catálogo barato |
| `arranque-sesion` | `.claude/context/30` | 190 / 1,318 caracteres | siempre | 5 | sí | conservar; fundir en `orquestacion` o recortar | no cabe hoy (§2); #1455 opción 3 |
| `cierre-sesion` | `.claude/context/40` | 467 / 3,089 caracteres | siempre | 12 | sí | conservar fuera del canal SessionStart | #1455 opción 1; ya es puntero |
| `planificacion` | `.claude/context/05` | 403 / 2,752 caracteres | `harness.planTiers` (default false) | 7 | no | opt-in congelado | doctrina de niveles de plan; #1467 |
| `plan-maestro` | `.claude/context/07` | 82 / 614 caracteres | `harness.masterPlan` (default false) | 2 | sí | opt-in congelado | #1470 |
| `codex-cross-review` | sub-bloque de `orchestrator.md` | 139 / — | solo engine `codex` | 0 | sí | conservar | ya es condicional |

## 4. Skills (18 por defecto)

Tamaño: palabras fuente / palabras renderizadas en la instalación por defecto.

| Skill | Tamaño | Tests | ¿jey? | Propuesta | Razón |
|---|---|---|---|---|---|
| `master-plan` | 3,010 / 2,760 | 31 | sí (`specs/_master`, `masterPlan` true) | opt-in congelado; renderizar solo con `harness.masterPlan` | #1470; es la skill más grande y se instala sin el flag |
| `review-diff` | 1,357 / 1,376 | 34 | sí (229 handoffs `review_`) | conservar | revisión de diffs |
| `solution-design` | 1,244 / 1,256 | 13 | sí (17 handoffs `solution_`) | conservar | la usa `architect` |
| `security-invariants` | 1,202 / 1,211 | 8 | no verificado | conservar | seguridad |
| `spec-bootstrap` | 1,108 / 1,110 | 15 | sí (`specs/`) | conservar; recortar con #1467 | scaffolding SDD |
| `debug-failure` | 1,007 / 1,001 | 12 | no verificado | conservar | diagnóstico de fallos |
| `resolve-ticket` | 1,032 / 920 | 16 | no verificado (sin commits de ticket) | conservar | doctrina de `intake-tickets` |
| `scoped-gate` | 854 / 863 | 6 | no verificado | conservar | ligado a `qualityGate.scoped` |
| `locate-code` | 842 / 851 | 17 | no verificado | conservar | ruteo de búsqueda |
| `verify-before-done` | 791 / 781 | 33 | no verificado | conservar | cierre de tarea; barato |
| `author-skill` | 600 / 609 | 3 | no verificado | opt-in congelado | meta: solo al crear skills |
| `follow-up-prs` | 570 / 582 | 7 | no verificado | conservar | seguimiento de PRs |
| `plan-advanced` | 553 / 562 | 6 | parcial (92 handoffs `workplan_` con `planTiers` false) | opt-in congelado, ligar a `planTiers` | #1467; decidir en jey antes de cortar |
| `plan-simple` | 543 / 552 | 9 | parcial (mismo caso) | opt-in congelado, ligar a `planTiers` | #1467 |
| `dominio` | 454 / 466 | 6 | instalado sin uso evidente (2 commits, sin store) | opt-in congelado | base de conocimiento de workspace |
| `quality-attributes` | 200 / 212 | 5 | no verificado | conservar | barato |
| `context-intake` | 289 / 298 | 7 | sí (ligado a `master-plan`) | opt-in congelado, ligar a `masterPlan` | solo para etapas de `master-plan` |
| `secure-by-design` | 274 / 286 | 4 | no verificado | conservar | seguridad |

## 5. Agentes (8 por defecto)

| Agente | Tamaño (fuente / render) | Tests | ¿jey? | Propuesta | Razón |
|---|---|---|---|---|---|
| `orchestrator` | 3,429 / 3,183 | 22 | sí | conservar | rol principal |
| `implementer` | 2,699 / 2,068 | 32 | sí (128 handoffs `impl_`) | conservar | implementación |
| `reviewer` | 3,240 / 2,856 | 33 | sí (229 `review_`) | conservar | revisión |
| `scout` | 1,186 / 1,191 | 13 | sí (15 `scout_`) | conservar | reconocimiento |
| `auditor` | 1,760 / 1,987 | 11 | sí (17 `audit_`) | conservar | auditoría |
| `publisher` | 4,103 / 3,907 | 16 | sí (5 `pr_`) | conservar; recortar (el más largo) | publicación de PRs |
| `architect` | 811 / 799 | 8 | sí (17 `solution_`) | conservar | diseño de solución |
| `scribe` | 843 / 212 | 7 | no (`scribeOwnsMarkdown` false, 0 handoffs) | opt-in congelado, ligar a `scribeOwnsMarkdown` | sin función con el flag apagado |

## 6. Hooks

Líneas: fuente (LOC) / en disco en la instalación por defecto (incluye partials inlinados). Los tests cuentan archivos que nombran el hook.

| Hook | Evento y matcher | Líneas | Tests | ¿jey? | Propuesta | Razón |
|---|---|---|---|---|---|---|
| `guard-destructive` | PreToolUse Bash | 969 / 2,892 | 38 | sí (registrado) | conservar | seguridad; área crítica |
| `comment-draft-confirm` | PreToolUse Bash | 205 / 994 | 7 | sí | conservar | confirma publicar comentarios e issues |
| `pr-publisher-confirm` | PreToolUse Bash | 222 / 1,011 | 7 | sí | conservar | `gh pr create` fuera del publisher |
| `quality-gate-pre-commit` | PreToolUse Bash (timeout 600 s) | 367 / 1,735 | 21 | sí | conservar | corre `qualityGate.fast` antes de commit |
| `subagent-no-background` | PreToolUse Bash\|Monitor | 165 / 884 | 3 | sí | conservar | mecánico y barato |
| `general-purpose-confirm` | PreToolUse Agent | 73 / 441 | 5 | sí | conservar | confirma el despacho de `general-purpose` |
| `session-start-context` | SessionStart | 632 / 1,182 | 18 | sí | conservar; reducir contenido (§2) | inyecta el contexto |
| `model-advisor` | SessionStart, PostModelSwitch, Stop | 273 / 504 | 9 | sí | opt-in congelado (decidir) | 3 disparos por sesión; costo no medido |
| `managed-drift-watch` | PostToolUse Bash\|Edit\|Write\|NotebookEdit | 334 / 844 | 7 | sí | conservar | drift de bloques gestionados; área crítica |
| `routing-watch` | PostToolUse (4 matchers) | 444 / 1,498 | 11 | sí | opt-in congelado (decidir) | consejo, no bloquea; dispara en cada herramienta |
| `subagent-stop-handoff` | PostToolUse Agent\|Task | 520 / 1,030 | 14 | sí | conservar | valida el contrato de handoff |
| `bash-outcome-watch` | PostToolUseFailure Bash | 25 / 1,028 | 3 | sí | conservar | barato |
| `worktree-reclaim` | SessionEnd | 281 / 791 | 6 | sí | conservar | evita acumular checkouts de agentes (#527) |
| `audit-mode-trigger` | UserPromptSubmit | 108 / 658 | 9 | instalado sin uso trazable (17 `audit_`) | opt-in congelado (decidir) | corre en cada prompt; inerte sin activación |
| `audit-mode-close` | SessionEnd | 57 / 425 | 6 | igual | opt-in congelado (decidir) | cierra el log de audit mode |
| `implementer-no-markdown` | PreToolUse Bash\|Edit\|Write\|NotebookEdit | 806 / 1,316 | 9 | en disco, no registrado | opt-in congelado | solo con `scribeOwnsMarkdown` |
| `master-accept-confirm` | PreToolUse Bash | 105 / 679 | 6 | sí (registrado, `masterPlan` true) | opt-in congelado, ligar a `masterPlan` | en disco sin registro si el flag está apagado; #1470 |
| `master-plan-context` | SessionStart | 73 / 304 | 6 | sí (registrado) | opt-in congelado, ligar a `masterPlan` | #1470 |

No se instalan por defecto:

| Hook | Condición | Líneas | Tests | ¿jey? | Propuesta |
|---|---|---|---|---|---|
| `plan-gate` | `harness.planTiers` | 229 | 10 | no | opt-in congelado (#1467) |
| `stop-verify-reminder` | `hooks.verifyOnStop` (default false) | 100 | 8 | no | opt-in congelado |
| `role-guard`, `engram-write-guard` | solo engine Codex | 332, 114 | 5, 3 | sí (`.codex/hooks/`) | conservar en Codex |
| `_partials/` (16 archivos) | inlinados en hooks | 2,899 | — | — | conservar (infraestructura) |

## 7. Engines

| Engine | LOC sin tests | Archivos de test | Por defecto | ¿jey? | Propuesta | Razón |
|---|---|---|---|---|---|---|
| `claude` | 4,671 | 34 | sí (único) | sí | conservar | engine por defecto |
| `codex` | 2,400 | 9 | no (`engines`) | sí (`.codex/`, 7 agentes TOML) | conservar | en uso en jey |
| `pi` | 4,241 | 27 | no | sí (`.pi/`) | conservar | en uso en jey |
| `agents-md` | 48 | 1 | no | no (`AGENTS.md` también lo escribe `codex`) | opt-in congelado | sin uso fuera de la lectura universal; costo bajo |
| `cursor` | 55 | 1 | no | no | opt-in congelado | sin uso en jey |
| `copilot` | 41 | 1 | no | no | opt-in congelado | sin uso en jey |
| `shared` | 8,386 | 25 | sí (base común) | — | conservar | código compartido |

## 8. Plugins

| Plugin | Por defecto | Palabras (md) / líneas (sh) | Tests | ¿jey? | Propuesta | Razón |
|---|---|---|---|---|---|---|
| `engram` | sí (siempre activo en `init`) | 814 / 0 | 33 | sí (`.mcp.json`; extensión en `AGENTS.md`) | conservar | memoria del protocolo |
| `gh` | no; con `--recommended` si hay remoto GitHub | 94 / 0 | 1 | sí | conservar | PRs; barato |
| `tgrep` | no; con `--full` | 104 / 250 | 18 | instalado sin uso evidente (sin `.tgrep`, 0 menciones en `progress/history.md`) | conservar | ruteo de búsqueda |
| `codegraph` | no (opt-in) | 134 / 0 | 22 | instalado sin uso evidente (en `.mcp.json`, sin `.codegraph/`) | opt-in congelado | ya es opt-in |
| `acli` | no; con `--full` | 164 / 0 | 3 | no | opt-in congelado | Jira externo; `--full` lo agrega sin necesidad |

## 9. Presets

Los 13 presets y `custom` se ven en §2 (tamaño añadido por preset). Todos extienden `core`. No hay telemetría de uso por preset; no se retira ninguno sin datos. Propuesta: conservar, revisar con el uso real en bonum.

## 10. Comandos de la CLI

LOC del archivo de comando (`packages/cli/src/commands/`, sin tests). Subcomandos de primer nivel; los anidados se indican.

| Comando | Subcomandos | LOC | Tests | Lo ejecuta un hook por defecto | ¿jey? | Propuesta | Razón |
|---|---|---|---|---|---|---|---|
| `init` | 0 | 1,459 | 3 | no | sí | conservar | entrada |
| `add` | 0 | 514 | 1 | no | no verificado | conservar | alta de plugins |
| `remove` | 0 | 114 | 2 | no | no verificado | conservar | baja de plugins |
| `adopt` | 0 | 163 | 2 | no | no verificado | conservar | toma archivos hechos a mano |
| `configure` | 9 | 775 | 1 | no | no verificado | conservar | edición de config |
| `update` | 0 | 186 | 1 | no | no verificado | conservar | actualiza el CLI |
| `refresh` | 0 | 615 | 0 | no | no verificado | conservar | redetecta y sincroniza |
| `render` | 0 | 2,415 | 18 | no | sí (archivos renderizados) | conservar | núcleo |
| `sync` | 0 | 1,527 | 5 | no | no verificado | conservar | sincronización de engines |
| `scan` | 0 | 253 | 1 | no | no verificado | conservar | solo monorepos |
| `registry` | 5 | 181 | 1 | no | no | opt-in congelado | solo para `render --all` |
| `doctor` | 0 | 4,749 | 6 | no | no verificado | conservar | diagnóstico; candidato a dividir, no a retirar |
| `status` | 0 | 204 | 3 | no | no verificado | conservar | resumen de estado |
| `bench` | 0 | 71 | 1 | no | no | eliminar del binario | herramienta de mantenedor; si hace falta, va a `scripts/` |
| `workspace` | 9 | 568 | 1 | no | no | opt-in congelado | cross-repo; jey no usa workspace |
| `ticket` | 6 | 282 | 1 | no | no | opt-in congelado | tickets de workspace |
| `backup` | 3 | 208 | 1 | no | no verificado | conservar | seguridad: restaurar tras un render |
| `migrations` | 2 | 184 | 1 | no | no verificado | conservar | seguridad: revertir migraciones de init |
| `preset` | 1 | 117 | 1 | no | no | conservar | presets locales; barato |
| `codex` | 5 (incluye `evaluation`, `profile`, `trust`, `approval`, `integration`) | 772 | 1 | no | engine sí; subcomandos no verificados | opt-in congelado | evidencia en vivo y perfiles nativos sin uso verificado |
| `dominio` | 6 | 171 | 2 | sí (SessionStart invoca `dominio inject`) | instalado sin uso evidente | opt-in congelado; el hook omite `inject` sin store | base de conocimiento de workspace |
| `audit` | 0 | 1,568 | 1 | parcial (solo con sesión armada) | sí (17 handoffs `audit_`) | opt-in congelado, junto con audit mode | ver §11 |
| `receipt` | 4 (+3 anidados en `review`) | 316 | 2 | no | no | opt-in congelado | gate de milestones |
| `plan` | 8 | 974 | 3 | solo con `planTiers` | parcial | opt-in congelado | #1467 |
| `spec` | 2 | 261 | 0 | no | sí (`specs/`) | conservar | `spec check` es barato; alimenta #1467 |
| `handoff` | 8 | 343 | 0 | no | sí (535 handoffs) | conservar `check`; congelar `*-parallel`, `attest` y `render` | `check` valida antes de despachar |
| `master` | 19 | 809 | 6 | solo con `masterPlan` | sí | opt-in congelado | #1470 |
| `tools` | 2 | 142 | 1 | sí (SessionStart) | sí (por hook) | conservar | avisos de versión; opt-out con `NAVORI_NO_UPDATE_NOTIFIER=1` o `CI` |
| `gate` | 0 | 131 | 1 | sí (`quality-gate-pre-commit`) | sí (176 logs en `.navori/state/gate/`) | conservar | ejecuta `qualityGate` |

## 11. Librerías de soporte

| Librería | LOC | Cuándo se ejecuta | ¿jey? | Propuesta | Razón |
|---|---|---|---|---|---|
| `lib/audit` | 20,859 | `subagent-stop-handoff` llama `navori audit --capture-child` solo si hay log de sesión armada; SessionStart consume la bandera de `navori audit --arm` | sí (17 handoffs `audit_`) | opt-in congelado | mayor librería del core; inerte sin activación |
| `lib/master` | 6,426 | solo con `harness.masterPlan` | sí | opt-in congelado | #1470 |
| `lib/plan` | 3,470 | solo con `harness.planTiers` | parcial | opt-in congelado | #1467 |
| `lib/codex` | 5,327 | solo con engine `codex` | sí | conservar | engine soportado |
| `lib/diagnose` | 6,118 | `doctor` y `status`; ningún hook por defecto | no verificado | conservar | diagnóstico |
| `lib/render` | 3,614 | `init`, `render`, `sync` | sí | conservar | núcleo |
| `lib/primitives` | 2,256 | avisos de versión en SessionStart; worker en segundo plano con red (npm y GitHub) | sí | conservar | opt-out con `NAVORI_NO_UPDATE_NOTIFIER=1` o `CI` |

## 12. Gates y CI

Tiempos: medidos cuando se midió en CI o en esta sesión; el resto está marcado "est.".

| Gate | Qué corre | Dónde | Tiempo | Clase | Tests | Propuesta |
|---|---|---|---|---|---|---|
| `qualityGate.fast` | `check:fast`: format, lint, typecheck, `check:dup`, `check:ast` | hook `quality-gate-pre-commit` antes de commit; `navori gate fast` | est. <1 min; pasos de CI de 0–2 s | local | 21 (hook) | conservar |
| `nativeHooks` | `scripts/git-hooks/pre-commit`, instalado por `prepare` | cada commit humano | igual que `fast` | local | — | conservar |
| `qualityGate.scoped` | `check:scoped`: `fast` + links, render, assets, doc budgets, blame-ignore, size | local; skill `scoped-gate` | est. 2–4 min | aceptación de slice | 6 (skill) | conservar; revisar solape con `full` |
| `qualityGate.affected` | `test:affected` | local; CI job `affected` | CI 3.9 min (medido, 1 muestra) | PR | 2 | conservar |
| `qualityGate.docs` | `check:links`, `check:doc-budgets`, 3 tests de dirección y comandos | local | medido: links 1 s; budgets <1 s; tests est. <1 min | local | 3 archivos | conservar; es barato |
| `qualityGate.full` | `check` completo, incluido `test:coverage` | CI en push a dev, PR a main y PR a dev con `full`; local manual | CI ≈4 min de pared (shards 2.1–3.5 min en paralelo; merge 0.3–0.4) | PR (≤10 min) | 7 (coverage) | conservar; único gate con cobertura completa |
| CI `checks` (`ci.yml`) | build, website, size, render, assets, lint, typecheck, format, dup, ast, links, budgets, blame-ignore, tests-preserved | PR y push | 26 s (medido) | PR | — | conservar |
| CI `plan` | `test-affected --plan-json` | PR a dev | 0.2–0.3 min (medido) | PR | — | conservar |
| CI `test` (4 shards) y `test-merge` | `run-test-coverage --shard` y merge con floor | push; PR a main; PR a dev con `full` | 2.1–4.3 min por shard; merge 0.2–0.4 min (medido) | PR | — | conservar |
| CI `affected` | `test-affected` con presupuesto | PR a dev sin `full` | 3.9 min (medido, 1 muestra) | PR | — | conservar |
| CI `semgrep` | Semgrep, solo hallazgos nuevos | push y PR a main | no medido | PR a main | — | conservar |
| Workflow `deploy-website` | build y despliegue de la web | push a main; `workflow_dispatch` | no medido | main | — | fuera de gates |
| Workflow `release-tag` | crea el tag `v<version>` | push a main | no medido | main | — | fuera de gates |
| Diario | ninguno | — | — | diario | — | no existe: no hay `schedule` en `.github/workflows/` |

## 13. No medido

- Duración local de `check:fast`, `check:scoped` y `check`: solo estimada.
- Costo por sesión de `routing-watch` (cuatro matchers) y de `model-advisor` (tres eventos): sin conteo de disparos.
- Uso real de skills y agentes en jey: solo hay evidencia indirecta (handoffs por rol). No hay trazas por skill.
- Contexto inyectado en jey: estimado por tamaño de archivo; el hook no se ejecutó.
- Uso por preset en bonum u otros repos: no revisado.
- Tiempo de `semgrep`: sin corridas en `dev`.
- Una corrida de PR (`feat/0062-rust-e2-distribucion`, 33.8 min) tiene jobs `quality`, `oracle`, `tarball` y `post-cutover`. Pertenece a un workflow que no está en `.github/workflows/` de `dev`; se excluyó.
- Tests por nombre: proxy, no cobertura.
- La consulta a CodeGraph devolvió símbolos de otra worktree; no se usó ese resultado.

## Resumen de la propuesta

Sale del render por defecto (condicionado a flag):

- Skills: 5,247 palabras (`master-plan` 2,760; `author-skill` 609; `plan-advanced` 562; `plan-simple` 552; `dominio` 466; `context-intake` 298).
- Agente `scribe`: 212 palabras.
- Subtotal: 5,459 palabras, 17 % de las 31,899 palabras renderizadas de skills y agentes.
- Hooks en disco sin registro: `implementer-no-markdown` (1,316 líneas), `master-accept-confirm` (679) y `master-plan-context` (304). Suman 2,299 líneas que dejan de escribirse sin flag. No cambia el comportamiento: hoy no están registrados.

Decisión pendiente, fuera del total:

- `audit-mode-trigger` y `audit-mode-close`: 1,083 líneas. La activación por frase depende de ellos.
- `routing-watch`: 1,498 líneas. `model-advisor`: 504 líneas. Requiere medir el costo por sesión.

Contexto residente:

- `cierre-sesion` (3,089 caracteres) sale del canal de arranque. Hoy ya es puntero, así que no libera espacio.
- Para que `arranque-sesion` entre hay que recortar ≈1,070 caracteres de `orquestacion` o `agentes-disponibles`, o fundir `arranque-sesion` en `orquestacion`. La medición no confirma el margen de ~300 caracteres de #1455.

Sin cambio: `CLAUDE.md`, `.claude/context/` (12,157 caracteres), permisos, engines `claude`, `codex` y `pi`, plugin `engram`, y los gates de CI.

Único candidato a añadir: una prueba que falle si la suma de bloques inline supera 8,000 caracteres, como propone #1455. Cuesta poco y protege contra la regresión.

Riesgos:

- jey instala `plan-*` sin `planTiers` (92 handoffs `workplan_`) y usa `master-plan` con `masterPlan`. Condicionar por flag cambia su render si el flag se apaga; jey debe ajustarse antes.
- Los hooks de audit mode tienen activación por frase. Quitarlos del default rompe esa vía.

Decisiones que se piden:

1. Condicionar por flag `master-plan`, `context-intake`, `plan-simple`, `plan-advanced`, `dominio`, `author-skill` y `scribe` (5,459 palabras).
2. Dejar de escribir `implementer-no-markdown`, `master-accept-confirm` y `master-plan-context` sin su flag.
3. Decidir `audit-mode-*`, `routing-watch` y `model-advisor`, con medición de costo.
4. Recortar `orquestacion` o fundir `arranque-sesion` (cambia #1455).
5. Retirar `bench` del binario y dejar `codex` experimental congelado.
