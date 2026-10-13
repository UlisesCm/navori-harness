# Endurecimiento de producción del plan maestro — Design

**Estado:** diseño aprobado, sin cambios de arquitectura ni contratos. E1 (M1–M4) integrada mediante PR1313 en `dev`, commit `7d12fa42b6fdc4cf67db46267a0ff3c0beeeb7c5`, el 2026-10-13: merge confirmado por el usuario y verificado con `gh` por el principal, no por scribe. `tasks.md` conserva la procedencia de M1–M3 y el checkpoint de M4: A4 exacto/full ejecutado por el principal con exit `0` (31 pruebas focused y 8620 full aprobadas, 2 omitidas), según `.navori/state/handoffs/verification_0049-e1-m4-main.json`. En ese checkpoint la revisión final, recibo y publicación estaban pendientes; no son próximos pasos actuales de E1 ni evidencia de un recibo vigente para E2. M4 no añadió comportamiento runtime.

M5 (R7–R10) implementado en el dueño existente: JSDoc actualizado y dos severidades warning→error en `checkSpec`, sin alterar retorno temprano legacy, parser, esquema, reglas, thresholds ni `commands/spec.ts`. Según el productor en `.navori/state/handoffs/impl_0049-master-plan-production-hardening-e2.json`, A5 exacto tiene exit `0` (5 archivos, 106/106 pruebas) y fast exit `0`, log `.navori/state/gate/fast-20261013T045851114Z.log`; las pruebas unitarias y subprocesos verifican los fallos estrictos y compatibilidad legacy sin atribuir significado semántico a la validación. Scribe no ejecutó esos probes. Revisión fresca posterior `APPROVED`, sin findings, en `.navori/state/handoffs/review_0049-master-plan-production-hardening-e2.json` (estado `validated`); T5 marcado por implementación y revisión. El reviewer ejecutó A5 independiente (106/106) y scoped exit `0`. Full del principal exit `0`, log `.navori/state/gate/full-20261013T050413060Z.log` (418 archivos, 8631 aprobadas, 2 omitidas); recibo full validado `status:ok`, `fresh:true` antes de esta actualización documental. El usuario solicitó el checkpoint como PR DRAFT y detener M6/M7, no iniciados. No hay URL de PR ni commit de M5 acreditado; E2 no está completa ni lista para merge. Esta actualización solo de estado/procedencia requiere reseal acotado antes de publicar, sin cambios runtime ni pruebas nuevas de comportamiento; la política y los contratos aprobados permanecen intactos.

**Procedencia.** El diseño original se preparó bajo la excepción de rol ausente: los roles `architect` y `auditor` no estaban disponibles en la sesión de origen (Pi) y el diseño no fue auditado de forma independiente entonces. Este documento no afirma aprobación de `architect` ni de `auditor`. La implementación futura debe pasar revisión y, donde aplique, el challenge de áreas críticas.

## Approach

Cada defecto se corrige en el dueño existente, sin piezas nuevas:

- **Init** (`runMasterInit`): en cada init o reanudación validado, se reutiliza el renderizador idempotente existente (`runRender`, independiente del engine, sobre los engines configurados; `CLAUDE.md` solo con Claude habilitado), también cuando `harness.masterPlan: true` ya está persistido (legacy). Sin flags nuevos, sin esquema nuevo, sin `force` ni `prune`. Se descarta un rollback solo con `catch`: un corte abrupto escapa al `catch`, así que la recuperación debe vivir en el reintento (R1, R2). Los controles de entregas tras throw o `ok:false` no estaban en la base `7faec48f`: se añadieron en M1 a `init.test.ts`, junto con los casos legacy y assertions de salida real tras el reintento. Son controles de compatibilidad; el defecto de la condición de render afectaba al estado legacy persistido y al corte previo al render.
- **Estado derivado** (`runMasterAdvance`): tras la actualización durable de la fase, llama al dueño existente del estado (`writeMasterStatus`). Si una escritura derivada posterior falla, reporta la fase durable y la reparación explícita con `navori master status` (que ya regenera), sin avanzar dos veces (R3, R4).
- **Skill y modo**: se cambia solo el texto del skill canónico; el contrato JSON de `architectContext` no cambia. El runtime ya fija `en-curso` en etapas ≥ 2 (`init.ts`) y rechaza `navori master mode` (`setMasterMode`); el skill debe conservar ese `en-curso` automático y no invocar `mode` (R5, R6). M4 es solo de redacción.
- **Política estricta de spec**: solo en formato nuevo, según lo aprobado; el legacy no cambia (R7–R10).
- **Evidencia**: se usa la autoridad de estado existente (`readMasterStatus`, `evidenceAge`) para bloquear huérfanos; los ancestros más antiguos solo avisan (R11–R13).
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
- Evidencia huérfana en parte sin disposición: `closable` falso y `close` bloquea con el mismo criterio, al derivar ambos de la misma autoridad (R11).
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
