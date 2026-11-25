# `init` y `refresh` nativos en Rust (0.13.x, rebanada 2)

## Resultado

Quien adopta navori en un repo corre `navori init`, responde el asistente o usa sus modos sin preguntas (`--yes`, `--recommended`, `--full`), y el binario `navori-rust` detecta el stack, escribe `navori.config.json` y renderiza el harness sin Node. Más tarde, `navori refresh` vuelve a detectar, muestra el diff de config y sincroniza. La config y el árbol que quedan son los mismos que deja el TS con las mismas respuestas.

## Guion de aceptación

Entorno: macOS y Linux, binario `navori-rust` construido desde la rama, `PATH` sin `node` ni el CLI de TypeScript, y tres repos de prueba: uno de Node con monorepo, uno de Python y uno vacío sin commits.

1. `navori init` en el repo de Node y completar el asistente en español. **Esperado:** las preguntas del TS; `navori.config.json` y el árbol renderizado iguales a los del TS con esas respuestas.
2. `navori init --yes` en el repo de Python. **Esperado:** sin preguntas; la config detectada y el render, iguales al TS.
3. `navori init --recommended --lang en` y, en otra copia, `navori init --full --scan-monorepo --pre-commit-hook` en el monorepo. **Esperado:** config, workspaces del monorepo y hook de pre-commit iguales al TS.
4. `navori init` en un repo que ya tiene config. **Esperado:** el aviso del TS; nada se sobrescribe sin confirmar.
5. `navori init --workspace demo` con un workspace inexistente. **Esperado:** el error del TS, sin escribir.
6. Cambiar el stack del repo de Node y correr `navori refresh --dry-run`. **Esperado:** el diff de config del TS, sin escribir nada.
7. `navori refresh --yes`. **Esperado:** config actualizada y `sync` aplicado, igual que el TS.
8. `navori refresh --config-only`. **Esperado:** actualiza la config y no sincroniza.
9. `navori init --full` sin red. **Esperado:** el mismo mensaje del TS para las herramientas externas que no pudo instalar; la config se escribe igual.
10. `navori init` en el repo vacío. **Esperado:** el comportamiento del TS para un repo sin stack detectable.

## Reglas aplicables

- R1 — Con las mismas respuestas, la config escrita es igual byte a byte a la del TS, y el render que sigue es el render nativo actual.
- R2 — El asistente usa la base de preguntas de la rebanada 0067, con el texto, el orden y los valores por omisión del TS.
- R3 — `--yes`, `--recommended` y `--full` nunca preguntan. `--lang` solo cambia el idioma del asistente.
- R4 — `init` sobre una config existente y `refresh` sin `--yes` nunca escriben sin confirmar.
- R5 — `--full` instala las mismas herramientas externas que el TS y falla igual que él sin red.
- R6 — `init`, `refresh` y sus banderas salen de la delegación transitoria, y `cutover:check` lo refleja.

## Estados

| Estado | Lo que ve el usuario |
|---|---|
| Vacío | Repo sin stack detectable: el resultado del TS. |
| Error | Workspace inexistente o config inválida: el error del TS, sin escribir. |
| Sin conexión | `--full` sin red: aviso del TS por herramienta, y la config se escribe. |
| Sin permiso | Directorio sin escritura: el error del TS antes de escribir. |

## Entorno y datos

- Depende de la rebanada 0067 (preguntas nativas).
- Inventario en H (`997128b9`): `init` y `refresh` están en `TRANSITIONAL_DELEGATION` (`scripts/js/rust-areas.mjs`). Tamaño TS: `commands/init.ts` 1.459 líneas con 22 preguntas, `commands/refresh.ts` 615 con 1. Usan detección (`lib/diagnose/detect.ts`), config, plugins, recomendados y esquema (`lib/config/`), i18n, el registro de workspaces y el plan de render. Rust ya tiene detección, i18n, registro de workspaces y render; faltan la escritura de la config, los recomendados y el asistente.
- Repos de prueba fabricados por la prueba de aceptación; red real solo en el paso 9.

## Fuera de alcance

- `add` y `update`: rebanada 0069.
- `configure`: segunda tanda.
- Nuevas detecciones o presets: no cambian en esta rebanada.

## Tareas

1. La config que escribe `init --yes` es igual a la del TS en los tres repos.
2. `--recommended`, `--full`, `--scan-monorepo` y `--pre-commit-hook` dan el resultado del TS.
3. El asistente de `init` pregunta en el binario, en los dos idiomas.
4. `refresh` detecta, muestra el diff y sincroniza, con `--yes`, `--dry-run` y `--config-only`.
5. El oráculo compara config y árbol con el TS en los tres repos.
6. `init` y `refresh` salen de la delegación transitoria.
7. El guion pasa sobre el binario construido, sin Node en `PATH`.
