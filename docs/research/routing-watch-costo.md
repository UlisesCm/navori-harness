# Costo de routing-watch por sesión (S1, 23 nov 2026)

Solo medición, para decidir el port después de 0.13 (`decisiones-ulises/2026-11-23-0925` punto 3).

## Método

Los scripts y los datos crudos (`harness.py`, `count.py`, `lanes.py`, `results.json`, `bench-clean.txt`) quedaron fuera del repo, en `~/.cache/navori-rust/s1/routing-watch-cost/` de la máquina de medición.

- **Costo por llamada:** `harness.py` corre el hook renderizado desde un worktree de `migration/rust` 71e2203c (2.262 archivos versionados). Claude se mide con el comando exacto de `.claude/settings.json` (`bash -n` + `exec bash … claude-post-tool-use`) y Pi con `.pi/navori/hooks/routing-watch.sh`. Los 12 escenarios se intercalan en cada ronda: 30 rondas entre 09:50:19 y 09:50:40, con carga de 2,8 → 2,5 en 16 CPUs y localsearch-3 parado. El acceptance-index es el real de la sombra (89 criterios), con el directorio cambiado al worktree de prueba. Control: `bench-hooks --hook routing-watch.sh --runs 10`, comparable=true, da el mismo orden de magnitud (Claude Bash 14 ms CPU, Edit 31, Agent 22; Pi Bash 11, Edit 28).
- **Disparos por sesión:** `count.py` sobre las transcripciones locales de los proyectos navori: 222 sesiones de Claude y 98 de Pi. Solo cuenta los resultados sin error de las herramientas del matcher.
- **Mezcla de carriles:** `lanes.py` reconstruye el payload aproximado (en Claude, entrada más texto del resultado; en Pi, solo la entrada, como el bridge) y le aplica los mismos filtros baratos del hook (`navori_has_write_token` sobre el payload completo, tamaño, Bash exitoso justo después de un Bash fallido).

## Costo por llamada (pared, p50 / p95, ms)

| Carril | Claude | Pi |
|---|---|---|
| Bash sin escritura, sin plan | 13,5 / 14,2 | — |
| Bash sin escritura, con acceptance-index (caso normal en este repo) | 15,9 / 17,2 | 12,6 / 13,3 |
| Bash con token de escritura (`>`, `tee`, `sed -i` en cualquier parte del payload) | 22,9 / 24,5 | 19,1 / 20,2 |
| Bash exitoso tras un Bash fallido (reset de bash-outcome, `node -e`) | 45,6 / 50,2 | no aplica |
| Bash que ejecuta un criterio de aceptación (huella del árbol completo) | 246 / 257 | no aplica |
| Bash con payload de 40 KB, sin plan / con plan | 79 / 155 | — |
| Edit/Write | 19,9 / 20,4 | 19,0 / 20,6 |
| Agent | 21,8 / 22,5 | — |
| Aviso de ruteo (`node -e`, como máximo una vez por sesión) | +25 | +25 |

## Mezcla real de carriles

| | Claude (6.807 llamadas) | Pi (10.144) |
|---|---|---|
| Bash sin escritura | 53,2 % | 72,8 % |
| Bash con token de escritura | 29,2 % | 17,5 % |
| Edit/Write | 15,1 % | 7,7 % |
| Agent / navori_subagent | 2,5 % | 2,0 % |
| Bash tras un fallo | 8,9 % de las llamadas | — |
| Payload de Bash > 10 KB | 2,3 % | 0,0 % |

Corrección del 23 nov: la primera versión de este informe armó el payload de Pi con la salida del comando y le asignó un 43,3 % de Bash con escritura. El bridge de Pi no manda `tool_response` (`packages/cli/src/engines/pi/bridge-source.ts:133-144`): su payload lleva solo el comando, y con eso la mezcla es la de esta tabla. En Claude, que sí manda la salida, el 35,4 % de los Bash tiene el token en el payload y solo el 10,7 % en el comando. El otro 24,8 % son falsos positivos del primer filtro (#1793).

## Costo por sesión

Costo medio ponderado por llamada:
- **Claude ≈ 22 ms:** 18,7 por la mezcla, +2,6 por el reset tras un fallo y +0,8 por los payloads largos.
- **Pi ≈ 14,4 ms.**

| | Disparos por sesión (mediana / p90 / máx.) | Costo por sesión (mediana / p90 / máx.) |
|---|---|---|
| Claude | 14 / 48 / 329 | **0,3 s / 1,1 s / 7,2 s** |
| Pi | 86 / 220 / 290 | **1,2 s / 3,2 s / 4,2 s** |

A eso se suman 246 ms por cada criterio de aceptación que se corre con Bash, y como máximo 25 ms por el aviso.

## Lectura

- El costo es latencia en serie: PostToolUse bloquea hasta que el hook termina. Por llamada son unos 14-22 ms, no los ~76 ms que estima `rust-areas.mjs:162`.
- Los carriles caros son raros pero reales:
  - la huella del árbol al correr un criterio: ~0,25 s cada uno;
  - el reset con Node tras un fallo: 9 % de las llamadas en Claude, +30 ms cada una;
  - los payloads largos con el índice de 89 criterios: el bucle `case` del carril rápido escala con tamaño × criterios, y +75 ms en 40 KB.
- En Claude hay un sesgo en `navori_has_write_token`: el primer filtro corre sobre el payload completo, salida incluida. Cualquier `>` en el stdout (`->`, `=>`, HTML) manda la llamada al carril de escritura. Es el 24,8 % de los Bash, con +7 ms en cada uno (#1793). Pi no está afectado, porque su payload no lleva la salida.
- Un port nativo (perfil del guard: ~4-5 ms) bajaría la sesión mediana de Pi de ~1,2 s a ~0,4 s, y la de Claude de 0,3 s a ~0,1 s. Hay ahorros más baratos en shell sin port:
  - probar el token de escritura solo sobre lo que va antes de `tool_response` (#1793, entra en 0.13);
  - evitar el `node -e` del reset cuando no hay estado (ya lo evita) o resolverlo con jq.

  El segundo cambia el comportamiento de un hook y va después de 0.13. La huella del árbol al correr un criterio (#1794) también queda fuera de 0.13.

## Limitaciones

- Las transcripciones de Pi pueden incluir sesiones paralelas (S1/S2/S3), pero no subagentes hijos.
- El payload reconstruido aproxima el real: la salida de las transcripciones de Claude puede venir truncada. El de Pi se arma solo con el comando, como el bridge.
- No medí Codex ni el carril de auditoría armada (`navori audit --record-metadata`).
