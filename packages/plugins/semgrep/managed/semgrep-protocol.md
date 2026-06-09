## Security gate local (semgrep)

Antes de cerrar un cambio relevante (auth, RBAC, secrets, input validation), correr semgrep sobre el diff.

- Scan rápido del diff:
  ```
  git diff --name-only $BRANCH_BASE...HEAD | xargs semgrep --config=auto --severity=ERROR
  ```
- Scan completo del proyecto (más lento, opt-in):
  ```
  semgrep --config=auto --error
  ```
- Reglas custom: ver `.semgrep.yml` en la raíz del repo si existe.
- Skip silencioso si `semgrep` no está instalado (no bloquear si el dev no lo tiene).
