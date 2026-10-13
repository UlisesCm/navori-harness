# Endurecimiento de producción del plan maestro — Requirements

**Estado:** M1 (R1, R2), M2 (R3, R4) y M3 (R5) implementados, revisados y comprometidos en `0309c30d`, `a69affc2` y `b78df7d2`, respectivamente. M4 (R6) implementado en el diff combinado de pruebas, prosa y salidas generadas; el principal ejecutó A4 exacto con full y exit `0` (31 pruebas focused y 8620 full aprobadas, 2 omitidas). T4 se marca solo por implementación y probes completados: no representa aprobación de revisión final ni publicación. E1 tiene M1–M4 implementados, pero su revisión fresca final, recibo del diff de envío y cierre siguen pendientes. M5–M7 de E2 siguen pendientes en `tasks.md`. Sin commit de M4, push ni PR de implementación.

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

Cada `R<n>` termina en al menos una tarea y una prueba nombrada en `tasks.md`. Los casos de M1–M3 (R1–R5) se añadieron y verificaron; `tasks.md` conserva su procedencia, revisión y commits. Las regresiones de M4 (R6) están implementadas y A4 exacto/full fue ejecutado por el principal con exit `0`, según `.navori/state/handoffs/verification_0049-e1-m4-main.json`; no por scribe. Esta evidencia precede a la actualización final de documentación y no certifica un recibo fresco del diff de envío. La revisión fresca final de E1 sigue pendiente; no hay comportamiento runtime nuevo. Los casos de M5–M7 siguen planeados, salvo la cobertura que ya existe en la base.
