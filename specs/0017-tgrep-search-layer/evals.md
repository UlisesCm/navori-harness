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
| E1 — búsqueda literal, tgrep instalado | "¿en qué archivos se usa `pluginHooksToClaudeShape`?" | Grep nativo o shell grep | `bash .claude/scripts/tgrep-search.sh …` en la primera búsqueda | (no corrido: ver método) | **PASA** — la primera búsqueda fue el wrapper en las DOS sesiones medidas |
| E2 — fallback visible, tgrep ausente (PATH sin tgrep) | mismo prompt que E1 | igual que E1-RED | el wrapper corre, cae a rg, y la línea de aviso con `brew install tgrep` aparece en el transcript | — | **sin datos** — las dos máquinas medidas tienen tgrep; el fallback solo está cubierto por tests |
| E3 — ruteo conceptual (sinergia) | "¿quién llama a `buildClaudeSettings` y qué rompo si le cambio la firma?" | grep/read crawl | `codegraph_explore` primero; el span se verifica con el wrapper, no con un segundo query al grafo | — | **FALLA** — **cero** llamadas a `codegraph_*` en ambas sesiones |

## Método: observación, no A/B controlado

Los prompts de la tabla nunca se corrieron. Lo que se midió es mejor en un
sentido y peor en otro: **dos sesiones de trabajo reales**, completas, sobre
repos con la capa recién renderizada (`moonar-medusa-monorepo`, 1 076 mensajes /
158 Bash; `navori-health`, 1 246 / 166), leyendo sus transcripts de Claude Code.
Mejor, porque nadie estaba siendo observado ni respondiendo a un prompt
diseñado; peor, porque no hay brazo RED pareado — el RED es el histórico del
audit (cientos de búsquedas shell, cero por vía indexada).

Contar "búsquedas" a secas da un número injusto, así que se clasificó cada
invocación de `grep`/`rg` por lo que realmente hacía:

| Clase | moonar | navori-health | ¿le toca al wrapper? |
|---|---|---|---|
| por el wrapper | 13 | 24 | — |
| filtro de un pipe (`git diff \| grep`) | 20 | — | no: no busca en archivos |
| territorio fuera de alcance (`node_modules/`, `dist/`) | 3 | 1 | no: el wrapper respeta `.gitignore` |
| extracción de UN archivo ya conocido (`grep -n "x" medusa-config.ts`) | 11 | 3 | no: el índice contesta *en qué archivo*, no *qué líneas de este* |
| búsqueda en el árbol por shell | 6 | 4 | **sí — la desviación real** |

**Adopción donde el wrapper es la herramienta correcta: 13/19 = 68% (moonar) y
24/28 = 86% (navori-health).** Y de las que quedan fuera, varias siguen siendo
`grep` sobre un archivo nombrado (`.gitignore`, `package.json`) que la
heurística no alcanzó a clasificar, así que el número real es un piso.

## Los dos hallazgos

**1. tgrep se activó; codegraph sigue sin activarse.** Es el mismo repo, la
misma sesión, el mismo modelo — y una capa se usa 13 y 24 veces mientras la otra
se usa cero. No es que el agente no sepa cargar un tool diferido: en esas mismas
sesiones hizo `ToolSearch`, para engram. La diferencia que queda en pie es la
FRICCIÓN: el wrapper es un comando Bash con regla `allow`, la vía que el agente
ya está usando; codegraph exige descubrir que existe, cargarlo y cambiar de
familia de herramienta. Esto es evidencia directa para R13/T7 y para el issue de
activación: el problema de codegraph no es doctrina, y más doctrina no lo va a
mover.

**2. La doctrina no distingue buscar de extraer.** Las 11 y 3 invocaciones de
"extracción de un archivo conocido" son comportamiento CORRECTO que el protocolo
no nombra: el índice de trigramas responde *en qué archivo está X*, y no aporta
nada cuando ya sabes el archivo y quieres sus líneas. Vale una línea en
`tgrep-protocol.md`, y sin ella cualquier medición futura seguirá castigando lo
que está bien hecho.

Criterio de cierre: E1 y E2 GREEN en su primer intento de búsqueda (no tras corrección del
usuario). E3 GREEN admite que el grafo esté diferido (la carga vía ToolSearch cuenta como
uso). Un GREEN fallido no bloquea el merge del mecanismo (wrapper y allow son correctos por
tests), pero se reporta en el PR como hallazgo de activación clase #597 con su evidencia.

**Veredicto (2026-09-09).** E1 cerrado en verde con datos de campo. E2 queda
abierto por falta de una máquina sin tgrep. E3 falla, y su fallo es el hallazgo
clase #597 que esta spec anticipaba — solo que le tocó a codegraph, no a tgrep.
