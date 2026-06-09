## Duplicación de código (jscpd)

Antes de aprobar un cambio, correr jscpd sobre el diff vs la branch base.

- Solo sobre archivos modificados:
  ```
  git diff --name-only $BRANCH_BASE...HEAD | grep -E '\.(ts|tsx|js|jsx)$' | xargs jscpd --silent
  ```
- Si reporta clones >0 con threshold del proyecto: **no aprobar** el cambio sin justificar (los reviewers deben pedir refactor o extracción).
- Skip silencioso si `jscpd` no está en `PATH` (no bloquear si el dev no tiene la tool instalada).
