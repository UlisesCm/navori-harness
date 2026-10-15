# Endurecimiento de producción del plan maestro — Design

**Estado:** diseño aprobado y completado sin cambios de arquitectura ni contratos. E1 (M1–M4) se integró mediante PR1313 en `dev`, commit `7d12fa42b6fdc4cf67db46267a0ff3c0beeeb7c5`. E2 (M5–M7) quedó revisada `APPROVED` y se integró mediante PR1316 en `dev`, merge commit `336c0621b9d647ecdaee2634212859ceb81aeddc`; el commit final de M7 es `bb7f616cd6d2cf238347c51a2af5b3ee1484512a`. La revisión final aprobó A7 enfocado (26 archivos/592 pruebas), el gate full (418 archivos/8644 aprobadas, 2 omitidas, 0 fallidas) y un recibo full `status:ok`, `fresh:true` antes de publicación. El primer A7 full falló porque faltaban nueve delivery-* prompts en la lista del test; tras la reparación aprobada y acotada a las excepciones exactas, A7/full pasaron. El checkpoint M5 como DRAFT y la espera de esa aceptación son historia superada. No hay implementación ni aceptación pendiente; el diseño y contratos aprobados permanecen vigentes.

Enmendado por `specs/0051-master-plan-correcciones` (2026-10-13): la evidencia huérfana ya no está en `closable`/`blockers` ni en `STATUS.md`; vive en `evidenceBlockers` (`--json`) y bloquea `close` (0051 R6).

M5 (R7–R10) implementado en el dueño existente: JSDoc actualizado y dos severidades warning→error en `checkSpec`, sin alterar retorno temprano legacy, parser, esquema, reglas, thresholds ni `commands/spec.ts`. Según el productor en `.navori/state/handoffs/impl_0049-master-plan-production-hardening-e2.json`, A5 exacto tiene exit `0` (5 archivos, 106/106 pruebas) y fast exit `0`, log `.navori/state/gate/fast-20261013T045851114Z.log`; las pruebas unitarias y subprocesos verifican los fallos estrictos y compatibilidad legacy sin atribuir significado semántico a la validación. Scribe no ejecutó esos probes. Revisión fresca posterior `APPROVED`, sin findings, en `.navori/state/handoffs/review_0049-master-plan-production-hardening-e2.json` (estado `validated`); T5 marcado por implementación y revisión. El reviewer ejecutó A5 independiente (106/106) y scoped exit `0`. Full del principal exit `0`, log `.navori/state/gate/full-20261013T050413060Z.log` (418 archivos, 8631 aprobadas, 2 omitidas); recibo full validado `status:ok`, `fresh:true` antes de la actualización documental de M5. M5 quedó publicado en PR1316 DRAFT con commit `61837a088d7f62e6fb4aaa4d3868fd539b675f82`.

M6 (R11–R13) se implementó en el dueño existente de estado (`status.ts`): hubo una regresión RED antes del arreglo (5 fallidas, 17 aprobadas), A6 exacto e independiente pasó con 61/61 pruebas en 3 archivos y exit `0`; fast terminó con exit `0`. Root confirmó revisión `APPROVED` y commit `9db6e079`. M7 (R14–R15) completó smoke (18/18), controles combinados (91/91), golden sin update (5/5) y checks documentales en verde. El primer A7 focused pasó (26 archivos/592 pruebas), pero el full falló (417 archivos, 8643 aprobadas, 1 fallida, 2 omitidas) por nueve prompts delivery-* no documentados. Tras aprobación expresa del usuario, se agregaron las nueve excepciones exactas al test de prompts y el límite subió de 21 a 30; permisos, settings, hooks y runtime quedaron intactos. La prueba dirigida pasó 12/12. En la revisión final, A7 focused pasó con 26 archivos/592 pruebas y full con 418 archivos/8644 aprobadas, 2 omitidas y 0 fallidas; el recibo full quedó `status:ok`, `fresh:true` antes de publicación. La revisión fue `APPROVED`; PR1316 se integró en `dev` mediante `336c0621b9d647ecdaee2634212859ceb81aeddc` y el commit final de M7 es `bb7f616cd6d2cf238347c51a2af5b3ee1484512a`. La DRAFT inicial y la aceptación pendiente son checkpoints históricos superados; E2 está completa y no hay pendientes de implementación o envío.

