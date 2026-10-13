# Endurecimiento de producción del plan maestro — Requirements

**Estado:** E1 (M1–M4, R1–R6) integrada mediante PR1313 en `dev`, commit `7d12fa42b6fdc4cf67db46267a0ff3c0beeeb7c5`. E2 (M5–M7, R7–R15) completada, revisada `APPROVED` y fusionada mediante PR1316 en `dev`, merge commit `336c0621b9d647ecdaee2634212859ceb81aeddc` (2026-10-13); el commit final de M7 es `bb7f616cd6d2cf238347c51a2af5b3ee1484512a`. Todas las tareas T1–T7 están completas y los R1–R15 tienen cobertura trazada en `tasks.md`. En la revisión final, A7 enfocado pasó en 26 archivos/592 pruebas y el gate full pasó en 418 archivos/8644 pruebas, 2 omitidas y 0 fallidas; el recibo full quedó `status:ok`, `fresh:true` antes de publicar. El primer A7 full falló por nueve prompts no documentados; tras la reparación aprobada y acotada a la lista de prompts, A7/full pasaron en la revisión final. Los checkpoints previos de M5 como PR1316 DRAFT y la pausa antes de M6/M7 son historia ya superada. Los contratos aprobados siguen vigentes; no hay aceptación de implementación, revisión ni publicación pendiente.

## Contexto

El flujo `navori master` (init, advance, status, part, close) y `navori spec check` tienen huecos que se reprodujeron con pruebas manuales: un `init` repetido tras un fallo o un corte no recrea los artefactos derivados de los engines configurados (p. ej. `CLAUDE.md` solo si Claude está habilitado); `advance` deja `STATUS` obsoleto; `spec check` da `ok` sin `requirements.md`; y un plan queda `closable` con evidencia ejecutable huérfana. Las pruebas manuales muestran los defectos, no prueban que un arreglo funcione ni que la suite completa esté en verde.

El usuario aprobó dos PRs de implementación con commits atómicos (E1 y E2), más este PR de scaffold: tres PRs en total. Las decisiones de init, de política de `spec check` y de política de evidencia fueron aprobadas explícitamente y se preservan tal cual. No se aprobó ninguna dependencia externa ni migración de esquema. Ningún PR abierto ni la aprobación de esta documentación autoriza merge, despliegue ni release automáticos.

Fuentes estables (símbolos): `packages/cli/src/lib/master/init.ts` (`runMasterInit`), `packages/cli/src/lib/master/checks.ts` (`runMasterAdvance`, `runMasterCheck`), `packages/cli/src/lib/master/status.ts` (`readMasterStatus`, `writeMasterStatus`, `evidenceAge`), `packages/cli/src/commands/master.ts` (`setMasterMode`), `packages/cli/src/lib/spec/check.ts` (`checkSpec`) y los puntos de entrada del ciclo de entregas en `packages/cli/src/lib/master/delivery.ts`.

El diagnóstico histórico del runner de Pi pertenece a la spec 0048 y queda fuera de esta implementación. No es un bloqueo vigente de M1: las ejecuciones acotadas de agentes concluyeron. Esto no afirma una corrección global de 0048.

## Requirements (EARS)

### Inicialización
- **R1** — WHEN `navori master init` se ejecuta sobre un estado válido ya existente (tras un fallo de render capturado, un resultado `ok:false` o un corte abrupto entre la activación y el render), the system SHALL re-ejecutar el renderizado idempotente existente de modo que los artefactos derivados de los engines configurados queden presentes (`CLAUDE.md` solo si el engine Claude está habilitado; con un engine no Claude, p. ej. solo `AGENTS.md`, no se exige `CLAUDE.md`). Esto incluye el estado durable parcial con `harness.masterPlan: true` ya persistido sin render previo (en la base `7faec48f`, `runMasterInit` omitía el render en flujo legacy) y el corte abrupto entre la activación y el render. Los controles de reintento tras throw o `ok:false` en entregas no existían en la base `7faec48f`; se añadieron en M1 a `init.test.ts` junto con los casos legacy. Protegen la compatibilidad de entregas; el defecto de la condición de render estaba en legacy.
- **R2** — WHEN `navori master init` se repite sobre un estado sano, the system SHALL conservar la etapa, el historial, la prosa del usuario y los guardias anti-rollback sin cambios.

### Estado derivado
- **R3** — WHEN `navori master advance` avanza una fase con éxito, the system SHALL regenerar el estado derivado (`STATUS`) de esa fase.
- **R4** — IF la escritura de un derivado falla después de actualizar la fase de forma durable, THEN the system SHALL informar la fase durable y la reparación con `navori master status`, sin repetir el avance.

