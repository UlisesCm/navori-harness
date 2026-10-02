# Current — PR #1170 CI correction

Publicar corrección zsh y comprobar CI Ubuntu antes de retomar Spec 0039.

## Goal
Corregir el CI del PR #1170 (issue #1143) antes de continuar Spec 0039.

## Instructions
- Sincronizar dev antes de cada nuevo trabajo; PRs hacia dev.
- Mantener 0039 conservado sin publicar mientras se corrige este PR.

## Discoveries
- El job fast de Ubuntu no instalaba zsh; quality sí. Tres pruebas de master-plan-context devolvían status null por ejecutable ausente (ENOENT reproducido).

## Accomplished
- Instalación y verificación de zsh agregadas al job fast, sin omitir pruebas.
- Revisión APPROVED; check:fast, lint y 13/13 pruebas enfocadas verdes. Receipt contra dev45429b8: status ok, fresh true.

## Next Steps
- Publicar la corrección en el PR #1170 y comprobar CI de Ubuntu.
- Después retomar T34 y T23/T24 en worktrees sincronizados con dev45429b8; serialización Markdown y revisión final pendientes. T37 ya mergeada; T44 después.
- Conservar worktrees y checkout raíz por sesiones concurrentes.

## Relevant Files
- .github/workflows/ci.yml — prerequisite zsh del job fast.
- progress/current.md — próximo paso explícito.
- progress/history.md — evidencia de esta corrección.
