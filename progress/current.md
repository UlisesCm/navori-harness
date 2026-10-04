# Current — Spec0042 T1 approved for publication

## Goal
Deliver Spec0042 T1/R12 launchd safety with accepted spec tracking, without claiming full audit parity.
## Instructions
No real launchd/service/log mutation; fake-controller and temporary HOME tests. PR targets main; no automatic merge, no test/coverage/timeout relaxation. Preserve other live worktrees and safety stashes.
## Discoveries
- Bootout or follow-up query failure must preserve the plist and surface failure; unconfirmed unload must never authorize replacement or false CLI success.
- PR1200 doctor test-only correction was merged externally into main6f481613. Fresh verification uses that base; no copied fix or foreign commit drag.
## Accomplished
- T1 code and spec task tracking passed fresh independent review SPEC_OK/QUALITY_OK. Exact full gate exited0; receipt statusok/fresh against main6f481613. Only T1 is marked complete in the accepted twelve-task board.
- Rebased four audit cuts onto main6f481613 preserving changes; only T1 progress conflicts resolved with both histories retained. Safety autostash and original stash preserved.
- User approved T2 master fixture and two goldens; correction11/11focusedgreen and fresh Pass1SPEC_OK. T2 owns next serial full gate.
- T5/T7 source fixes remain ready for fresh gates on integrated base, unpublished. T4 privacy preflight/design clarification/challenge underway, not implemented. T3 availability clarification prepared; T3/T4/T6/T8–T12 remain open.
## Next Steps
- Publish this T1 work PR with spec/progress included; do not merge automatically.
- Finish T2 full gate and publish only with fresh receipt, then verify/publish T5 and T7 serially. Raise concrete T4 helper/tests/mirrors scope after design challenge before any writer.
- Shared root stays unchanged; feature branches/worktrees with pending work remain preserved, no unsafe parking/deletion.
## Relevant Files
- packages/cli/src/lib/audit/launchd.ts — transactional unload/install safety.
- packages/cli/src/commands/global.ts — truthful uninstall/install failure handling.
- packages/cli/src/lib/audit/__tests__/launchd.test.ts — injected fake controller tests.
- packages/cli/src/commands/__tests__/global-collect-{install,uninstall}.test.ts — command regression tests.
- specs/0042-auditoria-accionable-codex/{requirements,design,tasks}.md — accepted R1–R22 contract and single board, T1 only checked.
- progress/current.md and progress/history.md — this checkpoint and retained prior measurement context.

## Retained measurement context

# Current — Spec 0039 T44 measurement pending

## Goal
Ejecutar T44 de Spec 0039 con comparación T9 y criterios de cierre intactos.

## Instructions
- Base y PRs hacia dev, sincronizada antes del trabajo; gate local rápido, cobertura completa solo main CI.
- No declarar éxito ni activar una ventana sin evidencia.

## Discoveries
- Comparación 2026-10-02: 8 sesiones y 22 lanzamientos de implementer; cache read p50 por lanzamiento 3,394,101 a 657,376; hooks por Bash 4.88 a 5.16. La muestra está debajo de n>=100 y mezcla versiones.
- Las ocho sesiones comenzaron antes del merge final de 0039; no hay sesión Claude fresca post-activación verificada. R41 aún no inicia. Metadata no certifica audit.mode/minero idénticos; ruido pendiente.

## Accomplished
- PRs #1172 y #1173 confirmadas mergeadas: 44/45 tareas integradas.
- Comparación real audit --compare ejecutada y documentada sin alterar el preregistro ni marcar T44 completa.
- Checkpoint APPROVED y receipt dev ok/fresh; fast, links, budgets, lint y pruebas enfocadas verdes.

## Next Steps
- Publicar y mergear el checkpoint T44.
- Renderizar/cargar el harness completo de dev en una sesión Claude fresca verificable y registrar su timestamp como inicio R41.
- Reunir ventana post-activación comparable con n>=100 implementer y ruido de dos bases; entonces reevaluar T44. No descartar trabajo ni cambiar root main por sesiones concurrentes.

## Relevant Files
- docs/research/claude-first-verificacion.md — tabla preliminar, límites y ventana prospectiva.
- specs/0039-claude-first/tasks.md — T44 permanece pendiente.
- progress/current.md — próximos pasos de medición.
- progress/history.md — registro de este checkpoint.
