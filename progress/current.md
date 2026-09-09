# Sesión actual

**Estado:** `main` en `92a91a4`, limpio y sincronizado. **npm en 0.7.8** (publicado por Ulises).
0 issues abiertos. **2 PRs abiertos y verdes esperando merge**: #617 (engines >=22) y #618
(evals de T9). Fuera del repo, 2 PRs de rollout: moonar #111 y navori-health #20.

## Jornada: la spec 0017 completa, el 0.7.8, dos issues cerrados y el toolchain

Empezó con "mergea mi PR y comencemos la implementación" (#610, la spec 0017) y terminó
midiendo, sobre sesiones reales, si la capa que construimos se usa.

### La spec 0017 — tgrep como default de búsqueda

T1-T6 y T8 en #611; T9 en #618. Lo que costó de verdad no fue el mecanismo:

- **`status` es variable de solo lectura en zsh** (espeja `$?`). El wrapper abortaba entero bajo
  zsh y lo cazó `acrossShells`, que corre cada caso bajo los dos shells. Vale como regla para todo
  script del harness: ese nombre está quemado.
- **El parser de la vía grep leía el VALOR de un flag como patrón**: `-g '*.ts' foo .` buscaba
  `*.ts` dentro de un path llamado `foo`.
- **`-E/--encoding` NO bypassea el índice**, contra lo que afirmaba el design. Medido con
  `--stats`: solo `--hidden`, `--no-ignore*` y `-a` caen a brute-force. El design quedó corregido.
- **Un core asset no puede citar rutas de un engine.** La primera redacción de la cláusula de
  `operaciones-seguras.md` nombraba `.claude/scripts/...`; `cited-paths-exist` y `render-codex` la
  rechazaron con razón — ese asset también se renderiza a codex/cursor/copilot.
- **El wrapper no ve dentro de `.claude/`** (default de ripgrep para dot-dirs). Falso negativo
  silencioso de la misma clase que R2, por otra puerta. Arreglado en #612.

### Los dos issues

- **#604** (#613): `commits` tenía **seis** citas colgantes, no una; `version` respondía dos
  preguntas con un nombre (ahora `status` imprime `version (project)` y `version (navori)`); y
  `agentAssignments` se retiró — el schema ya decía "Do not add render-time consumers".
- **#614** (#615): el issue pedía un mecanismo nuevo (`audience` en el manifest) y **no hacía
  falta**: `skills[].injectInto` ya enruta. `jscpd-protocol` y `semgrep-protocol` pasaron a las
  skills que ya eran dueñas de ese momento. **−357 tokens por agente que arranca**. Lo riesgoso no
  era mover sino migrar: un bloque quitado de un plugin VIVO no lo alcanza ninguna rama del render
  — de ahí `RETIRED_PLUGIN_BLOCKS`.

### El toolchain (#616 mergeado, #617 pendiente)

TypeScript 7.0.2 (port nativo: typecheck completo en **1.8s**, paquete de 2.5 MB contra 23.6),
pnpm 12.3.4 y Node 24. Dos cambios que rompen y no estaban documentados:
**TS 7 ya no auto-descubre `@types/*`** (se arregla con `types: ["node"]`) y **pnpm 12 convierte un
build script ignorado en error** (la llave es `allowBuilds` en `pnpm-workspace.yaml`, no el
`onlyBuiltDependencies` de pnpm 10). El CI corría en Node 20, que está EOL.

### T9 — la medición que importaba

Sobre dos sesiones de trabajo reales post-rollout: **adopción del wrapper 68% y 86%** donde es la
herramienta correcta, y la primera búsqueda de la sesión fue el wrapper en las dos.

**El hallazgo grande es de codegraph: cero llamadas en ambas sesiones.** Mismo repo, mismo modelo,
misma sesión — y en esas mismas sesiones el agente sí hizo `ToolSearch`, para engram. La
diferencia que queda en pie es la fricción: el wrapper es un comando Bash con regla `allow`;
codegraph exige descubrirlo, cargarlo y cambiar de familia de herramienta. **Más doctrina no lo va
a mover**, y eso convierte a T7 en la pregunta central de lo que queda.

## Lo que sigue

1. **Mergear #617 y #618** (ambos verdes), y los dos de rollout fuera del repo.
2. **T7 — el experimento `alwaysLoad`**: poner `"alwaysLoad": true` en la entrada codegraph de
   `.mcp.json`, abrir sesión nueva y observar si `mcp__codegraph__*` arranca cargado o diferido.
   Con los datos de T9, es lo más valioso que queda de la spec. Las dos ramas de R13 están escritas.
3. **E2 de los evals**: sin datos, necesita una máquina sin tgrep en PATH.
4. **Release 0.7.9**: `engines.node >=22` y los evals no están publicados.
5. **Rollout del resto del parque**: 3 repos propios y los 15 Bonum (solo render, sin commit).

## Nota de método

El guard de aislamiento de `~/.navori` da **falso positivo determinista** mientras haya sesiones de
Claude Code vivas en otros repos: sus audit logs se modifican durante la corrida y el guard los lee
como fuga de la suite. Su propio mensaje lo anticipa. Verificado dos veces por mtime y por los
procesos `claude` vivos; en CI no ocurre.
