# `add` y `update` nativos en Rust (0.13.x, rebanada 3)

## Resultado

Quien ya usa navori agrega un plugin con `navori add <plugin>` o pide una sugerencia con `navori add --suggest`, y actualiza la herramienta con `navori update`. El binario `navori-rust` lo hace sin el CLI de TypeScript: registra el plugin, corre su instalación, renderiza, sugiere el preset y los plugins del stack, y actualiza el paquete antes de correr `refresh`. La config, los mensajes y los códigos de salida son los del TS.

## Guion de aceptación

Entorno: macOS y Linux, binario `navori-rust` construido desde la rama y un repo de prueba ya inicializado. Los plugins solo se cargan si vienen empaquetados, así que los pasos de `add` usan uno real (`tgrep`, que se instala con `brew install tgrep` en las dos plataformas) con un `PATH` mínimo: un directorio de prueba y los del sistema, sin un `tgrep` real. En ese directorio, un `brew` de prueba registra la llamada y, a pedido, deja un `tgrep` ejecutable ahí y termina con 0, o termina con 1. Los pasos de `update` usan un `PATH` con `node` y `npm` reales, porque `update` instala con npm, y sin el CLI de TypeScript.

1. `navori add tgrep` y aceptar. **Esperado:** las preguntas del TS; el plugin en la config, la misma llamada `brew install tgrep` que el TS, el render aplicado y exit 0 con el mensaje de listo.
2. `navori add tgrep --skip-install` en otra copia, y después de nuevo sobre el plugin ya habilitado. **Esperado:** registra y renderiza sin llamar al instalador; la segunda vez, el aviso del TS.
3. `navori add tgrep` y rechazar la instalación. **Esperado:** el plugin queda registrado, sin instalar, y sale con 0, como el TS.
4. `navori add tgrep --yes` con el `brew` de prueba terminando con 1, y en otra copia terminando con 0 sin dejar `tgrep`. **Esperado:** en los dos, el plugin queda registrado y sale con 1, con el mensaje del TS, que no deshace el registro.
5. `navori add --suggest`, `navori add no-existe` y un plugin retirado. **Esperado:** la sugerencia del TS sin escribir, y los errores del TS sin escribir.
6. `navori update` con el CLI al día. **Esperado:** el aviso de "ya actualizado" del TS y el `refresh` que corre el TS.
7. `navori update` sin red. **Esperado:** el aviso de sin conexión del TS, y `refresh` corre igual.
8. Pendiente de Q1: `navori update` sin terminal y sin `--yes`, con una versión más nueva. **Esperado:** exit 1, como el TS, sin instalar.

## Reglas aplicables

- R1 — Con las mismas respuestas, la config escrita por `add` es igual byte a byte a la del TS, y el render que sigue es el nativo.
- R2 — Las preguntas usan la base de la rebanada 0067, con el texto y los valores por omisión del TS. `add` tiene dos.
- R3 — `add` corre el comando de instalación del manifiesto del plugin para la plataforma, como el TS, solo si el binario del plugin no está en `PATH`, y después comprueba que quedó alcanzable; falla igual cuando no hay comando. `--skip-install` no instala; el paso posterior a la instalación solo corre con terminal, como en el TS.
- R4 — `add` no deshace el registro si la instalación o el render fallan, como el TS: queda registrado y sale con 1.
- R5 — `update` consulta la última versión, compara, nunca baja de versión y, con una versión ilegible, no actualiza, como el TS. `--dry-run` y `--config-only` solo se reenvían a `refresh`; no evitan la instalación.
- R6 — `update` instala con npm como el TS y después ejecuta el `navori` recién instalado para el `refresh`. Conoce su propia versión, sin caer en `0.0.0`.
- R7 — Las entradas de `add` y `update` salen de la delegación transitoria, y `cutover:check` lo refleja.

## Estados

| Estado | Lo que ve el usuario |
|---|---|
| Vacío | `add --suggest` sin stack detectable: la sugerencia mínima del TS. |
| Error | Plugin desconocido, retirado o sin comando para la plataforma; instalación fallida: el error del TS y su código. |
| Sin conexión | `update` sin red: el aviso del TS y `refresh` igual. |
| Sin permiso | `update` sin terminal y sin `--yes`: exit 1 del TS, sin instalar. |

## Entorno y datos

- Depende de las rebanadas 0067 (preguntas) y 0068 (`refresh`).
- Inventario en H (`997128b9`): `add` y `update` son entradas por comando en `TRANSITIONAL_DELEGATION` (`scripts/js/rust-areas.mjs:198-205`). Tamaño TS: `commands/add.ts` 514 líneas con 2 preguntas (`:217` y `:410`), `commands/update.ts` 186 con 1. Puntos del TS: render tras escribir (`add.ts:338`), sin deshacer (`:339-350` y `:424-438`), instalación con el comando del manifiesto (`:395-405`), última versión con registro fijo (`lib/primitives/update-notice.ts:22` y `:139`), plan de instalación con npm (`:79-136`), sin red (`update.ts:107-120`) y `refresh` con el binario instalado (`:168-176`).
- Pregunta abierta Q1 para Ulises: cómo probar `update` con una versión más nueva sin publicar en npm. Las opciones son (a) una variable de entorno que cambie el registro en el TS y en Rust, o (b) probarlo a mano en la siguiente publicación. Mientras no decida, el guion cubre `update` sin versión nueva (pasos 6 y 7), y el paso 8 espera a Q1.
- Instaladores de prueba en `PATH`: el TS (`lib/config/plugins.ts:614-617`) y el render nativo solo cargan plugins empaquetados, así que no hay plugin de prueba propio.
- Desafío del auditor (24 nov), incorporado; resumen en el PR de esta spec.
- Área crítica: el render tras `add` y el `refresh` tras `update` en el repo del usuario.

## Fuera de alcance

- `init` y `refresh`: rebanada 0068.
- `configure`: segunda tanda.
- La publicación de 0.13.x en npm: la decide Ulises.

## Tareas

1. `add <plugin>` registra, instala y renderiza como el TS, con y sin `--yes`.
2. `add` cubre `--skip-install`, plugin ya habilitado, retirado, desconocido y sin comando para la plataforma.
3. `add --suggest` sugiere lo mismo que el TS sin escribir.
4. `update` consulta, compara, instala y corre `refresh` con el binario instalado.
5. `update` conoce su propia versión y cubre sin red, sin terminal y `--cli-only`.
6. El oráculo compara config, mensajes y comandos con el TS.
7. `add` y `update` salen de la delegación transitoria.
8. El guion pasa sobre el binario construido.