### Contexto de arquitectos y modo
- **R5** — The system SHALL hacer que el skill canónico `master-plan` consuma el campo `architectContext` del estado, sin cambiar su contrato JSON.
- **R6** — The skill canónico `master-plan` SHALL indicar que, en etapas de número mayor o igual a 2, el modo `en-curso` se hereda automáticamente de `navori master init` y SHALL prohibir invocar `navori master mode` de forma redundante. El runtime ya lo cumple (`runMasterInit` fija `en-curso` y `setMasterMode` rechaza `mode` desde la etapa 2): R6 es solo de redacción del skill; no requiere comportamiento automático nuevo.

### Validación de specs
- **R7** — IF una spec en formato nuevo no tiene `requirements.md` o este es ilegible, THEN `navori spec check` SHALL fallar.
- **R8** — IF una spec en formato nuevo referencia un `R<n>` no declarado en su `requirements.md`, THEN `navori spec check` SHALL fallar.
- **R9** — WHILE una spec esté en formato legacy, `navori spec check` SHALL conservar su comportamiento actual.
- **R10** — The system SHALL NOT afirmar cobertura semántica de pruebas: la validación es estructural (existencia y referencias), no garantiza que una prueba demuestre el requisito.

### Política de evidencia
- **R11** — IF existe evidencia ejecutable huérfana en una parte sin disposición, THEN `status.closable` SHALL ser falso y `navori master close` SHALL bloquear con el mismo criterio.
- **R12** — WHEN la evidencia pertenece a un commit ancestro más antiguo (no huérfano), the system SHALL no bloquear, SHALL mostrar su antigüedad y SHALL ofrecer revalidarla. Esta política es deliberada: no exige todas las pruebas en `HEAD`.
- **R13** — The system SHALL conservar sin cambios las aprobaciones manuales válidas y las exenciones de partes descartadas o diferidas.

### Ruteo y verificación integrada
- **R14** — The system SHALL incluir en el skill canónico `master-plan`, tras consultar el estado, una rama explícita y compacta que distinga el flujo legacy (por defecto) del ciclo de entregas, usando solo los comandos `navori master delivery-*` soportados.
- **R15** — The system SHALL tener un smoke de CLI integrado y aislado que recorra: primera etapa, cierre, segunda etapa, conversión y ciclo de entregas.

## Trazabilidad

Cada `R<n>` termina en al menos una tarea y una prueba nombrada en `tasks.md`. Los casos de M1–M3 (R1–R5) se añadieron y verificaron; `tasks.md` conserva su procedencia, revisión y commits. Las regresiones de M4 (R6) se implementaron y A4 exacto/full fue ejecutado por el principal con exit `0` (31 pruebas focused y 8620 full aprobadas, 2 omitidas), según `.navori/state/handoffs/verification_0049-e1-m4-main.json`; no por scribe. En ese checkpoint la revisión final estaba pendiente y la evidencia precedía a la actualización documental, sin certificar un recibo fresco del diff de envío. E1 se integró posteriormente como indica la cabecera; M4 no añadió comportamiento runtime.

R7–R10 están implementados en M5: pruebas unitarias y subprocesos reales cubren requirements ausente, ilegible (directorio), vacío legible, R no declarado y compatibilidad legacy. R10 conserva el límite estructural: aceptar la forma de un comando inexistente no lo ejecuta ni acredita cobertura semántica. A5 exacto e independiente pasó con 106/106 pruebas; el full inicial de M5 pasó con 418 archivos, 8631 aprobadas y 2 omitidas, con recibo `status:ok`, `fresh:true` en ese checkpoint. M6 implementa R11–R13: hubo una regresión RED (5 fallidas, 17 aprobadas) antes del arreglo; A6 exacto e independiente pasó con 61/61 pruebas. El fast de M6 terminó con exit `0`; la revisión fue `APPROVED` y el commit fue `9db6e079`. M7 implementa R14–R15: smoke 18/18; cinco archivos enfocados 91/91; golden sin update 5/5; render/assets/presupuesto documental en verde. El primer A7 focused pasó (26 archivos, 592 pruebas), pero el full falló (417 archivos, 8643 aprobadas, 1 fallida y 2 omitidas) porque faltaban nueve delivery-* prompts en `EXPECTED_PROMPTS`. Con autorización expresa del usuario se agregaron esas nueve entradas exactas y el tope pasó de 21 a 30, sin cambiar settings, permisos, hooks ni runtime; la reproducción dirigida pasó de 11/12 a 12/12. En la revisión final independiente, A7 focused pasó de nuevo (26 archivos, 592 pruebas) y full pasó (418 archivos, 8644 aprobadas, 2 omitidas, 0 fallidas); recibo full `status:ok`, `fresh:true` antes de publicación. El reviewer cerró E2 como `APPROVED`; PR1316 se fusionó en `dev` como `336c0621b9d647ecdaee2634212859ceb81aeddc`, con M7 en `bb7f616cd6d2cf238347c51a2af5b3ee1484512a`. Estos son resultados históricos de envío, no una repetición funcional de esta actualización documental.
