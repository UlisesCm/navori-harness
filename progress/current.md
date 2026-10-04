# Current — Doctor scenario budgets reviewed, publication pending

## Goal
Correct doctor JSON scenario budgets without weakening the gate, unblocking Spec0042 audit deliveries.
## Instructions
Preserve assertions, default 15-second test limit, coverage floor and no skips. PR targets main; no automatic merge or service/log mutation.
## Discoveries
- Codegraph and global-layer tests bundled nine and five synchronous CLI calls under a single per-test budget. Baseline reproduced the timeout.
- Host saturation caused unrelated and split tests to exceed budgets; focused verification was retried only after measured load fell.
## Accomplished
- Split independent codegraph and global-layer fixtures while preserving all original assertions.
- Fresh focused run passed 16/16 in 65.26 seconds; exact full project gate exited 0. Independent reviewer approved; receipt check status ok/fresh on main51046a00 before publication tracking.
- Audit T1/T5/T7 source progress remains unpublished; T2 marker contradiction fixed and fresh code review clean, full gate pending. No audit parity/completion claim.
## Next Steps
- Publish this isolated doctor fix, without merging automatically.
- Integrate only reviewed changes into audit cuts, run fresh gates, and publish each eligible cut. T3 availability design clarified; T3/T4/T6/T8–T12 remain open.
## Relevant Files
- packages/cli/src/__tests__/doctor-json-checks.e2e.test.ts — independent fixtures with unchanged assertions and timeout.
- progress/current.md — next step and audit blockers.
- progress/history.md — this publication checkpoint.

## Retained prior context

# Current — Release 0.11.2 integration pending

## Release Next Step
Revisar y validar el candidato `release/0.11.2-main`, abrir PR a main y mergear sin squash tras CI; verificar tag y sincronizar main a dev usando worktrees aislados. npm no está publicado ni autorizado por esta preparación. Plan: `.navori/state/handoffs/workplan_release-main-0112.md`.

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
