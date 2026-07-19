---
name: spec-bootstrap
description: Scaffolda un spec SDD completo (requirements/design/tasks) con EARS y trazabilidad R<n>↔test. Usar al arrancar una feature de alcance real antes de escribir código.
type: reference
---

# spec-bootstrap — arranque de un spec SDD

## Cuándo usar este skill

Al iniciar trabajo SDD-scope (feature nueva completa, cambios en auth/seguridad/datos sensibles, scope > ~2 días — ver el bloque **Spec Driven Development** en `CLAUDE.md`). No lo uses para bugfixes, ajustes de UI o refactors aislados: esos van directo.

Produce `{{sdd.specsDir}}/<feature>/{requirements.md, design.md, tasks.md}` listos para que el `leader` los descomponga. El scaffolding lo hace el agente principal (o el `researcher`), no un subagente que nestee.

## Orden

1. **requirements.md primero.** Sin requisitos claros no hay diseño. Deriva del ticket/pedido; cada requisito es EARS con id `R<n>`.
2. **design.md** — cómo cumplir esos `R<n>`: componentes afectados, contratos, decisiones y trade-offs. Referencia los `R<n>` que cada decisión satisface.
3. **tasks.md** — lotes de 1-3 tasks; cada task lista los `R<n>` que cubre y su(s) test(s).

## Plantillas

`requirements.md`:
```md
# <Feature> — Requirements

## Contexto
<1-2 líneas: qué problema resuelve y para quién.>

## Requisitos (EARS)
- **R1** — El sistema DEBE <acción observable>.
- **R2** — CUANDO <evento>, el sistema DEBE <acción>.
- **R3** — SI <condición no deseada> ENTONCES el sistema DEBE <acción de contención>.
```

`design.md`:
```md
# <Feature> — Design

## Enfoque
<Arquitectura elegida y por qué. Trade-offs descartados.>

## Componentes
- <archivo/módulo> — <responsabilidad> — cubre R<n>.

## Decisiones
- <decisión no obvia> — <razón>.
```

`tasks.md`:
```md
# <Feature> — Tasks

- [ ] **T1** (R1, R2) — <qué se implementa> · test: <archivo>::<caso> con `// Covers: R1, R2`
- [ ] **T2** (R3) — <qué se implementa> · test: <archivo>::<caso> con `// Covers: R3`
```

## Reglas duras

- **Cero placeholders sin resolver.** No dejes `<...>` en el spec final; si no sabes un dato, es una pregunta al usuario, no un hueco.
- **Todo `R<n>` termina en ≥1 task y ≥1 test.** Un requisito sin task ni test no es trazable → no entra al spec.
- **El tracking vive en `tasks.md`, no en `TaskCreate`.** Ver el bloque SDD.
- **Self-review antes de cerrar el scaffolding:** ¿cada `R<n>` es una sola acción testeable? ¿cada task apunta a `R<n>` reales? ¿el design cubre todos los `R<n>`? Si algo falla, corrígelo antes de pasar el spec al `leader`.
