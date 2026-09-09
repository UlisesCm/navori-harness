# Capa de búsqueda indexada — Evals de activación

Esta spec agrega una capa always-on (el bloque `tgrep-protocol` + inyecciones) cuyo riesgo
central NO es mecánico sino de activación: codegraph demostró que un cableado perfecto
puede convivir con cero uso real (cientos de búsquedas shell, cero queries al grafo, en
sesiones auditadas 2026-09-07/08). La prosa no puede probar que el comportamiento se movió;
esta tabla sí.

**Variable aislada**: la capa de doctrina de tgrep (bloque + inyecciones) presente o
ausente. Mismo repo (navori-harness), mismo modelo, mismo prompt por escenario. RED = sin
la capa (estado actual), GREEN = con la capa renderizada. Se llena en T9; los resultados
se conservan exactamente como salgan, invertidos incluidos.

| Escenario | Prompt (idéntico en ambos brazos) | RED esperado (sin capa) | GREEN esperado (con capa) | RED real | GREEN real |
|---|---|---|---|---|---|
| E1 — búsqueda literal, tgrep instalado | "¿en qué archivos se usa `pluginHooksToClaudeShape`?" | Grep nativo o shell grep | `bash .claude/scripts/tgrep-search.sh …` en la primera búsqueda | _pendiente_ | _pendiente_ |
| E2 — fallback visible, tgrep ausente (PATH sin tgrep) | mismo prompt que E1 | igual que E1-RED | el wrapper corre, cae a rg, y la línea de aviso con `brew install tgrep` aparece en el transcript | _pendiente_ | _pendiente_ |
| E3 — ruteo conceptual (sinergia) | "¿quién llama a `buildClaudeSettings` y qué rompo si le cambio la firma?" | grep/read crawl | `codegraph_explore` primero; el span se verifica con el wrapper, no con un segundo query al grafo | _pendiente_ | _pendiente_ |

Criterio de cierre: E1 y E2 GREEN en su primer intento de búsqueda (no tras corrección del
usuario). E3 GREEN admite que el grafo esté diferido (la carga vía ToolSearch cuenta como
uso). Un GREEN fallido no bloquea el merge del mecanismo (wrapper y allow son correctos por
tests), pero se reporta en el PR como hallazgo de activación clase #597 con su evidencia.
