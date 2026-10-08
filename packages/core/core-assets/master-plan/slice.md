# Plantilla de parte (`navori master template slice`)

La spec de esta parte debe clasificarse previamente con `navori spec classify` antes de dividir por entregas.

## Identidad y resultado

ID: <P<n>>
Entrega: <E<n>>
Título: <título>
Resultado observable: <resultado de esta parte>

## Alcance

- Incluye: <elementos>
- Fuera de alcance: <elementos explícitos>
- Dependencias: <P<n> o []>
- Fuentes: <S<n>, con ruta, locator y digest verificados>
- Requisitos cubiertos: <RN-n / RF-n / RNF-n>

## Criterios de aceptación propuestos

Registra estos criterios canónicos en `parts.json` como `acceptance`; usa IDs `A<n>` (se muestran como P<n>.A<n>).

| ID | Método | Descripción observable | Evidencia / condición esperada |
|---|---|---|---|
| P<n>.A<n> | test | <resultado observable> | comando y resultado esperado |
| P<n>.A<n> | command | <resultado observable> | comando y resultado esperado |
| P<n>.A<n> | manual | <qué revisar> | artefacto en ruta relativa del repo |

No inventes resultados ejecutados: evidencia técnica se registra solo después de ejecutar o inspeccionar. Un criterio manual no implica confirmación del operador.

## Diseño y revisión

Spec: <ruta relativa existente o null>
Diseño compartido: <none, reuse o new según el contrato>
Arquitectura / flujo / sistema: <rutas existentes correspondientes, si aplica>
Revisión de diseño: <revisión registrada o pendiente>
Parte fundacional: <true/false; debe concordar con el contrato>

## Preguntas

| Pregunta | Bloquea preparación | Parte responsable |
|---|---|---|
| <texto> | <true/false> | <P<n> o null solo si bloqueante> |

Las preguntas futuras no bloqueantes requieren una parte responsable válida. Resolver una pregunta es una decisión separada; no la marques resuelta por omisión.

## Aprobación del operador y estado de evidencia

Aprobación de línea base: **pendiente**. Solo se registra tras aprobación explícita del usuario para la identidad exacta del contrato y sus fuentes/diseño.

Autorización de cola: **pendiente**. Solo se registra tras aprobación explícita del usuario de esta parte dentro de una cola acotada de una sola entrega, y con sus prerrequisitos incluidos. La autorización habilita únicamente esa cola; no es evidencia de inicio, ejecución, terminación, revisión, aceptación, publicación ni despliegue.

Evidencia técnica: <pendiente; agregar únicamente resultado verificable de comando/test o artefacto revisado, con ruta y revisión>