**Procedencia.** El diseño original se preparó bajo la excepción de rol ausente: los roles `architect` y `auditor` no estaban disponibles en la sesión de origen (Pi) y el diseño no fue auditado de forma independiente entonces. Este documento no afirma aprobación retroactiva de `architect` ni de `auditor`. La implementación se completó después mediante E1/E2 y recibió la revisión final `APPROVED` descrita arriba.

## Approach

Cada defecto se corrige en el dueño existente, sin piezas nuevas:

- **Init** (`runMasterInit`): en cada init o reanudación validado, se reutiliza el renderizador idempotente existente (`runRender`, independiente del engine, sobre los engines configurados; `CLAUDE.md` solo con Claude habilitado), también cuando `harness.masterPlan: true` ya está persistido (legacy). Sin flags nuevos, sin esquema nuevo, sin `force` ni `prune`. Se descarta un rollback solo con `catch`: un corte abrupto escapa al `catch`, así que la recuperación debe vivir en el reintento (R1, R2). Los controles de entregas tras throw o `ok:false` no estaban en la base `7faec48f`: se añadieron en M1 a `init.test.ts`, junto con los casos legacy y assertions de salida real tras el reintento. Son controles de compatibilidad; el defecto de la condición de render afectaba al estado legacy persistido y al corte previo al render.
- **Estado derivado** (`runMasterAdvance`): tras la actualización durable de la fase, llama al dueño existente del estado (`writeMasterStatus`). Si una escritura derivada posterior falla, reporta la fase durable y la reparación explícita con `navori master status` (que ya regenera), sin avanzar dos veces (R3, R4).
- **Skill y modo**: se cambia solo el texto del skill canónico; el contrato JSON de `architectContext` no cambia. El runtime ya fija `en-curso` en etapas ≥ 2 (`init.ts`) y rechaza `navori master mode` (`setMasterMode`); el skill debe conservar ese `en-curso` automático y no invocar `mode` (R5, R6). M4 es solo de redacción.
- **Política estricta de spec**: solo en formato nuevo, según lo aprobado; el legacy no cambia (R7–R10).
- **Evidencia**: se usa la autoridad de estado existente (`readMasterStatus`, `evidenceAge`) para bloquear huérfanos; los ancestros más antiguos solo avisan (R11–R13). (enmendado por 0051 R6: el bloqueo vive en `evidenceBlockers`, no en `closable`/`blockers`; `close` lo rechaza igual)
- **Ruteo**: una rama compacta en el skill canónico tras el estado (R14), y un smoke integrado (R15).

## Components

- `packages/cli/src/lib/master/init.ts` (`runMasterInit`) — reaplica el render idempotente en init/reanudación, incluido el estado legacy con `masterPlan:true` persistido (se omitía en la base `7faec48f`) — covers R1, R2.
- `packages/cli/src/lib/master/checks.ts` (`runMasterAdvance`) — regenera estado tras avanzar y reporta fallo parcial — covers R3, R4.
- `packages/cli/src/lib/master/status.ts` (`writeMasterStatus`, `readMasterStatus`, `evidenceAge`) — dueño de estado derivado, `architectContext` y bloqueadores de evidencia — covers R3, R4, R5, R11, R12, R13.
- `packages/core/core-assets/skills/master-plan.md` — skill canónico: consumo de `architectContext`, redacción de `en-curso` heredado en etapas ≥ 2 (sin invocar `mode`), rama legacy/entregas — covers R5, R6, R14.
- `packages/cli/src/commands/master.ts` (`setMasterMode`, comando `status`) — reparación (R4); el rechazo de `mode` desde la etapa 2 ya existe y solo se usa como control de compatibilidad (R6).
- `packages/cli/src/lib/spec/check.ts` (`checkSpec`) — fallos estrictos solo en formato nuevo — covers R7, R8, R9, R10.
- Puntos de entrada del ciclo en `packages/cli/src/lib/master/delivery.ts` — cubiertos por el smoke — covers R15.

