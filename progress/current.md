# Sesión actual

**Estado:** idle. `main` limpio y al día. **23 issues abiertos**: los 11 previos (alcance
decidido, post-release) + los 12 de la auditoría de cableado+reprocesos del 2026-08-20
(#398–#409, cada uno con problema/justificación/solución/test anti-regresión en el cuerpo).

## El siguiente paso sigue siendo el release 0.6.0

`packages/cli/package.json` dice `0.6.0`, pero el último tag es `v0.5.1` y npm sirve
`0.5.1`. Falta: tag → `gh workflow run deploy-website.yml` → `npm publish` (manual,
OTP de Ulises). El render de auto-hospedaje ya se hizo (#388).

**Qué avisar en el rollout** (per-repo, NUNCA `--all`):

1. Los assets managed cambiaron bastante —guard, hook del gate, reviewer, pilot, 8
   lib-skills—, así que los repos onboardeados verán drift gestionado en su próximo
   render. Es esperado.
2. **El guard es más estricto con el TEXTO del comando**: un mensaje de commit por
   heredoc que mencione un borrado recursivo de HOME se bloquea. La salida es
   `git commit -F <archivo>`.
3. Heredado: los repos con `socket.io-client` necesitan `navori update` además de
   `render` para migrar `socketio` → `socketio-client`.

## Los 12 issues nuevos de la auditoría (2026-08-20), por tanda

**Reprocesos del pipeline** (los de más ahorro; #398/#399/#400 son prosa de riesgo ~0
y caben en una sola tanda):

- **#398** `priority:high` — el closeout re-corre el full gate ya verde (~42s/sesión).
- **#399** `priority:high` — 7 agentes ordenan "Read CLAUDE.md" que el host ya inyectó.
- **#402** `priority:high` — semgrep escanea el mismo diff hasta 6×/ciclo (~20–24s);
  caché por hash de diff.
- **#400** `priority:medium` — verify-before-done contradice el criterio load-bearing.
- **#401** `priority:medium` — ceremonia de memoria duplicada (mem_context + cierre 3×).

**Permisos:** **#403** `priority:medium` — derivar el allowlist del `qualityGate` del
config + filtros puros.

**CLI:** **#404** `priority:high` — la suite de tests escribe/purga backups en el
`~/.navori` REAL (⚠️ **va antes que la purga por tamaño de #393**, comentado allá);
**#405** `priority:medium` — backup proporcional al diff; **#406** `priority:low` —
`core/src/index.ts` muerto/drifteado.

**Cableado:** **#407** `priority:low` — ruta semgrep inexistente (5ª instancia #392,
comentado allá); **#408** `priority:medium` — bloque fantasma «?» en doctor
(`health.ts:35`); **#409** `priority:low` — `solution_*` fuera del contrato de handoffs.

## Los 11 issues previos (sin cambios, decisión tomada)

Post-release: #375, #379 (solo mitad B), #378 (R1 exprés), #377, #370.
Testing real: #391 `high` (zsh), #392 `high` (rutas — ahora con la instancia 5 de #407),
#394, #395, #396. Infra: #393 `high` (disco — redefinido en parte por #404/#405).

## Notas

- Reportes de la auditoría en `.claude/progress/`: `audit_wiring.md`,
  `audit_reprocesos.md`, `research_hooks_costo.md`, `research_cli_reprocesos.md`.
- La auditoría confirmó qué NO recortar: Pass-2 del reviewer, hook pre-commit fast,
  receipt+delta re-sign, challenge de solution-design, cadena de hooks por Bash.
- Heredado: la ruta de los repos Bonum en el `~/.claude/CLAUDE.md` global sigue
  desactualizada, `~/.navori/registry.json` conserva una entrada de prueba apuntando
  al scratchpad, y siguen pendientes los PRs del repo externo bonum-webapp (#639,
  #640, #559) más el rebind de SonarCloud.
