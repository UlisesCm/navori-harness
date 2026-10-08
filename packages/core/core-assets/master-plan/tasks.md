# Plantilla de tasks.md de una parte (`harness.masterPlan`, R35)

Organiza el trabajo por entregas, cada una con milestones, criterios de aceptación y tareas. Cada tarea declara archivos exactos, interfaces, archivo patrón, lista cerrada de lectura, versiones fijas de librerías, comando y resultado esperado, pruebas nombradas y fuera de alcance; no escribas cuerpos de funciones en las tareas.

## E1 — <título de la entrega>

Estimated LOC: <número>

### M1 — <título del milestone>

- **A1** [observable] — <descripción del criterio de aceptación> → `comando esperado o "verificado manualmente"`

- [ ] **T1** (R<n>, ...) — <título>.
  - **Archivos:** rutas exactas que la tarea toca.
  - **Interfaces:** las que toca, cada una nombrada en `design.md`.
  - **Patrón:** un archivo del repo que ya existe, a seguir.
  - **Lectura:** lista cerrada de archivos a leer antes de escribir.
  - **Librerías:** nombre y versión exacta (sin `^` ni `~`).
  - **Done:** comando, resultado esperado y casos de test con nombre. Nombra los `P<n>.A<m>` que cierra.
  - **Fuera de alcance:** qué NO hace esta tarea.

### M2 — <título del milestone>

- **A2** — <descripción>

- [ ] **T2** (R<n>) — <título>.
  - **Archivos:** ...
  - **Interfaces:** ...
  - **Patrón:** ...
  - **Lectura:** ...
  - **Librerías:** ...
  - **Done:** ...
  - **Fuera de alcance:** ...

## E2 — <título de la siguiente entrega>

Estimated LOC: <número>

### M3 — <título del milestone>

- **A3** — <descripción>

- [ ] **T3** (R<n>) — <título>.
  - **Archivos:** ...

Cada `R<n>` de `requirements.md` cita los `P<n>.A<m>` que cubre (R60).
