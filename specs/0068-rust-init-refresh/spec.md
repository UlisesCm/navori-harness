# `init` y `refresh` nativos en Rust (0.13.x, rebanada 2)

## Resultado

Quien adopta navori en un repo corre `navori init`, responde el asistente o usa sus modos sin preguntas (`--yes`, `--recommended`, `--full`), y el binario `navori-rust` hace lo que hoy hace el TS, sin Node: detecta el stack, elige el modo de adopción, escribe `navori.config.json`, registra el repo en el registro global y renderiza el harness. Más tarde, `navori refresh` vuelve a detectar, muestra el diff de config y vuelve a renderizar. Con la misma versión y las mismas respuestas, quedan los mismos archivos, dentro y fuera del repo, que con el TS.

## Guion de aceptación

Entorno: macOS y Linux, binario `navori-rust` construido desde la rama, `PATH` sin `node` ni el CLI de TypeScript, un `HOME` aislado y cuatro repos de prueba: uno de Node con monorepo y un harness ajeno (agentes y skills propios en `.claude/`), uno de Python sin harness, uno ya inicializado y uno sin nombre de proyecto detectable.

1. `navori init` en el repo de Node, elegir "reemplazar", confirmar, completar el asistente y aceptar renderizar. **Esperado:** las preguntas del TS; el respaldo en `~/.navori/migrations`, los originales retirados, la config, el registro global y el árbol renderizado iguales a los del TS.
2. `navori init --yes` en el repo de Python y, en una copia del de Node, `navori init --yes`. **Esperado:** sin preguntas; el de Python en modo nuevo, con render; el de Node en modo "coexistir", con config y sin render; los dos iguales al TS.
3. En dos copias del monorepo sin el harness ajeno y con `.git`, `navori init --recommended --lang en` y `navori init --full`. **Esperado:** render y `.prettierignore` en las dos; la de `--recommended --lang en`, con la config en inglés; la de `--full`, en español, con los workspaces del monorepo y el hook de pre-commit; todo igual al TS.
4. `navori init` en el repo ya inicializado. **Esperado:** el error del TS y exit 1; nada cambia.
5. `navori init --workspace demo` con un workspace inexistente, y `navori init --yes` en el repo sin nombre. **Esperado:** los errores del TS y exit 1, sin escribir.
6. Cambiar el stack del repo de Node y correr `navori refresh --dry-run`. **Esperado:** el diff de config del TS, sin escribir nada.
7. `navori refresh` y responder "no" a la pregunta de config. **Esperado:** el aviso de cancelado del TS; no se escribe ni la config ni el render.
8. `navori refresh --yes` y `navori refresh --config-only` en copias separadas. **Esperado:** config actualizada y render aplicado, o solo la config, igual que el TS.
9. `navori init --full` con `PATH` sin `tgrep` ni `acli`. **Esperado:** el aviso del TS por cada binario que falta; la config se escribe igual y no se instala nada.
10. Repetir el paso 1 cancelando en la pregunta que sigue al respaldo. **Esperado:** sale con 0; el repo queda intacto y el respaldo queda en `~/.navori/migrations`, como en el TS.

## Reglas aplicables

- R1 — Con la misma versión de navori y las mismas respuestas, la config, el registro global, el respaldo de "reemplazar", el hook de pre-commit y `.prettierignore` son iguales byte a byte a los del TS. El render que sigue es el render nativo actual.
- R2 — El asistente y el modo de adopción usan la base de preguntas de la rebanada 0067, con el texto, el orden y los valores por omisión del TS.
- R3 — El modo de adopción es el del TS: sin harness ajeno, modo nuevo, que renderiza; con harness ajeno, pregunta, y con `--yes` (también `--recommended` y `--full`) elige "coexistir", que escribe la config y no renderiza ni escribe `.prettierignore` ni el hook. "Reemplazar" respalda en `~/.navori/migrations` y retira los originales solo después de escribir la config. `--yes`, `--recommended` y `--full` nunca preguntan. `--full` implica `--recommended`, `--scan-monorepo` y el hook de pre-commit (que solo se escribe si hay `.git`), y nunca instala: solo habilita y avisa por cada binario que falta.
- R4 — `init` sobre una config existente falla con exit 1. `refresh` solo pregunta si cambia la config, y "no" cancela todo el comando; si solo el render está desfasado, lo aplica sin preguntar, como el TS.
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
- Inventario en H (`997128b9`): `init` y `refresh` son entradas por comando en `TRANSITIONAL_DELEGATION` (`scripts/js/rust-areas.mjs:198-205`). Tamaño TS: `commands/init.ts` 1.459 líneas con 22 preguntas, `commands/refresh.ts` 615 con 1. Puntos del TS: el modo de adopción (`init.ts:931-988`; harness ajeno en `lib/assets/claude-infra.ts:123-128`), "coexistir" sin render (`init.ts:503-506` y `:897-900`), la pregunta de render (`:908-912`), `--full` implica `--recommended` y `--yes` (`:253-256`) y fuerza el hook (`:512-516`, `:1097-1112`), el retiro de originales (`:882-883`), los avisos de `--full` (`:79-100`), config existente (`:271-274`), el registro global (`:480` y `:888`; `lib/workspace/registry.ts:57-133`) y `refresh`, que pregunta y cancela (`refresh.ts:542-550`) y renderiza. Rust ya escribe la config (`crates/navori-core/src/config.rs:90`) y renderiza; su detección delega con `pyproject.toml` (`diagnose/detect.rs:48-60`) y solo lee el registro.
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
