# Plantilla de tasks.md de una parte (`harness.masterPlan`, R35)

Mismo formato de `spec-bootstrap` (batches de 1-3 tareas, cada una con los `R<n>` que cubre), más estos campos obligatorios por tarea:

- [ ] **T<n>** (R<n>, ...) — <título>.
  - **Archivos:** rutas exactas que la tarea toca.
  - **Interfaces:** las que toca, cada una nombrada en `design.md`.
  - **Patrón:** un archivo del repo que ya existe, a seguir.
  - **Lectura:** lista cerrada de archivos a leer antes de escribir.
  - **Librerías:** nombre y versión exacta (sin `^` ni `~`).
  - **Done:** comando, resultado esperado y casos de test con nombre. Nombra los `P<n>.A<m>` que cierra.
  - **Fuera de alcance:** qué NO hace esta tarea.

Cada `R<n>` de `requirements.md` cita los `P<n>.A<m>` que cubre (R60).