## Decisions

- Reutilizar el renderizador idempotente en cada init validado — evita nuevas superficies y repara tanto fallos capturados como cortes abruptos.
- La reparación del estado derivado es explícita (`navori master status`) — repetir `advance` movería la fase dos veces.
- El modo de etapas ≥ 2 ya es automático en el runtime; solo se corrige la redacción del skill (`registra en-curso sin preguntar` se lee como llamar a `mode`). No se añade comportamiento.
- Los espejos generados se renderizan con el CLI (`navori render --apply`/`sync`), nunca a mano. El alcance de fuentes original era provisional para estos espejos: antes de despachar se miden las salidas generadas exactas y se aprueba cualquier alcance adicional.
- La evidencia antigua no huérfana no bloquea: la política es deliberada y no exige todas las pruebas en `HEAD`.
- Las inmutabilidades de etapa y las activaciones opt-in del skill se mantienen.

## Contracts

- `architectContext` en el JSON de estado: contrato existente, sin cambios; solo cambia el texto del skill que lo consume.
- `navori master status` sin flags regenera el estado derivado; con `--json`/`--line` solo lee. Es la reparación del R4.
- Comandos de entregas soportados (nombres verificados en `commands/master.ts`): `delivery-slice`, `delivery-check`, `delivery-baseline`, `delivery-queue`, `delivery-revoke`, `delivery-criterion`, `delivery-review`, `delivery-present`, `delivery-decision`, `delivery-publication`. La rama del skill usa solo estos y no inventa argumentos; los flags exactos se leen del archivo al implementar.
- Sin dependencias externas ni migración de esquema.

## Failure modes

- Corte abrupto tras activar `masterPlan` y antes del render, o estado legacy persistido sin render: el siguiente `init` valida el estado y completa el render de los engines configurados (R1). Fallo capturado/`ok:false` en entregas: comportamiento conservado con controles de recuperación añadidos en M1, ausentes en la base `7faec48f`.
- Fallo parcial de escritura derivada tras avanzar: se informa la fase durable y se repara con `navori master status`; no hay doble avance (R4).
- Evidencia huérfana en parte sin disposición: `closable` falso y `close` bloquea con el mismo criterio, al derivar ambos de la misma autoridad (R11). (enmendado por 0051 R6: el bloqueo vive en `evidenceBlockers`, no en `closable`/`blockers`; `close` lo rechaza igual)
- `requirements.md` ausente o ilegible, o `R<n>` no declarado, en formato nuevo: `spec check` falla (R7, R8).

## Compatibility

Las specs legacy conservan su comportamiento (R9). Las aprobaciones manuales válidas y las exenciones descartadas/diferidas no cambian (R13).

## Testing strategy

Cada prueba responde a un riesgo nombrado arriba, no a una cuota. Cada prueba futura lleva `// Covers: R<n>`. Probes por milestone en `tasks.md`; M4 y M7 cierran además con el gate completo `bun run check`. No se promete cobertura semántica a partir del parseo estructural (R10). Rollback: cada commit atómico por milestone se revierte de forma independiente con `git revert`.

Gates: ciclos intermedios con `qualityGate.fast` y los `A<n>` del milestone; el PR de cada entrega corre el gate completo y lo revisa un reviewer de contexto fresco, dueño de la aprobación de envío.

## NOT in scope

- Diagnóstico del runner de Pi (entrega activa de la spec 0048).
- Nuevos flags, `force`, `prune`, cambios de esquema o dependencias.
- Garantía semántica de cobertura de pruebas.
- Exigir evidencia en `HEAD` para todas las pruebas.
- Cambios a los gates opt-in de los skills, merge automático, despliegue o release.
