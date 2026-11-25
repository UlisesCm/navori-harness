# `init` y `refresh` nativos en Rust (0.13.x, rebanada 2)

## Resultado

Quien adopta navori en un repo corre `navori init`, responde el asistente o usa sus modos sin preguntas (`--yes`, `--recommended`, `--full`), y el binario `navori-rust` hace lo que hoy hace el TS, sin Node: detecta el stack, elige el modo de adopción, escribe `navori.config.json`, registra el repo en el registro global y renderiza el harness. Más tarde, `navori refresh` vuelve a detectar, muestra el diff de config y vuelve a renderizar. Con la misma versión y las mismas respuestas, quedan los mismos archivos, dentro y fuera del repo, que con el TS.

## Guion de aceptación

Entorno: macOS y Linux, binario `navori-rust` construido desde la rama, `PATH` sin `node` ni el CLI de TypeScript, un `HOME` aislado y cuatro repos de prueba: uno de Node con monorepo y un `CLAUDE.md` propio, uno de Python, uno ya inicializado y uno sin nombre de proyecto detectable.

1. `navori init` en el repo de Node, elegir el modo "reemplazar" y completar el asistente. **Esperado:** las preguntas del TS; respaldo de los originales, la config, el registro global y el árbol renderizado iguales a los del TS.
2. `navori init --yes` en el repo de Python. **Esperado:** sin preguntas, modo "coexistir", sin render; config y registro iguales al TS.
3. `navori init --recommended --lang en` y, en otra copia, `navori init --full` en el monorepo. **Esperado:** config, idioma, workspaces del monorepo, hook de pre-commit y `.prettierignore` iguales al TS.
4. `navori init` en el repo ya inicializado. **Esperado:** el error del TS y exit 1; nada cambia.
5. `navori init --workspace demo` con un workspace inexistente, y `navori init --yes` en el repo sin nombre. **Esperado:** los errores del TS y exit 1, sin escribir.
6. Cambiar el stack del repo de Node y correr `navori refresh --dry-run`. **Esperado:** el diff de config del TS, sin escribir nada.
7. `navori refresh` y responder "no" a la pregunta de config. **Esperado:** la config no cambia; el render de lo que ya no está al día se aplica como en el TS.
8. `navori refresh --yes` y `navori refresh --config-only` en copias separadas. **Esperado:** config actualizada y render aplicado, o solo la config, igual que el TS.
9. `navori init --full` con `PATH` sin `tgrep` ni `acli`. **Esperado:** el aviso del TS por cada binario que falta; la config se escribe igual y no se instala nada.
10. Cancelar el asistente del paso 1 a la mitad. **Esperado:** sale con 0 y no escribe nada.

## Reglas aplicables

- R1 — Con la misma versión de navori y las mismas respuestas, la config, el registro global, el respaldo de "reemplazar", el hook de pre-commit y `.prettierignore` son iguales byte a byte a los del TS. El render que sigue es el render nativo actual.
- R2 — El asistente y el modo de adopción usan la base de preguntas de la rebanada 0067, con el texto, el orden y los valores por omisión del TS.
- R3 — `--yes`, `--recommended` y `--full` nunca preguntan, y usan el modo de adopción que el TS usa sin preguntar. `--full` implica `--scan-monorepo` y el hook de pre-commit, y nunca instala: solo habilita y avisa por cada binario que falta.
- R4 — `init` sobre una config existente falla con exit 1. `refresh` solo pregunta por los cambios de config; el render de lo que está desfasado se aplica sin preguntar, como en el TS.
- R5 — La detección nativa cubre todo lo que el TS detecta: Python, el gestor de paquetes, el stack, el quality gate, la rama base y la infraestructura de Claude. Hoy delega con `pyproject.toml`.
- R6 — El registro global se escribe con el bloqueo del TS, y la migración del formato viejo de workspaces ocurre igual que en el TS.
- R7 — Los códigos de salida son los del TS, incluido un render fallido dentro de `init` (exit 0, con el aviso).
- R8 — Las entradas de `init` y `refresh` salen de la delegación transitoria, y `cutover:check` lo refleja.

## Estados

| Estado | Lo que ve el usuario |
|---|---|
| Vacío | Repo sin stack detectable: el resultado del TS. Sin nombre de proyecto: el error del TS. |
| Error | Config existente, workspace inexistente o config inválida: el error del TS, sin escribir. |
| Sin conexión | n/a: `init` y `refresh` no usan la red; los binarios faltantes dependen del `PATH`. |
| Sin permiso | n/a como estado propio: el error del sistema de archivos, como en el TS. |

## Entorno y datos

- Depende de la rebanada 0067 (preguntas nativas).
- Inventario en H (`997128b9`): `init` y `refresh` son entradas por comando en `TRANSITIONAL_DELEGATION` (`scripts/js/rust-areas.mjs:198-205`). Tamaño TS: `commands/init.ts` 1.459 líneas con 22 preguntas, `commands/refresh.ts` 615 con 1. Puntos del TS: el modo de adopción (`init.ts:1013-1070`, respaldo y borrado en `:880`), `--full` solo avisa (`:79-100`), config existente (`:271-274`), el registro global (`:480` y `:888`; `lib/workspace/registry.ts:57-133`) y `refresh`, que renderiza (`refresh.ts:578`) y solo pregunta por la config (`:545`). Rust ya escribe la config (`crates/navori-core/src/config.rs:90`) y renderiza; su detección delega con `pyproject.toml` (`diagnose/detect.rs:48-60`) y solo lee el registro.
- `harnessVersion` lo escribe el render: la comparación byte a byte fija la misma versión en los dos lados.
- Desafío del auditor (24 nov), incorporado; resumen en el PR de esta spec.
- Área crítica: el render y el respaldo con borrado de originales en el repo del usuario.

## Fuera de alcance

- `add` y `update`: rebanada 0069.
- `configure`: segunda tanda.
- Nuevas detecciones o presets que el TS no tenga.

## Tareas

1. La detección nativa cubre todo lo que el TS detecta, también Python.
2. `init --yes`, `--recommended` y `--full` escriben la config, el registro y los archivos auxiliares del TS.
3. El asistente y el modo de adopción preguntan en el binario, con el respaldo de "reemplazar".
4. El registro global se escribe con su bloqueo y su migración.
5. `refresh` detecta, muestra el diff y renderiza, con `--yes`, `--dry-run` y `--config-only`.
6. El oráculo compara config, registro y árbol con el TS en los cuatro repos.
7. `init` y `refresh` salen de la delegación transitoria.
8. El guion pasa sobre el binario construido, sin Node en `PATH`.
