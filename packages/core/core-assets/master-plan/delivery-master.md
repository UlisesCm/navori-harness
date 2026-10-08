# Plantilla de contrato de entregas (`navori master template delivery-master`)

Este documento humano describe el propósito y las decisiones. Los hechos canónicos, IDs, rutas, digests, asignaciones y criterios viven en `parts.json` (contrato v2); no copies valores sin verificar. Completa los marcadores antes de solicitar aprobación. La preparación técnica no equivale a aprobación del usuario, aceptación del cliente, publicación ni despliegue.

## Metadatos

Proyecto: <nombre>
Etapa: <NN-slug>
Revisión del contrato: <revision>
Fuentes consolidadas: <S<n>: ruta, locator y digest SHA-256>

## Resultado y contexto

<Qué resultado se busca y por qué. Referencia las fuentes por S<n>; requisitos se identifican como RN-<n>, RF-<n> o RNF-<n>.>

## Fuentes y cobertura de requisitos

Registra en `parts.json` cada fuente con `id`, ruta relativa al repositorio, `digest` SHA-256 de sus bytes, `locator` literal y requisitos declarados. Marca `uiBearing` según el contenido real. Cada RN/RF/RNF debe vincularse a su `sourceId` y tener disposición `in-scope`, `excluded` o `deferred`; exclusión y diferimiento requieren una razón. Todo requisito incluido debe quedar cubierto por partes.

## Arquitectura y diseño compartido

Decisión `design.ui`: `none` solo si ninguna fuente es UI y se explica `reason`; `reuse` si se reutiliza diseño existente; `new` si se requiere diseño nuevo. En `reuse`/`new`, registra rutas existentes y contenidas en el repositorio para arquitectura, flujo y sistema, además de `reviewedRevision`. En `new`, identifica una parte `foundationPartId` marcada `foundation: true`. No declares revisión completa por llenar estos campos.

## Entregas y política Git

En `parts.json`, define cada E<n> con resultado, partes asignadas, dependencias y campos Git `branch`, `base`, `integrationTarget` y `prTarget`. Cada `E<n>` del `tasks.md` de la spec debe declarar el mismo id que la entrega en `parts.json`, y la unidad de PR es la entrega completa. Define cada P<n> con entrega, objetivo, alcance, fuera de alcance, dependencias, fuentes y RN/RF/RNF cubiertos. Las dependencias deben estar acíclicas y cada asignación debe coincidir en ambas direcciones.

| Entrega | Resultado | Partes | Depende de | Branch / base / integración / destino PR |
|---|---|---|---|---|
| E<n> | <resultado> | P<n> | <E<n> o []> | <valores explícitos> |

## Criterios y preguntas

Cada parte requiere criterios `A<n>` con método `test`, `command` o `manual`. Para test/command registra `description`, comando y resultado esperado; para manual, registra `description`, qué revisar y ruta relativa del artefacto. Son criterios propuestos, no evidencia de ejecución o aceptación.

Las preguntas se guardan en la parte: `blocking: true` detiene preparación hasta resolver; una pregunta futura no bloqueante debe asignarse a un `assignedPartId` válido. No conviertas una pregunta pendiente en decisión tácita.

## Línea base y autorización de cola

Antes de preparar una línea base, verifica fuentes, bytes/digests, locators, cobertura, rutas de diseño, dependencias y criterios con el chequeo de preparación de solo lectura. La línea base requiere aprobación explícita del usuario sobre el contrato y las fuentes/diseño exactos; guarda esa decisión en estado, no la infieras de este documento.

La autorización requiere aprobación explícita del usuario para una cola acotada de partes de una sola entrega. Una entrega dependiente espera evidencia de finalización en D3. Con diseño `new`, solo puede autorizarse la parte fundacional hasta que exista evidencia de que fue implementada. La autorización no afirma que el trabajo comenzó o terminó.

## Pendientes y límites

- Preguntas bloqueantes: <ninguna o lista con responsable>
- Decisiones diferidas y parte responsable: <ninguna o lista>
- Aprobación de línea base: <pendiente; solo registrar tras decisión explícita del usuario>
- Aprobación de cola: <pendiente; solo registrar tras decisión explícita del usuario>
- Aceptación del cliente, publicación y despliegue: <no afirmarlos sin evidencia independiente>

D3/D4 no se habilitan por esta plantilla ni por la autorización de cola.
