# Plantilla de plan (`navori master template plan`)

Cada sección de abajo es un encabezado `##` fijo (spec 0034, design.md D3). Ninguna sección queda vacía: lo que no aplica se escribe `No aplica: <razón>`.

## Metadatos

Proyecto, etapa (`<NN>-<slug>`), fecha, modo, número de este plan (`plan1`, `plan2` o `plan3`), prioridad de desempate asignada, archivos de `context/md/` leídos y, en etapa ≥2, los archivos de etapas cerradas leídos.

## Resumen ejecutivo

Qué se va a construir y por qué, en un párrafo.

## Estado actual vs. objetivo
<!-- only-mode: en-curso -->

Solo en modo `en-curso`: qué existe hoy en el código, qué falta para el objetivo. En etapa ≥2, incluye lo que entregaron las etapas cerradas.

## Alcance (MoSCoW)

Must / Should / Could / Won't, cada ítem observable. En etapa ≥2, las partes diferidas que el usuario incluyó entran aquí con su origen (`<NN-slug>/P<n>`).

## Actores y permisos

Rol, qué puede hacer, qué no.

## Reglas de negocio

`RN-<n>`, cada una con el archivo de `context/md/` del que sale o `[SUPUESTO]`.

## Requisitos funcionales

`RF-<n>`, observables.

## Requisitos no funcionales

`RNF-<n>`, cada uno con medida y umbral.

## Dominio y datos

Entidades, relaciones, ciclo de vida, retención.

## Arquitectura

Componentes, límites, flujo principal.

## Stack y librerías

Nombre, versión fija, URL oficial y fecha de consulta, o `[SIN VERIFICAR]`.

## Contratos

API, eventos, esquemas.

## Seguridad

Autenticación, autorización, datos sensibles, amenazas.

## Infraestructura y operación

Entornos, despliegue, observabilidad, costos.

## Entrega en partes

`P<n>` con objetivo, alcance, fuera de alcance, dependencias, requisitos semilla y criterios de aceptación con id `P<n>.A<m>`. Cada criterio lleva una descripción observable y su método: `test` (archivo y caso con nombre), `comando` (comando y resultado esperado) o `manual` (qué revisa el usuario y cómo). En modo `en-curso`, además, el estado (`hecho`, `parcial` o `pendiente`).

## Testing

Estrategia por nivel y qué riesgo cubre cada una.

## Riesgos

Riesgo, probabilidad, impacto, mitigación.

## Preguntas abiertas

Lo que el arquitecto no pudo decidir, incluida toda contradicción entre el contexto nuevo y una decisión de etapa cerrada.
