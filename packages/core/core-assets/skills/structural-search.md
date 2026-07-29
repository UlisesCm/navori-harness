---
name: structural-search
description: Usar antes de leer código para localizar algo (símbolo, forma sintáctica, relación estructural, sitio de refactor): encuentra la región correcta y abre solo el span confirmado en vez de leer archivos completos; escala de engram a Grep a ast-grep según el trigger.
type: reference
---

# structural-search — leer lo mínimo correcto

Encuentra primero la región correcta y abre solo el span confirmado. Las herramientas de precisión verifican una hipótesis; no la forman.

## Escalera Rung 0–2

### Rung 0 — orientación con engram

Antes de buscar, consulta memoria para preguntas durables: dónde vive un módulo, entry points, capas, convenciones y decisiones. Usa el resultado como **hipótesis de scope**, nunca como fuente de verdad para líneas, firmas o call sites.

Confirma cada puntero con una búsqueda barata. Si el código contradice la memoria, corrige la observación de inmediato. Guarda punteros estructurales, no snapshots volátiles.

### Rung 1 — texto con Grep/ripgrep (default)

Úsalo cuando conoces un token literal: nombre, import, config key, string de error.

1. Empieza estrecho: archivo, directorio o tipo obtenido en Rung 0.
2. Pide primero archivos (`rg -l`) o `file:line` con máximo dos líneas de contexto.
3. Deduplica antes de leer.
4. Abre únicamente el span que confirma el hit.

Escala a Rung 2 solo si ocurre uno:

- cero resultados después de dos patrones razonables;
- los resultados son puro ruido;
- estás escribiendo regex para aproximar sintaxis;
- necesitas un refactor estructural multi-sitio.

### Rung 2 — estructura con ast-grep

Usa `sg` o `ast-grep` para formas del AST:

```bash
sg -p 'async function $N($$$) { $$$ }' -l ts src/
ast-grep -p 'useAuth($$$)' -l tsx apps/
```

Para reescribir, prueba primero el patrón sin `--rewrite`, limita paths/lenguaje y revisa el diff antes de aplicar. Un nombre literal sigue siendo Rung 1; una pregunta conceptual vuelve a Rung 0.

Si ninguno de los binarios existe, cae a Grep y lectura puntual: **no bloquees la tarea** ni inventes sintaxis de ast-grep.

## Mapa rápido

| Necesidad | Rung |
|---|---:|
| Dónde vive un adapter o convención | 0 |
| Import, símbolo o mensaje conocido | 1 |
| Hooks/componentes con una forma concreta | 2 |
| Codemod multi-sitio | 2 |
| Semántica cross-file con tipos | lectura manual del span confirmado |

## Límites

- No leas archivos completos por reflejo.
- No corras grep ancho sin scope.
- No uses regex como AST.
- Si la búsqueda consume ~15% del contexto, detente: reduce scope o actúa con la evidencia disponible.
- No montes LSP/Serena; este harness termina en Rung 2.

<!-- navori:user-section -->
## Patrones estructurales del proyecto

<!-- user: documenta aquí patrones sg/ast-grep comprobados, lenguajes y paths frecuentes. Guarda patrones reutilizables; no pegues resultados ni líneas actuales. -->
