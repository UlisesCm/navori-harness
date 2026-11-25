# `add` y `update` nativos en Rust (0.13.x, rebanada 3)

## Resultado

Quien ya usa navori agrega un plugin con `navori add <plugin>` o pide una sugerencia con `navori add --suggest`, y actualiza la herramienta con `navori update`. El binario `navori-rust` lo hace sin Node: registra el plugin, instala su herramienta externa si hace falta, sugiere el preset y los plugins del stack, y actualiza el CLI antes de correr `refresh`. La config y los mensajes son los mismos que con el TS.

## Guion de aceptación

Entorno: macOS y Linux, binario `navori-rust` construido desde la rama, `PATH` sin `node` ni el CLI de TypeScript, un repo de prueba ya inicializado y un registro de paquetes de prueba con una versión más nueva publicada.

1. `navori add engram` y aceptar. **Esperado:** las preguntas del TS; el plugin queda en `navori.config.json`, igual que con el TS.
2. `navori add tgrep --yes`. **Esperado:** sin preguntas; registra el plugin e instala la herramienta como el TS.
3. `navori add tgrep --skip-install` en otra copia. **Esperado:** registra el plugin sin instalar nada.
4. `navori add --suggest`. **Esperado:** el preset y los plugins sugeridos del TS; no escribe ni instala.
5. `navori add no-existe`. **Esperado:** el error del TS con la lista de plugins válidos, sin escribir.
6. `navori update --dry-run`. **Esperado:** la versión nueva y el diff de `refresh`, sin instalar ni escribir.
7. `navori update --yes`. **Esperado:** instala la versión nueva y corre `refresh`, igual que el TS.
8. `navori update --cli-only` con el CLI ya al día. **Esperado:** el aviso de "ya actualizado" del TS, sin correr `refresh`.
9. `navori update` sin red. **Esperado:** el error de red del TS; nada se instala ni se escribe.

## Reglas aplicables

- R1 — Con las mismas respuestas, la config escrita por `add` es igual byte a byte a la del TS.
- R2 — Las preguntas usan la base de la rebanada 0067, con el texto y los valores por omisión del TS.
- R3 — `--suggest` y `--dry-run` nunca escriben ni instalan.
- R4 — `add` instala con el mismo gestor y los mismos argumentos que el TS, y `--skip-install` no instala.
- R5 — `update` compara versiones como el TS y nunca baja de versión.
- R6 — `update` corre el `refresh` de la rebanada 0068 con las banderas que reenvía (`--dry-run`, `--config-only`).
- R7 — `add`, `update` y sus banderas salen de la delegación transitoria, y `cutover:check` lo refleja.

## Estados

| Estado | Lo que ve el usuario |
|---|---|
| Vacío | `add --suggest` sin stack detectable: la sugerencia mínima del TS. |
| Error | Plugin desconocido, o instalación fallida: el error del TS, sin config a medias. |
| Sin conexión | `update` o una instalación de `add` sin red: el error del TS, sin escribir. |
| Sin permiso | Sin permiso para instalar: el error del TS, y el plugin no queda registrado a medias. |

## Entorno y datos

- Depende de las rebanadas 0067 (preguntas) y 0068 (`refresh`).
- Inventario en H (`997128b9`): `add` y `update` están en `TRANSITIONAL_DELEGATION` (`scripts/js/rust-areas.mjs`). Tamaño TS: `commands/add.ts` 514 líneas con 3 preguntas, `commands/update.ts` 186 con 1. Usan config y plugins (`lib/config/`), detección, `which`, semver y el aviso de actualización (`lib/primitives/update-notice.ts`). Rust ya tiene detección, semver y la caché de versiones del aviso.
- Registro de paquetes de prueba local, para no depender de npm en el guion. Red real solo en los pasos 2 y 9.

## Fuera de alcance

- `init` y `refresh`: rebanada 0068.
- `configure`: segunda tanda.
- La publicación de 0.13.x en npm: la decide Ulises.

## Tareas

1. `add <plugin>` registra el plugin con la config del TS, con y sin `--yes`.
2. `add` instala la herramienta externa como el TS, y `--skip-install` la omite.
3. `add --suggest` sugiere lo mismo que el TS sin escribir.
4. `update` detecta la versión nueva, instala y corre `refresh`, con sus banderas.
5. El oráculo compara config, mensajes y comandos de instalación con el TS.
6. `add` y `update` salen de la delegación transitoria.
7. El guion pasa sobre el binario construido, sin Node en `PATH`.
